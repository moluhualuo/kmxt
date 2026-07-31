-- KMXT Admin artifacts table for paid model encryption. Author: 花落, MIT License.
-- 新增表：存储付费模型的加密元数据和 DEK（用于云端密钥下发）
CREATE TABLE IF NOT EXISTS artifacts (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  version VARCHAR(64) NOT NULL DEFAULT '1.0',
  format VARCHAR(24) NOT NULL,
  game VARCHAR(64),
  encryption_dek TEXT NOT NULL,
  cipher_sha256 CHAR(64) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  original_size BIGINT UNSIGNED NOT NULL,
  object_url VARCHAR(512) NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_artifacts_name_version (name, version),
  KEY ix_artifacts_game (game),
  KEY ix_artifacts_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 注意：encryption_dek 存储 Base64 编码的 DEK，生产环境应该用 envelope 加密保护
-- （例如 AWS KMS / HashiCorp Vault / 本地 master key 包装）

UPDATE kmxt_meta SET schema_version = 6, updated_at = CURRENT_TIMESTAMP WHERE singleton_id = 1;
