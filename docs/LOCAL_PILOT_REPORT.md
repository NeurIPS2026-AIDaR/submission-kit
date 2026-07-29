# AIDaR GitHub-native submission local pilot report

- **Date:** July 29, 2026
- **Result:** Local pilot, standalone-client HTTP loop, prior one-repository live loop, and new-organization initial submission passed
- **Adoption status:** Not ready for workshop use

## Purpose

This pilot tests a private GitHub review process next to OpenReview. It does not replace OpenReview. It tests whether an author can submit an anonymous research package without a GitHub account or a prescribed file layout.

## Scope

The pilot includes the author client, the administrator client, the API, the package checks, local deterministic redaction, SQLite storage, and GitHub interfaces. The local test uses a mock GitHub service. A prior live test used a personal throwaway organization. The current live test uses the `NeurIPS2026-AIDaR` organization and its organization-owned App.

The pilot records one OpenReview forum URL for each submission. It does not synchronize OpenReview reviews or decisions. It does not include automatic claim extraction. It does not run submitted code.

## Observed results

| Test | Result |
|---|---|
| Server unit and integration tests | PASS, 36 tests |
| Standalone Rust client tests | PASS, 2 tests |
| Native Apple Silicon release build | PASS |
| Arbitrary non-empty regular-file submission | PASS |
| Stable redaction aliases across revisions | PASS |
| Local-only identity file and redaction profile | PASS |
| Self-service submission registration without chair action | PASS |
| Unique OpenReview forum URL gate | PASS |
| Two isolated private submission models | PASS |
| Author submission without a GitHub credential | PASS |
| Opaque repository names | PASS |
| Disabled GitHub Actions model | PASS |
| Named reviewer assignment | PASS |
| Three review item types through the author relay | PASS |
| Bot-relayed author response | PASS |
| Complete replacement revision | PASS |
| Deletion of a removed file in revision 2 | PASS |
| Cross-submission reviewer isolation | PASS |
| Actual HTTP API and both CLIs | PASS |
| Standalone client status, review, response, and revision loop | PASS |
| Deterministic package digest | PASS |
| Hostile archive and anonymity checks | PASS |
| Private repository creation with the GitHub App | PASS |
| Organization base repository permission set to no permission | PASS |
| App limited to selected repositories and five planned permissions | PASS |
| GitHub Actions disabled in the live repository | PASS |
| App bot owns author-side commits and comments | PASS |
| Named review relayed from GitHub to the anonymous author | PASS |
| Live complete-replacement revision and file deletion | PASS |
| Pull-only access for an outside reviewer | NOT TESTED |
| Cross-repository isolation on live GitHub | NOT TESTED |

The HTTP test completed one initial submission, one reviewer assignment, one inline comment, one author response, and one revision. The local test database and temporary package data were deleted after the test.

The standalone Apple Silicon client completed the same author loop through the HTTP API. It used only a project path and OpenReview forum URL for the initial submission. It saved its credential in owner-only local files, read an inline review, posted one response through the bot, and submitted revision 2. A second client state could not create a submission with the same normalized OpenReview forum URL.

The prior live test completed the full review, response, and revision loop in a personal throwaway organization. The App created the repository, disabled Actions, made the submission commits, opened the pull request, relayed one named review, posted the anonymous author response, and replaced revision 1 with revision 2. A file removed from the source did not remain in revision 2. No raw author token was present in the test database.

The new-organization test created private synthetic repository [`NeurIPS2026-AIDaR/submission-fff5fee24d11`](https://github.com/NeurIPS2026-AIDaR/submission-fff5fee24d11) and [pull request 1](https://github.com/NeurIPS2026-AIDaR/submission-fff5fee24d11/pull/1). The free-form source had no required manifest. The temporary snapshot replaced five fake identity signals. Inspection confirmed that the original fake name, email, ORCID, user-home path, and repository owner were absent from the review branch. The App bot owns the verified submission commit. The repository is private, and Actions are disabled.

The assigned reviewer owns the organization and has administrator access because of that role. Therefore, this run does not prove pull-only reviewer access or isolation between two submission repositories.

## Response to workshop concerns

### Clear AI-ready format

The current author client accepts arbitrary regular-file contents rather than imposing a minimum package or manifest. It creates a deterministic redacted snapshot and a local, term-safe validation/redaction summary. The fixture still demonstrates one optional structured layout.

### Submission burden

The author uses one client or one Codex skill. The submit command creates the submission and saves its credential automatically. The author does not wait for a chair, create a fork, or provide a GitHub account or token. A live user study must still measure preparation time and failure rate.

### Author anonymity

The local model hides the author GitHub identity. It removes local Git history and commit metadata. Supported identity matches are replaced only in a verified temporary snapshot, with stable aliases across revisions. The App owns all author-side GitHub actions. The checks find common identity leaks.

This is not cryptographic anonymity. Chairs, the operator, and GitHub are inside the trust boundary. Visible names, public code, writing style, and distinctive data can identify an author.

### Review before acceptance

The private package exists before the decision. Reviewers can inspect it during review. Publication is a separate action after acceptance. This design tests the value of structured artifacts during review, not only after acceptance.

### Quality and consistency

The client and server apply the same safety checks. They do not require a research layout. The server does not trust the client result. It extracts the archive into a new private directory and repeats the checks.

### OpenReview coexistence

OpenReview can remain the official submission and decision system. GitHub can provide the artifact view and the parallel review record. A new AIDaR submission requires one unused OpenReview forum URL. The service keeps this URL outside the anonymous repository. The MVP does not synchronize the two systems.

## Important limits

The live result proves the main App operations for one private repository. It does not prove the reviewer permission boundary. A second live run needs two reviewer accounts that are not organization owners. Each reviewer must have access to only one submission repository.

The client keeps PDFs, images, Office files, archives, and other binary files unchanged. It warns that it did not inspect them. Authors must inspect every final file and warning.

SQLite is suitable for one pilot process. It is not the final database for a multi-process service. A live GitHub failure can leave a partial private repository that needs operator repair.

## Recommendation

Do not propose workshop adoption yet. Repeat the live test with two reviewers who are not organization owners. Confirm pull-only access, collaborator invitation behavior, cross-repository isolation, reviewer removal, and repository retention procedures.

If the live test passes, run a small study with synthetic submissions. Measure author effort, chair effort, reviewer task time, reviewer preference, and identity guesses. Use these results for the team proposal.
