-- KMXT 0.8.0 signed client announcements. Author: 花落. MIT License.
-- 公告随 activate/verify 的 Ed25519 签名载荷下发，并提供独立的未激活用户公告端点。
-- 正文只允许纯文本；表中不保存任何密钥、会话或设备信息。
CREATE TABLE IF NOT EXISTS announcements (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  severity VARCHAR(16) NOT NULL,
  sequence BIGINT UNSIGNED NOT NULL,
  starts_at DATETIME(3) NULL,
  ends_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY ix_announcements_app_status (app_id, status),
  KEY ix_announcements_app_sequence (app_id, sequence),
  CONSTRAINT fk_announcements_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_announcements_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

UPDATE kmxt_meta SET schema_version = 6, updated_at = UTC_TIMESTAMP(3) WHERE singleton_id = 1;
