CREATE UNIQUE INDEX IF NOT EXISTS uq_collaboration_sessions_tenant_id_id
  ON collaboration_sessions(tenant_id, id);

CREATE TABLE IF NOT EXISTS collaboration_secure_files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('image', 'video', 'audio', 'file', 'screen_recording')),
  filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 512),
  extension TEXT NOT NULL DEFAULT '' CHECK (char_length(extension) <= 32),
  declared_mime TEXT NOT NULL DEFAULT '' CHECK (char_length(declared_mime) <= 255),
  detected_mime TEXT NOT NULL DEFAULT '' CHECK (char_length(detected_mime) <= 255),
  mime_conflict BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'initiated'
    CHECK (status IN (
      'initiated', 'uploading', 'scanning', 'processing', 'ready',
      'quarantined', 'failed', 'expired'
    )),
  threat_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (threat_status IN ('pending', 'scanning', 'clean', 'infected', 'error')),
  failure_code TEXT NOT NULL DEFAULT '' CHECK (char_length(failure_code) <= 100),
  object_key TEXT NOT NULL DEFAULT '' CHECK (char_length(object_key) <= 1024),
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL DEFAULT '' CHECK (sha256 = '' OR char_length(sha256) = 64),
  upload_mode TEXT NOT NULL CHECK (upload_mode IN ('single', 'multipart')),
  expected_size_bytes BIGINT NOT NULL CHECK (expected_size_bytes > 0),
  received_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (received_size_bytes >= 0),
  part_size_bytes BIGINT NOT NULL CHECK (part_size_bytes > 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  scan_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (scan_attempt_count >= 0),
  scanner_name TEXT NOT NULL DEFAULT '' CHECK (char_length(scanner_name) <= 100),
  scanner_mode TEXT NOT NULL DEFAULT '' CHECK (char_length(scanner_mode) <= 50),
  scanner_request_id TEXT NOT NULL DEFAULT '' CHECK (char_length(scanner_request_id) <= 200),
  scan_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  next_attempt_at TIMESTAMPTZ,
  lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (lease_token_hash = '' OR char_length(lease_token_hash) = 64),
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '' CHECK (char_length(worker_id) <= 255),
  cleanup_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempt_count >= 0),
  cleanup_next_attempt_at TIMESTAMPTZ,
  cleanup_lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (cleanup_lease_token_hash = '' OR char_length(cleanup_lease_token_hash) = 64),
  cleanup_lease_until TIMESTAMPTZ,
  cleanup_worker_id TEXT NOT NULL DEFAULT '' CHECK (char_length(cleanup_worker_id) <= 255),
  cleanup_error_code TEXT NOT NULL DEFAULT '' CHECK (char_length(cleanup_error_code) <= 100),
  retention_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, session_id, idempotency_key),
  UNIQUE (tenant_id, session_id, id),
  FOREIGN KEY (tenant_id, session_id)
    REFERENCES collaboration_sessions(tenant_id, id) ON DELETE CASCADE,
  CHECK (received_size_bytes <= expected_size_bytes),
  CHECK (size_bytes <= expected_size_bytes),
  CHECK (status != 'ready' OR (threat_status = 'clean' AND detected_mime <> '')),
  CHECK (status != 'quarantined' OR threat_status IN ('infected', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_collaboration_secure_files_status
  ON collaboration_secure_files(tenant_id, status, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_collaboration_secure_files_scan_due
  ON collaboration_secure_files(tenant_id, status, next_attempt_at, lease_until, updated_at, id)
  WHERE status IN ('scanning', 'processing');

CREATE INDEX IF NOT EXISTS idx_collaboration_secure_files_expiry
  ON collaboration_secure_files(expires_at, tenant_id, id)
  WHERE expires_at IS NOT NULL AND status NOT IN ('expired', 'quarantined');

CREATE INDEX IF NOT EXISTS idx_collaboration_secure_files_cleanup_due
  ON collaboration_secure_files(
    status, cleanup_next_attempt_at, cleanup_lease_until, expires_at, retention_until,
    updated_at, tenant_id, id
  )
  WHERE status IN ('initiated', 'uploading', 'ready', 'quarantined', 'failed');

CREATE TABLE IF NOT EXISTS collaboration_secure_file_parts (
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  secure_file_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (char_length(sha256) = 64),
  object_key TEXT NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
  etag TEXT NOT NULL DEFAULT '' CHECK (char_length(etag) <= 255),
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('staged', 'uploaded', 'committed', 'aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, secure_file_id, part_number),
  FOREIGN KEY (tenant_id, session_id, secure_file_id)
    REFERENCES collaboration_secure_files(tenant_id, session_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collaboration_secure_file_parts_file
  ON collaboration_secure_file_parts(tenant_id, secure_file_id, part_number);

CREATE TABLE IF NOT EXISTS collaboration_secure_file_derivatives (
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  secure_file_id TEXT NOT NULL,
  derivative_kind TEXT NOT NULL
    CHECK (derivative_kind IN (
      'image_thumbnail', 'video_thumbnail', 'video_transcode', 'audio_transcode'
    )),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry_wait', 'ready', 'failed', 'expired')),
  object_key TEXT NOT NULL DEFAULT '' CHECK (char_length(object_key) <= 1024),
  mime TEXT NOT NULL DEFAULT '' CHECK (char_length(mime) <= 255),
  size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL DEFAULT '' CHECK (sha256 = '' OR char_length(sha256) = 64),
  provider_profile_id TEXT NOT NULL DEFAULT '' CHECK (char_length(provider_profile_id) <= 255),
  provider_request_id TEXT NOT NULL DEFAULT '' CHECK (char_length(provider_request_id) <= 200),
  provider_metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (lease_token_hash = '' OR char_length(lease_token_hash) = 64),
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '' CHECK (char_length(worker_id) <= 255),
  error_code TEXT NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 100),
  retention_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, secure_file_id, derivative_kind),
  FOREIGN KEY (tenant_id, session_id, secure_file_id)
    REFERENCES collaboration_secure_files(tenant_id, session_id, id) ON DELETE CASCADE,
  CHECK (status != 'ready' OR (object_key <> '' AND mime <> '' AND size_bytes > 0 AND sha256 <> ''))
);

CREATE INDEX IF NOT EXISTS idx_collaboration_secure_file_derivatives_due
  ON collaboration_secure_file_derivatives(
    tenant_id, status, next_attempt_at, lease_until, updated_at, secure_file_id
  )
  WHERE status IN ('pending', 'processing', 'retry_wait');

CREATE OR REPLACE FUNCTION opc_secure_file_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT file.tenant_id
  FROM public.collaboration_secure_files file
  WHERE file.status = 'scanning'
    AND (file.next_attempt_at IS NULL OR file.next_attempt_at <= p_now)
    AND (file.lease_until IS NULL OR file.lease_until <= p_now)
  GROUP BY file.tenant_id
  ORDER BY MIN(file.updated_at), file.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

CREATE OR REPLACE FUNCTION opc_secure_file_derivative_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT file.tenant_id
  FROM public.collaboration_secure_files file
  LEFT JOIN public.collaboration_secure_file_derivatives derivative
    ON derivative.tenant_id = file.tenant_id AND derivative.secure_file_id = file.id
  WHERE file.status = 'processing'
    AND (
      derivative.secure_file_id IS NULL OR
      (
        derivative.status IN ('pending', 'processing', 'retry_wait')
        AND (derivative.next_attempt_at IS NULL OR derivative.next_attempt_at <= p_now)
        AND (derivative.lease_until IS NULL OR derivative.lease_until <= p_now)
      )
    )
  GROUP BY file.tenant_id
  ORDER BY MIN(file.updated_at), file.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

CREATE OR REPLACE FUNCTION opc_secure_file_cleanup_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_upload_stale_before TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT file.tenant_id
  FROM public.collaboration_secure_files file
  WHERE file.status IN ('initiated', 'uploading', 'ready', 'quarantined', 'failed')
    AND (file.cleanup_next_attempt_at IS NULL OR file.cleanup_next_attempt_at <= p_now)
    AND (file.cleanup_lease_until IS NULL OR file.cleanup_lease_until <= p_now)
    AND (
      (file.expires_at IS NOT NULL AND file.expires_at <= p_now) OR
      (file.status IN ('initiated', 'uploading') AND file.updated_at <= p_upload_stale_before) OR
      (
        file.status IN ('ready', 'quarantined', 'failed') AND
        file.retention_until IS NOT NULL AND file.retention_until <= p_now
      )
    )
  GROUP BY file.tenant_id
  ORDER BY MIN(file.updated_at), file.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

CREATE OR REPLACE FUNCTION opc_secure_file_status_transition_allowed(
  previous_status TEXT,
  next_status TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT previous_status = next_status OR CASE previous_status
    WHEN 'initiated' THEN next_status IN ('uploading', 'failed', 'expired')
    WHEN 'uploading' THEN next_status IN ('scanning', 'failed', 'expired')
    WHEN 'scanning' THEN next_status IN ('processing', 'quarantined', 'failed')
    WHEN 'processing' THEN next_status IN ('ready', 'failed')
    WHEN 'ready' THEN next_status = 'expired'
    WHEN 'quarantined' THEN next_status = 'expired'
    WHEN 'failed' THEN next_status = 'expired'
    ELSE FALSE
  END
$$;

CREATE OR REPLACE FUNCTION opc_secure_file_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT opc_secure_file_status_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'invalid secure file status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'processing' AND (NEW.threat_status <> 'clean' OR NEW.detected_mime = '') THEN
    RAISE EXCEPTION 'secure file scan must be clean before processing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'ready' AND (NEW.threat_status <> 'clean' OR NEW.detected_mime = '') THEN
    RAISE EXCEPTION 'secure file must be clean before ready'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'quarantined' AND NEW.threat_status NOT IN ('infected', 'error') THEN
    RAISE EXCEPTION 'secure file quarantine requires a threat result'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_collaboration_secure_files_status_guard
  ON collaboration_secure_files;
CREATE TRIGGER trg_collaboration_secure_files_status_guard
  BEFORE UPDATE OF status, threat_status, detected_mime
  ON collaboration_secure_files
  FOR EACH ROW
  EXECUTE FUNCTION opc_secure_file_status_guard();

ALTER TABLE collaboration_message_attachments
  ADD COLUMN IF NOT EXISTS secure_file_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_collaboration_message_attachments_secure_file'
  ) THEN
    ALTER TABLE collaboration_message_attachments
      ADD CONSTRAINT fk_collaboration_message_attachments_secure_file
      FOREIGN KEY (tenant_id, session_id, secure_file_id)
      REFERENCES collaboration_secure_files(tenant_id, session_id, id)
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_collaboration_message_attachments_secure_file
  ON collaboration_message_attachments(tenant_id, session_id, secure_file_id)
  WHERE secure_file_id IS NOT NULL;

ALTER TABLE collaboration_secure_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_secure_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_secure_files;
CREATE POLICY tenant_isolation ON collaboration_secure_files FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_secure_file_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_secure_file_parts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_secure_file_parts;
CREATE POLICY tenant_isolation ON collaboration_secure_file_parts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_secure_file_derivatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_secure_file_derivatives FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_secure_file_derivatives;
CREATE POLICY tenant_isolation ON collaboration_secure_file_derivatives FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_secure_file_status_transition_allowed(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_status_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_derivative_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_secure_file_cleanup_worker_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_secure_files TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_secure_file_parts TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_secure_file_derivatives TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_secure_file_status_transition_allowed(TEXT, TEXT) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_secure_file_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_secure_file_derivative_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_secure_file_cleanup_worker_tenant_ids(TIMESTAMPTZ, TIMESTAMPTZ, INTEGER) TO opc_runtime;
  END IF;
END
$$;
