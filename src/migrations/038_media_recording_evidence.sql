ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS evidence_record_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_call_recordings_evidence
  ON call_recordings(tenant_id, evidence_record_id)
  WHERE evidence_record_id != '';
