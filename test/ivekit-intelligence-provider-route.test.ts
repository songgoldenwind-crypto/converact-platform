import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { IntelligenceProviderGovernanceStore } from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { IntelligencePolicyStore } from '../src/agent-runtime/collaboration/intelligence-policy-store.js';
import {
  executeIntelligenceProviderRoute,
  IntelligenceProviderRouteError
} from '../src/agent-runtime/collaboration/intelligence-provider-route.js';
import {
  createPolicyAttachmentProviderResolver,
  createPolicyQualityReviewProviderResolver,
  createPolicyTranslationProviderResolver
} from '../src/agent-runtime/collaboration/intelligence-provider-routing.js';
import { intelligenceProviderMetricDefinitions } from '../src/agent-runtime/collaboration/intelligence-provider-metrics.js';
import { metricsRegistry } from '../src/metrics.js';

test('provider route fails over retryable errors and records the actual selected profile', async () => {
  const registry = providerRegistry();
  const calls: string[] = [];
  const result = await executeIntelligenceProviderRoute({
    tenant_id: 'tenant-route',
    capability: 'translation',
    candidates: ['translation-primary', 'translation-fallback'].map((id) => ({
      profile: registry.requireProfile(id, 'translation'),
      provider: { id }
    })),
    governance: new IntelligenceProviderGovernanceStore(new MemoryPg()),
    invoke: async (provider) => {
      calls.push(provider.id);
      if (provider.id === 'translation-primary') {
        throw Object.assign(new Error('provider timeout detail'), {
          code: 'provider_timeout', retryable: true
        });
      }
      return { translated_text: 'hello' };
    }
  });

  assert.deepEqual(calls, ['translation-primary', 'translation-fallback']);
  assert.equal(result.selected_profile.id, 'translation-fallback');
  assert.deepEqual(result.output, { translated_text: 'hello' });
  assert.equal(result.attempt_count, 2);
  assert.equal(result.failed_over, true);
  assert.deepEqual(result.attempts, [
    { profile_id: 'translation-primary', status: 'retryable_failure', code: 'provider_timeout' },
    { profile_id: 'translation-fallback', status: 'succeeded', code: '' }
  ]);
  assert.doesNotMatch(JSON.stringify(result), /provider timeout detail/i);
  assert.deepEqual(intelligenceProviderMetricDefinitions.map((metric) => metric.name), [
    'opc_ivekit_intelligence_provider_reservations_total',
    'opc_ivekit_intelligence_provider_requests_total',
    'opc_ivekit_intelligence_provider_request_duration_seconds',
    'opc_ivekit_intelligence_provider_failovers_total',
    'opc_ivekit_intelligence_provider_routes_exhausted_total',
    'opc_ivekit_intelligence_provider_circuit_transitions_total'
  ]);
  const metrics = await metricsRegistry.metrics();
  assert.match(
    metrics,
    /opc_ivekit_intelligence_provider_requests_total\{capability="translation",profile_id="translation-primary",result="retryable_failure",error_code="provider_timeout"\}/
  );
  assert.match(
    metrics,
    /opc_ivekit_intelligence_provider_failovers_total\{capability="translation",from_profile="translation-primary",to_profile="translation-fallback"\}/
  );
});

