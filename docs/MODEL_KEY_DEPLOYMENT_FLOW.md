# KMXT 模型密钥下发完整流程（端到端）

作者：花落 | 协议：MIT | 最后更新：2026-07-24

---

## 📋 概述

本文档详细说明 **KMXT 模型密钥（DEK）如何安全地从服务端下发到 Android 客户端**，回答「我怎么下发 DEK 到客户端？」的完整流程。

---

## 🔐 核心设计原则

1. ✅ **DEK 永不明文传输**：通过 X25519 临时密钥交换 + HKDF + AES-GCM 封装
2. ✅ **DEK 永不落盘**：Native 内存 handle，用后即擦除
3. ✅ **单次有效**：每个租约有独立的临时公钥和 Nonce，不可重放
4. ✅ **强身份验证**：Ed25519 签名 + 设备指纹 + 会话令牌三重验证
5. ✅ **管理员不可见 DEK**：后台只显示加密后的 `encryptedDek`

---

## 🚀 完整流程（6 个阶段）

### 阶段 1：模型加密与登记（开发者/运维）

```bash
# 1. 使用 KMXT CLI 加密模型
cd /f/kmxt
node src/cli/kmxt-cli.js encrypt-model \
  --input Delta_INT8_192.onnx \
  --output Delta_INT8_192.vmp \
  --format onnx \
  --key-version 1

# 输出示例：
# ✅ 加密完成
# 内容密钥 DEK (Base64URL): kX9mP3vR8sT2uY5wZ7aB4cD6eF1gH0iJ9kL2mN5oP8qR
# Nonce: A1B2C3D4E5F6G7H8
# Tag: I9J0K1L2M3N4O5P6Q7R8S9
# 密文 SHA-256: 3a7f8b12c4d5e67f89a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2
# 密文大小: 2457600 字节

# 2. 登记到 KMXT 后台（通过 API 或 Web UI）
curl -X POST https://kmxt.moluhualuo.top/api/v1/apps/{appId}/artifacts \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Delta_INT8_192",
    "version": "1.0",
    "format": "onnx",
    "cipherSha256": "3a7f8b12c4d5e67f89a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2",
    "size": 2457600,
    "encryption": {
      "algorithm": "AES-256-GCM",
      "nonce": "A1B2C3D4E5F6G7H8",
      "tag": "I9J0K1L2M3N4O5P6Q7R8S9"
    },
    "contentKey": "kX9mP3vR8sT2uY5wZ7aB4cD6eF1gH0iJ9kL2mN5oP8qR",
    "keyVersion": 1
  }'

# ⚠️ contentKey 只在此次注册时传输（HTTPS），之后永不返回
```

**服务端处理**：
```javascript
// src/services/model-delivery-service.js:195
encryptedDek: encryptArtifactKey(this.rootSecret, artifactId, contentKey)
// ↓ 使用服务端 rootSecret 加密 DEK，存入数据库
// ↓ API 返回时 presentArtifact() 过滤掉 contentKey 字段
```

---

### 阶段 2：APK 打包（构建时）

```bash
# 1. 将 .vmp 密文复制到 assets
cp Delta_INT8_192.vmp /f/ScreenYolo/ScreenYolo-/app/src/main/assets/

# 2. 在 build.gradle 映射 artifact UUID
android {
  defaultConfig {
    buildConfigField "String", "MODEL_DELTA_192_ARTIFACT_ID", '"ab12cd34-..."'
    buildConfigField "String", "MODEL_DELTA_192_SHA256", '"3a7f8b12c4d5..."'
  }
}

# 3. 构建 APK
gradle :app:assembleRelease
```

**APK 内容**：
- ✅ `assets/Delta_INT8_192.vmp`（密文）
- ✅ `BuildConfig.MODEL_DELTA_192_ARTIFACT_ID`（UUID）
- ❌ **不包含 DEK**（DEK 由服务端动态下发）

---

### 阶段 3：用户激活卡密（运行时）

```kotlin
// Android 客户端代码
val client = KmxtLicenseClient(context, KmxtConfig(
    baseUrl = "https://kmxt.moluhualuo.top",
    appId = BuildConfig.KMXT_APP_ID,
))

// 1. 用户输入卡密并激活
val result = client.activate("KMXT-XXXX-XXXX-XXXX-XXXX")
if (!result.isSuccess) {
    showError("激活失败：${result.error}")
    return
}

// 2. 验证授权（每次启动 + 心跳）
val verified = client.verify()
if (!verified.isAuthorized) {
    showError("授权已过期")
    return
}

Log.i("KMXT", "授权有效，到期时间：${verified.expiresAt}")
```

**服务端处理**：
- ✅ 验证卡密有效性、设备数量上限、有效期
- ✅ 生成会话令牌（AES-GCM 加密），绑定设备指纹
- ✅ 客户端用 Android Keystore 加密保存会话令牌

