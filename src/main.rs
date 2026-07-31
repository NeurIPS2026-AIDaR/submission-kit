use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use serde::Deserialize;
use serde_json::Value;

use aidar::api::Api;
use aidar::package::{package_project, validate_response};
use aidar::store::{load_credential, save_credential};

#[derive(Parser)]
#[command(name = "aidar", version, about = "Submit research artifacts to AIDaR")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check a project without uploading it.
    Check { path: PathBuf },
    /// Create a submission.
    Submit {
        path: PathBuf,
        #[arg(long, env = "AIDAR_BASE_URL")]
        server: String,
        #[arg(long)]
        openreview: Option<String>,
        #[arg(long, env = "AIDAR_INVITATION_CODE")]
        invitation_code: Option<String>,
        #[arg(long)]
        submission: Option<String>,
    },
    /// Import the private credential downloaded after a browser submission.
    ImportCredential {
        receipt: PathBuf,
        #[arg(long, default_value = ".")]
        project: PathBuf,
    },
    /// Replace the current submission snapshot.
    Revise {
        path: PathBuf,
        #[arg(long, env = "AIDAR_BASE_URL")]
        server: String,
        #[arg(long)]
        submission: Option<String>,
    },
    /// Show submission status.
    Status {
        #[arg(long, env = "AIDAR_BASE_URL")]
        server: String,
        #[arg(long, default_value = ".")]
        project: PathBuf,
        #[arg(long)]
        submission: Option<String>,
    },
    /// Read reviews and comments.
    Reviews {
        #[arg(long, env = "AIDAR_BASE_URL")]
        server: String,
        #[arg(long, default_value = ".")]
        project: PathBuf,
        #[arg(long)]
        submission: Option<String>,
    },
    /// Send an author response through the AIDaR bot.
    Respond {
        #[arg(long, env = "AIDAR_BASE_URL")]
        server: String,
        #[arg(long, default_value = ".")]
        project: PathBuf,
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        reply_to: Option<u64>,
        #[arg(long)]
        submission: Option<String>,
    },
}

fn normalize_server(value: &str) -> String {
    value.trim_end_matches('/').to_string()
}

fn normalize_openreview(value: &str) -> Result<String> {
    let url = url::Url::parse(value.trim()).context("OpenReview forum URL is invalid")?;
    if url.scheme() != "https"
        || url.host_str() != Some("openreview.net")
        || url.port().is_some()
        || url.path() != "/forum"
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
    Ok(format!("https://openreview.net/forum?id={id}"))
}

#[derive(Deserialize)]
struct BrowserCredentialReceipt {
    version: u8,
    kind: String,
    submission_id: String,
    server: String,
    author_token: String,
}

fn import_credential(receipt: &Path, project: &Path) -> Result<()> {
    let value: BrowserCredentialReceipt = serde_json::from_slice(
        &fs::read(receipt).with_context(|| format!("Cannot read {}", receipt.display()))?,
    )
    .context("Browser credential file is invalid")?;
    if value.version != 1
        || value.kind != "aidar-browser-credential"
        || value.submission_id.len() != 12
        || !value
            .submission_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
        || !value.author_token.starts_with("aidar_sub_")
        || value.author_token.len() > 128
    {
        bail!("Browser credential file is invalid");
    }
    Api::new(&value.server)?;
    let project = resolve_project(project)?;
    save_credential(
        &value.submission_id,
        &normalize_server(&value.server),
        &project,
        &value.author_token,
    )?;
    println!(
        "Imported private credential for submission {}.",
        value.submission_id
    );
    Ok(())
}

fn print_json(value: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn resolve_project(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("Project does not exist: {}", path.display()))
}

