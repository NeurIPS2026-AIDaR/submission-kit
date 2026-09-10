#[cfg(test)]
#[path = "github/team_tests.rs"]
mod team_tests;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use base64::Engine;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reqwest::{Client, Method};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::archive::Snapshot;
use super::config::GithubConfig;
use super::database::Submission;

const API: &str = "https://api.github.com";
const REVIEW_GUIDE: &str = r#"# AIDaR review guide

The author is anonymous. Review with your assigned GitHub account.

Do not run submitted code outside an appropriate sandbox. Use pull-request reviews, inline comments, and the PR conversation. Author responses and revisions appear under the AIDaR bot identity.

## Review structure

## Summary
## Main contributions
## Strengths
## Major concerns
## Minor concerns
## Artifact and reproducibility assessment
## Questions for the authors
## Recommendation and confidence
"#;

#[derive(Clone, Serialize)]
pub struct ReviewItem {
    pub id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub reviewer_login: String,
    pub body: String,
    pub state: Option<String>,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub in_reply_to_id: Option<u64>,
    pub created_at: String,
}

pub struct SubmissionResult {
    pub repo_id: i64,
    pub repo_name: String,
    pub pull_number: u64,
    pub head_sha: String,
}

pub struct MockReview<'a> {
    pub kind: &'a str,
    pub body: &'a str,
    pub path: Option<&'a str>,
    pub line: Option<u64>,
    pub state: Option<&'a str>,
}

#[async_trait]
pub trait GithubGateway: Send + Sync {
    fn mode(&self) -> &'static str;
    async fn create_submission(&self, id: &str, snapshot: &Snapshot) -> Result<SubmissionResult>;
    async fn revise(
        &self,
        record: &Submission,
        snapshot: &Snapshot,
        revision: u32,
    ) -> Result<String>;
    async fn assign_reviewer(&self, record: &Submission, login: &str) -> Result<String>;
    async fn sync_reviewer(&self, record: &Submission, login: &str) -> Result<String>;
    async fn remove_reviewer(&self, record: &Submission, login: &str) -> Result<()>;
    async fn list_reviews(&self, record: &Submission) -> Result<Vec<ReviewItem>>;
    async fn post_response(
        &self,
        record: &Submission,
        body: &str,
        reply_to: Option<u64>,
    ) -> Result<u64>;
    async fn close_review(&self, record: &Submission) -> Result<()>;
    async fn publish(&self, record: &Submission, slug: &str, snapshot: &Snapshot) -> Result<u64>;
    async fn inject_mock_review(
        &self,
        _submission_id: &str,
        _login: &str,
        _review: MockReview<'_>,
    ) -> Result<u64> {
        bail!("Mock review injection is available only in mock mode")
    }
}

struct MockRepository {
    head_sha: String,
    files: Snapshot,
    reviewers: HashSet<String>,
    reviews: Vec<ReviewItem>,
    next_comment_id: u64,
}

pub struct MockGateway {
    repositories: Mutex<HashMap<String, MockRepository>>,
}

impl MockGateway {
    pub fn new() -> Self {
        Self {
            repositories: Mutex::new(HashMap::new()),
        }
    }

    fn sha(values: &[&str]) -> String {
        let mut hash = Sha256::new();
        for value in values {
            hash.update(value.as_bytes());
        }
        hex::encode(hash.finalize())
    }
}

