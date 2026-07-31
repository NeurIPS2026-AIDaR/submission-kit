use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::blocking::multipart::{Form, Part};
use reqwest::blocking::{Client, Response};
use serde_json::{Value, json};

pub struct Api {
    client: Client,
    server: String,
}

impl Api {
    pub fn new(server: &str) -> Result<Self> {
        let server = server.trim_end_matches('/').to_string();
        let url = url::Url::parse(&server).context("AIDaR server URL is invalid")?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("AIDaR server URL must use HTTP or HTTPS");
        }
        if !url.username().is_empty() || url.password().is_some() {
            bail!("AIDaR server URL must not contain credentials");
        }
        if url.scheme() == "http"
            && !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
        {
            bail!("A remote AIDaR server must use HTTPS");
        }
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(1_800))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            server,
        })
    }

    fn json(response: Response) -> Result<Value> {
        let status = response.status();
        let value: Value = response
            .json()
            .context("AIDaR server returned an invalid response")?;
        if !status.is_success() {
            bail!(
                "{}",
                value
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("AIDaR request failed")
            );
        }
        Ok(value)
    }

    pub fn register(&self, openreview_url: &str, invitation_code: &str) -> Result<Value> {
        Self::json(
            self.client
                .post(format!("{}/v1/author/submissions", self.server))
                .json(&json!({
                    "openreview_url": openreview_url,
                    "invitation_code": invitation_code
                }))
                .send()?,
        )
    }

    pub fn upload(
        &self,
        endpoint: &str,
        token: &str,
        archive: Vec<u8>,
        digest: &str,
    ) -> Result<Value> {
        let form = Form::new()
            .part(
                "archive",
                Part::bytes(archive)
                    .file_name("submission.tar.gz")
                    .mime_str("application/gzip")?,
            )
            .text("archive_sha256", digest.to_string());
        Self::json(
            self.client
                .post(format!("{}{}", self.server, endpoint))
                .bearer_auth(token)
                .header("Idempotency-Key", uuid::Uuid::new_v4().to_string())
                .multipart(form)
                .send()?,
        )
    }

    pub fn get(&self, endpoint: &str, token: &str) -> Result<Value> {
        Self::json(
            self.client
                .get(format!("{}{}", self.server, endpoint))
                .bearer_auth(token)
                .send()?,
        )
    }

    pub fn respond(&self, token: &str, body: &str, reply_to: Option<u64>) -> Result<Value> {
        Self::json(
            self.client
                .post(format!("{}/v1/author/responses", self.server))
                .bearer_auth(token)
                .json(&json!({ "body": body, "reply_to_review_comment_id": reply_to }))
                .send()?,
        )
    }
}
