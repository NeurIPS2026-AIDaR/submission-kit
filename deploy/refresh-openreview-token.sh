#!/bin/sh
set -eu

TOKEN_FILE=/etc/aidar/openreview-token
API_BASE=https://api2.openreview.net
SUBMISSION_QUERY='notes?invitation=NeurIPS.cc%2F2026%2FWorkshop%2FAIDaR%2F-%2FSubmission&limit=1'
REFRESH_BEFORE_SECONDS=172800
MIN_NEW_LIFETIME_SECONDS=518400
FORCE=0

if [ "${1:-}" = "--force" ] && [ "$#" -eq 1 ]; then
    FORCE=1
elif [ "$#" -ne 0 ]; then
    echo "Usage: $0 [--force]" >&2
    exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "OpenReview token rotation must run as root." >&2
    exit 1
fi

test -f "$TOKEN_FILE"
test "$(stat -c %a "$TOKEN_FILE")" = 600
test "$(stat -c %U:%G "$TOKEN_FILE")" = aidar:aidar

umask 077
exec 9>/run/aidar-openreview-token.lock
if ! flock -n 9; then
    echo "OpenReview token rotation is already running."
    exit 0
fi

read_token() {
    tr -d '\r\n' < "$1"
}

jwt_exp() {
    token=$1
    payload=${token#*.}
    test "$payload" != "$token"
    payload=${payload%%.*}
    test -n "$payload"

    normalized=$(printf '%s' "$payload" | tr '_-' '/+')
    case $((${#normalized} % 4)) in
        0) ;;
        2) normalized="${normalized}==" ;;
        3) normalized="${normalized}=" ;;
        *) return 1 ;;
    esac

    printf '%s' "$normalized" \
        | base64 -d 2>/dev/null \
        | jq -er '.exp | select(type == "number" and floor == . and . > 0)'
}

validate_token_shape() {
    candidate=$1
    test -n "$candidate"
    test "${#candidate}" -le 8192
    case "$candidate" in
        *[!A-Za-z0-9._-]*) return 1 ;;
    esac
    parts=$(printf '%s' "$candidate" | awk -F. '{ print NF }')
    test "$parts" -eq 3
}

authenticated_status() {
    candidate=$1
    url=$2
    {
        printf 'header = "Authorization: Bearer '
        printf '%s' "$candidate"
        printf '"\n'
    } | curl -sS -o /dev/null -w '%{http_code}' \
        --connect-timeout 10 --max-time 30 --config - "$url"
}

old_token=$(read_token "$TOKEN_FILE")
if ! validate_token_shape "$old_token"; then
    echo "The installed OpenReview token has an invalid shape." >&2
    exit 1
fi
if ! old_exp=$(jwt_exp "$old_token"); then
    echo "The installed OpenReview token has no valid expiration claim." >&2
    exit 1
fi

now=$(date +%s)
remaining=$((old_exp - now))
if [ "$FORCE" -eq 0 ] && [ "$remaining" -gt "$REFRESH_BEFORE_SECONDS" ]; then
    old_exp_utc=$(date -u -d "@$old_exp" '+%Y-%m-%d %H:%M:%S UTC')
    echo "OpenReview token remains valid until $old_exp_utc; rotation is not due."
    exit 0
fi

response=$(mktemp /run/aidar-openreview-refresh.XXXXXX)
previous=$(mktemp /run/aidar-openreview-previous.XXXXXX)
next=$(mktemp /etc/aidar/.openreview-token.XXXXXX)
cleanup() {
    rm -f "$response" "$previous" "$next"
}
trap cleanup EXIT HUP INT TERM
install -o root -g root -m 0600 "$TOKEN_FILE" "$previous"

if ! refresh_status=$(
    {
        printf 'header = "Authorization: Bearer '
        printf '%s' "$old_token"
        printf '"\n'
    } | curl -sS -o "$response" -w '%{http_code}' \
        --connect-timeout 10 --max-time 30 --config - \
        -H 'Accept: application/json' \
        -H 'Content-Type: application/json' \
        --data '{}' \
        "$API_BASE/refreshToken"
); then
    echo "OpenReview token refresh could not reach API 2." >&2
    exit 1
fi
if [ "$refresh_status" != 200 ]; then
    echo "OpenReview token refresh returned HTTP $refresh_status." >&2
    exit 1
fi

if ! new_token=$(jq -er '.token | select(type == "string" and length > 0 and length <= 8192)' "$response"); then
    echo "OpenReview returned no valid replacement token." >&2
    exit 1
fi
if ! validate_token_shape "$new_token"; then
    echo "OpenReview returned a replacement token with an invalid shape." >&2
    exit 1
fi
if ! new_exp=$(jwt_exp "$new_token"); then
    echo "The replacement token has no valid expiration claim." >&2
    exit 1
fi
if [ "$new_exp" -le "$old_exp" ]; then
    echo "OpenReview did not extend the token expiration; the installed token was not changed." >&2
    exit 1
fi
if [ $((new_exp - now)) -lt "$MIN_NEW_LIFETIME_SECONDS" ]; then
    echo "OpenReview returned a token valid for less than six days; the installed token was not changed." >&2
    exit 1
fi

if ! new_status=$(authenticated_status "$new_token" "$API_BASE/$SUBMISSION_QUERY"); then
    echo "The replacement token could not be verified against OpenReview." >&2
    exit 1
fi
if [ "$new_status" != 200 ]; then
    echo "The replacement token verification returned HTTP $new_status; expected 200." >&2
    exit 1
fi

printf '%s\n' "$new_token" > "$next"
chown aidar:aidar "$next"
chmod 0600 "$next"
sync -f "$next"
mv -f "$next" "$TOKEN_FILE"
sync -f /etc/aidar

restore_previous() {
    echo "AIDaR did not become healthy with the replacement token; restoring the previous file." >&2
    install -o aidar -g aidar -m 0600 "$previous" "$TOKEN_FILE"
    systemctl restart aidar || true
    exit 1
}

if ! systemctl restart aidar; then
    restore_previous
fi
attempt=0
until curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:39740/health >/dev/null; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 10 ]; then
        restore_previous
    fi
    sleep 1
done

new_exp_utc=$(date -u -d "@$new_exp" '+%Y-%m-%d %H:%M:%S UTC')
echo "Rotated and verified the OpenReview token; it is valid until $new_exp_utc."
echo "No credential values were printed or stored in the journal."
