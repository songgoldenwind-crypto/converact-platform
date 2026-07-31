import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { createRuntimeContext, advanceSingleStep } from '../src/agent-runtime/ivr/ivr-executor.js';
import {
  resolveMenuRoute,
  handleMenuStep,
  resolveMenuInput,
  handleInvalidDigit,
} from '../src/agent-runtime/ivr/ivr-menu-handler.js';

function menuGraph(opts: { routeType: string; routeTarget: string; withDigitEdge?: boolean }): IvrFlowGraph {
  const edges = [
    { id: 'et', source: 'm1', target: 'tout', sourceHandle: 'timeout' },
    { id: 'ei', source: 'm1', target: 'inv', sourceHandle: 'invalid' },
    { id: 'em', source: 'm1', target: 'maxr', sourceHandle: 'max_retries' },
  ];
  if (opts.withDigitEdge) {
    edges.push({ id: 'e1', source: 'm1', target: 'play_node', sourceHandle: 'digit_1' });
  }
  return {
    version: 1,
    entryNodeId: 'm1',
    variables: [],
    nodes: [
      {
        id: 'm1', type: 'menu', name: '主菜单', position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: '菜单' }],
          options: [{ digit: '1', label: '销售', routeType: opts.routeType, routeTarget: opts.routeTarget }],
          timeoutSec: 5, maxRetries: 3, maxInvalidRetries: 2,
        },
      },
      { id: 'play_node', type: 'play', name: '图', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'x' }] } },
      { id: 'tout', type: 'play', name: '超时', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 't' }] } },
      { id: 'inv', type: 'play', name: '无效', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'i' }] } },
      { id: 'maxr', type: 'play', name: '超限', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'm' }] } },
    ],
    edges,
  };
}

test('routeType queue → queue action without digit_1 edge', async () => {
  const graph = menuGraph({ routeType: 'queue', routeTarget: 'sales' });
  const ctx = createRuntimeContext(graph);
  const step = await advanceSingleStep(ctx, { dtmf: '1' });
  assert.equal(step.action?.kind, 'queue');
  assert.equal((step.action as { queueName: string }).queueName, 'sales');
});

test('routeType agent → transfer agent_ring_all', async () => {
  const graph = menuGraph({ routeType: 'agent', routeTarget: 'seat-001' });
  const step = await advanceSingleStep(createRuntimeContext(graph), { dtmf: '1' });
  assert.equal(step.action?.kind, 'transfer');
  assert.equal((step.action as { targetType: string }).targetType, 'agent_ring_all');
});

test('routeType group_call → memberSeatIds populated', async () => {
  const graph = menuGraph({ routeType: 'group_call', routeTarget: 'gc-1' });
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    dtmf: '1',
    groupCallResolver: () => ['s1', 's2'],
  });
  assert.deepEqual((step.action as { memberSeatIds?: string[] }).memberSeatIds, ['s1', 's2']);
});

test('routeType node → uses digit_1 edge', async () => {
  const graph = menuGraph({ routeType: 'node', routeTarget: '', withDigitEdge: true });
  const step = await advanceSingleStep(createRuntimeContext(graph), { dtmf: '1' });
  assert.equal(step.nextNodeId, 'play_node');
});

test('routeType queue wins over digit_1 edge when both exist', async () => {
  const graph = menuGraph({ routeType: 'queue', routeTarget: 'sales', withDigitEdge: true });
  const step = await advanceSingleStep(createRuntimeContext(graph), { dtmf: '1' });
  assert.equal(step.action?.kind, 'queue');
});

test('invalid digit 9 → invalid edge', async () => {
  const graph = menuGraph({ routeType: 'node', routeTarget: '', withDigitEdge: true });
  const step = await advanceSingleStep(createRuntimeContext(graph), { dtmf: '9' });
  assert.equal(step.nextNodeId, 'inv');
});

test('invalid twice → max_retries edge', async () => {
  const graph = menuGraph({ routeType: 'node', routeTarget: '', withDigitEdge: true });
  const invalidLoop = graph.edges.find((e) => e.sourceHandle === 'invalid');
  if (invalidLoop) invalidLoop.target = 'm1';

  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, { dtmf: '9' })).context;
  const step = await advanceSingleStep(ctx, { dtmf: '9' });
  assert.equal(step.nextNodeId, 'maxr');
});

test('timeout → timeout edge', async () => {
  const graph = menuGraph({ routeType: 'queue', routeTarget: 'sales' });
  const step = await advanceSingleStep(createRuntimeContext(graph), { timedOut: true });
  assert.equal(step.nextNodeId, 'tout');
});

test('routeType queue with empty routeTarget → invalid', () => {
  const node = menuGraph({ routeType: 'queue', routeTarget: '' }).nodes[0];
  const r = resolveMenuRoute(menuGraph({ routeType: 'queue', routeTarget: '' }), node, '1');
  assert.equal(r.mode, 'invalid');
});

test('unit: handleMenuStep sets last_digit variable', () => {
  const graph = menuGraph({ routeType: 'node', routeTarget: '', withDigitEdge: true });
  const node = graph.nodes[0];
  const r = handleMenuStep(graph, node, createRuntimeContext(graph), { dtmf: '1' });
  assert.equal(r.variables.last_digit, '1');
});
