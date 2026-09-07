#!/bin/sh
set -eu

legacy_setting=""
if [ "${SECURE+x}" = "x" ]; then
  legacy_setting="SECURE"
elif [ "${LETTA_SERVER_SECURE+x}" = "x" ]; then
  legacy_setting="LETTA_SERVER_SECURE"
elif [ "${LETTA_SERVER_PASSWORD+x}" = "x" ]; then
  legacy_setting="LETTA_SERVER_PASSWORD"
elif [ -d /var/lib/postgresql/data ]; then
  legacy_setting="the old /var/lib/postgresql/data mount"
fi

case "${1:-}" in
  ./letta/server/startup.sh|/app/letta/server/startup.sh)
    legacy_setting="the retired server startup command"
    ;;
  letta|letta.js)
    ;;
esac

if [ -n "$legacy_setting" ]; then
  cat >&2 <<EOF
The retired Python Letta server is end-of-life and this image now contains Letta Code.

This container still uses $legacy_setting, which is not supported by the current App Server. The old PostgreSQL data cannot be mounted directly into the current server. Keep a backup of it, then follow the current self-hosting guide:
https://docs.letta.com/self-hosting/
EOF
  exit 64
fi

cron_dir="${LETTA_SYSTEM_CRON_DIR:-/root/.letta/system-cron}"
root_crontab_file="${LETTA_SYSTEM_ROOT_CRONTAB:-/root/.letta/system-crontab/root}"

mkdir -p /etc/cron.d "$cron_dir" "$(dirname "$root_crontab_file")"

if [ -d "$cron_dir" ]; then
  find "$cron_dir" -mindepth 1 -maxdepth 1 -type f | while read -r cron_file; do
    target="/etc/cron.d/$(basename "$cron_file")"
    cp "$cron_file" "$target"
    chmod 0644 "$target"
  done
fi

if [ -f "$root_crontab_file" ]; then
  crontab "$root_crontab_file"
else
  crontab -r 2>/dev/null || true
fi

cron
exec "$@"
