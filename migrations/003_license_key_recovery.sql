-- KMXT 0.6.0 encrypted license-key recovery metadata. Author: 花落. MIT License.
-- License ciphertext stays inside each JSON payload, so no table-column rewrite is required.
UPDATE kmxt_meta SET schema_version = 4, updated_at = UTC_TIMESTAMP(3) WHERE singleton_id = 1;
