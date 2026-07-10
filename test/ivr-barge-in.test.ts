import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
  simulateIvrFlow,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const bargeGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
    { id: 'p1', type: 'play', name: 'P', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'long prompt' }], bargeIn: true } },
    {
      id: 'm1',
      type: 'menu',
      name: 'M',
      position: { x: 200, y: 0 },
      data: {
        prompt: [{ playType: 'tts', text: 'menu' }],
        options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
        timeoutSec: 5,
        maxRetries: 3,
      },
    },
    { id: 't1', type: 'transfer', name: 'T', position: { x: 300, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'p1', sourceHandle: 'out' },
    { id: 'e2', source: 'p1', target: 'm1', sourceHandle: 'out' },
    { id: 'e3', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
    { id: 'e4', source: 'm1', target: 't1', sourceHandle: 'timeout' },
    { id: 'e5', source: 'm1', target: 't1', sourceHandle: 'invalid' },
    { id: 'e6', source: 'm1', target: 't1', sourceHandle: 'max_retries' },
  ],
  variables: [],
};

test('interruptible play enqueues segment with interruptible flag on menu prompt_queue', async () => {
  let ctx = createRuntimeContext(bargeGraph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const menu = await advanceSingleStep(ctx, {});
  assert.equal(menu.action.kind, 'menu');
  if (menu.action.kind === 'menu') {
    assert.equal(menu.action.promptQueue?.[0]?.interruptible, true);
  }
});

test('bargeInDigits during queued gather clears queue and sets pendingDigits', async () => {
  let ctx = createRuntimeContext(bargeGraph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  const barged = await advanceSingleStep(ctx, { bargeInDigits: '1' });
  assert.equal(barged.context.pendingDigits, '1');
  assert.equal(barged.context.audioQueue?.length ?? 0, 0);
  assert.equal(barged.context.currentNodeId, 'm1');
});

test('pendingDigits consumed by next menu without second gather input', async () => {
  let ctx = createRuntimeContext(bargeGraph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, { bargeInDigits: '1' })).context;
  const routed = await advanceSingleStep(ctx, {});
  assert.equal(routed.context.currentNodeId, 't1');
  assert.equal(routed.context.pendingDigits, undefined);
});

test('non-interruptible play: menu prompt_queue segments not interruptible', async () => {
  const graph: IvrFlowGraph = {
    ...bargeGraph,
    nodes: bargeGraph.nodes.map((n) =>
      n.id === 'p1' ? { ...n, data: { contents: [{ playType: 'tts', text: 'x' }], bargeIn: false } } : n
    ),
  };
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const menu = await advanceSingleStep(ctx, {});
  assert.equal(menu.action.kind, 'menu');
  if (menu.action.kind === 'menu') {
    assert.equal(menu.action.promptQueue?.[0]?.interruptible, false);
  }
});

test('rwi gather_digits prompt_queue includes interruptible on queued segment', async () => {
  let ctx = createRuntimeContext(bargeGraph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const menu = await advanceSingleStep(ctx, {});
  const rwi = ivrActionToRwi(menu.action, 'call-1');
  assert.equal(rwi?.command, 'gather_digits');
  const queue = (rwi?.params as { prompt_queue?: Array<{ interruptible?: boolean }> }).prompt_queue;
  assert.equal(queue?.[0]?.interruptible, true);
});

test('simulate barge-in skips menu presenting when digit buffered', async () => {
  const result = await simulateIvrFlow(bargeGraph, { dtmfSequence: ['1'] });
  assert.equal(result.terminated, true);
  assert.ok(result.steps.some((s) => s.nodeType === 'menu'));
});
