# 客户端接入

Android API 24 / arm64-v8a 的严格在线 SDK、Keystore、设备指纹和生命周期接入见 [ANDROID_SDK.md](./ANDROID_SDK.md)。Node 与 Android 客户端共用 v1 激活/验证协议。

程序验证的信任根是随正式程序一起发布的 Ed25519 公钥。HTTP 连接只负责传输；即使返回 `200`，也必须验证签名后才允许程序进入授权功能。

## 接入准备

1. 商户管理员创建程序。
2. 从创建程序响应取得 `appId`、`signing.keyId` 和 `signing.publicKey`。
3. 将这三个值固定进正式程序或受保护配置。
4. 创建卡密并将明文安全交付用户。
5. 程序生成稳定、非敏感的设备 ID，通过 HTTPS 激活。

不要在运行时从 `/api/v1/client/apps/:appId/config` 下载公钥后立即信任。攻击者若同时能替换响应，就能替换公钥。公开配置接口用于开发接入和人工核对。

## Node.js SDK

SDK 位于 `sdk/node/license-client.js`，无第三方依赖。

```js
import { LicenseClient } from './sdk/node/license-client.js';

const client = new LicenseClient({
  baseUrl: 'https://license.example.com',
  appId: '固定的程序 UUID',
  keyId: '固定的签名 keyId',
  publicKey: `-----BEGIN PUBLIC KEY-----
固定的程序公钥
-----END PUBLIC KEY-----`,
  deviceId: '由程序生成并稳定保存的设备标识',
  clientVersion: '1.0.0',
});

const activation = await client.activate(userInputLicense, {
  deviceLabel: 'Office PC',
});

// sessionToken 应保存到操作系统凭据存储，不应写入普通日志。
await saveSecurely(activation.sessionToken);

const verified = await client.verify(await readSecurely());
if (verified.licensed !== true) {
  throw new Error('Authorization denied');
}

// 用户选择“解绑本机”时，SDK 会验证服务端签名的解绑确认。
const unbound = await client.unbind(await readSecurely());
if (unbound.unbound === true) {
  await deleteSecurelyStoredSession();
}
```

SDK 自动完成：

- 创建毫秒时间戳和随机 Nonce。
- 远程 `baseUrl` 必须使用 HTTPS；仅 `localhost`、`127.0.0.1` 和 `[::1]` 允许本地 HTTP 调试。
- 为请求设置 `redirect: error`，并拒绝跟随重定向的响应。
- 检查 HTTP 和统一错误响应。
- 检查签名算法、`keyId` 和 `appId`。
- 用固定公钥验证 Ed25519 签名。
- 验签后严格比较已签名 `requestNonce` 与当前请求 Nonce。
- 检查 `licensed === true` 和卡密到期时间。
- 主动解绑时检查签名、固定程序、`unbound === true` 和 `DEVICE_UNBOUND`。

网络错误、签名错误、响应解析错误均以拒绝授权处理。不要在异常时默认放行。
Node SDK 当前只覆盖卡密激活、心跳和主动解绑；模型租约仍由 Android app-specific SDK 提供，
不能把普通 Node 客户端收到的模型元数据当作 DEK 或授权凭据。

## 设备标识

设备标识需要稳定，但不应直接使用单一 MAC 地址或硬盘序列号。建议生成应用专属随机 ID，保存在操作系统安全存储中；确实需要硬件绑定时，可组合多个硬件特征后先在客户端做单向摘要。服务端收到后还会按程序再次做 HMAC 摘要，数据文件不保存设备原文。

设备 ID 长度必须为 8 到 256 字节。用户重装系统或清除安全存储后通常会得到新设备 ID，需要在管理端解绑旧设备。

## 激活和心跳顺序

```text
输入卡密
  -> POST /client/activate
  -> 验证 Ed25519 签名
  -> 安全保存 sessionToken
  -> 启用授权功能
  -> 按 heartbeatAfterSeconds 调用 /client/verify
  -> 每次验证签名和到期时间
  -> 用户主动解绑时调用 /client/unbind
  -> 验证签名解绑确认后删除本地 sessionToken
```

主动解绑必须使用当前会话和同一设备 ID，不能只在本地删除令牌。服务端成功处理后会将设备绑定标记为 `revoked`、撤销该设备全部会话并释放设备名额；下次使用需要重新输入卡密激活。

每次请求必须使用新的 Nonce，并只接受 `requestNonce` 与本次请求完全一致的已签名响应。即使旧信封签名有效，也不能用于新的激活、心跳或解绑请求。客户端时钟偏差超过服务端窗口时会收到 `STALE_REQUEST`，此时应提示用户同步系统时间，不能绕过验证。

## 离线策略

`offlineGraceSeconds` 是程序策略提示，服务端不会替客户端执行离线放行。客户端如支持短时离线，应缓存最后一次已验证的签名信封，并同时满足：

- 签名仍有效。
- 当前时间没有超过 `licenseExpiresAt`。
- 当前时间距离 `issuedAt` 不超过 `offlineGraceSeconds`。
- 本地时间没有明显回拨。

高风险软件建议不启用离线宽限。客户端本身可被修改，卡密系统只能提高绕过成本，不能从理论上阻止对客户端二进制的补丁修改。

## 其他语言

其他语言必须复现相同的规范化 JSON：对象键按 JavaScript 默认排序规则，即 UTF-16 代码单元字典序排列；数组保持顺序且不添加空白，然后对 UTF-8 字节执行 Ed25519 验签。优先移植 `sdk/node/license-client.js` 中的规则，并用服务端真实响应制作跨语言测试向量。
