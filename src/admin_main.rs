use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use reqwest::Method;
use reqwest::blocking::multipart::{Form, Part};
use serde_json::{Value, json};

use aidar::package::package_project;

#[derive(Parser)]
#[command(
    name = "aidar-admin",
    version,
    about = "Operate the AIDaR review service"
)]
struct Cli {
    #[arg(long, env = "AIDAR_BASE_URL", default_value = "http://localhost:3000")]
    server: String,
    #[arg(long)]
    token_stdin: bool,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    CreateInvitation {
        #[arg(long)]
        label: Option<String>,
    },
    CreateSubmission {
        #[arg(long)]
        external_id: Option<String>,
    },
    Status {
        submission_id: String,
    },
    AssignReviewer {
        submission_id: String,
        #[arg(long)]
        github_login: String,
    },
    SyncReviewer {
        submission_id: String,
        #[arg(long)]
        github_login: String,
    },
    RemoveReviewer {
        submission_id: String,
        #[arg(long)]
        github_login: String,
    },
    Decision {
        submission_id: String,
        #[arg(long)]
        value: String,
    },
    MockReview {
        submission_id: String,
        #[arg(long)]
        github_login: String,
        #[arg(long)]
        file: PathBuf,
        #[arg(long, default_value = "review")]
        r#type: String,
        #[arg(long)]
        path: Option<String>,
        #[arg(long)]
        line: Option<u64>,
        #[arg(long, default_value = "COMMENTED")]
        state: String,
    },
    Publish {
        submission_id: String,
        path: PathBuf,
        #[arg(long)]
        public_slug: String,
    },
    RevokeToken {
        submission_id: String,
    },
}

struct AdminApi {
    client: reqwest::blocking::Client,
    server: String,
    token: String,
}

impl AdminApi {
    fn new(server: &str, token: String) -> Result<Self> {
        let server = server.trim_end_matches('/').to_string();
        let url = url::Url::parse(&server).context("AIDaR server URL is invalid")?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("AIDaR server URL must use HTTP or HTTPS");
        }
        if url.scheme() == "http"
            && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
        {
            bail!("A remote AIDaR server must use HTTPS");
        }
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(1_800))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            server,
            token,
        })
    }

    fn request(&self, method: Method, path: &str, body: Option<Value>) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.server, path))
            .bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        response(request.send()?)
    }

    fn upload(&self, path: &str, project: &Path, public_slug: &str) -> Result<Value> {
        let package = package_project(project)?;
        let form = Form::new()
            .part(
                "archive",
                Part::bytes(package.archive)
                    .file_name("submission.tar.gz")
                    .mime_str("application/gzip")?,
            )
            .text("archive_sha256", package.digest)
            .text("public_slug", public_slug.to_string());
        response(
            self.client
                .post(format!("{}{}", self.server, path))
                .bearer_auth(&self.token)
                .multipart(form)
                .send()?,
        )
    }
}

fn response(response: reqwest::blocking::Response) -> Result<Value> {
    let status = response.status();
    let value: Value = response
        .json()
        .context("AIDaR server returned an invalid response")?;
    if !status.is_success() {
        bail!(
            "{}",
            value["error"].as_str().unwrap_or("AIDaR request failed")
        );
    }
    Ok(value)
}

fn admin_token(stdin: bool) -> Result<String> {
    if stdin {
        let mut value = String::new();
        std::io::stdin().read_to_string(&mut value)?;
        let value = value.trim().to_string();
        if value.is_empty() {
            bail!("Standard input did not contain an admin token");
        }
        return Ok(value);
    }
    std::env::var("AIDAR_ADMIN_TOKEN").context("Set AIDAR_ADMIN_TOKEN or use --token-stdin")
}

fn print(value: Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let api = AdminApi::new(&cli.server, admin_token(cli.token_stdin)?)?;
    let value = match cli.command {
        Command::CreateInvitation { label } => api.request(
            Method::POST,
            "/v1/admin/invitations",
            Some(json!({ "label": label })),
        )?,
        Command::CreateSubmission { external_id } => api.request(
            Method::POST,
            "/v1/admin/submissions",
            Some(json!({ "external_id": external_id })),
        )?,
        Command::Status { submission_id } => api.request(
            Method::GET,
            &format!("/v1/admin/submissions/{submission_id}"),
            None,
        )?,
        Command::AssignReviewer {
            submission_id,
            github_login,
        } => api.request(
            Method::POST,
            &format!("/v1/admin/submissions/{submission_id}/reviewers"),
            Some(json!({ "github_login": github_login })),
        )?,
        Command::SyncReviewer {
            submission_id,
            github_login,
        } => api.request(
            Method::POST,
            &format!("/v1/admin/submissions/{submission_id}/reviewers/{github_login}/sync"),
            None,
        )?,
        Command::RemoveReviewer {
            submission_id,
            github_login,
        } => api.request(
            Method::DELETE,
            &format!("/v1/admin/submissions/{submission_id}/reviewers/{github_login}"),
            None,
        )?,
        Command::Decision {
            submission_id,
            value,
        } => api.request(
            Method::POST,
            &format!("/v1/admin/submissions/{submission_id}/decision"),
            Some(json!({ "decision": value })),
        )?,
        Command::MockReview {
            submission_id,
            github_login,
            file,
            r#type,
            path,
            line,
            state,
        } => api.request(
            Method::POST,
            &format!("/v1/admin/submissions/{submission_id}/mock-reviews"),
            Some(json!({
                "github_login": github_login,
                "body": fs::read_to_string(&file)
                    .with_context(|| format!("Cannot read {}", file.display()))?,
                "type": r#type,
                "path": path,
                "line": line,
                "state": state
            })),
        )?,
        Command::Publish {
            submission_id,
            path,
            public_slug,
        } => api.upload(
            &format!("/v1/admin/submissions/{submission_id}/publish"),
            &path,
            &public_slug,
        )?,
        Command::RevokeToken { submission_id } => api.request(
            Method::POST,
            &format!("/v1/admin/submissions/{submission_id}/revoke-token"),
            None,
        )?,
    };
    print(value)
}

fn main() {
    let _ = dotenvy::dotenv();
    if let Err(error) = run() {
        eprintln!("ERROR: {error:#}");
        std::process::exit(1);
    }
}
