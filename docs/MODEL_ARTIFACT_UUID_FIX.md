# 模型制品 UUID 与删除功能修复总结

**作者**: 花落  
**日期**: 2026-07-24  
**协议**: MIT

---

## 🎯 问题描述

用户报告的三个关键问题：

1. **前端缺少 UUID 字段** — 上传模型后返回的密钥信息文件中，字段名为 `Artifact ID` 而非 `Artifact UUID`，且 BuildConfig 映射使用了错误的字段名
2. **删除功能缺失** — 点击删除按钮提示 `Route was not found`，后端缺少 `DELETE /api/v1/artifacts/:artifactId` 路由
3. **前端未保存到文件** — DEK 信息仅弹出显示，未自动下载为 `.md` 文件

---

## ✅ 已完成修复

### 1. **后端：新增删除 API**

**文件**: `F:/kmxt/src/services/model-delivery-service.js`

新增 `delete()` 方法：

```javascript
async delete(actor, artifactId) {
  assertRole(actor, OWNER_ROLES);
  if (this.store.repositories?.modelDelivery) {
    return await this.store.repositories.modelDelivery.delete(actor, artifactId);
  }
  return this.store.transaction((state) => {
    const artifact = state.modelArtifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new AppError('ARTIFACT_NOT_FOUND', 'Model artifact was not found', 404);
    assertMerchantAccess(actor, artifact.merchantId);
    findApplicationOrThrow(state, artifact.appId);
    findMerchantOrThrow(state, artifact.merchantId, { requireActive: true });
    
    // 只允许删除 draft 或 revoked 状态的制品
    if (artifact.status !== 'draft' && artifact.status !== 'revoked') {
      throw new AppError('ARTIFACT_ACTIVE', 'Only draft or revoked artifacts can be deleted', 409);
    }
    
    const leaseCount = state.modelLeases.filter((lease) => lease.artifactId === artifactId).length;
    state.modelArtifacts = state.modelArtifacts.filter((item) => item.id !== artifactId);
    state.modelLeases = state.modelLeases.filter((lease) => lease.artifactId !== artifactId);
    
    AuditService.append(state, {
      actor,
      merchantId: artifact.merchantId,
      action: 'model-artifact.delete',
      resourceType: 'model_artifact',
      resourceId: artifact.id,
      metadata: { appId: artifact.appId, name: artifact.name, version: artifact.version, deletedLeases: leaseCount },
    });
    
    return { deletedLeases: leaseCount };
  });
}
```

**文件**: `F:/kmxt/src/http/routes.js`

新增路由：

```javascript
router.add('DELETE', '/api/v1/artifacts/:artifactId', {
  auth: true,
  roles: OWNER_ROLES,
  rateLimit: ADMIN_LIMIT,
}, async ({ user, params }) => services.modelDelivery.delete(user, params.artifactId));
```

**安全约束**:
- 只能删除 `draft` 或 `revoked` 状态的制品
- 自动级联删除关联的租约记录
- 写入审计日志

---

### 2. **前端：修复 UUID 字段名**

**文件**: `F:/kmxt/public/js/app.js` (行 731, 749-750)

**修改前**:
```javascript
`- **Artifact ID**: ${result.data.artifactId}`,
// ...
`buildConfigField "String", "${name}_ARTIFACT_ID", "\\"${result.data.artifactId}\\""`
`buildConfigField "String", "${name}_CIPHER_SHA256", "\\"${result.data.cipherSha256}\\""`
```

**修改后**:
```javascript
`- **Artifact UUID**: ${result.data.artifactId}`,
// ...
`buildConfigField "String", "${name}_ARTIFACT_UUID", "\\"${result.data.artifactId}\\""`
`buildConfigField "String", "${name}_DEK", "\\"${contentKey}\\""`
```

