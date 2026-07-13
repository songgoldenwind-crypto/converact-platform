ALTER TABLE ivekit_ivr_audio_assets
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_time_groups_status
  ON ivekit_ivr_time_groups(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_region_groups_status
  ON ivekit_ivr_region_groups(tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ivekit_ivr_ring_groups_status
  ON ivekit_ivr_ring_groups(tenant_id, status, updated_at DESC);

-- There is one logical settings resource per tenant. Existing deployments may
-- already contain a row, so enforce singleton semantics without rewriting data.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_ivr_settings_tenant_singleton
  ON ivekit_ivr_settings(tenant_id);

