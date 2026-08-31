-- Add a bounded machine-readable recovery reason without exposing customer or Provider content.
SET LOCAL lock_timeout = '5s';

ALTER TABLE converact_post_call_finalization_jobs
  ADD COLUMN IF NOT EXISTS last_error_code TEXT;

ALTER TABLE converact_post_call_finalization_jobs
  DROP CONSTRAINT IF EXISTS converact_post_call_finalization_error_state_check;
ALTER TABLE converact_post_call_finalization_jobs
  ADD CONSTRAINT converact_post_call_finalization_error_state_check CHECK (
    (state = 'reconcile_required'
      AND last_error_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$') OR
    (state <> 'reconcile_required' AND last_error_code IS NULL)
  ) NOT VALID;
ALTER TABLE converact_post_call_finalization_jobs
  VALIDATE CONSTRAINT converact_post_call_finalization_error_state_check;

CREATE OR REPLACE FUNCTION converact_claim_post_call_finalization_jobs(
  p_tenant_id TEXT,
  p_lease_owner TEXT,
  p_lease_token_hash TEXT,
  p_lease_ms BIGINT,
  p_limit INTEGER
)
RETURNS SETOF converact_post_call_finalization_jobs
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH candidates AS (
    SELECT job.tenant_id, job.job_id
    FROM public.converact_post_call_finalization_jobs AS job
    WHERE job.tenant_id = p_tenant_id
      AND p_lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
      AND p_lease_token_hash ~ '^[0-9a-f]{64}$'
      AND p_lease_ms BETWEEN 1 AND 300000
      AND p_limit BETWEEN 1 AND 1000
      AND (
        job.state IN ('pending', 'reconcile_required') OR
        (job.state = 'claimed' AND job.lease_expires_at <= transaction_timestamp())
      )
    ORDER BY job.enqueued_at, job.job_id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
  )
  UPDATE public.converact_post_call_finalization_jobs AS job
  SET state = 'claimed',
      revision = job.revision + 1,
      lease_owner = p_lease_owner,
      lease_token_hash = p_lease_token_hash,
      lease_expires_at = transaction_timestamp() + (p_lease_ms * interval '1 millisecond'),
      last_error_code = NULL,
      updated_at = transaction_timestamp()
  FROM candidates
  WHERE job.tenant_id = candidates.tenant_id
    AND job.job_id = candidates.job_id
  RETURNING job.*
$$;
