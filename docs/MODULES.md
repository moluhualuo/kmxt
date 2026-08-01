# 模块说明

本文对应 KMXT `0.7.3`。作者花落，项目按 MIT 协议发布。

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
| `cli/kmxt.js` | 初始化数据、创建首个平台管理员、查看商户/程序/商品/订单/卡密统计及启动服务；管理员初始化优先通过 `--password-file` 读取受限 secret，避免密码进入进程参数和 Shell 历史。 |
| `cli/publish-model-artifact.js` | 模型发布命令入口；从环境变量或受限 token 文件读取管理员令牌，不接受会进入 shell 历史和进程参数的明文 token 参数。 |
| `src/tools/model-artifact-publisher.js` | 流式 AES-256-GCM 加密模型，计算明文/密文 SHA-256，调用管理员 API 登记密文元数据；成功后清零 DEK，登记失败时清理不可用密文和清单。 |
| `scripts/ui-smoke.ps1` | 通过 Chrome DevTools Protocol 登录后台，在指定设备尺寸检测横向溢出并生成截图。 |
| `scripts/check-utf8.mjs` | `npm run check` 调用的 UTF-8 无 BOM 守卫；检查 Web、服务端、测试、文档与部署文本资产。 |
| `deploy/scripts/restore.sh` | 仅在应用已停止、根密钥匹配、校验和有效且目标数据库为空时，通过 TLS 导入已验证备份；必须显式确认，不会删除或覆盖数据库。 |
| `sdk/android/demo-app` | Android SDK 本地接入示例，演示卡密激活、会话验证和清除会话；不参与线上部署。 |
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
| `src/services/model-delivery-service.js` | 在启用程序上登记不可变加密模型清单；严格校验 AES-256-GCM 元数据并加密保存每 artifact DEK；吊销为不可恢复终态；校验有效卡密会话、到期状态与设备绑定后签发 X25519 客户端公钥绑定的短期 Ed25519 模型租约。 |
| `src/security/replay-guard.js` | 以闭区间校验过去或未来的毫秒时间戳，规范化一次性 Nonce，并计算覆盖完整可接受窗口且带 1 秒边界余量的 TTL。 |
| `src/security/security-state.js` | 抽象 Nonce 与限流状态；JSON 开发模式按毫秒 TTL 存入内存，MySQL 生产模式通过独立 Redis `SET NX PX` 原子消费同一 TTL。 |
| `src/services/dashboard-service.js` | 按角色、商户和程序聚合后台总览数据；24 小时统计只计算已记录的 `activate/verify` 事件，`LICENSE_VALID` 为成功。 |
| `src/services/maintenance-service.js` | 清理过期管理/客户端会话、已到期模型租约和历史验证日志，并生成审计摘要。 |
| `src/storage/repositories/mysql-dashboard-repository.js` | MySQL Dashboard 的定向聚合查询；只读取索引字段和计数，不加载 JSON payload 表，并与 JSON 路径使用相同验证事件语义。 |
| `src/storage/repositories/mysql-order-repository.js` | MySQL 公开下单、订单查询、拒单与审核发卡；写操作锁定相关资源，审核时使用 `source_id` 唯一约束保护幂等性。 |
| `src/storage/repositories/mysql-verification-repository.js` | MySQL 激活、心跳与客户端主动解绑；锁定程序、商户、卡密、绑定和会话的相关行，原子处理设备上限、会话续期及自助解绑释放名额。 |
| `src/storage/repositories/mysql-license-repository.js` | MySQL 卡密批量生成、查询、批次、设备绑定、完整卡密查看和删除；批量发卡写入摘要与加密密文，敏感查看和删除均在资源锁定事务中写审计，删除会清理会话、验证记录和设备绑定。 |
| `src/storage/repositories/mysql-auth-repository.js` | MySQL 管理员账号与会话查询；登录、账号创建、改密、重置密码、角色调整和账号停用在定向事务中锁定用户并撤销对应管理会话。 |
| `src/storage/repositories/mysql-merchant-repository.js` | MySQL 商户创建、资料和状态管理；停用商户时在同一事务中撤销所属管理会话和客户端会话。 |
| `src/storage/repositories/mysql-application-repository.js` | MySQL 程序创建、设置、公开配置和状态管理；停用程序时锁定资源并撤销客户端会话，不轮换签名密钥。 |
| `src/storage/repositories/mysql-product-repository.js` | MySQL 商品创建、编辑、启停、列表和公开店铺读取；店铺查询只返回启用商户、程序和商品。 |
| `src/storage/repositories/mysql-audit-repository.js` | MySQL 审计和验证日志的租户范围、事件、时间和分页查询。 |
| `src/storage/repositories/mysql-maintenance-repository.js` | MySQL 过期管理/客户端会话、模型租约和验证日志清理；删除与无敏感数据的审计摘要在同一事务完成。 |
| `src/storage/repositories/mysql-online-device-repository.js` | MySQL 在线设备分页、状态/关键词筛选、在线统计和强制下线；使用程序、绑定、会话索引与 JSON 安全展示字段，不读取或返回设备摘要。 |
| `src/storage/repositories/mysql-model-delivery-repository.js` | MySQL 模型制品登记、列表、不可恢复吊销、草稿/已吊销制品删除（级联清理其租约）、设备绑定租约和到期租约清理；只锁定模型、程序、卡密、绑定和会话相关行。 |
| `public/js/views/overview.js` | 后台总览视图模块；调用 Dashboard API 并展示权限范围内的实时统计。 |

