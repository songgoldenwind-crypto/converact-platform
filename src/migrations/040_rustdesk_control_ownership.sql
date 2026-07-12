CREATE TABLE IF NOT EXISTS rustdesk_control_locks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  owner_identity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('owned', 'transferring', 'released', 'expired')),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_control_locks_expiry
  ON rustdesk_control_locks(tenant_id, status, lease_expires_at);

CREATE TABLE IF NOT EXISTS rustdesk_secondary_confirmations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  actor_identity TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'control_mouse_keyboard', 'transfer_file', 'clipboard', 'unattended_launch', 'control_transfer'
  )),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_secondary_confirmations_lookup
  ON rustdesk_secondary_confirmations(tenant_id, external_id, actor_identity, operation, expires_at DESC);

CREATE TABLE IF NOT EXISTS rustdesk_control_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL REFERENCES rustdesk_gateway_sessions(external_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'acquired', 'heartbeat', 'released', 'expired', 'transfer_started', 'transferred', 'operation_confirmed'
  )),
  actor_identity TEXT NOT NULL,
  previous_owner_identity TEXT,
  owner_identity TEXT,
  operation TEXT,
  lock_version INTEGER NOT NULL CHECK (lock_version >= 0),
  confirmation_id TEXT REFERENCES rustdesk_secondary_confirmations(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_control_events_session
  ON rustdesk_control_events(tenant_id, external_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION reject_rustdesk_control_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'RustDesk control history is immutable';
END;
$$;

DROP TRIGGER IF EXISTS rustdesk_control_events_immutable ON rustdesk_control_events;
CREATE TRIGGER rustdesk_control_events_immutable
BEFORE UPDATE OR DELETE ON rustdesk_control_events
FOR EACH ROW EXECUTE FUNCTION reject_rustdesk_control_event_mutation();

ALTER TABLE rustdesk_control_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE rustdesk_control_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rustdesk_control_locks;
CREATE POLICY tenant_isolation ON rustdesk_control_locks
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE rustdesk_secondary_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rustdesk_secondary_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rustdesk_secondary_confirmations;
CREATE POLICY tenant_isolation ON rustdesk_secondary_confirmations
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE rustdesk_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rustdesk_control_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON rustdesk_control_events;
CREATE POLICY tenant_isolation ON rustdesk_control_events
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
