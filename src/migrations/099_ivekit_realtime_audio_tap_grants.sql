CREATE TABLE IF NOT EXISTS ivekit_realtime_audio_tap_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  interaction_id TEXT NOT NULL CHECK (char_length(interaction_id) BETWEEN 1 AND 256),
  media_session_id TEXT NOT NULL CHECK (char_length(media_session_id) BETWEEN 1 AND 256),
  purpose TEXT NOT NULL CHECK (purpose IN ('live_captions', 'live_translation')),
  consent_ref TEXT NOT NULL CHECK (char_length(consent_ref) BETWEEN 1 AND 256),
  source_language TEXT NOT NULL CHECK (char_length(source_language) BETWEEN 2 AND 64),
  target_languages TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  features TEXT[] NOT NULL CHECK (
    features <@ ARRAY[
      'streaming_asr', 'streaming_translation', 'language_detection',
      'speaker_diarization', 'word_timestamps'
    ]::TEXT[]
    AND features @> ARRAY['streaming_asr']::TEXT[]
  ),
  tracks JSONB NOT NULL CHECK (
    jsonb_typeof(tracks) = 'array'
    AND jsonb_array_length(tracks) BETWEEN 1 AND 2
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 128),
  revoked_by TEXT NOT NULL DEFAULT '' CHECK (char_length(revoked_by) <= 128),
  revocation_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(revocation_reason) <= 128),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_realtime_audio_tap_active_session
  ON ivekit_realtime_audio_tap_grants(tenant_id, media_session_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ivekit_realtime_audio_tap_authorization
  ON ivekit_realtime_audio_tap_grants(
    tenant_id, interaction_id, media_session_id, expires_at
  )
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ivekit_realtime_audio_tap_expiry
  ON ivekit_realtime_audio_tap_grants(tenant_id, expires_at, id);

ALTER TABLE ivekit_realtime_audio_tap_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_realtime_audio_tap_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_realtime_audio_tap_grants;
CREATE POLICY tenant_isolation ON ivekit_realtime_audio_tap_grants FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON ivekit_realtime_audio_tap_grants TO opc_runtime;
  END IF;
END
$$;
