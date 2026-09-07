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

# Railway owns the R2 configuration. When all three values are present,
# Litestream restores a missing database and supervises Chadashot while
# continuously replicating SQLite changes. With none present, local and
# non-backed-up deployments run Chadashot normally.
if [ -n "${LITESTREAM_REPLICA_URL:-}" ] \
  || [ -n "${LITESTREAM_ACCESS_KEY_ID:-}" ] \
  || [ -n "${LITESTREAM_SECRET_ACCESS_KEY:-}" ]; then
  if [ -z "${LITESTREAM_REPLICA_URL:-}" ] \
    || [ -z "${LITESTREAM_ACCESS_KEY_ID:-}" ] \
    || [ -z "${LITESTREAM_SECRET_ACCESS_KEY:-}" ]; then
    echo "Litestream backups require replica URL, access key ID, and secret access key" >&2
    exit 1
  fi

  exec gosu node litestream replicate \
    -config /etc/litestream.yml \
    -restore-if-db-not-exists \
    -exec "$*"
fi

exec gosu node "$@"
