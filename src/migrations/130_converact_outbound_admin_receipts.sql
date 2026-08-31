-- Additive, content-free idempotency receipts for Rust AI-outbound authoring.
-- This migration does not switch a writer or expose customer payloads.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_outbound_admin_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  command_kind TEXT NOT NULL CHECK (command_kind IN (
    'publish_agent', 'create_campaign', 'import_contacts', 'transition_campaign'
  )),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('agent_release', 'campaign')),
  resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 255),
  result_state TEXT NOT NULL CHECK (char_length(result_state) BETWEEN 1 AND 64),
  result_revision BIGINT NOT NULL CHECK (result_revision > 0),
  result_count INTEGER NOT NULL CHECK (result_count >= 0 AND result_count <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

DROP TRIGGER IF EXISTS converact_outbound_admin_receipts_immutable
  ON converact_outbound_admin_receipts;
CREATE TRIGGER converact_outbound_admin_receipts_immutable
  BEFORE UPDATE OR DELETE ON converact_outbound_admin_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_outbound_immutable_history_guard();

ALTER TABLE converact_outbound_admin_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_admin_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_admin_receipts;
CREATE POLICY tenant_isolation ON converact_outbound_admin_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_outbound_admin_receipts TO opc_runtime;
  END IF;
END
$grant$;
