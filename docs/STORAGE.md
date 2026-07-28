# MySQL 与 Redis 存储

作者：花落；协议：MIT。本文对应 KMXT 0.7.0。

MySQL 的旧 `StateStore` 兼容层已移除连接级 advisory lock：事务使用 `SERIALIZABLE` 隔离级别及表行/范围锁，并仅 upsert 有变化的行。它仅保留为兼容诊断能力；MySQL 运行时的业务服务均使用按领域 Repository，不会整库加载或全量回写。

`MysqlDashboardRepository` 是首个按领域迁移的 Repository：Dashboard 使用参数化 `COUNT` 聚合 SQL，不读取任意 `payload` JSON，也不经过全量 StateStore 加载。

`MysqlOrderRepository` 直接分页读取指定商户订单，并按订单号和查询摘要查询店铺订单。公开下单在同一事务中锁定启用的商户、商品和程序，再保存加密联系信息和查询摘要；拒单锁定订单行并写入原因。人工审核发卡在一个事务内执行 `SELECT ... FOR UPDATE` 锁定订单行，插入 `license_batches.source_id`（唯一）与卡密后再更新订单；重复审核读取已发卡订单，不会重复生成卡密。

`MysqlVerificationRepository` 将激活、心跳和客户端主动解绑迁为定向事务：它锁定程序、商户、卡密、会话与绑定行；每张卡密的激活串行化，因此同设备重复激活可复用绑定，有限设备数可原子判断，`maxDevices=0` 不执行数量限制。客户端主动解绑只有在会话与设备摘要同时匹配时才将绑定改为 `revoked`、删除该绑定全部会话并写入验证日志。

在兼容层与定向 Repository 并存期间，订单发卡、激活和心跳会对 MySQL deadlock/lock-wait 错误进行最多三次的安全重试；不会重试业务校验错误。

`MysqlLicenseRepository` 使用程序/卡密/绑定索引进行批量发卡、分页和设备查询。批量发卡在锁定启用程序与商户的事务中写入批次、卡密摘要及根密钥派生 AES-256-GCM 密文；列表不读取或返回明文。完整卡密查看在锁定卡密的事务中解密、只返回给授权管理员并写入审计；删除会先检查订单关联，再按外键顺序清理会话、验证日志和设备绑定。停用卡密与解绑设备同样在定向事务中撤销客户端会话，所有写操作均写入审计记录。

`MysqlAuthRepository` 使用用户名、用户 ID 和会话摘要的定向查询处理管理员身份。登录在锁定用户与所属商户后创建会话；验证通过会话、用户和商户的连接查询完成。创建账号、密码变更、密码重置和账号停用均在锁定用户的事务内撤销对应管理会话并写入审计记录。首次平台管理员创建锁定 `kmxt_meta` 的单例行来串行化初始化，不使用 MySQL advisory lock。

`MysqlMerchantRepository` 处理商户创建、资料读取与名称编辑。停用商户时锁定商户行、更新状态，并在同一事务中删除所属用户的管理会话和该商户全部客户端会话。

`MysqlApplicationRepository` 处理程序创建、读取、设置编辑和公开配置读取。程序停用时锁定程序与所属商户，更新状态并撤销该程序的客户端会话；程序签名密钥不会在资料编辑中轮换。

`MysqlProductRepository` 处理商品的创建、编辑、启停、列表和公开店铺读取。公开店铺只查询指定启用商户下的启用程序和启用商品，并在服务端按展示排序字段排序，不会加载其他商户的商品状态。

`MysqlAuditRepository` 按商户或程序执行审计与验证日志的分页、事件和时间范围查询，先校验资源所属租户，再使用独立索引列过滤，避免读取无关日志 payload。

`MysqlMaintenanceRepository` 在一个事务中删除过期管理会话、客户端会话、已到期模型租约或超出保留期的验证日志，并写入不含敏感字段的 `maintenance.*` 审计摘要。

`MysqlOnlineDeviceRepository` 使用 `device_bindings.app_id/status`、`client_sessions.binding_id/expires_at` 和程序 payload 中的心跳设置计算在线状态。分页查询只返回设备标签、卡密遮罩、客户端版本、可信来源 IP 与时间字段；设备摘要和会话摘要不会进入响应。强制下线在锁定绑定后删除对应客户端会话，并在实际删除时写入 `device.disconnect` 审计记录。

