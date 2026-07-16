#!/bin/sh
set -eu

# Author: 花落. Distributed under the MIT License.
LOGIN_URL=${KMXT_LOGIN_URL:-https://kmxt.moluhualuo.top/api/v1/auth/login}
PASSWORD_FILE=${KMXT_ADMIN_PASSWORD_FILE:-/root/kmxt/deploy/secrets/admin_password}

BODY=$(
  cat "$PASSWORD_FILE" \
    | node -e 'let password=""; process.stdin.on("data", (chunk) => { password += chunk; }).on("end", () => { console.log(JSON.stringify({ username: "platform-admin", password: password.trim() })); });'
)
RESPONSE=$(
  printf '%s' "$BODY" \
    | curl --silent --show-error --max-time 15 \
        -H 'Content-Type: application/json' \
        --data-binary @- "$LOGIN_URL"
)

printf '%s' "$RESPONSE" \
  | node -e 'let body=""; process.stdin.on("data", (chunk) => { body += chunk; }).on("end", () => { const response = JSON.parse(body); if (!response.success) process.exit(2); console.log("PUBLIC_LOGIN_OK role=" + response.data.user.role); });'
