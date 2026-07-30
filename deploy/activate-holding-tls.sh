#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this script as root." >&2
    exit 1
fi

SOURCE_ROOT=/var/www/html/submityour.work
test -s /etc/letsencrypt/live/submityour.work/fullchain.pem
test -s /etc/letsencrypt/live/submityour.work/privkey.pem

install -o root -g root -m 0644 \
    "$SOURCE_ROOT/deploy/submityour.work-holding-https.conf" \
    /etc/apache2/sites-available/submityour.work-https.conf
a2ensite submityour.work-https.conf
apache2ctl configtest
systemctl reload apache2

echo "Activated the static HTTPS holding site. No AIDaR API proxy is enabled."
