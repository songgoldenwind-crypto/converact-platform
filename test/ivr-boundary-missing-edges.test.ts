/**
 * P0 — 缺出边运行时边界：nextNodeId / last_branch_handle / 降级行为。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';

function minimalMenuGraph(edges: IvrFlowGraph['edges']): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'm1',
    variables: [],
    nodes: [
      {
        id: 'm1',
        type: 'menu',
        name: 'M',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'menu' }],
          options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
          maxInvalidRetries: 3,
        },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'q' } },
      { id: 'inv', type: 'play', name: 'Inv', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'inv' }] } },
    ],
    edges,
  };
}

async function advanceMenuConsuming(
  graph: IvrFlowGraph,
  input: { dtmf?: string; timedOut?: boolean }
) {
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  return advanceSingleStep(ctx, input);
}

test('menu: timedOut without timeout edge → null target but records timeout branch', async () => {
  const graph = minimalMenuGraph([
    { id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
  ]);
  const step = await advanceMenuConsuming(graph, { timedOut: true });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.TIMEOUT);
});

test('menu: invalid without invalid edge → null target, invalid branch', async () => {
  const graph = minimalMenuGraph([
    { id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
  ]);
  const step = await advanceMenuConsuming(graph, { dtmf: '9' });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.INVALID);
});

test('collect: max_retries exhausted without max_retries or timeout edge → null', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'collect',
        name: 'C',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'enter' }],
          minDigits: 4,
          maxDigits: 4,
          endMode: 'hash_key',
          storeVariable: 'x',
          verifyMode: 'none',
          maxRetries: 1,
        },
      },
      { id: 'bad', type: 'play', name: 'Bad', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'bad' }] } },
    ],
    edges: [{ id: 'e1', source: 'c1', target: 'bad', sourceHandle: 'invalid' }],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '12#' });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.MAX_RETRIES);
});

test('collect: invalid input without invalid edge → _branch_miss', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'collect',
        name: 'C',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'enter' }],
          minDigits: 4,
          maxDigits: 4,
          endMode: 'hash_key',
          storeVariable: 'x',
          verifyMode: 'none',
          maxRetries: 3,
        },
      },
      { id: 'ok', type: 'play', name: 'Ok', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'c1', target: 'ok', sourceHandle: 'out' }],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '12#' });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.INVALID);
  assert.equal(step.context.variables._branch_miss, 'c1:invalid');
});

test('webhook: success without success edge → null target, success branch recorded', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'wh1',
    variables: [],
    nodes: [
      { id: 'wh1', type: 'webhook', name: 'WH', position: { x: 0, y: 0 }, data: { url: 'https://x', method: 'POST', eventType: 't' } },
      { id: 'fail', type: 'play', name: 'F', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'f' }] } },
    ],
    edges: [{ id: 'e1', source: 'wh1', target: 'fail', sourceHandle: 'fail' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: { executeWebhook: async () => ({ success: true, statusCode: 200 }) },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.SUCCESS);
  assert.equal(step.context.variables.webhook_status, '200');
});

test('queue: connected event without out edge → null target, out branch', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'q1',
    variables: [],
    nodes: [
      { id: 'q1', type: 'queue', name: 'Q', position: { x: 0, y: 0 }, data: { queueName: 'sales', strategy: 'fifo', timeoutSec: 300 } },
      { id: 'tout', type: 'play', name: 'T', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'to' }] } },
    ],
    edges: [{ id: 'e1', source: 'q1', target: 'tout', sourceHandle: 'timeout' }],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (
    await advanceSingleStep(ctx, {
      acdEnqueue: async () => ({ status: 'pending', queueEntryId: 'e1' }),
      callSessionId: 'call-1',
    })
  ).context;
  const step = await advanceSingleStep(ctx, {
    queueEvent: { kind: 'connected', agentId: 'agent-1' },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.OUT);
  assert.equal(step.context.variables.agent_id, 'agent-1');
});

test('queue: queueEvent error without error edge → null target, error branch', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'q1',
    variables: [],
    nodes: [
      { id: 'q1', type: 'queue', name: 'Q', position: { x: 0, y: 0 }, data: { queueName: 'sales', strategy: 'fifo', timeoutSec: 300 } },
      { id: 'out', type: 'transfer', name: 'O', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
    ],
    edges: [{ id: 'e1', source: 'q1', target: 'out', sourceHandle: 'out' }],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (
    await advanceSingleStep(ctx, {
      acdEnqueue: async () => ({ status: 'pending', queueEntryId: 'e1' }),
      callSessionId: 'call-1',
    })
  ).context;
  const step = await advanceSingleStep(ctx, {
    queueEvent: { kind: 'error', reason: 'acd_disconnect' },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, IVR_BRANCH.ERROR);
  assert.equal(step.context.variables.queue_result, 'error');
  assert.equal(step.context.variables.last_error, 'acd_disconnect');
});
