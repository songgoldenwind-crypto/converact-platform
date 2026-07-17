ALTER TABLE ivekit_media_call_participants
  ADD COLUMN IF NOT EXISTS connection_revision BIGINT NOT NULL DEFAULT 0
    CHECK (connection_revision >= 0),
  ADD COLUMN IF NOT EXISTS connection_state TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (connection_state IN ('connected', 'reconnecting', 'disconnected', 'rejoining', 'failed')),
  ADD COLUMN IF NOT EXISTS connection_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_disconnected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_rejoined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (quality_state IN ('unknown', 'good', 'degraded')),
  ADD COLUMN IF NOT EXISTS quality_degraded_streak INTEGER NOT NULL DEFAULT 0
    CHECK (quality_degraded_streak >= 0),
  ADD COLUMN IF NOT EXISTS quality_recovered_streak INTEGER NOT NULL DEFAULT 0
    CHECK (quality_recovered_streak >= 0),
  ADD COLUMN IF NOT EXISTS last_quality_level TEXT NOT NULL DEFAULT 'unknown'
    CHECK (last_quality_level IN ('excellent', 'good', 'poor', 'lost', 'unknown')),
  ADD COLUMN IF NOT EXISTS last_quality_sample_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_qos_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ivekit_media_quality_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  participant_identity TEXT NOT NULL,
  connection_revision BIGINT NOT NULL CHECK (connection_revision > 0),
  sample_id TEXT NOT NULL CHECK (char_length(sample_id) BETWEEN 1 AND 128),
  track_source TEXT NOT NULL
    CHECK (track_source IN ('camera', 'microphone', 'screen_share', 'screen_share_audio')),
  quality_level TEXT NOT NULL DEFAULT 'unknown'
    CHECK (quality_level IN ('excellent', 'good', 'poor', 'lost', 'unknown')),
  rtt_ms DOUBLE PRECISION CHECK (rtt_ms IS NULL OR rtt_ms BETWEEN 0 AND 60000),
  jitter_ms DOUBLE PRECISION CHECK (jitter_ms IS NULL OR jitter_ms BETWEEN 0 AND 10000),
  packet_loss_ratio DOUBLE PRECISION
    CHECK (packet_loss_ratio IS NULL OR packet_loss_ratio BETWEEN 0 AND 1),
  bitrate_bps BIGINT CHECK (bitrate_bps IS NULL OR bitrate_bps BETWEEN 0 AND 1000000000),
  quality_score DOUBLE PRECISION CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 5),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  sampled_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, call_id, participant_identity)
    REFERENCES ivekit_media_call_participants(tenant_id, call_id, identity) ON DELETE CASCADE,
  UNIQUE (tenant_id, call_id, participant_identity, connection_revision, sample_id, track_source)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_quality_recent
  ON ivekit_media_quality_snapshots(
    tenant_id, call_id, participant_identity, sampled_at DESC, id DESC
  );
CREATE INDEX IF NOT EXISTS idx_ivekit_media_quality_retention
  ON ivekit_media_quality_snapshots(tenant_id, retention_until, id);

ALTER TABLE ivekit_media_quality_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_quality_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_quality_snapshots;
CREATE POLICY tenant_isolation ON ivekit_media_quality_snapshots FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE TABLE IF NOT EXISTS ivekit_media_connection_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  participant_identity TEXT NOT NULL,
  event_id TEXT NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 128),
  connection_revision BIGINT NOT NULL CHECK (connection_revision > 0),
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'connected', 'reconnecting', 'reconnected', 'disconnected', 'rejoining', 'rejoined', 'failed'
    )),
  reason_code TEXT NOT NULL DEFAULT '' CHECK (char_length(reason_code) <= 128),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, call_id, participant_identity)
    REFERENCES ivekit_media_call_participants(tenant_id, call_id, identity) ON DELETE CASCADE,
  UNIQUE (tenant_id, call_id, participant_identity, event_id)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_media_connection_events_recent
  ON ivekit_media_connection_events(
    tenant_id, call_id, participant_identity, connection_revision DESC, occurred_at DESC, id DESC
  );

ALTER TABLE ivekit_media_connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_media_connection_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_media_connection_events;
CREATE POLICY tenant_isolation ON ivekit_media_connection_events FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_media_quality_snapshots TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_media_connection_events TO opc_runtime;
  END IF;
END
$$;
