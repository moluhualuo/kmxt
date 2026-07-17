# API 文档

版本：`v1`  
服务版本：`0.6.0`  
作者：花落  
协议：MIT

## 通用约定

默认地址为 `http://127.0.0.1:8080`。生产环境必须使用 HTTPS。所有带请求体的接口使用：

```http
Content-Type: application/json
```

管理接口使用登录响应中的令牌：

```http
Authorization: Bearer <admin-token>
```

成功响应统一格式：

```json
{
  "success": true,
  "data": {},
  "requestId": "c61625c1-b9c9-4595-b3cf-36746df223bd"
}
```

失败响应统一格式：

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "name length must be between 2 and 100"
  },
  "requestId": "12992653-7ac6-45e8-9e11-0550e355993e"
}
```

分页接口接受 `page` 和 `limit`，默认分别为 `1` 和 `20`，`limit` 最大为 `100`。

## 角色

| 角色 | 能力 |
| --- | --- |
| `platform_admin` | 管理所有商户，并可进入任一商户范围执行管理操作。 |
| `merchant_admin` | 管理自己的用户、程序、卡密、设备和日志。 |
| `operator` | 管理自己商户的卡密与设备，不能创建程序和用户，也不能查看审计日志。 |

商户身份来自登录用户，服务不会信任请求体中的 `merchantId`。商户账号访问其他商户路径会返回 `403 FORBIDDEN`。

## Android 客户端配置

### `GET /api/v1/apps/:appId/client-config`

需要 `platform_admin`、程序所属商户的 `merchant_admin` 或 `operator` 登录。服务端再次按程序的 `merchantId` 校验租户权限。响应同时包含可直接保存的 JSON 和构建期 C++ 头文件；后台程序页的下载按钮调用本接口。

```json
{
  "config": {
    "protocolVersion": 1,
    "baseUrl": "https://kmxt.moluhualuo.top",
    "appId": "00000000-0000-0000-0000-000000000000",
    "keyId": "0123456789abcdef",
    "publicKey": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
  },
  "cppHeader": "#pragma once\n..."
}
```

`baseUrl` 来自 `KMXT_PUBLIC_BASE_URL`，公钥为程序独立 Ed25519 SPKI PEM。接口不返回私钥。公开的 `GET /api/v1/client/apps/:appId/config`、`POST /api/v1/client/activate` 与 `POST /api/v1/client/verify` 字段保持兼容。

## 健康检查

### `GET /ready`

无需认证。执行存储、Redis/安全状态与根密钥就绪检查；详细响应和 0.6.0 管理接口见 `docs/PRODUCTIZATION_060.md`。

### `GET /health`

无需认证。返回服务版本和服务器时间。

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "kmxt-license-server",
    "version": "0.6.0",
    "time": "2026-07-13T08:00:00.000Z"
  },
  "requestId": "..."
}
```

## 管理认证

### `POST /api/v1/auth/login`

登录平台或商户账号。每个来源地址每分钟最多尝试 10 次。

```json
{
  "username": "admin",
  "password": "Change-This-Password!"
}
```

响应中的 `token` 是只出现一次的 Bearer 令牌，默认 8 小时到期。账号失败计数仅在会话实际创建成功后清除；密码错误、账号停用或所属商户停用都不会清除该计数。

```json
{
  "token": "opaque-token",
  "tokenType": "Bearer",
  "expiresAt": "2026-07-13T16:00:00.000Z",
  "user": {
    "id": "uuid",
    "merchantId": null,
    "username": "admin",
    "displayName": "admin",
    "role": "platform_admin",
    "status": "active"
  }
}
```

### `GET /api/v1/auth/me`

需要任意管理角色。返回当前账号，不返回密码摘要。

### `POST /api/v1/auth/logout`

需要任意管理角色。撤销当前 Bearer 会话。

### `POST /api/v1/auth/password`

需要任意管理角色。修改当前登录账号的密码，原密码和新密码长度均为 10 到 128。

```json
{
  "currentPassword": "Current-Password!",
  "newPassword": "New-Strong-Password!"
}
```

必须正确提供当前密码，且新密码不能与原密码相同。成功后撤销该账号的全部管理会话，调用方必须使用新密码重新登录。

## 平台商户管理

### `GET /api/v1/platform/merchants`

仅平台管理员。返回全部商户。

### `POST /api/v1/platform/merchants`

仅平台管理员。商户代码全局唯一，只允许大写字母、数字、下划线和连字符。

```json
{
  "code": "MERCHANT_A",
  "name": "商户 A"
}
```

