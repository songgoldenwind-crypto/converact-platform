import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';
import {
  IntelligencePolicyStore,
  type IntelligencePolicyUpdate
} from '../src/agent-runtime/collaboration/intelligence-policy-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { routeIveKitIntelligenceApi } from '../src/agent-runtime/converact/intelligence-http.js';

const providerEnv: NodeJS.ProcessEnv = {
  OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
    {
      id: 'ocr-private',
      capability: 'ocr',
      mode: 'self_hosted',
      base_url: 'http://ocr-worker:8080'
    },
    {
      id: 'asr-cloud',
      capability: 'asr',
      mode: 'third_party',
      base_url: 'https://asr.example.test',
      token_env: 'ASR_CLOUD_TOKEN'
    },
    {
      id: 'ocr-cloud',
      capability: 'ocr',
      mode: 'third_party',
      base_url: 'https://ocr.example.test'
    },
    {
      id: 'quality-private',
      capability: 'quality_review',
      mode: 'self_hosted',
      base_url: 'http://quality-worker:8080'
    },
    {
      id: 'translation-cloud',
      capability: 'translation',
      mode: 'third_party',
      base_url: 'https://translation.example.test',
      token_env: 'TRANSLATION_CLOUD_TOKEN'
    },
    {
      id: 'translation-private',
      capability: 'translation',
      mode: 'self_hosted',
      base_url: 'http://translation-worker:8080'
    }
  ]),
  ASR_CLOUD_TOKEN: 'asr-secret',
  TRANSLATION_CLOUD_TOKEN: 'translation-secret'
};

test('missing tenant policy uses conservative legacy-compatible defaults', async () => {
  const pg = new MemoryPg();
  const registry = createIntelligenceProviderRegistry({
    OPC_OCR_BASE_URL: 'http://ocr-worker:8080',
    OPC_ASR_BASE_URL: 'https://asr.example.test',
    OPC_ASR_PROVIDER_MODE: 'third_party',
    OPC_QUALITY_REVIEW_BASE_URL: 'http://quality-worker:8080'
  });
  const store = new IntelligencePolicyStore(pg, registry);

  const policy = await store.getEffectivePolicy('tenant-defaults');
  assert.equal(policy.configured, false);
  assert.equal(policy.version, 0);
  assert.equal(policy.ocr_enabled, true);
  assert.equal(policy.ocr_profile_id, 'legacy-ocr');
  assert.deepEqual(policy.ocr_profile_ids, ['legacy-ocr']);
  assert.equal(policy.asr_profile_id, 'legacy-asr');
  assert.deepEqual(policy.asr_profile_ids, ['legacy-asr']);
  assert.deepEqual(policy.quality_profile_ids, ['legacy-quality']);
  assert.deepEqual(policy.translation_profile_ids, []);
  assert.equal(policy.allow_third_party, true);
  assert.equal(policy.translation_enabled, false);
  assert.equal(policy.auto_translation, false);
  assert.deepEqual(policy.translation_target_languages, []);
  assert.equal(JSON.stringify(policy).includes('secret'), false);
});

