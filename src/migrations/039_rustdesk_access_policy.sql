CREATE UNIQUE INDEX IF NOT EXISTS idx_rustdesk_devices_tenant_id
  ON rustdesk_devices(tenant_id, id);

CREATE TABLE IF NOT EXISTS rustdesk_access_policy_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('configured', 'revoked')),
  mode TEXT NOT NULL CHECK (mode IN ('attended_only', 'unattended_allowed')),
  allowed_scopes JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_scopes) = 'array')
    CHECK (allowed_scopes <@ '["view_screen","control_mouse_keyboard","record_screen","transfer_file","clipboard"]'::jsonb),
  business_ref_type TEXT NOT NULL,
  business_ref_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  expires_at TIMESTAMPTZ,
  supersedes_id TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, device_id, id),
  UNIQUE (tenant_id, device_id, version),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, device_id) REFERENCES rustdesk_devices(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, device_id, supersedes_id)
    REFERENCES rustdesk_access_policy_events(tenant_id, device_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_rustdesk_access_policy_current
  ON rustdesk_access_policy_events(tenant_id, device_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_rustdesk_access_policy_business_ref
  ON rustdesk_access_policy_events(tenant_id, business_ref_type, business_ref_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_rustdesk_access_policy_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'access policy history is immutable';
END;
$$;

DROP TRIGGER IF EXISTS rustdesk_access_policy_events_immutable
  ON rustdesk_access_policy_events;

CREATE TRIGGER rustdesk_access_policy_events_immutable
BEFORE UPDATE OR DELETE ON rustdesk_access_policy_events
FOR EACH ROW EXECUTE FUNCTION reject_rustdesk_access_policy_event_mutation();

ALTER TABLE rustdesk_access_policy_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rustdesk_access_policy_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON rustdesk_access_policy_events;
CREATE POLICY tenant_isolation ON rustdesk_access_policy_events
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
