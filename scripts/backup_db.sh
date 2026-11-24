#!/bin/bash

# Daily MongoDB backup for instances that still use MongoDB.
# Cron: 0 4 * * * /data/chatbot-sili/scripts/backup_db.sh >> /data/chatbot-sili/.backups/backup.log 2>&1

set -euo pipefail

script_dir=$(dirname "$(realpath "$0")")
backup_dir=$(realpath "$script_dir/../.backups")

echo "[$(date '+%F %T')] backup start"

"$script_dir/dump_db.sh"

# Keep the 14 newest scheduled local archives
ls -1t "$backup_dir"/mongo_dump-sili_v4-*.archive.gz | tail -n +15 | xargs -r rm --

# Keep old archives in private R2 even if they age out locally.
count=$(ls -1 "$backup_dir"/mongo_dump-*.archive.gz 2>/dev/null | wc -l)
if [ "$count" -lt 3 ]; then
  echo "refusing to upload: only $count local archives, remote copies preserved" >&2
  exit 1
fi
rclone copy "$backup_dir" r2:sili-backups/mongo/ --include "mongo_dump-*.archive.gz"

echo "[$(date '+%F %T')] backup done: $count local archives, copied to private R2"
