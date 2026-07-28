-- KMXT 0.7.0 model artifact delivery metadata. Author: 花落. MIT License.
-- Model bytes stay in object storage/CDN; these tables only hold immutable metadata,
-- an encrypted data-encryption key, and short-lived device-bound lease records.
CREATE TABLE IF NOT EXISTS model_artifacts (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  name VARCHAR(128) NOT NULL,
  version VARCHAR(64) NOT NULL,
  format VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL,
  cipher_sha256 CHAR(64) NOT NULL,
  size BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_model_artifacts_version (app_id, name, version),
  KEY ix_model_artifacts_app_status (app_id, status),
  CONSTRAINT fk_model_artifacts_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_artifacts_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS model_leases (
  id CHAR(36) PRIMARY KEY,
  merchant_id CHAR(36) NOT NULL,
  app_id CHAR(36) NOT NULL,
  artifact_id CHAR(36) NOT NULL,
  license_id CHAR(36) NOT NULL,
  binding_id CHAR(36) NOT NULL,
  jti CHAR(36) NOT NULL,
  client_key_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  payload JSON NOT NULL,
  UNIQUE KEY uq_model_leases_jti (jti),
  KEY ix_model_leases_binding_expiry (binding_id, expires_at),
  KEY ix_model_leases_artifact_created (artifact_id, created_at),
  CONSTRAINT fk_model_leases_merchant FOREIGN KEY (merchant_id) REFERENCES merchants(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_leases_app FOREIGN KEY (app_id) REFERENCES applications(id) ON DELETE RESTRICT,
  CONSTRAINT fk_model_leases_artifact FOREIGN KEY (artifact_id) REFERENCES model_artifacts(id) ON DELETE CASCADE,
  CONSTRAINT fk_model_leases_license FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE,
  CONSTRAINT fk_model_leases_binding FOREIGN KEY (binding_id) REFERENCES device_bindings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

UPDATE kmxt_meta SET schema_version = 5, updated_at = UTC_TIMESTAMP(3) WHERE singleton_id = 1;
