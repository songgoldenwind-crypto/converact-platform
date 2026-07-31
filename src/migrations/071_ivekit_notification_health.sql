ALTER TABLE ivekit_notification_endpoint_runtime
  ADD COLUMN IF NOT EXISTS health_worker_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS health_lease_token_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS health_lease_until TIMESTAMPTZ;

ALTER TABLE ivekit_notification_endpoint_runtime
  DROP CONSTRAINT IF EXISTS ivekit_notification_endpoint_runtime_health_worker_id_check;
ALTER TABLE ivekit_notification_endpoint_runtime
  ADD CONSTRAINT ivekit_notification_endpoint_runtime_health_worker_id_check
  CHECK (char_length(health_worker_id) <= 255);

ALTER TABLE ivekit_notification_endpoint_runtime
  DROP CONSTRAINT IF EXISTS ivekit_notification_endpoint_runtime_health_lease_hash_check;
ALTER TABLE ivekit_notification_endpoint_runtime
  ADD CONSTRAINT ivekit_notification_endpoint_runtime_health_lease_hash_check
  CHECK (health_lease_token_hash = '' OR char_length(health_lease_token_hash) = 64);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_endpoint_health_due
  ON ivekit_notification_endpoint_runtime(health_lease_until, tenant_id, endpoint_id);

CREATE OR REPLACE FUNCTION opc_notification_health_tenant_ids(
  p_now TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT endpoint.tenant_id
  FROM public.ivekit_notification_endpoints endpoint
  LEFT JOIN public.ivekit_notification_endpoint_runtime runtime
    ON runtime.tenant_id = endpoint.tenant_id AND runtime.endpoint_id = endpoint.id
  WHERE endpoint.status IN ('active', 'degraded')
    AND (endpoint.last_health_at IS NULL OR endpoint.last_health_at <= p_stale_before)
    AND (runtime.health_lease_until IS NULL OR runtime.health_lease_until <= p_now)
  GROUP BY endpoint.tenant_id
  ORDER BY MIN(COALESCE(endpoint.last_health_at, '-infinity'::timestamptz)), endpoint.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

REVOKE ALL ON FUNCTION opc_notification_health_tenant_ids(
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION opc_notification_health_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER)
      TO opc_runtime;
  END IF;
END
$$;
