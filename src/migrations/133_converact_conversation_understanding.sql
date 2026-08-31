-- Additive durable ledger for realtime conversation-understanding evidence and latest heads.
-- This migration does not switch any existing writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_conversation_understanding_records (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL CHECK (char_length(record_id) BETWEEN 1 AND 255),
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'intent_observation', 'emotion_observation', 'emotion_fusion',
    'customer_state_snapshot', 'dialogue_recommendation'
  )),
  domain TEXT NOT NULL CHECK (domain IN ('intent', 'emotion', 'customer_state', 'dialogue')),
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 255),
  call_attempt_id TEXT NOT NULL CHECK (char_length(call_attempt_id) BETWEEN 1 AND 255),
  call_id TEXT CHECK (call_id IS NULL OR char_length(call_id) BETWEEN 1 AND 255),
  agent_release_id TEXT NOT NULL CHECK (char_length(agent_release_id) BETWEEN 1 AND 255),
  channel_agent_session_id TEXT CHECK (
    channel_agent_session_id IS NULL OR char_length(channel_agent_session_id) BETWEEN 1 AND 255
  ),
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  turn_index BIGINT NOT NULL CHECK (turn_index >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  retention_policy_ref TEXT NOT NULL CHECK (char_length(retention_policy_ref) BETWEEN 1 AND 255),
  retention_until TIMESTAMPTZ NOT NULL CHECK (retention_until > observed_at),
  payload JSONB NOT NULL CHECK (
    jsonb_typeof(payload) = 'object' AND octet_length(payload::TEXT) <= 131072
  ),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, record_id),
  CONSTRAINT converact_understanding_record_head_identity UNIQUE (
    tenant_id, record_id, domain, record_kind, interaction_id, call_attempt_id,
    execution_generation, turn_index, observed_at, payload_hash
  ),
  CHECK (
    (record_kind = 'intent_observation' AND domain = 'intent') OR
    (record_kind IN ('emotion_observation', 'emotion_fusion') AND domain = 'emotion') OR
    (record_kind = 'customer_state_snapshot' AND domain = 'customer_state') OR
    (record_kind = 'dialogue_recommendation' AND domain = 'dialogue')
  )
);

CREATE TABLE IF NOT EXISTS converact_conversation_understanding_heads (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 255),
  call_attempt_id TEXT NOT NULL CHECK (char_length(call_attempt_id) BETWEEN 1 AND 255),
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  domain TEXT NOT NULL CHECK (domain IN ('intent', 'emotion', 'customer_state', 'dialogue')),
  head_revision BIGINT NOT NULL CHECK (head_revision > 0),
  record_id TEXT NOT NULL CHECK (char_length(record_id) BETWEEN 1 AND 255),
  record_kind TEXT NOT NULL CHECK (record_kind IN (
    'intent_observation', 'emotion_observation', 'emotion_fusion',
    'customer_state_snapshot', 'dialogue_recommendation'
  )),
  turn_index BIGINT NOT NULL CHECK (turn_index >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, interaction_id, call_attempt_id, execution_generation, domain),
  UNIQUE (tenant_id, record_id),
  FOREIGN KEY (
    tenant_id, record_id, domain, record_kind, interaction_id, call_attempt_id,
    execution_generation, turn_index, observed_at, payload_hash
  ) REFERENCES converact_conversation_understanding_records (
    tenant_id, record_id, domain, record_kind, interaction_id, call_attempt_id,
    execution_generation, turn_index, observed_at, payload_hash
  ) ON DELETE RESTRICT,
  CHECK (
    (record_kind = 'intent_observation' AND domain = 'intent') OR
    (record_kind = 'emotion_fusion' AND domain = 'emotion') OR
    (record_kind = 'customer_state_snapshot' AND domain = 'customer_state') OR
    (record_kind = 'dialogue_recommendation' AND domain = 'dialogue')
  )
);

