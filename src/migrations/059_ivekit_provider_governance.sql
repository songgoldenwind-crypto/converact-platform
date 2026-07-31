ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS ocr_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS asr_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS quality_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS translation_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE collaboration_intelligence_policies
SET ocr_profile_ids = ARRAY[ocr_profile_id]
WHERE cardinality(ocr_profile_ids) = 0 AND ocr_profile_id <> '';

UPDATE collaboration_intelligence_policies
SET asr_profile_ids = ARRAY[asr_profile_id]
WHERE cardinality(asr_profile_ids) = 0 AND asr_profile_id <> '';

UPDATE collaboration_intelligence_policies
SET quality_profile_ids = ARRAY[quality_profile_id]
WHERE cardinality(quality_profile_ids) = 0 AND quality_profile_id <> '';

UPDATE collaboration_intelligence_policies
SET translation_profile_ids = ARRAY[translation_profile_id]
WHERE cardinality(translation_profile_ids) = 0 AND translation_profile_id <> '';

CREATE TABLE IF NOT EXISTS collaboration_intelligence_provider_runtime (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  capability TEXT NOT NULL
    CHECK (capability IN ('ocr', 'asr', 'quality_review', 'translation')),
  profile_id TEXT NOT NULL,
  minute_window_started_at TIMESTAMPTZ,
  minute_request_count INTEGER NOT NULL DEFAULT 0 CHECK (minute_request_count >= 0),
  day_window_started_at TIMESTAMPTZ,
  day_request_count INTEGER NOT NULL DEFAULT 0 CHECK (day_request_count >= 0),
  requests_per_minute INTEGER NOT NULL DEFAULT 0 CHECK (requests_per_minute >= 0),
  requests_per_day INTEGER NOT NULL DEFAULT 0 CHECK (requests_per_day >= 0),
  max_concurrency INTEGER NOT NULL DEFAULT 10 CHECK (max_concurrency BETWEEN 1 AND 100),
  failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 100),
  open_cooldown_ms INTEGER NOT NULL DEFAULT 30000
    CHECK (open_cooldown_ms BETWEEN 1000 AND 3600000),
  circuit_state TEXT NOT NULL DEFAULT 'closed'
    CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  consecutive_retryable_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_retryable_failures >= 0),
  opened_until TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, capability, profile_id)
);

CREATE TABLE IF NOT EXISTS collaboration_intelligence_provider_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  capability TEXT NOT NULL
    CHECK (capability IN ('ocr', 'asr', 'quality_review', 'translation')),
  profile_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'succeeded', 'failed', 'expired')),
  route_attempt INTEGER NOT NULL DEFAULT 1 CHECK (route_attempt BETWEEN 1 AND 10),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  outcome_class TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, capability, profile_id)
    REFERENCES collaboration_intelligence_provider_runtime(tenant_id, capability, profile_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_collaboration_intelligence_provider_leases_active
  ON collaboration_intelligence_provider_leases(
    tenant_id, capability, profile_id, expires_at
  ) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_collaboration_intelligence_provider_leases_expired
  ON collaboration_intelligence_provider_leases(expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_collaboration_intelligence_provider_leases_history
  ON collaboration_intelligence_provider_leases(tenant_id, updated_at, id)
  WHERE status != 'active';

ALTER TABLE collaboration_intelligence_provider_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_intelligence_provider_runtime FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_intelligence_provider_runtime;
CREATE POLICY tenant_isolation ON collaboration_intelligence_provider_runtime FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE collaboration_intelligence_provider_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaboration_intelligence_provider_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON collaboration_intelligence_provider_leases;
CREATE POLICY tenant_isolation ON collaboration_intelligence_provider_leases FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_intelligence_provider_runtime TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_intelligence_provider_leases TO opc_runtime;
  END IF;
END
$$;
