# 香港机部署与恢复

作者：花落；协议：MIT。生产域名为 `kmxt.moluhualuo.top`，项目与 `/root/new-api` 完全隔离。

## 拓扑

```text
Internet -> Nginx :443 -> 127.0.0.1:8082 -> KMXT app 172.28.52.10
                                           -> external MySQL 8 (TLS)
                                           -> dedicated Redis Cloud
```

仓库的 `deploy/compose.yaml` 使用固定 `172.28.52.0/24` 网络；应用只发布宿主机回环端口。Node 只信任网关 `172.28.52.1/32` 传入的 `X-Forwarded-For`。Nginx 的 `cloudflare-realip.conf` 仅接受 Cloudflare 官方网段发送的 `CF-Connecting-IP`，再把真实访客地址覆盖写入转发头；因此 Redis 限流按真实客户端而不是 Cloudflare 边缘地址计数。Compose 内 Redis 位于 `local-redis` profile，仅用于没有独立 Redis 时的离线替代；当前生产使用独立 Redis Cloud，不能指向 `new-api`。

外部 Redis 的持久化、备份和可用性由 Redis Cloud 套餐负责，上线前需确认开启持久化并满足 Nonce 保留窗口；若切换到 `local-redis` profile，则镜像已启用 AOF `appendfsync everysec`，且 Redis 不发布宿主机端口。

## DNS 与目录

为 `kmxt.moluhualuo.top` 设置到香港机公网 IPv4 的 A 记录。当前域名已开启 Cloudflare 代理；Cloudflare 的 SSL/TLS 加密模式必须使用 `Full (strict)`，确保回源请求以 HTTPS 到达源站 443 端口，不能使用明文 HTTP 回源 443。服务器准备：

```bash
install -d -m 0700 /root/kmxt/deploy/secrets /root/kmxt/backups
cd /root/kmxt
cp deploy/production.env.example deploy/production.env
cp deploy/backup.env.example deploy/backup.env
```

填写 MySQL 主机，但不得把密码写入 env。当前独立 Redis 主机已经写入示例 URL（不含账号密码）；将轮换后的 Redis 密码写入 `deploy/secrets/redis_password`。其余文件：

| 文件 | 内容 |
| --- | --- |
| `root_secret` | 32 随机字节的 base64url；用于摘要、私钥和订单字段加密。 |
| `mysql_password` | 新生成的 `kamxt1` 数据库用户密码。 |
| `mysql_ca.pem` | MySQL 服务端证书链的可信 CA。 |
| `redis_password` | 专用 Redis 密码。 |
| `admin_password` | 首个平台管理员强密码，仅初始化读取。 |

`deploy/secrets` 目录设置为 `0700 root:root`。Compose file secrets 会按宿主机文件 uid/gid 挂载，app 镜像内的 `node` 用户 uid 为 `1000`，因此 secret 文件设置为 `chown 1000:1000 deploy/secrets/* && chmod 0400 deploy/secrets/*`。这些文件受 `.gitignore` 排除，禁止进入 Git、镜像、Compose 字面值、日志或文档。根密钥创建后不可更换，否则历史加密字段无法恢复。

## 预检、迁移和启动

```bash
cd /root/kmxt/deploy
sh scripts/preflight.sh
sh scripts/deploy.sh
curl --fail http://127.0.0.1:8082/health
```

预检校验 secret、Compose、镜像构建、MySQL TLS 连接、SQL migration、Redis `PING` 和状态读取。`deploy.sh` 再执行 migration、创建全新平台管理员并启动应用。
由于 app 服务使用固定容器 IP，服务已运行后不要再用 `docker compose run app ...` 做状态查询，否则临时容器会与运行中 app 的固定 IP 冲突；上线后的状态检查使用 `docker compose exec -T app node cli/kmxt.js status`。

## Nginx 与证书

先以只有 80 端口 ACME location 的临时站点启动 Nginx，再签发：

```bash
certbot certonly --webroot -w /var/www/certbot -d kmxt.moluhualuo.top
cp /root/kmxt/deploy/nginx/kmxt.moluhualuo.top.conf /etc/nginx/sites-available/
cp /root/kmxt/deploy/nginx/cloudflare-realip.conf /etc/nginx/conf.d/kmxt-cloudflare-realip.conf
ln -s /etc/nginx/sites-available/kmxt.moluhualuo.top.conf /etc/nginx/sites-enabled/kmxt.moluhualuo.top.conf
nginx -t && systemctl reload nginx
certbot renew --dry-run
```

