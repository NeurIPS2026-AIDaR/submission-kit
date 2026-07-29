use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};
use base64::Engine;
use flate2::Compression;
use flate2::GzBuilder;
use hmac::{Hmac, Mac};
use regex::{Captures, Regex, RegexBuilder};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use walkdir::{DirEntry, WalkDir};

use crate::store::{RedactionProfile, load_or_create_profile};

type HmacSha256 = Hmac<Sha256>;

const MAX_FILE_BYTES: u64 = 52_428_800;
const MAX_TOTAL_BYTES: u64 = 524_288_000;
const MAX_FILES: usize = 10_000;
const MAX_PATH_LENGTH: usize = 240;

pub struct PackageResult {
    pub archive: Vec<u8>,
    pub digest: String,
    pub summary: String,
}

struct Pattern {
    kind: &'static str,
    regex: Regex,
}

fn privacy_patterns() -> Vec<Pattern> {
    vec![
        Pattern {
            kind: "email",
            regex: RegexBuilder::new(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
                .case_insensitive(true)
                .build()
                .unwrap(),
        },
        Pattern {
            kind: "orcid",
            regex: RegexBuilder::new(r"\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b")
                .case_insensitive(true)
                .build()
                .unwrap(),
        },
        Pattern {
            kind: "home-path",
            regex: RegexBuilder::new(r"(?:/Users/|/home/|[A-Z]:\\Users\\)[^\s/\\]+")
                .case_insensitive(true)
                .build()
                .unwrap(),
        },
        Pattern {
            kind: "coauthor",
            regex: RegexBuilder::new(r"(?m)^.*Co-authored-by\s*:.*$")
                .case_insensitive(true)
                .build()
                .unwrap(),
        },
        Pattern {
            kind: "repository-owner",
            regex: RegexBuilder::new(r"(?:github\.com|gitlab\.com|bitbucket\.org)/[\w.-]+")
                .case_insensitive(true)
                .build()
                .unwrap(),
        },
    ]
}

fn secret_patterns() -> Vec<(&'static str, Regex)> {
    vec![
        (
            "private key",
            Regex::new(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----").unwrap(),
        ),
        (
            "AWS access key",
            Regex::new(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b").unwrap(),
        ),
        (
            "GitHub token",
            Regex::new(r"\bgh[pousr]_[A-Za-z0-9_]{30,}\b").unwrap(),
        ),
        (
            "API secret",
            Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}\b").unwrap(),
        ),
    ]
}

fn keep_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some(".git" | ".aidar-private-identities.txt")
    )
}

fn relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(root)?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(
                value
                    .to_str()
                    .context("Submission paths must use Unicode")?,
            ),
            _ => bail!("Submission path is unsafe"),
        }
    }
    Ok(parts.join("/"))
}

fn collect_files(root: &Path) -> Result<Vec<(String, PathBuf)>> {
    let mut files = Vec::new();
    let mut total = 0_u64;
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(keep_entry)
    {
        let entry = entry?;
        if entry.depth() == 0 || entry.file_type().is_dir() {
            continue;
        }
        let relative = relative_path(root, entry.path())?;
        if relative.len() > MAX_PATH_LENGTH || relative.chars().any(char::is_control) {
            bail!("Submission path is invalid or too long: {relative}");
        }
        if relative == ".gitmodules"
            || relative
                .split('/')
                .any(|part| matches!(part, ".git" | ".hg" | ".svn"))
        {
            bail!("Version-control metadata is not submitted: {relative}");
        }
        if relative == ".github/workflows" || relative.starts_with(".github/workflows/") {
            bail!("GitHub workflow files are not submitted: {relative}");
        }
        if entry.file_type().is_symlink() || !entry.file_type().is_file() {
            bail!("Only regular files are submitted: {relative}");
        }
        let metadata = entry.metadata()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() > 1 {
                bail!("Hard-linked files are not submitted: {relative}");
            }
        }
        if metadata.len() > MAX_FILE_BYTES {
            bail!("File is larger than the submission limit: {relative}");
        }
        total = total.saturating_add(metadata.len());
        if total > MAX_TOTAL_BYTES {
            bail!("Submission is larger than the unpacked-size limit");
        }
        files.push((relative, entry.path().to_path_buf()));
        if files.len() > MAX_FILES {
            bail!("Submission has too many files");
        }
    }
    if files.is_empty() {
        bail!("Submission has no files");
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn replacement(profile: &RedactionProfile, kind: &str, original: &str) -> Result<String> {
    let key = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&profile.key)?;
    let mut hmac = HmacSha256::new_from_slice(&key)
        .map_err(|_| anyhow::anyhow!("Invalid local redaction key"))?;
    hmac.update(kind.as_bytes());
    hmac.update(&[0]);
    hmac.update(original.to_lowercase().as_bytes());
    let digest = hex::encode(hmac.finalize().into_bytes());
    Ok(format!("aidar-{kind}-{}", &digest[..12]))
}

fn replace_regex(
    input: &str,
    regex: &Regex,
    kind: &str,
    profile: &RedactionProfile,
    originals: &mut BTreeSet<String>,
    counts: &mut BTreeMap<String, usize>,
) -> Result<String> {
    let mut failure = None;
    let output = regex.replace_all(input, |captures: &Captures| {
        let original = captures.get(0).unwrap().as_str();
        originals.insert(original.to_string());
        *counts.entry(kind.to_string()).or_default() += 1;
        match replacement(profile, kind, original) {
            Ok(value) => value,
            Err(error) => {
                failure = Some(error);
                original.to_string()
            }
        }
    });
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(output.into_owned())
}