返回 `201` 和新商户：

```json
{
  "id": "merchant-uuid",
  "code": "MERCHANT_A",
  "name": "商户 A",
  "status": "active",
  "createdAt": "2026-07-13T08:00:00.000Z",
  "updatedAt": "2026-07-13T08:00:00.000Z"
}
```

### `PATCH /api/v1/platform/merchants/:merchantId/status`

仅平台管理员。`status` 为 `active` 或 `disabled`。

```json
{
  "status": "disabled"
}
```

禁用商户会立即撤销该商户的管理会话和客户端验证会话；其程序不能继续激活或验证。

## 商户用户

### `GET /api/v1/merchants/:merchantId`

任意管理角色。平台管理员可读取任意商户；商户账号只能读取自己的商户。返回商户名称、代码、状态及时间字段。管理后台使用该接口为商户账号加载当前租户信息。

### `GET /api/v1/merchants/:merchantId/users`

平台管理员或对应商户管理员。返回该商户全部管理账号。

### `POST /api/v1/merchants/:merchantId/users`

平台管理员或对应商户管理员。用户名全局唯一，密码长度为 10 到 128 个字符。

```json
{
  "username": "merchant.operator",
  "password": "Strong-Password!",
  "displayName": "运营账号",
  "role": "operator"
}
```

`role` 只能是 `merchant_admin` 或 `operator`。返回 `201`。

### `POST /api/v1/users/:userId/password/reset`

平台管理员或目标账号所属商户的商户管理员。只能重置商户账号，商户管理员不能跨商户操作；当前账号应使用自助修改密码接口。

```json
{
  "newPassword": "Reset-Strong-Password!"
}
```

新密码长度为 10 到 128，且不能与目标账号原密码相同。成功后立即撤销目标账号的全部管理会话，并写入 `merchant_user.password.reset` 审计记录。

## 程序管理

### `GET /api/v1/merchants/:merchantId/apps`

任意管理角色，但商户账号只能查询自己的商户。返回程序数组。

### `POST /api/v1/merchants/:merchantId/apps`

平台管理员或对应商户管理员。创建程序时自动生成独立 Ed25519 密钥。

```json
{
  "code": "DESKTOP_PRO",
  "name": "桌面专业版",
  "description": "Windows 客户端",
  "settings": {
    "defaultDurationDays": 30,
    "defaultMaxDevices": 1,
    "heartbeatSeconds": 300,
    "offlineGraceSeconds": 900
  }
}
```

限制：`defaultDurationDays` 为 1 到 3650；`defaultMaxDevices` 为 0 到 20，默认 1，`0` 表示设备绑定无上限；心跳为 30 到 86400 秒；离线容忍为 60 到 604800 秒。

返回 `201`。`signing.publicKey` 和 `signing.keyId` 应在发布客户端时固定到程序内。

### `GET /api/v1/apps/:appId`

任意管理角色并执行商户隔离。返回程序资料、默认策略和签名公钥，不返回加密私钥。

### `PATCH /api/v1/apps/:appId/status`

平台管理员或对应商户管理员。`status` 为 `active` 或 `disabled`。禁用程序会撤销其全部客户端会话。

```json
{
  "status": "disabled"
}
```

## 卡密管理

### `POST /api/v1/apps/:appId/license-batches`

任意管理角色，但只能操作自己可访问的程序。一次生成 1 到 `KMXT_MAX_LICENSE_BATCH` 个卡密，默认上限 1000。

按首次激活计时：

```json
{
  "batchName": "七天体验卡",
  "count": 20,
  "durationDays": 7,
  "maxDevices": 1
}
```

固定到期时间：

```json
{
  "batchName": "年度统一到期",
  "count": 20,
  "fixedExpiresAt": "2027-01-01T00:00:00.000Z",
  "maxDevices": 2
}
```

`durationDays` 和 `fixedExpiresAt` 不能同时提供。未提供时使用程序默认天数和设备数；`maxDevices=0` 表示设备绑定无上限。

返回 `201`。`licenses[].key` 会在本次生成响应中返回；新卡密同时使用根密钥派生的 AES-256-GCM 密文保存，以便授权管理员后续显式查看。普通卡密列表和批次记录始终只返回预览值：

```json
{
  "batch": {
    "id": "batch-uuid",
    "appId": "app-uuid",
    "count": 1
  },
  "licenses": [
    {
      "id": "license-uuid",
      "key": "KMXT-DESKTOP-XXXXX-XXXXX-XXXXX-XXXXX",
      "keyPreview": "KMXT-DESKTOP-****-****-XXXXX",
      "status": "pending",
      "durationDays": 7,
      "maxDevices": 1
    }
  ],
  "plaintextNotice": "License keys can later be explicitly revealed by an authorized owner."
}
```

