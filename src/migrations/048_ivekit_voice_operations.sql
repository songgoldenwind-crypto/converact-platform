CREATE TABLE IF NOT EXISTS ivekit_voice_configuration_commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  resource_type TEXT NOT NULL
    CHECK (resource_type IN ('deployment_profile', 'sip_trunk', 'did', 'extension', 'route')),
  resource_id TEXT NOT NULL,
  operation TEXT NOT NULL
    CHECK (operation IN ('preflight', 'apply', 'test', 'disable', 'delete')),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled', 'uncertain')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  provider_command_id TEXT NOT NULL DEFAULT '',
  result JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE CASCADE,
  CHECK (attempt_count <= max_attempts),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_configuration_commands_due
  ON ivekit_voice_configuration_commands(state, next_attempt_at, created_at)
  WHERE state IN ('pending', 'retry_wait', 'processing', 'uncertain');

ALTER TABLE ivekit_voice_configuration_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_configuration_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_configuration_commands;
CREATE POLICY tenant_isolation ON ivekit_voice_configuration_commands FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

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
  ELSE
    RAISE EXCEPTION 'unsupported worker queue: %', p_queue USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_voice_profile_context(p_profile_id TEXT)
RETURNS TABLE (tenant_id TEXT, profile_id TEXT, adapter TEXT, secret_refs JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p.tenant_id, p.id, p.adapter, p.secret_refs
  FROM public.ivekit_voice_deployment_profiles p
  WHERE p.id = p_profile_id
    AND p.status <> 'archived';
$$;

REVOKE ALL ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_voice_profile_context(TEXT) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_worker_tenant_ids(TEXT, TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_ivekit_voice_profile_context(TEXT) TO opc_runtime';
  END IF;
END
$$;
