CREATE TABLE IF NOT EXISTS ivekit_capacity_scaling_campaigns (
  campaign_id TEXT PRIMARY KEY CHECK (char_length(campaign_id) BETWEEN 3 AND 255),
  contract_id TEXT NOT NULL CHECK (char_length(contract_id) BETWEEN 3 AND 255),
  contract_sha256 TEXT NOT NULL CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  submission_sha256 TEXT NOT NULL CHECK (submission_sha256 ~ '^[a-f0-9]{64}$'),
  submission JSONB NOT NULL CHECK (jsonb_typeof(submission) = 'object'),
  curve_id TEXT NOT NULL CHECK (char_length(curve_id) BETWEEN 3 AND 255),
  scope TEXT NOT NULL CHECK (scope IN ('component', 'cell', 'shared_data')),
  mode TEXT NOT NULL CHECK (mode IN ('controlled', 'production')),
  identity JSONB NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
  source_run_count INTEGER NOT NULL CHECK (source_run_count > 0),
  state TEXT NOT NULL CHECK (state IN ('finalizing', 'completed', 'failed', 'not_run')),
  outcome TEXT NOT NULL DEFAULT '' CHECK (
    outcome IN ('', 'passed', 'failed', 'invalid_generator_capacity', 'not_run')
  ),
  capacity_claim TEXT NOT NULL DEFAULT 'none' CHECK (
    capacity_claim IN ('none', 'component_pass', 'cell_pass')
  ),
  controller_id TEXT,
  controller_lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (controller_lease_epoch >= 0),
  controller_lease_expires_at TIMESTAMPTZ,
  evidence_object_uri TEXT NOT NULL DEFAULT '',
  evidence_sha256 TEXT NOT NULL DEFAULT '' CHECK (
    evidence_sha256 = '' OR evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  evidence_byte_size BIGINT NOT NULL DEFAULT 0 CHECK (evidence_byte_size >= 0),
  failure_code TEXT NOT NULL DEFAULT '',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ivekit_capacity_scaling_campaign_runs (
  campaign_id TEXT NOT NULL
    REFERENCES ivekit_capacity_scaling_campaigns(campaign_id) ON DELETE CASCADE,
  units INTEGER NOT NULL CHECK (units > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  phase TEXT NOT NULL CHECK (phase IN ('ramp', 'binary_search', 'final_repeat')),
  requested_load INTEGER NOT NULL CHECK (requested_load > 0),
  run_id TEXT NOT NULL REFERENCES ivekit_capacity_load_runs(run_id),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_manifest_sha256 TEXT NOT NULL CHECK (
    evidence_manifest_sha256 ~ '^[a-f0-9]{64}$'
  ),
  dominant_resource TEXT NOT NULL CHECK (char_length(dominant_resource) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (campaign_id, units, attempt),
  UNIQUE (campaign_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_scaling_campaign_state
  ON ivekit_capacity_scaling_campaigns(state, controller_lease_expires_at, campaign_id);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_scaling_campaign_runs_run
  ON ivekit_capacity_scaling_campaign_runs(run_id, campaign_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ivekit_capacity_scaling_campaigns,
      ivekit_capacity_scaling_campaign_runs
    TO opc_runtime;
  END IF;
END
$$;
