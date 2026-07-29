# AIDaR operator setup

This document is for pilot administrators. Authors do not use these steps.

## Build

```bash
cargo test --locked
cargo build --locked --release
```

The build creates three executables:

- `target/release/aidar` for authors;
- `target/release/aidar-server` for the service;
- `target/release/aidar-admin` for administrators.

The executables do not require Rust at run time.

## Run the service

```bash
cp .env.example .env
target/release/aidar-server
```

Use `AIDAR_GITHUB_MODE=mock` for local tests. Use `AIDAR_GITHUB_MODE=live` only after you complete [GitHub App setup](GITHUB_SETUP.md).

The service creates the current SQLite schema when it starts. This pilot has no migration layer.

## Administrator commands

The administrator client reads `AIDAR_BASE_URL` and `AIDAR_ADMIN_TOKEN` from `.env` or the process environment.

```text
aidar-admin status SUBMISSION_ID
aidar-admin assign-reviewer SUBMISSION_ID --github-login LOGIN
aidar-admin sync-reviewer SUBMISSION_ID --github-login LOGIN
aidar-admin remove-reviewer SUBMISSION_ID --github-login LOGIN
aidar-admin decision SUBMISSION_ID --value accepted|rejected
aidar-admin publish SUBMISSION_ID PATH --public-slug SLUG
aidar-admin revoke-token SUBMISSION_ID
```

Do not give the administrator token to authors or reviewers.

## Releases

Published releases contain compiled author clients and SHA-256 checksums. Linux author releases use musl and do not require the host glibc version.
