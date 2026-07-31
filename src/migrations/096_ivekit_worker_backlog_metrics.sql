CREATE OR REPLACE FUNCTION opc_ivekit_worker_backlog_metrics(
  p_now TIMESTAMPTZ
)
RETURNS TABLE(pool TEXT, depth BIGINT, oldest_age_seconds DOUBLE PRECISION)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT 'notification'::TEXT,
    COUNT(*)::BIGINT,
    GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (
      p_now - MIN(COALESCE(delivery.next_attempt_at, delivery.updated_at))
    )), 0))::DOUBLE PRECISION
  FROM public.ivekit_notification_deliveries delivery
  WHERE (
      delivery.state IN ('pending', 'retry_wait')
      AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= p_now)
    ) OR (
      delivery.state = 'processing'
      AND (delivery.lease_until IS NULL OR delivery.lease_until <= p_now)
    )
  UNION ALL
  SELECT 'event-webhook'::TEXT,
    COUNT(*)::BIGINT,
    GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (
      p_now - MIN(subscription.next_attempt_at)
    )), 0))::DOUBLE PRECISION
  FROM public.ivekit_event_webhook_subscriptions subscription
  WHERE subscription.status = 'active'
    AND subscription.next_attempt_at <= p_now
    AND (subscription.lease_until IS NULL OR subscription.lease_until <= p_now)
    AND EXISTS (
      SELECT 1
      FROM public.ivekit_tenant_events event
      WHERE event.tenant_id = subscription.tenant_id
        AND event.id > subscription.last_event_id
        AND event.expires_at > p_now
    )
  UNION ALL
  SELECT 'attachment'::TEXT,
    COUNT(*)::BIGINT,
    GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (
      p_now - MIN(COALESCE(job.next_attempt_at, job.updated_at))
    )), 0))::DOUBLE PRECISION
  FROM public.collaboration_attachment_processing_jobs job
  WHERE (
      job.status IN ('pending', 'retry_wait')
      AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= p_now)
    ) OR (
      job.status = 'processing'
      AND (job.lease_until IS NULL OR job.lease_until <= p_now)
    )
  UNION ALL
  SELECT 'quality'::TEXT,
    COUNT(*)::BIGINT,
    GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (
      p_now - MIN(COALESCE(job.next_attempt_at, job.updated_at))
    )), 0))::DOUBLE PRECISION
  FROM public.collaboration_quality_review_jobs job
  WHERE (
      job.status IN ('pending', 'retry_wait')
      AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= p_now)
    ) OR (
      job.status = 'processing'
      AND (job.lease_until IS NULL OR job.lease_until <= p_now)
    )
  UNION ALL
  SELECT 'translation'::TEXT,
    COUNT(*)::BIGINT,
    GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (
      p_now - MIN(COALESCE(job.next_attempt_at, job.updated_at))
    )), 0))::DOUBLE PRECISION
  FROM public.collaboration_translation_jobs job
  WHERE (
      job.status IN ('pending', 'retry_wait')
      AND (job.next_attempt_at IS NULL OR job.next_attempt_at <= p_now)
    ) OR (
      job.status = 'processing'
      AND (job.lease_until IS NULL OR job.lease_until <= p_now)
    )
  UNION ALL
  SELECT 'file-security'::TEXT,
    COUNT(*)::BIGINT,
    GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (
      p_now - MIN(due.updated_at)
    )), 0))::DOUBLE PRECISION
  FROM (
    SELECT file.updated_at
    FROM public.collaboration_secure_files file
    WHERE file.status = 'scanning'
      AND (file.next_attempt_at IS NULL OR file.next_attempt_at <= p_now)
      AND (file.lease_until IS NULL OR file.lease_until <= p_now)
    UNION ALL
    SELECT derivative.updated_at
    FROM public.collaboration_secure_file_derivatives derivative
    JOIN public.collaboration_secure_files file
      ON file.tenant_id = derivative.tenant_id
      AND file.id = derivative.secure_file_id
    WHERE file.status = 'processing'
      AND derivative.status IN ('pending', 'processing', 'retry_wait')
      AND (derivative.next_attempt_at IS NULL OR derivative.next_attempt_at <= p_now)
      AND (derivative.lease_until IS NULL OR derivative.lease_until <= p_now)
  ) due
$$;

REVOKE ALL ON FUNCTION opc_ivekit_worker_backlog_metrics(TIMESTAMPTZ) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION opc_ivekit_worker_backlog_metrics(TIMESTAMPTZ) TO opc_runtime;
  END IF;
END
$$;
