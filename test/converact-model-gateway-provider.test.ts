import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ModelGatewayProviderError,
  createHttpModelGatewayProvider
} from '../src/agent-runtime/collaboration/model-gateway-provider.js';

test('model gateway requires schema-valid structured output and returns data without executing it', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let commandExecutions = 0;
  const provider = createHttpModelGatewayProvider({
    mode: 'third_party', baseUrl: 'https://model.example.test', endpoint: '/v2/model',
    token: 'model-secret', profileId: 'model-cloud', providerVersion: 'sglang-compatible-v1',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        output: { score: 91, action: 'disconnect_call' },
        model: 'quality-v7', provider_request_id: ' model request ',
        usage: { input_tokens: 120, output_tokens: 18 },
        metadata: { region: 'ap-southeast', prompt: 'must-drop', token: 'model-secret' }
      });
    }
  });

  const result = await provider.generate(validInput());
  assert.equal(requests[0]?.url, 'https://model.example.test/v2/model');
  assert.equal(new Headers(requests[0]?.init?.headers).get('authorization'), 'Bearer model-secret');
  assert.deepEqual(result.output, { score: 91, action: 'disconnect_call' });
  assert.equal(commandExecutions, 0);
  assert.equal(result.profile_id, 'model-cloud');
  assert.equal(result.provider_version, 'sglang-compatible-v1');
  assert.equal(result.provider_request_id, 'model_request');
  assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 18 });
  assert.deepEqual(result.metadata, { region: 'ap-southeast' });
  const request = JSON.parse(String(requests[0]?.init?.body));
  assert.deepEqual(request.output_schema, validInput().output_schema);
  assert.equal(request.idempotency_key, 'model-a');
});

test('model gateway rejects schema mismatches and remote refs as terminal safe errors', async () => {
  const mismatch = createHttpModelGatewayProvider({
    mode: 'self_hosted', baseUrl: 'http://model-worker:8080',
    fetch: async () => jsonResponse({ output: { score: 'high', action: 'review' } })
  });
  await assert.rejects(
    () => mismatch.generate(validInput()),
    (error: unknown) => error instanceof ModelGatewayProviderError
      && error.code === 'provider_schema_mismatch'
      && error.retryable === false
  );

  let calls = 0;
  const guarded = createHttpModelGatewayProvider({
    mode: 'self_hosted', baseUrl: 'http://model-worker:8080',
    fetch: async () => { calls += 1; return jsonResponse({ output: {} }); }
  });
  await assert.rejects(
    () => guarded.generate({
      ...validInput(),
      output_schema: { $ref: 'https://attacker.example/schema.json' }
    }),
    (error: unknown) => (error as ModelGatewayProviderError).code === 'model_schema_invalid'
  );
  assert.equal(calls, 0);
});

test('model gateway propagates AbortSignal and bounds provider responses', async () => {
  const caller = new AbortController();
  let downstreamAborted = false;
  const provider = createHttpModelGatewayProvider({
    mode: 'self_hosted', baseUrl: 'http://model-worker:8080', timeoutMs: 5_000,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        downstreamAborted = true;
        reject(new Error('private provider error'));
      }, { once: true });
    })
  });
  const pending = provider.generate({ ...validInput(), signal: caller.signal });
  caller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => (error as ModelGatewayProviderError).code === 'provider_cancelled'
  );
  assert.equal(downstreamAborted, true);

  const oversized = createHttpModelGatewayProvider({
    mode: 'self_hosted', baseUrl: 'http://model-worker:8080',
    fetch: async () => jsonResponse({ output: {} }, { 'content-length': '2097153' })
  });
  await assert.rejects(
    () => oversized.generate(validInput()),
    (error: unknown) => (error as ModelGatewayProviderError).code === 'provider_response_too_large'
  );
});

function validInput() {
  return {
    tenant_id: 'tenant-a', interaction_id: 'interaction-a', task: 'quality_review',
    input: { transcript_ref: 'ivekit://transcript/final-a', rule_ids: ['phone-number'] },
    output_schema: {
      type: 'object', additionalProperties: false, required: ['score', 'action'],
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        action: { type: 'string', enum: ['pass', 'review', 'disconnect_call'] }
      }
    },
    model_hint: 'quality-low-latency', temperature: 0, max_output_tokens: 256,
    idempotency_key: 'model-a'
  };
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}
