//! Opt-in live check: creates one private synthetic repository, never an author submission.
//! Run only with the approved production App configuration. Prints no credentials.
#![allow(dead_code)]

#[path = "../src/operator/archive.rs"]
mod archive;
#[path = "../src/operator/config.rs"]
mod config;
#[path = "../src/operator/database.rs"]
mod database;
#[path = "../src/operator/github.rs"]
mod github;
pub use aidar::package;

use anyhow::{Context, Result, ensure};
use github::{GithubGateway, LiveGateway};
use std::collections::BTreeMap;

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--create-synthetic-repository"),
        "Explicit --create-synthetic-repository is required"
    );
    let config = config::Config::load()?;
    let github = config
        .github
        .context("Live GitHub configuration is required")?;
    ensure!(
        github.review_team_id.is_some(),
        "A review team must be configured"
    );
    let gateway = LiveGateway::new(github)?;
    let id = format!("smoke-{}", uuid::Uuid::new_v4().simple());
    println!("Synthetic test repository: submission-{id}");
    let mut files = BTreeMap::from([(
        "CHECK.txt".to_string(),
        b"Synthetic deployment verification. No author material.\n".to_vec(),
    )]);
    let created = gateway.create_submission(&id, &files).await?;
    ensure!(!created.head_sha.is_empty(), "Missing submission commit");
    println!("Private repository, committee access, files and review PR created successfully.");
    let record = database::Submission {
        id,
        external_id: None,
        revoked_at: None,
        status: "under_review".into(),
        repo_name: Some(created.repo_name),
        pr_number: Some(created.pull_number),
        submission_branch: "submission".into(),
        branch_head_sha: Some(created.head_sha),
        revision: 1,
        package_sha256: None,
        updated_at: String::new(),
    };
    files.insert(
        "CHECK.txt".into(),
        b"Synthetic revision verification.\n".to_vec(),
    );
    gateway.revise(&record, &files, 2).await?;
    gateway.list_reviews(&record).await?;
    println!("Revision upload and review retrieval succeeded.");
    gateway.close_review(&record).await?;
    println!(
        "Synthetic review PR closed. Repository retained for operator verification and archival."
    );
    Ok(())
}