#[async_trait]
impl GithubGateway for MockGateway {
    fn mode(&self) -> &'static str {
        "mock"
    }

    async fn create_submission(&self, id: &str, snapshot: &Snapshot) -> Result<SubmissionResult> {
        let name = format!("submission-{id}");
        let head_sha = Self::sha(&[id, "revision-1"]);
        let repo_id = i64::from_str_radix(&Self::sha(&[&name])[..12], 16)?;
        self.repositories
            .lock()
            .expect("mock lock poisoned")
            .insert(
                id.to_string(),
                MockRepository {
                    head_sha: head_sha.clone(),
                    files: snapshot.clone(),
                    reviewers: HashSet::new(),
                    reviews: Vec::new(),
                    next_comment_id: 10_000,
                },
            );
        Ok(SubmissionResult {
            repo_id,
            repo_name: name,
            pull_number: 1,
            head_sha,
        })
    }

    async fn revise(
        &self,
        record: &Submission,
        snapshot: &Snapshot,
        revision: u32,
    ) -> Result<String> {
        let mut repositories = self.repositories.lock().expect("mock lock poisoned");
        let repo = repositories
            .get_mut(&record.id)
            .context("Mock repository does not exist")?;
        repo.head_sha = Self::sha(&[&repo.head_sha, &revision.to_string()]);
        repo.files = snapshot.clone();
        Ok(repo.head_sha.clone())
    }

    async fn assign_reviewer(&self, record: &Submission, login: &str) -> Result<String> {
        self.repositories
            .lock()
            .expect("mock lock poisoned")
            .get_mut(&record.id)
            .context("Mock repository does not exist")?
            .reviewers
            .insert(login.to_string());
        Ok("review_requested".to_string())
    }

    async fn sync_reviewer(&self, record: &Submission, login: &str) -> Result<String> {
        self.assign_reviewer(record, login).await
    }

    async fn remove_reviewer(&self, record: &Submission, login: &str) -> Result<()> {
        self.repositories
            .lock()
            .expect("mock lock poisoned")
            .get_mut(&record.id)
            .context("Mock repository does not exist")?
            .reviewers
            .remove(login);
        Ok(())
    }

    async fn list_reviews(&self, record: &Submission) -> Result<Vec<ReviewItem>> {
        Ok(self
            .repositories
            .lock()
            .expect("mock lock poisoned")
            .get(&record.id)
            .context("Mock repository does not exist")?
            .reviews
            .clone())
    }

    async fn post_response(
        &self,
        record: &Submission,
        _body: &str,
        _reply_to: Option<u64>,
    ) -> Result<u64> {
        let mut repositories = self.repositories.lock().expect("mock lock poisoned");
        let repo = repositories
            .get_mut(&record.id)
            .context("Mock repository does not exist")?;
        let id = repo.next_comment_id;
        repo.next_comment_id += 1;
        Ok(id)
    }

    async fn close_review(&self, record: &Submission) -> Result<()> {
        self.repositories
            .lock()
            .expect("mock lock poisoned")
            .get(&record.id)
            .context("Mock repository does not exist")?;
        Ok(())
    }

    async fn publish(&self, record: &Submission, slug: &str, _snapshot: &Snapshot) -> Result<u64> {
        if !valid_slug(slug) {
            bail!("Public slug is invalid");
        }
        self.repositories
            .lock()
            .expect("mock lock poisoned")
            .get(&record.id)
            .context("Mock repository does not exist")?;
        Ok(1)
    }

    async fn inject_mock_review(
        &self,
        submission_id: &str,
        login: &str,
        review: MockReview<'_>,
    ) -> Result<u64> {
        let mut repositories = self.repositories.lock().expect("mock lock poisoned");
        let repo = repositories
            .get_mut(submission_id)
            .context("Mock repository does not exist")?;
        if !repo.reviewers.contains(login) {
            bail!("Reviewer does not have access to this submission");
        }
        let id = repo.reviews.len() as u64 + 1;
        repo.reviews.push(ReviewItem {
            id,
            kind: review.kind.to_string(),
            reviewer_login: login.to_string(),
            body: review.body.to_string(),
            state: review.state.map(str::to_string),
            path: review.path.map(str::to_string),
            line: review.line,
            in_reply_to_id: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        });
        Ok(id)
    }
}

pub struct LiveGateway {
    config: GithubConfig,
    client: Client,
    encoding_key: EncodingKey,
    api_base: String,
}

