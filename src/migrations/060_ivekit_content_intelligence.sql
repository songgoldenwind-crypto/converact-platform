ALTER TABLE collaboration_policy_findings
  ADD COLUMN IF NOT EXISTS detector_version TEXT NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE collaboration_policy_findings
  ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE collaboration_policy_findings
  ADD COLUMN IF NOT EXISTS evidence_snapshot_hash TEXT NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (char_length(evidence_snapshot_hash) = 64);

ALTER TABLE collaboration_policy_findings
  ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1
    CHECK (content_version > 0);

ALTER TABLE collaboration_policy_findings
  DROP CONSTRAINT IF EXISTS collaboration_policy_findings_source_check;

ALTER TABLE collaboration_policy_findings
  ADD CONSTRAINT collaboration_policy_findings_source_check
    CHECK (source IN ('text', 'ocr', 'asr', 'ai', 'aggregate'));

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS detector_version TEXT NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS evidence_snapshot_hash TEXT NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (char_length(evidence_snapshot_hash) = 64);

ALTER TABLE collaboration_policy_events
  ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1
    CHECK (content_version > 0);

ALTER TABLE collaboration_attachment_processing_jobs
  DROP CONSTRAINT IF EXISTS collaboration_attachment_processing_jobs_processor_check;

ALTER TABLE collaboration_attachment_processing_jobs
  ADD CONSTRAINT collaboration_attachment_processing_jobs_processor_check
    CHECK (processor IN ('ocr', 'asr', 'video_frame_ocr'));

CREATE TABLE IF NOT EXISTS collaboration_visual_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES collaboration_message_attachments(id) ON DELETE CASCADE,
  processor_job_id TEXT NOT NULL
    REFERENCES collaboration_attachment_processing_jobs(id) ON DELETE CASCADE,
  observation_type TEXT NOT NULL
    CHECK (observation_type IN ('qr_code', 'barcode', 'text_region')),
  value_hash TEXT NOT NULL CHECK (char_length(value_hash) = 64),
  symbology TEXT NOT NULL DEFAULT '',
  confidence DOUBLE PRECISION CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  frame_timestamp_ms INTEGER CHECK (
    frame_timestamp_ms IS NULL OR frame_timestamp_ms BETWEEN 0 AND 86400000
  ),
  page_number INTEGER CHECK (page_number IS NULL OR page_number BETWEEN 1 AND 10000),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  detector_version TEXT NOT NULL DEFAULT 'visual-observation-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_visual_observations_identity
  ON collaboration_visual_observations(
    tenant_id, attachment_id, processor_job_id, observation_type, value_hash,
    COALESCE(frame_timestamp_ms, -1), COALESCE(page_number, -1)
  );

CREATE INDEX IF NOT EXISTS idx_collaboration_visual_observations_session
  ON collaboration_visual_observations(tenant_id, session_id, created_at DESC);

ALTER TABLE collaboration_visual_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_visual_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_visual_observations;
CREATE POLICY tenant_isolation ON collaboration_visual_observations FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_visual_observations TO opc_runtime;
  END IF;
END
$$;
