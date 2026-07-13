ALTER TABLE ivekit_ivr_flow_versions
  ADD COLUMN IF NOT EXISTS release_kind TEXT NOT NULL DEFAULT 'publish'
    CHECK (release_kind IN ('publish', 'rollback')),
  ADD COLUMN IF NOT EXISTS source_version INTEGER CHECK (source_version > 0),
  ADD COLUMN IF NOT EXISTS publication_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS publication_payload_hash TEXT NOT NULL DEFAULT ''
    CHECK (publication_payload_hash = '' OR char_length(publication_payload_hash) = 64),
  ADD COLUMN IF NOT EXISTS release_metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

-- A rollback is a new immutable version and can intentionally reuse a
-- historical graph hash. Keep hash lookup indexed without making it unique.
ALTER TABLE ivekit_ivr_flow_versions
  DROP CONSTRAINT IF EXISTS ivekit_ivr_flow_versions_tenant_id_flow_id_graph_hash_key;
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_versions_graph_hash
  ON ivekit_ivr_flow_versions(tenant_id, flow_id, graph_hash);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_ivr_versions_publication_key
  ON ivekit_ivr_flow_versions(tenant_id, publication_key)
  WHERE publication_key <> '';
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_versions_published
  ON ivekit_ivr_flow_versions(tenant_id, flow_id, published_at DESC, version DESC);

ALTER TABLE ivekit_ivr_sessions
  ADD COLUMN IF NOT EXISTS provider_profile_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_session_id TEXT,
  ADD COLUMN IF NOT EXISTS last_event_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (last_event_sequence >= 0),
  ADD COLUMN IF NOT EXISTS last_event_payload_hash TEXT NOT NULL DEFAULT ''
    CHECK (last_event_payload_hash = '' OR char_length(last_event_payload_hash) = 64),
  ADD COLUMN IF NOT EXISTS last_action_revision INTEGER NOT NULL DEFAULT 0
    CHECK (last_action_revision >= 0),
  ADD COLUMN IF NOT EXISTS last_action JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS provider_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS trace_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ivekit_ivr_sessions_provider_binding_pair'
  ) THEN
    ALTER TABLE ivekit_ivr_sessions
      ADD CONSTRAINT ivekit_ivr_sessions_provider_binding_pair CHECK (
        (provider_profile_id IS NULL AND provider_session_id IS NULL)
        OR (provider_profile_id <> '' AND provider_session_id <> '')
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ivekit_ivr_sessions_provider_profile_fk'
  ) THEN
    ALTER TABLE ivekit_ivr_sessions
      ADD CONSTRAINT ivekit_ivr_sessions_provider_profile_fk
      FOREIGN KEY (tenant_id, provider_profile_id)
      REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_ivr_sessions_provider_binding
  ON ivekit_ivr_sessions(tenant_id, provider_profile_id, provider_session_id)
  WHERE provider_profile_id IS NOT NULL AND provider_session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_sessions_tenant_updated
  ON ivekit_ivr_sessions(tenant_id, updated_at DESC, id DESC);

ALTER TABLE ivekit_ivr_pending_actions
  ADD COLUMN IF NOT EXISTS trace_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS dispatch_mode TEXT NOT NULL DEFAULT 'worker'
    CHECK (dispatch_mode IN ('worker', 'provider_exchange')),
  ADD COLUMN IF NOT EXISTS reconciliation_count INTEGER NOT NULL DEFAULT 0
    CHECK (reconciliation_count >= 0);

ALTER TABLE ivekit_ivr_pending_actions
  DROP CONSTRAINT IF EXISTS ivekit_ivr_pending_actions_action_kind_check;
ALTER TABLE ivekit_ivr_pending_actions
  ADD CONSTRAINT ivekit_ivr_pending_actions_action_kind_check CHECK (
    action_kind IN (
      'play', 'collect', 'flush', 'queue', 'transfer', 'record', 'webhook',
      'knowledge', 'ai', 'media', 'hangup', 'wait'
    )
  );

CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_actions_tenant_due
  ON ivekit_ivr_pending_actions(
    tenant_id, state, COALESCE(next_attempt_at, created_at), id
  ) WHERE state IN ('pending', 'retry_wait', 'processing', 'uncertain');

