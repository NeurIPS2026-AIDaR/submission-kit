# AIDaR operator setup

This document is for pilot administrators. Authors do not use these steps.

## Server

The pilot server requires Node.js 22.13 or later.

```bash
npm install
cp .env.example .env
npm run dev
```

Use `AIDAR_GITHUB_MODE=mock` for local tests. Use `AIDAR_GITHUB_MODE=live` only after you complete [GitHub App setup](GITHUB_SETUP.md).

Run the test suite:

```bash
npm test
npm run test:pilot
```

## Administrator client

The administrator client uses the server admin credential. Do not give this credential to authors or reviewers.

```text
npm run aidar-admin -- status SUBMISSION_ID
npm run aidar-admin -- assign-reviewer SUBMISSION_ID --github-login LOGIN
npm run aidar-admin -- sync-reviewer SUBMISSION_ID --github-login LOGIN
npm run aidar-admin -- remove-reviewer SUBMISSION_ID --github-login LOGIN
npm run aidar-admin -- decision SUBMISSION_ID --value accepted|rejected
npm run aidar-admin -- publish SUBMISSION_ID PATH --public-slug SLUG
npm run aidar-admin -- revoke-token SUBMISSION_ID
```

## Author client build

The standalone client source is in `client/`.

```bash
cargo test --manifest-path client/Cargo.toml
cargo build --release --manifest-path client/Cargo.toml
```

Published releases contain a compiled client and SHA-256 checksums for each supported operating system and architecture. Linux releases use musl and do not require the host glibc version.
