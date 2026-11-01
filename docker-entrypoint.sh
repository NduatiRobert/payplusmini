#!/bin/sh
# Make sure the persistent data folder (Coolify volume / bind mount) is writable, then drop root.
set -e
DATA_DIR="$(dirname "${DB_PATH:-/data/payplus.db}")"
mkdir -p "$DATA_DIR"
if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec runuser -u node -- "$@"
fi
exec "$@"
