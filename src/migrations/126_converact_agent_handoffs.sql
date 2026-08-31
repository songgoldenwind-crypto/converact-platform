-- Additive AI/Human Handoff authority. This migration does not switch any writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_agent_handoff_context_packets (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  context_packet_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  source_execution_generation BIGINT NOT NULL CHECK (source_execution_generation > 0),
  context_revision BIGINT NOT NULL CHECK (context_revision > 0),
  context_packet_digest TEXT NOT NULL CHECK (context_packet_digest ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL CHECK (octet_length(payload::TEXT) <= 131072),
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, context_packet_id),
  UNIQUE (tenant_id, interaction_id, context_revision),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_agent_handoffs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  handoff_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  context_packet_id TEXT NOT NULL,
  context_packet_digest TEXT NOT NULL CHECK (context_packet_digest ~ '^[0-9a-f]{64}$'),
  target JSONB NOT NULL CHECK (octet_length(target::TEXT) <= 32768),
  state TEXT NOT NULL CHECK (state IN (
    'requested', 'prepared', 'human_leg_dialing', 'human_leg_answered',
    'committed', 'human_active', 'ai_resume_preparing', 'ai_resumed',
    'aborted', 'reconcile_required'
  )),
  reconcile_from TEXT CHECK (reconcile_from IS NULL OR reconcile_from IN (
    'requested', 'prepared', 'human_leg_dialing', 'human_leg_answered',
    'committed', 'human_active', 'ai_resume_preparing'
  )),
  control_owner TEXT NOT NULL CHECK (control_owner IN ('ai', 'human')),
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  revision BIGINT NOT NULL CHECK (revision > 0),
  source_ai_session_id TEXT NOT NULL,
  current_ai_session_id TEXT NOT NULL,
  human_leg_id TEXT,
  terminal_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, handoff_id),
  FOREIGN KEY (tenant_id, context_packet_id)
    REFERENCES converact_agent_handoff_context_packets(tenant_id, context_packet_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('ai_resumed', 'aborted') AND terminal_at IS NOT NULL) OR
    (state NOT IN ('ai_resumed', 'aborted') AND terminal_at IS NULL)
  ),
  CHECK (
    (state = 'reconcile_required' AND reconcile_from IS NOT NULL) OR
    (state <> 'reconcile_required' AND reconcile_from IS NULL)
  ),
  CHECK (
    (state IN ('human_leg_dialing', 'human_leg_answered', 'committed',
               'human_active', 'ai_resume_preparing', 'ai_resumed')
      AND human_leg_id IS NOT NULL) OR
    (state IN ('requested', 'prepared', 'aborted', 'reconcile_required'))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_converact_agent_handoff_active_interaction
  ON converact_agent_handoffs (tenant_id, interaction_id)
  WHERE state NOT IN ('ai_resumed', 'aborted');

CREATE TABLE IF NOT EXISTS converact_agent_handoff_commands (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (char_length(command_kind) BETWEEN 1 AND 64),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  expected_revision BIGINT NOT NULL CHECK (expected_revision > 0),
  expected_generation BIGINT NOT NULL CHECK (expected_generation > 0),
  command_state TEXT NOT NULL CHECK (command_state IN ('prepared', 'state_observed')),
  target_revision BIGINT,
  target_generation BIGINT,
  target_state TEXT,
  target_owner TEXT CHECK (target_owner IS NULL OR target_owner IN ('ai', 'human')),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at TIMESTAMPTZ,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  state_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, command_id),
  UNIQUE (tenant_id, handoff_id, target_revision),
  FOREIGN KEY (tenant_id, handoff_id)
    REFERENCES converact_agent_handoffs(tenant_id, handoff_id) ON DELETE RESTRICT,
  CHECK (
    (command_state = 'prepared' AND target_revision IS NULL
      AND target_generation IS NULL AND target_state IS NULL
      AND target_owner IS NULL AND state_observed_at IS NULL) OR
    (command_state = 'state_observed' AND target_revision IS NOT NULL
      AND target_generation IS NOT NULL AND target_state IS NOT NULL
      AND target_owner IS NOT NULL AND state_observed_at IS NOT NULL)
  ),
  CHECK (
    (lease_owner = '' AND lease_token_hash = '' AND lease_expires_at IS NULL) OR
    (lease_owner <> '' AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS converact_agent_handoff_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('prepared', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  observed_revision BIGINT NOT NULL CHECK (observed_revision > 0),
  observed_generation BIGINT NOT NULL CHECK (observed_generation > 0),
  observed_state TEXT NOT NULL,
  observed_owner TEXT NOT NULL CHECK (observed_owner IN ('ai', 'human')),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, command_id, stage),
  FOREIGN KEY (tenant_id, command_id)
    REFERENCES converact_agent_handoff_commands(tenant_id, command_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, handoff_id)
    REFERENCES converact_agent_handoffs(tenant_id, handoff_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_converact_agent_handoff_reconcile_claim
  ON converact_agent_handoff_commands (tenant_id, prepared_at, command_id)
  WHERE command_state = 'prepared';

CREATE OR REPLACE FUNCTION converact_agent_handoff_claim_reconcile(
  p_tenant_id TEXT,
  p_lease_owner TEXT,
  p_lease_token_hash TEXT,
  p_lease_ms BIGINT,
  p_limit INTEGER
)
RETURNS TABLE (command_id TEXT)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  WITH candidates AS (
    SELECT command.tenant_id, command.command_id
    FROM public.converact_agent_handoff_commands AS command
    WHERE command.tenant_id = p_tenant_id
      AND p_tenant_id = opc_current_tenant()
      AND p_lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
      AND p_lease_token_hash ~ '^[0-9a-f]{64}$'
      AND p_lease_ms BETWEEN 1 AND 300000
      AND p_limit BETWEEN 1 AND 1000
      AND command.command_state = 'prepared'
      AND (command.lease_expires_at IS NULL
        OR command.lease_expires_at <= transaction_timestamp())
    ORDER BY command.prepared_at, command.command_id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  )
  UPDATE public.converact_agent_handoff_commands AS command
  SET lease_owner = p_lease_owner,
      lease_token_hash = p_lease_token_hash,
      lease_expires_at = transaction_timestamp() + (p_lease_ms * interval '1 millisecond'),
      updated_at = transaction_timestamp()
  FROM candidates
  WHERE command.tenant_id = candidates.tenant_id
    AND command.command_id = candidates.command_id
  RETURNING command.command_id
$$;

CREATE OR REPLACE FUNCTION converact_agent_handoff_receipt_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Agent Handoff receipts are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_agent_handoff_receipts_immutable
  ON converact_agent_handoff_receipts;
CREATE TRIGGER converact_agent_handoff_receipts_immutable
  BEFORE UPDATE OR DELETE ON converact_agent_handoff_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_agent_handoff_receipt_immutable_guard();

CREATE OR REPLACE FUNCTION converact_agent_handoff_context_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Agent Handoff Context Packets are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_agent_handoff_context_packets_immutable
  ON converact_agent_handoff_context_packets;
CREATE TRIGGER converact_agent_handoff_context_packets_immutable
  BEFORE UPDATE OR DELETE ON converact_agent_handoff_context_packets
  FOR EACH ROW EXECUTE FUNCTION converact_agent_handoff_context_immutable_guard();

ALTER TABLE converact_agent_handoff_context_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_handoff_context_packets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_handoff_context_packets;
CREATE POLICY tenant_isolation ON converact_agent_handoff_context_packets FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_agent_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_handoffs;
CREATE POLICY tenant_isolation ON converact_agent_handoffs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_agent_handoff_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_handoff_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_handoff_commands;
CREATE POLICY tenant_isolation ON converact_agent_handoff_commands FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_agent_handoff_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_handoff_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_handoff_receipts;
CREATE POLICY tenant_isolation ON converact_agent_handoff_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_agent_handoff_claim_reconcile(
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_agent_handoff_receipt_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_agent_handoff_context_immutable_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_agent_handoff_context_packets TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_agent_handoffs TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_agent_handoff_commands TO opc_runtime;
    GRANT SELECT, INSERT ON converact_agent_handoff_receipts TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_agent_handoff_claim_reconcile(
      TEXT, TEXT, TEXT, BIGINT, INTEGER
    ) TO opc_runtime;
  END IF;
END
$grant$;
