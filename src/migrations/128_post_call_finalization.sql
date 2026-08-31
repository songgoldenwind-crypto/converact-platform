-- Additive durable post-call finalization queue. This migration does not switch any writer.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_post_call_finalization_jobs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  agent_release_id TEXT NOT NULL,
  execution_generation BIGINT NOT NULL CHECK (execution_generation > 0),
  retention_policy_ref TEXT NOT NULL CHECK (char_length(retention_policy_ref) BETWEEN 1 AND 255),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'reconcile_required', 'completed')),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('projected', 'incomplete')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  lease_owner TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at TIMESTAMPTZ,
  enqueued_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, job_id),
  UNIQUE (tenant_id, call_attempt_id),
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, agent_release_id)
    REFERENCES converact_agent_releases(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (state = 'pending' AND resolution IS NULL AND lease_owner = ''
      AND lease_token_hash = '' AND lease_expires_at IS NULL AND completed_at IS NULL) OR
    (state = 'claimed' AND resolution IS NULL AND lease_owner <> ''
      AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL AND completed_at IS NULL) OR
    (state = 'reconcile_required' AND resolution IS NULL AND lease_owner = ''
      AND lease_token_hash = '' AND lease_expires_at IS NULL AND completed_at IS NULL) OR
    (state = 'completed' AND resolution IS NOT NULL AND lease_owner = ''
      AND lease_token_hash = '' AND lease_expires_at IS NULL AND completed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS converact_post_call_finalization_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  call_attempt_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('enqueued', 'state_observed')),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('projected', 'incomplete')),
  observed_revision BIGINT NOT NULL CHECK (observed_revision > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, job_id, stage),
  FOREIGN KEY (tenant_id, job_id)
    REFERENCES converact_post_call_finalization_jobs(tenant_id, job_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_attempt_id)
    REFERENCES converact_outbound_call_attempts(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    (stage = 'enqueued' AND resolution IS NULL) OR
    (stage = 'state_observed' AND resolution IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_converact_post_call_finalization_claim
  ON converact_post_call_finalization_jobs (tenant_id, enqueued_at, job_id)
  WHERE state IN ('pending', 'claimed', 'reconcile_required');

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
      updated_at = transaction_timestamp()
  FROM candidates
  WHERE job.tenant_id = candidates.tenant_id
    AND job.job_id = candidates.job_id
  RETURNING job.*
$$;

CREATE OR REPLACE FUNCTION converact_post_call_finalization_receipt_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'post-call finalization receipts are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_post_call_finalization_receipts_immutable
  ON converact_post_call_finalization_receipts;
CREATE TRIGGER converact_post_call_finalization_receipts_immutable
  BEFORE UPDATE OR DELETE ON converact_post_call_finalization_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_post_call_finalization_receipt_immutable_guard();

ALTER TABLE converact_post_call_finalization_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_post_call_finalization_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_post_call_finalization_jobs;
CREATE POLICY tenant_isolation ON converact_post_call_finalization_jobs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_post_call_finalization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_post_call_finalization_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_post_call_finalization_receipts;
CREATE POLICY tenant_isolation ON converact_post_call_finalization_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
