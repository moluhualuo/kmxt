#!/bin/sh
set -eu
umask 077

# Author: 花落. MIT License. Run daily from root's cron.
BASE=/root/kmxt/backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DAILY="$BASE/daily/$STAMP"
mkdir -p "$DAILY" "$BASE/weekly"

set -a
. /root/kmxt/deploy/backup.env
set +a
MYSQL_PWD=$(cat /root/kmxt/deploy/secrets/mysql_password)
export MYSQL_PWD
mysqldump --single-transaction --routines --events --triggers \
  --ssl-mode=VERIFY_IDENTITY --ssl-ca=/root/kmxt/deploy/secrets/mysql_ca.pem \
  --host="$KMXT_MYSQL_HOST" --port="$KMXT_MYSQL_PORT" \
  --user="$KMXT_MYSQL_USER" "$KMXT_MYSQL_DATABASE" | gzip -9 > "$DAILY/kamxt1.sql.gz"
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
