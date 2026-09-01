-- Additive per-stream sequence authority for final transcript ingestion.
-- Existing streams may contain historical gaps; after backfill every new append is max + 1.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_conversation_transcript_stream_heads (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 255),
  call_attempt_id TEXT NOT NULL CHECK (char_length(call_attempt_id) BETWEEN 1 AND 255),
  agent_release_id TEXT NOT NULL CHECK (char_length(agent_release_id) BETWEEN 1 AND 255),
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  last_sequence BIGINT NOT NULL CHECK (last_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, interaction_id, execution_generation),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT
);

DO $validate_existing$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM converact_conversation_transcript_segments
    GROUP BY tenant_id, interaction_id, execution_generation
    HAVING COUNT(DISTINCT (call_attempt_id, agent_release_id)) <> 1
  ) THEN
    RAISE EXCEPTION 'existing transcript stream has mixed authority'
      USING ERRCODE = '23514';
  END IF;
END
$validate_existing$;

INSERT INTO converact_conversation_transcript_stream_heads (
  tenant_id, interaction_id, call_attempt_id, agent_release_id,
  execution_generation, last_sequence
)
SELECT
  tenant_id,
  interaction_id,
  MIN(call_attempt_id),
  MIN(agent_release_id),
  execution_generation,
  MAX(segment_sequence)
FROM converact_conversation_transcript_segments
GROUP BY tenant_id, interaction_id, execution_generation
ON CONFLICT (tenant_id, interaction_id, execution_generation) DO NOTHING;

DO $validate_heads$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        tenant_id,
        interaction_id,
        execution_generation,
        MIN(call_attempt_id) AS call_attempt_id,
        MIN(agent_release_id) AS agent_release_id,
        MAX(segment_sequence) AS last_sequence
      FROM converact_conversation_transcript_segments
      GROUP BY tenant_id, interaction_id, execution_generation
    ) AS stream
    JOIN converact_conversation_transcript_stream_heads AS head
      USING (tenant_id, interaction_id, execution_generation)
    WHERE head.call_attempt_id <> stream.call_attempt_id
      OR head.agent_release_id <> stream.agent_release_id
      OR head.last_sequence <> stream.last_sequence
  ) THEN
    RAISE EXCEPTION 'transcript stream head backfill conflict' USING ERRCODE = '23514';
  END IF;
END
$validate_heads$;

CREATE OR REPLACE FUNCTION converact_conversation_transcript_stream_head_fence_guard()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  stored_sequence BIGINT;
  stored_call_attempt_id TEXT;
  stored_agent_release_id TEXT;
BEGIN
  IF TG_OP <> 'DELETE' THEN
    SELECT MAX(segment_sequence), MIN(call_attempt_id), MIN(agent_release_id)
    INTO stored_sequence, stored_call_attempt_id, stored_agent_release_id
    FROM public.converact_conversation_transcript_segments
    WHERE tenant_id = NEW.tenant_id
      AND interaction_id = NEW.interaction_id
      AND execution_generation = NEW.execution_generation;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (NEW.last_sequence = 0 AND stored_sequence IS NULL) OR (
      NEW.last_sequence = stored_sequence
      AND NEW.call_attempt_id = stored_call_attempt_id
      AND NEW.agent_release_id = stored_agent_release_id
    ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'transcript stream head insert is not backed by stored segments'
      USING ERRCODE = '40001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'transcript stream heads cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id
    OR NEW.interaction_id <> OLD.interaction_id
    OR NEW.call_attempt_id <> OLD.call_attempt_id
    OR NEW.agent_release_id <> OLD.agent_release_id
    OR NEW.execution_generation <> OLD.execution_generation
    OR NEW.last_sequence <> OLD.last_sequence + 1
    OR NEW.last_sequence IS DISTINCT FROM stored_sequence
    OR NEW.call_attempt_id IS DISTINCT FROM stored_call_attempt_id
    OR NEW.agent_release_id IS DISTINCT FROM stored_agent_release_id
    OR NEW.updated_at < OLD.updated_at
  THEN
    RAISE EXCEPTION 'transcript stream head fence violated' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION converact_conversation_transcript_advance_stream_head()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  advanced_sequence BIGINT;
BEGIN
  UPDATE public.converact_conversation_transcript_stream_heads AS head
  SET last_sequence = head.last_sequence + 1,
      updated_at = transaction_timestamp()
  WHERE head.tenant_id = NEW.tenant_id
    AND head.interaction_id = NEW.interaction_id
    AND head.execution_generation = NEW.execution_generation
    AND head.call_attempt_id = NEW.call_attempt_id
    AND head.agent_release_id = NEW.agent_release_id
    AND head.last_sequence + 1 = NEW.segment_sequence
  RETURNING head.last_sequence INTO advanced_sequence;

  IF advanced_sequence IS NULL THEN
    INSERT INTO public.converact_conversation_transcript_stream_heads (
      tenant_id, interaction_id, call_attempt_id, agent_release_id,
      execution_generation, last_sequence
    ) VALUES (
      NEW.tenant_id, NEW.interaction_id, NEW.call_attempt_id, NEW.agent_release_id,
      NEW.execution_generation, NEW.segment_sequence
    )
    ON CONFLICT DO NOTHING
    RETURNING last_sequence INTO advanced_sequence;
  END IF;

  IF advanced_sequence IS DISTINCT FROM NEW.segment_sequence THEN
    RAISE EXCEPTION 'transcript segment sequence is not the next stream sequence'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS converact_conversation_transcript_stream_heads_fenced
  ON converact_conversation_transcript_stream_heads;
CREATE TRIGGER converact_conversation_transcript_stream_heads_fenced
  BEFORE INSERT OR UPDATE OR DELETE ON converact_conversation_transcript_stream_heads
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_transcript_stream_head_fence_guard();

DROP TRIGGER IF EXISTS converact_conversation_transcript_advance_stream_head
  ON converact_conversation_transcript_segments;
CREATE TRIGGER converact_conversation_transcript_advance_stream_head
  AFTER INSERT ON converact_conversation_transcript_segments
  FOR EACH ROW EXECUTE FUNCTION converact_conversation_transcript_advance_stream_head();

ALTER TABLE converact_conversation_transcript_stream_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_conversation_transcript_stream_heads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_conversation_transcript_stream_heads;
CREATE POLICY tenant_isolation ON converact_conversation_transcript_stream_heads
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_conversation_transcript_stream_head_fence_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_conversation_transcript_advance_stream_head() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE
      ON converact_conversation_transcript_stream_heads TO opc_runtime;
  END IF;
END
$grant$;
