# 香港机部署与恢复

作者：花落；协议：MIT。生产域名为 `kmxt.moluhualuo.top`，项目与 `/root/new-api` 完全隔离。

## 拓扑

```text
Internet -> Nginx :443 -> 127.0.0.1:8082 -> KMXT app 172.28.52.10
                                           -> external MySQL 8 (TLS)
                                           -> dedicated Redis Cloud
```

仓库的 `deploy/compose.yaml` 使用固定 `172.28.52.0/24` 网络；应用只发布宿主机回环端口。Node 只信任网关 `172.28.52.1/32` 传入的 `X-Forwarded-For`，Nginx 会覆盖而不是追加客户端提供的头。Compose 内 Redis 位于 `local-redis` profile，仅用于没有独立 Redis 时的离线替代；当前生产使用独立 Redis Cloud，不能指向 `new-api`。

外部 Redis 的持久化、备份和可用性由 Redis Cloud 套餐负责，上线前需确认开启持久化，并允许 Nonce 键至少保留 `2 * KMXT_CLOCK_SKEW_SECONDS + 1` 秒；若切换到 `local-redis` profile，则镜像已启用 AOF `appendfsync everysec`，且 Redis 不发布宿主机端口。

## DNS 与目录

为 `kmxt.moluhualuo.top` 设置到香港机公网 IPv4 的 A 记录，保持 DNS only，不开启 Cloudflare 代理。服务器准备：

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
curl --fail http://127.0.0.1:8082/ready
```

应用收到 `SIGTERM` 时会先停止接收新请求、等待进行中的请求完成，再关闭 MySQL/Redis；Compose 的 `stop_grace_period` 为 30 秒，避免进程被强制终止后留下半关闭连接池。
MySQL 连接池默认最多排队 100 个请求，获取连接和单次 SQL 操作默认 8 秒超时；存储不可用时 API 返回 `503 STORAGE_UNAVAILABLE`，不会再让请求无限等待。`/ready` 会同步返回 `503`，但普通 Docker Compose 不会仅因容器变为 `unhealthy` 自动重启，生产环境仍需外部 supervisor/watchdog 处理持续不可用实例。

预检校验 secret、Compose、镜像构建、MySQL TLS 连接、SQL migration、Redis `PING` 和状态读取。`deploy.sh` 再执行 migration、创建全新平台管理员并启动应用。
由于 app 服务使用固定容器 IP，服务已运行后不要再用 `docker compose run app ...` 做状态查询，否则临时容器会与运行中 app 的固定 IP 冲突；上线后的状态检查使用 `docker compose exec -T app node cli/kmxt.js status`。

## ScreenYolo 兼容性门禁

新版本 ScreenYolo AAR 要求 `activate`、`verify` 和 `unbind` 的成功签名 payload 都回显本次请求的 `requestNonce`。必须先把包含该协议的 KMXT 服务部署到生产，再分发 APK；旧服务返回的成功 envelope 会被 native validator fail-closed 拒绝。部署后在服务器和外部入口分别检查：

```bash
curl --fail https://kmxt.moluhualuo.top/health
curl --fail https://kmxt.moluhualuo.top/ready
```

然后用受控测试卡密完成一次激活、心跳和解绑，确认三份成功 payload 的 `requestNonce` 与请求 nonce 完全一致，并保存不含卡密/令牌的审计结果。服务未通过该门禁时，禁止把 ScreenYolo 的新 Release APK 标记为可分发。作者：花落 / MIT。

## Nginx 与证书

先以只有 80 端口 ACME location 的临时站点启动 Nginx，再签发：

```bash
certbot certonly --webroot -w /var/www/certbot -d kmxt.moluhualuo.top
cp /root/kmxt/deploy/nginx/kmxt.moluhualuo.top.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/kmxt.moluhualuo.top.conf /etc/nginx/sites-enabled/kmxt.moluhualuo.top.conf
nginx -t && systemctl reload nginx
certbot renew --dry-run
```

站点将 HTTP 跳转 HTTPS，并对 API、后台和店铺统一发送 `no-store`。

## 业务验收

## 模型交付部署

新增配置：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `KMXT_MODEL_LEASE_TTL_SECONDS` | `600` | 正常模型租约秒数，最小 60。 |
| `KMXT_MODEL_LEASE_MAX_TTL_SECONDS` | `900` | 服务端允许的租约上限，必须不小于正常 TTL。 |
| `KMXT_MODEL_ARTIFACT_MAX_BYTES` | `2147483648` | 登记 artifact 的最大密文字节数。 |

上线顺序为：备份 MySQL/根密钥 -> 执行 `004_model_delivery.sql` -> 部署
0.7.0 服务 -> 选择发布路径 -> 校验 `.vmp` SHA-256 后再激活。大型模型推荐在受控
发布机运行 `cli/publish-model-artifact.js`，本地加密后仅登记元数据与 DEK；密文可随
APK/AAB 分发，或上传到私有写入、HTTPS 只读的对象存储/CDN。管理后台也可逐个上传
明文模型，由 Node 在内存中加密、登记 draft，并把 `.vmp` 作为 Base64 响应交给浏览器下载。

生产必须使用 MySQL + Redis；Redis URL 应使用 `rediss://` 或处于受保护私网，
因为 Nonce/限流状态决定租约重放边界。使用管理后台上传时，Nginx
`client_max_body_size`、代理超时和并发上限必须按可用内存设置；该路径会同时持有明文、
密文与 Base64 响应，生产大文件应改用本地发布 CLI。KMXT 不持久化模型字节，也不把
CDN 写凭据放入数据库。对象 URL 若包含短时查询签名，其寿命不得短于模型租约，且日志不得
记录完整查询串。根密钥应迁入 secret manager/KMS；丢失根密钥会使历史 artifact
DEK 无法解密，轮换必须采用版本化双读迁移。

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

