ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS object_status TEXT NOT NULL DEFAULT 'unchecked';

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS object_checked_at TIMESTAMPTZ;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS failure_code TEXT NOT NULL DEFAULT '';

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE call_recordings
SET retention_until = created_at + INTERVAL '90 days'
WHERE retention_until IS NULL;

UPDATE call_recordings
SET completed_at = COALESCE(completed_at, created_at),
    updated_at = COALESCE(updated_at, created_at)
WHERE status = 'completed';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_recordings_status_check'
  ) THEN
    ALTER TABLE call_recordings
      ADD CONSTRAINT call_recordings_status_check
      CHECK (status IN ('starting', 'pending', 'recording', 'stopping', 'stopped', 'completed', 'failed', 'deleted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_recordings_object_status_check'
  ) THEN
    ALTER TABLE call_recordings
      ADD CONSTRAINT call_recordings_object_status_check
      CHECK (object_status IN ('unchecked', 'readable', 'missing_storage_url', 'not_found', 'forbidden', 'unsupported', 'fetch_failed', 'deleted', 'delete_failed'));
  END IF;
END $$;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY egress_id ORDER BY created_at ASC, id ASC) AS duplicate_rank
  FROM call_recordings
  WHERE egress_id != ''
)
UPDATE call_recordings AS recording
SET egress_id = '',
    status = 'failed',
    failure_code = 'duplicate_egress_id_migrated',
    updated_at = NOW()
FROM ranked
WHERE recording.id = ranked.id
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_egress_id
  ON call_recordings(egress_id)
  WHERE egress_id != '';

CREATE INDEX IF NOT EXISTS idx_call_recordings_retention
  ON call_recordings(tenant_id, retention_until, status);

ALTER TABLE call_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_recordings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON call_recordings;
CREATE POLICY tenant_isolation ON call_recordings
  FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
