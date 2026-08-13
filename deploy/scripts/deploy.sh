#!/bin/sh
set -eu

# Author: 花落. MIT License.
cd /root/kmxt/deploy
docker compose run --rm app node cli/kmxt.js migrate
if docker compose run --rm app node cli/kmxt.js status | grep -q '"users": 0'; then
  docker compose run --rm app node cli/kmxt.js create-admin \
    --username platform-admin --password-file /run/secrets/kmxt_admin_password \
    --display-name "平台管理员"
fi
docker compose up -d --build
curl --fail --silent --show-error http://127.0.0.1:8082/ready