站点将 HTTP 跳转 HTTPS，并对 API、后台和店铺统一发送 `no-store`。HTTPS 虚拟主机还通过 Nginx 内部状态码 `497` 将误发到 443 端口的明文 HTTP 请求重定向到同域名 HTTPS；这只用于兼容错误客户端或代理，Cloudflare 回源仍必须配置为 `Full (strict)`。该站点对真实客户端实施 `60/min`、突发 `20` 的 Nginx 限流，应用层对客户端激活和验证接口还使用 Redis `30/min` 限流；过载时返回 `429`，不应再把登录拖到 `504`。

验证公网、源站 TLS 与错误协议纠正：

```bash
curl -I https://kmxt.moluhualuo.top/
curl -kI -H 'Host: kmxt.moluhualuo.top' https://127.0.0.1/
curl -I -H 'Host: kmxt.moluhualuo.top' http://127.0.0.1:443/
```

前两项应返回应用的 `302 /admin/`，第三项应返回指向 `https://kmxt.moluhualuo.top/` 的 `301`，不得再出现 `400 The plain HTTP request was sent to HTTPS port`。

## 业务验收

1. 平台管理员登录并创建商户、商户管理员和程序。
2. 程序页下载 Android JSON/头文件，确认 base URL、appId、keyId 与公钥。
3. 创建套餐并从公开店铺下单；后台重复点击发卡，确认两次返回同一 `licenseId`。
4. Android API 24 arm64 设备激活、心跳、切换前后台；重复 Nonce 返回 `REPLAY_DETECTED`。
5. 解绑、禁用卡密和修改密码后，旧客户端/管理会话立即失效。

## 备份、日志与磁盘

每日 UTC 执行 `deploy/scripts/backup.sh`。脚本使用 `--single-transaction`、`VERIFY_IDENTITY` 和 CA 创建一致性压缩备份，同时复制根密钥并生成 SHA-256；保留 7 个日备和约 4 个周备。

```cron
17 3 * * * /bin/sh /root/kmxt/deploy/scripts/backup.sh
```

Compose JSON 日志限制 app 为 `20m × 5`、可选本地 Redis 为 `10m × 3`。备份脚本在磁盘占用达到 85% 时写 syslog warning。

## MySQL 事务锁诊断

KMXT 0.5.2 起在实例内排队写事务，使用 `kmxt_meta` InnoDB 行锁作为跨实例兜底，并按固定状态表顺序读取完整状态，避免托管 MySQL 的跨表 JSON `UNION ALL` 停滞。旧版 0.5.0 使用连接级命名锁 `kmxt_state_transaction`；升级排障或出现登录、激活、验证接口超时时，可运行只读诊断脚本，不要直接清理数据库连接：

```bash
docker exec -i deploy-app-1 node --input-type=module < /root/kmxt/deploy/scripts/diagnose-lock.mjs
```

脚本输出旧命名锁的锁主连接 ID、同库连接状态、可读取的 user-level lock 元数据，以及各状态表的行数、payload 体积和统计查询耗时；它不输出连接密码，也不主动释放锁。0.5.2 正常运行时 `lockOwnerConnectionId` 应为 `null`。若仍有锁主，说明旧实例或旧连接尚未退出；仅在确认锁主属于已故障的 KMXT 实例后，才可通过重启该实例关闭连接并释放命名锁。

0.5.2 发布后执行登录检查，并确认响应在 Nginx 30 秒上游超时以内：

```bash
time sh /root/kmxt/deploy/scripts/check-login.sh
time sh /root/kmxt/deploy/scripts/check-public-login.sh
docker inspect deploy-app-1 --format '{{.Config.Image}} {{.State.Health.Status}}'
```

`check-login.sh` 通过本机回源验证 Nginx 与应用，`check-public-login.sh` 直接经过 Cloudflare 验证公网链路。两者只输出登录结果与角色，不输出密码或会话令牌；公网检查还通过标准输入传递请求体，避免密码出现在进程参数中。

