#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root." >&2
    exit 1
fi

SOURCE_ROOT=/var/www/html/submityour.work
ENV_FILE=/etc/aidar/aidar.env
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP=/var/lib/aidar/backups/cutover-$STAMP

test -x "$SOURCE_ROOT/target/release/aidar-server"
test -x "$SOURCE_ROOT/target/release/aidar-admin"
test -x "$SOURCE_ROOT/target/release/aidar"
test -r "$SOURCE_ROOT/public/index.html"
test -r "$SOURCE_ROOT/public/app.js"
test -f "$ENV_FILE"
test -f /etc/aidar/github-app.pem

umask 077
install -d -o aidar -g aidar -m 0700 /var/lib/aidar/backups
install -d -o root -g root -m 0700 "$BACKUP"

backup_file() {
    if [ -e "$1" ]; then
        cp -a "$1" "$BACKUP/$2"
    fi
}

backup_file /usr/local/lib/aidar/aidar-server aidar-server
backup_file /usr/local/lib/aidar/aidar-admin aidar-admin
backup_file /usr/local/bin/aidar aidar-client
backup_file /etc/systemd/system/aidar.service aidar.service
backup_file /etc/apache2/sites-available/submityour.work-https.conf apache-https.conf
backup_file /etc/apache2/sites-available/submityour.work.conf apache-http.conf
backup_file "$ENV_FILE" aidar.env

if [ -f /var/lib/aidar/aidar.sqlite ]; then
    DB_BACKUP=/var/lib/aidar/backups/aidar-$STAMP.sqlite
    runuser -u aidar -- sqlite3 /var/lib/aidar/aidar.sqlite ".backup '$DB_BACKUP'"
    chown aidar:aidar "$DB_BACKUP"
    chmod 0600 "$DB_BACKUP"
fi

rollback() {
    code=$?
    trap - EXIT HUP INT TERM
    set +e
    [ ! -f "$BACKUP/aidar-server" ] || install -o root -g root -m 0755 "$BACKUP/aidar-server" /usr/local/lib/aidar/aidar-server
    [ ! -f "$BACKUP/aidar-admin" ] || install -o root -g root -m 0755 "$BACKUP/aidar-admin" /usr/local/lib/aidar/aidar-admin
    [ ! -f "$BACKUP/aidar-client" ] || install -o root -g root -m 0755 "$BACKUP/aidar-client" /usr/local/bin/aidar
    [ ! -f "$BACKUP/aidar.service" ] || install -o root -g root -m 0644 "$BACKUP/aidar.service" /etc/systemd/system/aidar.service
    [ ! -f "$BACKUP/apache-https.conf" ] || install -o root -g root -m 0644 "$BACKUP/apache-https.conf" /etc/apache2/sites-available/submityour.work-https.conf
    [ ! -f "$BACKUP/apache-http.conf" ] || install -o root -g root -m 0644 "$BACKUP/apache-http.conf" /etc/apache2/sites-available/submityour.work.conf
    [ ! -f "$BACKUP/aidar.env" ] || install -o aidar -g aidar -m 0600 "$BACKUP/aidar.env" "$ENV_FILE"
    systemctl daemon-reload
    systemctl restart aidar
    if apache2ctl configtest; then
        systemctl reload apache2
    fi
    echo "Cutover failed. Previous service and vhost files were restored from $BACKUP." >&2
    exit "$code"
}
trap rollback EXIT HUP INT TERM

TEMP_ENV=$(mktemp /etc/aidar/aidar.env.XXXXXX)
install -o aidar -g aidar -m 0600 "$ENV_FILE" "$TEMP_ENV"

set_env() {
    name=$1
    value=$2
    next=$(mktemp /etc/aidar/aidar.env.XXXXXX)
    awk -F= -v key="$name" '$1 != key' "$TEMP_ENV" > "$next"
    printf '%s=%s\n' "$name" "$value" >> "$next"
    install -o aidar -g aidar -m 0600 "$next" "$TEMP_ENV"
    rm -f "$next"
}

set_env GITHUB_REVIEW_TEAM_ID 18777959
set_env REGISTRATIONS_PER_MINUTE 5
set_env UPLOADS_PER_MINUTE 2
set_env MAX_CONCURRENT_UPLOADS 2
install -o aidar -g aidar -m 0600 "$TEMP_ENV" "$ENV_FILE"
rm -f "$TEMP_ENV"

install -o root -g root -m 0755 "$SOURCE_ROOT/target/release/aidar-server" /usr/local/lib/aidar/aidar-server
install -o root -g root -m 0755 "$SOURCE_ROOT/target/release/aidar-admin" /usr/local/lib/aidar/aidar-admin
install -o root -g root -m 0755 "$SOURCE_ROOT/target/release/aidar" /usr/local/bin/aidar
install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/aidar.service" /etc/systemd/system/aidar.service
install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/submityour.work-https.conf" /etc/apache2/sites-available/submityour.work-https.conf
install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/submityour.work-http.conf" /etc/apache2/sites-available/submityour.work.conf
chmod 0751 "$SOURCE_ROOT"
chmod 0755 "$SOURCE_ROOT/public"
chmod 0644 "$SOURCE_ROOT/public/index.html" "$SOURCE_ROOT/public/app.js"

systemctl daemon-reload
apache2ctl configtest
systemctl restart aidar

attempt=0
until curl -fsS http://127.0.0.1:39740/health >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 10 ]; then
        echo "AIDaR did not become healthy on localhost." >&2
        exit 1
    fi
    sleep 1
done

gate_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data '{"openreview_url":"https://openreview.net/forum?id=CutoverGateCheck","invitation_code":"aidar_inv_invalid"}' \
    http://127.0.0.1:39740/v1/author/submissions)
test "$gate_status" = 403

systemctl reload apache2
curl -fsS https://submityour.work/health >/dev/null
public_gate_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    --data '{"openreview_url":"https://openreview.net/forum?id=PublicCutoverGate","invitation_code":"aidar_inv_invalid"}' \
    https://submityour.work/v1/author/submissions)
test "$public_gate_status" = 403
redirect_status=$(curl -sS -o /dev/null -w '%{http_code}' http://submityour.work/)
test "$redirect_status" = 301

trap - EXIT HUP INT TERM
echo "Activated the invited AIDaR browser pilot."
echo "Rollback files are owner-only at $BACKUP."
echo "No secret values were printed."
