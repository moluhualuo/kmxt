# 云模型 Artifact 发布

作者：花落
许可：MIT License

本文说明如何在构建机上把 ONNX、ncnn、TFLite 或 DLC 模型加密为
artifact，并通过 KMXT 管理 API 登记为 `draft`。工具不上传模型字节，KMXT 也不托管
密文；加密后的密文 `.vmp` 随 APK 打包进本地 `assets`，KMXT 只保存清单和经根密钥加密
的 DEK。运行期客户端读取本地密文，凭租约下发的 DEK 与 `cipherSha256` 校验并解密。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `src/tools/model-artifact-publisher.js` | 流式读取模型，生成随机 DEK/Nonce，执行 AES-256-GCM 加密，计算明文和密文 SHA-256/大小，调用 artifact 登记 API，并清零持有的 DEK。 |
| `cli/publish-model-artifact.js` | 校验命令参数，从环境变量或只读文件读取管理员令牌，调用发布模块，只输出不含 DEK/令牌的结果。 |
| `test/model-artifact-publisher.test.js` | 验证加密可逆性、摘要、Nonce/Tag 长度、登记请求、无密钥 manifest、API HTTPS 限制和明确拒绝时的密文清理。 |

发布工具使用整文件 AES-256-GCM。当前协议字段为：

| 字段 | 值 |
| --- | --- |
| DEK | 每个 artifact 独立随机 32 字节 |
| Nonce | 每个 artifact 独立随机 12 字节 |
| Tag | 16 字节，Base64URL 登记，不追加到密文文件 |
| `chunkSize` | `null`，表示整文件 GCM，不得当作分块密文处理 |
| `size` | 密文对象字节数，不含 Tag |
| `cipherSha256` | 密文对象的 SHA-256 小写十六进制 |

## 发布前提

1. KMXT 管理 API 使用有效 HTTPS 证书。
2. 管理令牌属于 `platform_admin`，或属于目标程序商户的 `merchant_admin`。
3. 目标程序必须处于 `active`；已禁用程序拒绝登记新制品。
4. 加密后的 `.vmp` 密文将随 APK/AAB 打包进本地 `assets`，服务端不托管密文。
   artifact 在密文打包与校验完成前必须保持 `draft`。
5. Release 构建目录与 APK/AAB 资产中不再包含原始 `.onnx`、`.param`、`.bin`、
   `.tflite` 或 `.dlc` 明文文件。
6. 构建机工作目录、临时目录和 CI 日志只能由发布账号访问。

管理员令牌不能作为命令行参数传入。优先使用进程级环境变量：

```powershell
$env:KMXT_ADMIN_TOKEN = '<short-lived-admin-token>'
$env:KMXT_API_URL = 'https://kmxt.example.com'
$env:KMXT_APP_ID = '<application-uuid>'
```

CI 也可以将令牌放在权限受限的临时文件中并使用 `--token-file`。该文件不得进入
Git、构建产物或缓存，任务完成后应由 CI secret 机制删除。

## 命令示例

```powershell
node cli/publish-model-artifact.js `
  --input F:\release\models\screenyolo-paid.onnx `
  --output F:\release\encrypted\screenyolo-paid.onnx.vmp `
  --name screenyolo-paid.onnx `
  --version 2026.07.22 `
  --format onnx `
  --edition paid `
  --manifest F:\release\encrypted\screenyolo-paid.onnx.manifest.json
```

`--api-url` 和 `--app-id` 可以显式传入，也可以分别由 `KMXT_API_URL`、
`KMXT_APP_ID` 提供。`--output` 缺省为 `<input>.enc`。已有输出默认拒绝覆盖；只有
发布者明确使用 `--overwrite` 才会替换。`--allow-http` 只允许本机
`localhost`、`127.0.0.1` 或 `[::1]` 测试地址，生产发布不得使用。

支持的 `--format`：

| 模型文件 | `--format` |
| --- | --- |
| ONNX | `onnx` |
| ncnn 参数 | `ncnn-param` |
| ncnn 权重 | `ncnn-bin` |
| TensorFlow Lite | `tflite` |
| Qualcomm DLC | `dlc` |
| 自定义不可拆包组合 | `bundle` |

ncnn 的 `.param` 与 `.bin` 应分别发布为两个 artifact，使用不同 DEK。客户端映射
也应引用两个独立 artifact ID，避免一个文件泄露后扩大影响范围。

## 执行流程

```text
明文模型
  -> 流式 SHA-256 与字节计数
  -> 随机 DEK + 随机 Nonce
  -> 流式 AES-256-GCM
  -> 密文 .vmp 文件 + 密文 SHA-256/大小 + Tag
  -> POST /api/v1/apps/:appId/artifacts
  -> draft artifact
  -> 把密文 .vmp 打包进 APK assets 并按 cipherSha256 校验
  -> PATCH /api/v1/artifacts/:artifactId/status {"status":"active"}
