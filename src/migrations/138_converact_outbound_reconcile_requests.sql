-- Additive durable operator reconciliation requests. This migration switches no existing writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_outbound_reconcile_requests (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  call_attempt_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'processing', 'completed', 'reconcile_required')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_converact_outbound_reconcile_pending
  ON converact_outbound_reconcile_requests (tenant_id, created_at, idempotency_key)
  WHERE state IN ('pending', 'reconcile_required');

DROP TRIGGER IF EXISTS converact_outbound_reconcile_requests_immutable
  ON converact_outbound_reconcile_requests;
CREATE TRIGGER converact_outbound_reconcile_requests_immutable
  BEFORE UPDATE OR DELETE ON converact_outbound_reconcile_requests
  FOR EACH ROW EXECUTE FUNCTION converact_outbound_immutable_history_guard();

ALTER TABLE converact_outbound_reconcile_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_reconcile_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_reconcile_requests;
CREATE POLICY tenant_isolation ON converact_outbound_reconcile_requests FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_outbound_reconcile_requests TO opc_runtime;
  END IF;
END
$grant$;
