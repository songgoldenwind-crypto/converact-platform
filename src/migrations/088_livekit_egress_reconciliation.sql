ALTER TABLE livekit_egress_jobs
  ADD COLUMN IF NOT EXISTS provider_observed_at TIMESTAMPTZ;

ALTER TABLE livekit_egress_jobs
  ADD COLUMN IF NOT EXISTS provider_missing_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE livekit_egress_jobs
  ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE livekit_egress_jobs
  ADD COLUMN IF NOT EXISTS reconcile_after TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE livekit_egress_jobs
  ADD COLUMN IF NOT EXISTS reconcile_lease_until TIMESTAMPTZ;

ALTER TABLE livekit_egress_jobs
  ADD COLUMN IF NOT EXISTS reconcile_worker_id TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'livekit_egress_jobs_provider_missing_count_check'
  ) THEN
    ALTER TABLE livekit_egress_jobs
      ADD CONSTRAINT livekit_egress_jobs_provider_missing_count_check
      CHECK (provider_missing_count >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'livekit_egress_jobs_reconcile_attempts_check'
  ) THEN
    ALTER TABLE livekit_egress_jobs
      ADD CONSTRAINT livekit_egress_jobs_reconcile_attempts_check
      CHECK (reconcile_attempts >= 0);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_reconcile
  ON livekit_egress_jobs(
    tenant_id,
    reconcile_after,
    reconcile_lease_until,
    updated_at,
    id
  )
  WHERE status IN ('starting', 'recording', 'stopping');
