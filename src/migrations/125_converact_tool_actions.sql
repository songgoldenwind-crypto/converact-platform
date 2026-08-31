-- Additive Tool Action authority. This migration does not switch any writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_tool_actions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  agent_release_id TEXT NOT NULL,
  tool_revision_id TEXT NOT NULL,
  tool_schema_hash TEXT NOT NULL CHECK (tool_schema_hash ~ '^[0-9a-f]{64}$'),
  arguments_hash TEXT NOT NULL CHECK (arguments_hash ~ '^[0-9a-f]{64}$'),
  proposal_digest TEXT NOT NULL CHECK (proposal_digest ~ '^[0-9a-f]{64}$'),
  arguments JSONB NOT NULL CHECK (octet_length(arguments::TEXT) <= 65536),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('query', 'mutation')),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'high')),
  action_capability TEXT NOT NULL CHECK (char_length(action_capability) BETWEEN 1 AND 128),
  policy_decision TEXT NOT NULL CHECK (
    policy_decision IN ('allowed', 'approval_required')
  ),
  approval_id TEXT,
  approval_expires_at TIMESTAMPTZ,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'state_observed')),
  resolution TEXT CHECK (resolution IN ('applied', 'not_applied')),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  completed_at TIMESTAMPTZ,
  state_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, tool_call_id),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (approval_id IS NULL AND approval_expires_at IS NULL AND risk = 'low') OR
    (approval_id IS NOT NULL AND approval_expires_at IS NOT NULL
      AND approval_expires_at > accepted_at)
  ),
  CHECK (
    (lease_owner = '' AND lease_token_hash = '' AND lease_expires_at IS NULL) OR
    (lease_owner <> '' AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL)
  ),
  CHECK (
    (state = 'accepted' AND resolution IS NULL AND completed_at IS NULL
      AND state_observed_at IS NULL) OR
    (state = 'state_observed' AND resolution IS NOT NULL AND completed_at IS NOT NULL
      AND state_observed_at IS NOT NULL AND state_observed_at >= completed_at
      AND completed_at >= accepted_at)
  )
);

CREATE TABLE IF NOT EXISTS converact_tool_action_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  stage TEXT NOT NULL CHECK (stage IN ('accepted', 'completed', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  resolution TEXT CHECK (resolution IN ('applied', 'not_applied')),
  result_hash TEXT CHECK (result_hash IS NULL OR result_hash ~ '^[0-9a-f]{64}$'),
  result_payload JSONB CHECK (
    result_payload IS NULL OR octet_length(result_payload::TEXT) <= 131072
  ),
  failure_code TEXT CHECK (
    failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 255
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, tool_call_id, stage),
  FOREIGN KEY (tenant_id, tool_call_id)
    REFERENCES converact_tool_actions(tenant_id, tool_call_id) ON DELETE RESTRICT,
  CHECK (
    (stage = 'accepted' AND resolution IS NULL AND result_hash IS NULL
      AND result_payload IS NULL AND failure_code IS NULL) OR
    (stage IN ('completed', 'state_observed') AND resolution = 'applied'
      AND result_hash IS NOT NULL AND result_payload IS NOT NULL AND failure_code IS NULL) OR
    (stage IN ('completed', 'state_observed') AND resolution = 'not_applied'
      AND result_hash IS NULL AND result_payload IS NULL AND failure_code IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS converact_tool_action_outbox (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  outbox_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  state_observed_receipt_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL CHECK (octet_length(payload::TEXT) <= 131072),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (
    state IN ('pending', 'published', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1000),
  available_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, tool_call_id),
  FOREIGN KEY (tenant_id, tool_call_id)
    REFERENCES converact_tool_actions(tenant_id, tool_call_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, state_observed_receipt_id)
    REFERENCES converact_tool_action_receipts(tenant_id, receipt_id) ON DELETE RESTRICT,
  CHECK (
    (lease_owner = '' AND lease_token_hash = '' AND lease_expires_at IS NULL) OR
    (lease_owner <> '' AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_converact_tool_action_reconcile_claim
  ON converact_tool_actions (tenant_id, accepted_at, tool_call_id)
  WHERE state = 'accepted';

CREATE INDEX IF NOT EXISTS idx_converact_tool_action_outbox_claim
  ON converact_tool_action_outbox (tenant_id, available_at, outbox_id)
  WHERE state = 'pending';

CREATE OR REPLACE FUNCTION converact_tool_action_claim_reconcile(
  p_tenant_id TEXT,
  p_lease_owner TEXT,
  p_lease_token_hash TEXT,
  p_lease_ms BIGINT,
  p_limit INTEGER
)
RETURNS TABLE (tool_call_id TEXT)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH candidates AS (
    SELECT action.tenant_id, action.tool_call_id
    FROM public.converact_tool_actions AS action
    WHERE action.tenant_id = p_tenant_id
      AND p_tenant_id = opc_current_tenant()
      AND p_lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
      AND p_lease_token_hash ~ '^[0-9a-f]{64}$'
      AND p_lease_ms BETWEEN 1 AND 300000
      AND p_limit BETWEEN 1 AND 1000
      AND action.state = 'accepted'
      AND (action.lease_expires_at IS NULL OR action.lease_expires_at <= transaction_timestamp())
    ORDER BY action.accepted_at, action.tool_call_id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  )
  UPDATE public.converact_tool_actions AS action
  SET lease_owner = p_lease_owner,
      lease_token_hash = p_lease_token_hash,
      lease_expires_at = transaction_timestamp() + (p_lease_ms * interval '1 millisecond'),
      updated_at = transaction_timestamp()
  FROM candidates
  WHERE action.tenant_id = candidates.tenant_id
    AND action.tool_call_id = candidates.tool_call_id
  RETURNING action.tool_call_id
$$;

CREATE OR REPLACE FUNCTION converact_tool_action_receipt_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Tool Action receipts are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_tool_action_receipts_immutable
  ON converact_tool_action_receipts;
CREATE TRIGGER converact_tool_action_receipts_immutable
  BEFORE UPDATE OR DELETE ON converact_tool_action_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_tool_action_receipt_immutable_guard();

ALTER TABLE converact_tool_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_tool_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_tool_actions;
CREATE POLICY tenant_isolation ON converact_tool_actions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_tool_action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_tool_action_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_tool_action_receipts;
CREATE POLICY tenant_isolation ON converact_tool_action_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_tool_action_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_tool_action_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_tool_action_outbox;
CREATE POLICY tenant_isolation ON converact_tool_action_outbox FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_tool_action_claim_reconcile(
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_tool_action_receipt_immutable_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON converact_tool_actions TO opc_runtime;
    GRANT SELECT, INSERT ON converact_tool_action_receipts TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_tool_action_outbox TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_tool_action_claim_reconcile(
      TEXT, TEXT, TEXT, BIGINT, INTEGER
    ) TO opc_runtime;
  END IF;
END
$grant$;
