#!/bin/sh
set -eu

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
