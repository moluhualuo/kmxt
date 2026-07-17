# KMXT 0.6.0 产品化接口与模块

作者：花落  
协议：MIT  
编码：UTF-8（无 BOM）

## 新增模块

| 模块 | 作用 |
| --- | --- |
| `src/services/dashboard-service.js` | 在当前角色与租户范围内聚合商户、程序、待审订单、卡密、有效设备绑定和最近 24 小时验证结果。 |
| `migrations/002_productization_indexes.sql` | 为账号状态、程序状态、批次、订单、绑定、会话和日志查询增加定向索引，并将数据库结构版本提升为 3。 |
| `test/productization.test.js` | 验证资料编辑、无限设备默认值、批次分页、Dashboard、就绪检查和账号停用撤销会话。 |
| `test/e2e.test.js` | 通过真实 HTTP 流程覆盖就绪检查、角色越权、商户/程序编辑、账号停用、批次明文边界、店铺发卡和解绑后重绑。 |
| `test/production-infra.test.js` | 验证安全状态契约、迁移索引、只读 secret 部署模板和拒绝覆盖非空数据库的恢复保护。 |
| `scripts/check-utf8.mjs` | 校验本阶段 Web、服务端、测试、文档和部署文本均为 UTF-8 无 BOM；已纳入 `npm run check`。 |

## 新增或完善 API

### `GET /ready`

无需认证。检查业务存储、共享安全状态和根密钥是否可用。成功返回：

```json
{
  "success": true,
  "data": {
    "status": "ready",
    "checks": { "storage": true, "security": true, "rootKey": true }
  }
}
```

`GET /health` 仍只用于轻量存活探测，版本号为 `0.6.0`。

### `GET /api/v1/dashboard?merchantId=&appId=`

需要管理端登录。平台管理员可选择商户；商户管理员和操作员始终限制在自身商户。`appId` 会再次校验租户归属。返回统计字段：`merchants`、`applications`、`pendingOrders`、`licenses`、`activeBindings` 和 `verification24h`。

### `PATCH /api/v1/platform/merchants/:merchantId`

仅平台管理员。请求体 `{ "name": "新名称" }`；唯一代码不可修改。操作写入 `merchant.update` 审计日志。

### `PATCH /api/v1/apps/:appId`

平台管理员或所属商户管理员。可修改 `name`、`description` 以及 `settings` 中的 `defaultDurationDays`、`defaultMaxDevices`、`heartbeatSeconds`、`offlineGraceSeconds`。`defaultMaxDevices=0` 表示无限制。此接口不会轮换签名密钥。

### `PATCH /api/v1/users/:userId/status`

平台管理员或所属商户管理员。状态只能是 `active` 或 `disabled`。停用会在同一事务中撤销该账号全部管理会话；禁止管理员停用自身账号。

### `GET /api/v1/apps/:appId/license-batches?page=1&limit=20`

返回批次元数据分页列表。该接口不返回卡密明文；新版本由平台管理员或所属商户管理员在卡密列表中对单张卡密显式、受审计地查看。

## 登录保护

登录同时受 IP 维度速率限制和账号维度失败窗口保护。账号键只使用规范化用户名，不保存密码；15 分钟窗口超过 10 次尝试返回 `LOGIN_ACCOUNT_LOCKED`，成功登录后清除该账号计数。生产环境计数位于 Redis，开发环境使用内存实现。

## 当前存储边界

本次已增加 `002` 查询索引和业务 API；MySQL 兼容层已移除连接级 advisory lock，并只写回变化行。Dashboard、订单创建/查询/拒绝/发卡、客户端验证、卡密批量生成/查询/停用/解绑、管理员账号/会话、商户、程序、商品、日志和维护均已迁为按领域定向 SQL Repository。当前生产部署边界仍为单 Node 实例，不能据此扩展为多实例写入。

管理后台入口已将总览、商户、程序、卡密、商品、订单、账号和日志渲染拆分为独立 ES 模块，并继续复用统一分页、筛选、对话框与转义组件。所有角色按钮仍同时接受前端隐藏与服务端权限校验。

## 筛选与维护命令

- 订单列表支持 `status`、`orderNo`、`from`、`to`。
- 审计日志支持 `action`、`from`、`to`。
- 验证日志支持 `event`、`resultCode`、`from`、`to`。
- `node cli/kmxt.js doctor` 检查 Node 版本、存储、安全状态和根密钥。
- `node cli/kmxt.js cleanup-sessions` 清理过期管理会话和客户端会话。
- `node cli/kmxt.js cleanup-verification-logs --retention-days 90` 按保留期清理验证日志。
- `npm run check` 同时执行关键 JavaScript 语法检查和 UTF-8 无 BOM 编码检查。

两个清理命令都在事务中写入不含敏感数据的审计摘要。
