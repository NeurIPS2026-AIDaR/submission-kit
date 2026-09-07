#!/bin/sh
# Repair the deployed July 2026 refresh program without changing its privileges.
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this repair with sudo." >&2
    exit 1
fi
if [ "$#" -gt 1 ]; then
    echo "Usage: $0 [OpenReview-note-id-to-check]" >&2
    exit 2
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE=$SOURCE_DIR/refresh-openreview-token.sh
TARGET=/usr/local/lib/aidar/refresh-openreview-token
OLD_SHA=169a34466bbdc1dab75505328142985609ea9490e92dc71b74ae370c5522e493
FIXED_SHA=b31e792e7ea24a33133e45b2c5f923d72a51301f570a6dbe2db16e56645f13bc

test "$(sha256sum "$SOURCE" | cut -d ' ' -f 1)" = "$FIXED_SHA"
CURRENT_SHA=$(sha256sum "$TARGET" | cut -d ' ' -f 1)
case "$CURRENT_SHA" in
    "$OLD_SHA"|"$FIXED_SHA") ;;
    *) echo "Installed refresh script differs from the reviewed version; stopping." >&2; exit 1 ;;
esac
sh -n "$SOURCE"

# Use disposable, non-secret files to reproduce the exact capability restriction.
TEST_DIR=$(mktemp -d /tmp/aidar-token-permissions.XXXXXX)
cleanup() {
    rm -f "$TEST_DIR/old" "$TEST_DIR/new"
    rmdir "$TEST_DIR"
}
trap cleanup EXIT HUP INT TERM
setpriv --bounding-set=-all,+chown,+dac_override /bin/sh -eu -c '
    dir=$1
    touch "$dir/old"
    chown aidar:aidar "$dir/old"
    if chmod 0600 "$dir/old" 2>/dev/null; then
        echo "Permission regression test did not reproduce the fault." >&2
        exit 1
    fi
    touch "$dir/new"
    chmod 0600 "$dir/new"
    chown aidar:aidar "$dir/new"
    test "$(stat -c %a "$dir/new")" = 600
    test "$(stat -c %U:%G "$dir/new")" = aidar:aidar
' sh "$TEST_DIR"
echo "Permission regression test passed with the restricted capabilities."

# Stop a currently running refresh before replacing its program; keep the timer.
systemctl stop aidar-openreview-token.service
if [ "$CURRENT_SHA" = "$OLD_SHA" ]; then
    install -d -o root -g root -m 0700 /var/lib/aidar/backups
    BACKUP=$(mktemp /var/lib/aidar/backups/refresh-before-permission-fix.XXXXXX)
    install -o root -g root -m 0600 "$TARGET" "$BACKUP"
    install -o root -g root -m 0755 "$SOURCE" "$TARGET"
    echo "Installed corrected refresh program; previous program backed up privately."
fi

# Exercise the actual unit restrictions, not a privileged manual script invocation.
if ! systemctl start aidar-openreview-token.service; then
    echo "Refresh still failed. Safe diagnostic output follows:" >&2
    journalctl -u aidar-openreview-token.service -n 12 --no-pager
    exit 1
fi
systemctl is-active --quiet aidar
systemctl is-active --quiet aidar-openreview-token.timer
curl -fsS --connect-timeout 3 --max-time 10 http://127.0.0.1:39740/health
echo

# Verify an optional real note through a read-only OpenReview request. Never claim
# the author's link, create a key, or print their manuscript or any credentials.
if [ "$#" -eq 1 ]; then
    python3 - "$1" <<'PY'
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

note_id = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9_-]{6,128}", note_id):
    sys.exit("Invalid OpenReview note ID.")
token = Path('/etc/aidar/openreview-token').read_text().strip()
request = urllib.request.Request(
    'https://api2.openreview.net/notes?id=' + note_id,
    headers={'Authorization': 'Bearer ' + token},
)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        data = json.load(response)
except urllib.error.HTTPError as error:
    sys.exit('Read-only submission verification returned HTTP ' + str(error.code))
except Exception:
    sys.exit('Read-only submission verification could not reach OpenReview.')
notes = data.get('notes', [])
if len(notes) != 1:
    sys.exit('OpenReview did not return exactly one submission.')
note = notes[0]
venue = note.get('content', {}).get('venueid')
if isinstance(venue, dict):
    venue = venue.get('value')
if not (
    note.get('id') == note_id
    and note.get('ddate') is None
    and 'NeurIPS.cc/2026/Workshop/AIDaR/-/Submission' in note.get('invitations', [])
    and venue == 'NeurIPS.cc/2026/Workshop/AIDaR/Submission'
):
    sys.exit('The note does not meet the current AIDaR verification rules.')
print('Reported submission passed the OpenReview checks; no submission was created.')
PY
fi
journalctl -u aidar-openreview-token.service -n 8 --no-pager
echo "Refresh completed under systemd; AIDaR and its rotation timer are active."