根密钥默认位于 `data/secret.key`，用于派生不同用途的 HMAC 和加密密钥。卡密、管理令牌、客户端会话和设备标识使用不同的用途标签，避免同一摘要跨域复用。

## 持久化模块

| 模块 | 职责 |
| --- | --- |
| `src/storage/schema.js` | 定义当前 schema v5 数据结构版本和全部集合，并在读写时检查结构及升级旧 JSON 状态。 |
| `src/storage/json-store.js` | 将事务串行化，使用内存副本修改并通过临时文件替换实现原子写入。 |
| `src/storage/store.js` | `initialize/read/transaction/close` 存储契约，业务服务不感知适配器。 |
| `src/storage/mysql-store.js` | MySQL 8 适配器；注册 Dashboard、订单、验证、卡密、账号、商户、程序、商品、模型、日志和维护领域 Repository，兼容事务仅供诊断。 |
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
| `licenses` | 卡密摘要、根密钥派生加密副本、生命周期、有效期及设备上限。 |
| `deviceBindings` | 设备摘要、显示标签、绑定状态、最后客户端版本和服务端解析的最后来源 IP。 |
| `clientSessions` | 激活后产生的短期验证会话摘要、最后心跳、客户端版本和服务端解析的来源 IP。 |
| `auditLogs` | 管理端操作记录。 |
| `verificationLogs` | 成功激活和心跳记录，不保存卡密或设备原文。 |
| `modelArtifacts` | 按程序保存加密模型的不可变清单、密文摘要、对象 URL、状态和根密钥加密 DEK；不保存模型字节。 |
| `modelLeases` | 保存制品、卡密、设备绑定、客户端公钥指纹、状态和租约时间；不保存 DEK 明文，`cleanup-sessions` 删除已到期记录。 |

## 服务模块