struct CommitSpec<'a> {
    token: &'a str,
    repo: &'a str,
    parent_sha: &'a str,
    base_tree_sha: &'a str,
    files: &'a Snapshot,
    message: String,
    prefix: String,
}

#[derive(Serialize)]
struct Claims {
    iat: i64,
    exp: i64,
    iss: String,
}

impl LiveGateway {
    pub fn new(config: GithubConfig) -> Result<Self> {
        let encoding_key = EncodingKey::from_rsa_pem(config.private_key.as_bytes())?;
        Ok(Self {
            config,
            api_base: API.to_string(),
            client: Client::builder()
                .user_agent("aidar-server/0.1")
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            encoding_key,
        })
    }

    fn app_jwt(&self) -> Result<String> {
        let now = chrono::Utc::now().timestamp();
        Ok(encode(
            &Header::new(Algorithm::RS256),
            &Claims {
                iat: now - 60,
                exp: now + 540,
                iss: self.config.app_id.clone(),
            },
            &self.encoding_key,
        )?)
    }

    async fn installation_token(&self) -> Result<String> {
        let response = self
            .client
            .post(format!(
                "{API}/app/installations/{}/access_tokens",
                self.config.installation_id
            ))
            .bearer_auth(self.app_jwt()?)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", &self.config.api_version)
            .send()
            .await?;
        let value = response_json(response).await?;
        value["token"]
            .as_str()
            .map(str::to_string)
            .context("GitHub did not return an installation token")
    }

    async fn call(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.api_base))
            .bearer_auth(token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", &self.config.api_version);
        if let Some(body) = body {
            request = request.json(&body);
        }
        response_json(request.send().await?).await
    }

    async fn commit_tree(&self, spec: CommitSpec<'_>) -> Result<String> {
        let mut entries = Vec::new();
        for (path, data) in spec.files {
            let blob = self
                .call(
                    spec.token,
                    Method::POST,
                    &format!("/repos/{}/{}/git/blobs", self.config.org, spec.repo),
                    Some(json!({
                        "content": base64::engine::general_purpose::STANDARD.encode(data),
                        "encoding": "base64"
                    })),
                )
                .await?;
            entries.push(json!({
                "path": format!("{}{path}", spec.prefix),
                "mode": "100644",
                "type": "blob",
                "sha": required_str(&blob, "sha")?
            }));
        }
        let tree = self
            .call(
                spec.token,
                Method::POST,
                &format!("/repos/{}/{}/git/trees", self.config.org, spec.repo),
                Some(json!({ "base_tree": spec.base_tree_sha, "tree": entries })),
            )
            .await?;
        let commit = self
            .call(
                spec.token,
                Method::POST,
                &format!("/repos/{}/{}/git/commits", self.config.org, spec.repo),
                Some(json!({
                    "message": spec.message,
                    "tree": required_str(&tree, "sha")?,
                    "parents": [spec.parent_sha]
                })),
            )
            .await?;
        Ok(required_str(&commit, "sha")?.to_string())
    }

    fn repo<'a>(&self, record: &'a Submission) -> Result<&'a str> {
        record
            .repo_name
            .as_deref()
            .context("Submission repository is not ready")
    }

    fn pull(&self, record: &Submission) -> Result<u64> {
        record
            .pr_number
            .context("Submission pull request is not ready")
    }
}

