# API 文档

版本：`v1`  
服务版本：`0.7.3`
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

`baseUrl` 来自 `KMXT_PUBLIC_BASE_URL`，公钥为程序独立 Ed25519 SPKI PEM。接口不返回私钥。公开的 `GET /api/v1/client/apps/:appId/config`、`POST /api/v1/client/activate`、`POST /api/v1/client/verify` 与 `POST /api/v1/client/unbind` 共用程序签名信任根。

## 健康检查

### `GET /ready`

无需认证。执行存储、Redis/安全状态与根密钥就绪检查；历史 0.6.0 变更记录见
`docs/PRODUCTIZATION_060.md`，当前接口以本文和 `src/http/routes.js` 为准。

### `GET /health`

无需认证。返回服务版本和服务器时间。

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "kmxt-license-server",
    "version": "0.7.3",
    "time": "2026-07-13T08:00:00.000Z"
  },
  "requestId": "..."
}
```

## 管理总览

### `GET /api/v1/dashboard`

需要任意管理角色，并按登录用户、可选 `merchantId` 和可选 `appId` 执行租户隔离。
返回商户、程序、待审核订单、卡密、有效绑定以及 `verification24h` 统计。
24 小时验证只统计已经写入验证日志的 `activate` 与 `verify` 事件；
`resultCode=LICENSE_VALID` 计为成功，其他已记录结果计为失败。
成功的主动解绑 `DEVICE_UNBOUND` 不属于验证统计，服务端在校验失败前拒绝且没有写入
验证日志的请求也不会进入 `total` 或 `failed`。

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

### `PATCH /api/v1/users/:userId/role`

平台管理员或目标账号所属商户的商户管理员。只能调整商户账号在 `operator` 与 `merchant_admin` 之间的角色，与 `POST /api/v1/merchants/:merchantId/users` 使用同一枚举，因此不能借该接口造出 `platform_admin`；平台管理员账号没有 `merchantId`，返回 `404 USER_NOT_FOUND`。

```json
{
  "role": "merchant_admin"
}
```

不能修改自己的角色，否则返回 `409 SELF_ROLE_FORBIDDEN`，避免最后一个商户管理员自降权后该商户无人可写。角色确实发生变化时立即撤销目标账号的全部管理会话并写入 `merchant_user.role.update` 审计记录（`metadata` 为 `{ from, to }`）；提交与当前角色相同的值是幂等的，不撤销会话也不写审计。

```json
{
  "user": { "id": "...", "role": "merchant_admin", "status": "active" },
  "sessionsRevoked": 1,
  "roleChanged": true
}
```

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

### `GET /api/v1/apps/:appId/online-devices`

任意管理角色可调用，但必须通过程序所属商户的租户隔离校验。接口按程序分页返回活动设备绑定的在线状态，不返回设备 ID 原文或设备摘要。

查询参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `page` | `1` | 页码。 |
| `limit` | `20` | 每页数量，最大 `100`。 |
| `status` | `online` | `online`、`offline` 或 `all`。 |
| `search` | 空 | 模糊匹配设备标签、卡密遮罩预览、客户端版本或来源 IP，最长 100 字符。 |

在线判定要求同时满足：设备绑定为 `active`、至少存在一个未到期客户端会话、该会话最后心跳不早于在线窗口。在线窗口为程序 `heartbeatSeconds × 2`，最低 60 秒。这个窗口只用于管理端在线展示，不修改客户端签名响应中的心跳和离线宽限策略。

```json
{
  "items": [
    {
      "bindingId": "binding-uuid",
      "licenseId": "license-uuid",
      "licenseKeyPreview": "KMXT-APP-****-1234",
      "deviceLabel": "Primary PC",
      "clientVersion": "1.0.1",
      "ipAddress": "203.0.113.10",
      "online": true,
      "status": "online",
      "boundAt": "2026-07-18T08:00:00.000Z",
      "lastSeenAt": "2026-07-18T08:10:00.000Z",
      "sessionExpiresAt": "2026-07-18T08:40:00.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "summary": {
    "total": 3,
    "online": 1,
    "offline": 2,
    "onlineWindowSeconds": 180
  }
}
```

`summary` 始终统计当前程序的全部活动绑定，不受 `status`、`search` 和分页影响。`ipAddress` 来自服务端可信客户端地址解析：只有直连地址命中 `KMXT_TRUSTED_PROXY_CIDRS` 时才采纳代理转发链；客户端请求体不能自行指定该字段。

### `POST /api/v1/device-bindings/:bindingId/disconnect`

任意管理角色可调用并执行租户隔离。接口没有业务请求体，会删除该设备绑定的全部客户端会话，使已有会话令牌立即返回 `401 SESSION_EXPIRED`；绑定仍保持 `active`，因此设备之后可以重新激活且不会额外占用设备名额。

```json
{
  "bindingId": "binding-uuid",
  "disconnectedSessions": 1
}
```

接口幂等：设备已经离线时返回 `disconnectedSessions: 0`。只有实际撤销会话时才写入 `device.disconnect` 审计记录。

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

任意管理角色并执行商户隔离。分页返回成功的 `activate`、`verify` 和客户端主动 `unbind` 事件。日志只包含资源 ID、结果、客户端版本和时间。

## 客户端验证接口

客户端接口不使用管理 Bearer 令牌。`timestamp` 必须是当前 Unix 毫秒时间戳，允许偏差由 `KMXT_CLOCK_SKEW_SECONDS` 控制；服务端闭区间接受 `now - clockSkew` 到 `now + clockSkew`，包含窗口内的未来时间戳。`nonce` 为 12 到 128 位 URL 安全文本，在时间窗口内不可重复；成功消费后至少保留 `2 * clockSkew + 1000ms`，确保未来时间戳的整个可接受窗口均受防重放保护。

`activate`、`verify` 和 `unbind` 的成功签名载荷都包含 `requestNonce`，其值必须与本次请求的 `nonce` 完全一致。客户端必须先验证 Ed25519 签名，再比较该字段；缺失、不匹配或把旧签名响应重放给新请求时都必须失败关闭。

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
    "requestNonce": "url-safe-random-value",
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

客户端必须先使用固定公钥验证签名，再确认 `payload.requestNonce` 等于本次请求的 `nonce`，最后读取授权字段。不能只判断 HTTP 200 或 `licensed` 字段。

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

成功返回相同签名信封并包含本次心跳的 `requestNonce`，但不重复返回 `sessionToken`。心跳会将短期会话续至“当前时间 + 会话时长”，且绝不会超过卡密到期时间。

### `POST /api/v1/client/unbind`

当前设备主动解除自己的绑定。请求不使用管理令牌，但必须携带仍有效的客户端会话、与激活时相同的设备标识、新时间戳和新 Nonce：

```json
{
  "appId": "app-uuid",
  "sessionToken": "opaque-client-token",
  "deviceId": "stable-device-identifier",
  "clientVersion": "1.0.0",
  "timestamp": 1783930200000,
  "nonce": "fresh-url-safe-random-value"
}
```

服务端只允许会话所属设备解绑自身。设备不匹配返回 `401 DEVICE_MISMATCH`，会话无效、过期或已被管理员撤销返回 `401 SESSION_EXPIRED`。成功后绑定状态改为 `revoked`，该绑定全部会话立即失效，并释放卡密设备名额。

成功响应同样是程序 Ed25519 签名信封，但它不是授权信封，客户端必须验证签名后检查 `unbound` 和 `code`：

```json
{
  "algorithm": "Ed25519",
  "keyId": "8f1c4a31e415fe25",
  "payload": {
    "unbound": true,
    "code": "DEVICE_UNBOUND",
    "appId": "app-uuid",
    "requestNonce": "fresh-url-safe-random-value",
    "licenseId": "license-uuid",
    "bindingId": "binding-uuid",
    "sessionsRevoked": 1,
    "issuedAt": "2026-07-19T08:00:00.000Z"
  },
  "signature": "base64url-ed25519-signature"
}
```

客户端只有在算法、固定 `keyId`、Ed25519 签名、固定 `appId`、当前请求 `nonce` 与已签名 `requestNonce` 完全一致、`unbound === true` 与 `code === DEVICE_UNBOUND` 全部验证通过后，才能删除本地会话。解绑成功后需要再次输入卡密激活才能恢复授权。

## 公告与版本策略

公告系统通过双通道向客户端下发系统通知和版本更新要求：

- **通道 A**：已激活客户端在 `activate` 和 `verify` 的授权签名载荷中自动获得公告和版本策略
- **通道 B**：未激活客户端通过独立的公开签名端点 `/api/v1/client/apps/:appId/notices` 获取

两条通道的公告和版本策略均由程序 Ed25519 私钥签名，客户端必须验证签名和 `appId` 后使用。公告载荷包含单调递增序号，客户端必须持久化已见最大序号并拒绝回滚。

每条公告有一个 `placement`（投放位置）字段决定它进入哪条通道，因此「只在软件内展示、不在卡密验证页展示」这类需求完全由服务端过滤实现，客户端无需改动：

| `placement` | 含义 | 通道 A（软件内） | 通道 B（卡密验证页） |
| --- | --- | --- | --- |
| `both`（缺省） | 全部页面 | 下发 | 下发 |
| `gate` | 仅验证页 | 不下发 | 下发 |
| `app` | 仅软件内 | 下发 | 不下发 |

`placement` 与 `status`、时间窗口是三层相互独立的过滤条件，且过滤在条数上限（每条通道最多 3 条）之前执行，因此一条通道的公告不会挤占另一条通道的名额。历史公告的记录里没有这个键，读取时统一按 `both` 解释，升级服务端不会让任何已发布公告从某个页面消失。`placement` 是服务端投放开关，**不会**出现在下发给客户端的签名载荷里。

### 管理接口

#### `GET /api/v1/apps/:appId/announcements`

需要 `platform_admin`、`merchant_admin` 或 `operator`（只读权限）。返回指定程序的全部公告（包括草稿和已发布），按创建时间倒序。

响应示例：

```json
{
  "success": true,
  "data": [
    {
      "id": "ann-uuid",
      "applicationId": "app-uuid",
      "sequence": 3,
      "status": "published",
      "severity": "warning",
      "placement": "both",
      "title": "重要更新提醒",
      "body": "我们发现了一个影响性能的问题，请尽快更新到最新版本。",
      "startsAt": "2026-07-25T00:00:00.000Z",
      "endsAt": "2026-08-05T00:00:00.000Z",
      "publishedAt": "2026-07-25T10:30:00.000Z",
      "createdAt": "2026-07-25T10:00:00.000Z",
      "updatedAt": "2026-07-25T10:30:00.000Z"
    }
  ]
}
```

#### `POST /api/v1/apps/:appId/announcements`

需要 `platform_admin` 或程序所属商户的 `merchant_admin`（`operator` 无权创建公告）。创建新公告，初始状态为 `draft`，自动分配单调递增序号。

请求体：

```json
{
  "title": "维护通知",
  "body": "系统将于今晚22:00进行例行维护，预计持续2小时。",
  "severity": "info",
  "placement": "app",
  "startsAt": "2026-07-30T22:00:00.000Z",
  "endsAt": "2026-07-31T02:00:00.000Z"
}
```

- `title`：必填，2-200 字符，纯文本（拒绝 `<>` 和 JavaScript URI）
- `body`：必填，10-2000 字符，纯文本，最多 20 行
- `severity`：必填，枚举 `info`、`warning`、`critical`
- `placement`：可选，枚举 `both`（缺省）、`gate`、`app`，决定公告进入哪条下发通道
- `startsAt`/`endsAt`：可选，ISO 8601 时间戳，用于时间窗口过滤；`endsAt` 必须晚于 `startsAt`

响应返回完整公告对象（201 Created）。

#### `PATCH /api/v1/announcements/:announcementId`

需要 `platform_admin` 或程序所属商户的 `merchant_admin`。更新公告内容、投放位置和时间窗口（不能修改 `sequence` 和 `status`）。

请求体示例：

```json
{
  "title": "维护通知（已延期）",
  "placement": "app",
  "endsAt": "2026-07-31T04:00:00.000Z"
}
```

所有字段可选，未提供的字段保持不变。

#### `PATCH /api/v1/announcements/:announcementId/status`

需要 `platform_admin` 或程序所属商户的 `merchant_admin`。切换公告状态。

请求体：

```json
{
  "status": "published"
}
```

- `draft` → `published`：首次发布时记录 `publishedAt` 时间戳
- `published` → `draft`：取消发布，客户端不再收到
- `published` → `archived`：归档已过期公告

#### `DELETE /api/v1/announcements/:announcementId`

需要 `platform_admin` 或程序所属商户的 `merchant_admin`。物理删除公告记录。

**重要**：删除公告不会回退程序的 `announcementSequence` 计数器，新创建的公告序号会跳过被删除的序号，确保客户端防回滚机制正常工作。

### 客户端接口

#### `GET /api/v1/client/apps/:appId/notices`

公开端点，无需认证，受限速保护（30 次/60 秒）。返回程序签名的通知信封，包含版本策略和当前有效公告。

响应示例：

```json
{
  "success": true,
  "data": {
    "algorithm": "Ed25519",
    "keyId": "8f1c4a31e415fe25",
    "payload": {
      "type": "client_notice",
      "protocolVersion": 1,
      "appId": "app-uuid",
      "issuedAt": "2026-07-30T12:00:00.000Z",
      "sequence": 3,
      "clientPolicy": {
        "minVersionCode": 100,
        "latestVersionCode": 120,
        "latestVersionName": "1.2.0",
        "releaseNotes": "修复已知问题，优化性能。"
      },
      "announcements": [
        {
          "id": "ann-uuid",
          "sequence": 3,
          "severity": "warning",
          "title": "重要更新提醒",
          "body": "我们发现了一个影响性能的问题，请尽快更新到最新版本。",
          "publishedAt": "2026-07-25T10:30:00.000Z"
        }
      ]
    },
    "signature": "base64url-ed25519-signature"
  }
}
```

**版本策略字段**：

- `minVersionCode`：硬性最低版本要求，低于此版本的客户端应禁用激活功能
- `latestVersionCode`/`latestVersionName`/`releaseNotes`：建议更新信息，用于提示用户

**公告列表**：

- 只返回 `status === 'published'` 且在时间窗口内的公告（当前时间在 `startsAt` 和 `endsAt` 之间，缺失时视为无限制）
- 只返回 `placement` 为 `both` 或 `gate` 的公告；`placement === 'app'` 的公告不进这条通道
- 按 `sequence` 倒序排列，最多返回 3 条
- 载荷里的 `payload.sequence` 取程序级 `announcementSequence` 计数器（只随创建递增），**不是**本次下发公告的最大序号。撤回发布、公告过期、删除、或把 `placement` 改成 `app` 都会让下发集合缩小，若用集合最大序号，客户端的防回滚检查会把一次合法的管理操作当成降级攻击并整封拒收

**客户端验证要求**：

1. 验证 Ed25519 签名和 `keyId`（必须与预置公钥匹配）
2. 验证 `payload.appId` 与当前程序一致
3. 验证 `payload.type === 'client_notice'`
4. 检查 `issuedAt` 时间戳新鲜度（建议容忍 5 分钟内）
5. **防回滚**：比较 `payload.sequence` 与本地持久化的最大已见序号
   - 如果 `payload.sequence < lastSeenSequence`，拒绝使用（可能是降级攻击）
   - 如果 `payload.sequence >= lastSeenSequence`，更新本地记录
6. 验证通过后，检查 `clientPolicy.minVersionCode`：
   - 如果当前客户端 `versionCode < minVersionCode`，禁用激活按钮并提示强制更新
7. 渲染 `announcements` 列表，按 `severity` 分配视觉样式（`critical` 红色，`warning` 橙色，`info` 蓝色）

**签名载荷可用性**：

- 服务端配置 `rootSecret` 和程序签名密钥后才能生成签名
- 缺少密钥时返回 `503 NOTICE_UNAVAILABLE`
- 客户端应容错处理：签名验证失败或服务不可用时不阻塞激活流程，仅跳过公告显示

### 通道 A：授权响应中的公告

`activate` 和 `verify` 的成功响应载荷自动包含相同的 `clientPolicy` 和 `announcements` 字段，无需单独请求。客户端应优先使用授权响应中的公告（更及时），仅在未激活状态时回退到通道 B。

这条通道只包含 `placement` 为 `both` 或 `app` 的公告；`placement === 'gate'` 的公告是卡密验证页专属，不会出现在授权响应里。两条通道各自独立应用 3 条上限。

## 常见错误代码

## 加密模型与云密钥

模型发布支持两条路径。推荐由受控发布机运行 `cli/publish-model-artifact.js`，
在本地生成随机 32 字节 DEK、执行 AES-256-GCM 加密，再仅向 KMXT 登记元数据和
DEK；该路径不把模型字节发送给 Node。管理后台也提供受认证的上传接口，明文文件
经 HTTPS 进入 Node 内存，加密后立即以 `.vmp` 下载响应返回，服务端不落盘也不托管
明文或密文。两条路径最终都只持久化不可变清单、密文 SHA-256、被根密钥加密的
DEK 和短期租约；大型模型优先使用本地发布 CLI，避免浏览器上传的内存与 Base64 开销。

### 管理后台上下文

“模型制品”页面位于后台程序上下文。从侧栏入口进入时继续使用当前程序的 `appId`；
点击程序列表每行的“模型”快捷按钮时，先将该程序设为当前上下文再进入页面。
页内程序选择器也可切换到同一权限范围的其他程序。它不是跨租户的全局制品入口；商户身份来自 Bearer
会话，请求体中不接受 `merchantId` 来改变权限范围。

| 页面动作 | API | 权限 | 对客户端租约的影响 |
| --- | --- | --- | --- |
| 加载当前程序制品 | `GET /api/v1/apps/:appId/artifacts` | `platform_admin`、所属商户的 `merchant_admin` 或 `operator` | 只读，不签发租约。 |
| 上传并加密模型 | `POST /api/v1/admin/artifacts/upload` | `platform_admin` 或所属商户的 `merchant_admin` | 明文经 HTTPS 进入服务端内存，加密并登记为 `draft`，随后返回 `.vmp` 下载数据。 |
| 登记加密制品 | `POST /api/v1/apps/:appId/artifacts` | `platform_admin` 或所属商户的 `merchant_admin` | 新制品始终以 `draft` 创建，不签发租约。 |
| 切换制品状态 | `PATCH /api/v1/artifacts/:artifactId/status` | `platform_admin` 或所属商户的 `merchant_admin` | 只有 `active` 可签发；`revoked` 停止新租约并撤销现有 active 租约。 |

`operator` 可查看当前程序的制品列表，但后端和页面都不允许其上传、登记或切换状态。
管理页不调用客户端租约 API，也不显示或持久化模型 DEK。

### `POST /api/v1/admin/artifacts/upload`

需要 `platform_admin` 或程序所属商户的 `merchant_admin`。请求使用
`multipart/form-data`，每个 HTTP 请求只处理一个文件；管理页面允许多选，但会按文件
逐个调用接口。目标程序必须处于 `active`，新记录固定创建为 `draft`。

| 表单字段 | 必填 | 约束与用途 |
| --- | --- | --- |
| `file` | 是 | 明文制品文件；后台支持 `.onnx`、`.param`、`.bin`、`.tflite`、`.dlc`、`.so` 和 `.dex`。 |
| `appId` | 是 | 当前程序 UUID；商户范围仍由 Bearer 会话校验。 |
| `name` | 否 | 制品名；省略时从文件名推断。`.onnx`/`.tflite`/`.dlc`/`.so`/`.dex`/`.pt`/`.pth` 去除扩展名；ncnn 的 `.param`/`.bin` **保留完整文件名**，以免 `X.ncnn.param` 与 `X.ncnn.bin` 塌缩同名后触发唯一键冲突。 |
| `version` | 否 | 版本号，默认 `1.0`。 |
| `format` | 否 | 制品格式；省略时从文件扩展名推断，最终仍受 artifact 格式白名单校验。 |
| `edition` | 否 | 可选版本分层。 |
| `keyVersion` | 否 | 密钥版本，默认 `1`。 |

服务端为该文件生成独立 DEK 和 12 字节 Nonce，使用 AES-256-GCM 生成
`[12B nonce][16B tag][ciphertext]` 格式的 `.vmp`，调用模型交付服务登记元数据，
并把 DEK 以 `artifact-dek:<artifactId>` 用途标签加密保存。响应不包含明文 DEK：

```json
{
  "artifactId": "artifact-uuid",
  "name": "screenyolo-paid",
  "version": "1.0",
  "format": "onnx",
  "cipherSha256": "64-lowercase-hex",
  "size": 7340060,
  "encryption": {
    "algorithm": "AES-256-GCM",
    "nonce": "base64url",
    "tag": "base64url",
    "chunkSize": null
  },
  "vmpFilename": "screenyolo-paid.vmp",
  "vmpBase64": "base64-encrypted-file"
}
```

Router 会再包裹统一的 `{ "success": true, "data": ... }` 信封。明文、密文和 DEK
都不写入服务端磁盘；但当前实现会在内存中缓冲单个 multipart 文件，并把密文转换为
Base64 JSON 响应，因此反向代理必须设置明确的上传上限和超时，大文件应使用本地发布 CLI。
`KMXT_MODEL_ARTIFACT_MAX_BYTES` 在登记阶段限制最终密文字节数。

批量上传时同一 `(appId, name, version)` 只能存在一条记录，重复登记返回
`409 ARTIFACT_EXISTS`。管理页多选会按文件逐个调用本接口且共用同一 `version`，
因此同批文件的推断名必须互不相同。重传同名同版本前需先删除或吊销旧制品，
或显式传入不同的 `version`。

### `POST /api/v1/apps/:appId/artifacts`

需要 `platform_admin` 或程序所属商户的 `merchant_admin`，并要求目标程序处于
`active`。登记一个 draft artifact；已禁用程序返回 `403 APPLICATION_DISABLED`。
请求只能通过 HTTPS 管理链路提交；`contentKey` 是 32 字节
Base64URL DEK，服务收到后立即用 `artifact-dek:<artifactId>` 用途标签加密，
列表、日志和响应均不返回该字段。

```json
{
  "name": "screenyolo-paid.onnx",
  "version": "2026.07.22",
  "format": "onnx",
  "edition": "paid",
  "cipherSha256": "64-lowercase-hex",
  "size": 7340032,
  "encryption": {
    "algorithm": "AES-256-GCM",
    "nonce": "base64url",
    "tag": "base64url"
  },
  "contentKey": "base64url-32-bytes",
  "keyVersion": 1
}
```

| 请求字段 | 必填 | 约束与用途 |
| --- | --- | --- |
| `name` | 是 | 制品名称，1–128 个字符。 |
| `version` | 是 | 程序内的发布版本，1–64 个字符；与 `name` 组合唯一。 |
| `format` | 是 | `onnx`、`ncnn-param`、`ncnn-bin`、`tflite`、`dlc`、`bundle`、`so` 或 `dex`。 |
| `edition` | 否 | 可选版本分支，1–32 个字符。 |
| `cipherSha256` | 是 | 密文文件的 64 位小写十六进制 SHA-256。 |
| `size` | 是 | 密文字节数，不超过 `KMXT_MODEL_ARTIFACT_MAX_BYTES`。 |
| `encryption` | 是 | 加密元数据对象。 |
| `encryption.algorithm` | 否 | 只允许 `AES-256-GCM`；省略时也默认为该算法，管理页会显式提交。 |
| `encryption.nonce` | 是 | 不带填充的规范 Base64URL，解码后恰为 12 字节。 |
| `encryption.tag` | 是 | 不带填充的规范 Base64URL，解码后恰为 16 字节。 |
| `encryption.chunkSize` | 否 | 整文件模式省略或为 `null`；分块模式为 65536–67108864 的安全整数。 |
| `contentKey` | 是 | 仅登记请求使用的 32 字节 Base64URL DEK；页面提交后不回显。 |
| `keyVersion` | 否 | 1–1000000 的正整数，默认为 `1`。 |

`format` 支持 `onnx`、`ncnn-param`、`ncnn-bin`、`tflite`、`dlc`、`bundle`、`so`
和 `dex`；`size` 受
`KMXT_MODEL_ARTIFACT_MAX_BYTES` 限制。同一程序、名称和版本不可重复。
`encryption.nonce` 和 `encryption.tag` 必填，必须是不带填充的规范
Base64URL，解码后分别为 12 字节和 16 字节。`chunkSize` 在整文件
AES-GCM 模式下省略或设为 `null`；分块模式只能使用 65536 到
67108864 字节范围内的安全整数，字符串、浮点数和范围外数值均返回
`400 INVALID_INPUT`。

登记成功后返回安全的制品元数据并固定为 `draft`。登记页的 nonce、tag
和 `contentKey` 都是当次 POST 表单的请求态输入，不写入 URL、`sessionStorage`、
`localStorage` 或页面导出文件。服务 API 的安全响应可包含非秘密的 nonce/tag
加密元数据，但绝不包含 `contentKey` 或内部 `encryptedDek`。

### `GET /api/v1/apps/:appId/artifacts`

需要任意有权访问该程序的管理角色，包括只读的 `operator`。返回 artifact
数组，按 `createdAt` 从新到旧排序。管理页列表展示名称与完整 UUID、版本、edition、格式/加密算法、
大小、密文摘要、`draft|active|revoked` 状态和更新时间，并提供三态筛选与数量统计；不返回也不展示
`encryptedDek`、`contentKey` 或任何会话秘密。

### `PATCH /api/v1/artifacts/:artifactId/status`

需要拥有者角色，即 `platform_admin` 或制品所属商户的 `merchant_admin`。
`operator` 不能调用。请求为 `{"status":"draft|active|revoked"}`：`draft` 用于上传/
校验阶段，`active` 允许有效客户端签发租约，`revoked` 会同时把现存 active 租约标记为 revoked，
后续客户端必须停止使用并清除内存密钥。

管理页和后端都只提供 `draft <-> active` 与 `draft|active -> revoked` 流转；
`revoked` 是不可恢复终态，再请求 `draft` 或 `active` 返回 `409 ARTIFACT_REVOKED`。
重复提交 `revoked` 是幂等操作。从 `active` 退回 `draft` 会停止新租约，但不会撤销
已签发租约；这些租约仍有效至各自 `expiresAt`。已吊销制品需要替代时，
管理员应登记新制品。PATCH 请求体仍只接受上述三个枚举字符串。

### `DELETE /api/v1/artifacts/:artifactId`

需要拥有者角色，即 `platform_admin` 或制品所属商户的 `merchant_admin`，
`operator` 不能调用。只有处于 `draft` 或 `revoked` 状态的制品可删除；
删除处于 `active` 的制品返回 `409 ARTIFACT_ACTIVE`，应先切换状态。
制品不存在返回 `404 ARTIFACT_NOT_FOUND`。该接口没有请求体。

删除在单个事务内完成：先级联删除该制品关联的全部模型租约（数据库外键
`fk_model_leases_artifact` 也声明了 `ON DELETE CASCADE`），再删除制品本身，
并写入不含密钥的 `model-artifact.delete` 审计记录。响应返回被一并删除的
租约数量：

```json
{ "deletedLeases": 0 }
```

### `POST /api/v1/client/artifacts/:artifactId/lease`

每来源地址每分钟最多 30 次。请求必须携带现有有效客户端会话、同一设备指纹、
毫秒时间戳、一次性 Nonce 和客户端临时 X25519 SPKI DER 公钥：

```json
{
  "appId": "app-uuid",
  "sessionToken": "opaque-token",
  "deviceId": "stable-device-fingerprint",
  "clientVersion": "1.1.0",
  "timestamp": 1784678400000,
  "nonce": "random-base64url",
  "clientPublicKey": "base64url-x25519-spki"
}
```

服务先执行与心跳相同的卡密、会话和设备绑定事务，再返回程序 Ed25519 签名信封。
卡密状态为 `expired` 或到期时间不晚于当前时间时返回
`403 LICENSE_EXPIRED`，不会创建模型租约。
客户端必须先验证算法、固定 `keyId`、签名、`appId`、`artifactId`、
`requestNonce`、`clientKeyFingerprint`、密文 SHA-256 和租约时间，再用
X25519 + HKDF-SHA256 + AES-256-GCM 解开 `wrappedDek`。ScreenYolo app-specific
Android SDK 在 native 完成这些步骤并返回一次性 DEK handle，Java/Kotlin 不接收 DEK：

```json
{
  "algorithm": "Ed25519",
  "keyId": "trusted-key-id",
  "payload": {
    "type": "model_lease",
    "appId": "app-uuid",
    "artifactId": "artifact-uuid",
    "cipherSha256": "64-lowercase-hex",
    "leaseId": "lease-uuid",
    "bindingId": "binding-uuid",
    "requestNonce": "original-request-nonce",
    "issuedAt": "2026-07-22T00:00:00.000Z",
    "expiresAt": "2026-07-22T00:10:00.000Z",
    "wrapAlgorithm": "X25519-HKDF-SHA256-AES-256-GCM",
    "serverEphemeralPublicKey": "base64url",
    "wrappedDek": {
      "iv": "base64url",
      "tag": "base64url",
      "ciphertext": "base64url",
      "associatedData": "signed-binding-data"
    }
  },
  "signature": "base64url-ed25519-signature"
}
```

密文可缓存，明文模型和 DEK 不得写盘。默认租约 600 秒，并且不能超过客户端
会话或卡密到期时间。`expiresAt`、`size` 与密文哈希都位于 Ed25519 签名载荷内；
Android native handle 以该 `expiresAt` 为硬期限，并受固定容量上限保护。到期 handle
立即不可使用，其 DEK 与物理表项在下一次 handle 操作时惰性擦除；清理后仍满则失败关闭。
租约 HTTP、解析、验证、解包失败或协程取消时，Android SDK 调用 native cancel 擦除
待处理 X25519 私钥；成功返回 `ModelLease` 时不执行 cancel。会话撤销、失效或设备不匹配
一经客户端在线验证确认，会清除 native 授权状态和全部未消费 handle。
服务端已到期租约记录由 `node cli/kmxt.js cleanup-sessions` 一并清理；未到期的
`revoked` 记录保留到自身 `expiresAt`，用于审计状态变化。

管理后台与客户端的责任边界是：后台只决定制品清单和状态，客户端只能在
`active` 状态下凭有效卡密会话、同一设备绑定和临时 X25519 公钥请求租约。
管理列表不会返回 `wrappedDek`；该字段只出现在通过会话、设备、Nonce 和签名
约束的客户端租约响应中。作者：花落；协议：MIT。

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
| 409 | `ARTIFACT_REVOKED` | 已吊销制品是终态，不能恢复为草稿或启用。 |
| 403 | `ARTIFACT_UNAVAILABLE` | Artifact 未激活或已吊销。 |
| 404 | `ARTIFACT_NOT_FOUND` | Artifact 不存在或不属于该程序。 |
| 400 | `INVALID_CLIENT_KEY` | 客户端临时 X25519 公钥无效。 |
| 503 | `ARTIFACT_KEY_UNAVAILABLE` | Artifact DEK 无法解密或包裹。 |
| 401 | `ORDER_QUERY_INVALID` | 订单号或查询码错误。 |
| 413 | `BODY_TOO_LARGE` | 请求体超过配置上限。 |
| 429 | `RATE_LIMITED` | 请求过多，参考 `Retry-After` 响应头。 |