| 模块 | 职责 |
| --- | --- |
| `src/services/access-control.js` | 角色定义、租户访问断言，以及商户、程序、卡密和绑定查找。 |
| `src/services/presenters.js` | 将内部记录转换为安全输出，去除密码、摘要和加密私钥。 |
| `src/services/audit-service.js` | 在业务事务内写入审计记录，按商户查询审计，按程序查询验证日志。 |
| `src/services/auth-service.js` | 创建首个平台管理员、登录、会话校验、退出、自助改密、商户账号密码重置、账号启停、商户账号角色调整（仅 `operator` 与 `merchant_admin`）及会话撤销；MySQL 模式委托账号领域 Repository，JSON 模式保留同一契约。 |
| `src/services/merchant-service.js` | 平台创建、查询、启用和禁用商户。MySQL 模式用定向事务禁用商户并撤销其所有会话。 |
| `src/services/application-service.js` | 创建及管理程序；为每个程序生成独立 Ed25519 密钥，并提供公开客户端配置。MySQL 模式以定向事务更新设置或停用程序，不轮换密钥。 |
| `src/services/client-integrity.js` | 规范化 Android 客户端完整性声明，校验包名、签名证书摘要、安装来源和可选 Play Integrity 字段，并为验证服务提供失败关闭的统一结果。 |
| `src/services/product-service.js` | 管理商品和公开店铺商品读取；MySQL 模式使用商品领域 Repository 保持商户边界与展示排序。 |
| `src/services/license-service.js` | 批量生成卡密、分页查询、启停卡密、完整卡密查看、删除、设备列表、单设备解绑及整卡密解绑全部设备；卡密以摘要校验并以根密钥派生 AES-256-GCM 密文保存，查看与删除均受租户权限和审计保护，JSON 删除会同步清理关联模型租约。 |
| `src/services/online-device-service.js` | 按程序心跳策略计算在线窗口，分页查询在线/离线活动绑定并强制撤销设备会话；JSON 与 MySQL 存储保持相同输出。 |
| `src/services/order-service.js` | 公开下单、查询码校验、订单列表、拒绝和幂等人工发卡；MySQL 模式以定向事务保存加密联系信息、拒单和发卡，并为订单卡密保存订单交付密文与卡密恢复密文。 |
| `src/services/verification-service.js` | 首次激活、有效期计算、设备绑定、短期会话、心跳续期、客户端主动解绑和对应 Ed25519 签名响应；JSON 与 MySQL 路径都会把原请求 nonce 写入已签名 `requestNonce`。 |
| `src/services/maintenance-service.js` | 清理过期管理/客户端会话、已到期模型租约和历史验证日志；MySQL 模式以定向删除事务记录维护审计摘要。 |
| `src/services/model-delivery-service.js` | 登记和展示加密模型制品、状态流转、删除、设备绑定租约签发、X25519/HKDF/AES-GCM DEK 封装，以及 JSON/MySQL 双存储路径。 |

## HTTP 模块

| 模块 | 职责 |
| --- | --- |
| `src/http/rate-limiter.js` | 按来源地址和路由执行固定窗口限流；生产计数由 Redis Lua 原子更新。 |
| `src/http/client-ip.js` | 只在直连地址命中可信代理 CIDR 时解析 `X-Forwarded-For`。 |
| `src/http/router.js` | 路由匹配、JSON 读取、请求体上限、Bearer 认证、安全响应头和错误封装。 |
| `src/http/routes.js` | 声明全部 API、所需角色和限流策略。 |
| `src/routes/admin-artifacts.js` | 解析受认证的单文件 multipart 上传，在 Node 内存中执行 AES-256-GCM 加密、登记 draft artifact，并返回不含 DEK 的 `.vmp` Base64 下载数据。 |
| `src/http/static-server.js` | 在 `/admin/` 下安全提供管理后台资源，限制路径穿越并设置 CSP 和缓存策略。 |
| `src/app.js` | 组装配置、密钥、存储、服务、路由和 HTTP Server，供测试与 CLI 复用。 |
| `src/server.js` | 生产启动入口和关闭信号处理。 |

## 客户端模块

`sdk/node/license-client.js` 负责为每次激活、心跳和主动解绑生成并独立保存时间戳与 Nonce、固定 `appId + keyId + publicKey`；远程 `baseUrl` 必须使用 HTTPS，回环地址只用于本地开发，并拒绝跟随重定向。所有成功响应在 Ed25519 验签后严格比较已签名 `requestNonce`，授权响应继续检查到期时间，解绑响应继续检查 `unbound + DEVICE_UNBOUND`。服务端返回 HTTP 200 本身不代表授权或解绑成功。Node SDK 当前不提供模型租约 API。

