#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root." >&2
    exit 1
fi

KEY=/etc/aidar/github-app.pem
OPENREVIEW_TOKEN=/etc/aidar/openreview-token
test -f "$KEY"
test "$(stat -c %a "$KEY")" = 600
test "$(stat -c %U:%G "$KEY")" = aidar:aidar
runuser -u aidar -- test -r "$KEY"
test -f "$OPENREVIEW_TOKEN"
test "$(stat -c %a "$OPENREVIEW_TOKEN")" = 600
test "$(stat -c %U:%G "$OPENREVIEW_TOKEN")" = aidar:aidar
runuser -u aidar -- test -r "$OPENREVIEW_TOKEN"

umask 077
TEMP_ENV=$(mktemp /etc/aidar/aidar.env.XXXXXX)
trap 'rm -f "$TEMP_ENV"' EXIT HUP INT TERM

TOKEN_HMAC_SECRET=$(openssl rand -hex 32)
ADMIN_TOKEN=$(openssl rand -hex 32)
ADMIN_TOKEN_HASH=$(printf %s "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)

printf '%s\n' \
    'AIDAR_HOST=127.0.0.1' \
    'PORT=39740' \
    'AIDAR_BASE_URL=http://127.0.0.1:39740' \
    'AIDAR_DATABASE_PATH=/var/lib/aidar/aidar.sqlite' \
    "AIDAR_TOKEN_HMAC_SECRET=$TOKEN_HMAC_SECRET" \
    "AIDAR_ADMIN_TOKEN_HASH=$ADMIN_TOKEN_HASH" \
    'AIDAR_GITHUB_MODE=live' \
    'GITHUB_APP_ID=4427282' \
    'GITHUB_APP_PRIVATE_KEY_PATH=/etc/aidar/github-app.pem' \
    'GITHUB_INSTALLATION_ID=149900943' \
    'GITHUB_ORG=NeurIPS2026-AIDaR' \
    'GITHUB_API_VERSION=2026-03-10' \
    'GITHUB_PUBLIC_ARCHIVE_REPO=aidar-2026-submissions' \
    'GITHUB_REVIEW_TEAM_ID=18777959' \
    'OPENREVIEW_API_BASE=https://api2.openreview.net' \
    'OPENREVIEW_ACCESS_TOKEN_PATH=/etc/aidar/openreview-token' \
    'OPENREVIEW_SUBMISSION_INVITATION=NeurIPS.cc/2026/Workshop/AIDaR/-/Submission' \
    'OPENREVIEW_ACTIVE_VENUE_ID=NeurIPS.cc/2026/Workshop/AIDaR/Submission' \
    'MAX_UPLOAD_BYTES=104857600' \
    'MAX_UNPACKED_BYTES=262144000' \
    'MAX_FILE_BYTES=26214400' \
    'MAX_FILE_COUNT=5000' \
    'MAX_PATH_LENGTH=240' \
    'MAX_RESPONSE_BYTES=65536' \
    'REGISTRATIONS_PER_MINUTE=5' \
    'UPLOADS_PER_MINUTE=2' \
    'MAX_CONCURRENT_UPLOADS=2' > "$TEMP_ENV"

install -o aidar -g aidar -m 0600 "$TEMP_ENV" /etc/aidar/aidar.env
printf %s "$ADMIN_TOKEN" | install -o aidar -g aidar -m 0600 /dev/stdin /etc/aidar/admin.token

unset TOKEN_HMAC_SECRET ADMIN_TOKEN ADMIN_TOKEN_HASH
rm -f "$TEMP_ENV"
trap - EXIT HUP INT TERM

systemctl enable --now aidar
echo "Configured and started AIDaR on 127.0.0.1:39740."
echo "No secret values were printed."