---

### 阶段 4：请求模型租约（关键步骤！）

```kotlin
// 客户端代码：加载模型前请求租约
suspend fun loadModel(artifactId: String): ByteArray {
    // 1. 请求租约（内部生成临时 X25519 密钥对）
    val lease = client.requestModelLease(artifactId)
    
    try {
        // 2. 读取 assets 中的 .vmp 密文
        val ciphertext = context.assets.open("Delta_INT8_192.vmp").readBytes()
        
        // 3. 校验完整性（防篡改）
        val actualSha256 = MessageDigest.getInstance("SHA-256")
            .digest(ciphertext).toHex()
        if (actualSha256 != BuildConfig.MODEL_DELTA_192_SHA256) {
            throw SecurityException("模型文件已被篡改！")
        }
        
        // 4. 用租约解密（调用 native，消费一次性 handle）
        val plaintext = lease.decrypt(ciphertext)
        
        return plaintext
    } finally {
        // 5. 擦除 native 内存中的 DEK handle
        lease.wipe()
    }
}
```

**网络请求详情**：

```http
POST /api/v1/leases/model-artifacts
Authorization: Bearer <会话令牌>
Content-Type: application/json

{
  "artifactId": "ab12cd34-ef56-7890-ab12-cd34ef567890",
  "clientPublicKey": "BASE64URL_X25519_PUBLIC_KEY",  // 临时生成
  "requestNonce": "RANDOM_NONCE"                     // 防重放
}
```

**服务端处理**：

```javascript
// src/services/model-delivery-service.js:352
const secretText = decryptText(
    this.rootSecret, 
    `artifact-dek:${artifact.id}`, 
    artifact.encryptedDek
);
const contentKey = decodeBase64Url(secretText);

// 用客户端临时公钥 + HKDF-SHA256 封装 DEK
const wrapped = wrapKey(contentKey, clientPublicKey, associatedData);

return {
    lease: {
        id: leaseId,
        artifactId,
        algorithm: 'X25519-HKDF-AES-GCM',
        wrappedKey: wrapped.ciphertext,     // 加密的 DEK
        ephemeralPublicKey: wrapped.serverPublicKey,  // 服务端临时公钥
        expiresAt: now + 300000  // 5 分钟有效期
    },
    signature: ed25519Sign(lease, serverPrivateKey)
};
```

---

### 阶段 5：客户端解包 DEK（Native）

```cpp
// KMXT SDK Native 代码（sdk/android/cpp/lease_crypto.cpp）

// 1. 验证 Ed25519 签名
if (!verifyLeaseSignature(response, trustedPublicKey)) {
    throw SecurityException("租约签名无效");
}

// 2. ECDH 密钥交换
shared_secret = X25519(clientPrivateKey, response.ephemeralPublicKey);

// 3. HKDF 派生解密密钥
aes_key = HKDF_SHA256(
    shared_secret, 
    salt: "kmxt-lease-v1",
    info: artifactId + requestNonce
);

// 4. AES-256-GCM 解密 DEK
contentKey = AES_GCM_decrypt(
    response.wrappedKey,
    aes_key,
    nonce: response.nonce,
    tag: response.tag
);

// 5. 存入临时 handle 表（不暴露给 Java）
handleId = storeHandle(contentKey, expiresAt);
return handleId;  // 返回给 Kotlin 层
```

**安全特性**：
- ✅ 客户端 X25519 私钥只在内存，用后擦除
- ✅ DEK 只在 Native 层，Java 层拿不到明文
- ✅ Handle 有硬过期时间（5 分钟），到期自动擦除

---

### 阶段 6：解密模型并推理

```kotlin
// 最终使用（在 NanoDetDetector / NcnnNanoDetDetector 中）
val plainModel = lease.decrypt(ciphertext)  // 调用 native

// 喂给推理引擎
val ortSession = OrtEnvironment.getEnvironment()
    .createSession(plainModel)  // ONNX Runtime

// 或
val ncnnNet = NcnnNanoDetDetector()
ncnnNet.loadModelFromMemory(plainModel)  // ncnn

// plainModel 用完后擦除
plainModel.fill(0)
lease.wipe()  // 清理 native handle
```

---

## 🔍 关键问题解答

### Q1：为什么后台不显示 DEK？

**A**：这是**正确的安全设计**，原因：
1. 管理员不需要知道 DEK（客户端通过租约自动获取）
2. 防止内部威胁（管理员账号被盗 → 攻击者拿不到 DEK）
3. 符合最小权限原则（DEK 只在需要时动态下发）

### Q2：DEK 什么时候下发？

**A**：**每次客户端调用 `requestModelLease()` 时**，动态下发，不是构建时写死。

