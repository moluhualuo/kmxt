# KMXT 卡密验证服务

KMXT 是一个使用 Node.js 20 开发的多租户卡密服务。当前版本 `0.6.0` 支持 MySQL 8 + Redis 生产存储与 Android NDK SDK。平台可创建多个商户，每个商户可管理多个独立程序；卡密、设备、签名密钥和日志均按 `merchantId` 与 `appId` 隔离。

作者：花落  
许可证：MIT

## 当前功能

- 平台管理员、商户管理员、操作员三级权限
- 账号自助修改密码、商户账号管理员重置与会话撤销
- 多商户、多程序数据隔离
- 每个程序独立 Ed25519 签名密钥
- 批量生成按天或固定到期时间的卡密
- 首次激活、设备绑定、设备数量限制和解绑
- 短期验证会话与心跳续期
- 时间戳、Nonce 防重放和接口速率限制
- 管理审计日志与程序验证日志
- 卡密摘要校验与 AES-256-GCM 加密副本存储，程序私钥 AES-256-GCM 加密存储
- JSON 开发存储与 MySQL 8 TLS 生产存储
- Redis 原子 Nonce 与跨进程限流
- Node.js SDK 及 Android API 24 / arm64-v8a C++17 + Kotlin SDK
- 内置响应式 Web 管理后台
- 商户独立用户店铺、无支付订单和人工审核发卡

## 快速启动

要求 Node.js 20 或更高版本。首次运行执行 `npm install`；本地默认使用 JSON 适配器。

```powershell
node cli/kmxt.js init
node cli/kmxt.js create-admin --username admin --password "Change-This-Password!"
npm start
```

默认监听 `http://127.0.0.1:8080`，健康检查地址为：

```text
GET http://127.0.0.1:8080/health
```

管理后台地址：

```text
http://127.0.0.1:8080/admin/
```

用户店铺地址使用商户代码：

```text
http://127.0.0.1:8080/store/MERCHANT_CODE
```

当前订单模式不接入支付。用户提交订单后，商户在后台“订单”页面审核并发卡，用户凭订单号和查询码领取。

管理员登录：

```powershell
$body = @{ username = 'admin'; password = 'Change-This-Password!' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/v1/auth/login -ContentType application/json -Body $body
```

`create-admin` 只允许在不存在平台管理员时执行。新生成卡密使用根密钥派生的密钥加密保存；平台管理员或所属商户管理员可在后台显式查看单张卡密，查看会写入审计记录。卡密列表、批次记录和日志不返回明文。

## 常用命令

```powershell
node cli/kmxt.js status
node cli/kmxt.js serve --host 127.0.0.1 --port 8080
npm test
npm run check
```

配置通过环境变量传入，示例见 [.env.example](./.env.example)。程序不会自动读取 `.env` 文件，部署系统应直接设置环境变量。

## 项目结构

```text
cli/                 管理与启动命令
docs/                API、模块、安全和部署文档
public/              管理后台及本地视觉资源
sdk/node/            Node.js 程序端验证 SDK
sdk/android/         Android NDK C++17 与 Kotlin/OkHttp SDK
migrations/          MySQL 8 版本化 SQL
deploy/              Compose、Nginx、预检和备份资产
src/core/            错误与输入校验
src/http/            路由、限流与 HTTP 协议
src/security/        密码、摘要、加密、签名和防重放
src/services/        认证及业务服务
src/storage/         数据结构与原子持久化
test/                自动化测试
data/                运行数据及根密钥，默认被 Git 忽略
```

## 文档

- [API 接口](./docs/API.md)
- [模块说明](./docs/MODULES.md)
- [客户端接入](./docs/CLIENT_INTEGRATION.md)
- [管理后台](./docs/ADMIN_UI.md)
- [用户店铺](./docs/STOREFRONT.md)
- [安全设计](./docs/SECURITY.md)
- [部署说明](./docs/DEPLOYMENT.md)
- [MySQL 与 Redis](./docs/STORAGE.md)
- [Android SDK](./docs/ANDROID_SDK.md)

## 部署边界

JSON 适配器只用于本地开发。生产使用 MySQL 8 与独立 Redis，但当前仍明确限制单个 Node.js 服务实例，不做 JSON 数据迁移或双写。无论采用哪种存储，都必须通过 HTTPS 对外提供客户端接口。
