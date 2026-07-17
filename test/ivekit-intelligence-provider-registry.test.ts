import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createIntelligenceProviderRegistry,
  type IntelligenceProviderCapability
} from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import {
  sanitizeProviderMetadata,
  sanitizeProviderRequestId
} from '../src/agent-runtime/collaboration/provider-safety.js';
import { configuredAsrProvider } from '../src/agent-runtime/collaboration/asr-provider.js';
import { configuredOcrProvider } from '../src/agent-runtime/collaboration/ocr-provider.js';
import { configuredQualityReviewProvider } from '../src/agent-runtime/collaboration/quality-review.js';

test('provider registry parses safe profiles and resolves secrets only on explicit internal access', () => {
  const env: NodeJS.ProcessEnv = {
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      {
        id: 'ocr-internal',
        capability: 'ocr',
        mode: 'self_hosted',
        base_url: 'http://ocr-worker:8080',
        endpoint: '/v1/ocr',
        health_endpoint: '/health',
        token_env: 'OCR_INTERNAL_TOKEN',
        requests_per_minute: 120,
        requests_per_day: 5_000,
        max_concurrency: 4,
        failure_threshold: 5,
        open_cooldown_ms: 45_000,
        reservation_ttl_ms: 40_000
      },
      {
        id: 'translate-cloud',
        capability: 'translation',
        mode: 'third_party',
        base_url: 'https://translation.example.test',
        endpoint: '/v1/translate',
        token_env: 'TRANSLATION_CLOUD_TOKEN'
      }
    ]),
    OCR_INTERNAL_TOKEN: 'ocr-runtime-secret',
    TRANSLATION_CLOUD_TOKEN: 'translation-runtime-secret',
    DATABASE_URL: 'must-never-resolve-through-profile-copy'
  };
  const registry = createIntelligenceProviderRegistry(env);

  assert.deepEqual(registry.listSafe(), [
    {
      id: 'ocr-internal',
      capability: 'ocr',
      mode: 'self_hosted',
      name: 'ocr-internal',
      configured: true,
      token_configured: true,
      requests_per_minute: 120,
      requests_per_day: 5_000,
      max_concurrency: 4,
      failure_threshold: 5,
      open_cooldown_ms: 45_000,
      reservation_ttl_ms: 40_000
    },
    {
      id: 'translate-cloud',
      capability: 'translation',
      mode: 'third_party',
      name: 'translate-cloud',
      configured: true,
      token_configured: true,
      requests_per_minute: 0,
      requests_per_day: 0,
      max_concurrency: 10,
      failure_threshold: 3,
      open_cooldown_ms: 30_000,
      reservation_ttl_ms: 35_000
    }
  ]);
  const ocr = registry.requireProfile('ocr-internal', 'ocr');
  assert.equal(ocr.endpoint, '/v1/ocr');
  assert.equal(registry.resolveToken(ocr), 'ocr-runtime-secret');
  assert.equal(
    registry.resolveToken({ ...ocr, token_env: 'DATABASE_URL' }),
    'ocr-runtime-secret'
  );
  assert.equal(JSON.stringify(registry.listSafe()).includes('TOKEN'), false);
  assert.equal(JSON.stringify(registry.listSafe()).includes('runtime-secret'), false);
  assert.throws(() => registry.requireProfile('ocr-internal', 'asr'), /capability/i);
});

