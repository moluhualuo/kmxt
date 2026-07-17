#!/bin/sh
set -eu
umask 077

# Author: 花落. Recovery is MIT licensed and intentionally never drops or overwrites a database.
usage() {
  echo "Usage: $0 <backup-directory> --confirm-restore" >&2
  exit 64
}

[ "$#" -eq 2 ] && [ "$2" = "--confirm-restore" ] || usage
BACKUP_DIRECTORY=$1
DEPLOY_DIRECTORY=/root/kmxt/deploy

cd "$DEPLOY_DIRECTORY"
test -f backup.env
test -d "$BACKUP_DIRECTORY"
test -f "$BACKUP_DIRECTORY/SHA256SUMS"
test -f "$BACKUP_DIRECTORY/kamxt1.sql.gz"
test -f "$BACKUP_DIRECTORY/root_secret"
test -s secrets/mysql_password
test -s secrets/mysql_ca.pem
test -s secrets/root_secret

if docker compose ps --status running --services | grep -qx app; then
  echo "Refusing restore while the app service is running. Stop it first." >&2
  exit 1
fi

if ! cmp -s "$BACKUP_DIRECTORY/root_secret" secrets/root_secret; then
  echo "The configured root secret does not match the backup. Restore it manually before importing data." >&2
  exit 1
fi

(cd "$BACKUP_DIRECTORY" && sha256sum -c SHA256SUMS)

set -a
. ./backup.env
set +a

: "${KMXT_MYSQL_HOST:?KMXT_MYSQL_HOST is required}"
: "${KMXT_MYSQL_PORT:?KMXT_MYSQL_PORT is required}"
: "${KMXT_MYSQL_USER:?KMXT_MYSQL_USER is required}"
: "${KMXT_MYSQL_DATABASE:?KMXT_MYSQL_DATABASE is required}"
case "$KMXT_MYSQL_DATABASE" in
  *[!A-Za-z0-9_]* | '')
    echo "KMXT_MYSQL_DATABASE may contain only letters, digits, and underscores." >&2
    exit 1
    ;;
esac

MYSQL_PWD=$(cat secrets/mysql_password)
export MYSQL_PWD
MYSQL_OPTIONS="--ssl-mode=VERIFY_IDENTITY --ssl-ca=$DEPLOY_DIRECTORY/secrets/mysql_ca.pem --host=$KMXT_MYSQL_HOST --port=$KMXT_MYSQL_PORT --user=$KMXT_MYSQL_USER"
TABLE_COUNT=$(mysql $MYSQL_OPTIONS --batch --skip-column-names --database="$KMXT_MYSQL_DATABASE" \
  --execute "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '$KMXT_MYSQL_DATABASE'")

if [ "$TABLE_COUNT" != "0" ]; then
  echo "Refusing restore because $KMXT_MYSQL_DATABASE is not empty. Provision an empty database first." >&2
  exit 1
fi

gzip -cd "$BACKUP_DIRECTORY/kamxt1.sql.gz" | mysql $MYSQL_OPTIONS --database="$KMXT_MYSQL_DATABASE"
echo "Restore import completed. Run migration and status checks before starting the app."
