# 模型 DEK 可见性安全方案（可选高级功能）

## 当前状态
- ✅ DEK 加密存储在 `encryptedDek` 字段
- ✅ API 返回时不包含 DEK（`presentArtifact` 过滤）
- ✅ 只在签发租约时解密 DEK 并封装给客户端

## 如果需要管理员查看 DEK（风险功能）

### 使用场景
1. **紧急迁移**：需要导出加密参数到其他系统
2. **故障排查**：验证 DEK 是否正确加密/解密
3. **手动封装**：测试环境手动生成租约

### 安全措施

#### 1. 单独的 API 端点（需要二次确认）
```javascript
// GET /api/v1/artifacts/:id/content-key
// 返回：{ contentKey: "base64url...", warning: "此密钥可解密所有该制品的密文" }
async revealContentKey(actor, artifactId) {
  assertRole(actor, [Roles.PLATFORM_ADMIN]); // 仅超级管理员
  
  const artifact = await this.store.findArtifact(artifactId);
  const dek = decryptText(this.rootSecret, `artifact-dek:${artifactId}`, artifact.encryptedDek);
  
  // 记录审计日志
  await AuditService.append({
    actor,
    action: 'model-artifact.reveal-dek',
    resourceType: 'model_artifact',
    resourceId: artifactId,
    severity: 'critical',
    metadata: { reason: 'manual_export' },
  });
  
  return { contentKey: dek };
}
```

#### 2. 前端二次确认弹窗
```javascript
// 在 renderStatusActions() 添加按钮（仅超级管理员）
if (isPlatformAdmin() && artifact.status !== 'revoked') {
  actions.push(['reveal-dek', '导出密钥', 'key', 'danger']);
}

// 事件处理
else if (action === 'reveal-model-dek') {
  const confirmed = await confirmAction({
    title: '⚠️ 导出内容密钥',
    message: '此操作将显示可解密该模型的主密钥，任何获得该密钥的人都能永久解密模型文件。本次查看会写入审计记录。确认导出？',
    confirmLabel: '确认导出（高危）',
    tone: 'danger',
  });
  if (confirmed) {
    const result = await api.get(`/api/v1/artifacts/${id}/content-key`);
    openContentDialog({
      title: '内容密钥 DEK',
      content: `<div class="form-stack">
        <p class="field-hint danger">⚠️ 请妥善保管，不要通过不安全的渠道传输！</p>
        <div class="field"><label>Base64URL（32 字节）</label><input class="input mono" readonly value="${escapeHtml(result.contentKey)}" onclick="this.select()"></div>
      </div>`,
    });
  }
}
```

#### 3. 审计日志强化
```sql
-- 定期检查异常的 DEK 查看行为
SELECT actor_id, COUNT(*), MAX(created_at)
FROM audit_logs
WHERE action = 'model-artifact.reveal-dek'
GROUP BY actor_id
HAVING COUNT(*) > 5  -- 超过 5 次查看需要人工审查
ORDER BY COUNT(*) DESC;
```

## 推荐方案：不实现此功能

**理由**：
1. 正常运营不需要查看 DEK（客户端通过租约自动获取）
2. 迁移/备份应该直接导出数据库（包含加密后的 `encryptedDek`）
3. 增加攻击面（钓鱼/社工/内部威胁）

**替代方案**：
- 需要迁移时，导出整个 `model_artifacts` 表（包含 `encryptedDek`）
- 新系统用相同的 `rootSecret` 即可自动解密
- 如果 `rootSecret` 不同，编写离线脚本批量重加密

## 结论

✅ **当前设计是正确的**：管理页面不显示 DEK
❌ **不建议添加"查看 DEK"功能**，除非有明确的合规/运营需求
⚠️ **如果必须添加**，严格按照上述安全措施实施
