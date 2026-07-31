ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS ocr_text TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS asr_text TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS extracted_text TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS processing_error_code TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE IF NOT EXISTS collaboration_attachment_processing_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES collaboration_message_attachments(id) ON DELETE CASCADE,
  processor TEXT NOT NULL CHECK (processor IN ('ocr', 'asr')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  provider_mode TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (provider_mode IN ('unconfigured', 'self_hosted', 'third_party')),
  provider_name TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  output_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, attachment_id, processor)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_attachment_jobs_due
  ON collaboration_attachment_processing_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_collaboration_attachment_jobs_tenant
  ON collaboration_attachment_processing_jobs(tenant_id, session_id, message_id, created_at);

ALTER TABLE collaboration_attachment_processing_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_attachment_processing_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_attachment_processing_jobs;
CREATE POLICY tenant_isolation ON collaboration_attachment_processing_jobs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
