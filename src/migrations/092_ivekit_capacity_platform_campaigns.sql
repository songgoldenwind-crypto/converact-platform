CREATE TABLE IF NOT EXISTS ivekit_capacity_platform_campaigns (
  platform_campaign_id TEXT PRIMARY KEY
    CHECK (char_length(platform_campaign_id) BETWEEN 3 AND 255),
  contract_id TEXT NOT NULL CHECK (char_length(contract_id) BETWEEN 3 AND 255),
  contract_sha256 TEXT NOT NULL CHECK (contract_sha256 ~ '^[a-f0-9]{64}$'),
  submission_sha256 TEXT NOT NULL CHECK (submission_sha256 ~ '^[a-f0-9]{64}$'),
  submission JSONB NOT NULL CHECK (jsonb_typeof(submission) = 'object'),
  mode TEXT NOT NULL CHECK (mode IN ('controlled', 'production')),
  profile_id TEXT NOT NULL CHECK (char_length(profile_id) BETWEEN 3 AND 255),
  profile_sha256 TEXT NOT NULL CHECK (profile_sha256 ~ '^[a-f0-9]{64}$'),
  scaling_campaign_count INTEGER NOT NULL CHECK (scaling_campaign_count > 0),
  endpoint_run_id TEXT NOT NULL REFERENCES ivekit_capacity_load_runs(run_id),
  endpoint_manifest_sha256 TEXT NOT NULL CHECK (
    endpoint_manifest_sha256 ~ '^[a-f0-9]{64}$'
  ),
  endpoint_evidence_sha256 TEXT NOT NULL CHECK (
    endpoint_evidence_sha256 ~ '^[a-f0-9]{64}$'
  ),
  state TEXT NOT NULL CHECK (state IN ('finalizing', 'completed', 'failed', 'not_run')),
  outcome TEXT NOT NULL DEFAULT '' CHECK (outcome IN ('', 'passed', 'failed', 'not_run')),
  capacity_claim TEXT NOT NULL DEFAULT 'none' CHECK (
    capacity_claim IN ('none', 'platform_pass')
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

CREATE TABLE IF NOT EXISTS ivekit_capacity_platform_scaling_refs (
  platform_campaign_id TEXT NOT NULL
    REFERENCES ivekit_capacity_platform_campaigns(platform_campaign_id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL
    REFERENCES ivekit_capacity_scaling_campaigns(campaign_id),
  submission_sha256 TEXT NOT NULL CHECK (submission_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 TEXT NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (platform_campaign_id, campaign_id),
  UNIQUE (platform_campaign_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_platform_campaign_state
  ON ivekit_capacity_platform_campaigns(state, controller_lease_expires_at, platform_campaign_id);

CREATE INDEX IF NOT EXISTS idx_ivekit_capacity_platform_scaling_campaign
  ON ivekit_capacity_platform_scaling_refs(campaign_id, platform_campaign_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      ivekit_capacity_platform_campaigns,
      ivekit_capacity_platform_scaling_refs
    TO opc_runtime;
  END IF;
END
$$;
