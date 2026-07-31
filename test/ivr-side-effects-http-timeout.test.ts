/**
 * P2 — defaultSideEffects.executeHttp maps fetch AbortError → error: 'timeout'.
 */
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { defaultSideEffects } from '../src/agent-runtime/ivr/ivr-side-effects.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function hangingFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    const signal = init?.signal;
    if (!signal) {
      reject(new Error('expected AbortSignal'));
      return;
    }
    if (signal.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
}

test('executeHttp: AbortError → timeout error field', async () => {
  globalThis.fetch = hangingFetch as typeof fetch;
  const result = await defaultSideEffects.executeHttp!(
    { method: 'GET', url: 'https://example.com/slow', timeoutSec: 0.01 },
    {}
  );
  assert.equal(result.success, false);
  assert.equal(result.error, 'timeout');
  assert.equal(result.statusCode, 0);
});

test('executeHttp timeout routes through advanceSingleStep to timeout edge', async () => {
  globalThis.fetch = hangingFetch as typeof fetch;
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: 'https://api.test/x', timeoutSec: 0.01 } },
      { id: 'to', type: 'play', name: 'To', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'to' }] } },
    ],
    edges: [{ id: 'e1', source: 'h1', target: 'to', sourceHandle: 'timeout' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: defaultSideEffects,
  });
  assert.equal(step.nextNodeId, 'to');
  assert.equal(step.context.variables.last_branch_handle, 'timeout');
  assert.equal(step.context.variables.http_status, '0');
});
