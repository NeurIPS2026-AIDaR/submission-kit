use std::time::Duration;

use anyhow::{Result, bail};
use async_trait::async_trait;
use reqwest::{Client, StatusCode};
use serde_json::Value;

use super::config::OpenReviewConfig;

const MAX_RESPONSE_BYTES: usize = 1_048_576;

#[async_trait]
pub trait OpenReviewGateway: Send + Sync {
    fn mode(&self) -> &'static str;
    async fn verify_submission(&self, forum_id: &str) -> Result<()>;
}

pub struct LiveOpenReviewGateway {
    client: Client,
    config: OpenReviewConfig,
}

impl LiveOpenReviewGateway {
    pub fn new(config: OpenReviewConfig) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .user_agent("aidar/0.1")
                .build()?,
            config,
        })
    }
}

#[async_trait]
impl OpenReviewGateway for LiveOpenReviewGateway {
    fn mode(&self) -> &'static str {
        "live"
    }

    async fn verify_submission(&self, forum_id: &str) -> Result<()> {
        let response = self
            .client
            .get(format!("{}/notes", self.config.api_base))
            .query(&[("id", forum_id)])
            .bearer_auth(&self.config.access_token)
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("OpenReview verification is unavailable"))?;
        if matches!(
            response.status(),
            StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
        ) {
            bail!("This link is not an active AIDaR workshop submission");
        }
        if response.status() != StatusCode::OK {
            bail!("OpenReview verification is unavailable");
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| anyhow::anyhow!("OpenReview verification is unavailable"))?;
        if body.len() > MAX_RESPONSE_BYTES {
            bail!("OpenReview verification is unavailable");
        }
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| anyhow::anyhow!("OpenReview verification is unavailable"))?;
        if !is_verified_submission(
            &value,
            forum_id,
            &self.config.submission_invitation,
            &self.config.active_venue_id,
        ) {
            bail!("This link is not an active AIDaR workshop submission");
        }
        Ok(())
    }
}

pub struct MockOpenReviewGateway;

#[async_trait]
impl OpenReviewGateway for MockOpenReviewGateway {
    fn mode(&self) -> &'static str {
        "mock"
    }

    async fn verify_submission(&self, _forum_id: &str) -> Result<()> {
        Ok(())
    }
}

fn content_value<'a>(content: &'a Value, key: &str) -> Option<&'a str> {
    let value = content.get(key)?;
    value
        .as_str()
        .or_else(|| value.get("value").and_then(Value::as_str))
}

fn is_verified_submission(
    response: &Value,
    forum_id: &str,
    submission_invitation: &str,
    active_venue_id: &str,
) -> bool {
    let Some(notes) = response.get("notes").and_then(Value::as_array) else {
        return false;
    };
    if notes.len() != 1 {
        return false;
    }
    let note = &notes[0];
    if note.get("id").and_then(Value::as_str) != Some(forum_id)
        || note.get("ddate").is_some_and(|value| !value.is_null())
    {
        return false;
    }
    let has_invitation = note
        .get("invitations")
        .and_then(Value::as_array)
        .is_some_and(|values| {
            values
                .iter()
                .any(|value| value.as_str() == Some(submission_invitation))
        });
    let active_venue = note
        .get("content")
        .and_then(|content| content_value(content, "venueid"))
        == Some(active_venue_id);
    has_invitation && active_venue
}

#[cfg(test)]
mod tests {
    use super::is_verified_submission;
    use serde_json::json;

    const FORUM: &str = "Abc_123-xyz";
    const INVITATION: &str = "NeurIPS.cc/2026/Workshop/AIDaR/-/Submission";
    const VENUE: &str = "NeurIPS.cc/2026/Workshop/AIDaR/Submission";

    fn response() -> serde_json::Value {
        json!({
            "count": 1,
            "notes": [{
                "id": FORUM,
                "invitations": [INVITATION],
                "content": { "venueid": { "value": VENUE } }
            }]
        })
    }

    #[test]
    fn accepts_exact_active_workshop_submission() {
        assert!(is_verified_submission(
            &response(),
            FORUM,
            INVITATION,
            VENUE
        ));
    }

    #[test]
    fn rejects_wrong_id_invitation_venue_or_deleted_note() {
        assert!(!is_verified_submission(
            &response(),
            "Other_123",
            INVITATION,
            VENUE
        ));
        assert!(!is_verified_submission(&response(), FORUM, "wrong", VENUE));
        assert!(!is_verified_submission(
            &response(),
            FORUM,
            INVITATION,
            "wrong"
        ));
        let mut deleted = response();
        deleted["notes"][0]["ddate"] = json!(1_234_567);
        assert!(!is_verified_submission(&deleted, FORUM, INVITATION, VENUE));
    }

    #[test]
    fn rejects_empty_or_ambiguous_responses() {
        assert!(!is_verified_submission(
            &json!({ "notes": [] }),
            FORUM,
            INVITATION,
            VENUE
        ));
        let note = response()["notes"][0].clone();
        assert!(!is_verified_submission(
            &json!({ "notes": [note.clone(), note] }),
            FORUM,
            INVITATION,
            VENUE
        ));
    }
}
