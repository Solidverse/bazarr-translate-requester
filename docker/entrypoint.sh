#!/bin/sh
set -eu
fail() { echo "[INIT] ERROR: $1" >&2; exit 1; }
validate_id() {
  case "$2" in ''|*[!0-9]*) fail "$1 must be a positive numeric ID." ;; esac
  [ "$2" -gt 0 ] && [ "$2" -le 2147483647 ] || fail "$1 must be between 1 and 2147483647."
}
PUID=${PUID-99}
PGID=${PGID-100}
validate_id PUID "$PUID"
validate_id PGID "$PGID"
[ "$(id -u)" = 0 ] || fail 'Cron initialization requires root; omit --user. Application Node runs unprivileged.'

# Debian cron reads /etc/timezone; TZ alone is insufficient.
case "$TZ" in ''|/*|*..*|*[!A-Za-z0-9_+/-]*) fail 'TZ must name an installed IANA timezone.' ;; esac
[ -f "/usr/share/zoneinfo/$TZ" ] || fail 'TZ must name an installed IANA timezone.'
ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
printf '%s\n' "$TZ" > /etc/timezone

# Only the known config directory/file are managed, never recursive contents.
[ -d /config ] && [ ! -L /config ] || fail 'Mount a real /config directory containing config.yml.'
[ -f /config/config.yml ] && [ ! -L /config/config.yml ] || fail 'Supply a regular /config/config.yml file.'
[ "$(stat -c %h /config/config.yml)" = 1 ] || fail 'Hardlinked configuration files are unsupported.'
chown "$PUID:$PGID" /config /config/config.yml || fail 'Cannot set config ownership; check mount permissions.'
gosu "$PUID:$PGID" test -r /config/config.yml || fail 'Configuration is unreadable by PUID/PGID.'

mkdir -p /run/requester
printf 'PUID=%s\nPGID=%s\n' "$PUID" "$PGID" > /run/requester/identity
chmod 600 /run/requester/identity
gosu "$PUID:$PGID" node /app/scripts/setup-cron.mjs > /etc/cron.d/requester
chmod 644 /etc/cron.d/requester

shutdown() {
  trap '' TERM INT
  echo '[INIT] Stopping cron and active application executions.'
  kill -TERM "$cron_pid" 2>/dev/null || true
  # Cron jobs have separate sessions. Signal the runtime UID explicitly;
  # tini reaps orphaned descendants. Keep the container alive until jobs exit.
  pkill -TERM -u "$PUID" 2>/dev/null || true
  wait "$cron_pid" 2>/dev/null || true
  while pgrep -u "$PUID" >/dev/null; do sleep 0.1; done
  exit 0
}
echo "[INIT] Starting Debian cron; timezone=$TZ; application UID:GID=$PUID:$PGID."
/usr/sbin/cron -f &
cron_pid=$!
trap shutdown TERM INT
set +e
wait "$cron_pid"
status=$?
echo '[INIT] Cron exited unexpectedly.' >&2
exit "${status:-1}"
