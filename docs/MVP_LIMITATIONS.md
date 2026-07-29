# MVP limitations

- OpenReview integration is not implemented. Chairs must keep the OpenReview-to-AIDaR ID mapping outside this service.
- The local mock models GitHub behavior. The single-repository live test confirmed the main GitHub App operations.
- The live test used an organization owner as the reviewer. This account had administrator access. The test did not prove pull-only reviewer access or cross-repository isolation for outside collaborators.
- The client checks PDF author metadata and extracted text but cannot rewrite PDF content. A detected PDF privacy term or author metadata blocks submission. It does not fully inspect Office files, image metadata, or visible text in figures.
- Unsupported binary files are retained with an explicit warning and are not claimed clean. Authors must inspect them or convert them to a supported text format.
- Text and path redaction covers configured identity terms plus supported email, ORCID, home-path, co-author-trailer, and repository-owner patterns. It does not infer every name, affiliation, URL, or indirect identity clue.
- The built-in secret scanner uses high-confidence patterns. Install `gitleaks` for an additional check.
- Threaded author replies use a top-level pull-request comment that cites the review comment ID.
- The service does not send email or webhook notifications.
- The self-service creation endpoint has no chair gate. A public deployment must add creation and upload rate limits without putting author identity into review repositories.
- SQLite is correct for one local pilot process. A multi-process deployment needs a shared database and stronger job coordination.
- A live GitHub failure after repository creation can leave a partial private repository. An operator must inspect and remove or repair it.
- The MVP does not execute code or verify reproducibility.
- Automatic claim extraction is not implemented. The package can include `claims/claims.json` for later study.
- The publication command accepts a validated package. A controlled de-anonymization schema and consent step are second-stage work.
- The MVP does not provide cryptographic anonymity, anonymous reviewer identities, or anonymity from chairs, the operator, or GitHub.
