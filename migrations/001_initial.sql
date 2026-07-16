-- KMXT 0.4.0 initial MySQL 8 schema. Author: 花落. MIT License.
CREATE TABLE IF NOT EXISTS kmxt_meta (
  singleton_id TINYINT UNSIGNED PRIMARY KEY,
  schema_version INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_kmxt_meta_singleton CHECK (singleton_id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS merchants (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_merchants_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NULL,
  username_normalized VARCHAR(64) NOT NULL,
  role VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_users_username (username_normalized),
  KEY ix_users_merchant (merchant_id),
  CONSTRAINT fk_users_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_digest CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_admin_sessions_token (token_digest),
  KEY ix_admin_sessions_user (user_id),
  KEY ix_admin_sessions_expiry (expires_at),
  CONSTRAINT fk_admin_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS applications (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_applications_merchant_code (merchant_id, code),
  CONSTRAINT fk_applications_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS products (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY ix_products_app_status (app_id, status),
  CONSTRAINT fk_products_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_products_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS license_batches (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  source_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_license_batches_source (source_id),
  KEY ix_license_batches_app (app_id),
  CONSTRAINT fk_license_batches_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_license_batches_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS licenses (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  key_digest CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_licenses_key_digest (key_digest),
  KEY ix_licenses_app_status (app_id, status),
  KEY ix_licenses_batch (batch_id),
  CONSTRAINT fk_licenses_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_licenses_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_licenses_batch FOREIGN KEY (batch_id) REFERENCES license_batches(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  license_id CHAR(36) NULL,
  order_no VARCHAR(40) NOT NULL,
  query_digest CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_orders_order_no (order_no),
  UNIQUE KEY uq_orders_query_digest (query_digest),
  UNIQUE KEY uq_orders_license (license_id),
  KEY ix_orders_merchant_status (merchant_id, status),
  CONSTRAINT fk_orders_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_orders_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS device_bindings (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  license_id CHAR(36) NOT NULL,
  device_digest CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY ix_device_bindings_license_status (license_id, status),
  KEY ix_device_bindings_digest (app_id, device_digest),
  CONSTRAINT fk_device_bindings_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_bindings_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_device_bindings_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS client_sessions (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  license_id CHAR(36) NOT NULL,
  binding_id CHAR(36) NOT NULL,
  token_digest CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_client_sessions_token (token_digest),
  KEY ix_client_sessions_license (license_id),
  KEY ix_client_sessions_expiry (expires_at),
  CONSTRAINT fk_client_sessions_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_client_sessions_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_client_sessions_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE,
  CONSTRAINT fk_client_sessions_binding FOREIGN KEY (binding_id) REFERENCES device_bindings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NULL,
  actor_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY ix_audit_logs_merchant_created (merchant_id, created_at),
  CONSTRAINT fk_audit_logs_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS verification_logs (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  license_id CHAR(36) NOT NULL,
  binding_id CHAR(36) NOT NULL,
  event VARCHAR(32) NOT NULL,
  result_code VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  KEY ix_verification_logs_app_created (app_id, created_at),
  CONSTRAINT fk_verification_logs_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_verification_logs_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_verification_logs_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_verification_logs_binding FOREIGN KEY (binding_id) REFERENCES device_bindings(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO kmxt_meta (singleton_id, schema_version, created_at, updated_at)
VALUES (1, 2, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version);
