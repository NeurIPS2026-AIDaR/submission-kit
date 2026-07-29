use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use base64::Engine;
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Clone, Serialize, Deserialize)]
pub struct RedactionProfile {
    pub key: String,
    pub identity_terms: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredProfile {
    project_path: String,
    key: String,
    identity_terms: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct PrivacyFile {
    version: u8,
    projects: Vec<StoredProfile>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AuthorCredential {
    pub submission_id: String,
    pub server: String,
    pub project_path: String,
    pub author_token: String,
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
struct CredentialFile {
    version: u8,
    submissions: Vec<AuthorCredential>,
}

fn config_dir() -> Result<PathBuf> {
    if let Some(path) = env::var_os("AIDAR_CREDENTIALS_DIR") {
        return Ok(PathBuf::from(path));
    }
    if let Some(path) = env::var_os("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path).join("aidar"));
    }
    Ok(dirs::home_dir()
        .context("The home directory is not available")?
        .join(".config/aidar"))
}

fn secure_directory() -> Result<PathBuf> {
    let root = config_dir()?;
    fs::create_dir_all(&root).with_context(|| format!("Cannot create {}", root.display()))?;
    #[cfg(unix)]
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    Ok(root)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, fallback: T) -> Result<T> {
    if !path.exists() {
        return Ok(fallback);
    }
    serde_json::from_slice(&fs::read(path)?)
        .with_context(|| format!("Invalid local file: {}", path.display()))
}

fn write_private_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary)?;
    serde_json::to_writer_pretty(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn normalize_terms(terms: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut output: Vec<String> = terms
        .into_iter()
        .map(|term| term.trim().to_string())
        .filter(|term| term.chars().count() >= 2 && !term.chars().any(char::is_control))
        .collect();
    output.sort_by_key(|term| term.to_lowercase());
    output.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    output
}

fn local_terms(project: &Path) -> Result<Vec<String>> {
    let mut terms = Vec::new();
    let path = project.join(".aidar-private-identities.txt");
    if path.exists() {
        for line in fs::read_to_string(path)?.lines() {
            let value = line.trim();
            if !value.is_empty() && !value.starts_with('#') {
                terms.push(value.to_string());
            }
        }
    }
    if let Some(home) = dirs::home_dir().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }) {
        terms.push(home);
    }
    Ok(normalize_terms(terms))
}

pub fn load_or_create_profile(project: &Path) -> Result<RedactionProfile> {
    let project = project.canonicalize()?;
    let root = secure_directory()?;
    if root == project || root.starts_with(&project) {
        bail!("AIDaR private state must be outside the submitted project");
    }
    let path = root.join("redactions.json");
    let mut data: PrivacyFile = read_json(
        &path,
        PrivacyFile {
            version: 1,
            projects: Vec::new(),
        },
    )?;
    if data.version != 1 {
        bail!("The local AIDaR redaction file has an unsupported version");
    }
    let project_path = project.to_string_lossy().into_owned();
    let detected = local_terms(&project)?;
    let index = if let Some(index) = data
        .projects
        .iter()
        .position(|item| item.project_path == project_path)
    {
        index
    } else {
        let mut key = [0_u8; 32];
        rand::rng().fill(&mut key);
        data.projects.push(StoredProfile {
            project_path: project_path.clone(),
            key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key),
            identity_terms: Vec::new(),
        });
        data.projects.len() - 1
    };
    let profile = &mut data.projects[index];
    profile.identity_terms =
        normalize_terms(profile.identity_terms.clone().into_iter().chain(detected));
    let result = RedactionProfile {
        key: profile.key.clone(),
        identity_terms: profile.identity_terms.clone(),
    };
    write_private_json(&path, &data)?;
    Ok(result)
}

pub fn save_credential(
    submission_id: &str,
    server: &str,
    project: &Path,
    author_token: &str,
) -> Result<()> {
    let root = secure_directory()?;
    let path = root.join("credentials.json");
    let project_path = project.canonicalize()?.to_string_lossy().into_owned();
    let mut data: CredentialFile = read_json(
        &path,
        CredentialFile {
            version: 1,
            submissions: Vec::new(),
        },
    )?;
    if data.version != 1 {
        bail!("The local AIDaR credential file has an unsupported version");
    }
    data.submissions
        .retain(|item| !(item.server == server && item.submission_id == submission_id));
    data.submissions.push(AuthorCredential {
        submission_id: submission_id.to_string(),
        server: server.to_string(),
        project_path,
        author_token: author_token.to_string(),
        created_at: Utc::now().to_rfc3339(),
    });
    write_private_json(&path, &data)
}

pub fn load_credential(
    server: &str,
    project: &Path,
    submission_id: Option<&str>,
) -> Result<AuthorCredential> {
    let path = secure_directory()?.join("credentials.json");
    let data: CredentialFile = read_json(
        &path,
        CredentialFile {
            version: 1,
            submissions: Vec::new(),
        },
    )?;
    let project_path = project.canonicalize()?.to_string_lossy().into_owned();
    data.submissions
        .into_iter()
        .filter(|item| item.server == server)
        .filter(|item| {
            submission_id.map_or(item.project_path == project_path, |id| {
                item.submission_id == id
            })
        })
        .max_by(|a, b| a.created_at.cmp(&b.created_at))
        .context("No saved AIDaR submission exists for this project")
}
