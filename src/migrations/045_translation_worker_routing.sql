ALTER TABLE collaboration_translation_jobs
  ADD COLUMN IF NOT EXISTS automatic BOOLEAN NOT NULL DEFAULT FALSE;

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
