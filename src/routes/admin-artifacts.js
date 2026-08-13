// 作者: 花落, MIT License
// Admin API: 模型加密 & Artifact 注册（WS7 付费模型专用）
import crypto from 'crypto';

/**
 * AES-256-GCM 加密模型文件，返回 .vmp 格式密文 Buffer 及元数据。
 * .vmp 格式：[12B nonce][16B tag][ciphertext]
 */
function encryptModel(plaintext) {
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const vmpBlob = Buffer.concat([nonce, tag, ciphertext]);

  return {
    vmpBlob,
    dek,
    nonce,
    tag,
    cipherSha256: crypto.createHash('sha256').update(vmpBlob).digest('hex'),
    size: vmpBlob.length,
    originalSize: plaintext.length,
  };
}

/**
 * 简易 multipart/form-data 解析（仅支持单文件 + 文本字段）
 */
function parseMultipart(request) {
  return new Promise((resolve, reject) => {
    const boundary = request.headers['content-type']?.match(/boundary=(.+)/)?.[1];
    if (!boundary) {
      return reject(new Error('Missing multipart boundary'));
    }

    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const parts = buffer.toString('binary').split(`--${boundary}`);
        const fields = {};
        let file = null;

        for (const part of parts) {
          if (!part.includes('Content-Disposition')) continue;

          const nameMatch = part.match(/name="([^"]+)"/);
          if (!nameMatch) continue;

          const name = nameMatch[1];
          const bodyStart = part.indexOf('\r\n\r\n') + 4;
          const bodyEnd = part.lastIndexOf('\r\n');
          const body = part.substring(bodyStart, bodyEnd);

          if (part.includes('filename=')) {
            const filenameMatch = part.match(/filename="([^"]+)"/);
            file = {
              fieldname: name,
              originalname: filenameMatch ? filenameMatch[1] : 'unknown',
              buffer: Buffer.from(body, 'binary'),
            };
          } else {
            fields[name] = body;
          }
        }

        resolve({ fields, file });
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

/**
 * 从文件名推断模型格式（.onnx / .param / .bin / .tflite）
 */
export function inferFormat(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.onnx')) return 'onnx';
  if (lower.endsWith('.param')) return 'ncnn-param';
  if (lower.endsWith('.bin')) return 'ncnn-bin';
  if (lower.endsWith('.tflite')) return 'tflite';
  if (lower.endsWith('.dlc')) return 'dlc';
  if (lower.endsWith('.so')) return 'so';
  if (lower.endsWith('.dex')) return 'dex';
  return 'onnx';  // 默认
}

/**
 * 从文件名提取模型名称。
 *
 * 只剥离单一扩展名的格式（如 model.onnx -> model）；ncnn 的 `.param` / `.bin`
 * 保留完整文件名，避免 `X.ncnn.param` 与 `X.ncnn.bin` 塌缩成同名而撞上
 * uq_model_artifacts_version (app_id, name, version) 唯一键。ncnn 的两个文件
 * 按设计本就是各自独立 DEK 的两个 artifact，名称必须可区分。
 */
export function inferName(filename) {
  if (/\.(param|bin)$/i.test(filename)) return filename;
  return filename.replace(/\.(onnx|tflite|dlc|so|dex|pt|pth)$/i, '');
}

/**
 * POST /api/v1/admin/artifacts/upload
 * 上传明文模型 → 加密成 .vmp → 调用 modelDelivery.register 登记到 DB
 */
export async function handleUpload(user, request, services) {
  const { fields, file } = await parseMultipart(request);

  if (!file) {
    throw new Error('No file uploaded');
  }

  const appId = fields.appId;
  if (!appId) {
    throw new Error('appId is required');
  }

  // 自动推断：name/format 从文件名提取，version 从字段或默认 1.0
  const name = fields.name || inferName(file.originalname);
  const version = fields.version || '1.0';
  const format = fields.format || inferFormat(file.originalname);
  const edition = fields.edition || null;
  const keyVersion = Number(fields.keyVersion) || 1;

  // 加密（内存中完成，服务端不落地任何模型文件）
  const encrypted = encryptModel(file.buffer);

  // 调用 modelDelivery.register，只登记 DEK + 元数据（不含 objectUrl，服务端不存密文）。
  const artifact = await services.modelDelivery.register(user, appId, {
    name,
    version,
    format,
    edition,
    cipherSha256: encrypted.cipherSha256,
    size: encrypted.size,
    encryption: {
      algorithm: 'AES-256-GCM',
      nonce: encrypted.nonce.toString('base64url').substring(0, 16),
      tag: encrypted.tag.toString('base64url').substring(0, 22),
      chunkSize: null,
    },
    contentKey: encrypted.dek.toString('base64url').substring(0, 43),
    keyVersion,
  });

  // 花落/MIT: 加密后的 .vmp 密文直接回传给管理员下载（base64），服务端不存储。
  // 管理员把该 .vmp 打包进 APK；运行期客户端验卡后经租约拿 DEK 解密本地 .vmp。
  // 注意：router 会自动包一层 {success, data}，此处直接返回数据对象即可。
  // ⚠️ DEK 不回传到浏览器：明文 DEK 只在服务端加密存入 encryptedDek，运行期由租约协议
  // 用客户端临时 X25519 公钥包裹后下发，客户端构建期无需、也不应接触明文 DEK。
  return {
    artifactId: artifact.id,
    name: artifact.name,
    version: artifact.version,
    format: artifact.format,
    cipherSha256: artifact.cipherSha256,
    size: artifact.size,
    encryption: artifact.encryption,
    vmpFilename: `${name}.vmp`,
    vmpBase64: encrypted.vmpBlob.toString('base64'),
  };
}
