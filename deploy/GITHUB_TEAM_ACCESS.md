# GitHub App team-access repair

The repository-creation request formerly included `team_id`. The deployed App
received HTTP 422 because this creation option requires team-admin access.
Creation now omits that option and uses the supported Teams permission endpoint
after creating the private repository and disabling Actions. The configured team
receives `pull` access, as before. Team visibility is checked before repository
creation; a failed permission grant stops the flow before project files are sent.

The App installation requires organization **Members: read** along with its
existing repository **Administration: write** and **Metadata: read** permissions.
Approve permission updates on the installation as well as on the App settings.
Do not remove the committee team configuration to work around this failure.

## Validate and deploy

```sh
cargo test --locked
cargo build --locked --release --bin aidar-server --example github_team_smoke
sudo sh deploy/deploy-github-team-fix.sh
```

The deployment helper first runs the real GitHub implementation as `aidar`, using
the installed App credentials. It creates a uniquely named private repository
containing only synthetic text, creates and closes a review PR, uploads a
revision and fetches reviews. It does not access an author's key or change the
production database. If that test fails, the production binary is not replaced.

The synthetic repository is retained for checking privacy, Actions status, and
team permissions through an independent organizer account. Archive it after
verification. Never apply cleanup to an author's repository. The helper backs up
the old server binary privately, swaps in the new binary and restarts AIDaR,
restoring the old binary if the local startup check fails.

The original HTTP 422 happens before repository creation. An affected author can
retry with their existing key. Other downstream GitHub failures can still leave
a partial private repository and require operator inspection before retrying.

Reference: https://docs.github.com/en/rest/teams/teams#add-or-update-team-repository-permissions
