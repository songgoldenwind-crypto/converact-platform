import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { validateFlowGraphDetailed } from '../src/agent-runtime/ivr/ivr-types.js';
import { createRuntimeContext, advanceSingleStep } from '../src/agent-runtime/ivr/ivr-executor.js';
import {
  tryConsumeGlobalShortcut,
} from '../src/agent-runtime/ivr/ivr-global-shortcuts.js';

function menuWithShortcutGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'm1',
    variables: [],
    globalShortcuts: [{ digit: '*', action: 'transfer_queue', queueName: 'operator' }],
    nodes: [
      {
        id: 'm1',
        type: 'menu',
        name: '主菜单',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: '按1销售' }],
          options: [
            { digit: '1', label: '销售', routeType: 'node', routeTarget: '' },
            { digit: '*', label: '星号', routeType: 'queue', routeTarget: 'sales' },
          ],
          timeoutSec: 5,
          maxRetries: 3,
        },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
      { id: 'p1', type: 'play', name: 'P', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'prev' }] } },
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
    ],
  };
}

test('shortcut * during menu Consuming preempts menu digit route', async () => {
  const graph = menuWithShortcutGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  assert.equal(ctx.interaction?.awaiting, true);

  const step = await advanceSingleStep(ctx, { dtmf: '*' });
  assert.equal(step.action.kind, 'queue');
  if (step.action.kind === 'queue') {
    assert.equal(step.action.queueName, 'operator');
  }
  assert.equal(step.context.interaction, undefined);
});

test('transfer_queue shortcut returns queue action', () => {
  const graph = menuWithShortcutGraph();
  const ctx = createRuntimeContext(graph);
  const r = tryConsumeGlobalShortcut(graph, ctx, '*');
  assert.equal(r.handled, true);
  assert.equal(r.action?.kind, 'queue');
});

test('repeat_last without lastPromptNodeId → not handled', () => {
  const graph: IvrFlowGraph = {
    ...menuWithShortcutGraph(),
    globalShortcuts: [{ digit: '9', action: 'repeat_last' }],
  };
  const ctx = createRuntimeContext(graph);
  const r = tryConsumeGlobalShortcut(graph, ctx, '9');
  assert.equal(r.handled, false);
});

test('repeat_last with lastPromptNodeId → replay target', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    globalShortcuts: [{ digit: '9', action: 'repeat_last' }],
    nodes: [
      {
        id: 'c1',
        type: 'collect',
        name: 'C',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'input' }],
          minDigits: 4,
          maxDigits: 6,
          storeVariable: 'pin',
        },
      },
      { id: 'p1', type: 'play', name: 'P', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'prev' }] } },
    ],
    edges: [],
  };
  let ctx = createRuntimeContext(graph);
  ctx = { ...ctx, lastPromptNodeId: 'p1', interaction: { nodeId: 'c1', kind: 'collect', awaiting: true } };
  const step = await advanceSingleStep(ctx, { dtmf: '9' });
  assert.equal(step.nextNodeId, 'p1');
  assert.equal(step.context.playQueueIndex, undefined);
});

test('goto_node valid id → navigates', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    globalShortcuts: [{ digit: '0', action: 'goto_node', targetNodeId: 'm1' }],
    nodes: [
      { id: 'p1', type: 'play', name: 'P', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'x' }] } },
      {
        id: 'm1',
        type: 'menu',
        name: 'M',
        position: { x: 100, y: 0 },
        data: { prompt: [{ playType: 'tts', text: 'm' }], options: [] },
      },
    ],
    edges: [],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { dtmf: '0' });
  assert.equal(step.nextNodeId, 'm1');
});

test('goto_node invalid id → not handled, stay on node', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    globalShortcuts: [{ digit: '0', action: 'goto_node', targetNodeId: 'missing' }],
    nodes: [
      { id: 'p1', type: 'play', name: 'P', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'x' }] } },
    ],
    edges: [],
  };
  const ctx = createRuntimeContext(graph);
  const step = await advanceSingleStep(ctx, { dtmf: '0' });
  assert.equal(step.context.currentNodeId, 'p1');
});

test('shortcut during collect Presenting ignored until Consuming', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    globalShortcuts: [{ digit: '9', action: 'repeat_last' }],
    nodes: [
      {
        id: 'c1',
        type: 'collect',
        name: 'C',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'pin' }],
          minDigits: 4,
          maxDigits: 6,
          storeVariable: 'pin',
        },
      },
      { id: 'p1', type: 'play', name: 'P', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'prev' }] } },
    ],
    edges: [],
  };
  let ctx = createRuntimeContext(graph);
  ctx = { ...ctx, lastPromptNodeId: 'p1' };
  const presenting = await advanceSingleStep(ctx, {});
  assert.equal(presenting.context.currentNodeId, 'c1');
  assert.equal(presenting.context.interaction?.awaiting, true);

  const consuming = await advanceSingleStep(
    { ...presenting.context, lastPromptNodeId: 'p1' },
    { dtmf: '9' }
  );
  assert.equal(consuming.nextNodeId, 'p1');
});

test('validateFlowGraphDetailed warns on global vs menu digit conflict', () => {
  const graph = menuWithShortcutGraph();
  const report = validateFlowGraphDetailed(graph);
  assert.ok(
    report.warnings.some((w) => w.message.includes('全局快捷键') && w.handle === 'digit_*')
  );
});
