#!/usr/bin/env node
// KMXT Admin CLI: 导入已加密的付费模型到数据库
// 作者: 花落, MIT License
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_FILE = path.join(__dirname, '../artifacts/encrypted/paid_models_manifest.json');

async function main() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    console.error(`ERROR: Manifest not found: ${MANIFEST_FILE}`);
    console.error('Run: node tools/batch_encrypt_paid.js first');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));

  // 连接数据库（从环境变量读取配置）
  const connection = await mysql.createConnection({
    host: process.env.KMXT_DB_HOST || 'localhost',
    port: parseInt(process.env.KMXT_DB_PORT || '3306', 10),
    user: process.env.KMXT_DB_USER || 'root',
    password: process.env.KMXT_DB_PASSWORD || '',
    database: process.env.KMXT_DB_NAME || 'kmxt',
  });

  console.log(`📦 Importing ${manifest.models.length} models into database...\n`);

  for (const model of manifest.models) {
    const id = crypto.randomUUID();

    try {
      await connection.execute(
        `INSERT INTO artifacts (
          id, name, version, format, game,
          encryption_dek, cipher_sha256, size, original_size,
          object_url, key_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
        ON DUPLICATE KEY UPDATE
          encryption_dek = VALUES(encryption_dek),
          cipher_sha256 = VALUES(cipher_sha256),
          size = VALUES(size),
          original_size = VALUES(original_size),
          object_url = VALUES(object_url)`,
        [
          id,
          model.name,
          '1.0', // 默认版本
          model.format,
          null, // game 标签后续可手动更新
          model.dekBase64,
          model.cipherSha256,
          model.size,
          model.originalSize,
          model.objectUrl,
        ]
      );

      console.log(`✓ ${model.name} (${model.format})`);
    } catch (error) {
      console.error(`✗ ${model.name}: ${error.message}`);
    }
  }

  await connection.end();

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✓ Import completed`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(error => {
  console.error('FATAL:', error);
  process.exit(1);
});
