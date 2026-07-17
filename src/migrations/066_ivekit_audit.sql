CREATE TABLE IF NOT EXISTS ivekit_audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL CHECK (char_length(actor_id) BETWEEN 1 AND 255),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'admin', 'operator', 'viewer', 'system', 'provider')),
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 255),
  resource_type TEXT NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 100),
  resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 255),
  business_ref_type TEXT NOT NULL CHECK (char_length(business_ref_type) BETWEEN 1 AND 100),
  business_ref_id TEXT NOT NULL CHECK (char_length(business_ref_id) BETWEEN 1 AND 255),
  request_id TEXT NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 255),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  result TEXT NOT NULL CHECK (result IN ('succeeded', 'failed', 'denied', 'accepted')),
  policy_decision TEXT NOT NULL CHECK (policy_decision IN ('allow', 'deny', 'not_applicable')),
  source_ip_hmac TEXT NOT NULL DEFAULT ''
    CHECK (source_ip_hmac = '' OR char_length(source_ip_hmac) = 64),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  previous_hash TEXT NOT NULL CHECK (char_length(previous_hash) = 64),
  event_hash TEXT NOT NULL CHECK (char_length(event_hash) = 64),
  occurred_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, event_hash),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_audit_events_timeline
  ON ivekit_audit_events(tenant_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ivekit_audit_events_resource
  ON ivekit_audit_events(tenant_id, resource_type, resource_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION opc_ivekit_audit_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'iveKit audit history is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS ivekit_audit_events_immutable ON ivekit_audit_events;
CREATE TRIGGER ivekit_audit_events_immutable
  BEFORE UPDATE OR DELETE ON ivekit_audit_events
  FOR EACH ROW EXECUTE FUNCTION opc_ivekit_audit_immutable_guard();

ALTER TABLE ivekit_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_audit_events;
CREATE POLICY tenant_isolation ON ivekit_audit_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_ivekit_audit_immutable_guard() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON ivekit_audit_events TO opc_runtime;
  END IF;
END
$$;
