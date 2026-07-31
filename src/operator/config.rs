use std::env;
use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, bail};

#[derive(Clone)]
pub struct Limits {
    pub max_upload_bytes: usize,
    pub max_unpacked_bytes: usize,
    pub max_file_bytes: usize,
    pub max_file_count: usize,
    pub max_path_length: usize,
    pub max_response_bytes: usize,
}

#[derive(Clone)]
pub struct PublicLimits {
    pub registrations_per_minute: usize,
    pub uploads_per_minute: usize,
    pub max_concurrent_uploads: usize,
}

#[derive(Clone)]
pub struct GithubConfig {
    pub app_id: String,
    pub private_key: String,
    pub installation_id: u64,
    pub org: String,
    pub api_version: String,
    pub public_archive_repo: String,
    pub review_team_id: Option<u64>,
}

#[derive(Clone)]
pub struct Config {
    pub host: IpAddr,
    pub port: u16,
    pub database_path: PathBuf,
    pub token_hmac_secret: String,
    pub admin_token: Option<String>,
    pub admin_token_hash: Option<String>,
    pub github: Option<GithubConfig>,
    pub limits: Limits,
    pub public_limits: PublicLimits,
}

fn positive(name: &str, fallback: usize) -> Result<usize> {
    match env::var(name) {
        Ok(value) => value
            .parse::<usize>()
            .with_context(|| format!("{name} must be a positive integer"))
            .and_then(|value| {
                if value == 0 {
                    bail!("{name} must be a positive integer")
                }
                Ok(value)
            }),
        Err(_) => Ok(fallback),
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        let _ = dotenvy::dotenv();
        let live = env::var("AIDAR_GITHUB_MODE").unwrap_or_else(|_| "mock".to_string());
        if !matches!(live.as_str(), "mock" | "live") {
            bail!("AIDAR_GITHUB_MODE must be mock or live");
        }
        let token_hmac_secret = env::var("AIDAR_TOKEN_HMAC_SECRET")
            .unwrap_or_else(|_| "local-pilot-change-this-secret".to_string());
        let admin_token = env::var("AIDAR_ADMIN_TOKEN")
            .ok()
            .filter(|value| !value.is_empty());
        let admin_token_hash = env::var("AIDAR_ADMIN_TOKEN_HASH")
            .ok()
            .filter(|value| !value.is_empty());
        if let Some(value) = &admin_token_hash
            && (value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()))
        {
            bail!("AIDAR_ADMIN_TOKEN_HASH must be a SHA-256 digest");
        }
        if live == "live" && token_hmac_secret.len() < 32 {
            bail!("Live mode requires an AIDAR_TOKEN_HMAC_SECRET of at least 32 bytes");
        }
        if live == "live" && admin_token.is_none() && admin_token_hash.is_none() {
            bail!("Live mode requires AIDAR_ADMIN_TOKEN or AIDAR_ADMIN_TOKEN_HASH");
        }
        let github = if live == "live" {
            let private_key_path = env::var("GITHUB_APP_PRIVATE_KEY_PATH")
                .context("GITHUB_APP_PRIVATE_KEY_PATH is required in live mode")?;
            Some(GithubConfig {
                app_id: env::var("GITHUB_APP_ID")
                    .context("GITHUB_APP_ID is required in live mode")?,
                private_key: fs::read_to_string(&private_key_path)
                    .with_context(|| format!("Cannot read {private_key_path}"))?,
                installation_id: env::var("GITHUB_INSTALLATION_ID")
                    .context("GITHUB_INSTALLATION_ID is required in live mode")?
                    .parse()
                    .context("GITHUB_INSTALLATION_ID must be an integer")?,
                org: env::var("GITHUB_ORG").context("GITHUB_ORG is required in live mode")?,
                api_version: env::var("GITHUB_API_VERSION")
                    .unwrap_or_else(|_| "2026-03-10".to_string()),
                public_archive_repo: env::var("GITHUB_PUBLIC_ARCHIVE_REPO")
                    .unwrap_or_else(|_| "aidar-2026-submissions".to_string()),
                review_team_id: env::var("GITHUB_REVIEW_TEAM_ID")
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(|value| value.parse())
                    .transpose()
                    .context("GITHUB_REVIEW_TEAM_ID must be an integer")?,
            })
        } else {
            None
        };
        Ok(Self {
            host: env::var("AIDAR_HOST")
                .unwrap_or_else(|_| "127.0.0.1".to_string())
                .parse()
                .context("AIDAR_HOST must be an IP address")?,
            port: env::var("PORT")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()
                .context("PORT must be an integer")?,
            database_path: PathBuf::from(
                env::var("AIDAR_DATABASE_PATH")
                    .unwrap_or_else(|_| "./data/aidar.sqlite".to_string()),
            ),
            token_hmac_secret,
            admin_token,
            admin_token_hash,
            github,
            limits: Limits {
                max_upload_bytes: positive("MAX_UPLOAD_BYTES", 209_715_200)?,
                max_unpacked_bytes: positive("MAX_UNPACKED_BYTES", 524_288_000)?,
                max_file_bytes: positive("MAX_FILE_BYTES", 52_428_800)?,
                max_file_count: positive("MAX_FILE_COUNT", 10_000)?,
                max_path_length: positive("MAX_PATH_LENGTH", 240)?,
                max_response_bytes: positive("MAX_RESPONSE_BYTES", 65_536)?,
            },
            public_limits: PublicLimits {
                registrations_per_minute: positive("REGISTRATIONS_PER_MINUTE", 5)?,
                uploads_per_minute: positive("UPLOADS_PER_MINUTE", 2)?,
                max_concurrent_uploads: positive("MAX_CONCURRENT_UPLOADS", 2)?,
            },
        })
    }
}
