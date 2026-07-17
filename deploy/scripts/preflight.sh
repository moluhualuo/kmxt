#!/bin/sh
set -eu

# Author: 花落. MIT License.
cd /root/kmxt/deploy
test -f production.env
for secret in root_secret mysql_password mysql_ca.pem redis_password admin_password; do
  test -s "secrets/$secret"
done
docker compose config --quiet
docker compose build app
docker compose run --rm app node cli/kmxt.js migrate
docker compose run --rm app node cli/kmxt.js status
