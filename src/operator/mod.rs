mod archive;
mod config;
mod database;
mod github;
mod openreview;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use base64::Engine;
use hmac::{Hmac, Mac};
use rand::Rng;
use regex::Regex;
use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

use self::archive::{extract_snapshot, sha256};
use self::config::Config;
use self::database::{Database, Submission};
use self::github::{GithubGateway, LiveGateway, MockGateway, MockReview};
use self::openreview::{LiveOpenReviewGateway, MockOpenReviewGateway, OpenReviewGateway};
use crate::package::validate_server_text;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
struct AppState {
    config: Config,
    database: Arc<Database>,
    github: Arc<dyn GithubGateway>,
    openreview: Arc<dyn OpenReviewGateway>,
    rate_limiter: Arc<RateLimiter>,
    upload_slots: Arc<Semaphore>,
}

struct RateLimiter {
    windows: Mutex<HashMap<(String, IpAddr), (Instant, usize)>>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            windows: Mutex::new(HashMap::new()),
        }
    }

    fn check(&self, bucket: &str, ip: IpAddr, limit: usize) -> Result<()> {
        let now = Instant::now();
        let mut windows = self.windows.lock().expect("rate limiter lock poisoned");
        windows.retain(|_, (started, _)| now.duration_since(*started) < Duration::from_secs(60));
        let entry = windows.entry((bucket.to_string(), ip)).or_insert((now, 0));
        if now.duration_since(entry.0) >= Duration::from_secs(60) {
            *entry = (now, 0);
        }
        if entry.1 >= limit {
            bail!("Request rate limit reached; wait one minute and try again");
        }
        entry.1 += 1;
        Ok(())
    }
}

pub async fn serve() -> Result<()> {
    let config = Config::load()?;
    let database = Arc::new(Database::open(&config.database_path)?);
    let github: Arc<dyn GithubGateway> = match config.github.clone() {
        Some(value) => Arc::new(LiveGateway::new(value)?),
        None => Arc::new(MockGateway::new()),
    };
    let openreview: Arc<dyn OpenReviewGateway> = match config.openreview.clone() {
        Some(value) => Arc::new(LiveOpenReviewGateway::new(value)?),
        None => Arc::new(MockOpenReviewGateway),
    };
    let state = AppState {
        config: config.clone(),
        database,
        github,
        openreview,
        rate_limiter: Arc::new(RateLimiter::new()),
        upload_slots: Arc::new(Semaphore::new(config.public_limits.max_concurrent_uploads)),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/author/submissions", post(register_submission))
        .route("/v1/author/submit", post(initial_submit))
        .route("/v1/author/revise", post(revise))
        .route("/v1/author/status", get(author_status))
        .route("/v1/author/reviews", get(author_reviews))
        .route("/v1/author/responses", post(author_response))
        .route("/v1/admin/submissions", post(admin_create_submission))
        .route("/v1/admin/submissions/{id}", get(admin_status))
        .route(
            "/v1/admin/submissions/{id}/reviewers",
            post(assign_reviewer),
        )
        .route(
            "/v1/admin/submissions/{id}/reviewers/{login}/sync",
            post(sync_reviewer),
        )
        .route(
            "/v1/admin/submissions/{id}/reviewers/{login}",
            delete(remove_reviewer),
        )
        .route("/v1/admin/submissions/{id}/decision", post(decision))
        .route("/v1/admin/submissions/{id}/publish", post(publish))
        .route("/v1/admin/submissions/{id}/mock-reviews", post(mock_review))
        .route(
            "/v1/admin/submissions/{id}/revoke-token",
            post(revoke_token),
        )
        .layer(DefaultBodyLimit::max(
            config.limits.max_upload_bytes + 1_048_576,
        ))
        .with_state(state);
    let address = (config.host, config.port);
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!(
        "AIDaR API listening at http://{}:{} ({} GitHub mode, {} OpenReview mode)",
        config.host,
        config.port,
        if config.github.is_some() {
            "live"
        } else {
            "mock"
        },
        if config.openreview.is_some() {
            "live"
        } else {
            "mock"
        }
    );
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await?;
    Ok(())
}

async fn shutdown() {
    let control_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = control_c => {},
        _ = terminate => {},
    }
}

