# MySQL 与 Redis 存储

作者：花落；协议：MIT。本文对应 KMXT 0.5.2。

## 存储契约

所有服务只依赖 `read(selector)` 与 `transaction(mutator)`。JSON 适配器用于本地开发和兼容测试；`KMXT_STORAGE_DRIVER=mysql` 选择 MySQL 8 生产适配器。两者使用相同状态结构，因此租户隔离、设备上限、密码撤销、订单幂等发卡等业务规则不会分叉。

同一 KMXT 实例内的写事务先进入 FIFO Promise 队列，再从连接池获取连接；因此突发请求不会让多条 MySQL 会话同时等待同一行锁。事务通过 `SELECT ... FOR UPDATE` 锁定 `kmxt_meta` 单例行，作为跨实例的兜底串行化机制。该 InnoDB 行锁会在提交、回滚或连接断开时由数据库自动释放，不使用可能残留在连接池会话上的 `GET_LOCK` 命名锁。发卡、密码变更、会话撤销和设备绑定均在同一事务提交；错误会回滚。

状态读取先读取并按需锁定 `kmxt_meta`，再按固定表顺序读取各状态表的 `id` 与 JSON payload。该顺序读取避免部分托管 MySQL 对跨多表 JSON payload `UNION ALL` 查询出现的停滞；每条查询仍受应用级期限保护。持久化阶段比较事务前后的 JSON payload，仅对新增或变化记录执行 `UPSERT`，删除仍按外键逆序执行。未变化的用户、卡密、审计日志和验证日志不会在每次请求中重复写入，从而避免远程 MySQL 往返次数随历史日志总量线性增长。当前设计仍以单服务实例为生产边界，不承诺多实例吞吐。

## 表与约束

`migrations/001_initial.sql` 创建 `users`、`admin_sessions`、`merchants`、`applications`、`products`、`orders`、`license_batches`、`licenses`、`device_bindings`、`client_sessions`、`audit_logs`、`verification_logs`。主键均为 `CHAR(36)` UUID，时间为 UTC `DATETIME(3)`，引擎为 InnoDB，字符集为 `utf8mb4`。

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

生产连接池默认最多保留 1 条空闲连接（`KMXT_MYSQL_MAX_IDLE=1`），空闲 60 秒后关闭（`KMXT_MYSQL_IDLE_TIMEOUT_MS=60000`），避免长期空闲的外部 MySQL TLS 会话被服务端回收后仍被复用。获取连接、开始/提交/回滚事务、查询与预编译语句都受 `KMXT_MYSQL_OPERATION_TIMEOUT_MS`（默认 8000 毫秒）限制；检测到连接丢失、协议超时或该期限到达时，适配器会销毁该连接，不把它释放回池中，并返回 `503 STORAGE_UNAVAILABLE` 和 `Retry-After: 2`，而不是等待 Nginx 的 504。写事务不会在网络不确定时自动重放，以避免未知提交结果造成重复发卡或重复状态变更。

生产模式必须设置独立 `KMXT_REDIS_URL` 和 `KMXT_REDIS_PASSWORD_FILE`。Nonce 使用 `SET key 1 NX PX ttl`；限流用 Lua 在一个原子操作内执行 `INCR`、首次 `EXPIRE` 和 `TTL`。Redis 不保存卡密、会话明文或设备原文。

## 集成验收

普通 `npm test` 覆盖共享契约、事务业务回归、Nonce、限流和可信代理。真实基础设施测试默认跳过，以免误写生产；使用数据库名必须以 `_test` 结尾的空库和临时 Redis 前缀显式运行：

```bash
KMXT_RUN_MYSQL_INTEGRATION=1 KMXT_RUN_REDIS_INTEGRATION=1 npm test
```

密码与 CA 仍通过上述只读文件变量提供。MySQL 用例连续运行 migration 两次并验证回滚；Redis 用例验证重复 Nonce 与计数跨适配器保存。

`test/mysql-store.test.js` 还覆盖连接丢失和查询无响应两种场景：前者必须销毁故障连接并返回可重试 503，后者必须在应用级期限内结束，不得交由反向代理超时。

## MySQL TLS 模式与状态导入

`KMXT_MYSQL_TLS_MODE` 仅接受 `verify_identity` 或 `disabled`，默认值为 `verify_identity`。验证模式要求 `KMXT_MYSQL_TLS_CA_FILE` 非空，启用 TLS 1.2 以上并验证证书链；`disabled` 不读取 CA，只能用于 Compose 私有桥接网络中未映射宿主机端口的本地 MySQL。公共网络、跨主机网络和托管数据库不得使用 `disabled`。

`cli/import-state-json.js` 是一次性迁移模块。它支持裸状态对象和将集合放在 `state` 字段内的紧急导出封装，先运行 schema migration，再通过 `MysqlStore` 读取目标集合计数；只有全部业务集合为空才允许导入。展开后的源状态必须通过 `assertStateShape`，导入在数据库事务中完成，最后重新读取并逐集合核对行数。脚本不负责合并、覆盖或清理已有数据，避免错误目标造成静默覆盖。

本地 MySQL 的持久数据位于 Compose `mysql-data` 卷。日常 SQL 备份由 `deploy/scripts/backup.sh` 调用容器内 `mysqldump --no-tablespaces` 生成，因此应用账号不需要全局 `PROCESS` 权限。备份仍必须和同一时点的 `root_secret` 一起保管；只有 SQL 没有原根密钥时，加密字段无法恢复。
