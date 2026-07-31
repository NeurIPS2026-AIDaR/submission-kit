# Submit to AIDaR

AIDaR adds a private, anonymous GitHub review space next to an OpenReview submission.

## Submit

Give your coding agent this instruction:

```text
Install the submit-to-aidar skill from
https://github.com/NeurIPS2026-AIDaR/submission-kit/tree/main/skills/submit-to-aidar

Use it to submit the project at PATH.
```

The agent asks for your OpenReview link and one-time invitation code, then does the rest.

You need:

- the project directory;
- its `https://openreview.net/forum?id=...` link;
- a one-time invitation code from the workshop organizers.

That is all. The skill downloads one standalone `aidar` client and runs it. You do not need a GitHub account.

## What happens

1. The client makes a temporary copy. It does not change your project.
2. It removes Git history, checks for secrets, and replaces supported identity text.
3. It uploads the checked copy to AIDaR.
4. The AIDaR App creates a private repository and pull request.
5. Reviewers comment with their normal GitHub accounts. Author updates and responses appear under the AIDaR bot identity.

To update a submission, ask the agent to use the skill again. The saved local credential links the revision to the same pull request.

A browser submission saves its private AIDaR key in that browser and downloads a backup file. A returning author can refresh status, read reviews, respond, or upload a checked revision without entering the invitation code again. Use **Forget** after a session on a shared device.

Keep the downloaded key outside the submitted project. Import it in another browser, or attach it to a local project for CLI access:

```bash
aidar import-credential aidar-submission-ID.json --project PATH
```

## Limits

The client keeps PDFs, images, and other binary files unchanged. Inspect them before submission. AIDaR provides reviewer-facing anonymity, not cryptographic anonymity. Workshop administrators and GitHub remain inside the trust boundary.

## Administrators

The author client and administrator service are separate. See [operator setup](docs/OPERATIONS.md), [GitHub App setup](docs/GITHUB_SETUP.md), and the [pilot report](docs/LOCAL_PILOT_REPORT.md).

This pilot runs next to OpenReview. OpenReview remains the official submission and decision system.
