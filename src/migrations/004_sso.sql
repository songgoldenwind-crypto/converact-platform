-- Sprint 10: OIDC SSO user linking

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS external_sub TEXT;
CREATE INDEX IF NOT EXISTS idx_users_external_sub ON users (tenant_id, external_sub);
