use std::fs;
use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, external_id TEXT UNIQUE, author_token_hmac TEXT NOT NULL UNIQUE,
  revoked_at TEXT, status TEXT NOT NULL, repo_id INTEGER, repo_name TEXT,
  pr_number INTEGER, submission_branch TEXT NOT NULL DEFAULT 'submission',
  branch_head_sha TEXT, revision INTEGER NOT NULL DEFAULT 0, package_sha256 TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviewers (
  submission_id TEXT NOT NULL, github_login TEXT NOT NULL, state TEXT NOT NULL,
  invited_at TEXT, accepted_at TEXT, review_requested_at TEXT, removed_at TEXT,
  PRIMARY KEY (submission_id, github_login),
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);
CREATE TABLE IF NOT EXISTS responses (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL, github_comment_id INTEGER,
  reply_to_review_comment_id INTEGER, body_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY, submission_id TEXT NOT NULL, request_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invitations (
  code_hmac TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_at TEXT, submission_id TEXT,
  FOREIGN KEY (submission_id) REFERENCES submissions(id)
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, submission_id TEXT, event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL, github_object_id TEXT, payload_sha256 TEXT, created_at TEXT NOT NULL
);
"#;

#[derive(Clone, Debug)]
pub struct Submission {
    pub id: String,
    pub external_id: Option<String>,
    pub revoked_at: Option<String>,
    pub status: String,
    pub repo_name: Option<String>,
    pub pr_number: Option<u64>,
    pub submission_branch: String,
    pub branch_head_sha: Option<String>,
    pub revision: u32,
    pub package_sha256: Option<String>,
    pub updated_at: String,
}

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode = WAL;")?;
        connection.execute_batch(SCHEMA)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn with<T>(&self, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        operation(&self.connection.lock().expect("database lock poisoned"))
    }

    pub fn submission_by_id(connection: &Connection, id: &str) -> Result<Submission> {
        connection
            .query_row(
                "SELECT id, external_id, revoked_at, status, repo_name, pr_number, submission_branch, branch_head_sha, revision, package_sha256, updated_at FROM submissions WHERE id = ?1",
                [id],
                row_submission,
            )
            .optional()?
            .context("Submission does not exist")
    }

    pub fn submission_by_hmac(connection: &Connection, token_hmac: &str) -> Result<Submission> {
        let record = connection
            .query_row(
                "SELECT id, external_id, revoked_at, status, repo_name, pr_number, submission_branch, branch_head_sha, revision, package_sha256, updated_at FROM submissions WHERE author_token_hmac = ?1",
                [token_hmac],
                row_submission,
            )
            .optional()?
            .context("Invalid or revoked author token")?;
        if record.revoked_at.is_some() {
            anyhow::bail!("Invalid or revoked author token");
        }
        Ok(record)
    }

    pub fn event(
        connection: &Connection,
        submission_id: Option<&str>,
        event_type: &str,
        actor: &str,
        github_object_id: Option<&str>,
        payload_sha256: Option<&str>,
    ) -> Result<()> {
        connection.execute(
            "INSERT INTO events (id, submission_id, event_type, actor_type, github_object_id, payload_sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![uuid::Uuid::new_v4().to_string(), submission_id, event_type, actor, github_object_id, payload_sha256, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }
}

fn row_submission(row: &rusqlite::Row<'_>) -> rusqlite::Result<Submission> {
    Ok(Submission {
        id: row.get(0)?,
        external_id: row.get(1)?,
        revoked_at: row.get(2)?,
        status: row.get(3)?,
        repo_name: row.get(4)?,
        pr_number: row.get::<_, Option<i64>>(5)?.map(|value| value as u64),
        submission_branch: row.get(6)?,
        branch_head_sha: row.get(7)?,
        revision: row.get::<_, i64>(8)? as u32,
        package_sha256: row.get(9)?,
        updated_at: row.get(10)?,
    })
}