struct AppError(anyhow::Error);

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(value: E) -> Self {
        Self(value.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let message = format!("{:#}", self.0);
        let lower = message.to_ascii_lowercase();
        let status = if lower.contains("rate limit") || lower.contains("upload capacity") {
            StatusCode::TOO_MANY_REQUESTS
        } else if lower.contains("openreview verification is unavailable") {
            StatusCode::BAD_GATEWAY
        } else if lower.contains("not an active aidar workshop submission") {
            StatusCode::FORBIDDEN
        } else if lower.contains("already has an aidar submission") {
            StatusCode::CONFLICT
        } else if lower.contains("token") || lower.contains("authorization") {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::BAD_REQUEST
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "github_mode": state.github.mode(),
        "openreview_mode": state.openreview.mode()
    }))
}

fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> Result<IpAddr> {
    if peer.ip().is_loopback()
        && let Some(value) = headers.get("X-Forwarded-For")
    {
        let value = value.to_str().context("Client address header is invalid")?;
        if value.contains(',') {
            bail!("Client address header is invalid");
        }
        return value.parse().context("Client address header is invalid");
    }
    Ok(peer.ip())
}

#[derive(Deserialize)]
struct Registration {
    openreview_url: Option<String>,
}

async fn register_submission(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(input): Json<Registration>,
) -> Result<Json<Value>, AppError> {
    state.rate_limiter.check(
        "registration",
        client_ip(peer, &headers)?,
        state.config.public_limits.registrations_per_minute,
    )?;
    let (openreview, forum_id) =
        normalize_openreview(input.openreview_url.as_deref().unwrap_or(""))?;
    state.openreview.verify_submission(&forum_id).await?;
    Ok(Json(create_submission(
        &state,
        Some(&openreview),
        "self_service",
    )?))
}

#[derive(Deserialize)]
struct AdminRegistration {
    external_id: Option<String>,
}

async fn admin_create_submission(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<AdminRegistration>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    Ok(Json(create_submission(
        &state,
        input.external_id.as_deref(),
        "admin",
    )?))
}

fn create_submission(state: &AppState, external_id: Option<&str>, actor: &str) -> Result<Value> {
    let id = {
        let mut bytes = [0_u8; 6];
        rand::rng().fill(&mut bytes);
        hex::encode(bytes)
    };
    let token = {
        let mut bytes = [0_u8; 32];
        rand::rng().fill(&mut bytes);
        format!(
            "aidar_sub_{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        )
    };
    let now = chrono::Utc::now().to_rfc3339();
    let result = state.database.with(|connection| {
        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "INSERT INTO submissions (id, external_id, author_token_hmac, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'awaiting_submission', ?4, ?4)",
            params![id, external_id, token_hmac(&state.config.token_hmac_secret, &token), now],
        )?;
        Database::event(&transaction, Some(&id), "submission_created", actor, None, None)?;
        Ok(transaction.commit()?)
    });
    if let Err(error) = result {
        if error
            .to_string()
            .contains("UNIQUE constraint failed: submissions.external_id")
        {
            bail!(
                "This OpenReview link already has an AIDaR submission; use the saved credential to revise it"
            );
        }
        return Err(error);
    }
    Ok(json!({
        "submission_id": id,
        "author_token": token,
        "status": "awaiting_submission"
    }))
}

async fn initial_submit(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    state.rate_limiter.check(
        "upload",
        client_ip(peer, &headers)?,
        state.config.public_limits.uploads_per_minute,
    )?;
    ingest(state, headers, multipart, false).await.map(Json)
}

async fn revise(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    state.rate_limiter.check(
        "upload",
        client_ip(peer, &headers)?,
        state.config.public_limits.uploads_per_minute,
    )?;
    ingest(state, headers, multipart, true).await.map(Json)
}

