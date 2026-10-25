#!/bin/sh
set -eu
fail() { echo "[INIT] ERROR: $1" >&2; exit 1; }
validate_id() {
  case "$2" in ''|*[!0-9]*) fail "$1 must be a positive numeric ID." ;; esac
  [ "$2" -gt 0 ] 2>/dev/null && [ "$2" -le 2147483647 ] 2>/dev/null || fail "$1 must be between 1 and 2147483647."
}
PUID=${PUID-99}
PGID=${PGID-100}
validate_id PUID "$PUID"
validate_id PGID "$PGID"
[ "$(id -u)" = 0 ] || fail 'Permission initialization requires root; omit --user. Node runs unprivileged.'
[ ! -L /config ] || fail 'Symlink at /config is unsupported.'
mkdir -p /config || fail 'Cannot create /config.'
[ -d /config ] || fail 'Mount a real /config directory.'
# Preflight known files before any ownership changes. Never recurse.
for file in /config/config.yml /config/requests.yml; do
  [ ! -L "$file" ] || fail 'Symlink at an application file is unsupported.'
  if [ -e "$file" ]; then
    [ -f "$file" ] && [ "$(stat -c %h "$file")" = 1 ] || fail 'Application files must be regular, non-hardlinked files.'
  fi
done
own() {
  [ "$(stat -c %u:%g "$1")" = "$PUID:$PGID" ] || chown -h "$PUID:$PGID" "$1" || fail 'Cannot set application storage ownership.'
}
own /config
for file in /config/config.yml /config/requests.yml; do
  if [ -f "$file" ]; then own "$file"; fi
done
if [ -f /config/config.yml ]; then
  gosu "$PUID:$PGID" test -r /config/config.yml || fail 'Configuration is unreadable by PUID/PGID.'
fi
gosu "$PUID:$PGID" sh -c 'probe=$(mktemp /config/.write-check.XXXXXX) && rm "$probe"' || fail 'Cannot write to /config; check mount permissions.'
# Normalize supported npm aliases to a direct Node process for PID 1 signals.
if [ "$#" -ge 3 ] && [ "$1" = npm ] && [ "$2" = run ]; then
  case "$3" in
    run:generate) operation=generate ;;
    run:request) operation=request ;;
    *) operation= ;;
  esac
  if [ -n "$operation" ]; then
    shift 3
    if [ "${1-}" = -- ]; then shift; fi
    set -- node /app/src/index.js "$operation" "$@"
  fi
fi
exec gosu "$PUID:$PGID" "$@"
