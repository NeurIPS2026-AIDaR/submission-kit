# Threat model

## Security goal

Hide the author-to-submission mapping from assigned reviewers during review. Keep reviewer activity attributable to known GitHub accounts. Prevent common accidental identity and secret leaks from entering the review repository.

This is reviewer-facing author anonymity. It is not cryptographic anonymity.

## Trust boundary

| Actor | Can know author identity | Can read a submission | GitHub identity shown |
|---|---:|---:|---|
| Author | Yes | Own package and relayed reviews | No author account is used |
| Assigned reviewer | Should not | Assigned repositories only | Reviewer account |
| Chair | Yes | All managed submissions | Chair or App account |
| AIDaR operator | Can infer it | Service data and GitHub objects | App account for relay actions |
| GitHub | Can observe metadata | Hosted repositories | Platform records apply |

## Protected data

- Author token.
- GitHub App private key and installation tokens.
- Chairs-only external ID mapping.
- Private package content.
- Private identity terms.
- Reviewer-to-account mapping.

## Main threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Original Git history identifies an author | Create a new archive, tree, and App-authored commit | File content can still identify an author |
| A file path escapes staging | Reject absolute, traversal, ambiguous, and colliding paths | Parser defects remain possible |
| Link targets expose local files | Reject symbolic links, hard links, and non-regular files | Platform file-system behavior can differ |
| Submitted workflows run code | Reject workflow files and disable Actions | A reviewer can run code on another system |
| A secret enters the repository | Built-in patterns and optional `gitleaks`, repeated on the server | No scanner detects every secret |
| Supported text or paths identify an author | Redact into a temporary snapshot with stable project-specific aliases, then verify matched originals are absent | Unlisted names and indirect clues can remain |
| Metadata or opaque binary content identifies an author | Check PDF metadata and extracted text; explicitly warn for unsupported or uninspected binary formats | Visible image text and unsupported metadata can remain |
| Reviewer sees another paper | Use one private repository for each submission and narrow collaborator access | Organization owners can have broad access |
| Author identity appears on GitHub | Author uses only an AIDaR token; App posts all author actions | GitHub and the operator can observe network metadata |
| Token theft permits author actions | Use 32 random bytes, HMAC storage, one-submission scope, and revocation | The MVP has no device binding or rotation UI |
| Duplicate request creates duplicate state | Require an idempotency key and package digest | A partial live GitHub failure can need operator repair |
| Upload exhausts resources | Limit compressed size, expanded size, file size, count, and path length | The MVP has no distributed denial-of-service layer |

## Data retention

The service does not store raw author tokens, author names, author email addresses, identity-term lists, redaction mappings, or uploaded archives. The author client stores credentials and a project-specific redaction profile in owner-only files outside the project. It deletes temporary staging directories after success or failure. This deletion is logical deletion. It is not secure physical erasure from SSDs or cloud volumes.

Define a workshop policy for private repository and review retention. Remove reviewer access after that period. Do not publish a rejected package without author consent.

## Author responsibility

The checks and supported redactions find common leaks. They cannot find all leaks. An unsupported-binary warning explicitly means that the client does not claim the file is clean. Authors must inspect the final PDF, figures, code, data, URLs, and machine-readable files. Topic, prose style, public artifacts, and distinctive results can identify an author.
