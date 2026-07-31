import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
  simulateIvrFlow,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const menuGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
    { id: 'menu1', type: 'menu', name: 'M', position: { x: 200, y: 0 }, data: {
      prompt: [{ playType: 'tts', text: 'press 1' }],
      options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
    } },
    { id: 't1', type: 'transfer', name: 'T', position: { x: 400, y: 0 }, data: { targetType: 'queue', targetValue: 'q' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'menu1', sourceHandle: 'out' },
    { id: 'e2', source: 'menu1', target: 't1', sourceHandle: 'digit_1' },
  ],
  variables: [],
};

test('menu Presenting sets interaction.awaiting and stays on node', async () => {
  let ctx = createRuntimeContext(menuGraph);
  ctx = (await advanceSingleStep(ctx, {})).context; // start → menu1
  const presenting = await advanceSingleStep(ctx, {});
  assert.equal(presenting.context.interaction?.awaiting, true);
  assert.equal(presenting.context.interaction?.kind, 'menu');
  assert.equal(presenting.context.currentNodeId, 'menu1');
  assert.equal(presenting.action.kind, 'menu');
});

test('menu Consuming clears interaction and routes digit', async () => {
  let ctx = createRuntimeContext(menuGraph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  const consuming = await advanceSingleStep(ctx, { dtmf: '1' });
  assert.equal(consuming.context.interaction, undefined);
  assert.equal(consuming.context.currentNodeId, 't1');
});

test('play enqueues and walks to menu without pendingAdvanceNodeId', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'p1', type: 'play', name: 'P', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'hi' }] } },
      { id: 'm1', type: 'menu', name: 'M', position: { x: 200, y: 0 }, data: { prompt: [{ playType: 'tts', text: 'm' }], options: [] } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'p1', sourceHandle: 'out' },
      { id: 'e2', source: 'p1', target: 'm1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const play = await advanceSingleStep(ctx, {});
  assert.equal(play.action.kind, 'menu');
  assert.equal(play.context.currentNodeId, 'm1');
  assert.equal(play.context.audioQueue?.length ?? 0, 0);
  assert.equal(play.context.pendingAdvanceNodeId, undefined);
});

test('play no longer requires playCompleted to reach menu', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    nodes: [
      { id: 'p1', type: 'play', name: 'P', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'hi' }] } },
      { id: 'm1', type: 'menu', name: 'M', position: { x: 100, y: 0 }, data: { prompt: [{ playType: 'tts', text: 'm' }], options: [] } },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'x' } },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'm1', sourceHandle: 'out' }],
    variables: [],
  };
  const stepped = await advanceSingleStep(createRuntimeContext(graph), {});
  assert.equal(stepped.context.currentNodeId, 'm1');
  assert.equal(stepped.context.pendingAdvanceNodeId, undefined);
});

test('simulate: menu two-phase before transfer', async () => {
  const result = await simulateIvrFlow(menuGraph, { dtmfSequence: ['1'] });
  const menuSteps = result.steps.filter((s) => s.nodeType === 'menu');
  assert.equal(menuSteps.length, 2);
  assert.equal(result.terminated, true);
});