`sdk/android/kmxt-sdk` 是 API 24、`arm64-v8a` Android 库。Kotlin/OkHttp 负责协程网络，Android Keystore 保存会话；app-specific JNI 的 C++17 核心固定包名/appId/keyId/Ed25519 trust anchor，使用 native 时钟和待消费 nonce 验证响应，并在 OpenSSL 内完成 X25519/HKDF/AES-GCM。`KmxtLifecycleVerifier` 在前台恢复时立即在线验证并按服务端签名心跳间隔继续验证。作者：花落，MIT。

## 管理后台模块

| 模块 | 职责 |
| --- | --- |
| `public/index.html` | 后台入口、语义结构、加载状态和无障碍跳转链接。 |
| `public/styles.css` | 数据密集型后台设计系统、响应式布局、状态颜色、对话框及减少动画规则。 |
| `public/js/api.js` | Bearer 会话、统一 GET/POST/PATCH/DELETE API 请求、网络错误及未授权事件。令牌只保存在 `sessionStorage`。 |
| `public/js/state.js` | 当前用户、商户、程序、页面、筛选和分页状态；模型制品页在内存中维护当前列表及程序/状态筛选，不把 DEK 或登记表单秘密写入前端持久存储。 |
| `public/js/components.js` | HTML 转义、图标、状态、分页、提示、对话框、确认和文件导出组件。 |
| `public/js/app.js` | 登录、会话初始化、侧栏、程序上下文切换、对话框操作和事件编排；包含模型制品批量选择、逐文件上传/下载、状态操作与完整卡密的受确认展示，页面渲染委托给 `views/`。 |
| `public/js/views/shared.js` | 后台视图共享 API、状态、表格格式化、页面标题和角色判断。 |
| `public/js/views/overview.js` | 权限范围 Dashboard 总览。 |
| `public/js/views/merchants.js` | 平台商户列表与启停入口。 |
| `public/js/views/applications.js` | 程序列表、设置、客户端配置下载入口，以及将该行设为当前程序并进入模型制品页的“模型”快捷按钮。 |
| `public/js/views/model-artifacts.js` | 从后台程序上下文进入的加密模型制品视图；按当前 `appId` 列出和筛选 `draft|active|revoked`，统计各状态数量，并只向拥有者渲染登记与状态切换操作。 |
| `public/js/views/licenses.js` | 卡密列表、筛选、分页、批次和设备入口；仅向拥有者渲染完整卡密查看与删除操作。 |
| `public/js/views/online-devices.js` | 在线设备统计、程序/状态/关键词筛选、分页和强制下线入口；显示卡密遮罩、版本、可信来源 IP 与最后心跳。 |
| `public/js/views/products.js` | 商品列表、状态和公开店铺入口。 |
| `public/js/views/orders.js` | 订单状态、编号、时间筛选和人工发卡入口。 |
| `public/js/views/users.js` | 商户账号、角色调整、密码重置和启停入口。 |
| `public/js/views/logs.js` | 审计/验证日志模式、事件和时间筛选入口。 |
| `public/store.html` | `/store/:merchantCode` 用户店铺入口。 |
| `public/store.css` | 套餐、订单提交、查询和卡密交付的响应式样式。 |
| `public/js/store.js` | 公开商品加载、提交订单、本机凭证、订单查询和卡密复制。 |
| `public/assets/brand.svg` | KMXT 品牌图形，用于浏览器图标、登录页和侧栏。 |
| `public/assets/icons.svg` | 本地 Lucide 图标精灵，许可说明见 `public/assets/ATTRIBUTION.md`。 |

### 模型制品页面协作

模型制品视图位于后台“程序”上下文：侧栏入口沿用当前 `appId`，
程序列表每行的“模型”快捷按钮先切换 `appId` 再进入页面。当前 `appId` 是列表和登记
路由范围，页内程序选择器只能切换到当前账号可访问的程序。页面不自己接受 `merchantId`，商户边界仍由登录会话和
`ModelDeliveryService` 的程序归属校验决定。