async fn ingest(
    state: AppState,
    headers: HeaderMap,
    multipart: Multipart,
    revision: bool,
) -> Result<Value, AppError> {
    let token = bearer(&headers, "Author bearer token is required")?;
    let record = authenticate_author(&state, token)?;
    let idempotency_key = headers
        .get("Idempotency-Key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if idempotency_key.is_empty() || idempotency_key.len() > 200 {
        return Err(anyhow!("A valid Idempotency-Key is required").into());
    }
    let _upload_permit = state
        .upload_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow!("Upload capacity is busy; try again shortly"))?;
    let upload = read_upload(multipart, &state.config).await?;
    let snapshot = extract_snapshot(&upload.archive, &upload.digest, &state.config.limits)?;
    let digest = sha256(&upload.archive);
    if let Some(value) = state.database.with(|connection| {
        connection
            .query_row(
                "SELECT submission_id, request_sha256, response_json FROM idempotency_keys WHERE key = ?1",
                [idempotency_key],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(Into::into)
    })? {
        if value.0 != record.id || value.1 != digest {
            return Err(anyhow!("Idempotency key belongs to a different request").into());
        }
        return Ok(serde_json::from_str(&value.2)?);
    }
    if revision {
        if record.revision < 1 {
            return Err(anyhow!("Initial submission does not exist; use submit").into());
        }
        if record.status != "under_review" {
            return Err(anyhow!("Submission is not open for revision").into());
        }
        let next_revision = record.revision + 1;
        let head_sha = state
            .github
            .revise(&record, &snapshot, next_revision)
            .await?;
        let response = json!({
            "submission_id": record.id,
            "status": "under_review",
            "revision": next_revision,
            "package_sha256": digest
        });
        save_ingest(
            &state,
            &record.id,
            idempotency_key,
            &digest,
            &response,
            Some((&head_sha, next_revision)),
            None,
        )?;
        Ok(response)
    } else {
        if record.revision != 0 {
            return Err(anyhow!("Initial submission already exists; use revise").into());
        }
        let github = state
            .github
            .create_submission(&record.id, &snapshot)
            .await?;
        let response = json!({
            "submission_id": record.id,
            "status": "under_review",
            "revision": 1,
            "package_sha256": digest,
            "repository_created": true,
            "pull_request_number": github.pull_number
        });
        save_ingest(
            &state,
            &record.id,
            idempotency_key,
            &digest,
            &response,
            Some((&github.head_sha, 1)),
            Some((github.repo_id, &github.repo_name, github.pull_number)),
        )?;
        Ok(response)
    }
}

fn save_ingest(
    state: &AppState,
    id: &str,
    key: &str,
    digest: &str,
    response: &Value,
    revision: Option<(&str, u32)>,
    repository: Option<(i64, &str, u64)>,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    state.database.with(|connection| {
        if let Some((repo_id, repo_name, pull)) = repository {
            connection.execute(
                "UPDATE submissions SET status='under_review', repo_id=?1, repo_name=?2, pr_number=?3, branch_head_sha=?4, revision=1, package_sha256=?5, updated_at=?6 WHERE id=?7",
                params![repo_id, repo_name, pull as i64, revision.map(|value| value.0), digest, now, id],
            )?;
            Database::event(connection, Some(id), "initial_submission", "author", revision.map(|value| value.0), Some(digest))?;
        } else if let Some((head, number)) = revision {
            connection.execute(
                "UPDATE submissions SET branch_head_sha=?1, revision=?2, package_sha256=?3, updated_at=?4 WHERE id=?5",
                params![head, number, digest, now, id],
            )?;
            Database::event(connection, Some(id), "revision_submitted", "author", Some(head), Some(digest))?;
        }
        connection.execute(
            "INSERT INTO idempotency_keys (key, submission_id, request_sha256, response_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![key, id, digest, serde_json::to_string(response)?, now],
        )?;
        Ok(())
    })
}

struct Upload {
    archive: Vec<u8>,
    digest: String,
    public_slug: Option<String>,
}

async fn read_upload(mut multipart: Multipart, config: &Config) -> Result<Upload> {
    let mut archive = None;
    let mut digest = None;
    let mut public_slug = None;
    while let Some(field) = multipart.next_field().await? {
        let name = field.name().unwrap_or("").to_string();
        if name == "archive" {
            if archive.is_some() {
                bail!("Exactly one archive field is required");
            }
            let data: Bytes = field.bytes().await?;
            if data.len() > config.limits.max_upload_bytes {
                bail!("Upload exceeds the configured limit");
            }
            archive = Some(data.to_vec());
        } else if name == "archive_sha256" {
            digest = Some(field.text().await?);
        } else if name == "public_slug" {
            public_slug = Some(field.text().await?);
        }
    }
    Ok(Upload {
        archive: archive.context("archive field is required")?,
        digest: digest.context("archive_sha256 field is required")?,
        public_slug,
    })
}