impl LiveGateway {
    async fn create_submission_with_token(
        &self,
        id: &str,
        snapshot: &Snapshot,
        token: &str,
    ) -> Result<SubmissionResult> {
        let repo = format!("submission-{id}");
        let settings = json!({
            "name": repo,
            "private": true,
            "auto_init": true,
            "description": "Anonymous AIDaR workshop review",
            "has_issues": true,
            "has_projects": false,
            "has_wiki": false,
            "has_discussions": false
        });
        // Check team visibility before creating anything. Installation tokens need
        // Members: read in addition to repository Administration: write.
        let team_path = if let Some(team_id) = self.config.review_team_id {
            let org = self
                .call(
                    token,
                    Method::GET,
                    &format!("/orgs/{}", self.config.org),
                    None,
                )
                .await?;
            let org_id = org["id"]
                .as_u64()
                .context("GitHub organization id is missing")?;
            let path = format!("/organizations/{org_id}/team/{team_id}");
            self.call(token, Method::GET, &path, None).await.context(
                "Cannot read the configured review team; check the App's Members read permission",
            )?;
            Some(format!("{path}/repos/{}/{repo}", self.config.org))
        } else {
            None
        };
        let created = self
            .call(
                token,
                Method::POST,
                &format!("/orgs/{}/repos", self.config.org),
                Some(settings),
            )
            .await?;
        let repo_id = created["id"]
            .as_i64()
            .context("GitHub repository id is missing")?;
        let default_branch = required_str(&created, "default_branch")?;
        if default_branch != "main" {
            self.call(
                token,
                Method::POST,
                &format!(
                    "/repos/{}/{repo}/branches/{default_branch}/rename",
                    self.config.org
                ),
                Some(json!({ "new_name": "main" })),
            )
            .await?;
        }
        self.call(
            &token,
            Method::PUT,
            &format!("/repos/{}/{repo}/actions/permissions", self.config.org),
            Some(json!({ "enabled": false })),
        )
        .await?;
        if let Some(path) = team_path {
            // The repository-creation team_id field requires team-admin access
            // and rejects installation tokens. Use the supported Teams endpoint
            // and retain the committee's existing read-only repository role.
            self.call(
                token,
                Method::PUT,
                &path,
                Some(json!({ "permission": "pull" })),
            )
            .await
            .context("Cannot grant review-team access; no project files were sent")?;
        }
        let initial = self
            .call(
                token,
                Method::GET,
                &format!("/repos/{}/{repo}/branches/main", self.config.org),
                None,
            )
            .await?;
        let initial_sha = required_nested_str(&initial, &["commit", "sha"])?;
        let initial_commit = self
            .call(
                token,
                Method::GET,
                &format!(
                    "/repos/{}/{repo}/git/commits/{initial_sha}",
                    self.config.org
                ),
                None,
            )
            .await?;
        let mut shell = BTreeMap::new();
        shell.insert(
            "README.md".to_string(),
            format!("# Submission {id}\n\nAnonymous AIDaR review repository.\n").into_bytes(),
        );
        shell.insert(
            "REVIEW_GUIDE.md".to_string(),
            REVIEW_GUIDE.as_bytes().to_vec(),
        );
        shell.insert(
            "SECURITY.md".to_string(),
            b"# Security\n\nTreat every submitted artifact as untrusted. Do not run code without an appropriate sandbox.\n".to_vec(),
        );
        shell.insert(
            "metadata/submission.json".to_string(),
            serde_json::to_vec_pretty(&json!({
                "submission_id": id,
                "schema_version": "0.1",
                "review_model": "anonymous-authors-named-reviewers"
            }))?,
        );
        let shell_sha = self
            .commit_tree(CommitSpec {
                token,
                repo: &repo,
                parent_sha: initial_sha,
                base_tree_sha: required_nested_str(&initial_commit, &["tree", "sha"])?,
                files: &shell,
                message: format!("Initialize review shell for submission {id}"),
                prefix: String::new(),
            })
            .await?;
        self.call(
            &token,
            Method::PATCH,
            &format!("/repos/{}/{repo}/git/refs/heads/main", self.config.org),
            Some(json!({ "sha": shell_sha })),
        )
        .await?;
        let shell_commit = self
            .call(
                token,
                Method::GET,
                &format!("/repos/{}/{repo}/git/commits/{shell_sha}", self.config.org),
                None,
            )
            .await?;
        self.call(
            &token,
            Method::POST,
            &format!("/repos/{}/{repo}/git/refs", self.config.org),
            Some(json!({ "ref": "refs/heads/submission", "sha": shell_sha })),
        )
        .await?;
        let head_sha = self
            .commit_tree(CommitSpec {
                token,
                repo: &repo,
                parent_sha: &shell_sha,
                base_tree_sha: required_nested_str(&shell_commit, &["tree", "sha"])?,
                files: snapshot,
                message: format!("Revision 1 for submission {id}"),
                prefix: String::new(),
            })
            .await?;
        self.call(
            &token,
            Method::PATCH,
            &format!(
                "/repos/{}/{repo}/git/refs/heads/submission",
                self.config.org
            ),
            Some(json!({ "sha": head_sha })),
        )
        .await?;
        let pull = self
            .call(
                token,
                Method::POST,
                &format!("/repos/{}/{repo}/pulls", self.config.org),
                Some(json!({
                    "title": format!("Submission {id}"),
                    "base": "main",
                    "head": "submission",
                    "body": "This is an anonymous author submission. Reviewers use named GitHub accounts. Author responses and revisions are relayed by the AIDaR bot.\n\nDo not execute submitted code outside an appropriate sandbox. See REVIEW_GUIDE.md."
                })),
            )
            .await?;
        Ok(SubmissionResult {
            repo_id,
            repo_name: repo,
            pull_number: pull["number"]
                .as_u64()
                .context("GitHub pull request number is missing")?,
            head_sha,
        })
    }
}

