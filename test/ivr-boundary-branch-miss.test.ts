/**
 * P1 — `_branch_miss` 在缺出边时全节点一致性。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';
import { applyBranchRoute } from '../src/agent-runtime/ivr/ivr-branch-vars.js';

test('applyBranchRoute: missing target sets _branch_miss', () => {
  const vars = applyBranchRoute({}, 'n1', 'timeout', null);
  assert.equal(vars.last_branch_handle, 'timeout');
  assert.equal(vars._branch_miss, 'n1:timeout');
});

test('applyBranchRoute: present target does not set _branch_miss', () => {
  const vars = applyBranchRoute({}, 'n1', 'out', 'next');
  assert.equal(vars.last_branch_handle, 'out');
  assert.equal(vars._branch_miss, undefined);
});

test('menu invalid without edge → _branch_miss', async () => {
  const graph: IvrFlowGraph = {
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
          prompt: [{ playType: 'tts', text: 'm' }],
          options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
        },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' }],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { dtmf: '9' });
  assert.equal(step.context.variables._branch_miss, `m1:${IVR_BRANCH.INVALID}`);
});

test('webhook success without edge → _branch_miss', async () => {
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
  assert.equal(step.context.variables._branch_miss, `wh1:${IVR_BRANCH.SUCCESS}`);
});

test('queue connected without out edge → _branch_miss', async () => {
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
      callSessionId: 'c1',
    })
  ).context;
  const step = await advanceSingleStep(ctx, {
    queueEvent: { kind: 'connected', agentId: 'a1' },
  });
  assert.equal(step.context.variables._branch_miss, `q1:${IVR_BRANCH.OUT}`);
});
