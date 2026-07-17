CREATE TABLE IF NOT EXISTS rustdesk_authorization_codes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  remote_session_id TEXT NOT NULL
    CONSTRAINT rustdesk_authorization_codes_remote_session_fk
    REFERENCES remote_assistance_sessions(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  scopes JSONB NOT NULL
    CHECK (jsonb_typeof(scopes) = 'array')
    CHECK (scopes <@ '["view_screen","control_mouse_keyboard","record_screen","transfer_file","clipboard"]'::jsonb),
  requested_by TEXT NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL,
  code_salt TEXT NOT NULL CHECK (code_salt ~ '^[a-f0-9]{32}$'),
  code_hmac TEXT NOT NULL CHECK (code_hmac ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  max_attempts INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND max_attempts),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'consumed', 'expired', 'locked')),
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  consumed_external_id TEXT REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE RESTRICT,
  consumed_at TIMESTAMPTZ,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, device_id) REFERENCES rustdesk_devices(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((verified_by IS NULL) = (verified_at IS NULL)),
  CHECK (status NOT IN ('verified', 'consumed') OR verified_by IS NOT NULL),
  CHECK (status NOT IN ('pending', 'locked') OR verified_by IS NULL),
  CHECK ((status = 'consumed') = (consumed_external_id IS NOT NULL AND consumed_at IS NOT NULL))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'rustdesk_authorization_codes_remote_session_fk'
      AND conrelid = 'rustdesk_authorization_codes'::regclass
  ) THEN
    ALTER TABLE rustdesk_authorization_codes
      ADD CONSTRAINT rustdesk_authorization_codes_remote_session_fk
      FOREIGN KEY (remote_session_id)
      REFERENCES remote_assistance_sessions(id)
      ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_rustdesk_authorization_codes_session
  ON rustdesk_authorization_codes(tenant_id, remote_session_id, device_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_rustdesk_authorization_codes_expiry
  ON rustdesk_authorization_codes(tenant_id, status, expires_at);

ALTER TABLE rustdesk_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE rustdesk_authorization_codes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON rustdesk_authorization_codes;
CREATE POLICY tenant_isolation ON rustdesk_authorization_codes
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
