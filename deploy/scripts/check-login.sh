#!/bin/sh
set -eu

# Author: 花落. MIT License.
PASS=$(cat /root/kmxt/deploy/secrets/admin_password)
BODY=$(node -e 'console.log(JSON.stringify({username: process.argv[1], password: process.argv[2]}))' platform-admin "$PASS")
RESP=$(curl --resolve kmxt.moluhualuo.top:443:127.0.0.1 --silent --show-error --max-time 10 \
  -H 'Content-Type: application/json' -d "$BODY" https://kmxt.moluhualuo.top/api/v1/auth/login)
printf '%s' "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s); if(!r.success) process.exit(2); console.log("LOGIN_OK role=" + r.data.user.role);})'