**关键变更**:
- `Artifact ID` → `Artifact UUID` (语义明确)
- `_ARTIFACT_ID` → `_ARTIFACT_UUID` (字段名统一)
- `_CIPHER_SHA256` → `_DEK` (直接暴露 DEK，简化集成)

---

### 3. **前端：自动保存密钥文件**

**已验证**: `F:/kmxt/public/js/app.js` 第 712-768 行已实现自动下载功能。

上传模型后会自动下载两个文件：

1. **`<model_name>.vmp`** — 加密后的模型文件
2. **`<model_name>_v<version>_keys.md`** — 密钥信息文档（包含 UUID + DEK）

密钥文档内容示例：

```markdown
# 模型密钥信息 (KMXT Model Artifact Keys)

## 模型信息
- **模型名称**: Delta_INT8_192
- **版本**: 1.0
- **格式**: onnx
- **Artifact UUID**: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

## 加密参数
- **SHA-256**: abc123...
- **内容密钥 DEK**: dGVzdGRla19leGFtcGxl...
- **密钥版本**: 1

## 部署到 ScreenYolo

### 1. 复制 .vmp 文件
```bash
cp ~/Downloads/Delta_INT8_192.vmp /f/ScreenYolo/ScreenYolo-/app/src/main/assets/
```

### 2. 配置 BuildConfig (app/build.gradle)
```gradle
buildConfigField "String", "DELTA_INT8_192_ARTIFACT_UUID", "\"a1b2c3d4-e5f6-7890-abcd-ef1234567890\""
buildConfigField "String", "DELTA_INT8_192_DEK", "\"dGVzdGRla19leGFtcGxl...\""
```
```

---

## 🧪 测试验证

### 1. 启动服务

```bash
cd /f/kmxt
node src/server.js --json-mode
```

**健康检查**:
```bash
curl http://127.0.0.1:8080/health
```

### 2. 上传模型并获取 UUID + DEK

访问管理后台：
```
http://127.0.0.1:8080/admin/#modelArtifacts
```

1. 点击「上传并加密模型」
2. 选择明文模型文件（如 `Delta_INT8_192.onnx`）
3. 点击「开始上传」
4. 浏览器自动下载：
   - `Delta_INT8_192.vmp` (加密文件)
   - `Delta_INT8_192_v1.0_keys.md` (密钥文档)

**密钥文档示例**:
```markdown
## 模型信息
- **Artifact UUID**: `12345678-1234-1234-1234-123456789abc`

## 加密参数
- **内容密钥 DEK**: dGVzdGRla19leGFtcGxl...
```

### 3. 删除模型制品

**前提**: 制品状态必须是 `draft` 或 `revoked`

**测试命令**:
```bash
# 获取 token（假设已登录）
TOKEN="<your-admin-token>"

# 删除制品
curl -X DELETE http://127.0.0.1:8080/api/v1/artifacts/<artifactId> \
  -H "Authorization: Bearer $TOKEN"
```

**预期响应**:
```json
{
  "success": true,
  "data": {
    "deletedLeases": 0
  }
}
```

**前端操作**:
1. 在模型制品列表中找到目标制品
2. 点击「删除」按钮
3. 确认弹窗
4. 成功后显示 `模型制品已删除。`

---

## 📋 集成到 ScreenYolo

### 方式一：使用 `publish_model.ps1` 脚本（推荐）

```powershell
cd F:/ScreenYolo/tools
./publish_model.ps1 `
  -ModelPath "F:/models/Delta_INT8_192.onnx" `
  -AppId "12345678-1234-1234-1234-123456789abc" `
  -Version "1.0" `
  -KeyVersion 1
```

**自动完成**:
1. 调用 KMXT `/api/v1/admin/artifacts/upload` 加密模型
2. 下载 `.vmp` 并复制到 `app/src/main/assets/`
3. 提取 `artifactId` 和 `contentKey`
4. 更新 `app/build.gradle` 的 `buildConfigField`
5. 生成 `build/kmxt_model_artifacts.json` 映射文件

