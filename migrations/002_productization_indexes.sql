-- KMXT 0.6.0 query indexes. Author: 花落. MIT License.
ALTER TABLE users ADD KEY ix_users_merchant_status (merchant_id, status);
ALTER TABLE applications ADD KEY ix_applications_merchant_status (merchant_id, status);
ALTER TABLE license_batches ADD KEY ix_license_batches_app_created (app_id, created_at);
ALTER TABLE licenses ADD KEY ix_licenses_app_created (app_id, created_at);
ALTER TABLE orders ADD KEY ix_orders_merchant_created (merchant_id, created_at);
ALTER TABLE orders ADD KEY ix_orders_app_status_created (app_id, status, created_at);
ALTER TABLE device_bindings ADD KEY ix_device_bindings_app_status (app_id, status);
ALTER TABLE client_sessions ADD KEY ix_client_sessions_user_scope (merchant_id, app_id, expires_at);
ALTER TABLE audit_logs ADD KEY ix_audit_logs_action_created (action, created_at);
ALTER TABLE verification_logs ADD KEY ix_verification_logs_event_created (event, created_at);
UPDATE kmxt_meta SET schema_version = 3, updated_at = UTC_TIMESTAMP(3) WHERE singleton_id = 1;
