#!/usr/bin/env node
// 作者: 花落, MIT License
// 用途: 加密模型文件用于 KMXT artifact 云端密钥分发
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * 加密单个模型文件 (AES-256-GCM)
 * @param {string} inputPath - 明文模型文件路径
 * @param {string} outputPath - 输出 .vmp 文件路径
 * @returns {{dekBase64: string, cipherSha256: string, size: number, originalSize: number}}
 */
function encryptModel(inputPath, outputPath) {
  const plaintext = fs.readFileSync(inputPath);

  // 生成随机 DEK（32 字节）
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);

  // AES-256-GCM 加密
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // .vmp 格式：[12B nonce][16B tag][ciphertext]
  const vmpBlob = Buffer.concat([nonce, tag, ciphertext]);
  fs.writeFileSync(outputPath, vmpBlob);

  const cipherSha256 = crypto.createHash('sha256').update(vmpBlob).digest('hex');

  return {
    dekBase64: dek.toString('base64'),
    cipherSha256,
    size: vmpBlob.length,
    originalSize: plaintext.length,
  };
}

// CLI 入口
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: node encrypt_model.js <input.onnx> <output.vmp>');
    process.exit(1);
  }

  const result = encryptModel(input, output);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = { encryptModel };
