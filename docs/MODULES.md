# 模块说明

本文对应 KMXT `0.5.2`。作者花落，项目按 MIT 协议发布。

## 架构与依赖方向

```text
HTTP / CLI
    -> Services
        -> Security
        -> Storage
    -> Core validation and errors
```

HTTP 层只负责协议、认证入口和参数转发；业务判断集中在服务层；持久化层不知道 HTTP；程序客户端只信任签名公钥，不持有服务端机密。

## 根目录模块

| 文件 | 职责 |
| --- | --- |
| `package.json` | Node.js 版本要求、启动、检查和测试命令；生产依赖为 `mysql2` 与 `redis`。 |
| `.env.example` | 所有可配置环境变量示例。程序不会自动加载该文件。 |
| `LICENSE` | MIT 协议及作者花落。 |
| `cli/kmxt.js` | 初始化数据、创建首个平台管理员、查看商户/程序/商品/订单/卡密统计及启动服务。 |
| `scripts/ui-smoke.ps1` | 通过 Chrome DevTools Protocol 登录后台，在指定设备尺寸检测横向溢出并生成截图。 |
| `scripts/test-native.ps1` | 使用本机 MSYS2 G++ 严格编译 C++17 静态核心并运行密码学固定向量。 |

## 核心与配置

| 模块 | 职责 |
| --- | --- |
| `src/config.js` | 读取监听地址、数据文件、会话时长、时钟窗口和批量上限。路径统一解析为绝对路径。 |
| `src/core/app-error.js` | 定义带业务代码和 HTTP 状态的统一错误类型。 |
| `src/core/validation.js` | 字符串、整数、枚举、时间及分页参数验证。无效输入在进入服务逻辑前被拒绝。 |

## 安全模块

| 模块 | 职责 |
| --- | --- |
| `src/security/crypto.js` | 创建根密钥、scrypt 密码哈希、HMAC 摘要、卡密生成、AES-256-GCM 私钥加密、JSON 规范化和 Ed25519 签名。 |
| `src/security/replay-guard.js` | 校验毫秒时间戳和一次性 Nonce；生产通过 Redis `SET NX PX` 跨请求原子防重放。 |
| `src/security/security-state.js` | 抽象 Nonce 与限流状态；JSON 开发模式用内存，MySQL 生产模式强制独立 Redis。 |

根密钥默认位于 `data/secret.key`，用于派生不同用途的 HMAC 和加密密钥。卡密、管理令牌、客户端会话和设备标识使用不同的用途标签，避免同一摘要跨域复用。

## 持久化模块

| 模块 | 职责 |
| --- | --- |
| `src/storage/schema.js` | 定义当前数据结构版本和全部集合，并在读写时检查结构。 |
| `src/storage/json-store.js` | 将事务串行化，使用内存副本修改并通过临时文件替换实现原子写入。 |
| `src/storage/store.js` | `initialize/read/transaction/close` 存储契约，业务服务不感知适配器。 |
| `src/storage/mysql-store.js` | MySQL 8 适配器；以实例内 FIFO 队列和 `kmxt_meta` InnoDB 行锁串行写事务，按固定表顺序读取状态并仅持久化新增、变化或删除的记录。空闲连接会轮换，连接丢失或 8 秒存储超时会销毁故障连接并返回可重试的 503。 |
| `src/storage/migrate.js` | 按文件名顺序执行 `migrations/` 中尚未登记的版本化 SQL。 |
| `src/storage/secret-file.js` | 从只读文件读取 MySQL、Redis 机密和 TLS CA，拒绝空值。 |

数据集合：

| 集合 | 内容 |
| --- | --- |
| `users` | 平台与商户账号，只保存 scrypt 密码结果。 |
| `adminSessions` | 管理 Bearer 会话，只保存令牌摘要。 |
| `merchants` | 商户资料和启停状态。 |
| `applications` | 商户程序、默认授权策略、公钥及加密私钥。 |
| `products` | 公开店铺套餐、展示价格、授权天数、设备上限和状态。 |
| `orders` | 人工审核订单、商品快照、加密联系方式、查询码摘要及加密交付卡密。 |
| `licenseBatches` | 卡密生成批次和批次参数。 |
| `licenses` | 卡密摘要、生命周期、有效期及设备上限。 |
| `deviceBindings` | 设备摘要、显示标签及绑定状态。 |
| `clientSessions` | 激活后产生的短期验证会话摘要。 |
| `auditLogs` | 管理端操作记录。 |
| `verificationLogs` | 成功激活和心跳记录，不保存卡密或设备原文。 |

## 服务模块

| 模块 | 职责 |
| --- | --- |
| `src/services/access-control.js` | 角色定义、租户访问断言，以及商户、程序、卡密和绑定查找。 |
| `src/services/presenters.js` | 将内部记录转换为安全输出，去除密码、摘要和加密私钥。 |
| `src/services/audit-service.js` | 在业务事务内写入审计记录，按商户查询审计，按程序查询验证日志。 |
| `src/services/auth-service.js` | 创建首个平台管理员、登录、会话校验、退出、自助改密、商户账号密码重置及会话撤销。 |
| `src/services/merchant-service.js` | 平台创建、查询、启用和禁用商户。禁用会撤销该商户所有会话。 |
| `src/services/application-service.js` | 创建及管理程序；为每个程序生成独立 Ed25519 密钥，并提供公开客户端配置。 |
| `src/services/license-service.js` | 批量生成卡密、分页查询、启停卡密、设备列表及解绑。 |
| `src/services/product-service.js` | 商户程序商品管理及公开店铺商品读取。 |
| `src/services/order-service.js` | 公开下单、查询码校验、订单列表、拒绝和幂等人工发卡。 |
| `src/services/verification-service.js` | 首次激活、有效期计算、设备绑定、短期会话、心跳续期和签名响应。 |

