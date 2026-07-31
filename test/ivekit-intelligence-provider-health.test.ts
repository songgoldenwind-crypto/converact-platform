import assert from 'node:assert/strict';
import test from 'node:test';

import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { IntelligenceProviderHealthService } from '../src/agent-runtime/collaboration/intelligence-provider-health.js';
import { routeIveKitIntelligenceApi } from '../src/agent-runtime/ivekit/intelligence-http.js';
import { MemoryPg } from '../src/db-pg.js';

const API_KEY = 'intelligence-health-system-key';

test('provider health reports only bounded coarse status and never response bodies or credentials', async () => {
  const calls: Array<{ url: string; authorization: string }> = [];
  const registry = createIntelligenceProviderRegistry({
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      profile('ocr-ok', 'ocr', 'https://ocr.example.test'),
      profile('asr-rate-limited', 'asr', 'https://asr.example.test'),
      profile('quality-auth-failed', 'quality_review', 'https://quality.example.test'),
      profile('translation-broken', 'translation', 'https://translation.example.test')
    ]),
    PROVIDER_TEST_TOKEN: 'provider-health-secret'
  });
  const service = new IntelligenceProviderHealthService(registry, {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization') || ''
      });
      const status = String(url).includes('ocr.')
        ? 200
        : String(url).includes('asr.')
          ? 429
          : String(url).includes('quality.')
            ? 401
            : 503;
      return new Response('provider-health-secret must never be returned', { status });
    },
    clock: () => 1_783_900_000_000,
    timeout_ms: 50
  });

  const results = await service.probe();
  assert.deepEqual(results.map((item) => [item.profile_id, item.status, item.http_class]), [
    ['ocr-ok', 'healthy', '2xx'],
    ['asr-rate-limited', 'degraded', '4xx'],
    ['quality-auth-failed', 'unavailable', '4xx'],
    ['translation-broken', 'degraded', '5xx']
  ]);
  assert.equal(calls.every((call) => call.url.endsWith('/health')), true);
  assert.equal(calls.every((call) => call.authorization === 'Bearer provider-health-secret'), true);
  const serialized = JSON.stringify(results);
  assert.doesNotMatch(serialized, /provider-health-secret|example\.test|authorization|response/i);
});

test('provider health distinguishes missing credentials, timeout, and network failure without leaking errors', async () => {
  const registry = createIntelligenceProviderRegistry({
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      profile('ocr-missing-token', 'ocr', 'https://ocr.example.test'),
      { ...profile('asr-timeout', 'asr', 'https://asr.example.test'), token_env: '' },
      { ...profile('quality-network', 'quality_review', 'https://quality.example.test'), token_env: '' }
    ])
  });
  const service = new IntelligenceProviderHealthService(registry, {
    fetch: async (url, init) => {
      if (String(url).includes('asr.')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('secret network timeout detail')));
        });
      }
      throw new Error('secret DNS detail');
    },
    timeout_ms: 10
  });

  const results = await service.probe();
  assert.deepEqual(results.map((item) => [item.profile_id, item.status, item.http_class]), [
    ['ocr-missing-token', 'unavailable', 'not_run'],
    ['asr-timeout', 'unavailable', 'timeout'],
    ['quality-network', 'unavailable', 'network']
  ]);
  assert.doesNotMatch(JSON.stringify(results), /secret|DNS|detail/i);
});

test('provider health HTTP endpoint requires an administrator and bounds profile selection', async () => {
  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = API_KEY;
  const registry = createIntelligenceProviderRegistry({
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      { ...profile('ocr-ok', 'ocr', 'https://ocr.example.test'), token_env: '' }
    ])
  });
  try {
    const response = await routeIveKitIntelligenceApi(
      new MemoryPg(),
      'POST',
      '/api/ivekit/intelligence/providers/health',
      new URL('http://localhost/api/ivekit/intelligence/providers/health'),
      { profile_ids: ['ocr-ok'] },
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-health',
        'x-user-id': 'ops-health'
      },
      {
        registry,
        health: {
          probe: async (input) => [{
            profile_id: input.profile_ids?.[0] || '',
            capability: 'ocr',
            mode: 'third_party',
            configured: true,
            status: 'healthy',
            http_class: '2xx',
            latency_ms: 2,
            checked_at: '2026-07-13T00:00:00.000Z'
          }]
        }
      }
    ) as { data: { items: Array<{ profile_id: string }> } };
    assert.equal(response.data.items[0]?.profile_id, 'ocr-ok');
  } finally {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
  }
});

function profile(
  id: string,
  capability: 'ocr' | 'asr' | 'quality_review' | 'translation',
  baseUrl: string
): Record<string, unknown> {
  return {
    id,
    capability,
    mode: 'third_party',
    base_url: baseUrl,
    health_endpoint: '/health',
    token_env: 'PROVIDER_TEST_TOKEN'
  };
}