test('provider registry rejects unsafe or ambiguous deployment profiles', () => {
  const invalidProfiles: Array<[string, Record<string, unknown>[], RegExp]> = [
    ['duplicate id', [baseProfile(), baseProfile()], /duplicate provider profile id/i],
    ['invalid id', [{ ...baseProfile(), id: 'OCR Internal' }], /profile id/i],
    ['third-party HTTP', [{ ...baseProfile(), mode: 'third_party' }], /https/i],
    ['public self-hosted HTTP', [{ ...baseProfile(), base_url: 'http://ocr.example.test' }], /private or container host/i],
    ['embedded credential', [{ ...baseProfile(), base_url: 'http://user:pass@ocr-worker:8080' }], /credentials/i],
    ['query', [{ ...baseProfile(), base_url: 'http://ocr-worker:8080?token=value' }], /query/i],
    ['fragment', [{ ...baseProfile(), base_url: 'http://ocr-worker:8080/#secret' }], /fragment/i],
    ['endpoint traversal', [{ ...baseProfile(), endpoint: '/../admin' }], /endpoint/i],
    ['invalid token env', [{ ...baseProfile(), token_env: 'token-value' }], /token_env/i],
    ['inline token', [{ ...baseProfile(), token: 'forbidden' }], /unsupported field/i],
    ['negative minute quota', [{ ...baseProfile(), requests_per_minute: -1 }], /requests_per_minute/i],
    ['day quota too large', [{ ...baseProfile(), requests_per_day: 1_000_000_001 }], /requests_per_day/i],
    ['zero concurrency', [{ ...baseProfile(), max_concurrency: 0 }], /max_concurrency/i],
    ['zero failure threshold', [{ ...baseProfile(), failure_threshold: 0 }], /failure_threshold/i],
    ['short cooldown', [{ ...baseProfile(), open_cooldown_ms: 999 }], /open_cooldown_ms/i],
    ['lease shorter than timeout', [{
      ...baseProfile(), timeout_ms: 20_000, reservation_ttl_ms: 20_000
    }], /reservation_ttl_ms/i]
  ];

  for (const [label, profiles, pattern] of invalidProfiles) {
    assert.throws(
      () => createIntelligenceProviderRegistry({
        OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify(profiles)
      }),
      pattern,
      label
    );
  }
});

test('legacy OCR, ASR, and quality settings become compatible default profiles', () => {
  const env: NodeJS.ProcessEnv = {
    OPC_OCR_BASE_URL: 'http://ocr-worker:8080',
    OPC_OCR_TOKEN: 'legacy-ocr-secret',
    OPC_ASR_BASE_URL: 'https://asr.example.test',
    OPC_ASR_PROVIDER_MODE: 'third_party',
    OPC_ASR_TOKEN: 'legacy-asr-secret',
    OPC_QUALITY_REVIEW_BASE_URL: 'http://quality-worker:8080',
    OPC_QUALITY_REVIEW_PROVIDER_NAME: 'quality-internal',
    OPC_QUALITY_REVIEW_TOKEN: 'legacy-quality-secret'
  };
  const registry = createIntelligenceProviderRegistry(env);

  for (const capability of ['ocr', 'asr', 'quality_review'] as IntelligenceProviderCapability[]) {
    assert.equal(registry.defaultProfile(capability)?.id, `legacy-${capability.replace('_review', '')}`);
  }
  assert.equal(configuredOcrProvider(env)?.name, 'self_hosted-ocr');
  assert.equal(configuredAsrProvider(env)?.mode, 'third_party');
  assert.equal(configuredQualityReviewProvider(env)?.name, 'quality-internal');
  assert.equal(JSON.stringify(registry.listSafe()).includes('legacy-ocr-secret'), false);
});

test('provider metadata and request IDs are recursively bounded and secret-key safe', () => {
  const metadata = sanitizeProviderMetadata({
    model: 'vision-v3',
    token: 'must-disappear',
    nested: {
      api_key: 'must-also-disappear',
      'auth.token': 'must-disappear-too',
      credentials: 'must-disappear-again',
      label: 'x'.repeat(700),
      values: Array.from({ length: 30 }, (_, index) => index)
    }
  });

  assert.equal(metadata.model, 'vision-v3');
  assert.equal('token' in metadata, false);
  assert.equal(JSON.stringify(metadata).includes('must-'), false);
  assert.equal(String((metadata.nested as Record<string, unknown>).label).length, 500);
  assert.equal(((metadata.nested as Record<string, unknown>).values as unknown[]).length, 20);
  assert.equal(sanitizeProviderRequestId(' req/unsafe?value '), 'req_unsafe_value');
});

function baseProfile(): Record<string, unknown> {
  return {
    id: 'ocr-internal',
    capability: 'ocr',
    mode: 'self_hosted',
    base_url: 'http://ocr-worker:8080',
    endpoint: '/v1/ocr',
    health_endpoint: '/health',
    token_env: 'OCR_INTERNAL_TOKEN'
  };
}
