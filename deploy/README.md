# AIDaR host deployment

The source checkout and build stay in `/var/www/html/submityour.work`. Runtime
state and secrets do not.

- Binary: `/usr/local/lib/aidar/aidar-server`
- Database and future backups: `/var/lib/aidar`
- Environment and GitHub App key: `/etc/aidar`
- Listener: `127.0.0.1:39740`
- Public hostname: `submityour.work`

The HTTPS virtual host is intentionally not ready for activation: the pinned
application has neither one-time invitation codes nor request-frequency
limiting. Those controls require a separate reviewed repository change.

The GitHub App key transfer target is `/etc/aidar/github-app.pem`. Transfer it
to a temporary owner-only file outside the web root, then have an administrator
install it at that target as `aidar:aidar` mode `0600`. Never paste or print it.
