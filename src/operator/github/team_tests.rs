use super::*;
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{StatusCode, Uri},
    response::IntoResponse,
    routing::any,
};
use std::sync::Arc;

type Requests = Arc<Mutex<Vec<(String, Value)>>>;

async fn fake_github(
    State((requests, failure)): State<(Requests, &'static str)>,
    method: Method,
    uri: Uri,
    body: Bytes,
) -> impl IntoResponse {
    let path = uri.path();
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    requests
        .lock()
        .unwrap()
        .push((format!("{method} {path}"), value.clone()));
    let team = "/organizations/1/team/2";
    if (failure == "visibility" && path == team)
        || (failure == "grant" && method == Method::PUT && path.starts_with(team))
    {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(json!({"message":"permission denied"})),
        );
    }
    let reply = match (method.as_str(), path) {
        ("GET", "/orgs/test-org") => json!({"id":1}),
        ("GET", "/organizations/1/team/2") => json!({"id":2}),
        ("POST", "/orgs/test-org/repos") => {
            if value.get("team_id").is_some() {
                return (
                    StatusCode::UNPROCESSABLE_ENTITY,
                    axum::Json(
                        json!({"message":"You need admin access to the team before adding a repository to it."}),
                    ),
                );
            }
            assert_eq!(value["private"], true);
            json!({"id":3,"default_branch":"main"})
        }
        ("GET", p) if p.ends_with("/branches/main") => json!({"commit":{"sha":"initial"}}),
        ("GET", p) if p.contains("/git/commits/") => json!({"tree":{"sha":"tree"}}),
        ("POST", p) if p.ends_with("/git/blobs") => json!({"sha":"blob"}),
        ("POST", p) if p.ends_with("/git/trees") => json!({"sha":"tree"}),
        ("POST", p) if p.ends_with("/git/commits") => json!({"sha":"commit"}),
        ("POST", p) if p.ends_with("/pulls") => json!({"number":1}),
        _ => json!({}),
    };
    (StatusCode::OK, axum::Json(reply))
}

async fn exercise(failure: &'static str) -> (Result<SubmissionResult>, Vec<(String, Value)>) {
    let requests: Requests = Arc::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .fallback(any(fake_github))
        .with_state((requests.clone(), failure));
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let gateway = LiveGateway {
        config: GithubConfig {
            app_id: String::new(),
            private_key: String::new(),
            installation_id: 0,
            org: "test-org".into(),
            api_version: "2026-03-10".into(),
            public_archive_repo: "unused".into(),
            review_team_id: Some(2),
        },
        client: Client::new(),
        encoding_key: EncodingKey::from_secret(b"unused"),
        api_base: format!("http://{address}"),
    };
    let snapshot = BTreeMap::from([("data.txt".into(), b"synthetic test data".to_vec())]);
    let result = gateway
        .create_submission_with_token("example", &snapshot, "test-token")
        .await;
    server.abort();
    let seen = requests.lock().unwrap().clone();
    (result, seen)
}

#[tokio::test]
async fn creates_private_repo_then_disables_actions_and_grants_read_access_before_files() {
    let (result, seen) = exercise("").await;
    assert_eq!(result.unwrap().pull_number, 1);
    let index = |needle: &str| {
        seen.iter()
            .position(|(path, _)| path.contains(needle))
            .unwrap()
    };
    assert!(index("GET /organizations/1/team/2") < index("POST /orgs/test-org/repos"));
    assert!(index("POST /orgs/test-org/repos") < index("actions/permissions"));
    assert!(index("actions/permissions") < index("PUT /organizations/1/team/2/repos/"));
    assert!(index("PUT /organizations/1/team/2/repos/") < index("/git/blobs"));
    assert_eq!(seen[index("actions/permissions")].1["enabled"], false);
    assert_eq!(
        seen[index("PUT /organizations/1/team/2/repos/")].1["permission"],
        "pull"
    );
}

#[tokio::test]
async fn missing_members_permission_stops_before_creating_repository() {
    let (result, seen) = exercise("visibility").await;
    assert!(result.is_err());
    assert!(!seen.iter().any(|(path, _)| path.starts_with("POST")));
}

#[tokio::test]
async fn failed_team_assignment_stops_before_sending_project_files() {
    let (result, seen) = exercise("grant").await;
    assert!(result.is_err());
    assert!(
        !seen
            .iter()
            .any(|(path, _)| path.contains("/git/blobs") || path.ends_with("/pulls"))
    );
}
