-- Additive conversation-result and quality authority. This migration does not switch any writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_conversation_transcript_segments (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  segment_sequence BIGINT NOT NULL CHECK (segment_sequence > 0),
  speaker TEXT NOT NULL CHECK (speaker IN ('customer', 'ai_agent', 'human_agent', 'system')),
  language TEXT NOT NULL CHECK (char_length(language) BETWEEN 2 AND 35),
  transcript_text TEXT NOT NULL CHECK (
    char_length(transcript_text) BETWEEN 1 AND 32768
    AND transcript_text !~ '[[:cntrl:]]'
  ),
  start_offset_ms BIGINT NOT NULL CHECK (start_offset_ms >= 0),
  end_offset_ms BIGINT NOT NULL CHECK (end_offset_ms >= start_offset_ms),
  observed_at TIMESTAMPTZ NOT NULL,
  retention_policy_ref TEXT NOT NULL CHECK (char_length(retention_policy_ref) BETWEEN 1 AND 255),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  historical BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, segment_id),
  UNIQUE (tenant_id, interaction_id, source_event_id),
  UNIQUE (tenant_id, interaction_id, execution_generation, segment_sequence),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_conversation_snapshots (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  snapshot_revision BIGINT NOT NULL CHECK (snapshot_revision > 0),
  transcript_snapshot_digest TEXT NOT NULL CHECK (transcript_snapshot_digest ~ '^[0-9a-f]{64}$'),
  segment_count BIGINT NOT NULL CHECK (segment_count >= 0),
  max_execution_generation BIGINT NOT NULL CHECK (max_execution_generation > 0),
  call_terminal_observed BOOLEAN NOT NULL,
  agent_terminal_observed BOOLEAN NOT NULL,
  transcript_terminal_observed BOOLEAN NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  frozen_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, snapshot_id),
  UNIQUE (tenant_id, interaction_id, snapshot_revision),
  UNIQUE (tenant_id, interaction_id, transcript_snapshot_digest),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    transcript_terminal_observed = FALSE OR
    (call_terminal_observed AND agent_terminal_observed)
  )
);