### `GET /api/v1/apps/:appId/licenses`

分页查询卡密。可选参数：

| 参数 | 说明 |
| --- | --- |
| `status` | `pending`、`active`、`disabled` 或 `expired`。 |
| `key` | 使用完整卡密精确查询，服务只计算摘要，不记录查询原文。 |
| `page` | 页码。 |
| `limit` | 每页数量，最大 100。 |

### `POST /api/v1/apps/:appId/licenses/bulk-delete`

平台管理员或所属商户管理员可调用。请求体最多传入 100 个卡密 ID；服务端会逐个执行与单卡密删除相同的安全检查。能删除的会先删除，已关联订单、跨程序或无权限的卡密会进入 `failed`，不会阻止其他卡密删除。

```json
{
  "licenseIds": ["license-uuid-1", "license-uuid-2"]
}
```

成功响应：

```json
{
  "requestedCount": 2,
  "deletedCount": 1,
  "deletedBindings": 0,
  "deleted": [{ "licenseId": "license-uuid-1", "deletedBindings": 0 }],
  "failed": [{ "licenseId": "license-uuid-2", "code": "LICENSE_HAS_ORDER", "message": "..." }]
}
```

### `PATCH /api/v1/licenses/:licenseId/status`

启用或禁用卡密。

```json
{
  "status": "disabled"
}
```

禁用会撤销该卡密全部客户端会话。重新启用后，未激活卡恢复为 `pending`，已激活卡恢复为 `active`；到期卡不能重新启用。

### `POST /api/v1/licenses/:licenseId/reveal-key`

仅平台管理员或所属商户管理员可调用，且必须通过商户隔离校验。接口没有业务请求体，返回该卡密的完整明文：

```json
{
  "licenseId": "license-uuid",
  "key": "KMXT-DESKTOP-XXXXX-XXXXX-XXXXX-XXXXX"
}
```

响应设置为 `no-store`，访问日志、审计元数据和卡密列表均不包含明文；每次成功查看都会写入 `license.key.reveal` 审计记录。早于此功能创建且没有加密副本的手工卡密返回 `409 LICENSE_KEY_UNAVAILABLE`，无法由摘要反推出明文。

### `DELETE /api/v1/licenses/:licenseId`

仅平台管理员或所属商户管理员可调用，且必须通过商户隔离校验。删除会立即撤销该卡密的客户端会话，清除其设备绑定及验证日志，保留批次和审计记录：

```json
{
  "licenseId": "license-uuid",
  "deletedBindings": 2
}
```

已关联已发卡店铺订单的卡密不能删除，以保持订单交付记录可追溯；此时返回 `409 LICENSE_HAS_ORDER`。每次成功删除写入 `license.delete` 审计记录。

### `GET /api/v1/licenses/:licenseId/devices`

返回卡密全部设备绑定，包括已解绑历史。设备原始标识不会返回。

### `POST /api/v1/licenses/:licenseId/unbind-all`

任意管理角色，但只能操作自己可访问商户的卡密。接口没有业务请求体，会将该卡密全部处于 `active` 状态的设备绑定改为 `revoked`，撤销该卡密的全部客户端会话，并保留设备绑定历史。客户端需要重新激活后才能继续使用。

成功返回 `200`：

```json
{
  "licenseId": "license-uuid",
  "unboundCount": 2
}
```

接口幂等：没有活动设备时仍返回 `200`，且 `unboundCount` 为 `0`；仅在实际解绑时写入一条 `license.devices.unbind_all` 审计记录。

### `POST /api/v1/device-bindings/:bindingId/unbind`

将绑定改为 `revoked` 并撤销相关客户端会话。该接口没有请求体。

## 商品管理

商品属于一个商户程序，决定公开店铺展示内容和审核发卡时生成的授权参数。展示价格使用人民币整数分，当前版本不执行支付。

### `GET /api/v1/apps/:appId/products`

任意管理角色并执行商户隔离。返回指定程序的全部商品，包括已禁用商品。

### `POST /api/v1/apps/:appId/products`

平台管理员或对应商户管理员。返回 `201`。

```json
{
  "name": "30 天单设备授权",
  "description": "桌面专业版授权",
  "priceCents": 1990,
  "durationDays": 30,
  "maxDevices": 1,
  "sortOrder": 10
}
```

