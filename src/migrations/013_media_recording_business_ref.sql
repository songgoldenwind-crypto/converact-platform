ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS business_ref_type TEXT NOT NULL DEFAULT '';

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS business_ref_id TEXT NOT NULL DEFAULT '';

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS business_ref_metadata TEXT NOT NULL DEFAULT '{}';

ALTER TABLE call_recordings
  ALTER COLUMN call_session_id DROP NOT NULL;

UPDATE call_recordings
SET business_ref_type = 'call_session',
    business_ref_id = call_session_id,
    business_ref_metadata = COALESCE(NULLIF(business_ref_metadata, ''), '{}')
WHERE business_ref_type = ''
  AND COALESCE(call_session_id, '') != '';

CREATE INDEX IF NOT EXISTS idx_call_recordings_business
  ON call_recordings(tenant_id, business_ref_type, business_ref_id, created_at DESC);