### MySQL 临时故障降级

KMXT 会将外部 MySQL 的连接丢失、连接/协议超时与超过 8 秒的存储操作降级为 `503 STORAGE_UNAVAILABLE`，带 `Retry-After: 2`；不会让请求一直挂起到 Nginx 的 30 秒 `504`。连接池默认仅保留 1 条空闲连接并在 60 秒后轮换。可通过 `KMXT_MYSQL_MAX_IDLE`、`KMXT_MYSQL_IDLE_TIMEOUT_MS` 和 `KMXT_MYSQL_OPERATION_TIMEOUT_MS` 调整，后者必须小于 Nginx 的 `proxy_read_timeout`。

发生 503 时先重试一次；若持续出现，执行只读锁诊断，并记录 `docker logs --timestamps --tail=200 deploy-app-1` 中的 `KMXT MySQL temporary failure` 代码。不要把 Nginx 超时调大，也不要手动杀 MySQL 连接；确认外部 MySQL 的网络、TLS CA、服务状态和连接配额后再恢复。

管理员密码重置必须通过已认证的 `/api/v1/auth/password` 流程执行，随后同步更新 `deploy/secrets/admin_password` 并保留 `0400`、`node` 用户可读的权限。`deploy/reset-kmxt-platform-admin-password.mjs` 是容器内的通用脚本：新密码只通过一次性 `KMXT_NEW_PASSWORD` 环境变量提供，脚本不输出密码或登录令牌，并会用新密码再登录一次验证。

## 恢复

1. `docker compose stop app`，校验 `sha256sum -c SHA256SUMS`。
2. 恢复原 `root_secret`，建立空 `kamxt1`，通过 TLS 导入 `kamxt1.sql.gz`。
3. 执行 `docker compose run --rm app node cli/kmxt.js migrate` 和 `status`。
4. 启动 app，完成健康、登录、店铺、既有卡密激活与心跳检查。

没有原根密钥时不得启动写流量：程序私钥、订单联系方式、已交付卡密和所有摘要用途都依赖它。

## 本地 MySQL 迁移

生产 Compose 内置 `mysql:8.4`，地址为私有网络中的 `172.28.52.30:3306`，不发布任何宿主机端口。数据保存在 `mysql-data` 命名卷；应用在数据库健康检查通过后才启动。`mysql_local_password` 是应用账号密码，`mysql_local_root_password` 只用于初始化和健康检查，两者都必须是 `deploy/secrets` 下的独立随机 secret，禁止写入 env、Compose 日志或文档。

本地连接配置为 `KMXT_MYSQL_HOST=mysql`、`KMXT_MYSQL_PORT=3306`、`KMXT_MYSQL_USER=kmxt`、`KMXT_MYSQL_DATABASE=kamxt1`、`KMXT_MYSQL_TLS_MODE=disabled`。禁用 TLS 只允许用于未暴露端口的私有 Compose 网络；切回外部 MySQL 时必须恢复 `KMXT_MYSQL_TLS_MODE=verify_identity` 和可信 CA 文件。

从紧急状态快照迁移时必须先停止 app、校验快照与根密钥校验和，并确认目标库为空：

```bash
docker compose up -d mysql
docker compose run --rm --no-deps -T \
  -v /root/kmxt/backups/emergency/20260716T151313Z:/import:ro \
  app node cli/import-state-json.js /import/state.json.gz
docker compose up -d app
```

`import-state-json.js` 接受 UTF-8 `.json` 或 `.json.gz`，兼容裸状态对象及 `{ exportedAt, schemaVersion, meta, state }` 紧急导出封装，校验 schema 和全部状态集合，目标任一业务表非空时拒绝执行，并在一个 `MysqlStore` 事务中导入。输出只包含各集合计数，不输出账号、卡密、会话、密钥或 payload。

每日备份脚本改为在 MySQL 容器内运行 `mysqldump --no-tablespaces`，应用账号无需全局 `PROCESS` 权限；脚本先在宿主机生成非空 SQL，成功后再 gzip，并执行 `gzip -t` 和 SHA-256。这样缺少导出程序或导出失败时脚本会直接失败，不会再生成可通过表面校验的空 gzip 文件。
