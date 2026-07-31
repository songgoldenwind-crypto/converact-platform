ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS realtime_speech_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS tts_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS model_gateway_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS realtime_speech_profile_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS tts_profile_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS model_gateway_profile_id TEXT NOT NULL DEFAULT '';

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS realtime_speech_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS tts_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE collaboration_intelligence_policies
  ADD COLUMN IF NOT EXISTS model_gateway_profile_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE collaboration_intelligence_provider_runtime
  DROP CONSTRAINT IF EXISTS collaboration_intelligence_provider_runtime_capability_check;

ALTER TABLE collaboration_intelligence_provider_runtime
  ADD CONSTRAINT collaboration_intelligence_provider_runtime_capability_check
  CHECK (capability IN (
    'ocr', 'asr', 'quality_review', 'translation',
    'realtime_speech', 'tts', 'model_gateway'
  ));

ALTER TABLE collaboration_intelligence_provider_leases
  DROP CONSTRAINT IF EXISTS collaboration_intelligence_provider_leases_capability_check;

ALTER TABLE collaboration_intelligence_provider_leases
  ADD CONSTRAINT collaboration_intelligence_provider_leases_capability_check
  CHECK (capability IN (
    'ocr', 'asr', 'quality_review', 'translation',
    'realtime_speech', 'tts', 'model_gateway'
  ));

ALTER TABLE collaboration_intelligence_provider_runtime
  DROP CONSTRAINT IF EXISTS collaboration_intelligence_provider_runtime_max_concurrency_check;

ALTER TABLE collaboration_intelligence_provider_runtime
  ADD CONSTRAINT collaboration_intelligence_provider_runtime_max_concurrency_check
  CHECK (max_concurrency BETWEEN 1 AND 1000000);
