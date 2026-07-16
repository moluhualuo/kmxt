#!/bin/sh
set -eu
umask 077

# Author: 花落. MIT License. Run daily from root's cron.
BASE=/root/kmxt/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DAILY="$BASE/daily/$STAMP"
mkdir -p "$DAILY" "$BASE/weekly"
DUMP="$DAILY/kamxt1.sql"

cleanup() {
  rm -f "$DUMP"
}
trap cleanup EXIT HUP INT TERM

cd /root/kmxt/deploy
docker compose exec -T mysql sh -eu -c '
  export MYSQL_PWD="$(cat /run/secrets/mysql_local_password)"
  exec mysqldump --single-transaction --routines --events --triggers \
    --no-tablespaces --set-gtid-purged=OFF --host=127.0.0.1 --port=3306 \
    --user="$MYSQL_USER" "$MYSQL_DATABASE"
' > "$DUMP"
test -s "$DUMP"
gzip -9 "$DUMP"
gzip -t "$DAILY/kamxt1.sql.gz"
cp /root/kmxt/deploy/secrets/root_secret "$DAILY/root_secret"
sha256sum "$DAILY/kamxt1.sql.gz" "$DAILY/root_secret" > "$DAILY/SHA256SUMS"

find "$BASE/daily" -mindepth 1 -maxdepth 1 -type d -mtime +6 -exec rm -rf -- {} +
if [ "$(date -u +%u)" = "7" ]; then
  cp -a "$DAILY" "$BASE/weekly/$STAMP"
fi
find "$BASE/weekly" -mindepth 1 -maxdepth 1 -type d -mtime +27 -exec rm -rf -- {} +

USED=$(df -P "$BASE" | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if [ "$USED" -ge 85 ]; then
  logger -p auth.warning "KMXT backup filesystem usage is ${USED}%"
fi
