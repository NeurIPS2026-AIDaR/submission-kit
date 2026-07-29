# AIDaR GitHub-native submission pilot

This repository contains a runnable local pilot for anonymous, GitHub-native workshop review. It runs next to OpenReview. It does not replace OpenReview in this MVP.

The author runs the `aidar` client on a local project. The client creates a submission and saves its credential automatically. The author does not need chair action, a GitHub account, or a GitHub token. An AIDaR GitHub App creates a private repository and a pull request. A named reviewer uses a normal GitHub account. The App relays author responses and revisions under its bot identity.

The local mock mode implements the full loop without a GitHub organization or credentials. Use it to test the workflow and its limits before you configure the live App.

## Pilot status

This software is experimental. Use only synthetic submissions in the current pilot. The live test does not yet prove isolation between two outside reviewers.

## Author quick start

Install the deterministic CLI from this repository:

```bash
npm install --global https://github.com/NeurIPS2026-AIDaR/submission-kit/archive/refs/heads/main.tar.gz
```

Check any local project. The project does not need a prescribed layout:

```bash
aidar check PATH
```

The command states its built-in redaction patterns. It also shows locally detected private terms and asks one optional question for more terms. The terms and stable replacement map stay on the author computer.

Submit to the URL that the pilot operator provides:

```bash
aidar submit PATH --server AIDAR_SERVER_URL
```

The command creates a new submission. It saves the author credential outside the project. It does not need a GitHub account or a GitHub token.

To update the same submission, continue work in the source project and run:

```bash
aidar revise PATH --server AIDAR_SERVER_URL
```

The revision is a full replacement snapshot. The App pushes the new snapshot to the private pull request. The author does not run `git push` to the review repository.

## Install the Codex skill

Ask Codex to install the skill from this public path:

```text
Install the submit-to-aidar skill from
https://github.com/NeurIPS2026-AIDaR/submission-kit/tree/main/skills/submit-to-aidar
```

Then make a direct request:

```text
Use $submit-to-aidar to check and submit the project at PATH to AIDAR_SERVER_URL.
```

The skill uses the deterministic CLI for privacy-critical work. It does not implement redaction in the prompt.

## Reviewer quick start

An assigned reviewer receives access to one private repository. The reviewer opens its submission pull request and uses normal GitHub reviews, inline comments, or pull-request comments. The author reads these items through the AIDaR client. Author responses appear under the App bot identity.

See [the synthetic source project](examples/synthetic-submission) for one possible submission. Its structure is an example, not a requirement.

## What this pilot tests

- One private repository for each submission.
- A clean snapshot with no local Git history or commit metadata.
- Local and server-side checks for unsafe paths, operational limits, identity leaks, secrets, and PDF author metadata/text.
- A deterministic, temporary redacted snapshot with stable aliases across revisions; source files are never modified.
- Named reviewer access that is limited to assigned repositories.
- Review retrieval by an author who has no GitHub access.
- Bot-relayed author responses.
- Complete replacement revisions, including file deletion.
- An accepted-paper publication pull request.

The service never runs submitted code. It disables GitHub Actions in every live review repository.

## Requirements

- Node.js 22.13 or later.
- `pdfinfo` for PDF metadata checks. On macOS, install `poppler` with Homebrew.
- Docker and Docker Compose are optional.
- `gitleaks` is optional. The client and server use it when it is on `PATH`.

## Run the automated local pilot

```bash
npm install
npm test
npm run test:pilot
```

The pilot uses an in-memory database and the mock GitHub adapter. It creates two isolated submissions. It runs the submit, assign, review, response, and revision loop. It also checks that a deleted file does not remain in the revised snapshot.

## Run the API and CLIs in mock mode

Create a local `.env` file:

```bash
cp .env.example .env
```

Set these values in `.env`:

```dotenv
AIDAR_TOKEN_HMAC_SECRET=<at-least-32-random-bytes>
AIDAR_ADMIN_TOKEN=<a-high-entropy-local-admin-token>
AIDAR_GITHUB_MODE=mock
```

Start the API:

```bash
npm run dev
```

Use a second terminal:

