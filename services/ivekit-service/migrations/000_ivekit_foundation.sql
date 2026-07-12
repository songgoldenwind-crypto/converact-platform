-- Minimal fresh-database foundation for the standalone iveKit service.
-- Keep this additive and compatible with the tables created by OPC 005_full_schema.sql.

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  plan_code TEXT NOT NULL DEFAULT 'free',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS livekit_rooms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_name TEXT NOT NULL UNIQUE,
  room_sid TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL CHECK (purpose IN ('ai_outbound', 'video_service', 'screen_share', 'conference', 'pstn_bridge')),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'active', 'closed')),
  call_session_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_livekit_rooms_tenant_status
  ON livekit_rooms(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_livekit_rooms_call_session
  ON livekit_rooms(call_session_id);

-- This is intentionally the pre-013 shape. The shared 013/026/036/038
-- migrations evolve it to the current recording lifecycle contract.
CREATE TABLE IF NOT EXISTS call_recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_session_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('livekit_egress', 'rustpbx_sipflow')),
  format TEXT NOT NULL CHECK (format IN ('mp4', 'webm', 'wav', 'ogg')),
  storage_url TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  file_size_bytes INTEGER,
  has_video INTEGER NOT NULL DEFAULT 0,
  egress_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_call_recordings_session
  ON call_recordings(call_session_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_egress_id
  ON call_recordings(egress_id) WHERE egress_id != '';