`MysqlModelDeliveryRepository` 直接处理模型制品登记、列表、终态吊销和模型租约。
登记会锁定启用的商户与程序；租约事务按与心跳一致的顺序锁定目标 artifact、客户端会话、卡密和设备绑定，
不再经过全量 `StateStore`。制品一旦进入 `revoked` 就不能恢复；重复吊销保持幂等。
`MysqlMaintenanceRepository` 复用模型 Repository 的定向删除，在 `cleanup-sessions`
事务中一并删除 `expires_at <= now` 的模型租约。

## 存储契约

JSON 适配器的所有服务仍只依赖 `read(selector)` 与 `transaction(mutator)`，用于本地开发和契约测试。`KMXT_STORAGE_DRIVER=mysql` 选择 MySQL 8 适配器后，全部业务服务使用已注册的领域 Repository；两种实现保持相同的业务输出、租户隔离、设备上限、密码撤销和订单幂等规则。

MySQL 领域事务直接开启 InnoDB 事务并以 `SELECT ... FOR UPDATE` 锁定相关业务行；不会取得 `kmxt_state_transaction` 或其他连接级 advisory lock。遗留兼容事务仍使用 `SERIALIZABLE` 行/范围锁。发卡、密码变更、会话撤销和设备绑定均在同一事务提交，错误会回滚。当前部署边界仍是单 Node 实例，不承诺多实例写入吞吐。

## 表与约束

`migrations/001_initial.sql` 创建 `users`、`admin_sessions`、`merchants`、`applications`、`products`、`orders`、`license_batches`、`licenses`、`device_bindings`、`client_sessions`、`audit_logs`、`verification_logs`。主键均为 `CHAR(36)` UUID，时间为 UTC `DATETIME(3)`，引擎为 InnoDB，字符集为 `utf8mb4`。

`migrations/003_license_key_recovery.sql` 将持久化元数据升级至 schema v4；卡密密文位于既有 `licenses.payload` JSON，因此无需重写表列或明文回填历史数据。

关键唯一约束包括用户名、商户代码、商户内程序代码、订单号、订单查询摘要、订单对应卡密、卡密摘要和会话摘要。外键覆盖租户、程序、商品、批次、卡密与设备关系。业务完整对象保存在 JSON 列，同时用于与 JSON 适配器共享契约；常用过滤字段有独立类型列和索引。

## 初始化

数据库 `kamxt1` 按空库初始化，不导入或双写 `data/kmxt.json`：

```bash
node cli/kmxt.js migrate
node cli/kmxt.js create-admin --username platform-admin --password-file /run/secrets/kmxt_admin_password
```

迁移文件使用 `CREATE TABLE IF NOT EXISTS`，已应用版本登记在 `schema_migrations`。重复运行只会检查并跳过已登记版本。MySQL DDL 会隐式提交，因此新增迁移必须保持单向、幂等，发布前在空库和备份副本各演练一次。

## TLS 与机密

MySQL 密码和 CA 分别由 `KMXT_MYSQL_PASSWORD_FILE`、`KMXT_MYSQL_TLS_CA_FILE` 注入。驱动强制 TLS 1.2 以上并设置 `rejectUnauthorized=true`。密码不得放进 URL、环境示例、Compose 或日志。连接池上限由 `KMXT_MYSQL_POOL_LIMIT` 控制，默认 10。

生产模式必须设置独立 `KMXT_REDIS_URL` 和 `KMXT_REDIS_PASSWORD_FILE`。Nonce 使用 `SET key 1 NX PX ttl`，其中 ReplayGuard 传入的 `ttl` 为 `max(2 * clockSkew + 1000ms, timestamp + clockSkew - now + 1000ms)`；内存实现以同一 TTL 计算绝对到期时间。限流用 Lua 在一个原子操作内执行 `INCR`、首次 `EXPIRE` 和 `TTL`。Redis 不保存卡密、会话明文或设备原文。

## 集成验收

