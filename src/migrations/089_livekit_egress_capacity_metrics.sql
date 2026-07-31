CREATE OR REPLACE FUNCTION opc_livekit_egress_reconciliation_tenant_ids(
  p_now TIMESTAMPTZ,
  p_stale_before TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT job.tenant_id
  FROM public.livekit_egress_jobs job
  WHERE job.status IN ('starting', 'recording', 'stopping')
    AND job.egress_id != ''
    AND job.egress_id NOT LIKE 'egress_pending_%'
    AND job.reconcile_after <= p_now
    AND job.updated_at <= p_stale_before
    AND (job.reconcile_lease_until IS NULL OR job.reconcile_lease_until <= p_now)
  GROUP BY job.tenant_id
  ORDER BY min(job.reconcile_after), job.tenant_id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

CREATE OR REPLACE FUNCTION opc_livekit_egress_capacity_metrics(
  p_now TIMESTAMPTZ
)
RETURNS TABLE (
  pool TEXT,
  pending_jobs BIGINT,
  active_jobs BIGINT,
  stopping_jobs BIGINT,
  oldest_pending_age_seconds DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH pools(pool) AS (
    VALUES ('track'::TEXT), ('composite'::TEXT)
  ), jobs AS (
    SELECT CASE WHEN recording_mode = 'track' THEN 'track' ELSE 'composite' END AS pool,
           status,
           updated_at
    FROM public.livekit_egress_jobs
    WHERE status IN ('pending', 'starting', 'recording', 'stopping')
  ), aggregate AS (
    SELECT jobs.pool,
           count(*) FILTER (WHERE status IN ('pending', 'starting')) AS pending_jobs,
           count(*) FILTER (WHERE status = 'recording') AS active_jobs,
           count(*) FILTER (WHERE status = 'stopping') AS stopping_jobs,
           extract(epoch FROM p_now - min(updated_at)
             FILTER (WHERE status IN ('pending', 'starting'))) AS oldest_pending_age_seconds
    FROM jobs
    GROUP BY jobs.pool
  )
  SELECT pools.pool,
         coalesce(aggregate.pending_jobs, 0),
         coalesce(aggregate.active_jobs, 0),
         coalesce(aggregate.stopping_jobs, 0),
         greatest(coalesce(aggregate.oldest_pending_age_seconds, 0), 0)
  FROM pools
  LEFT JOIN aggregate USING (pool)
  ORDER BY pools.pool;
$$;

REVOKE ALL ON FUNCTION opc_livekit_egress_reconciliation_tenant_ids(
  TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_livekit_egress_capacity_metrics(TIMESTAMPTZ) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION opc_livekit_egress_reconciliation_tenant_ids(
      TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_livekit_egress_capacity_metrics(TIMESTAMPTZ)
      TO opc_runtime;
  END IF;
END
$$;