fn submit(
    path: &Path,
    server: &str,
    openreview: Option<&str>,
    invitation_code: Option<&str>,
    submission: Option<&str>,
    revision: bool,
) -> Result<()> {
    let path = resolve_project(path)?;
    let server = normalize_server(server);
    let packaged = package_project(&path)?;
    println!("{}", packaged.summary);
    let api = Api::new(&server)?;
    let credential = if revision || submission.is_some() {
        load_credential(&server, &path, submission)?
    } else {
        let openreview =
            normalize_openreview(openreview.context("The OpenReview forum URL is required")?)?;
        let invitation_code = invitation_code
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .context(
                "An invitation code is required; use --invitation-code or AIDAR_INVITATION_CODE",
            )?;
        let registration = api.register(&openreview, invitation_code)?;
        let submission_id = registration
            .get("submission_id")
            .and_then(Value::as_str)
            .context("Server did not return a submission id")?;
        let author_token = registration
            .get("author_token")
            .and_then(Value::as_str)
            .context("Server did not return an author credential")?;
        if submission_id.len() != 12
            || !submission_id.chars().all(|value| value.is_ascii_hexdigit())
            || !author_token.starts_with("aidar_sub_")
        {
            bail!("Server returned an invalid submission credential");
        }
        save_credential(submission_id, &server, &path, author_token)?;
        load_credential(&server, &path, Some(submission_id))?
    };
    let endpoint = if revision {
        "/v1/author/revise"
    } else {
        "/v1/author/submit"
    };
    match api.upload(
        endpoint,
        &credential.author_token,
        packaged.archive,
        &packaged.digest,
    ) {
        Ok(result) => print_json(&result),
        Err(error) if !revision && submission.is_none() => {
            bail!(
                "Submission {} was created and saved locally. Retry with --submission {}. {error}",
                credential.submission_id,
                credential.submission_id
            )
        }
        Err(error) => Err(error),
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Check { path } => {
            let result = package_project(&path)?;
            println!("{}\n\nREADY\nSHA-256 {}", result.summary, result.digest);
            Ok(())
        }
        Command::Submit {
            path,
            server,
            openreview,
            invitation_code,
            submission,
        } => submit(
            &path,
            &server,
            openreview.as_deref(),
            invitation_code.as_deref(),
            submission.as_deref(),
            false,
        ),
        Command::ImportCredential { receipt, project } => import_credential(&receipt, &project),
        Command::Revise {
            path,
            server,
            submission,
        } => submit(&path, &server, None, None, submission.as_deref(), true),
        Command::Status {
            server,
            project,
            submission,
        } => {
            let server = normalize_server(&server);
            let credential =
                load_credential(&server, &resolve_project(&project)?, submission.as_deref())?;
            print_json(&Api::new(&server)?.get("/v1/author/status", &credential.author_token)?)
        }
        Command::Reviews {
            server,
            project,
            submission,
        } => {
            let server = normalize_server(&server);
            let credential =
                load_credential(&server, &resolve_project(&project)?, submission.as_deref())?;
            print_json(&Api::new(&server)?.get("/v1/author/reviews", &credential.author_token)?)
        }
        Command::Respond {
            server,
            project,
            file,
            reply_to,
            submission,
        } => {
            let server = normalize_server(&server);
            let project = resolve_project(&project)?;
            let body = fs::read_to_string(&file)
                .with_context(|| format!("Cannot read {}", file.display()))?;
            validate_response(&project, &body)?;
            let credential = load_credential(&server, &project, submission.as_deref())?;
            print_json(&Api::new(&server)?.respond(&credential.author_token, &body, reply_to)?)
        }
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("ERROR: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_openreview;

    #[test]
    fn normalizes_openreview_forum_urls() {
        assert_eq!(
            normalize_openreview("https://openreview.net/forum?id=Abc_123-xyz#discussion").unwrap(),
            "https://openreview.net/forum?id=Abc_123-xyz"
        );
    }

    #[test]
    fn rejects_non_forum_urls() {
        assert!(normalize_openreview("https://example.org/forum?id=Abc_123").is_err());
        assert!(normalize_openreview("http://openreview.net/forum?id=Abc_123").is_err());
        assert!(normalize_openreview("https://openreview.net/pdf?id=Abc_123").is_err());
    }
}
