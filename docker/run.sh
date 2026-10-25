#!/bin/sh
set -eu
# Root-owned runtime values contain only validated numeric IDs.
. /run/requester/identity
cd /app
export NODE_ENV=production
# --no-fork makes Node inherit the lock and receive signals directly after gosu.
exec flock --nonblock --conflict-exit-code 75 --no-fork /run/requester/execution.lock \
  /usr/sbin/gosu "$PUID:$PGID" /usr/local/bin/node /app/src/index.js
