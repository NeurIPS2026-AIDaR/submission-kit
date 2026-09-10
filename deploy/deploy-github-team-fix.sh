#!/bin/sh
# Build first: cargo build --locked --release --bin aidar-server --example github_team_smoke
set -eu
umask 077
test "$(id -u)" -eq 0 || { echo 'Run with sudo.' >&2; exit 1; }
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SERVER=$ROOT/target/release/aidar-server
SMOKE=$ROOT/target/release/examples/github_team_smoke
test -x "$SERVER"
test -x "$SMOKE"

# Exercise the real App under the aidar account before replacing production.
# Only synthetic files are used; no author credential or submission is touched.
install -o root -g root -m 0755 "$SMOKE" /usr/local/lib/aidar/github-team-smoke
runuser -u aidar -- /bin/sh -eu -c '
    set -a
    . /etc/aidar/aidar.env
    set +a
    cd /var/lib/aidar
    exec /usr/local/lib/aidar/github-team-smoke --create-synthetic-repository
'

install -d -o root -g root -m 0700 /var/lib/aidar/backups
BACKUP=$(mktemp /var/lib/aidar/backups/server-before-team-fix.XXXXXX)
install -o root -g root -m 0600 /usr/local/lib/aidar/aidar-server "$BACKUP"
CANDIDATE=$(mktemp /usr/local/lib/aidar/.aidar-server.XXXXXX)
trap 'rm -f "$CANDIDATE"' EXIT HUP INT TERM
install -o root -g root -m 0755 "$SERVER" "$CANDIDATE"
mv -f "$CANDIDATE" /usr/local/lib/aidar/aidar-server

healthy() {
    attempt=0
    while [ "$attempt" -lt 15 ]; do
        if curl -fsS --connect-timeout 2 --max-time 3 http://127.0.0.1:39740/health >/dev/null 2>&1; then
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    return 1
}
if ! systemctl restart aidar || ! healthy; then
    install -o root -g root -m 0755 "$BACKUP" "$CANDIDATE"
    mv -f "$CANDIDATE" /usr/local/lib/aidar/aidar-server
    systemctl restart aidar
    echo 'Deployment failed; restored the previous server binary.' >&2
    exit 1
fi
cmp "$SERVER" /usr/local/lib/aidar/aidar-server
curl -fsS --connect-timeout 3 --max-time 10 https://submityour.work/health
echo
echo 'GitHub team fix deployed. Synthetic create/revise/review checks passed.'
echo 'Existing author keys and the production database were preserved.'