test('policy updates are versioned, canonicalized, and reject unsafe profile selection', async () => {
  const pg = new MemoryPg();
  const registry = createIntelligenceProviderRegistry(providerEnv);
  const store = new IntelligencePolicyStore(pg, registry);
  const update = validPolicyUpdate();

  const created = await store.updatePolicy({
    tenant_id: 'tenant-policy',
    actor_identity: 'owner-1',
    expected_version: 0,
    policy: update
  });
  assert.equal(created.version, 1);
  assert.equal(created.updated_by, 'owner-1');
  assert.deepEqual(created.ocr_profile_ids, ['ocr-private', 'ocr-cloud']);
  assert.deepEqual(created.translation_profile_ids, ['translation-cloud', 'translation-private']);
  assert.equal(created.ocr_profile_id, 'ocr-private');
  assert.equal(created.translation_profile_id, 'translation-cloud');
  assert.deepEqual(created.translation_target_languages, ['en-US', 'ja-JP']);

  await assert.rejects(
    () => store.updatePolicy({
      tenant_id: 'tenant-policy',
      actor_identity: 'owner-2',
      expected_version: 0,
      policy: update
    }),
    (error: unknown) => errorStatus(error) === 409
  );
  const updated = await store.updatePolicy({
    tenant_id: 'tenant-policy',
    actor_identity: 'admin-1',
    expected_version: 1,
    policy: { ...update, auto_quality_review: true }
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.auto_quality_review, true);

  await assert.rejects(
    () => new IntelligencePolicyStore(new MemoryPg(), registry).updatePolicy({
      tenant_id: 'tenant-policy-third-party-denied',
      actor_identity: 'owner-1',
      expected_version: 0,
      policy: { ...update, allow_third_party: false }
    }),
    /third-party/i
  );
  await assert.rejects(
    () => new IntelligencePolicyStore(new MemoryPg(), registry).updatePolicy({
      tenant_id: 'tenant-policy-capability-mismatch',
      actor_identity: 'owner-1',
      expected_version: 0,
      policy: { ...update, ocr_profile_id: 'translation-cloud' }
    }),
    /capability/i
  );
  await assert.rejects(
    () => new IntelligencePolicyStore(new MemoryPg(), registry).updatePolicy({
      tenant_id: 'tenant-policy-route-capability-mismatch',
      actor_identity: 'owner-1',
      expected_version: 0,
      policy: { ...update, ocr_profile_ids: ['ocr-private', 'translation-private'] }
    }),
    /capability/i
  );
  await assert.rejects(
    () => new IntelligencePolicyStore(new MemoryPg(), registry).updatePolicy({
      tenant_id: 'tenant-policy-route-duplicate',
      actor_identity: 'owner-1',
      expected_version: 0,
      policy: { ...update, ocr_profile_ids: ['ocr-private', 'ocr-private'] }
    }),
    /duplicate/i
  );
  await assert.rejects(
    () => new IntelligencePolicyStore(new MemoryPg(), registry).updatePolicy({
      tenant_id: 'tenant-policy-disabled-auto',
      actor_identity: 'owner-1',
      expected_version: 0,
      policy: { ...update, translation_enabled: false, auto_translation: true }
    }),
    /auto_translation requires translation_enabled/i
  );
});

test('intelligence HTTP exposes public capabilities but protects policy and profile administration', async () => {
  const previous = snapshotEnv(['OPC_API_KEY', 'OPC_JWT_SECRET']);
  process.env.OPC_API_KEY = 'intelligence-system-key';
  process.env.OPC_JWT_SECRET = 'intelligence-jwt-secret-with-sufficient-length';
  const pg = new MemoryPg();
  const registry = createIntelligenceProviderRegistry(providerEnv);
  const published: Array<{ tenantId: string; type: string; data: unknown }> = [];
  const systemHeaders = {
    'x-api-key': 'intelligence-system-key',
    'x-tenant-id': 'tenant-http',
    'x-user-id': 'ops-system'
  };
  try {
    const put = await routeIveKitIntelligenceApi(
      pg,
      'PUT',
      '/api/ivekit/intelligence/policy',
      new URL('http://localhost/api/ivekit/intelligence/policy'),
      { version: 0, ...validPolicyUpdate() },
      systemHeaders,
      {
        registry,
        publish: (tenantId, type, data) => {
          published.push({ tenantId, type, data });
        }
      }
    ) as { status: number; data: { version: number }; afterCommit: () => Promise<void> };
    assert.equal(put.status, 201);
    assert.equal(put.data.version, 1);
    await put.afterCommit();
    assert.deepEqual(published, [{
      tenantId: 'tenant-http',
      type: 'collaboration.intelligence.policy_updated',
      data: { tenant_id: 'tenant-http', version: 1, updated_by: 'ops-system' }
    }]);

    const capabilities = await routeIveKitIntelligenceApi(
      pg,
      'GET',
      '/api/ivekit/intelligence/capabilities',
      new URL('http://localhost/api/ivekit/intelligence/capabilities'),
      {},
      systemHeaders,
      { registry }
    ) as { data: Record<string, unknown> };
    assert.equal(JSON.stringify(capabilities).includes('translation-secret'), false);
    assert.equal(JSON.stringify(capabilities).includes('base_url'), false);
    assert.equal(JSON.stringify(capabilities).includes('token_env'), false);
    const capabilityData = capabilities.data as {
      capabilities: Record<string, {
        provider_profile_ids: string[];
        providers: Array<Record<string, unknown>>;
      }>;
    };
    assert.deepEqual(capabilityData.capabilities.ocr.provider_profile_ids, [
      'ocr-private', 'ocr-cloud'
    ]);
    assert.deepEqual(capabilityData.capabilities.ocr.providers, [
      {
        profile_id: 'ocr-private', mode: 'self_hosted', available: true, reason: ''
      },
      {
        profile_id: 'ocr-cloud', mode: 'third_party', available: true, reason: ''
      }
    ]);
    assert.deepEqual(capabilityData.capabilities.translation.provider_profile_ids, [
      'translation-cloud', 'translation-private'
    ]);

    const providers = await routeIveKitIntelligenceApi(
      pg,
      'GET',
      '/api/ivekit/intelligence/providers',
      new URL('http://localhost/api/ivekit/intelligence/providers'),
      {},
      systemHeaders,
      { registry }
    ) as { data: { items: unknown[] } };
    assert.equal(providers.data.items.length, 6);
    assert.equal(JSON.stringify(providers).includes('translation-secret'), false);
    assert.equal(JSON.stringify(providers).includes('token_env'), false);
    assert.equal(JSON.stringify(providers).includes('base_url'), false);

    const runtime = await routeIveKitIntelligenceApi(
      pg,
      'GET',
      '/api/ivekit/intelligence/providers/runtime',
      new URL('http://localhost/api/ivekit/intelligence/providers/runtime'),
      {},
      systemHeaders,
      {
        registry,
        governance: {
          listRuntime: async () => [{
            tenant_id: 'tenant-http', capability: 'translation', profile_id: 'translation-cloud',
            minute_request_count: 2, day_request_count: 20, circuit_state: 'closed',
            consecutive_retryable_failures: 0, opened_until: null, last_success_at: null,
            last_failure_at: null, last_error_code: '', updated_at: '2026-07-15T00:00:00.000Z'
          }]
        }
      }
    ) as { data: { items: Array<{ profile_id: string }> } };
    assert.equal(runtime.data.items[0]?.profile_id, 'translation-cloud');
    assert.doesNotMatch(JSON.stringify(runtime), /base_url|token_env|translation-secret/i);

    const ownerToken = signAccessToken({ sub: 'owner-http', tid: 'tenant-http', role: 'owner' });
    const policy = await routeIveKitIntelligenceApi(
      pg,
      'GET',
      '/api/ivekit/intelligence/policy',
      new URL('http://localhost/api/ivekit/intelligence/policy'),
      {},
      { authorization: `Bearer ${ownerToken}` },
      { registry }
    ) as { data: { version: number } };
    assert.equal(policy.data.version, 1);

    const viewerToken = signAccessToken({ sub: 'viewer-http', tid: 'tenant-http', role: 'viewer' });
    await assert.rejects(
      () => routeIveKitIntelligenceApi(
        pg,
        'GET',
        '/api/ivekit/intelligence/policy',
        new URL('http://localhost/api/ivekit/intelligence/policy'),
        {},
        { authorization: `Bearer ${viewerToken}` },
        { registry }
      ),
      (error: unknown) => errorStatus(error) === 403
    );
    await assert.rejects(
      () => routeIveKitIntelligenceApi(
        pg,
        'GET',
        '/api/ivekit/intelligence/providers/runtime',
        new URL('http://localhost/api/ivekit/intelligence/providers/runtime'),
        {},
        { authorization: `Bearer ${viewerToken}` },
        { registry }
      ),
      (error: unknown) => errorStatus(error) === 403
    );
  } finally {
    restoreEnv(previous);
  }
});

function validPolicyUpdate(): IntelligencePolicyUpdate {
  return {
    ocr_enabled: true,
    asr_enabled: true,
    quality_review_enabled: true,
    translation_enabled: true,
    ocr_profile_id: 'ocr-private',
    asr_profile_id: 'asr-cloud',
    quality_profile_id: 'quality-private',
    translation_profile_id: 'translation-cloud',
    ocr_profile_ids: ['ocr-private', 'ocr-cloud'],
    asr_profile_ids: ['asr-cloud'],
    quality_profile_ids: ['quality-private'],
    translation_profile_ids: ['translation-cloud', 'translation-private'],
    allow_third_party: true,
    auto_ocr: true,
    auto_asr: true,
    auto_quality_review: false,
    auto_translation: true,
    translation_target_languages: ['EN-us', 'ja-jp', 'en-US'],
    min_ocr_confidence: 0.6,
    min_asr_confidence: 0.55
  };
}

function errorStatus(error: unknown): number {
  return Number((error as { status?: unknown })?.status || 0);
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