`priceCents` 为 0 到 99999999；`durationDays` 为 1 到 3650；`maxDevices` 为 0 到 20，`0` 表示设备绑定无上限；`sortOrder` 为 0 到 10000。

### `PATCH /api/v1/products/:productId`

平台管理员或对应商户管理员。更新商品名称、说明、展示价格、授权参数和排序。已有订单保存商品快照，不会被后续修改影响。

### `PATCH /api/v1/products/:productId/status`

平台管理员或对应商户管理员。`status` 为 `active` 或 `disabled`。禁用后公开店铺立即停止展示该商品，已有待处理订单仍保留。

## 人工订单管理

### `GET /api/v1/merchants/:merchantId/orders`

任意管理角色并执行商户隔离。支持 `page`、`limit` 和可选 `status=pending|fulfilled|rejected`。管理响应会解密联系方式；已发卡订单还会返回 `licenseKey`。

### `POST /api/v1/orders/:orderId/fulfill`

任意管理角色。审核订单并在单一事务中创建卡密、批次和交付记录。接口没有业务请求字段，可发送空 JSON。

成功响应：

```json
{
  "orderNo": "KMO-20260714-19A33C4F10",
  "status": "fulfilled",
  "licenseId": "license-uuid",
  "licenseKey": "KMXT-DESKTOP-XXXXX-XXXXX-XXXXX-XXXXX",
  "fulfilledAt": "2026-07-14T02:00:00.000Z"
}
```

该接口幂等：对已发卡订单重复调用会返回同一 `licenseId` 和卡密，不会生成第二张卡。

### `POST /api/v1/orders/:orderId/reject`

任意管理角色。只有待处理订单可以拒绝。

```json
{
  "reason": "订单信息不完整"
}
```

## 公开店铺接口

公开接口不使用管理 Bearer 令牌。

### `GET /api/v1/store/:merchantCode`

返回启用商户下启用程序的启用商品。响应不包含商户内部 ID、私钥或卡密库存。

```json
{
  "merchant": {
    "code": "MERCHANT_A",
    "name": "商户 A"
  },
  "products": [
    {
      "id": "product-uuid",
      "appId": "app-uuid",
      "name": "30 天单设备授权",
      "priceCents": 1990,
      "currency": "CNY",
      "durationDays": 30,
      "maxDevices": 1,
      "application": {
        "id": "app-uuid",
        "code": "DESKTOP",
        "name": "桌面程序"
      }
    }
  ],
  "fulfillment": "manual"
}
```

### `POST /api/v1/store/:merchantCode/orders`

提交人工审核订单，每个来源地址每分钟最多 10 次。

```json
{
  "productId": "product-uuid",
  "customerName": "张三",
  "contact": "user@example.com",
  "note": "可选备注"
}
```

`contact` 必填，长度 3 到 120；`customerName` 可选，填写时长度为 1 到 80，支持单字中文称呼；`note` 可选，最长 500。返回 `201`，其中查询码只在创建响应出现一次：

```json
{
  "orderNo": "KMO-20260714-19A33C4F10",
  "status": "pending",
  "contact": "us***@example.com",
  "licenseKey": null,
  "queryCode": "high-entropy-order-secret"
}
```

### `POST /api/v1/store/orders/query`

每个来源地址每分钟最多查询 30 次。订单号和查询码必须同时正确；错误时统一返回 `ORDER_QUERY_INVALID`，不会泄露订单是否存在。

```json
{
  "orderNo": "KMO-20260714-19A33C4F10",
  "queryCode": "high-entropy-order-secret"
}
```

待处理订单返回 `licenseKey: null`；发卡后返回解密卡密；拒绝后返回 `rejectReason`。

公开创建和查询响应不会返回内部 `merchantId`、`appId`、`productId`、`licenseId` 或订单数据库 ID。

## 日志

### `GET /api/v1/merchants/:merchantId/audit-logs`

平台管理员或对应商户管理员。分页返回程序创建、卡密生成、启停和解绑等管理操作。

### `GET /api/v1/apps/:appId/verification-logs`

任意管理角色并执行商户隔离。分页返回成功的 `activate` 和 `verify` 事件。日志只包含资源 ID、结果、客户端版本和时间。

## 客户端验证接口

客户端接口不使用管理 Bearer 令牌。`timestamp` 必须是当前 Unix 毫秒时间戳，允许偏差由 `KMXT_CLOCK_SKEW_SECONDS` 控制；`nonce` 为 12 到 128 位 URL 安全文本，在时间窗口内不可重复。

### `GET /api/v1/client/apps/:appId/config`

