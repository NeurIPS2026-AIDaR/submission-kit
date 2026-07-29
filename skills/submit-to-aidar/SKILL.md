---
name: submit-to-aidar
description: Validate, redact, submit, revise, and inspect an AIDaR workshop research snapshot through the aidar CLI. Use when an author asks to submit local manuscript, code, data documentation, claims, results, or other artifacts to AIDaR; asks whether submission content is ready for anonymous review; asks to read AIDaR reviews; or asks to send a response or revision without a GitHub account.
---

# Submit to AIDaR

Use the deterministic `aidar` CLI for all privacy-critical work. Never implement packaging, identity scanning, redaction, or upload logic in the prompt.

## Prepare or check

1. Resolve the project path from the request. Ask for it only if it is missing.
2. Confirm that `aidar` is on `PATH`. In the AIDaR source repository, use `npm run aidar --` if the installed command is absent. Otherwise, tell the author that the deterministic client is required and offer `npm install --global https://github.com/NeurIPS2026-AIDaR/submission-kit/archive/refs/heads/main.tar.gz`. Do not install it unless the author approves the installation.
3. Run `aidar check PATH`. When the client has a terminal, it uses one focused privacy prompt. It shows locally detected default identity terms and accepts optional comma-separated terms. Do not add a general author questionnaire.
4. Show the complete validation and redaction summary. The summary contains counts, never the original private terms.
5. Stop if any `FAIL` result exists. Explain the file and rule. An unsupported binary warning means the client did not claim that file clean; make sure the author sees it.
6. Do not require `aidar.yaml`, `README.md`, a manuscript, a PDF, or a fixed directory structure. `aidar init PATH` is only an optional example layout.

## Submit

1. Require a successful check in the current run. The client creates a deterministic redacted temporary snapshot and never changes the source project.
2. Get the AIDaR server URL from the request or `AIDAR_BASE_URL`.
3. Run `aidar submit PATH --server URL` only when the request authorizes submission. This command creates a new self-service submission. It does not require chair action or an existing token.
4. Let the CLI save the new author credential in its protected user configuration. Do not copy the credential into the project.
5. Return the opaque submission ID, revision, digest, and status. Do not display the author credential.

Each normal `aidar submit` command creates a new submission. To retry a failed upload, use `--submission SUBMISSION_ID`. For an older submission from the same project, use `--submission SUBMISSION_ID` with the review, response, status, or revision command.

Never request or use a GitHub personal access token, OAuth grant, GitHub App user token, GitHub username, fork, or author repository URL.

## Review and respond

Use these commands:

```bash
aidar status --server URL --project PATH
aidar reviews --server URL --project PATH
aidar respond --server URL --project PATH --file response.md
aidar respond --server URL --project PATH --file response.md --reply-to COMMENT_ID
```

Inspect the response file for author identity before posting. The AIDaR bot publishes the response under its bot identity.

## Revise

1. Run `aidar check PATH` again. The owner-only redaction profile keeps replacements stable for the same project across revisions.
2. Stop on any failure.
3. Run `aidar revise PATH --server URL`.
4. Explain that a revision is a complete replacement snapshot. Files removed locally are removed from the GitHub review branch.
5. Return the new revision, package digest, and status.

## Privacy rules

- Never upload `.git/`, other version-control metadata, `.github/workflows/`, or `.aidar-private-identities.txt`.
- Never display or log the author token. Let only the CLI store credentials and redaction profiles in owner-only files outside the project.
- Never include original identity terms or mappings in a report, archive, issue, response, or chat message. The focused local terminal prompt is the only place detected terms may be shown.
- Do not claim cryptographic anonymity. State that GitHub, chairs, and the operator are inside the trust boundary.
- Do not run submitted code, notebooks, builds, installers, containers, or workflows.
- The CLI may replace supported text and path matches only in its temporary snapshot. It must verify the matched originals are absent before upload and report replacement counts without reporting the originals.
- Treat warnings as items that the author must inspect, especially unsupported binary and partially inspected file formats, even when the CLI allows submission.
