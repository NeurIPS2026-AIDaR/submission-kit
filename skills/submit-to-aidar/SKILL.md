---
name: submit-to-aidar
description: Submit, revise, check, or review an anonymous AIDaR research project. Use when an author wants to send any local project or research artifacts to AIDaR, update a submission, read reviews, or reply without using GitHub.
---

# Submit to AIDaR

Use the official standalone `aidar` client. Do not reimplement its checks or packaging.

## Get the client

Use an existing official client if it is available. Otherwise:

1. Get the latest `client-v*` release from `NeurIPS2026-AIDaR/submission-kit`.
2. Select the asset for the operating system and processor.
3. Download the asset and `SHA256SUMS` from that release.
4. Verify the asset checksum. Stop if it does not match.
5. Extract `aidar` to an owner-controlled directory outside the project and make it executable.

The standalone client is the only author-side component. Do not ask the author to install a runtime, container system, Git, or a GitHub client.

For local development before the first release, use `target/release/aidar` from this repository.

## Submit

1. Resolve the project path. Ask for it only if the request does not identify it.
2. Get the OpenReview link. Ask only this question if it is missing: `What is the OpenReview link for this submission?`
3. Get the one-time invitation code. Ask only if it is missing. Do not save it in the project or repeat it after use.
4. Get the server from `AIDAR_BASE_URL`. Use `https://submityour.work` if the variable is absent.
5. Run `aidar check PATH`. Show all warnings. Stop on an error.
6. If the author asked to submit, run:

```bash
aidar submit PATH --server URL --openreview OPENREVIEW_URL --invitation-code INVITATION_CODE
```

7. Return the submission ID, revision, digest, and status. Do not show or copy the saved author credential.

Do not ask what types of artifacts are present. Do not require a PDF, manifest, README, fixed directory layout, Git repository, or GitHub account. The client submits the regular files that the author placed in the project.

## Continue the review

Use the project path so the client can find its saved credential:

```bash
aidar revise PATH --server URL
aidar status --server URL --project PATH
aidar reviews --server URL --project PATH
aidar respond --server URL --project PATH --file RESPONSE.md
```

A revision is a complete replacement snapshot. Run `aidar check PATH` before each revision. The client keeps redaction aliases stable across revisions.

## Privacy

- The client works on a temporary copy. It does not change the project.
- It excludes version-control data, workflow files, and `.aidar-private-identities.txt`.
- It redacts supported text patterns and stops on high-confidence secrets.
- If `gitleaks` is installed, the client also runs it. Do not require it.
- It keeps PDF and other binary files unchanged and warns the author to inspect them.
- It never runs submitted code, builds, installers, containers, or workflows.
- It stores the OpenReview link only in the private service database. The anonymous GitHub repository does not contain the URL.
- It does not provide cryptographic anonymity. The organizing committee, the service operator, OpenReview, and GitHub are inside the trust boundary.
