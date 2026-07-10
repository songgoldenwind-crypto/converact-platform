import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function webhookGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'wh1',
    variables: [],
    nodes: [
      { id: 'wh1', type: 'webhook', name: 'WH', position: { x: 0, y: 0 }, data: { url: 'https://example.com/hook', method: 'POST', eventType: 'test' } },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'fail', type: 'play', name: 'Fail', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
      { id: 'to', type: 'play', name: 'Timeout', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'to' }] } },
    ],
    edges: [
      { id: 'e1', source: 'wh1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'wh1', target: 'fail', sourceHandle: 'fail' },
      { id: 'e3', source: 'wh1', target: 'to', sourceHandle: 'timeout' },
    ],
  };
}

test('webhook: 200 → success edge node', async () => {
  const step = await advanceSingleStep(createRuntimeContext(webhookGraph()), {
    sideEffects: {
      executeWebhook: async () => ({ success: true, statusCode: 200 }),
    },
  });
  assert.equal(step.nextNodeId, 'ok');
  assert.equal(step.context.variables.last_branch_handle, 'success');
});

test('webhook: 500 → fail edge node', async () => {
  const step = await advanceSingleStep(createRuntimeContext(webhookGraph()), {
    sideEffects: {
      executeWebhook: async () => ({ success: false, statusCode: 500, error: 'server_error' }),
    },
  });
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.last_error, 'server_error');
  assert.equal(step.context.variables.last_branch_handle, 'fail');
});

test('webhook: timeout → timeout edge when present', async () => {
  const step = await advanceSingleStep(createRuntimeContext(webhookGraph()), {
    sideEffects: {
      executeWebhook: async () => ({ success: false, statusCode: 0, error: 'timeout' }),
    },
  });
  assert.equal(step.nextNodeId, 'to');
  assert.equal(step.context.variables.last_branch_handle, 'timeout');
});

test('webhook: timeout → fail edge when no timeout edge', async () => {
  const graph = webhookGraph();
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'timeout');
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: {
      executeWebhook: async () => ({ success: false, statusCode: 0, error: 'timeout' }),
    },
  });
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.last_branch_handle, 'fail');
});

test('http: timeout → timeout edge when present', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: 'https://api.test', timeoutSec: 5 } },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'fail', type: 'play', name: 'Fail', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
      { id: 'to', type: 'play', name: 'To', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'to' }] } },
    ],
    edges: [
      { id: 'e1', source: 'h1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'h1', target: 'fail', sourceHandle: 'fail' },
      { id: 'e3', source: 'h1', target: 'to', sourceHandle: 'timeout' },
    ],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeHttp: async () => ({ success: false, statusCode: 0, error: 'timeout' }) },
  });
  assert.equal(step.nextNodeId, 'to');
  assert.equal(step.context.variables.last_branch_handle, 'timeout');
  assert.equal(step.context.variables.http_status, '0');
});

test('http: timeout → fail when no timeout edge', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: 'https://api.test', timeoutSec: 5 } },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'fail', type: 'play', name: 'Fail', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
    ],
    edges: [
      { id: 'e1', source: 'h1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'h1', target: 'fail', sourceHandle: 'fail' },
    ],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeHttp: async () => ({ success: false, statusCode: 0, error: 'timeout' }) },
  });
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.last_branch_handle, 'fail');
});

test('http: timeout with no timeout and no fail edge → _branch_miss', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: 'https://api.test', timeoutSec: 5 } },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'h1', target: 'ok', sourceHandle: 'success' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeHttp: async () => ({ success: false, statusCode: 0, error: 'timeout' }) },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, 'fail');
  assert.equal(step.context.variables._branch_miss, 'h1:fail');
});

test('http: success and fail branches', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'h1',
    variables: [],
    nodes: [
      { id: 'h1', type: 'http', name: 'HTTP', position: { x: 0, y: 0 }, data: { method: 'GET', url: 'https://api.test', timeoutSec: 5 } },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'fail', type: 'play', name: 'Fail', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
    ],
    edges: [
      { id: 'e1', source: 'h1', target: 'ok', sourceHandle: 'success' },
      { id: 'e2', source: 'h1', target: 'fail', sourceHandle: 'fail' },
    ],
  };
  const ok = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeHttp: async () => ({ success: true, statusCode: 200 }) },
  });
  assert.equal(ok.nextNodeId, 'ok');
  assert.equal(ok.context.variables.last_branch_handle, 'success');

  const bad = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeHttp: async () => ({ success: false, statusCode: 503, error: 'down' }) },
  });
  assert.equal(bad.nextNodeId, 'fail');
  assert.equal(bad.context.variables.last_branch_handle, 'fail');
});
