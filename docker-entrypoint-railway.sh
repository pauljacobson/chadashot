#!/bin/sh
set -eu

# Railway can restore Debian's default Apache site after the image is built.
rm -f /etc/apache2/sites-enabled/000-default.conf

exec /var/www/FreshRSS/Docker/entrypoint.freshrss.sh "$@"