async fn author_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let record = authenticate_author(&state, bearer(&headers, "Author bearer token is required")?)?;
    Ok(Json(status_value(&record)))
}

async fn author_reviews(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let record = authenticate_author(&state, bearer(&headers, "Author bearer token is required")?)?;
    if record.revision < 1 {
        return Err(anyhow!("Submission has not been uploaded").into());
    }
    Ok(Json(json!({
        "submission_id": record.id,
        "reviews": state.github.list_reviews(&record).await?
    })))
}

#[derive(Deserialize)]
struct ResponseInput {
    body: Option<String>,
    reply_to_review_comment_id: Option<u64>,
}

async fn author_response(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ResponseInput>,
) -> Result<Json<Value>, AppError> {
    let record = authenticate_author(&state, bearer(&headers, "Author bearer token is required")?)?;
    if record.status != "under_review" {
        return Err(anyhow!("Submission is not open for author responses").into());
    }
    let body = input.body.unwrap_or_default();
    if body.trim().is_empty() || body.len() > state.config.limits.max_response_bytes {
        return Err(anyhow!("Response is empty or exceeds the configured limit").into());
    }
    validate_server_text(&body, "author response")?;
    let comment_id = state
        .github
        .post_response(&record, &body, input.reply_to_review_comment_id)
        .await?;
    state.database.with(|connection| {
        connection.execute(
            "INSERT INTO responses (id, submission_id, github_comment_id, reply_to_review_comment_id, body_sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![uuid::Uuid::new_v4().to_string(), record.id, comment_id as i64, input.reply_to_review_comment_id.map(|value| value as i64), sha256(body.as_bytes()), chrono::Utc::now().to_rfc3339()],
        )?;
        Database::event(connection, Some(&record.id), "author_response", "author", Some(&comment_id.to_string()), Some(&sha256(body.as_bytes())))
    })?;
    Ok(Json(json!({
        "submission_id": record.id,
        "posted": true,
        "github_comment_id": comment_id
    })))
}