test('provider route emits safe selection, failover, and circuit transition events', async () => {
  const registry = providerRegistry({ failure_threshold: 1 });
  const events: Array<{ tenant_id: string; type: string; data: Record<string, unknown> }> = [];
  const result = await executeIntelligenceProviderRoute({
    tenant_id: 'tenant-events',
    capability: 'translation',
    candidates: ['translation-primary', 'translation-fallback'].map((id) => ({
      profile: registry.requireProfile(id, 'translation'),
      provider: { id }
    })),
    governance: new IntelligenceProviderGovernanceStore(new MemoryPg()),
    onEvent: async (event) => {
      events.push(event);
    },
    invoke: async (provider) => {
      if (provider.id === 'translation-primary') {
        throw Object.assign(new Error('secret provider response'), {
          code: 'provider_timeout', retryable: true
        });
      }
      return { translated_text: 'hello' };
    }
  });

  assert.equal(result.selected_profile.id, 'translation-fallback');
  assert.deepEqual(events.map((event) => event.type), [
    'collaboration.intelligence.provider.circuit_changed',
    'collaboration.intelligence.provider.failed_over',
    'collaboration.intelligence.provider.selected'
  ]);
  assert.deepEqual(events[0], {
    tenant_id: 'tenant-events',
    type: 'collaboration.intelligence.provider.circuit_changed',
    data: {
      capability: 'translation',
      profile_id: 'translation-primary',
      previous_state: 'closed',
      state: 'open',
      error_code: 'provider_timeout'
    }
  });
  assert.deepEqual(events[2], {
    tenant_id: 'tenant-events',
    type: 'collaboration.intelligence.provider.selected',
    data: {
      capability: 'translation',
      profile_id: 'translation-fallback',
      attempt_count: 2,
      failed_over: true
    }
  });
  assert.deepEqual(events[1], {
    tenant_id: 'tenant-events',
    type: 'collaboration.intelligence.provider.failed_over',
    data: {
      capability: 'translation',
      from_profile_id: 'translation-primary',
      to_profile_id: 'translation-fallback',
      attempt_count: 2
    }
  });
  assert.doesNotMatch(JSON.stringify(events), /secret|https?:\/\//i);
  const metrics = await metricsRegistry.metrics();
  assert.match(
    metrics,
    /opc_ivekit_intelligence_provider_circuit_transitions_total\{capability="translation",profile_id="translation-primary",from_state="closed",to_state="open"\}/
  );
});

test('provider route event delivery failure does not roll back a successful provider result', async () => {
  const registry = providerRegistry();
  const result = await executeIntelligenceProviderRoute({
    tenant_id: 'tenant-event-failure',
    capability: 'translation',
    candidates: [{
      profile: registry.requireProfile('translation-primary', 'translation'),
      provider: { id: 'translation-primary' }
    }],
    governance: new IntelligenceProviderGovernanceStore(new MemoryPg()),
    onEvent: async () => {
      throw new Error('event store unavailable');
    },
    invoke: async () => ({ translated_text: 'still succeeds' })
  });

  assert.deepEqual(result.output, { translated_text: 'still succeeds' });
  assert.equal(result.selected_profile.id, 'translation-primary');
});

test('provider route never forwards terminal input or response errors to another provider', async () => {
  const registry = providerRegistry();
  const calls: string[] = [];
  await assert.rejects(
    () => executeIntelligenceProviderRoute({
      tenant_id: 'tenant-terminal',
      capability: 'translation',
      candidates: ['translation-primary', 'translation-fallback'].map((id) => ({
        profile: registry.requireProfile(id, 'translation'), provider: { id }
      })),
      governance: new IntelligenceProviderGovernanceStore(new MemoryPg()),
      invoke: async (provider) => {
        calls.push(provider.id);
        throw Object.assign(new Error('invalid source'), {
          code: 'provider_source_ref_invalid', retryable: false
        });
      }
    }),
    (error: unknown) => (error as { code?: string }).code === 'provider_source_ref_invalid'
  );
  assert.deepEqual(calls, ['translation-primary']);
});

test('provider route skips quota and circuit denials before exhausting safely', async () => {
  const registry = providerRegistry({ requests_per_minute: 1 });
  const governance = new IntelligenceProviderGovernanceStore(new MemoryPg());
  const candidates = ['translation-primary', 'translation-fallback'].map((id) => ({
    profile: registry.requireProfile(id, 'translation'), provider: { id }
  }));
  const invoke = async (provider: { id: string }) => ({ translated_text: provider.id });

  await executeIntelligenceProviderRoute({
    tenant_id: 'tenant-quota', capability: 'translation', candidates, governance, invoke
  });
  await executeIntelligenceProviderRoute({
    tenant_id: 'tenant-quota', capability: 'translation', candidates, governance, invoke
  });
  await assert.rejects(
    () => executeIntelligenceProviderRoute({
      tenant_id: 'tenant-quota', capability: 'translation', candidates, governance, invoke
    }),
    (error: unknown) => {
      assert.equal(error instanceof IntelligenceProviderRouteError, true);
      const routeError = error as IntelligenceProviderRouteError;
      assert.equal(routeError.code, 'provider_route_unavailable');
      assert.equal(routeError.retryable, true);
      assert.equal(routeError.provider_invoked, false);
      assert.equal(Number.isNaN(Date.parse(routeError.retry_at)), false);
      assert.deepEqual(routeError.attempts.map(({ retry_at: _retryAt, ...attempt }) => attempt), [
        { profile_id: 'translation-primary', status: 'skipped', code: 'minute_quota_exhausted' },
        { profile_id: 'translation-fallback', status: 'skipped', code: 'minute_quota_exhausted' }
      ]);
      assert.equal(routeError.attempts.every((attempt) => Boolean(attempt.retry_at)), true);
      return true;
    }
  );
});

test('provider route preserves successful output when governance completion needs reconciliation', async () => {
  const registry = providerRegistry();
  const governance = new IntelligenceProviderGovernanceStore(new MemoryPg());
  const originalComplete = governance.complete.bind(governance);
  let completions = 0;
  governance.complete = async (input) => {
    completions += 1;
    if (input.outcome === 'success') throw new Error('temporary governance write failure');
    return originalComplete(input);
  };

  const result = await executeIntelligenceProviderRoute({
    tenant_id: 'tenant-governance-reconcile',
    capability: 'translation',
    candidates: [{
      profile: registry.requireProfile('translation-primary', 'translation'),
      provider: { id: 'translation-primary' }
    }],
    governance,
    invoke: async () => ({ translated_text: 'provider already succeeded' })
  });

  assert.deepEqual(result.output, { translated_text: 'provider already succeeded' });
  assert.equal(result.governance_completion_pending, true);
  assert.equal(result.attempts[0]?.status, 'succeeded');
  assert.equal(completions, 1);
});

test('provider route reports exhausted failover attempts even when every provider fails', async () => {
  const registry = providerRegistry();
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  await assert.rejects(
    () => executeIntelligenceProviderRoute({
      tenant_id: 'tenant-route-exhausted-event',
      capability: 'translation',
      candidates: ['translation-primary', 'translation-fallback'].map((id) => ({
        profile: registry.requireProfile(id, 'translation'), provider: { id }
      })),
      governance: new IntelligenceProviderGovernanceStore(new MemoryPg()),
      onEvent: (event) => {
        events.push(event);
      },
      invoke: async () => {
        throw Object.assign(new Error('provider unavailable'), {
          code: 'provider_http_503', retryable: true
        });
      }
    }),
    (error: unknown) => {
      const routeError = error as IntelligenceProviderRouteError;
      assert.equal(routeError.provider_invoked, true);
      assert.equal(routeError.failover_attempted, true);
      assert.equal(routeError.attempts.length, 2);
      return true;
    }
  );
  assert.equal(events.some((event) => (
    event.type === 'collaboration.intelligence.provider.failed_over'
  )), true);
  assert.equal(events.some((event) => (
    event.type === 'collaboration.intelligence.provider.route_exhausted'
  )), true);
});

test('provider route emits explicit open, half-open, and closed circuit transitions', async () => {
  let now = new Date('2026-07-15T00:00:00.000Z');
  const registry = providerRegistry({ failure_threshold: 1, open_cooldown_ms: 1_000 });
  const governance = new IntelligenceProviderGovernanceStore(new MemoryPg(), { now: () => now });
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const input = {
    tenant_id: 'tenant-circuit-events',
    capability: 'translation' as const,
    candidates: [{
      profile: registry.requireProfile('translation-primary', 'translation'),
      provider: { id: 'translation-primary' }
    }],
    governance,
    onEvent: (event: (typeof events)[number]) => {
      events.push(event);
    }
  };
  await assert.rejects(() => executeIntelligenceProviderRoute({
    ...input,
    invoke: async () => {
      throw Object.assign(new Error('timeout'), { code: 'provider_timeout', retryable: true });
    }
  }), IntelligenceProviderRouteError);
  now = new Date('2026-07-15T00:00:01.001Z');
  await executeIntelligenceProviderRoute({
    ...input,
    invoke: async () => ({ translated_text: 'recovered' })
  });
  assert.deepEqual(
    events.filter((event) => event.type.endsWith('circuit_changed')).map((event) => [
      event.data.previous_state, event.data.state
    ]),
    [['closed', 'open'], ['open', 'half_open'], ['half_open', 'closed']]
  );
});

test('policy resolvers apply governed failover to OCR, ASR, quality review, and translation', async () => {
  const pg = new MemoryPg();
  const registry = allCapabilityRegistry();
  const events: Array<{ tenant_id: string; type: string; data: Record<string, unknown> }> = [];
  const onEvent = async (event: (typeof events)[number]) => {
    events.push(event);
  };
  await new IntelligencePolicyStore(pg, registry).updatePolicy({
    tenant_id: 'tenant-all-routes', actor_identity: 'owner-route', expected_version: 0,
    policy: {
      ocr_enabled: true, asr_enabled: true, quality_review_enabled: true, translation_enabled: true,
      ocr_profile_id: 'ocr-primary', asr_profile_id: 'asr-primary',
      quality_profile_id: 'quality-primary', translation_profile_id: 'translation-primary',
      ocr_profile_ids: ['ocr-primary', 'ocr-fallback'],
      asr_profile_ids: ['asr-primary', 'asr-fallback'],
      quality_profile_ids: ['quality-primary', 'quality-fallback'],
      translation_profile_ids: ['translation-primary', 'translation-fallback'],
      allow_third_party: true, auto_ocr: true, auto_asr: true,
      auto_quality_review: true, auto_translation: true,
      translation_target_languages: ['en-US'], min_ocr_confidence: 0, min_asr_confidence: 0
    }
  });
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('-primary')) return new Response('{}', { status: 503 });
    if (value.includes('quality-')) return jsonResponse({ findings: [] });
    if (value.includes('translation-')) return jsonResponse({ translated_text: 'hello' });
    return jsonResponse({ text: value.includes('ocr-') ? 'phone image text' : 'spoken phone text' });
  };
  const attachmentResolver = createPolicyAttachmentProviderResolver({
    pg, registry, fetch: fetchImpl, onEvent
  });
  for (const processor of ['ocr', 'asr'] as const) {
    const resolved = await attachmentResolver({ tenant_id: 'tenant-all-routes', processor });
    assert.ok(resolved.provider);
    await resolved.provider.extract({
      attachment_id: `${processor}-attachment`, tenant_id: 'tenant-all-routes',
      session_id: 'session-route', message_id: 'message-route', filename: `${processor}.bin`,
      content_type: processor === 'ocr' ? 'image/png' : 'audio/wav',
      source_ref: `ivekit://attachment/${processor}-attachment`, content: Buffer.from('bytes')
    });
    assert.equal(resolved.provider.profile_id, `${processor}-fallback`);
  }

  const quality = await createPolicyQualityReviewProviderResolver({ pg, registry, fetch: fetchImpl, onEvent })({
    tenant_id: 'tenant-all-routes'
  });
  assert.ok(quality.provider);
  await quality.provider.review({
    tenant_id: 'tenant-all-routes', session_id: 'session-route', message_id: 'message-route',
    content: 'content', content_hash: 'a'.repeat(64), rule_findings: [], evidence_refs: []
  });
  assert.equal(quality.provider.profile_id, 'quality-fallback');

  const translation = await createPolicyTranslationProviderResolver({ pg, registry, fetch: fetchImpl, onEvent })({
    tenant_id: 'tenant-all-routes'
  });
  assert.ok(translation.provider);
  await translation.provider.translate({
    tenant_id: 'tenant-all-routes', session_id: 'session-route', message_id: 'message-route',
    source_type: 'message', source_ref_id: 'message-route',
    source_ref: 'ivekit://message/message-route', text: '你好',
    source_language: 'zh-CN', target_language: 'en-US'
  });
  assert.equal(translation.provider.profile_id, 'translation-fallback');
  assert.equal(calls.filter((url) => url.includes('-primary')).length, 4);
  assert.equal(calls.filter((url) => url.includes('-fallback')).length, 4);
  assert.equal(events.length, 8);
  assert.equal(events.every((event) => event.tenant_id === 'tenant-all-routes'), true);
  assert.deepEqual(events.map((event) => event.type), [
    'collaboration.intelligence.provider.failed_over',
    'collaboration.intelligence.provider.selected',
    'collaboration.intelligence.provider.failed_over',
    'collaboration.intelligence.provider.selected',
    'collaboration.intelligence.provider.failed_over',
    'collaboration.intelligence.provider.selected',
    'collaboration.intelligence.provider.failed_over',
    'collaboration.intelligence.provider.selected'
  ]);
});

