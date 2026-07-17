CREATE TABLE IF NOT EXISTS ivekit_recording_manifests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL,
  interaction_kind TEXT NOT NULL,
  owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (owner_epoch >= 0 AND owner_epoch <= 18446744073709551615),
  source TEXT NOT NULL
    CHECK (source IN (
      'sip_voice', 'livekit_audio_track', 'livekit_video_track',
      'livekit_screen_track', 'livekit_room_composite',
      'rustdesk_local', 'im_attachment'
    )),
  state TEXT NOT NULL DEFAULT 'requested'
    CHECK (state IN (
      'requested', 'reserved', 'recording', 'finalizing', 'uploading',
      'uploaded_unverified', 'scanning', 'available', 'quarantined',
      'failed', 'deleting', 'deleted'
    )),
  consent_id TEXT NOT NULL,
  recording_mode TEXT NOT NULL
    CHECK (recording_mode IN ('always', 'policy', 'on_demand', 'evidence_only')),
  retention_until TIMESTAMPTZ NOT NULL,
  legal_hold BOOLEAN NOT NULL DEFAULT FALSE,
  region_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  recorder_node_id TEXT NOT NULL,
  media JSONB NOT NULL CHECK (jsonb_typeof(media) = 'object'),
  object_ref TEXT NOT NULL DEFAULT '',
  processing JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(processing) = 'object'),
  failure_code TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (state <> 'deleted' OR deleted_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ivekit_recording_segments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (owner_epoch >= 0 AND owner_epoch <= 18446744073709551615),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  track_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN (
      'open', 'closed', 'upload_pending', 'uploading', 'uploaded',
      'quarantined', 'failed', 'deleting', 'deleted'
    )),
  container TEXT NOT NULL,
  codec TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
  sha256 TEXT NOT NULL DEFAULT ''
    CHECK (sha256 = '' OR sha256 ~ '^[a-f0-9]{64}$'),
  local_ref TEXT NOT NULL DEFAULT '',
  object_ref TEXT NOT NULL DEFAULT '',
  failure_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, manifest_id)
    REFERENCES ivekit_recording_manifests(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, manifest_id, track_id, sequence),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CHECK (
    state NOT IN ('closed', 'upload_pending', 'uploading', 'uploaded', 'quarantined')
    OR ended_at IS NOT NULL
  ),
  CHECK (
    state NOT IN ('uploaded', 'quarantined')
    OR (size_bytes IS NOT NULL AND sha256 <> '' AND object_ref <> '')
  )
);

CREATE TABLE IF NOT EXISTS ivekit_recording_segment_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  manifest_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  owner_epoch NUMERIC(20,0) NOT NULL
    CHECK (owner_epoch >= 0 AND owner_epoch <= 18446744073709551615),
  event_sequence BIGINT NOT NULL CHECK (event_sequence >= 1),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'opened', 'closed', 'paused', 'resumed', 'masked', 'unmasked',
      'discontinuity', 'sample_dropped', 'upload_started',
      'upload_completed', 'upload_failed'
    )),
  policy_source TEXT NOT NULL DEFAULT '',
  actor_identity TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(metadata) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, manifest_id)
    REFERENCES ivekit_recording_manifests(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, segment_id)
    REFERENCES ivekit_recording_segments(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, segment_id, event_sequence)
);

CREATE TABLE IF NOT EXISTS ivekit_recording_upload_leases (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  worker_id TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (lease_token_hash = '' OR lease_token_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'retry_wait', 'completed', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 20 CHECK (max_attempts BETWEEN 1 AND 100),
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error_code TEXT NOT NULL DEFAULT '',
  last_error_message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, segment_id),
  FOREIGN KEY (tenant_id, segment_id)
    REFERENCES ivekit_recording_segments(tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (state = 'leased' AND worker_id <> '' AND lease_token_hash <> '' AND lease_expires_at IS NOT NULL)
    OR state <> 'leased'
  )
);

