CREATE TABLE IF NOT EXISTS ivekit_capacity_load_runs (
  run_id TEXT PRIMARY KEY CHECK (char_length(run_id) BETWEEN 3 AND 255),
  profile_id TEXT NOT NULL CHECK (char_length(profile_id) BETWEEN 3 AND 255),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('planned', 'ready', 'running', 'finalizing', 'completed', 'failed', 'cancelled', 'not_run')),
  current_phase_id TEXT,
  controller_id TEXT,
  controller_lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (controller_lease_epoch >= 0),
  controller_lease_expires_at TIMESTAMPTZ,
  start_not_before TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL DEFAULT '',
  evidence_manifest_sha256 TEXT NOT NULL DEFAULT '' CHECK (
    evidence_manifest_sha256 = '' OR evidence_manifest_sha256 ~ '^[a-f0-9]{64}$'
  ),
  failure_code TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ivekit_capacity_load_phases (
  run_id TEXT NOT NULL REFERENCES ivekit_capacity_load_runs(run_id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL CHECK (char_length(phase_id) BETWEEN 3 AND 255),
  phase_ordinal INTEGER NOT NULL CHECK (phase_ordinal >= 0),
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, phase_id),
  UNIQUE (run_id, phase_ordinal)
);

CREATE TABLE IF NOT EXISTS ivekit_capacity_load_shards (
  run_id TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  shard_id TEXT NOT NULL CHECK (char_length(shard_id) BETWEEN 1 AND 512),
  fleet_id TEXT NOT NULL CHECK (char_length(fleet_id) BETWEEN 3 AND 255),
  workload_domain TEXT NOT NULL CHECK (workload_domain IN ('interaction', 'connection')),
  workload_id TEXT NOT NULL,
  workload_kind TEXT NOT NULL,
  ordinal_start INTEGER NOT NULL CHECK (ordinal_start >= 0),
  ordinal_end_exclusive INTEGER NOT NULL CHECK (ordinal_end_exclusive > ordinal_start),
  expected_count INTEGER NOT NULL CHECK (expected_count = ordinal_end_exclusive - ordinal_start),
  required_protocols JSONB NOT NULL CHECK (jsonb_typeof(required_protocols) = 'array'),
  seed TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'running', 'completed', 'failed', 'cancelled', 'not_run')),
  lease_owner TEXT,
  lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  execution_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (execution_state IN ('pending', 'running', 'result_ready')),
  execution_result JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(execution_result) = 'object'),
  execution_result_sha256 TEXT NOT NULL DEFAULT ''
    CHECK (execution_result_sha256 = '' OR execution_result_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (run_id, phase_id)
    REFERENCES ivekit_capacity_load_phases(run_id, phase_id) ON DELETE CASCADE,
  UNIQUE (run_id, phase_id, shard_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_load_shards_claim
  ON ivekit_capacity_load_shards(run_id, phase_id, fleet_id, state, lease_expires_at, shard_id);

CREATE TABLE IF NOT EXISTS ivekit_capacity_load_workers (
  run_id TEXT NOT NULL REFERENCES ivekit_capacity_load_runs(run_id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL CHECK (char_length(worker_id) BETWEEN 3 AND 255),
  fleet_id TEXT NOT NULL CHECK (char_length(fleet_id) BETWEEN 3 AND 255),
  release_id TEXT NOT NULL CHECK (char_length(release_id) BETWEEN 3 AND 255),
  state TEXT NOT NULL CHECK (state IN ('online', 'draining', 'offline')),
  safe_capacity INTEGER NOT NULL CHECK (safe_capacity >= 0),
  assigned_load INTEGER NOT NULL CHECK (assigned_load >= 0 AND assigned_load <= safe_capacity),
  reported_load INTEGER NOT NULL CHECK (reported_load >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  heartbeat_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, worker_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_load_workers_freshness
  ON ivekit_capacity_load_workers(run_id, fleet_id, state, heartbeat_at DESC);

CREATE TABLE IF NOT EXISTS ivekit_capacity_evidence (
  evidence_id TEXT PRIMARY KEY CHECK (char_length(evidence_id) BETWEEN 3 AND 255),
  run_id TEXT NOT NULL REFERENCES ivekit_capacity_load_runs(run_id) ON DELETE CASCADE,
  phase_id TEXT,
  shard_id TEXT,
  kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 255),
  state TEXT NOT NULL CHECK (state IN ('pending', 'uploading', 'uploaded', 'verified', 'rejected', 'not_run')),
  object_uri TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '' CHECK (sha256 = '' OR sha256 ~ '^[a-f0-9]{64}$'),
  byte_size BIGINT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(metadata) = 'object'),
  error_code TEXT NOT NULL DEFAULT '',
  captured_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (shard_id IS NULL OR phase_id IS NOT NULL),
  FOREIGN KEY (run_id, phase_id)
    REFERENCES ivekit_capacity_load_phases(run_id, phase_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, phase_id, shard_id)
    REFERENCES ivekit_capacity_load_shards(run_id, phase_id, shard_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_evidence_run
  ON ivekit_capacity_evidence(run_id, state, phase_id, shard_id);

CREATE TABLE IF NOT EXISTS ivekit_capacity_command_outbox (
  command_id TEXT PRIMARY KEY CHECK (char_length(command_id) BETWEEN 3 AND 255),
  run_id TEXT NOT NULL REFERENCES ivekit_capacity_load_runs(run_id) ON DELETE CASCADE,
  command_key TEXT NOT NULL CHECK (char_length(command_key) BETWEEN 3 AND 1024),
  subject TEXT NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 512),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'published', 'cancelled')),
  dispatcher_id TEXT,
  dispatch_epoch BIGINT NOT NULL DEFAULT 0 CHECK (dispatch_epoch >= 0),
  dispatch_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, command_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_command_outbox_dispatch
  ON ivekit_capacity_command_outbox(state, available_at, dispatch_expires_at, command_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ivekit_capacity_load_runs,
      ivekit_capacity_load_phases,
      ivekit_capacity_load_shards,
      ivekit_capacity_load_workers,
      ivekit_capacity_evidence,
      ivekit_capacity_command_outbox
    TO opc_runtime;
  END IF;
END
$$;
