# AIDaR host deployment

The source checkout and build stay in `/var/www/html/submityour.work`. Runtime
state and secrets do not.

- Binary: `/usr/local/lib/aidar/aidar-server`
- Database and future backups: `/var/lib/aidar`
- Environment and GitHub App key: `/etc/aidar`
- Listener: `127.0.0.1:39740`
- Public hostname: `submityour.work`

The invited browser pilot has one-time invitation codes, per-client request
limits, bounded upload concurrency, and a localhost-only administrator API.
Invitation codes expire after 14 days. Uploaded archives are processed in
memory and are not written to the service database or filesystem.

Build the release binaries, then activate the HTTPS author API:

```bash
cargo build --release --bins
sudo /var/www/html/submityour.work/deploy/activate-invited-pilot.sh
```

The activation script makes owner-only rollback copies, backs up SQLite,
validates Apache and the local invitation gate, restarts AIDaR, and only then
reloads the public proxy.

Create a one-time invitation without exposing the administrator token:

```bash
sudo sh -c '/usr/local/lib/aidar/aidar-admin --server http://127.0.0.1:39740 --token-stdin create-invitation --label demo < /etc/aidar/admin.token'
```

The GitHub App key transfer target is `/etc/aidar/github-app.pem`. Install it
as `aidar:aidar` mode `0600`. Never paste or print it.