fn redact(
    input: &str,
    profile: &RedactionProfile,
    originals: &mut BTreeSet<String>,
    counts: &mut BTreeMap<String, usize>,
) -> Result<String> {
    let mut output = input.to_string();
    for pattern in privacy_patterns() {
        output = replace_regex(
            &output,
            &pattern.regex,
            pattern.kind,
            profile,
            originals,
            counts,
        )?;
    }
    let mut terms = profile.identity_terms.clone();
    terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
    for term in terms {
        let regex = RegexBuilder::new(&regex::escape(&term))
            .case_insensitive(true)
            .build()?;
        output = replace_regex(&output, &regex, "identity", profile, originals, counts)?;
    }
    Ok(output)
}

fn text(data: &[u8]) -> Option<&str> {
    if data.contains(&0) {
        return None;
    }
    std::str::from_utf8(data).ok()
}

fn scan_secrets(value: &str, path: &str) -> Result<()> {
    for (kind, regex) in secret_patterns() {
        if regex.is_match(value) {
            bail!("A {kind} pattern was found in {path}");
        }
    }
    Ok(())
}

fn verify_no_original(value: &str, originals: &BTreeSet<String>) -> Result<()> {
    let folded = value.to_lowercase();
    if originals
        .iter()
        .any(|original| folded.contains(&original.to_lowercase()))
    {
        bail!("Redaction verification failed");
    }
    Ok(())
}

fn run_gitleaks(stage: &Path) -> Result<bool> {
    match Command::new("gitleaks")
        .args(["detect", "--source"])
        .arg(stage)
        .args(["--no-git", "--no-banner", "--exit-code", "7"])
        .output()
    {
        Ok(output) if output.status.success() => Ok(true),
        Ok(output) if output.status.code() == Some(7) => {
            bail!("gitleaks found a secret; submission stopped")
        }
        Ok(_) => bail!("gitleaks could not complete"),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn archive(stage: &Path, files: &[String]) -> Result<Vec<u8>> {
    let mut tar_bytes = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_bytes);
        for relative in files {
            let data = fs::read(stage.join(relative))?;
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_cksum();
            builder.append_data(&mut header, relative, data.as_slice())?;
        }
        builder.finish()?;
    }
    let mut gzip = GzBuilder::new()
        .mtime(0)
        .write(Vec::new(), Compression::default());
    gzip.write_all(&tar_bytes)?;
    Ok(gzip.finish()?)
}

pub fn package_project(input: &Path) -> Result<PackageResult> {
    let root = input
        .canonicalize()
        .with_context(|| format!("Project does not exist: {}", input.display()))?;
    if !root.is_dir() {
        bail!("Project path must be a directory");
    }
    let profile = load_or_create_profile(&root)?;
    let source_files = collect_files(&root)?;
    let stage = TempDir::new()?;
    let mut output_files = Vec::new();
    let mut output_keys = BTreeSet::new();
    let mut originals = BTreeSet::new();
    let mut counts = BTreeMap::new();
    let mut files_changed = 0_usize;
    let mut paths_changed = 0_usize;
    let mut binary_files = 0_usize;

    for (relative, source) in source_files {
        let output_relative = redact(&relative, &profile, &mut originals, &mut counts)?;
        if output_relative != relative {
            paths_changed += 1;
        }
        let collision = output_relative.to_lowercase();
        if !output_keys.insert(collision) {
            bail!("Redaction caused two paths to collide");
        }
        let data = fs::read(&source)?;
        let output = if let Some(value) = text(&data) {
            scan_secrets(value, &output_relative)?;
            let redacted = redact(value, &profile, &mut originals, &mut counts)?;
            if redacted != value {
                files_changed += 1;
            }
            redacted.into_bytes()
        } else {
            binary_files += 1;
            data
        };
        let target = stage.path().join(&output_relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, output)?;
        output_files.push(output_relative);
    }

    for relative in &output_files {
        verify_no_original(relative, &originals)?;
        let data = fs::read(stage.path().join(relative))?;
        if let Some(value) = text(&data) {
            verify_no_original(value, &originals)?;
            scan_secrets(value, relative)?;
        }
    }

    let gitleaks = run_gitleaks(stage.path())?;
    output_files.sort();
    let archive = archive(stage.path(), &output_files)?;
    let digest = hex::encode(Sha256::digest(&archive));
    let replacements: usize = counts.values().sum();
    let kinds = if counts.is_empty() {
        "none".to_string()
    } else {
        counts
            .iter()
            .map(|(kind, count)| format!("{kind}={count}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let summary = [
        format!("PASS  {} files are ready", output_files.len()),
        format!("PASS  {replacements} private matches replaced ({kinds})"),
        format!("PASS  {files_changed} text files and {paths_changed} paths changed only in the temporary copy"),
        if binary_files == 0 { "PASS  no uninspected binary files".to_string() } else { format!("WARN  {binary_files} binary files were kept unchanged; inspect them before submission") },
        if gitleaks { "PASS  gitleaks found no secrets".to_string() } else { "PASS  built-in secret checks found no secrets".to_string() },
    ].join("\n");
    Ok(PackageResult {
        archive,
        digest,
        summary,
    })
}

pub fn validate_response(project: &Path, value: &str) -> Result<()> {
    let profile = load_or_create_profile(project)?;
    scan_secrets(value, "author response")?;
    if privacy_patterns()
        .iter()
        .any(|pattern| pattern.regex.is_match(value))
    {
        bail!("Author response contains a supported private-identity pattern");
    }
    if profile
        .identity_terms
        .iter()
        .any(|term| value.to_lowercase().contains(&term.to_lowercase()))
    {
        bail!("Author response contains a configured private identity term");
    }
    Ok(())
}
