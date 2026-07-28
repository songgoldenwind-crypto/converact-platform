UPDATE public.tinode_inbound_cursors AS cursor
SET status = 'paused',
    lease_token_hash = '',
    lease_until = NULL,
    next_retry_at = NULL,
    last_error_code = '',
    last_error_message = '',
    updated_at = CURRENT_TIMESTAMP
FROM public.collaboration_chat_bindings AS binding
JOIN public.collaboration_sessions AS session
  ON session.tenant_id = binding.tenant_id
 AND session.id = binding.session_id
WHERE cursor.tenant_id = binding.tenant_id
  AND cursor.binding_id = binding.id
  AND binding.provider = 'tinode'
  AND session.status = 'closed';

CREATE OR REPLACE FUNCTION opc_tinode_inbound_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT binding.tenant_id
  FROM public.collaboration_chat_bindings AS binding
  JOIN public.collaboration_sessions AS session
    ON session.tenant_id = binding.tenant_id
   AND session.id = binding.session_id
   AND session.status = 'open'
  LEFT JOIN public.tinode_inbound_cursors AS cursor
    ON cursor.tenant_id = binding.tenant_id
   AND cursor.binding_id = binding.id
  WHERE binding.provider = 'tinode'
    AND binding.provider_status = 'bound'
    AND (
      cursor.id IS NULL
      OR (
        cursor.status IN ('active', 'error')
        AND (cursor.next_retry_at IS NULL OR cursor.next_retry_at <= p_now)
        AND (cursor.lease_until IS NULL OR cursor.lease_until <= p_now)
      )
    )
  GROUP BY binding.tenant_id
  ORDER BY min(coalesce(cursor.next_retry_at, cursor.updated_at, binding.created_at))
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION opc_tinode_inbound_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime';
  END IF;
END
$$;
