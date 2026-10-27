#!/bin/sh
set -eu
# docker exec bypasses the entrypoint; apply the same production identity to npm.
if [ "$(id -u)" = 0 ]; then
  exec gosu "${PUID-99}:${PGID-100}" /usr/local/bin/npm "$@"
fi
exec /usr/local/bin/npm "$@"