CREATE OR REPLACE FUNCTION opc_worker_tenant_ids(
  p_queue TEXT,
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  bounded_limit INTEGER := least(greatest(p_limit, 1), 1000);
BEGIN
  IF p_queue = 'tinode' THEN
    RETURN QUERY
      SELECT m.tenant_id FROM public.collaboration_messages m
      WHERE m.provider = 'tinode' AND (
        m.provider_delivery_status = 'pending'
        OR (m.provider_delivery_status = 'retry_wait' AND (m.provider_next_attempt_at IS NULL OR m.provider_next_attempt_at <= p_now))
        OR (m.provider_delivery_status = 'publishing' AND m.provider_delivery_lease_until <= p_now)
      ) GROUP BY m.tenant_id ORDER BY min(coalesce(m.provider_next_attempt_at, m.created_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'attachment' THEN
    RETURN QUERY
      SELECT j.tenant_id FROM public.collaboration_attachment_processing_jobs j
      WHERE (j.status = 'pending'
        OR (j.status = 'retry_wait' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= p_now))
        OR (j.status = 'processing' AND j.lease_until <= p_now))
        AND j.attempt_count < j.max_attempts
      GROUP BY j.tenant_id ORDER BY min(coalesce(j.next_attempt_at, j.created_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'quality' THEN
    RETURN QUERY
      SELECT j.tenant_id FROM public.collaboration_quality_review_jobs j
      WHERE (j.status = 'pending'
        OR (j.status = 'retry_wait' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= p_now))
        OR (j.status = 'processing' AND j.lease_until <= p_now))
        AND j.attempt_count < j.max_attempts
      GROUP BY j.tenant_id ORDER BY min(coalesce(j.next_attempt_at, j.created_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'translation' THEN
    RETURN QUERY
      SELECT j.tenant_id FROM public.collaboration_translation_jobs j
      WHERE (j.status = 'pending'
        OR (j.status = 'retry_wait' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= p_now))
        OR (j.status = 'processing' AND j.lease_until <= p_now))
        AND j.attempt_count < j.max_attempts
      GROUP BY j.tenant_id ORDER BY min(coalesce(j.next_attempt_at, j.created_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'media_call_timeout' THEN
    RETURN QUERY
      SELECT c.tenant_id FROM public.ivekit_media_calls c
      WHERE c.status = 'ringing' AND c.ring_expires_at IS NOT NULL AND c.ring_expires_at <= p_now
      GROUP BY c.tenant_id ORDER BY min(c.ring_expires_at) LIMIT bounded_limit;
  ELSIF p_queue = 'voice_command' THEN
    RETURN QUERY
      SELECT c.tenant_id FROM public.ivekit_voice_call_commands c
      WHERE (
        ((c.state = 'pending'
          OR (c.state = 'retry_wait' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= p_now))
          OR (c.state = 'processing' AND c.lease_until <= p_now))
          AND c.attempt_count < c.max_attempts)
        OR (c.state = 'uncertain' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= p_now))
      )
      GROUP BY c.tenant_id ORDER BY min(coalesce(c.next_attempt_at, c.created_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'voice_configuration' THEN
    RETURN QUERY
      SELECT c.tenant_id FROM public.ivekit_voice_configuration_commands c
      WHERE (
        ((c.state = 'pending'
          OR (c.state = 'retry_wait' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= p_now))
          OR (c.state = 'processing' AND c.lease_until <= p_now))
          AND c.attempt_count < c.max_attempts)
        OR (c.state = 'uncertain' AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= p_now))
      )
      GROUP BY c.tenant_id ORDER BY min(coalesce(c.next_attempt_at, c.created_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'voice_provider_event' THEN
    RETURN QUERY
      SELECT e.tenant_id FROM public.ivekit_voice_provider_events e
      WHERE e.processing_state = 'pending'
        OR (e.processing_state = 'retry_wait' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= p_now))
        OR (e.processing_state = 'processing' AND e.lease_until <= p_now)
      GROUP BY e.tenant_id ORDER BY min(coalesce(e.next_attempt_at, e.received_at)) LIMIT bounded_limit;
  ELSIF p_queue = 'ivr_pending_action' THEN
    RETURN QUERY
      SELECT a.tenant_id FROM public.ivekit_ivr_pending_actions a
      WHERE a.dispatch_mode = 'worker' AND (
        ((a.state = 'pending'
          OR (a.state = 'retry_wait' AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= p_now))
          OR (a.state = 'processing' AND a.lease_until <= p_now))
          AND a.attempt_count < a.max_attempts)
        OR (a.state = 'uncertain' AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= p_now))
      )
      GROUP BY a.tenant_id ORDER BY min(coalesce(a.next_attempt_at, a.created_at)) LIMIT bounded_limit;
  ELSE
    RAISE EXCEPTION 'unsupported worker queue: %', p_queue USING ERRCODE = '22023';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