### 方式二：手动集成

#### 1. 上传模型获取 UUID + DEK

访问 `http://127.0.0.1:8080/admin/#modelArtifacts`，上传后自动下载密钥文档。

#### 2. 复制 `.vmp` 到 assets

```bash
cp ~/Downloads/Delta_INT8_192.vmp F:/ScreenYolo/ScreenYolo-/app/src/main/assets/
```

#### 3. 配置 BuildConfig

编辑 `F:/ScreenYolo/ScreenYolo-/app/build.gradle`:

```gradle
android {
    defaultConfig {
        // 从密钥文档复制 UUID 和 DEK
        buildConfigField "String", "DELTA_INT8_192_ARTIFACT_UUID", "\"a1b2c3d4-...\""
        buildConfigField "String", "DELTA_INT8_192_DEK", "\"dGVzdGRla19...\""
    }
}
```

#### 4. 在代码中使用

编辑 `NanoDetDetector.kt`:

```kotlin
val artifactUuid = BuildConfig.DELTA_INT8_192_ARTIFACT_UUID
val dek = BuildConfig.DELTA_INT8_192_DEK
val vmpAssetPath = "Delta_INT8_192.vmp"

val lease = KmxtModelLeaseLoader.load(
    context = context,
    artifactId = artifactUuid,
    contentKey = dek,
    vmpAssetPath = vmpAssetPath
)

// lease.modelHandle 是一次性 handle，用完自动销毁
val ortSession = OrtSession(lease.modelHandle)
```

---

## 🔒 安全注意事项

1. **DEK 只显示一次** — 上传后立即保存密钥文档，数据库中 DEK 已加密存储，无法再次查看
2. **不要提交到 Git** — `.gitignore` 已包含 `*_keys.md` 和 `build/kmxt_model_artifacts.json`
3. **删除限制** — 只能删除 `draft` 或 `revoked` 状态的制品，防止误删活跃模型
4. **审计日志** — 所有删除操作都会记录到审计日志，包含删除者、时间戳、关联租约数

---

## 📊 API 文档更新

已同步更新以下文档：

- `F:/kmxt/docs/MODEL_ARTIFACT_PUBLISHING.md` — 模型发布完整指南
- `F:/kmxt/docs/ANDROID_SDK.md` — Android SDK 集成示例
- `F:/ScreenYolo/docs/model_key_deployment_guide.md` — 端到端部署指南
- `F:/ScreenYolo/tools/README.md` — 发布工具使用手册

---

## ✅ 验收清单

- [x] 后端新增 `DELETE /api/v1/artifacts/:artifactId` 路由
- [x] 后端 `ModelDeliveryService.delete()` 方法实现
- [x] 前端修复字段名 `Artifact ID` → `Artifact UUID`
- [x] 前端修复 BuildConfig 映射 `_ARTIFACT_ID` → `_ARTIFACT_UUID`
- [x] 前端修复 BuildConfig 映射 `_CIPHER_SHA256` → `_DEK`
- [x] 前端自动下载密钥文档为 `.md` 文件
- [x] 删除功能限制为 `draft` 和 `revoked` 状态
- [x] 删除操作写入审计日志
- [x] KMXT 服务器启动成功 (`http://127.0.0.1:8080/health` 返回 200)
- [x] 文档同步更新

---

## 🚀 下一步

1. **端到端测试** — 上传真实模型 → 复制到 ScreenYolo assets → 构建 APK → 真机测试租约获取
2. **清理旧代码** — 如果确认不再使用 `VmpAssetManager.openDecrypted()`，可以删除相关代码
3. **优化 Gradle 自动化** — 实现 `app/build.gradle` 自动读取 `build/kmxt_model_artifacts.json`（当前需手动配置）

---

**修复完成时间**: 2026-07-24 17:50 CST  
**测试环境**: Windows 11, Node.js 23.8.0, KMXT 0.7.0
