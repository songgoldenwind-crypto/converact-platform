import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import {
  resolveMenuInput,
  handleInvalidDigit,
  handleMenuStep,
} from '../src/agent-runtime/ivr/ivr-menu-handler.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';

function menuNodeGraph(maxInvalidRetries = 2): IvrFlowGraph {
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
          maxInvalidRetries,
        },
      },
      { id: 'inv', type: 'play', name: 'I', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'bad' }] } },
      { id: 'maxr', type: 'play', name: 'X', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'max' }] } },
      { id: 'tout', type: 'play', name: 'T', position: { x: 300, y: 0 }, data: { contents: [{ playType: 'tts', text: 'to' }] } },
    ],
    edges: [
      { id: 'ei', source: 'm1', target: 'm1', sourceHandle: IVR_BRANCH.INVALID },
      { id: 'em', source: 'm1', target: 'maxr', sourceHandle: IVR_BRANCH.MAX_RETRIES },
      { id: 'et', source: 'm1', target: 'tout', sourceHandle: IVR_BRANCH.TIMEOUT },
    ],
  };
}

test('resolveMenuInput: timedOut takes precedence', () => {
  const node = menuNodeGraph().nodes[0];
  assert.equal(resolveMenuInput(node, { timedOut: true, dtmf: '1' }).kind, 'timeout');
});

test('resolveMenuInput: dtmf present returns digit', () => {
  const node = menuNodeGraph().nodes[0];
  const r = resolveMenuInput(node, { dtmf: '1' });
  assert.equal(r.kind, 'digit');
  if (r.kind === 'digit') assert.equal(r.digit, '1');
});

test('resolveMenuInput: speech unmatched → invalid when speechEnabled', () => {
  const node = {
    ...menuNodeGraph().nodes[0],
    data: {
      ...(menuNodeGraph().nodes[0].data as Record<string, unknown>),
      speechEnabled: true,
      speechAliases: [{ digit: '1', phrases: ['销售'] }],
    },
  };
  assert.equal(resolveMenuInput(node, { speechResult: '天气' }).kind, 'invalid');
});

test('handleInvalidDigit: first invalid increments counter and routes invalid', () => {
  const graph = menuNodeGraph(2);
  const node = graph.nodes[0];
  const ctx = createRuntimeContext(graph);
  const r = handleInvalidDigit(graph, node.id, ctx, node.data as { maxInvalidRetries: number });
  assert.equal(r.mode, 'invalid');
  assert.equal(r.retryCounters.m1?.invalid, 1);
});

test('handleInvalidDigit: threshold reached → max_retries', () => {
  const graph = menuNodeGraph(2);
  const node = graph.nodes[0];
  const ctx = createRuntimeContext(graph);
  ctx.retryCounters = { m1: { invalid: 1 } };
  const r = handleInvalidDigit(graph, node.id, ctx, node.data as { maxInvalidRetries: number });
  assert.equal(r.mode, 'max_retries');
  assert.equal(r.retryCounters.m1?.invalid, 2);
});

test('handleMenuStep: invalid twice on menu loops to max_retries edge', () => {
  const graph = menuNodeGraph(2);
  const node = graph.nodes[0];
  let ctx = createRuntimeContext(graph);
  const first = handleMenuStep(graph, node, ctx, { dtmf: '9' });
  assert.equal(first.branch, IVR_BRANCH.INVALID);
  assert.equal(first.retryCounters.m1?.invalid, 1);

  ctx = { ...ctx, retryCounters: first.retryCounters, currentNodeId: 'm1' };
  const second = handleMenuStep(graph, node, ctx, { dtmf: '9' });
  assert.equal(second.branch, IVR_BRANCH.MAX_RETRIES);
  assert.equal(second.nextNodeId, 'maxr');
});

test('advanceSingleStep: menu invalid records last_branch_handle', async () => {
  const graph = menuNodeGraph(2);
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const invalid = await advanceSingleStep(ctx, { dtmf: '9' });
  assert.equal(invalid.context.variables.last_branch_handle, IVR_BRANCH.INVALID);
  ctx = invalid.context;
  const maxRetries = await advanceSingleStep(ctx, { dtmf: '9' });
  assert.equal(maxRetries.context.variables.last_branch_handle, IVR_BRANCH.MAX_RETRIES);
  assert.equal(maxRetries.nextNodeId, 'maxr');
});