CREATE TABLE IF NOT EXISTS converact_conversation_results (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  result_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  result_revision BIGINT NOT NULL CHECK (result_revision > 0),
  outcome_schema_revision_id TEXT NOT NULL,
  transcript_snapshot_digest TEXT NOT NULL CHECK (transcript_snapshot_digest ~ '^[0-9a-f]{64}$'),
  summary_artifact_ref TEXT NOT NULL CHECK (char_length(summary_artifact_ref) BETWEEN 1 AND 2048),
  intent_code TEXT NOT NULL CHECK (char_length(intent_code) BETWEEN 1 AND 128),
  disposition_code TEXT NOT NULL CHECK (char_length(disposition_code) BETWEEN 1 AND 128),
  outcome_code TEXT NOT NULL CHECK (char_length(outcome_code) BETWEEN 1 AND 128),
  confidence_bps INTEGER NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  attributes JSONB NOT NULL CHECK (
    jsonb_typeof(attributes) = 'object' AND octet_length(attributes::TEXT) <= 65536
  ),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, result_id),
  UNIQUE (tenant_id, interaction_id, result_revision),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_conversation_evaluations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_revision BIGINT NOT NULL CHECK (result_revision > 0),
  evaluator_release_id TEXT NOT NULL,
  evaluation_rubric_revision_id TEXT NOT NULL,
  dimension_scores JSONB NOT NULL CHECK (
    jsonb_typeof(dimension_scores) = 'object'
    AND octet_length(dimension_scores::TEXT) <= 65536
  ),
  evidence_segment_ids JSONB NOT NULL CHECK (
    jsonb_typeof(evidence_segment_ids) = 'array'
    AND octet_length(evidence_segment_ids::TEXT) <= 65536
  ),
  violation_codes JSONB NOT NULL CHECK (
    jsonb_typeof(violation_codes) = 'array'
    AND octet_length(violation_codes::TEXT) <= 32768
  ),
  overall_score_bps INTEGER NOT NULL CHECK (overall_score_bps BETWEEN 0 AND 10000),
  quality_grade TEXT NOT NULL CHECK (quality_grade IN ('pass', 'warn', 'fail')),
  bad_case_reasons JSONB NOT NULL CHECK (
    jsonb_typeof(bad_case_reasons) = 'array'
    AND octet_length(bad_case_reasons::TEXT) <= 32768
  ),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, evaluation_id),
  UNIQUE (tenant_id, result_id, evaluation_rubric_revision_id),
  FOREIGN KEY (tenant_id, result_id)
    REFERENCES converact_conversation_results(tenant_id, result_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_conversation_bad_cases (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bad_case_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL,
  bad_case_reasons JSONB NOT NULL CHECK (
    jsonb_typeof(bad_case_reasons) = 'array'
    AND jsonb_array_length(bad_case_reasons) > 0
    AND octet_length(bad_case_reasons::TEXT) <= 32768
  ),
  review_state TEXT NOT NULL CHECK (review_state IN ('pending', 'reviewed', 'dismissed')),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, bad_case_id),
  UNIQUE (tenant_id, evaluation_id),
  FOREIGN KEY (tenant_id, evaluation_id)
    REFERENCES converact_conversation_evaluations(tenant_id, evaluation_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS converact_conversation_projection_commands (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  command_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('freeze_snapshot', 'persist_result', 'persist_evaluation')),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  expected_result_revision BIGINT CHECK (expected_result_revision IS NULL OR expected_result_revision > 0),
  expected_execution_generation BIGINT NOT NULL CHECK (expected_execution_generation > 0),
  command_state TEXT NOT NULL CHECK (command_state IN ('prepared', 'state_observed')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('applied', 'not_applied')),
  failure_code TEXT CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 255),
  observed_entity_id TEXT,
  observed_payload_hash TEXT CHECK (
    observed_payload_hash IS NULL OR observed_payload_hash ~ '^[0-9a-f]{64}$'
  ),
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
  CHECK (
    (command_state = 'prepared' AND resolution IS NULL AND failure_code IS NULL
      AND observed_entity_id IS NULL AND observed_payload_hash IS NULL
      AND state_observed_at IS NULL) OR
    (command_state = 'state_observed' AND resolution = 'applied'
      AND failure_code IS NULL AND observed_entity_id IS NOT NULL
      AND observed_payload_hash IS NOT NULL AND state_observed_at IS NOT NULL) OR
    (command_state = 'state_observed' AND resolution = 'not_applied'
      AND failure_code IS NOT NULL AND observed_entity_id IS NULL
      AND observed_payload_hash IS NULL AND state_observed_at IS NOT NULL)
  ),
  CHECK (
    (lease_owner = '' AND lease_token_hash = '' AND lease_expires_at IS NULL) OR
    (lease_owner <> '' AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS converact_conversation_projection_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('prepared', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('applied', 'not_applied')),
  failure_code TEXT CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 255),
  observed_entity_id TEXT,
  observed_payload_hash TEXT CHECK (
    observed_payload_hash IS NULL OR observed_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, command_id, stage),
  FOREIGN KEY (tenant_id, command_id)
    REFERENCES converact_conversation_projection_commands(tenant_id, command_id) ON DELETE RESTRICT,
  CHECK (
    (stage = 'prepared' AND resolution IS NULL AND failure_code IS NULL
      AND observed_entity_id IS NULL AND observed_payload_hash IS NULL) OR
    (stage = 'state_observed' AND resolution = 'applied' AND failure_code IS NULL
      AND observed_entity_id IS NOT NULL AND observed_payload_hash IS NOT NULL) OR
    (stage = 'state_observed' AND resolution = 'not_applied' AND failure_code IS NOT NULL
      AND observed_entity_id IS NULL AND observed_payload_hash IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_converact_conversation_transcript_order
  ON converact_conversation_transcript_segments (
    tenant_id, interaction_id, execution_generation, segment_sequence
  );
CREATE INDEX IF NOT EXISTS idx_converact_conversation_result_latest
  ON converact_conversation_results (tenant_id, interaction_id, result_revision DESC);
CREATE INDEX IF NOT EXISTS idx_converact_conversation_bad_case_queue
  ON converact_conversation_bad_cases (tenant_id, review_state, created_at, bad_case_id);
CREATE INDEX IF NOT EXISTS idx_converact_conversation_projection_claim
  ON converact_conversation_projection_commands (tenant_id, prepared_at, command_id)
  WHERE command_state = 'prepared';

CREATE OR REPLACE FUNCTION converact_conversation_projection_claim_reconcile(
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
    FROM public.converact_conversation_projection_commands AS command
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
  UPDATE public.converact_conversation_projection_commands AS command
  SET lease_owner = p_lease_owner,
      lease_token_hash = p_lease_token_hash,
      lease_expires_at = transaction_timestamp() + (p_lease_ms * interval '1 millisecond'),
      updated_at = transaction_timestamp()
  FROM candidates
  WHERE command.tenant_id = candidates.tenant_id
    AND command.command_id = candidates.command_id
  RETURNING command.command_id
$$;

CREATE OR REPLACE FUNCTION converact_conversation_transcript_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'conversation transcript segments are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_conversation_result_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'conversation results are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_conversation_snapshot_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'conversation snapshots are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_conversation_evaluation_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'conversation evaluations are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_conversation_projection_receipt_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'conversation projection receipts are immutable' USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER converact_conversation_transcript_segments_immutable
  BEFORE UPDATE OR DELETE ON converact_conversation_transcript_segments
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_transcript_immutable_guard();
CREATE TRIGGER converact_conversation_results_immutable
  BEFORE UPDATE OR DELETE ON converact_conversation_results
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_result_immutable_guard();
CREATE TRIGGER converact_conversation_snapshots_immutable
  BEFORE UPDATE OR DELETE ON converact_conversation_snapshots
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_snapshot_immutable_guard();
CREATE TRIGGER converact_conversation_evaluations_immutable
  BEFORE UPDATE OR DELETE ON converact_conversation_evaluations
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_evaluation_immutable_guard();
CREATE TRIGGER converact_conversation_projection_receipts_immutable
  BEFORE UPDATE OR DELETE ON converact_conversation_projection_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_projection_receipt_immutable_guard();

DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'converact_conversation_transcript_segments',
    'converact_conversation_snapshots',
    'converact_conversation_results',
    'converact_conversation_evaluations',
    'converact_conversation_bad_cases',
    'converact_conversation_projection_commands',
    'converact_conversation_projection_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (opc_rls_bypass() OR tenant_id = opc_current_tenant()) WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
      table_name
    );
  END LOOP;
END
$rls$;

REVOKE ALL ON FUNCTION converact_conversation_projection_claim_reconcile(
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_conversation_transcript_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_conversation_result_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_conversation_snapshot_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_conversation_evaluation_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_conversation_projection_receipt_immutable_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_conversation_transcript_segments TO opc_runtime;
    GRANT SELECT, INSERT ON converact_conversation_snapshots TO opc_runtime;
    GRANT SELECT, INSERT ON converact_conversation_results TO opc_runtime;
    GRANT SELECT, INSERT ON converact_conversation_evaluations TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_conversation_bad_cases TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_conversation_projection_commands TO opc_runtime;
    GRANT SELECT, INSERT ON converact_conversation_projection_receipts TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_conversation_projection_claim_reconcile(
      TEXT, TEXT, TEXT, BIGINT, INTEGER
    ) TO opc_runtime;
  END IF;
END
$grant$;
