import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import {
  IntelligenceProviderGovernanceStore
} from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import {
  createIntelligenceProviderRegistry
} from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import {
  IntelligencePolicyStore
} from '../src/agent-runtime/collaboration/intelligence-policy-store.js';

const migrationPath = 'src/migrations/097_ivekit_realtime_intelligence.sql';

const env: NodeJS.ProcessEnv = {
  OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
    {
      id: 'speech-cloud', capability: 'realtime_speech', mode: 'third_party',
      base_url: 'https://speech.example.test', adapter: 'ivekit_realtime_speech_v1',
      provider_version: '2026-07', data_region: 'ap-southeast',
      token_env: 'SPEECH_CLOUD_TOKEN', max_buffered_audio_ms: 800,
      max_session_seconds: 14_400, max_concurrency: 5_000, reservation_ttl_ms: 35_000
    },
    {
      id: 'tts-private', capability: 'tts', mode: 'self_hosted',
      base_url: 'http://tts-worker:8080'
    },
    {
      id: 'model-cloud', capability: 'model_gateway', mode: 'third_party',
      base_url: 'https://model.example.test', adapter: 'openai_compatible',
      token_env: 'MODEL_CLOUD_TOKEN'
    }
  ]),
  SPEECH_CLOUD_TOKEN: 'speech-secret',
  MODEL_CLOUD_TOKEN: 'model-secret'
};

test('registry accepts governed realtime speech, TTS, and model profiles without exposing secrets', () => {
  const registry = createIntelligenceProviderRegistry(env);

  const speech = registry.requireProfile('speech-cloud', 'realtime_speech');
  assert.equal(speech.endpoint, '/v1/realtime-speech');
  assert.equal(speech.adapter, 'ivekit_realtime_speech_v1');
  assert.equal(speech.provider_version, '2026-07');
  assert.equal(speech.data_region, 'ap-southeast');
  assert.equal(speech.max_buffered_audio_ms, 800);
  assert.equal(speech.max_session_seconds, 14_400);
  assert.equal(speech.max_concurrency, 5_000);
  assert.equal(registry.requireProfile('tts-private', 'tts').endpoint, '/v1/tts');
  assert.equal(registry.requireProfile('model-cloud', 'model_gateway').endpoint, '/v1/model');

  const safe = JSON.stringify(registry.listSafe());
  assert.doesNotMatch(safe, /speech-secret|model-secret|token_env|base_url/i);
  assert.match(safe, /ivekit_realtime_speech_v1/);
  assert.match(safe, /ap-southeast/);
});

test('realtime intelligence profile validation rejects insecure and secret-bearing configuration', () => {
  assert.throws(
    () => createIntelligenceProviderRegistry({
      OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
        id: 'speech-cloud', capability: 'realtime_speech', mode: 'third_party',
        base_url: 'http://speech.example.test', adapter: 'ivekit_realtime_speech_v1'
      }])
    }),
    /HTTPS/i
  );
  assert.throws(
    () => createIntelligenceProviderRegistry({
      OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
        id: 'speech-cloud', capability: 'realtime_speech', mode: 'third_party',
        base_url: 'https://speech.example.test', adapter: 'ivekit_realtime_speech_v1',
        config: { authorization: 'Bearer plaintext' }
      }])
    }),
    /secret|credential|unsupported/i
  );
});