返回公开程序配置和签名公钥。该接口适合接入阶段读取配置，不应被正式客户端用作动态信任源；正式程序必须预置并固定公钥和 `keyId`。

### `POST /api/v1/client/activate`

首次激活或同一设备重新获取短期会话。

```json
{
  "appId": "app-uuid",
  "licenseKey": "KMXT-DESKTOP-XXXXX-XXXXX-XXXXX-XXXXX",
  "deviceId": "stable-device-identifier",
  "deviceLabel": "Office PC",
  "clientVersion": "1.0.0",
  "timestamp": 1783930000000,
  "nonce": "url-safe-random-value"
}
```

成功响应的 `data` 是签名信封：

```json
{
  "algorithm": "Ed25519",
  "keyId": "8f1c4a31e415fe25",
  "payload": {
    "licensed": true,
    "code": "LICENSE_VALID",
    "appId": "app-uuid",
    "licenseId": "license-uuid",
    "bindingId": "binding-uuid",
    "sessionToken": "opaque-client-token",
    "issuedAt": "2026-07-13T08:00:00.000Z",
    "licenseExpiresAt": "2026-08-12T08:00:00.000Z",
    "sessionExpiresAt": "2026-07-13T08:30:00.000Z",
    "heartbeatAfterSeconds": 300,
    "offlineGraceSeconds": 900
  },
  "signature": "base64url-ed25519-signature"
}
```

客户端必须先使用固定公钥验证签名，再读取 `payload`。不能只判断 HTTP 200 或 `licensed` 字段。

### `POST /api/v1/client/verify`

使用激活返回的短期会话执行心跳。

```json
{
  "appId": "app-uuid",
  "sessionToken": "opaque-client-token",
  "deviceId": "stable-device-identifier",
  "clientVersion": "1.0.0",
  "timestamp": 1783930100000,
  "nonce": "another-url-safe-random-value"
}
```

成功返回相同签名信封，但不重复返回 `sessionToken`。心跳会将短期会话续至“当前时间 + 会话时长”，且绝不会超过卡密到期时间。

## 常见错误代码

| HTTP | 代码 | 含义 |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | 参数类型、长度或格式错误。 |
| 400 | `INVALID_JSON` | 请求体不是有效 JSON。 |
| 400 | `CURRENT_PASSWORD_INVALID` | 当前密码不正确。 |
| 401 | `INVALID_CREDENTIALS` | 管理用户名或密码错误。 |
| 401 | `UNAUTHORIZED` | 管理会话缺失或过期。 |
| 401 | `LICENSE_INVALID` | 卡密不属于指定程序。 |
| 401 | `SESSION_EXPIRED` | 客户端会话无效、过期或已撤销。 |
| 401 | `DEVICE_MISMATCH` | 心跳设备与激活设备不匹配。 |
| 401 | `STALE_REQUEST` | 客户端时间超出允许窗口。 |
| 403 | `FORBIDDEN` | 角色不足或跨商户访问。 |
| 403 | `MERCHANT_DISABLED` | 商户已禁用。 |
| 403 | `APPLICATION_DISABLED` | 程序已禁用。 |
| 403 | `LICENSE_DISABLED` | 卡密已禁用。 |
| 403 | `LICENSE_EXPIRED` | 卡密已到期。 |
| 404 | `*_NOT_FOUND` | 管理资源不存在。 |
| 409 | `REPLAY_DETECTED` | Nonce 已被使用。 |
| 409 | `DEVICE_LIMIT_REACHED` | 已达到卡密设备数上限。 |
| 409 | `PRODUCT_UNAVAILABLE` | 商品、程序或商户不可下单。 |
| 409 | `ORDER_NOT_PENDING` | 订单已经发卡或拒绝。 |
| 409 | `ORDER_COLLISION` | 极少数订单号唯一冲突连续重试后仍未获得编号；客户端可安全重试下单请求。 |
| 409 | `PASSWORD_UNCHANGED` | 新密码与原密码相同。 |
| 409 | `PASSWORD_CHANGED_RETRY` | 密码被并发请求修改，需重新登录后再试。 |
| 409 | `USE_SELF_PASSWORD_CHANGE` | 当前账号应使用自助改密接口。 |
| 409 | `*_EXISTS` | 唯一代码或用户名冲突。 |
| 401 | `ORDER_QUERY_INVALID` | 订单号或查询码错误。 |
| 413 | `BODY_TOO_LARGE` | 请求体超过配置上限。 |
| 429 | `RATE_LIMITED` | 请求过多，参考 `Retry-After` 响应头。 |