```

发布模块不会把明文模型或密文模型发送给 KMXT Node 进程。登记请求只包含：

- 名称、版本、格式和 edition；
- 密文 SHA-256 与密文大小；
- AES-256-GCM Nonce、Tag 和 `chunkSize: null`；
- 临时 Base64URL DEK 与 key version。

KMXT 服务收到 DEK 后立即使用 `artifact-dek:<artifactId>` 用途标签加密保存；
响应、artifact 列表与审计数据都不能返回 `contentKey` 或 `encryptedDek`。

## 输出与 Manifest

成功时 CLI 输出 `success: true` 和 artifact、路径、明/密文摘要及大小。输出不包含
DEK 或管理员令牌。指定 `--manifest` 后会额外写入 UTF-8 无 BOM JSON 文件，内容
包括：

- artifact ID、程序 ID、名称、版本、格式和 edition；
- key version；
- `plainSha256`、`plainSize`；
- `cipherSha256`、`cipherSize`；
- 算法、Nonce、Tag 和 `chunkSize`。

Manifest 不包含 `contentKey`。明文 SHA-256 用于发布侧可重复构建和源文件核对；
客户端安全边界使用签名租约中的 `cipherSha256`，读取本地 assets 中的 `.vmp` 后必须
先验证密文摘要，再执行 AES-GCM 认证解密。

## 打包与激活

1. 运行发布命令，得到密文 `.vmp`、manifest 和 `draft` artifact ID。
2. 将密文 `.vmp` 放入 app 的 `assets/` 目录（约定命名 `<modelFile>.vmp`），随 APK/AAB
   一起打包。服务端不托管密文，密文随包分发。
3. 在独立校验任务中核对打包进 assets 的 `.vmp` 的 `cipherSize` 与 `cipherSha256`，
   确认与登记的元数据一致。
4. 调用 `PATCH /api/v1/artifacts/:artifactId/status`，请求
   `{"status":"active"}`。
5. 在受控设备上请求模型租约并完成签名校验、DEK 解包、本地密文摘要校验与
   AES-GCM 解密。
6. 新版本验证完成后再吊销旧 artifact。吊销会同时吊销现存 active lease，且为
   后端不可恢复终态；需要回滚时登记新的版本记录，不恢复已吊销制品。

密文 `.vmp` 只是被 DEK 保护的密文，随 APK 分发本身不泄露明文模型；运行期的安全边界
由 KMXT 租约（在线验卡 + 设备绑定 + 一次性 DEK handle）保证，而非密文的可获取性。

## 失败语义

| 失败点 | 行为 |
| --- | --- |
| 参数、输入文件或 HTTPS 校验失败 | 不创建密文，不发请求。 |
| 加密或写盘失败 | 删除临时文件并清零 DEK。 |
| 服务明确返回 4xx/5xx | 默认删除未登记的密文并清零 DEK。 |
| 超时、断连等结果未知 | 保留密文，因为服务可能已经提交登记；先通过 artifact 列表按名称/版本查询，禁止直接用同版本重试覆盖。 |
| 服务返回 2xx 但响应格式异常 | 保留密文并人工查询 draft artifact，避免删除已登记 DEK 对应的唯一密文。 |
| manifest 写入失败 | artifact 已登记且密文保留；根据 CLI 错误人工生成或恢复 manifest。 |

`--keep-ciphertext-on-failure` 可覆盖明确拒绝时的默认清理行为，主要用于受控调试。
保留的失败密文如果确认服务端没有登记，应立即安全删除，因为 DEK 已清零，文件无法
恢复使用。

## 安全要求与限制

- DEK 只在发布进程内存和单次 HTTPS 请求体中短暂存在；工具在完成或失败时清零其
  持有的 Buffer，但 JavaScript 字符串和 TLS 实现内部副本只能依赖进程退出回收。
- 禁止启用 HTTP 调试代理记录请求体，禁止把 `fetch` 请求选项输出到 CI 日志。
- 每个 artifact 都重新生成 DEK 和 Nonce，不允许从程序名、版本或主密钥确定性派生。
- Tag 与 Nonce 不是秘密，但必须由签名租约保护，客户端不得接受本地替换值。
- 工具提供静态模型保护和短租约交付，不等于不可逆保护。Root、Hook、调试器和运行时
  内存转储仍可能取得已解密模型，应结合完整性检测、短租约、设备绑定及商业保护工具。
- 商业壳或函数虚拟化只能保护客户端取钥和解密路径，不能替代服务端授权、签名校验
  和密钥生命周期控制。

## 验证命令

```powershell
node --check src\tools\model-artifact-publisher.js
node --check cli\publish-model-artifact.js
node --test test\model-artifact-publisher.test.js
```

Release 流水线还应在 APK/AAB 和 native 库中扫描原始模型魔数、旧 seed、静态 DEK
以及意外 manifest；发现任一项必须阻断发布。
