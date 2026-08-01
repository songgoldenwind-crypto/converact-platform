import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import {
  createPolicyModelGatewayProviderResolver,
  createPolicyTtsProviderResolver
} from '../src/agent-runtime/collaboration/generic-provider-routing.js';
import { IntelligenceProviderGovernanceStore } from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { IntelligenceProviderRouteError } from '../src/agent-runtime/collaboration/intelligence-provider-route.js';
import { IntelligencePolicyStore } from '../src/agent-runtime/collaboration/intelligence-policy-store.js';

test('model gateway policy route applies retryable failover and safe route metadata', async () => {
  const fixture = await routingFixture();
  const calls: string[] = [];
  const resolver = createPolicyModelGatewayProviderResolver({
    pg: fixture.pg,
    registry: fixture.registry,
    governance: fixture.governance,
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).includes('model-primary')) return new Response('{}', { status: 503 });
      return jsonResponse({
        output: { decision: 'continue' },
        model: 'controlled-model',
        provider_request_id: 'request-fallback',
        metadata: { region: 'test', prompt: 'must-not-leak' }
      });
    }
  });
  const resolved = await resolver({ tenant_id: 'tenant-generic-route' });

  assert.equal(resolved.enabled, true);
  assert.ok(resolved.provider);
  const result = await resolved.provider.generate(modelInput());
  assert.deepEqual(calls, [
    'http://model-primary:8080/v1/model',
    'http://model-fallback:8080/v1/model'
  ]);
  assert.equal(resolved.provider.profile_id, 'model-fallback');
  assert.deepEqual(result.output, { decision: 'continue' });
  assert.equal(result.metadata.ivekit_route_attempt_count, 2);
  assert.equal(result.metadata.ivekit_route_failed_over, true);
  assert.doesNotMatch(JSON.stringify(result.metadata), /must-not-leak|prompt/i);
});

test('TTS policy route holds concurrency until audio consumption completes', async () => {
  const fixture = await routingFixture({
    tts_max_concurrency: 1,
    tts_route: ['tts-primary']
  });
  const calls: string[] = [];
  const resolver = createPolicyTtsProviderResolver({
    pg: fixture.pg,
    registry: fixture.registry,
    governance: fixture.governance,
    lease_renew_interval_ms: 10,
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 },
        duration_ms: 20,
        audio_base64: 'AAA=',
        metadata: { region: 'test' }
      });
    }
  });
  const resolved = await resolver({ tenant_id: 'tenant-generic-route' });
  assert.ok(resolved.provider);

  const first = await resolved.provider.synthesize(ttsInput('tts-first'));
  await assert.rejects(
    () => resolved.provider!.synthesize(ttsInput('tts-blocked')),
    (error: unknown) => {
      assert.equal(error instanceof IntelligenceProviderRouteError, true);
      assert.equal(
        (error as IntelligenceProviderRouteError).attempts.every(
          (attempt) => attempt.code === 'concurrency_exhausted'
        ),
        true
      );
      return true;
    }
  );
  assert.equal((await fixture.governance.listRuntime('tenant-generic-route'))
    .find((item) => item.profile_id === 'tts-primary')?.minute_request_count, 1);
  assert.equal((await collectAudio(first.audio)).length, 1);

  const afterCompletion = await resolved.provider.synthesize(ttsInput('tts-after-completion'));
  await collectAudio(afterCompletion.audio);
});

test('TTS policy route never changes provider after an audio stream is established', async () => {
  const fixture = await routingFixture();
  const calls: string[] = [];
  const resolver = createPolicyTtsProviderResolver({
    pg: fixture.pg,
    registry: fixture.registry,
    governance: fixture.governance,
    fetch: async (url) => {
      calls.push(String(url));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: metadata\ndata: {"audio_format":{"encoding":"pcm_s16le","sample_rate_hz":16000,"channels":1}}\n\n'
          ));
          controller.error(Object.assign(new Error('stream disconnected'), {
            code: 'provider_stream_disconnected', retryable: true
          }));
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });
  const resolved = await resolver({ tenant_id: 'tenant-generic-route' });
  assert.ok(resolved.provider);

  const established = await resolved.provider.synthesize(ttsInput('tts-stream-failure'));
  const callsBeforeRead = calls.length;
  await assert.rejects(() => collectAudio(established.audio));
  assert.equal(calls.length, callsBeforeRead);
  assert.equal(calls.at(-1), 'http://tts-primary:8080/v1/tts');
  assert.equal(calls.some((url) => url.includes('tts-fallback')), false);
});