CREATE TABLE IF NOT EXISTS ivekit_recording_segment_uploads (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  storage_url TEXT NOT NULL,
  part_size_bytes BIGINT NOT NULL CHECK (part_size_bytes > 0),
  state TEXT NOT NULL DEFAULT 'initiated'
    CHECK (state IN ('initiated', 'uploading', 'completed', 'aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, segment_id),
  UNIQUE (tenant_id, upload_id),
  FOREIGN KEY (tenant_id, segment_id)
    REFERENCES ivekit_recording_segments(tenant_id, id) ON DELETE CASCADE,
  CHECK (state <> 'completed' OR completed_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ivekit_recording_upload_parts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  etag TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'committed', 'aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, segment_id, part_number),
  FOREIGN KEY (tenant_id, segment_id)
    REFERENCES ivekit_recording_segment_uploads(tenant_id, segment_id)
      ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_recording_manifests_interaction
  ON ivekit_recording_manifests(
    tenant_id, interaction_kind, interaction_id, created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_ivekit_recording_manifests_retention
  ON ivekit_recording_manifests(tenant_id, legal_hold, retention_until, state);

CREATE INDEX IF NOT EXISTS idx_ivekit_recording_segments_upload_due
  ON ivekit_recording_segments(tenant_id, state, updated_at, id)
  WHERE state IN ('closed', 'upload_pending', 'uploading', 'failed');

CREATE INDEX IF NOT EXISTS idx_ivekit_recording_upload_leases_due
  ON ivekit_recording_upload_leases(
    tenant_id, state, next_attempt_at, lease_expires_at, updated_at, segment_id
  );

CREATE INDEX IF NOT EXISTS idx_ivekit_recording_segment_uploads_state
  ON ivekit_recording_segment_uploads(tenant_id, state, updated_at, segment_id);

ALTER TABLE ivekit_voice_recordings
  ADD COLUMN IF NOT EXISTS manifest_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ivekit_voice_recordings_manifest_fk'
  ) THEN
    ALTER TABLE ivekit_voice_recordings
      ADD CONSTRAINT ivekit_voice_recordings_manifest_fk
      FOREIGN KEY (tenant_id, manifest_id)
      REFERENCES ivekit_recording_manifests(tenant_id, id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_recordings_manifest
  ON ivekit_voice_recordings(tenant_id, manifest_id)
  WHERE manifest_id IS NOT NULL;

ALTER TABLE ivekit_recording_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_recording_manifests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_recording_manifests;
CREATE POLICY tenant_isolation ON ivekit_recording_manifests FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_recording_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_recording_segments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_recording_segments;
CREATE POLICY tenant_isolation ON ivekit_recording_segments FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_recording_segment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_recording_segment_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_recording_segment_events;
CREATE POLICY tenant_isolation ON ivekit_recording_segment_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_recording_upload_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_recording_upload_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_recording_upload_leases;
CREATE POLICY tenant_isolation ON ivekit_recording_upload_leases FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_recording_segment_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_recording_segment_uploads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_recording_segment_uploads;
CREATE POLICY tenant_isolation ON ivekit_recording_segment_uploads FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_recording_upload_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_recording_upload_parts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_recording_upload_parts;
CREATE POLICY tenant_isolation ON ivekit_recording_upload_parts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_ivekit_recording_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT segment.tenant_id
  FROM public.ivekit_recording_segments segment
  LEFT JOIN public.ivekit_recording_upload_leases lease
    ON lease.tenant_id = segment.tenant_id
   AND lease.segment_id = segment.id
  WHERE segment.state IN ('closed', 'upload_pending', 'uploading', 'failed')
    AND (
      lease.segment_id IS NULL
      OR lease.state = 'pending'
      OR (lease.state = 'retry_wait' AND lease.next_attempt_at <= p_now)
      OR (lease.state = 'leased' AND lease.lease_expires_at <= p_now)
    )
    AND COALESCE(lease.attempt_count, 0) < COALESCE(lease.max_attempts, 20)
  GROUP BY segment.tenant_id
  ORDER BY min(segment.updated_at)
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_ivekit_recording_worker_tenant_ids(
  TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

-- Worker claims use this ordering inside a tenant transaction:
-- SELECT ... FOR UPDATE SKIP LOCKED, then CAS segment state and upload lease.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ivekit_recording_manifests,
      ivekit_recording_segments,
      ivekit_recording_segment_events,
      ivekit_recording_upload_leases,
      ivekit_recording_segment_uploads,
      ivekit_recording_upload_parts
    TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_recording_worker_tenant_ids(
      TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
  END IF;
END
$$;