## 恢复

恢复只允许写入新建的空数据库；脚本不会删除或覆盖已有数据库。先选定一个已知备份目录：

```bash
cd /root/kmxt/deploy
BACKUP=/root/kmxt/backups/daily/<UTC 时间戳>
docker compose stop app
(cd "$BACKUP" && sha256sum -c SHA256SUMS)
install -o 1000 -g 1000 -m 0400 "$BACKUP/root_secret" secrets/root_secret
# 由数据库管理员建立空的 kamxt1 后执行：
sh scripts/restore.sh "$BACKUP" --confirm-restore
docker compose run --rm app node cli/kmxt.js migrate
docker compose run --rm app node cli/kmxt.js status
docker compose up -d app
```

`restore.sh` 会再次验证校验和与根密钥，要求 app 已停止，并在导入前查询目标库表数量；任何前置条件不满足都会退出。导入后完成健康、登录、店铺、既有卡密激活与心跳检查。

没有原根密钥时不得启动写流量：程序私钥、订单联系方式、已交付卡密和所有摘要用途都依赖它。

## 2026-07-17 online database config sync

Author: hualuo. License: MIT. The current online KMXT database is MySQL 8.4 inside the same Docker Compose private network, not an external public MySQL endpoint. `deploy/compose.yaml` now includes the `mysql` service. The app connects with `KMXT_MYSQL_HOST=mysql`, `KMXT_MYSQL_PORT=3306`, `KMXT_MYSQL_USER=kmxt`, and database `kamxt1`.

MySQL exposes only container-internal `3306/tcp`. The host does not publish `0.0.0.0:3306`, so the database is not open to the public Internet. Public traffic only enters through Nginx on 80/443 and the app loopback mapping `127.0.0.1:8082`.

Passwords are injected through Docker secrets. The app reads `/run/secrets/kmxt_mysql_password`; MySQL initialization reads `/run/secrets/mysql_local_password` and `/run/secrets/mysql_local_root_password`. The matching host files are under `deploy/secrets/`. Do not commit these files, print them in logs, or copy their plaintext into documentation. The development project was synchronized from the online `compose.yaml`, `production.env`, and `deploy/secrets`; the pre-sync backup is `deploy/.sync-backup-online-db-config`.
## 2026-07-17 Nginx rate limit adjustment

Author: hualuo. License: MIT. The 429 responses observed on the admin UI were generated by Nginx `limit_req`, not by the KMXT application. The previous global site limit was `rate=60r/m` with `burst=20 nodelay`, applied to static assets and API requests together. A normal admin page load can request multiple SVG, JavaScript, and API resources from the same client IP, so this limit was too strict.

The production limit is now `limit_req_zone $binary_remote_addr zone=kmxt_per_client:10m rate=600r/m;` with `limit_req zone=kmxt_per_client burst=120 nodelay;`. This keeps per-client protection enabled while allowing normal admin UI bursts. If 429 returns again, check `/var/log/nginx/error.log` for `limiting requests` and compare the client IP, path, and excess count before changing application code.
