CREATE TABLE IF NOT EXISTS ivekit_rate_limit_buckets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('tenant', 'actor', 'source_ip', 'recipient', 'provider')
  ),
  scope_key_hmac TEXT NOT NULL CHECK (char_length(scope_key_hmac) = 64),
  route_group TEXT NOT NULL CHECK (char_length(route_group) BETWEEN 1 AND 100),
  window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  window_started_at TIMESTAMPTZ NOT NULL,
  used_count BIGINT NOT NULL CHECK (used_count >= 0),
  limit_count BIGINT NOT NULL CHECK (limit_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, scope_type, scope_key_hmac, route_group, window_seconds)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_rate_limit_buckets_expiry
  ON ivekit_rate_limit_buckets(expires_at);

ALTER TABLE ivekit_rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_rate_limit_buckets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_rate_limit_buckets;
CREATE POLICY tenant_isolation ON ivekit_rate_limit_buckets FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_rate_limit_buckets TO opc_runtime;
  END IF;
END
$$;