普通 `npm test` 覆盖共享契约、事务业务回归、Nonce、限流和可信代理。真实基础设施测试默认跳过，以免误写生产；使用数据库名必须以 `_test` 结尾的空库和名称中带独立 `test` 段的 Redis 键前缀（例如 `kmxt:test:`）显式运行：

```bash
KMXT_RUN_MYSQL_INTEGRATION=1 KMXT_RUN_REDIS_INTEGRATION=1 npm test
```

密码与 CA 仍通过上述只读文件变量提供。MySQL 用例连续运行 migration 两次并验证回滚；Redis 用例验证重复 Nonce 与计数跨适配器保存。

## MySQL TLS 模式

作者：花落；协议：MIT。外部托管 MySQL 默认使用 `KMXT_MYSQL_TLS_MODE=verify_identity`，并要求 `KMXT_MYSQL_TLS_CA_FILE` 指向可信 CA 文件。部署在同一 Docker Compose 私有网络内的本地 MySQL 使用 `KMXT_MYSQL_TLS_MODE=disabled`，此时连接层不读取 CA 文件，也不会开启 TLS；密码仍必须通过 `KMXT_MYSQL_PASSWORD_FILE` 注入，不能写入 URL、Compose 字面值或日志。

## Current online MySQL topology

## 模型交付表

`migrations/004_model_delivery.sql` 将 schema 提升到 5，并创建：

- `model_artifacts`：程序、名称、版本、格式、状态、密文 SHA-256、大小和 JSON
  清单。JSON 中的 `encryptedDek` 已用根密钥派生 AES-256-GCM 加密；对象存储只
  保存密文模型，MySQL 不保存模型字节。
- `model_leases`：artifact、卡密、设备绑定、客户端公钥指纹、JTI、状态和到期
  时间。它不保存客户端公钥私钥、明文 DEK、会话 token 或设备 ID。

JSON 开发适配器使用同名 `modelArtifacts/modelLeases` 集合并由 schema 4 自动
升级到 5；删除 JSON 卡密时会同步移除关联租约。MySQL 由
`MysqlModelDeliveryRepository` 定向访问两张表，卡密外键删除会级联清理租约；
上线前必须先运行 migration，否则 schema 5 运行时会失败关闭。受控发布 CLI 在 Node
之外加密并只登记元数据；管理后台上传路径会让单个明文文件短暂进入 Node 内存，随后把
加密 `.vmp` 作为响应返回，但两条路径都不会把模型字节写入 JSON/MySQL。生产大文件应
使用本地发布 CLI，并通过 APK/AAB 或 HTTPS 对象存储/CDN 分发，避免浏览器上传的内存开销。

Author: hualuo. License: MIT. Production MySQL runs inside the KMXT Docker Compose private network. The app container connects to `mysql:3306` with `KMXT_MYSQL_TLS_MODE=disabled` because the link stays inside the Compose bridge network.

The host does not publish port 3306. External machines cannot connect to the database directly. For maintenance, log in over SSH and run `docker compose exec -T mysql mysql ...`, or create an explicit temporary SSH tunnel and close it after use.

Online passwords are stored only as secret files, not plaintext environment variables, URLs, Compose literals, logs, or documentation. Synchronizing these files into the development environment is only for reproducing the online deployment layout; it does not mean production MySQL should be reachable from the public network.

## 2026-07-17 MySQL 8.4 prepared pagination fix

Author: hualuo. License: MIT. After switching production to MySQL 8.4 inside Docker Compose, several admin list endpoints returned 500 with `ER_WRONG_ARGUMENTS: Incorrect arguments to mysqld_stmt_execute`. The failing SQL used prepared placeholders for `LIMIT ? OFFSET ?`. The MySQL repositories now coerce pagination values to safe integers and inline only those integers in the SQL limit clause, while keeping all tenant, filter, and identity values parameterized.

The dashboard repository also separates application-table scope from app-owned table scope. When filtering by a specific application, `applications` is counted with `WHERE id = ?`, while `licenses`, `orders`, `device_bindings`, and `verification_logs` use their `app_id` columns. This prevents dashboard 500 errors caused by querying `applications.app_id`, which does not exist.
