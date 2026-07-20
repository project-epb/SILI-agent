#!/bin/bash

# Weekly SILI DB backup: dump via dump_db.sh, prune old local dumps, mirror to R2.
# Cron: 0 4 * * 0 /data/chatbot-sili/scripts/backup_db.sh >> /data/chatbot-sili/.backups/backup.log 2>&1

set -euo pipefail

script_dir=$(dirname "$(realpath "$0")")
backup_dir=$(realpath "$script_dir/../.backups")

echo "[$(date '+%F %T')] backup start"

"$script_dir/dump_db.sh"

# Keep only the 8 newest local archives
ls -1t "$backup_dir"/mongo_dump-*.archive.gz | tail -n +15 | xargs -r rm --

# Mirror archives to R2 so remote retention matches local.
# Guard: refuse to sync (and delete remote copies) if local dir looks wiped.
count=$(ls -1 "$backup_dir"/mongo_dump-*.archive.gz 2>/dev/null | wc -l)
if [ "$count" -lt 3 ]; then
  echo "refusing to sync: only $count local archives, remote copies preserved" >&2
  exit 1
fi
rclone sync "$backup_dir" r2:cloud-epb/sili_backups/ --include "mongo_dump-*.archive.gz"

echo "[$(date '+%F %T')] backup done: $count local archives, r2 mirrored"
