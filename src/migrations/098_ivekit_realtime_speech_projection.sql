CREATE TABLE IF NOT EXISTS ivekit_realtime_speech_segments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 256),
  media_session_id TEXT NOT NULL CHECK (char_length(media_session_id) BETWEEN 1 AND 256),
  media_source TEXT NOT NULL CHECK (media_source IN ('rustpbx', 'livekit')),
  participant_id TEXT NOT NULL CHECK (char_length(participant_id) BETWEEN 1 AND 256),
  track_id TEXT NOT NULL CHECK (char_length(track_id) BETWEEN 1 AND 256),
  purpose TEXT NOT NULL CHECK (purpose IN ('live_captions', 'live_translation')),
  consent_ref TEXT NOT NULL CHECK (char_length(consent_ref) BETWEEN 1 AND 256),
  provider_profile_id TEXT NOT NULL CHECK (provider_profile_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  provider_version TEXT NOT NULL CHECK (char_length(provider_version) BETWEEN 1 AND 64),
  source_event_id TEXT NOT NULL CHECK (char_length(source_event_id) BETWEEN 1 AND 256),
  provider_session_id TEXT NOT NULL CHECK (char_length(provider_session_id) BETWEEN 1 AND 256),
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('transcript', 'translation')),
  segment_id TEXT NOT NULL CHECK (char_length(segment_id) BETWEEN 1 AND 256),
  speaker_id TEXT NOT NULL DEFAULT '' CHECK (char_length(speaker_id) <= 256),
  source_language TEXT NOT NULL CHECK (char_length(source_language) BETWEEN 2 AND 64),
  target_language TEXT NOT NULL DEFAULT '' CHECK (char_length(target_language) <= 64),
  source_text TEXT NOT NULL CHECK (char_length(source_text) BETWEEN 1 AND 65536),
  translated_text TEXT NOT NULL DEFAULT '' CHECK (char_length(translated_text) <= 65536),
  confidence DOUBLE PRECISION CHECK (confidence BETWEEN 0 AND 1),
  start_ms INTEGER CHECK (start_ms >= 0),
  end_ms INTEGER CHECK (end_ms >= 0 AND (start_ms IS NULL OR end_ms >= start_ms)),
  provider_request_id TEXT NOT NULL DEFAULT '' CHECK (char_length(provider_request_id) <= 256),
  latency_ms JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(latency_ms) = 'object'),
  safe_metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(safe_metadata) = 'object'),
  source_hash TEXT NOT NULL CHECK (char_length(source_hash) = 64),
  occurred_at TIMESTAMPTZ NOT NULL,
  retention_until TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    tenant_id, interaction_id, provider_session_id, segment_id, kind, target_language
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_realtime_speech_source_event
  ON ivekit_realtime_speech_segments(tenant_id, provider_session_id, source_event_id);

CREATE INDEX IF NOT EXISTS idx_ivekit_realtime_speech_interaction
  ON ivekit_realtime_speech_segments(tenant_id, interaction_id, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_ivekit_realtime_speech_retention
  ON ivekit_realtime_speech_segments(tenant_id, retention_until, id);

ALTER TABLE ivekit_realtime_speech_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_realtime_speech_segments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_realtime_speech_segments;
CREATE POLICY tenant_isolation ON ivekit_realtime_speech_segments FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, DELETE ON ivekit_realtime_speech_segments TO opc_runtime;
  END IF;
END
$$;
