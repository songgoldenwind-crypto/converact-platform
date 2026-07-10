CREATE TABLE IF NOT EXISTS rustdesk_device_commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES rustdesk_devices(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  command_type TEXT NOT NULL DEFAULT 'disconnect_session'
    CHECK (command_type = 'disconnect_session'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
  requested_by TEXT NOT NULL,
  requested_reason TEXT NOT NULL
    CHECK (requested_reason IN ('consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  claimed_by TEXT,
  claim_token_hash TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  execution_method TEXT
    CHECK (execution_method IS NULL OR execution_method IN ('session_adapter', 'service_restart')),
  exit_code INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  stdout_bytes INTEGER CHECK (stdout_bytes IS NULL OR stdout_bytes >= 0),
  stderr_bytes INTEGER CHECK (stderr_bytes IS NULL OR stderr_bytes >= 0),
  stdout_sha256 TEXT,
  stderr_sha256 TEXT,
  result_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, external_id, command_type)
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_device_commands_claim
  ON rustdesk_device_commands(tenant_id, device_id, status, next_attempt_at, requested_at);

ALTER TABLE rustdesk_device_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE rustdesk_device_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rustdesk_device_commands;
CREATE POLICY tenant_isolation ON rustdesk_device_commands FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
