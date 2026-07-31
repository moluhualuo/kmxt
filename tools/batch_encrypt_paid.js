#!/usr/bin/env node
// KMXT Admin CLI: 批量加密付费模型并上传到服务器
// 作者: 花落, MIT License
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 配置
const INPUT_DIR = 'F:/ScreenYolo/ScreenYolo-/int8_work/paid_tflite/assets';
const OUTPUT_DIR = path.join(__dirname, '../artifacts/encrypted');
const MANIFEST_FILE = path.join(OUTPUT_DIR, 'paid_models_manifest.json');
const EXTENSIONS = ['.onnx', '.tflite', '.param', '.bin', '.dlc'];

/**
 * AES-256-GCM 加密模型文件
 * @returns {object} { dekBase64, cipherSha256, size, originalSize }
 */
function encryptModel(inputPath, outputPath) {
  const plaintext = fs.readFileSync(inputPath);
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // .vmp 格式：[12B nonce][16B tag][ciphertext]
  const vmpBlob = Buffer.concat([nonce, tag, ciphertext]);
  fs.writeFileSync(outputPath, vmpBlob);

  return {
    dekBase64: dek.toString('base64'),
    cipherSha256: crypto.createHash('sha256').update(vmpBlob).digest('hex'),
    size: vmpBlob.length,
    originalSize: plaintext.length,
  };
}

function main() {
  if (!fs.existsSync(INPUT_DIR)) {
    console.error(`ERROR: Input directory not found: ${INPUT_DIR}`);
    process.exit(1);
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const manifest = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    models: [],
  };

  console.log(`🔐 Encrypting paid models from: ${INPUT_DIR}\n`);

  const files = fs.readdirSync(INPUT_DIR);
  let count = 0;

  files.forEach(filename => {
    const ext = path.extname(filename);
    if (!EXTENSIONS.includes(ext)) return;

    const inputPath = path.join(INPUT_DIR, filename);
    const outputFilename = `${filename}.vmp`;
    const outputPath = path.join(OUTPUT_DIR, outputFilename);

    console.log(`Encrypting ${filename}...`);
    const result = encryptModel(inputPath, outputPath);

    manifest.models.push({
      name: filename,
      vmpFile: outputFilename,
      format: ext.substring(1),
      dekBase64: result.dekBase64,
      cipherSha256: result.cipherSha256,
      size: result.size,
      originalSize: result.originalSize,
      objectUrl: `/models/${outputFilename}`,
    });

    console.log(`  ✓ ${result.originalSize} -> ${result.size} bytes`);
    console.log(`  ✓ DEK: ${result.dekBase64.substring(0, 16)}...`);
    console.log(`  ✓ SHA256: ${result.cipherSha256}\n`);
    count++;
  });

  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓ Encrypted ${count} paid models`);
  console.log(`✓ Output: ${OUTPUT_DIR}`);
  console.log(`✓ Manifest: ${MANIFEST_FILE}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main();