## HTTP 模块

| 模块 | 职责 |
| --- | --- |
| `src/http/rate-limiter.js` | 按来源地址和路由执行固定窗口限流；生产计数由 Redis Lua 原子更新。 |
| `src/http/client-ip.js` | 只在直连地址命中可信代理 CIDR 时解析 `X-Forwarded-For`。 |
| `src/http/router.js` | 路由匹配、JSON 读取、请求体上限、Bearer 认证、安全响应头和错误封装。 |
| `src/http/routes.js` | 声明全部 API、所需角色和限流策略。 |
| `src/http/static-server.js` | 在 `/admin/` 下安全提供管理后台资源，限制路径穿越并设置 CSP 和缓存策略。 |
| `src/app.js` | 组装配置、密钥、存储、服务、路由和 HTTP Server，供测试与 CLI 复用。 |
| `src/server.js` | 生产启动入口和关闭信号处理。 |

## 客户端模块

`sdk/node/license-client.js` 负责生成时间戳和 Nonce、请求激活与心跳、固定 `appId + keyId + publicKey`，并在返回授权结果前验证 Ed25519 签名及到期时间。服务端返回 HTTP 200 不代表授权有效，客户端必须以通过签名校验后的 `payload.licensed` 为准。

`sdk/android/kmxt-sdk` 是 API 24、`arm64-v8a` 首版 Android 库。Kotlin/OkHttp 负责协程网络，Android Keystore 保存会话；JNI 后的 C++17 静态核心使用 OpenSSL Ed25519、SHA-256 与 nlohmann/json 规范化数据。`KmxtLifecycleVerifier` 在前台恢复时立即在线验证并按服务端签名心跳间隔继续验证。

## 管理后台模块

| 模块 | 职责 |
| --- | --- |
| `public/index.html` | 后台入口、语义结构、加载状态和无障碍跳转链接。 |
| `public/styles.css` | 数据密集型后台设计系统、响应式布局、状态颜色、对话框及减少动画规则。 |
| `public/js/api.js` | Bearer 会话、统一 API 请求、网络错误及未授权事件。令牌只保存在 `sessionStorage`。 |
| `public/js/state.js` | 当前用户、商户、程序、页面、筛选和分页状态。 |
| `public/js/components.js` | HTML 转义、图标、状态、分页、提示、对话框、确认和文件导出组件。 |
| `public/js/app.js` | 登录、改密、总览、商户、程序、卡密、设备、账号密码重置和日志视图及事件编排。 |
| `public/store.html` | `/store/:merchantCode` 用户店铺入口。 |
| `public/store.css` | 套餐、订单提交、查询和卡密交付的响应式样式。 |
| `public/js/store.js` | 公开商品加载、提交订单、本机凭证、订单查询和卡密复制。 |
| `public/assets/brand.svg` | KMXT 品牌图形，用于浏览器图标、登录页和侧栏。 |
| `public/assets/icons.svg` | 本地 Lucide 图标精灵，许可说明见 `public/assets/ATTRIBUTION.md`。 |

## 状态变化

卡密状态：

```text
pending -> active -> expired
   |          |
   +----------+-> disabled -> pending/active
```

按天卡密在首次成功激活时计算 `expiresAt`；固定日期卡密从创建时就带有到期时间。禁用卡密会立即移除该卡密的全部客户端会话。

设备状态：

```text
active -> revoked
```

解绑不会删除历史记录。相同设备再次激活时会建立新绑定，便于审计。

订单状态：

```text
pending -> fulfilled
       \-> rejected
```

发卡操作在同一事务中创建卡密和更新订单；已完成订单再次调用发卡接口只返回原结果，不会生成第二张卡。

## 本地数据库迁移模块

| 模块 | 职责 |
| --- | --- |
| `src/config.js` | 解析 `KMXT_MYSQL_TLS_MODE`；默认验证外部 MySQL 身份，仅允许显式选择私有网络无 TLS。 |
| `src/storage/migrate.js` | 根据 TLS 模式构造 MySQL 连接；验证模式读取 CA，禁用模式不加载 CA。 |
| `cli/import-state-json.js` | 解压裸状态或紧急导出封装并验证快照，拒绝非空目标，通过单个存储事务导入并复核集合计数。 |
| `deploy/compose.yaml` | 编排本地 MySQL 8.4、健康检查、应用依赖、两个密码 secret 和持久数据卷。 |
| `deploy/scripts/backup.sh` | 在数据库容器内执行 SQL 导出，检查非空、gzip 完整性和 SHA-256，执行日备与周备保留。 |

这些模块由花落维护并按 MIT 协议发布。迁移工具是离线管理入口，不新增 HTTP API，也不会改变现有 `/api/v1` 契约。
