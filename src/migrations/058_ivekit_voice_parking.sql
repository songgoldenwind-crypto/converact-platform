-- Provider-neutral durable call parking authority. RustPBX 0.4.11 has no
-- native park/pickup action, so iveKit composes hold/unhold/bridge while this
-- table preserves slot ownership across workers, reconnects, and restarts.
CREATE TABLE IF NOT EXISTS ivekit_voice_parking_slots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot ~ '^[A-Za-z0-9][A-Za-z0-9_*#-]{0,31}$'),
  state TEXT NOT NULL CHECK (state IN (
    'parking', 'parked', 'retrieving', 'released', 'failed', 'expired'
  )),
  parked_call_id TEXT NOT NULL,
  park_command_id TEXT NOT NULL,
  pickup_call_id TEXT,
  pickup_command_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  release_reason TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, park_command_id),
  UNIQUE (tenant_id, pickup_command_id),
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parked_call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, park_command_id)
    REFERENCES ivekit_voice_call_commands(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pickup_call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, pickup_command_id)
    REFERENCES ivekit_voice_call_commands(tenant_id, id) ON DELETE RESTRICT,
  CHECK ((state IN ('retrieving', 'released') AND pickup_call_id IS NOT NULL
    AND pickup_command_id IS NOT NULL)
    OR state NOT IN ('retrieving', 'released')),
  CHECK ((state IN ('released', 'failed', 'expired') AND released_at IS NOT NULL)
    OR (state IN ('parking', 'parked', 'retrieving') AND released_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_voice_parking_active_slot
  ON ivekit_voice_parking_slots(tenant_id, profile_id, slot)
  WHERE state IN ('parking', 'parked', 'retrieving');

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_parking_expiry
  ON ivekit_voice_parking_slots(tenant_id, expires_at, id)
  WHERE state IN ('parking', 'parked', 'retrieving');

ALTER TABLE ivekit_voice_parking_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_parking_slots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_parking_slots;
CREATE POLICY tenant_isolation ON ivekit_voice_parking_slots FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());
