import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IVR_NODE_DEFINITIONS,
  createDefaultIvrGraph,
  createIvrNode,
  ivrNodeOutputHandles,
  parseImportedIvrGraph,
  toCanvasGraph,
  toIvrFlowGraph
} from './ivr-designer-model.js';

test('IVR designer declares all 25 runtime node types exactly once', () => {
  assert.equal(IVR_NODE_DEFINITIONS.length, 25);
  assert.equal(new Set(IVR_NODE_DEFINITIONS.map((item) => item.type)).size, 25);
  assert.deepEqual(
    IVR_NODE_DEFINITIONS.map((item) => item.type).sort(),
    [
      'ai_dialogue', 'avatar_switch', 'collect', 'compliance', 'condition', 'disconnect',
      'flush_audio', 'http', 'intent', 'knowledge_qa', 'menu', 'play', 'queue', 'recording',
      'screen_share', 'set_var', 'sip', 'start', 'subflow', 'time_condition', 'transfer',
      'video_play', 'visual_menu', 'voicemail', 'webhook'
    ]
  );
});

test('IVR designer creates a useful two-node draft and preserves graph data through canvas conversion', () => {
  const graph = createDefaultIvrGraph();
  assert.equal(graph.entryNodeId, 'start');
  assert.deepEqual(graph.nodes.map((node) => node.type), ['start', 'disconnect']);
  assert.deepEqual(graph.edges.map((edge) => edge.sourceHandle), ['out']);

  graph.variables = [{ name: 'customer_tier', defaultValue: 'standard' }];
  graph.globalShortcuts = [{ digit: '*', action: 'repeat_last' }];
  const roundTrip = toIvrFlowGraph(toCanvasGraph(graph), graph);
  assert.deepEqual(roundTrip, graph);
});

test('IVR designer gives dynamic menus exact branch handles', () => {
  const menu = createIvrNode('menu', { x: 200, y: 80 }, 'menu-a');
  menu.data.options = [{ digit: '1', label: 'Sales' }, { digit: '#', label: 'Operator' }];
  assert.deepEqual(ivrNodeOutputHandles(menu), [
    'digit_1', 'digit_#', 'timeout', 'invalid', 'max_retries'
  ]);
  const visual = createIvrNode('visual_menu', { x: 0, y: 0 }, 'visual-a');
  visual.data.items = [{ digit: '2', label: 'Support' }];
  assert.deepEqual(ivrNodeOutputHandles(visual), ['digit_2', 'timeout', 'invalid']);
});

test('IVR designer exposes optional success and failure branches used by the runtime', () => {
  assert.deepEqual(ivrNodeOutputHandles(createIvrNode('play', { x: 0, y: 0 })), ['out', 'error']);
  assert.deepEqual(ivrNodeOutputHandles(createIvrNode('transfer', { x: 0, y: 0 })), ['out', 'failed']);
  assert.deepEqual(ivrNodeOutputHandles(createIvrNode('sip', { x: 0, y: 0 })), ['out', 'failed']);
  assert.deepEqual(ivrNodeOutputHandles(createIvrNode('voicemail', { x: 0, y: 0 })), ['out', 'failed']);
  assert.deepEqual(ivrNodeOutputHandles(createIvrNode('recording', { x: 0, y: 0 })), ['out', 'skipped', 'error']);
});

test('IVR designer import validates the provider-neutral graph envelope', () => {
  const graph = createDefaultIvrGraph();
  assert.deepEqual(parseImportedIvrGraph(JSON.stringify(graph)), graph);
  assert.throws(
    () => parseImportedIvrGraph(JSON.stringify({ ...graph, nodes: [
      { ...graph.nodes[0], type: 'shell_command' }
    ] })),
    /unsupported IVR node type/
  );
  assert.throws(() => parseImportedIvrGraph('{'), /invalid IVR graph JSON/);
});
