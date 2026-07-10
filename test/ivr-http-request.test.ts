import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { executeHttpRequest } from '../src/agent-runtime/ivr/ivr-http-request.js';
import { routeHttpBranch } from '../src/agent-runtime/ivr/ivr-io-branch-handler.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

test('executeHttpRequest: retries 500 then succeeds', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => {
    calls++;
    if (calls === 1) {
      return new Response('err', { status: 500 });
    }
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await executeHttpRequest(
      { url: 'https://example.com/api', method: 'GET', retryCount: 2 },
      {}
    );
    assert.equal(result.success, true);
    assert.equal(result.statusCode, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeHttpRequest: retries exhausted routes fail branch', async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(async () => {
    calls++;
    return new Response('err', { status: 503 });
  }) as typeof fetch;

  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'H', position: { x: 0, y: 0 }, data: { url: 'https://x', retryCount: 1 } },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'bad', type: 'play', name: 'Bad', position: { x: 200, y: 50 }, data: { contents: [{ playType: 'tts', text: 'bad' }] } },
    ],
    edges: [
      { id: 'e1', source: 'h1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'h1', target: 'bad', sourceHandle: 'fail' },
    ],
  };

  try {
    const result = await executeHttpRequest(
      { url: 'https://example.com/api', method: 'GET', retryCount: 1 },
      {}
    );
    assert.equal(result.success, false);
    assert.equal(result.statusCode, 503);
    assert.equal(calls, 2);

    const vars: Record<string, string> = {};
    const route = routeHttpBranch(graph, 'h1', result, vars);
    assert.equal(route.branch, IVR_BRANCH.FAIL);
    assert.equal(route.target, 'bad');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