function providerRegistry(overrides: Record<string, unknown> = {}) {
  return createIntelligenceProviderRegistry({
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      {
        id: 'translation-primary', capability: 'translation', mode: 'self_hosted',
        base_url: 'http://translation-primary:8080', timeout_ms: 1_000,
        reservation_ttl_ms: 6_000, ...overrides
      },
      {
        id: 'translation-fallback', capability: 'translation', mode: 'third_party',
        base_url: 'https://translation.example.test', timeout_ms: 1_000,
        reservation_ttl_ms: 6_000, ...overrides
      }
    ])
  });
}

function allCapabilityRegistry() {
  const profiles = (['ocr', 'asr', 'quality', 'translation'] as const).flatMap((name) => {
    const capability = name === 'quality' ? 'quality_review' : name;
    return [
      {
        id: `${name}-primary`, capability, mode: 'self_hosted',
        base_url: `http://${name}-primary:8080`, timeout_ms: 1_000, reservation_ttl_ms: 6_000
      },
      {
        id: `${name}-fallback`, capability, mode: 'third_party',
        base_url: `https://${name}-fallback.example.test`, timeout_ms: 1_000, reservation_ttl_ms: 6_000
      }
    ];
  });
  return createIntelligenceProviderRegistry({ OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify(profiles) });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
