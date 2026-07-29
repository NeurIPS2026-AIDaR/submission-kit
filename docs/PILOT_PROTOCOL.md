# Local pilot protocol

## Purpose

Test whether a GitHub workflow can address the concerns in the workshop discussion before the team changes the submission process. Run this workflow next to OpenReview. Do not ask real authors to use the pilot until the live security checks pass.

## Concern matrix

| Concern | Pilot response | Evidence to collect |
|---|---|---|
| “AI-ready” must not impose one research layout | Accept arbitrary regular-file contents; enforce only safety, privacy, and operational gates | Validation results and reviewer ratings of artifact navigation |
| A new requirement can reduce submissions | The author runs one self-service skill or CLI command, answers at most one focused privacy prompt, and needs no chair action or GitHub account | Time to prepare, number of manual steps, and failure rate |
| Review must preserve anonymity | Create and verify a deterministic redacted snapshot; the App creates an opaque private repository and all author actions use the bot identity | Redaction tests, identity-leak tests, commit inspection, and reviewer guess survey |
| GitHub can be mandatory only after acceptance | The pilot tests a private GitHub representation during review and a separate public transition after acceptance | Compare review usefulness before and after access to structured artifacts |
| Chairs need quality and consistency | Local and server checks use the same schema and deterministic package | Rule failures, warnings, and chair correction time |
| OpenReview remains the official workflow | Run the GitHub review in parallel and keep decision authority in OpenReview | Reviewer comparison survey and reconciliation log |

## Local stages

1. Run all automated tests.
2. Run `npm run test:pilot` in mock mode.
3. Run the API, the self-service author CLI, and the administrator CLI as separate processes.
4. Use two anonymous fixture packages and two reviewer identities.
5. Confirm that each reviewer can access only the assigned package in the mock model.
6. Add one formal review, one inline comment, and one general comment.
7. Fetch all items with the author client.
8. Post one author response.
9. Remove a local file and submit a revision.
10. Confirm that the removed file is absent from the new snapshot.
11. Record all manual steps, errors, unclear terms, and elapsed times.

## Live stages

1. Use a test GitHub organization and test App.
2. Complete every check in `docs/GITHUB_SETUP.md`.
3. Use one chair account and two known reviewer accounts.
4. Submit two fixtures without any author GitHub credential.
5. Test cross-repository access with both reviewer accounts.
6. Inspect commit authorship, commit metadata, branch contents, App identity, and Actions state.
7. Complete the author response and replacement revision loop.
8. Test rejection and reviewer removal.
9. Test acceptance and a publication pull request with synthetic data only.

## Stop conditions

Stop the pilot and do not use real submissions if any of these events occurs:

- An author identity or secret reaches a review repository.
- An unassigned reviewer can read a repository.
- Submitted code runs automatically.
- An author must provide a GitHub credential.
- A revision keeps a file that the author removed.
- A repeated request creates a second repository or revision.

## Measurements

Record these values for each run:

- Package size and file count.
- Local check time and upload time.
- Number of failures and warnings by rule.
- Author preparation time.
- Chair setup and correction time.
- Reviewer time to find the manuscript, code, data notes, claims, and results.
- Reviewer preference between GitHub and OpenReview for each review task.
- Identity guesses and the reason for each guess.
- Failed access attempts across repositories.

## Report gate

Write the team report only after the local and live evidence tables are complete. Use ADS-STE100 Simplified Technical English. Separate observed results from proposed policy. State all anonymity limits.
