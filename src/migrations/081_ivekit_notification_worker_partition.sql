ALTER TABLE ivekit_notification_deliveries
  ADD COLUMN IF NOT EXISTS worker_shard SMALLINT
  GENERATED ALWAYS AS (
    ((('x' || substr(md5(id), 1, 8))::bit(32)::bigint % 1024))::smallint
  ) STORED;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ivekit_notification_delivery_worker_shard_valid'
      AND conrelid = 'ivekit_notification_deliveries'::regclass
  ) THEN
    ALTER TABLE ivekit_notification_deliveries
      ADD CONSTRAINT ivekit_notification_delivery_worker_shard_valid
      CHECK (worker_shard BETWEEN 0 AND 1023);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_delivery_worker_shard_due
  ON ivekit_notification_deliveries(
    worker_shard,
    tenant_id,
    next_attempt_at,
    updated_at,
    id
  )
  WHERE state IN ('pending', 'retry_wait', 'processing');

CREATE OR REPLACE FUNCTION opc_notification_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER,
  p_shard_ids SMALLINT[]
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT delivery.tenant_id
  FROM public.ivekit_notification_deliveries delivery
  WHERE delivery.worker_shard = ANY (p_shard_ids)
    AND (
      (
        delivery.state IN ('pending', 'retry_wait')
        AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= p_now)
      )
      OR (
        delivery.state = 'processing'
        AND (delivery.lease_until IS NULL OR delivery.lease_until <= p_now)
      )
    )
  GROUP BY delivery.tenant_id
  ORDER BY MIN(delivery.updated_at), delivery.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

REVOKE ALL ON FUNCTION opc_notification_worker_tenant_ids(
  TIMESTAMPTZ,
  INTEGER,
  SMALLINT[]
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION opc_notification_worker_tenant_ids(
      TIMESTAMPTZ,
      INTEGER,
      SMALLINT[]
    ) TO opc_runtime;
  END IF;
END
$$;