test('generic routes enforce adapter compatibility before provider invocation', async () => {
  const fixture = await routingFixture({
    tts_route: ['tts-incompatible'],
    model_route: ['model-incompatible']
  });
  const tts = await createPolicyTtsProviderResolver({
    pg: fixture.pg, registry: fixture.registry, governance: fixture.governance
  })({ tenant_id: 'tenant-generic-route' });
  const model = await createPolicyModelGatewayProviderResolver({
    pg: fixture.pg, registry: fixture.registry, governance: fixture.governance
  })({ tenant_id: 'tenant-generic-route' });

  assert.deepEqual(
    { enabled: tts.enabled, provider: tts.provider, error_code: tts.error_code },
    { enabled: true, provider: null, error_code: 'provider_adapter_unavailable' }
  );
  assert.deepEqual(
    { enabled: model.enabled, provider: model.provider, error_code: model.error_code },
    { enabled: true, provider: null, error_code: 'provider_adapter_unavailable' }
  );
});

async function routingFixture(options: {
  tts_max_concurrency?: number;
  allow_third_party?: boolean;
  tts_route?: string[];
  model_route?: string[];
} = {}) {
  const pg = new MemoryPg();
  const registry = createIntelligenceProviderRegistry({
    CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([
      profile('tts-primary', 'tts', 'self_hosted', 'ivekit_tts_v1', options.tts_max_concurrency),
      profile('tts-fallback', 'tts', 'self_hosted', 'ivekit_tts_v1', options.tts_max_concurrency),
      profile('tts-third-party', 'tts', 'third_party', 'ivekit_tts_v1'),
      profile('tts-incompatible', 'tts', 'self_hosted', 'unsupported_adapter'),
      profile('model-primary', 'model_gateway', 'self_hosted', 'openai_compatible'),
      profile('model-fallback', 'model_gateway', 'self_hosted', 'openai_compatible'),
      profile('model-incompatible', 'model_gateway', 'self_hosted', 'unsupported_adapter')
    ])
  });
  await new IntelligencePolicyStore(pg, registry).updatePolicy({
    tenant_id: 'tenant-generic-route', actor_identity: 'owner-a', expected_version: 0,
    policy: {
      ocr_enabled: false, asr_enabled: false, quality_review_enabled: false,
      translation_enabled: false, tts_enabled: true, model_gateway_enabled: true,
      tts_profile_ids: options.tts_route ?? ['tts-primary', 'tts-fallback'],
      model_gateway_profile_ids: options.model_route ?? ['model-primary', 'model-fallback'],
      allow_third_party: options.allow_third_party ?? true,
      auto_ocr: false, auto_asr: false, auto_quality_review: false, auto_translation: false,
      translation_target_languages: [], min_ocr_confidence: 0, min_asr_confidence: 0
    }
  });
  const governance = new IntelligenceProviderGovernanceStore(pg);
  return { pg, registry, governance };
}

function profile(
  id: string,
  capability: 'tts' | 'model_gateway',
  mode: 'self_hosted' | 'third_party',
  adapter: string,
  maxConcurrency = 10
) {
  return {
    id,
    capability,
    mode,
    base_url: mode === 'third_party' ? `https://${id}.example.test` : `http://${id}:8080`,
    adapter,
    timeout_ms: 1_000,
    reservation_ttl_ms: 5_000,
    max_concurrency: maxConcurrency,
    provider_version: 'controlled-v1'
  };
}

function modelInput() {
  return {
    tenant_id: 'tenant-generic-route', interaction_id: 'interaction-a',
    task: 'agent.reply', input: { text: 'hello' },
    output_schema: {
      type: 'object', additionalProperties: false, required: ['decision'],
      properties: { decision: { type: 'string', enum: ['continue'] } }
    },
    model_hint: '', temperature: 0, max_output_tokens: 100, idempotency_key: 'model-a'
  };
}

function ttsInput(idempotencyKey: string) {
  return {
    tenant_id: 'tenant-generic-route', interaction_id: 'interaction-a', text: 'hello',
    language: 'en-US', voice: 'agent-a',
    audio_format: { encoding: 'pcm_s16le' as const, sample_rate_hz: 16_000 as const, channels: 1 as const },
    idempotency_key: idempotencyKey
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

async function collectAudio<T>(audio: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of audio) chunks.push(chunk);
  return chunks;
}
