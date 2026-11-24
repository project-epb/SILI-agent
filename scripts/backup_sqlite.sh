#!/bin/bash
# Requires sqlite3 on the host and rclone access to the private backup bucket.
set -euo pipefail
umask 077

root=$(dirname "$(dirname "$(realpath "$0")")")
backup_dir="$root/.backups"
snapshot="$root/.volumns/core/.sili-db-snapshot.sqlite"
mkdir -p "$backup_dir"
exec 9>"$backup_dir/.sqlite-backup.lock"
flock -n 9

stamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_dir/sqlite-$stamp.sqlite.gz"
pending=$(mktemp "$backup_dir/.sqlite-backup.XXXXXXXX")
trap 'rm -f -- "$pending"' EXIT
rm -f -- "$snapshot"

docker exec sili-core bash -ec '
  test "$SILI_DATABASE" = sqlite
  while read -r label mask rest; do
    if [[ $label == SigCgt: ]]; then
      (( 16#$mask & (1 << 11) ))
      kill -USR2 1
      exit
    fi
  done < /proc/1/status
  exit 1
'
for ((attempt=0; attempt<60; attempt++)); do
  if [[ -f "$snapshot" ]]; then break; fi
  sleep 1
done
test -f "$snapshot"
test "$(sqlite3 -readonly "$snapshot" 'PRAGMA integrity_check;')" = ok
gzip -c -- "$snapshot" > "$pending"
gzip -t "$pending"
mv -n -- "$pending" "$archive"
rm -f -- "$snapshot"

rclone copyto "$archive" "r2:sili-backups/sqlite/${archive##*/}"
find "$backup_dir" -maxdepth 1 -type f -name 'sqlite-*.sqlite.gz' -mtime +14 -delete
rclone delete r2:sili-backups/sqlite --min-age 15d
printf '[%s] SQLite backup verified and uploaded: %s\n' "$(date '+%F %T')" "${archive##*/}"