async fn admin_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    let (record, reviewers) = state.database.with(|connection| {
        let record = Database::submission_by_id(connection, &id)?;
        let mut statement = connection.prepare("SELECT github_login, state, invited_at, accepted_at, review_requested_at, removed_at FROM reviewers WHERE submission_id=?1 ORDER BY github_login")?;
        let values = statement
            .query_map([&id], |row| {
                Ok(json!({
                    "github_login": row.get::<_, String>(0)?,
                    "state": row.get::<_, String>(1)?,
                    "invited_at": row.get::<_, Option<String>>(2)?,
                    "accepted_at": row.get::<_, Option<String>>(3)?,
                    "review_requested_at": row.get::<_, Option<String>>(4)?,
                    "removed_at": row.get::<_, Option<String>>(5)?
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok((record, values))
    })?;
    Ok(Json(json!({
        "submission_id": record.id,
        "external_id": record.external_id,
        "status": record.status,
        "revision": record.revision,
        "package_sha256": record.package_sha256,
        "repository": record.repo_name,
        "pull_request_number": record.pr_number,
        "reviewers": reviewers
    })))
}

#[derive(Deserialize)]
struct ReviewerInput {
    github_login: Option<String>,
}

async fn assign_reviewer(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<ReviewerInput>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    let login = input.github_login.unwrap_or_default();
    validate_login(&login)?;
    let record = state
        .database
        .with(|connection| Database::submission_by_id(connection, &id))?;
    if record.revision < 1 || record.status != "under_review" {
        return Err(anyhow!("Submission is not open for reviewer assignment").into());
    }
    let assignment = state.github.assign_reviewer(&record, &login).await?;
    let now = chrono::Utc::now().to_rfc3339();
    state.database.with(|connection| {
        connection.execute(
            "INSERT INTO reviewers (submission_id, github_login, state, invited_at, review_requested_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(submission_id, github_login) DO UPDATE SET state=excluded.state, invited_at=excluded.invited_at, review_requested_at=excluded.review_requested_at, removed_at=NULL",
            params![id, login, assignment, now, if assignment == "review_requested" { Some(&now) } else { None }],
        )?;
        Database::event(connection, Some(&id), "reviewer_assigned", "admin", Some(&login), None)
    })?;
    Ok(Json(
        json!({ "submission_id": id, "github_login": login, "state": assignment }),
    ))
}

async fn sync_reviewer(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((id, login)): AxumPath<(String, String)>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    validate_login(&login)?;
    let record = state
        .database
        .with(|connection| Database::submission_by_id(connection, &id))?;
    let assignment = state.github.sync_reviewer(&record, &login).await?;
    let now = chrono::Utc::now().to_rfc3339();
    state.database.with(|connection| {
        connection.execute(
            "UPDATE reviewers SET state=?1, accepted_at=?2, review_requested_at=?2 WHERE submission_id=?3 AND github_login=?4",
            params![assignment, now, id, login],
        )?;
        Ok(())
    })?;
    Ok(Json(
        json!({ "submission_id": id, "github_login": login, "state": assignment }),
    ))
}

async fn remove_reviewer(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((id, login)): AxumPath<(String, String)>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    let record = state
        .database
        .with(|connection| Database::submission_by_id(connection, &id))?;
    state.github.remove_reviewer(&record, &login).await?;
    let now = chrono::Utc::now().to_rfc3339();
    state.database.with(|connection| {
        connection.execute(
            "UPDATE reviewers SET state='removed', removed_at=?1 WHERE submission_id=?2 AND github_login=?3",
            params![now, id, login],
        )?;
        Database::event(connection, Some(&id), "reviewer_removed", "admin", Some(&login), None)
    })?;
    Ok(Json(json!({ "removed": true })))
}

#[derive(Deserialize)]
struct DecisionInput {
    decision: Option<String>,
}

async fn decision(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<DecisionInput>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    let decision = input.decision.unwrap_or_default();
    if !matches!(decision.as_str(), "accepted" | "rejected") {
        return Err(anyhow!("Decision must be accepted or rejected").into());
    }
    let record = state
        .database
        .with(|connection| Database::submission_by_id(connection, &id))?;
    if record.status != "under_review" {
        return Err(anyhow!("Submission is not under review").into());
    }
    if decision == "rejected" {
        state.github.close_review(&record).await?;
    }
    state.database.with(|connection| {
        connection.execute(
            "UPDATE submissions SET status=?1, updated_at=?2 WHERE id=?3",
            params![decision, chrono::Utc::now().to_rfc3339(), id],
        )?;
        Database::event(
            connection,
            Some(&id),
            &format!("decision_{decision}"),
            "admin",
            None,
            None,
        )
    })?;
    Ok(Json(json!({ "submission_id": id, "status": decision })))
}

async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    multipart: Multipart,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    let record = state
        .database
        .with(|connection| Database::submission_by_id(connection, &id))?;
    if record.status != "accepted" {
        return Err(anyhow!("Only an accepted submission can be published").into());
    }
    let upload = read_upload(multipart, &state.config).await?;
    let slug = upload.public_slug.context("public_slug is required")?;
    let snapshot = extract_snapshot(&upload.archive, &upload.digest, &state.config.limits)?;
    let pull = state.github.publish(&record, &slug, &snapshot).await?;
    Ok(Json(json!({
        "submission_id": id,
        "published": false,
        "publication_pull_request_number": pull,
        "package_sha256": sha256(&upload.archive)
    })))
}

#[derive(Deserialize)]
struct MockReviewInput {
    github_login: Option<String>,
    body: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    path: Option<String>,
    line: Option<u64>,
    state: Option<String>,
}

async fn mock_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<MockReviewInput>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    let login = input.github_login.context("github_login is required")?;
    let body = input.body.context("body is required")?;
    let review_id = state
        .github
        .inject_mock_review(
            &id,
            &login,
            MockReview {
                kind: input.kind.as_deref().unwrap_or("review"),
                body: &body,
                path: input.path.as_deref(),
                line: input.line,
                state: input.state.as_deref(),
            },
        )
        .await?;
    Ok(Json(json!({ "review_id": review_id })))
}

async fn revoke_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    require_admin(&state, &headers)?;
    state.database.with(|connection| {
        Database::submission_by_id(connection, &id)?;
        connection.execute(
            "UPDATE submissions SET revoked_at=?1, updated_at=?1 WHERE id=?2",
            params![chrono::Utc::now().to_rfc3339(), id],
        )?;
        Database::event(
            connection,
            Some(&id),
            "author_token_revoked",
            "admin",
            None,
            None,
        )
    })?;
    Ok(Json(json!({ "revoked": true })))
}

fn authenticate_author(state: &AppState, token: &str) -> Result<Submission> {
    state.database.with(|connection| {
        Database::submission_by_hmac(
            connection,
            &token_hmac(&state.config.token_hmac_secret, token),
        )
    })
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<()> {
    let token = bearer(headers, "Admin bearer token is required")?;
    let valid_plain = state
        .config
        .admin_token
        .as_deref()
        .is_some_and(|expected| secure_equal(token.as_bytes(), expected.as_bytes()));
    let digest = hex::encode(Sha256::digest(token.as_bytes()));
    let valid_hash = state
        .config
        .admin_token_hash
        .as_deref()
        .is_some_and(|expected| secure_equal(digest.as_bytes(), expected.as_bytes()));
    if !valid_plain && !valid_hash {
        bail!("Admin authorization failed");
    }
    Ok(())
}

fn bearer<'a>(headers: &'a HeaderMap, message: &str) -> Result<&'a str> {
    headers
        .get("Authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| !value.is_empty())
        .context(message.to_string())
}

fn token_hmac(secret: &str, token: &str) -> String {
    let mut hmac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    hmac.update(token.as_bytes());
    hex::encode(hmac.finalize().into_bytes())
}

fn secure_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.ct_eq(right).into()
}