#[async_trait]
impl GithubGateway for LiveGateway {
    fn mode(&self) -> &'static str {
        "live"
    }

    async fn create_submission(&self, id: &str, snapshot: &Snapshot) -> Result<SubmissionResult> {
        let token = self.installation_token().await?;
        self.create_submission_with_token(id, snapshot, &token)
            .await
    }

    async fn revise(
        &self,
        record: &Submission,
        snapshot: &Snapshot,
        revision: u32,
    ) -> Result<String> {
        let token = self.installation_token().await?;
        let repo = self.repo(record)?;
        let branch = self
            .call(
                &token,
                Method::GET,
                &format!(
                    "/repos/{}/{repo}/branches/{}",
                    self.config.org, record.submission_branch
                ),
                None,
            )
            .await?;
        let branch_sha = required_nested_str(&branch, &["commit", "sha"])?;
        if let Some(expected) = &record.branch_head_sha
            && expected != branch_sha
        {
            bail!("Submission branch changed outside AIDaR; revision stopped");
        }
        let main = self
            .call(
                &token,
                Method::GET,
                &format!("/repos/{}/{repo}/branches/main", self.config.org),
                None,
            )
            .await?;
        let main_sha = required_nested_str(&main, &["commit", "sha"])?;
        let main_commit = self
            .call(
                &token,
                Method::GET,
                &format!("/repos/{}/{repo}/git/commits/{main_sha}", self.config.org),
                None,
            )
            .await?;
        let head_sha = self
            .commit_tree(CommitSpec {
                token: &token,
                repo,
                parent_sha: branch_sha,
                base_tree_sha: required_nested_str(&main_commit, &["tree", "sha"])?,
                files: snapshot,
                message: format!("Revision {revision} for submission {}", record.id),
                prefix: String::new(),
            })
            .await?;
        self.call(
            &token,
            Method::PATCH,
            &format!(
                "/repos/{}/{repo}/git/refs/heads/{}",
                self.config.org, record.submission_branch
            ),
            Some(json!({ "sha": head_sha, "force": false })),
        )
        .await?;
        self.call(
            &token,
            Method::POST,
            &format!("/repos/{}/{repo}/issues/{}/comments", self.config.org, self.pull(record)?),
            Some(json!({ "body": format!("## AIDaR Revision {revision}\n\nComplete replacement snapshot received.") })),
        )
        .await?;
        Ok(head_sha)
    }

    async fn assign_reviewer(&self, record: &Submission, login: &str) -> Result<String> {
        let token = self.installation_token().await?;
        let repo = self.repo(record)?;
        self.call(
            &token,
            Method::PUT,
            &format!("/repos/{}/{repo}/collaborators/{login}", self.config.org),
            Some(json!({ "permission": "pull" })),
        )
        .await?;
        match self
            .call(
                &token,
                Method::POST,
                &format!(
                    "/repos/{}/{repo}/pulls/{}/requested_reviewers",
                    self.config.org,
                    self.pull(record)?
                ),
                Some(json!({ "reviewers": [login] })),
            )
            .await
        {
            Ok(_) => Ok("review_requested".to_string()),
            Err(error) if error.to_string().contains("422") => Ok("pending_acceptance".to_string()),
            Err(error) => Err(error),
        }
    }

    async fn sync_reviewer(&self, record: &Submission, login: &str) -> Result<String> {
        let token = self.installation_token().await?;
        let repo = self.repo(record)?;
        self.call(
            &token,
            Method::GET,
            &format!("/repos/{}/{repo}/collaborators/{login}", self.config.org),
            None,
        )
        .await?;
        self.call(
            &token,
            Method::POST,
            &format!(
                "/repos/{}/{repo}/pulls/{}/requested_reviewers",
                self.config.org,
                self.pull(record)?
            ),
            Some(json!({ "reviewers": [login] })),
        )
        .await?;
        Ok("review_requested".to_string())
    }

    async fn remove_reviewer(&self, record: &Submission, login: &str) -> Result<()> {
        let token = self.installation_token().await?;
        self.call(
            &token,
            Method::DELETE,
            &format!(
                "/repos/{}/{}/collaborators/{login}",
                self.config.org,
                self.repo(record)?
            ),
            None,
        )
        .await?;
        Ok(())
    }

    async fn list_reviews(&self, record: &Submission) -> Result<Vec<ReviewItem>> {
        let token = self.installation_token().await?;
        let repo = self.repo(record)?;
        let pull = self.pull(record)?;
        let reviews = self
            .call(
                &token,
                Method::GET,
                &format!(
                    "/repos/{}/{repo}/pulls/{pull}/reviews?per_page=100",
                    self.config.org
                ),
                None,
            )
            .await?;
        let comments = self
            .call(
                &token,
                Method::GET,
                &format!(
                    "/repos/{}/{repo}/issues/{pull}/comments?per_page=100",
                    self.config.org
                ),
                None,
            )
            .await?;
        let inline = self
            .call(
                &token,
                Method::GET,
                &format!(
                    "/repos/{}/{repo}/pulls/{pull}/comments?per_page=100",
                    self.config.org
                ),
                None,
            )
            .await?;
        let mut output = Vec::new();
        append_reviews(&mut output, &reviews, "review");
        append_reviews(&mut output, &comments, "comment");
        append_reviews(&mut output, &inline, "inline_comment");
        output.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        Ok(output)
    }

    async fn post_response(
        &self,
        record: &Submission,
        body: &str,
        reply_to: Option<u64>,
    ) -> Result<u64> {
        let token = self.installation_token().await?;
        let reference = reply_to
            .map(|id| format!("\n\nIn response to review comment ID `{id}`."))
            .unwrap_or_default();
        let result = self
            .call(
                &token,
                Method::POST,
                &format!(
                    "/repos/{}/{}/issues/{}/comments",
                    self.config.org,
                    self.repo(record)?,
                    self.pull(record)?
                ),
                Some(json!({
                    "body": format!("## AIDaR Author Response — Submission {}{reference}\n\n{body}", record.id)
                })),
            )
            .await?;
        result["id"]
            .as_u64()
            .context("GitHub comment id is missing")
    }

    async fn close_review(&self, record: &Submission) -> Result<()> {
        let token = self.installation_token().await?;
        self.call(
            &token,
            Method::PATCH,
            &format!(
                "/repos/{}/{}/pulls/{}",
                self.config.org,
                self.repo(record)?,
                self.pull(record)?
            ),
            Some(json!({ "state": "closed" })),
        )
        .await?;
        Ok(())
    }

    async fn publish(&self, record: &Submission, slug: &str, snapshot: &Snapshot) -> Result<u64> {
        if !valid_slug(slug) {
            bail!("Public slug is invalid");
        }
        let token = self.installation_token().await?;
        let repo = &self.config.public_archive_repo;
        let repository = self
            .call(
                &token,
                Method::GET,
                &format!("/repos/{}/{repo}", self.config.org),
                None,
            )
            .await?;
        let base = required_str(&repository, "default_branch")?;
        let branch = self
            .call(
                &token,
                Method::GET,
                &format!("/repos/{}/{repo}/branches/{base}", self.config.org),
                None,
            )
            .await?;
        let base_sha = required_nested_str(&branch, &["commit", "sha"])?;
        let base_commit = self
            .call(
                &token,
                Method::GET,
                &format!("/repos/{}/{repo}/git/commits/{base_sha}", self.config.org),
                None,
            )
            .await?;
        let publish_branch = format!("publish/{}", record.id);
        self.call(
            &token,
            Method::POST,
            &format!("/repos/{}/{repo}/git/refs", self.config.org),
            Some(json!({ "ref": format!("refs/heads/{publish_branch}"), "sha": base_sha })),
        )
        .await?;
        let head_sha = self
            .commit_tree(CommitSpec {
                token: &token,
                repo,
                parent_sha: base_sha,
                base_tree_sha: required_nested_str(&base_commit, &["tree", "sha"])?,
                files: snapshot,
                message: format!("Publish accepted submission {}", record.id),
                prefix: format!("submissions/{slug}/"),
            })
            .await?;
        self.call(
            &token,
            Method::PATCH,
            &format!(
                "/repos/{}/{repo}/git/refs/heads/{publish_branch}",
                self.config.org
            ),
            Some(json!({ "sha": head_sha })),
        )
        .await?;
        let pull = self
            .call(
                &token,
                Method::POST,
                &format!("/repos/{}/{repo}/pulls", self.config.org),
                Some(json!({
                    "base": base,
                    "head": publish_branch,
                    "title": format!("Publish accepted submission: {slug}"),
                    "body": format!("Publication package for accepted AIDaR submission {}.", record.id)
                })),
            )
            .await?;
        pull["number"]
            .as_u64()
            .context("GitHub pull request number is missing")
    }
}