```text
程序上下文
    -> model-artifacts.js
        -> GET  /api/v1/apps/:appId/artifacts
        -> POST /api/v1/admin/artifacts/upload         (owner only, one file/request)
        -> POST /api/v1/apps/:appId/artifacts          (owner only)
        -> PATCH /api/v1/artifacts/:artifactId/status  (owner only)
    -> active artifact
        -> POST /api/v1/client/artifacts/:artifactId/lease
```

`platform_admin` 和程序所属商户的 `merchant_admin` 是 owner，可在启用程序上登记制品并在
`draft`、`active`、`revoked` 之间设置状态；`operator` 只能调用列表接口和查看页面。
新登记记录始终为 `draft`，只有 `active` 可被客户端租约模块使用；退回
`draft` 只停止新租约，已签发租约仍有效至自身到期。设为 `revoked` 时停止新租约，
并将该制品现存 active 租约标记为 revoked；后端拒绝从 `revoked` 恢复，重新发布应登记新制品。

后台上传对话框可多选明文模型，但会逐文件调用 `/api/v1/admin/artifacts/upload`；
服务端在内存中生成随机 DEK、加密并登记 draft，浏览器只接收并下载 `.vmp`，不接收 DEK。
受控发布 CLI 也可直接调用 `/api/v1/apps/:appId/artifacts`，提交名称、版本、格式、edition、
密文 SHA-256、密文字节数、`AES-256-GCM` nonce/tag、可选 chunkSize、`contentKey` 和
keyVersion；这些秘密只存在于当次 HTTPS 请求，不进入前端持久状态。
列表只展示名称、版本、edition、格式/加密算法、大小、密文摘要、对象 URL、
状态和更新时间；管理 API 的 presenter 绝不返回 `contentKey`、`encryptedDek`、
会话令牌或客户端 `wrappedDek`。服务可在安全响应中返回非秘密的 nonce/tag
加密元数据，但页面不将它们作为密钥导出或二次保存。KMXT 只持久化清单和租约；
后台上传会短暂经过 Node 内存，CLI 发布路径则完全不向 Node 发送模型字节。

作者：花落；模型制品管理模块使用 MIT 协议。

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

模型状态：

```text
current status --PATCH(draft|active|revoked)--> target status
```

后端和管理页都只提供 `draft <-> active` 和 `draft|active -> revoked`；重复吊销幂等，
从 `revoked` 恢复会返回 `409 ARTIFACT_REVOKED`，因此 `revoked` 是真正的服务端终态。
页面通过程序上下文对这三种状态进行筛选，并显示 total/draft/active/revoked
数量。只有 active 程序可以登记制品，只有 active artifact 可签发租约。租约模块复用 `VerificationService.verify` 的
卡密、会话、设备和 ReplayGuard 校验；模型字节由对象存储/CDN 提供，不进入
`Router` 的 JSON body。Android SDK 的 native runtime 负责临时 X25519
私钥、HKDF-SHA256、AES-GCM 解包和一次性 DEK handle；Java/Kotlin 不接收 DEK。
Kotlin 在租约请求失败或协程取消时调用 native cancel 擦除待处理私钥；会话撤销、
会话失效和设备不匹配会清空全部 handle。Handle 的硬期限来自已签名 `expiresAt`，
表容量固定受限；到期条目逻辑上立即失效，并在后续 handle 操作时惰性物理擦除。
登记阶段要求 nonce/tag 使用规范 Base64URL 并精确解码为 12/16 字节；
`chunkSize` 仅允许空值或 64 KiB–64 MiB 安全整数。租约阶段对
`license.status=expired` 和已到期时间失败关闭，不产生租约记录。
`cleanup-sessions` 会删除已到期模型租约，未到期的 revoked 租约保留到签名过期时间。