test('legacy policy remains disabled for new capabilities and can enable ordered realtime routes', async () => {
  const pg = new MemoryPg();
  const registry = createIntelligenceProviderRegistry(env);
  const store = new IntelligencePolicyStore(pg, registry);

  const defaults = await store.getEffectivePolicy('tenant-realtime-policy');
  assert.equal(defaults.realtime_speech_enabled, false);
  assert.equal(defaults.tts_enabled, false);
  assert.equal(defaults.model_gateway_enabled, false);
  assert.deepEqual(defaults.realtime_speech_profile_ids, []);
  assert.deepEqual(defaults.tts_profile_ids, []);
  assert.deepEqual(defaults.model_gateway_profile_ids, []);

  const updated = await store.updatePolicy({
    tenant_id: 'tenant-realtime-policy',
    actor_identity: 'owner-a',
    expected_version: 0,
    policy: {
      ocr_enabled: false,
      asr_enabled: false,
      quality_review_enabled: false,
      translation_enabled: false,
      allow_third_party: true,
      auto_ocr: false,
      auto_asr: false,
      auto_quality_review: false,
      auto_translation: false,
      translation_target_languages: [],
      min_ocr_confidence: 0,
      min_asr_confidence: 0,
      realtime_speech_enabled: true,
      tts_enabled: true,
      model_gateway_enabled: true,
      realtime_speech_profile_ids: ['speech-cloud'],
      tts_profile_ids: ['tts-private'],
      model_gateway_profile_ids: ['model-cloud']
    }
  });

  assert.equal(updated.realtime_speech_profile_id, 'speech-cloud');
  assert.deepEqual(updated.realtime_speech_profile_ids, ['speech-cloud']);
  assert.deepEqual(updated.tts_profile_ids, ['tts-private']);
  assert.deepEqual(updated.model_gateway_profile_ids, ['model-cloud']);
});

test('governance renews an active realtime session lease without spending request quota', async () => {
  let now = new Date('2026-07-22T08:00:00.000Z');
  const registry = createIntelligenceProviderRegistry(env);
  const profile = registry.requireProfile('speech-cloud', 'realtime_speech');
  const store = new IntelligenceProviderGovernanceStore(new MemoryPg(), { now: () => now });
  const reservation = await store.reserve({
    tenant_id: 'tenant-realtime-lease',
    capability: 'realtime_speech',
    profile,
    route_attempt: 1
  });
  assert.equal(reservation.granted, true);
  if (!reservation.granted) throw new Error('reservation must be granted');
  assert.equal(reservation.expires_at, '2026-07-22T08:00:35.000Z');

  now = new Date('2026-07-22T08:00:20.000Z');
  const renewed = await store.renew({
    tenant_id: 'tenant-realtime-lease',
    lease_id: reservation.lease_id,
    profile
  });
  assert.deepEqual(renewed, {
    lease_id: reservation.lease_id,
    profile_id: 'speech-cloud',
    expires_at: '2026-07-22T08:00:55.000Z'
  });
  const runtime = await store.listRuntime('tenant-realtime-lease');
  assert.equal(runtime[0]?.minute_request_count, 1);
  assert.equal(runtime[0]?.day_request_count, 1);

  now = new Date('2026-07-22T08:00:56.000Z');
  await assert.rejects(
    () => store.renew({
      tenant_id: 'tenant-realtime-lease',
      lease_id: reservation.lease_id,
      profile
    }),
    /expired/i
  );
});

test('realtime intelligence migration expands policy and provider capability constraints safely', () => {
  const sql = readFileSync(migrationPath, 'utf8');
  for (const capability of ['realtime_speech', 'tts', 'model_gateway']) {
    assert.match(sql, new RegExp(`'${capability}'`, 'i'));
  }
  for (const column of [
    'realtime_speech_enabled', 'tts_enabled', 'model_gateway_enabled',
    'realtime_speech_profile_ids', 'tts_profile_ids', 'model_gateway_profile_ids'
  ]) {
    assert.match(
      sql,
      new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i'),
      column
    );
  }
  assert.match(sql, /collaboration_intelligence_provider_runtime_capability_check/i);
  assert.match(sql, /collaboration_intelligence_provider_leases_capability_check/i);
  assert.match(sql, /collaboration_intelligence_provider_runtime_max_concurrency_check/i);
  assert.match(sql, /max_concurrency BETWEEN 1 AND 1000000/i);
  assert.doesNotMatch(sql, /api_key|access_key|secret_key|password|bearer_token/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});