async fn response_json(response: reqwest::Response) -> Result<Value> {
    let status = response.status();
    let text = response.text().await?;
    let value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or_else(|_| json!({ "message": text }))
    };
    if !status.is_success() {
        bail!(
            "GitHub API {}: {}",
            status.as_u16(),
            value["message"].as_str().unwrap_or("request failed")
        );
    }
    Ok(value)
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("GitHub response is missing {key}"))
}

fn required_nested_str<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a str> {
    let mut cursor = value;
    for key in keys {
        cursor = &cursor[*key];
    }
    cursor
        .as_str()
        .with_context(|| format!("GitHub response is missing {}", keys.join(".")))
}

fn append_reviews(output: &mut Vec<ReviewItem>, value: &Value, kind: &str) {
    let Some(items) = value.as_array() else {
        return;
    };
    for item in items {
        output.push(ReviewItem {
            id: item["id"].as_u64().unwrap_or(0),
            kind: kind.to_string(),
            reviewer_login: item["user"]["login"]
                .as_str()
                .unwrap_or("unknown")
                .to_string(),
            body: item["body"].as_str().unwrap_or("").to_string(),
            state: item["state"].as_str().map(str::to_string),
            path: item["path"].as_str().map(str::to_string),
            line: item["line"]
                .as_u64()
                .or_else(|| item["original_line"].as_u64()),
            in_reply_to_id: item["in_reply_to_id"].as_u64(),
            created_at: item["submitted_at"]
                .as_str()
                .or_else(|| item["created_at"].as_str())
                .unwrap_or("1970-01-01T00:00:00Z")
                .to_string(),
        });
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 63
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || (character == '-' && index > 0)
        })
}