```bash
npm run aidar -- check test/fixtures/valid-submission
npm run aidar -- submit test/fixtures/valid-submission --server http://localhost:3000

export AIDAR_ADMIN_TOKEN='<local-admin-token>'
npm run aidar-admin -- assign-reviewer <submission-id> --github-login known-reviewer
npm run aidar-admin -- mock-review <submission-id> \
  --github-login known-reviewer \
  --file test/fixtures/author-response.md \
  --type review

npm run aidar -- reviews --server http://localhost:3000 \
  --project test/fixtures/valid-submission
npm run aidar -- respond --server http://localhost:3000 \
  --project test/fixtures/valid-submission \
  --file test/fixtures/author-response.md
npm run aidar -- revise test/fixtures/valid-submission \
  --server http://localhost:3000
```

The client saves author credentials in `~/.config/aidar/credentials.json` with owner-only permissions. It does not put credentials in the project. The environment and `--token-stdin` options remain available for controlled tests. Do not pass an author or admin token as a normal command-line argument.

## Use Docker

Create `.env` as shown above. Then run:

```bash
docker compose up --build
```

The API stores SQLite data in the `aidar-data` volume.

## Configure live GitHub mode

Complete the organization and GitHub App setup in [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md). Then set the GitHub values in `.env` and run the service with `AIDAR_GITHUB_MODE=live`.

For Docker, also set `GITHUB_APP_PRIVATE_KEY_HOST_PATH`. Then run:

```bash
docker compose -f docker-compose.yml -f docker-compose.live.yml up --build
```

The author client still uses only the AIDaR submission token. Do not give a GitHub credential to the author client.

An operator can register a private organization-owned App with the local manifest helper:

```bash
npm run github-app:register -- --org ORGANIZATION
```

The helper stores the generated private key outside this repository with owner-only access. After the App is installed, create an ignored owner-only `.env` file:

```bash
npm run live:configure -- \
  --app-id APP_ID \
  --installation-id INSTALLATION_ID \
  --org ORGANIZATION \
  --private-key ABSOLUTE_PRIVATE_KEY_PATH
```

## Commands

Author commands:

```text
aidar init PATH
aidar check PATH
aidar submit PATH --server URL
aidar status --server URL
aidar reviews --server URL
aidar respond --server URL --file response.md
aidar revise PATH --server URL
```

Administrator commands:

```text
aidar-admin create-submission --external-id ID
aidar-admin status SUBMISSION_ID
aidar-admin assign-reviewer SUBMISSION_ID --github-login LOGIN
aidar-admin sync-reviewer SUBMISSION_ID --github-login LOGIN
aidar-admin remove-reviewer SUBMISSION_ID --github-login LOGIN
aidar-admin decision SUBMISSION_ID --value accepted|rejected
aidar-admin publish SUBMISSION_ID PATH --public-slug SLUG
aidar-admin revoke-token SUBMISSION_ID
```

`aidar-admin create-submission` is an optional preregistration path for an OpenReview mapping. Normal author submission does not use it. `aidar-admin mock-review` exists only for the local mock pilot.

## Submission contents and local redaction

A submission can contain any regular files and directories within the configured size, count, and path limits. There is no required manifest, README, manuscript, PDF, or directory structure. `aidar init PATH` creates an optional example layout only.

Before `check`, `submit`, or `revise`, an interactive client shows one focused privacy prompt with locally detected default identity terms and accepts optional additional terms. The local `.aidar-private-identities.txt` file can also contain one private identity term per line. The client excludes this file from every snapshot.

The client redacts supported text content and paths in a temporary directory, verifies that every matched original is absent, and packages only that directory. It never modifies the source. A project-specific owner-only profile in `~/.config/aidar/redactions.json` keeps aliases stable across revisions. The local report contains replacement counts but never original terms. Unsupported binary files produce explicit warnings and are not claimed clean.

## Documents

- [Pilot protocol and concern matrix](docs/PILOT_PROTOCOL.md)
- [Local pilot report](docs/LOCAL_PILOT_REPORT.md)
- [GitHub organization and App setup](docs/GITHUB_SETUP.md)
- [Threat model](docs/THREAT_MODEL.md)
- [MVP limitations](docs/MVP_LIMITATIONS.md)

## Security statement

This design provides reviewer-facing author anonymity. It does not provide cryptographic anonymity. Workshop chairs, the service operator, and GitHub are inside the trust boundary. Authors must inspect warnings and every format the client cannot fully inspect. Visible names in figures, writing style, public code, and distinctive data can still identify an author.
