import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  executeWebhookRequest,
  signWebhookBody,
} from '../src/agent-runtime/ivr/ivr-webhook-request.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

test('signWebhookBody: sha256 HMAC header value', () => {
  const body = '{"event":"test"}';
  const expected = createHmac('sha256', 'secret-key').update(body).digest('hex');
  assert.equal(signWebhookBody(body, 'secret-key'), `sha256=${expected}`);
});

test('executeWebhookRequest: adds X-OPC-Signature when hmacSecret set', async () => {
  let capturedHeaders: Record<string, string> = {};
  const mockFetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return new Response('ok', { status: 200 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const result = await executeWebhookRequest(
      {
        url: 'https://example.com/hook',
        method: 'POST',
        eventType: 'ivr.entered',
        hmacSecret: 'my-secret',
      },
      {}
    );
    assert.equal(result.success, true);
    const body = mockFetch.mock.calls[0]?.arguments[1]?.body as string;
    const expected = signWebhookBody(body, 'my-secret');
    assert.equal(capturedHeaders['X-OPC-Signature'], expected);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeWebhookRequest: async mode returns 202 without blocking on fetch', async () => {
  let resolveFetch: (() => void) | undefined;
  const fetchGate = new Promise<void>((r) => {
    resolveFetch = r;
  });
  const mockFetch = mock.fn(async () => {
    await fetchGate;
    return new Response('fail', { status: 500 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const started = Date.now();
    const result = await executeWebhookRequest(
      { url: 'https://example.com/hook', method: 'POST', eventType: 'x', async: true },
      {}
    );
    const elapsed = Date.now() - started;
    assert.equal(result.success, true);
    assert.equal(result.statusCode, 202);
    assert.ok(elapsed < 30, 'should not wait for slow fetch');
    assert.equal(mockFetch.mock.calls.length, 1);
    resolveFetch?.();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeWebhookRequest: retries on 500 then succeeds', async () => {
  let calls = 0;
  const mockFetch = mock.fn(async () => {
    calls++;
    if (calls < 3) return new Response('err', { status: 500 });
    return new Response('ok', { status: 200 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const result = await executeWebhookRequest(
      { url: 'https://example.com/hook', method: 'POST', eventType: 'x', retryCount: 3 },
      {}
    );
    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webhook async: executor routes success edge immediately', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'wh1',
    variables: [],
    nodes: [
      {
        id: 'wh1',
        type: 'webhook',
        name: 'WH',
        position: { x: 0, y: 0 },
        data: {
          url: 'https://example.com/hook',
          method: 'POST',
          eventType: 'test',
          async: true,
        },
      },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'fail', type: 'play', name: 'Fail', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
    ],
    edges: [
      { id: 'e1', source: 'wh1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'wh1', target: 'fail', sourceHandle: 'fail' },
    ],
  };

  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: {
      executeWebhook: async () => ({ success: true, statusCode: 202 }),
    },
  });
  assert.equal(step.nextNodeId, 'ok');
  assert.equal(step.context.variables.last_branch_handle, 'success');
});
