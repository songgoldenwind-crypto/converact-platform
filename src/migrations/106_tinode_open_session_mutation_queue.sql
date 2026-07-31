UPDATE public.collaboration_message_delivery_attempts AS attempt
SET status = 'failed',
    completed_at = CURRENT_TIMESTAMP,
    error_code = 'session_closed',
    error_message = 'collaboration session closed before provider delivery completed'
FROM public.collaboration_messages AS message
JOIN public.collaboration_sessions AS session
  ON session.id = message.session_id
 AND session.tenant_id = message.tenant_id
WHERE attempt.message_id = message.id
  AND attempt.tenant_id = message.tenant_id
  AND attempt.status = 'started'
  AND message.provider = 'tinode'
  AND message.provider_delivery_status IN (
    'pending', 'blocked_by_file_security', 'publishing', 'retry_wait'
  )
  AND session.status = 'closed';

UPDATE public.collaboration_messages AS message
SET provider_delivery_status = 'failed',
    provider_delivery_claim_token_hash = '',
    provider_delivery_lease_until = NULL,
    provider_next_attempt_at = NULL,
    provider_last_error_code = 'session_closed',
    provider_last_error_message = 'collaboration session closed before provider delivery completed',
    provider_delivery_updated_at = CURRENT_TIMESTAMP
FROM public.collaboration_sessions AS session
WHERE session.id = message.session_id
  AND session.tenant_id = message.tenant_id
  AND session.status = 'closed'
  AND message.provider = 'tinode'
  AND message.provider_delivery_status IN (
    'pending', 'blocked_by_file_security', 'publishing', 'retry_wait'
  );

UPDATE public.tinode_message_mutation_outbox AS outbox
SET status = 'dead_letter',
    next_attempt_at = NULL,
    claim_token = '',
    claimed_until = NULL,
    last_error_code = 'session_closed',
    last_error_message = 'collaboration session closed before provider mutation completed',
    completed_at = COALESCE(outbox.completed_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
FROM public.collaboration_sessions AS session
WHERE session.id = outbox.session_id
  AND session.tenant_id = outbox.tenant_id
  AND session.status = 'closed'
  AND outbox.status IN ('pending', 'processing', 'retry_wait');

CREATE OR REPLACE FUNCTION opc_tinode_delivery_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT message.tenant_id
  FROM public.collaboration_messages AS message
  JOIN public.collaboration_sessions AS session
    ON session.id = message.session_id
   AND session.tenant_id = message.tenant_id
   AND session.status = 'open'
  WHERE message.provider = 'tinode'
    AND (
      message.provider_delivery_status IN ('pending', 'blocked_by_file_security')
      OR (
        message.provider_delivery_status = 'retry_wait'
        AND (message.provider_next_attempt_at IS NULL OR message.provider_next_attempt_at <= p_now)
      )
      OR (
        message.provider_delivery_status = 'publishing'
        AND message.provider_delivery_lease_until <= p_now
      )
    )
  GROUP BY message.tenant_id
  ORDER BY MIN(COALESCE(message.provider_next_attempt_at, message.created_at)), message.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

CREATE OR REPLACE FUNCTION opc_tinode_mutation_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT outbox.tenant_id
  FROM public.tinode_message_mutation_outbox AS outbox
  JOIN public.collaboration_messages AS message
    ON message.id = outbox.message_id AND message.tenant_id = outbox.tenant_id
  JOIN public.collaboration_sessions AS session
    ON session.id = outbox.session_id
   AND session.tenant_id = outbox.tenant_id
   AND session.status = 'open'
  WHERE message.provider = 'tinode'
    AND message.provider_message_id <> ''
    AND outbox.attempt_count < outbox.max_attempts
    AND (
      outbox.status = 'pending'
      OR (outbox.status = 'retry_wait' AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= p_now))
      OR (outbox.status = 'processing' AND outbox.claimed_until <= p_now)
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.tinode_message_mutation_outbox AS earlier
      WHERE earlier.tenant_id = outbox.tenant_id
        AND earlier.message_id = outbox.message_id
        AND earlier.mutation_version < outbox.mutation_version
        AND earlier.status <> 'delivered'
    )
  GROUP BY outbox.tenant_id
  ORDER BY MIN(COALESCE(outbox.next_attempt_at, outbox.created_at)), outbox.tenant_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

REVOKE ALL ON FUNCTION opc_tinode_delivery_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_tinode_mutation_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_delivery_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_mutation_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
