import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { LlmEndpointConfig } from '../src/agent-runtime/integrations/llm-config.js';
import {
  completeWithLlmFallback,
  httpStatusFromError,
  isLlmTransportError,
} from '../src/agent-runtime/integrations/llm-provider.js';

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const primary: LlmEndpointConfig = {
  apiKey: 'pk',
  baseUrl: 'http://primary/v1',
  model: 'primary-model',
  maxTokens: 100,
  timeoutMs: 5000,
};

const fallback: LlmEndpointConfig = {
  apiKey: 'fk',
  baseUrl: 'http://fallback/v1',
  model: 'fallback-model',
  maxTokens: 100,
  timeoutMs: 5000,
};

test('httpStatusFromError prefers statusCode then status', () => {
  assert.equal(httpStatusFromError({ statusCode: 422 }), 422);
  const err = new Error('auth') as Error & { status?: number };
  err.status = 401;
  assert.equal(httpStatusFromError(err), 401);
  assert.equal(httpStatusFromError(new Error('network')), 502);
});

test('isLlmTransportError: 503 true', () => {
  const err = new Error('service unavailable') as Error & { status?: number };
  err.status = 503;
  assert.equal(isLlmTransportError(err), true);
});

test('primary 503 then fallback succeeds', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('primary')) {
      return new Response('unavailable', { status: 503 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'from fallback' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  try {
    const result = await completeWithLlmFallback(
      { messages: [{ role: 'user', content: 'x' }] },
      { primary, fallback }
    );
    assert.equal(result.text, 'from fallback');
    assert.equal(result.llmTier, 'fallback');
    assert.equal(result.model, 'fallback-model');
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Primary LLM \(primary-model\) unavailable/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('primary 401 does not fallback', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('primary')) {
      return new Response('unauthorized', { status: 401 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  try {
    await assert.rejects(
      () =>
        completeWithLlmFallback({ messages: [{ role: 'user', content: 'x' }] }, { primary, fallback }),
      /401/
    );
    assert.equal(fetchMock.mock.callCount(), 1);
  } finally {
    fetchMock.mock.restore();
  }
});

test('DISABLE_AI_SCRIPT_GENERATION=true throws', async () => {
  setEnv('DISABLE_AI_SCRIPT_GENERATION', 'true');
  await assert.rejects(
    () =>
      completeWithLlmFallback({ messages: [{ role: 'user', content: 'x' }] }, { primary, fallback }),
    /DISABLE_AI_SCRIPT_GENERATION/
  );
});
