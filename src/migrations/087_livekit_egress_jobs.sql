ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS recording_mode TEXT NOT NULL DEFAULT 'room_composite';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_recordings_recording_mode_check'
  ) THEN
    ALTER TABLE call_recordings
      ADD CONSTRAINT call_recordings_recording_mode_check
      CHECK (recording_mode IN ('track', 'track_composite', 'room_composite'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS livekit_egress_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  job_sequence INTEGER NOT NULL CHECK (job_sequence >= 1),
  room_name TEXT NOT NULL,
  recording_mode TEXT NOT NULL
    CHECK (recording_mode IN ('track', 'track_composite', 'room_composite')),
  track_id TEXT NOT NULL DEFAULT '',
  track_kind TEXT NOT NULL DEFAULT '',
  track_source TEXT NOT NULL DEFAULT '',
  audio_track_id TEXT NOT NULL DEFAULT '',
  video_track_id TEXT NOT NULL DEFAULT '',
  storage_url TEXT NOT NULL,
  egress_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'starting'
    CHECK (status IN ('starting', 'pending', 'recording', 'stopping', 'stopped', 'completed', 'failed')),
  failure_code TEXT NOT NULL DEFAULT '',
  reservation_id TEXT NOT NULL DEFAULT '',
  owner_epoch NUMERIC(20,0),
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0),
  object_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (object_status IN ('unchecked', 'readable', 'missing_storage_url', 'not_found', 'forbidden', 'unsupported', 'fetch_failed', 'deleted', 'delete_failed')),
  object_checked_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, recording_id, id),
  UNIQUE (recording_id, job_sequence),
  CHECK (owner_epoch IS NULL OR (owner_epoch >= 0 AND owner_epoch <= 18446744073709551615))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_egress_jobs_provider_id
  ON livekit_egress_jobs(egress_id) WHERE egress_id != '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_livekit_egress_jobs_track
  ON livekit_egress_jobs(recording_id, track_id)
  WHERE recording_mode = 'track';

CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_recording
  ON livekit_egress_jobs(tenant_id, recording_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_livekit_egress_jobs_active
  ON livekit_egress_jobs(tenant_id, status, updated_at, id);

ALTER TABLE livekit_egress_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE livekit_egress_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON livekit_egress_jobs;
CREATE POLICY tenant_isolation ON livekit_egress_jobs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON livekit_egress_jobs TO opc_runtime;
  END IF;
END
$$;
