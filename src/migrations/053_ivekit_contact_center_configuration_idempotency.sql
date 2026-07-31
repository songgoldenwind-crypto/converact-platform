CREATE TABLE IF NOT EXISTS ivekit_cc_configuration_idempotency (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 1 AND 200
  ),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('skill', 'agent', 'queue')),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  resource_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, idempotency_key)
);

DROP TRIGGER IF EXISTS ivekit_cc_configuration_idempotency_immutable_delete
  ON ivekit_cc_configuration_idempotency;
CREATE TRIGGER ivekit_cc_configuration_idempotency_immutable_delete
BEFORE DELETE ON ivekit_cc_configuration_idempotency
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_cc_reject_delete();

ALTER TABLE ivekit_cc_configuration_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_configuration_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_configuration_idempotency;
CREATE POLICY tenant_isolation ON ivekit_cc_configuration_idempotency FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
