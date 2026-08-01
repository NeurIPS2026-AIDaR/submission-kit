#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root." >&2
    exit 1
fi

SOURCE_ROOT=/var/www/html/submityour.work

test -x "$SOURCE_ROOT/deploy/refresh-openreview-token.sh"
test -r "$SOURCE_ROOT/deploy/aidar-openreview-token.service"
test -r "$SOURCE_ROOT/deploy/aidar-openreview-token.timer"
test -f /etc/aidar/openreview-token
if [ ! -f /etc/aidar/openreview-refresh-token ]; then
    echo "Missing /etc/aidar/openreview-refresh-token." >&2
    echo "Install the private OpenReview refresh credential as root:root mode 0600." >&2
    exit 1
fi
if [ "$(stat -c %a /etc/aidar/openreview-refresh-token)" != 600 ] \
    || [ "$(stat -c %U:%G /etc/aidar/openreview-refresh-token)" != root:root ]; then
    echo "/etc/aidar/openreview-refresh-token must be root:root mode 0600." >&2
    exit 1
fi

systemctl disable --now aidar-openreview-token.timer >/dev/null 2>&1 || true
install -o root -g root -m 0755 \
    "$SOURCE_ROOT/deploy/refresh-openreview-token.sh" \
    /usr/local/lib/aidar/refresh-openreview-token
install -o root -g root -m 0644 \
    "$SOURCE_ROOT/deploy/aidar-openreview-token.service" \
    /etc/systemd/system/aidar-openreview-token.service
install -o root -g root -m 0644 \
    "$SOURCE_ROOT/deploy/aidar-openreview-token.timer" \
    /etc/systemd/system/aidar-openreview-token.timer

systemd-analyze verify \
    /etc/systemd/system/aidar-openreview-token.service \
    /etc/systemd/system/aidar-openreview-token.timer
systemctl daemon-reload

echo "Running one controlled cookie refresh. Only expiration times can be printed."
if ! /usr/local/lib/aidar/refresh-openreview-token --force; then
    echo "The refresh test failed. The automatic timer remains disabled." >&2
    exit 1
fi

systemctl enable --now aidar-openreview-token.timer
echo "Enabled automatic OpenReview token rotation."
systemctl list-timers aidar-openreview-token.timer --no-pager