fn normalize_openreview(value: &str) -> Result<(String, String)> {
    let url = url::Url::parse(value.trim()).context("A valid OpenReview forum URL is required")?;
    if url.scheme() != "https"
        || url.host_str() != Some("openreview.net")
        || url.port().is_some()
        || url.path() != "/forum"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("Use an https://openreview.net/forum?id=... URL");
    }
    let id = url
        .query_pairs()
        .find(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    if id.len() < 6
        || id.len() > 128
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        bail!("OpenReview forum URL has an invalid id");
    }
    Ok((format!("https://openreview.net/forum?id={id}"), id))
}

fn validate_login(value: &str) -> Result<()> {
    let regex = Regex::new(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$")?;
    if !regex.is_match(value) {
        bail!("GitHub login is invalid");
    }
    Ok(())
}

fn status_value(record: &Submission) -> Value {
    json!({
        "submission_id": record.id,
        "status": record.status,
        "revision": record.revision,
        "package_sha256": record.package_sha256,
        "updated_at": record.updated_at
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_openreview_urls() {
        assert_eq!(
            normalize_openreview("https://openreview.net/forum?id=Abc_123#discussion").unwrap(),
            (
                "https://openreview.net/forum?id=Abc_123".to_string(),
                "Abc_123".to_string()
            )
        );
    }

    #[test]
    fn rejects_non_openreview_urls() {
        assert!(normalize_openreview("https://example.org/forum?id=Abc_123").is_err());
    }

    #[test]
    fn rate_limiter_blocks_excess_requests() {
        let limiter = RateLimiter::new();
        let ip = "203.0.113.10".parse().unwrap();
        limiter.check("registration", ip, 1).unwrap();
        assert!(limiter.check("registration", ip, 1).is_err());
        limiter.check("upload", ip, 1).unwrap();
    }

    #[test]
    fn forwarded_address_is_trusted_only_from_loopback() {
        let mut headers = HeaderMap::new();
        headers.insert("X-Forwarded-For", "203.0.113.11".parse().unwrap());
        let proxy = "127.0.0.1:4000".parse().unwrap();
        let remote = "198.51.100.20:4000".parse().unwrap();
        assert_eq!(
            client_ip(proxy, &headers).unwrap().to_string(),
            "203.0.113.11"
        );
        assert_eq!(
            client_ip(remote, &headers).unwrap().to_string(),
            "198.51.100.20"
        );
    }
}
