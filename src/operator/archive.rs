use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Read};
use std::path::{Component, Path};

use anyhow::{Context, Result, bail};
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};

use super::config::Limits;
use crate::package::validate_server_text;

pub type Snapshot = BTreeMap<String, Vec<u8>>;

pub fn sha256(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn extract_snapshot(archive: &[u8], claimed_digest: &str, limits: &Limits) -> Result<Snapshot> {
    if archive.len() > limits.max_upload_bytes {
        bail!("Compressed upload exceeds the configured limit");
    }
    let digest = sha256(archive);
    if digest != claimed_digest.to_ascii_lowercase() {
        bail!("Package digest does not match the received archive");
    }
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut tar = tar::Archive::new(decoder);
    let mut output = BTreeMap::new();
    let mut collision_keys = BTreeSet::new();
    let mut total = 0_usize;
    for entry in tar.entries().context("Package archive is invalid")? {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file() {
            bail!("Package contains a non-regular entry");
        }
        let path = entry.path()?;
        let relative = safe_path(&path, limits)?;
        if prohibited(&relative) {
            bail!("Package contains a prohibited path: {relative}");
        }
        let collision = relative.to_lowercase();
        if !collision_keys.insert(collision) {
            bail!("Package contains duplicate or colliding paths");
        }
        if output.len() >= limits.max_file_count {
            bail!("Package contains too many files");
        }
        let declared = entry.header().size()? as usize;
        if declared > limits.max_file_bytes {
            bail!("Package contains an oversized file: {relative}");
        }
        let mut data = Vec::with_capacity(declared.min(1_048_576));
        entry
            .by_ref()
            .take((limits.max_file_bytes + 1) as u64)
            .read_to_end(&mut data)?;
        if data.len() != declared || data.len() > limits.max_file_bytes {
            bail!("Package entry size is invalid: {relative}");
        }
        total = total.saturating_add(data.len());
        if total > limits.max_unpacked_bytes {
            bail!("Package expands beyond the configured limit");
        }
        validate_path_and_content(&relative, &data)?;
        output.insert(relative, data);
    }
    if output.is_empty() {
        bail!("Submission has no files");
    }
    Ok(output)
}

fn safe_path(path: &Path, limits: &Limits) -> Result<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                parts.push(value.to_str().context("Package paths must use Unicode")?)
            }
            _ => bail!("Package contains an unsafe path"),
        }
    }
    let relative = parts.join("/");
    if relative.is_empty()
        || relative.len() > limits.max_path_length
        || relative.chars().any(char::is_control)
    {
        bail!("Package contains an unsafe path");
    }
    Ok(relative)
}

fn prohibited(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    parts
        .iter()
        .any(|part| matches!(*part, ".git" | ".hg" | ".svn"))
        || path == ".gitmodules"
        || path == ".aidar-private-identities.txt"
        || path == ".github/workflows"
        || path.starts_with(".github/workflows/")
}

fn validate_path_and_content(path: &str, data: &[u8]) -> Result<()> {
    validate_server_text(path, "submission path")?;
    if !data.contains(&0)
        && let Ok(value) = std::str::from_utf8(data)
    {
        validate_server_text(value, path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::GzEncoder;

    use super::*;

    fn limits() -> Limits {
        Limits {
            max_upload_bytes: 1_000_000,
            max_unpacked_bytes: 1_000_000,
            max_file_bytes: 100_000,
            max_file_count: 10,
            max_path_length: 240,
            max_response_bytes: 10_000,
        }
    }

    fn make_archive(path: &str, data: &[u8]) -> Vec<u8> {
        let mut tar_data = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_data);
            let mut header = tar::Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append(&header, data).unwrap();
            builder.finish().unwrap();
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&tar_data).unwrap();
        gzip.finish().unwrap()
    }

    #[test]
    fn extracts_an_arbitrary_binary() {
        let archive = make_archive("results/artifact.zip", &[0x50, 0x4b, 0, 1]);
        let snapshot = extract_snapshot(&archive, &sha256(&archive), &limits()).unwrap();
        assert_eq!(snapshot.len(), 1);
    }

    #[test]
    fn rejects_private_text() {
        let archive = make_archive("notes.txt", b"contact person@example.org");
        assert!(extract_snapshot(&archive, &sha256(&archive), &limits()).is_err());
    }
}