### Q3：密文 SHA-256 的作用？

**A**：
- ✅ 客户端校验文件完整性（防篡改）
- ✅ 运维快速识别模型版本
- ✅ 防止重复上传

### Q4：如果需要导出 DEK 怎么办？

**A**：查看 `F:/kmxt/SECURITY_DEK_VISIBILITY_PROPOSAL.md`，但**强烈不推荐**实现此功能。

---

## 📊 数据流对比表

| 阶段 | DEK 位置 | 加密状态 | 谁能访问 |
|------|----------|----------|----------|
| **开发者加密** | 本地内存 | 明文 | 开发者（用后擦除） |
| **上传到 KMXT** | HTTPS body | 明文（TLS 保护） | 仅本次请求 |
| **服务端存储** | `encryptedDek` | `rootSecret` 加密 | 无人（需 rootSecret 解密） |
| **管理后台** | ❌ 不返回 | - | 管理员看不到 |
| **签发租约** | `wrappedKey` | X25519+HKDF+AES-GCM | 仅目标客户端 |
| **客户端 Native** | 临时 handle | 内存明文 | 仅当前进程 |
| **用后清理** | 擦除 | - | 无人 |

---

## ✅ 验证清单

打钩表示已正确实现：

- [x] 服务端用 `rootSecret` 加密 DEK 存储
- [x] API 返回时过滤 `contentKey` 字段
- [x] 前端不显示 DEK（只显示 SHA-256）
- [x] 签发租约时用 X25519+HKDF+AES-GCM 封装
- [x] 客户端 Native 解包后存为临时 handle
- [x] Handle 有硬过期时间（5 分钟）
- [x] 用后调用 `lease.wipe()` 擦除
- [x] APK 只打包密文 .vmp，不含 DEK

---

## 🛠️ 故障排查

### 症状 1：客户端报 "租约请求失败"

**诊断**：
```bash
# 1. 检查会话是否有效
adb logcat | grep "KMXT.*verify"

# 2. 检查 artifact 是否启用
curl -H "Authorization: Bearer $TOKEN" \
  https://kmxt.moluhualuo.top/api/v1/apps/{appId}/artifacts/{artifactId}
# 确认 status == 'active'
```

### 症状 2：解密失败 "Invalid authentication tag"

**可能原因**：
- APK 中的 .vmp 文件已损坏
- SHA-256 不匹配（文件被篡改）
- 加密时的 Nonce/Tag 与登记的不一致

**修复**：
```bash
# 重新加密并上传
node src/cli/kmxt-cli.js encrypt-model --input model.onnx --output model.vmp
# 复制新的 Nonce/Tag/SHA-256 到登记表单
```

### 症状 3：Handle 过期错误

**原因**：租约默认 5 分钟有效期，超时后 handle 自动擦除。

**修复**：
- 将 `requestModelLease()` 放在真正需要解密前调用
- 不要在启动时预先请求租约

---

## 📚 相关文档

| 文档 | 路径 | 用途 |
|------|------|------|
| **Android SDK 接入** | `F:/kmxt/docs/ANDROID_SDK.md` | 客户端集成指南 |
| **模型制品发布** | `F:/kmxt/docs/MODEL_ARTIFACT_PUBLISHING.md` | 服务端 API 说明 |
| **DEK 可见性安全** | `F:/kmxt/SECURITY_DEK_VISIBILITY_PROPOSAL.md` | 如何安全地导出 DEK（不推荐） |
| **ScreenYolo 发布工具** | `F:/ScreenYolo/tools/publish_model.ps1` | 一键加密+部署脚本 |

---

## 🎯 总结

**DEK 下发流程核心**：
1. 开发者上传时，DEK 用 `rootSecret` 加密存储
2. 客户端激活卡密后，获得会话令牌
3. 需要模型时，调用 `requestModelLease(artifactId)`
4. 服务端解密 DEK，用客户端临时公钥重新封装
5. 客户端 Native 层解包 DEK，存为临时 handle
6. 用 handle 解密 .vmp 文件，喂给推理引擎
7. 用后擦除 handle 和明文

**关键安全点**：
- ✅ DEK 永不明文传输（X25519+HKDF+AES-GCM）
- ✅ DEK 永不落盘（Native 内存 handle）
- ✅ DEK 单次有效（临时密钥 + Nonce）
- ✅ 管理员看不到 DEK（防内部威胁）

---

**如有疑问，请参考**：
- 服务端源码：`F:/kmxt/src/services/model-delivery-service.js`
- 客户端源码：`F:/kmxt/sdk/android/kmxt-sdk/src/main/java/top/moluhualuo/kmxt/KmxtLicenseClient.kt`
- Native 加密：`F:/kmxt/sdk/android/cpp/lease_crypto.cpp`
