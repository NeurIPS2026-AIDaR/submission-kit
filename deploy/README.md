# AIDaR host deployment

The source checkout and build stay in `/var/www/html/submityour.work`. Runtime
state and secrets do not.

- Binary: `/usr/local/lib/aidar/aidar-server`
- Database and future backups: `/var/lib/aidar`
- Environment and GitHub App key: `/etc/aidar`
- Listener: `127.0.0.1:39740`
- Public hostname: `submityour.work`

The browser pilot verifies each OpenReview link against the private AIDaR workshop
submissions and permits one claim per link. It also has per-client request limits,
bounded upload concurrency, and a localhost-only administrator API. Uploaded archives are processed in
memory and are not written to the service database or filesystem.

Build the release binaries, then activate the HTTPS author API:

```bash
cargo build --release --bins
sudo /var/www/html/submityour.work/deploy/activate-invited-pilot.sh
```

The activation script makes owner-only rollback copies, backs up SQLite,
validates Apache and the local OpenReview verification gate, restarts AIDaR, and only then
reloads the public proxy.

Create the initial OpenReview credentials on a trusted local computer:

```bash
uv run --python 3.12 --with openreview-py \
  python /path/to/submission-kit/deploy/create-openreview-credentials.py
```

This one-time login creates an access credential and a longer-lived refresh credential.
It does not store the OpenReview username or password. Securely transfer both files to
the host without pasting or printing them. Install the access credential at
`/etc/aidar/openreview-token` as `aidar:aidar` mode `0600`. Install the refresh
credential at `/etc/aidar/openreview-refresh-token` as `root:root` mode `0600`.
The access credential must be able to read the workshop's private submissions.

Install automatic token rotation after the initial token is in place:

```bash
sudo /var/www/html/submityour.work/deploy/install-openreview-rotation.sh
```

The installer performs one controlled refresh through OpenReview's private refresh
cookie, verifies the new access credential, checks access to the private workshop
submissions, and restarts AIDaR. It enables the systemd timer only after all checks
pass. The timer checks every 30 minutes and rotates credentials with fewer than 45
minutes remaining. It logs expiration times and status only, never credential values
or API response bodies.

The GitHub App key transfer target is `/etc/aidar/github-app.pem`. Install it
as `aidar:aidar` mode `0600`. Never paste or print it.
