#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root." >&2
    exit 1
fi

SOURCE_ROOT=/var/www/html/submityour.work

test "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" = c104c1c4ec7266297787a551a708f13dcab74a2b
test -x "$SOURCE_ROOT/target/release/aidar-server"

if ! id aidar >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/aidar --shell /usr/sbin/nologin aidar
fi

install -d -o root -g root -m 0755 /usr/local/lib/aidar
install -o root -g root -m 0755 "$SOURCE_ROOT/target/release/aidar-server" /usr/local/lib/aidar/aidar-server
install -o root -g root -m 0755 "$SOURCE_ROOT/target/release/aidar-admin" /usr/local/lib/aidar/aidar-admin
install -d -o aidar -g aidar -m 0700 /var/lib/aidar
install -d -o aidar -g aidar -m 0700 /var/lib/aidar/backups
install -d -o aidar -g aidar -m 0700 /etc/aidar

install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/aidar.service" /etc/systemd/system/aidar.service
systemctl daemon-reload

chmod 0751 "$SOURCE_ROOT"
chmod 0755 "$SOURCE_ROOT/public"
chmod 0644 "$SOURCE_ROOT/public/index.html"
install -o root -g root -m 0644 "$SOURCE_ROOT/deploy/submityour.work-http.conf" /etc/apache2/sites-available/submityour.work.conf
a2ensite submityour.work.conf
apache2ctl configtest
systemctl reload apache2

echo "Installed the inactive AIDaR runtime skeleton and HTTP holding site."
echo "The aidar service remains disabled and stopped."