CREATE INDEX IF NOT EXISTS idx_converact_understanding_attempt_records
  ON converact_conversation_understanding_records (
    tenant_id, call_attempt_id, execution_generation, domain, turn_index, observed_at
  );

CREATE INDEX IF NOT EXISTS idx_converact_understanding_attempt_heads
  ON converact_conversation_understanding_heads (
    tenant_id, call_attempt_id, execution_generation, domain
  );

CREATE OR REPLACE FUNCTION converact_understanding_record_immutable_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) OR (
      current_user <> session_user
      AND current_setting('converact.understanding_retention_purge_tenant', TRUE) = OLD.tenant_id
      AND OLD.retention_until <= transaction_timestamp()
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'understanding records are immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_understanding_head_fence_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) OR (
      current_user <> session_user
      AND current_setting('converact.understanding_retention_purge_tenant', TRUE) = OLD.tenant_id
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'understanding heads cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.interaction_id <> OLD.interaction_id
    OR NEW.call_attempt_id <> OLD.call_attempt_id
    OR NEW.execution_generation <> OLD.execution_generation
    OR NEW.domain <> OLD.domain
    OR NOT (NEW.head_revision = OLD.head_revision + 1)
    OR NEW.record_id = OLD.record_id
    OR NEW.turn_index < OLD.turn_index
    OR NEW.observed_at < OLD.observed_at
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'understanding head fence violated' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS converact_understanding_records_immutable
  ON converact_conversation_understanding_records;
CREATE TRIGGER converact_understanding_records_immutable
  BEFORE UPDATE OR DELETE ON converact_conversation_understanding_records
  FOR EACH ROW EXECUTE FUNCTION converact_understanding_record_immutable_guard();

DROP TRIGGER IF EXISTS converact_understanding_heads_fenced
  ON converact_conversation_understanding_heads;
CREATE TRIGGER converact_understanding_heads_fenced
  BEFORE UPDATE OR DELETE ON converact_conversation_understanding_heads
  FOR EACH ROW EXECUTE FUNCTION converact_understanding_head_fence_guard();

CREATE OR REPLACE FUNCTION converact_purge_conversation_understanding(
  p_tenant_id TEXT,
  p_before TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  IF p_tenant_id <> opc_current_tenant()
    OR p_before > transaction_timestamp()
    OR NOT (p_limit BETWEEN 1 AND 1000)
  THEN
    RAISE EXCEPTION 'invalid understanding retention purge scope' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config(
    'converact.understanding_retention_purge_tenant', p_tenant_id, TRUE
  );

  WITH expired AS MATERIALIZED (
    SELECT record.tenant_id, record.record_id
    FROM public.converact_conversation_understanding_records AS record
    WHERE record.tenant_id = p_tenant_id
      AND record.retention_until <= p_before
      AND record.retention_until <= transaction_timestamp()
    ORDER BY record.retention_until, record.record_id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  ), cleared_heads AS (
    DELETE FROM public.converact_conversation_understanding_heads AS head
    USING expired
    WHERE head.tenant_id = expired.tenant_id
      AND head.record_id = expired.record_id
    RETURNING head.record_id
  )
  DELETE FROM public.converact_conversation_understanding_records AS record
  USING expired
  WHERE record.tenant_id = expired.tenant_id
    AND record.record_id = expired.record_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.converact_conversation_understanding_heads AS head
      WHERE head.tenant_id = record.tenant_id
        AND head.record_id = record.record_id
    )
    AND (SELECT count(*) FROM cleared_heads) >= 0;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END
$$;

DO $rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'converact_conversation_understanding_records',
    'converact_conversation_understanding_heads'
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

REVOKE ALL ON FUNCTION converact_understanding_record_immutable_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_understanding_head_fence_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_purge_conversation_understanding(
  TEXT, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_conversation_understanding_records TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON converact_conversation_understanding_heads TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_purge_conversation_understanding(
      TEXT, TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
  END IF;
END
$grant$;
