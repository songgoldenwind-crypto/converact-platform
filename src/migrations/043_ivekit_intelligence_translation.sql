CREATE TABLE IF NOT EXISTS collaboration_intelligence_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ocr_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  asr_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  quality_review_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  translation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ocr_profile_id TEXT NOT NULL DEFAULT '',
  asr_profile_id TEXT NOT NULL DEFAULT '',
  quality_profile_id TEXT NOT NULL DEFAULT '',
  translation_profile_id TEXT NOT NULL DEFAULT '',
  allow_third_party BOOLEAN NOT NULL DEFAULT FALSE,
  auto_ocr BOOLEAN NOT NULL DEFAULT TRUE,
  auto_asr BOOLEAN NOT NULL DEFAULT TRUE,
  auto_quality_review BOOLEAN NOT NULL DEFAULT FALSE,
  auto_translation BOOLEAN NOT NULL DEFAULT FALSE,
  translation_target_languages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  min_ocr_confidence REAL NOT NULL DEFAULT 0
    CHECK (min_ocr_confidence BETWEEN 0 AND 1),
  min_asr_confidence REAL NOT NULL DEFAULT 0
    CHECK (min_asr_confidence BETWEEN 0 AND 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS collaboration_intelligence_source_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('media_recording', 'remote_recording')),
  source_ref_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES collaboration_message_attachments(id) ON DELETE CASCADE,
  processor_profile_id TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  error_code TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, source_type, source_ref_id, session_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_intelligence_sources_session
  ON collaboration_intelligence_source_links(tenant_id, session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_translation_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES collaboration_sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES collaboration_messages(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('message', 'attachment')),
  source_ref_id TEXT NOT NULL,
  source_language TEXT NOT NULL DEFAULT 'auto',
  target_language TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (char_length(source_hash) = 64),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TIMESTAMPTZ,
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '',
  provider_profile_id TEXT NOT NULL DEFAULT '',
  provider_mode TEXT NOT NULL DEFAULT 'unconfigured'
    CHECK (provider_mode IN ('unconfigured', 'self_hosted', 'third_party')),
  provider_name TEXT NOT NULL DEFAULT '',
  provider_request_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  output_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, source_type, source_ref_id, target_language, source_hash)
);

CREATE INDEX IF NOT EXISTS idx_collaboration_translation_jobs_due
  ON collaboration_translation_jobs(status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_collaboration_translation_jobs_session
  ON collaboration_translation_jobs(tenant_id, session_id, message_id, created_at DESC);

ALTER TABLE collaboration_attachment_processing_jobs
  ADD COLUMN IF NOT EXISTS provider_profile_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_quality_review_jobs
  ADD COLUMN IF NOT EXISTS provider_profile_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'message';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS source_ref_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS source_hash TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS source_language TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS provider_profile_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS provider_mode TEXT NOT NULL DEFAULT 'unconfigured';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS provider_request_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS output_metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

ALTER TABLE collaboration_message_translations
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE collaboration_message_translations
SET source_ref_id = message_id
WHERE source_ref_id = '';

UPDATE collaboration_message_translations
SET source_hash =
  md5(id || ':' || message_id || ':' || target_language || ':' || translated_body) ||
  md5(translated_body || ':' || target_language || ':' || message_id || ':' || id)
WHERE source_hash = '';

ALTER TABLE collaboration_message_translations
  ADD CONSTRAINT collaboration_message_translations_source_type_check
  CHECK (source_type IN ('message', 'attachment')) NOT VALID;

ALTER TABLE collaboration_message_translations
  VALIDATE CONSTRAINT collaboration_message_translations_source_type_check;

ALTER TABLE collaboration_message_translations
  ADD CONSTRAINT collaboration_message_translations_source_hash_check
  CHECK (char_length(source_hash) = 64) NOT VALID;

ALTER TABLE collaboration_message_translations
  VALIDATE CONSTRAINT collaboration_message_translations_source_hash_check;

ALTER TABLE collaboration_message_translations
  ADD CONSTRAINT collaboration_message_translations_provider_mode_check
  CHECK (provider_mode IN ('unconfigured', 'self_hosted', 'third_party')) NOT VALID;

ALTER TABLE collaboration_message_translations
  VALIDATE CONSTRAINT collaboration_message_translations_provider_mode_check;

CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_translations_current_source
  ON collaboration_message_translations(
    tenant_id,
    source_type,
    source_ref_id,
    target_language,
    source_hash
  );

ALTER TABLE collaboration_intelligence_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_intelligence_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_intelligence_policies;
CREATE POLICY tenant_isolation ON collaboration_intelligence_policies FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_intelligence_source_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_intelligence_source_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_intelligence_source_links;
CREATE POLICY tenant_isolation ON collaboration_intelligence_source_links FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_translation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_translation_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_translation_jobs;
CREATE POLICY tenant_isolation ON collaboration_translation_jobs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_message_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_message_translations FORCE ROW LEVEL SECURITY;
