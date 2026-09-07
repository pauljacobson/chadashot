#!/bin/sh
set -eu

# Railway mounts the persistent volume as root. Restrict the ownership change to
# Chadashot's fixed data path, then run the application without root privileges.
if [ "${DATA_DIR:-}" != "/data" ]; then
  echo "Container DATA_DIR must be /data" >&2
  exit 1
fi

install -d -o node -g node -m 700 /data
chown node:node /data
exec gosu node "$@"
