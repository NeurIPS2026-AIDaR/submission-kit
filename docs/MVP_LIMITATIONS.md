# MVP limitations

- A new submission requires one unused OpenReview forum URL. The service stores the URL in its private database. It does not verify ownership and does not synchronize reviews or decisions with OpenReview.
- The local mock models GitHub behavior. The single-repository live test confirmed the main GitHub App operations.
- The live test used an organization owner as the reviewer. This account had administrator access. The test did not prove pull-only reviewer access or cross-repository isolation for outside collaborators.
- The client keeps PDF, Office, image, archive, and other binary files unchanged. It warns that these files were not inspected. Authors must inspect them.
- Text and path redaction covers configured identity terms plus supported email, ORCID, home-path, co-author-trailer, and repository-owner patterns. It does not infer every name, affiliation, URL, or indirect identity clue.
- The built-in secret scanner uses high-confidence patterns. The client also uses `gitleaks` when it is already installed. Authors do not have to install it.
- Threaded author replies use a top-level pull-request comment that cites the review comment ID.
- The service does not send email or webhook notifications.
- The self-service creation endpoint has no chair gate. OpenReview URL uniqueness limits accidental duplicates, but it is not authentication. A public deployment must add creation and upload rate limits without putting author identity into review repositories.
- SQLite is correct for one local pilot process. A multi-process deployment needs a shared database and stronger job coordination.
- A live GitHub failure after repository creation can leave a partial private repository. An operator must inspect and remove or repair it.
- The MVP does not execute code or verify reproducibility.
- Automatic claim extraction is not implemented. The package can include `claims/claims.json` for later study.
- The publication command accepts a validated package. A controlled de-anonymization schema and consent step are second-stage work.
- The MVP does not provide cryptographic anonymity, anonymous reviewer identities, or anonymity from chairs, the operator, or GitHub.
