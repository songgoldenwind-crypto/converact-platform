import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulateIvrFlow, type IvrSimulationInput } from '../src/agent-runtime/ivr/ivr-executor.js';
import { validateFlowGraph, type IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';

/** A minimal flow: start → play("欢迎") → menu("按1销售/按2客服") → transfer */
const baseSampleGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
    { id: 'play1', type: 'play', name: '欢迎语', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: '欢迎致电{{公司名}}' }] } },
    { id: 'menu1', type: 'menu', name: '主菜单', position: { x: 400, y: 0 }, data: {
      prompt: [{ playType: 'tts', text: '按1销售，按2客服' }],
      options: [{ digit: '1', label: '销售', routeType: 'node', routeTarget: '' }, { digit: '2', label: '客服', routeType: 'node', routeTarget: '' }],
      timeoutSec: 5, maxRetries: 3,
    } },
    { id: 'transfer_sales', type: 'transfer', name: '转销售', position: { x: 600, y: -100 }, data: { targetType: 'queue', targetValue: 'sales' } },
    { id: 'transfer_support', type: 'transfer', name: '转客服', position: { x: 600, y: 100 }, data: { targetType: 'queue', targetValue: 'support' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'play1', sourceHandle: 'out' },
    { id: 'e2', source: 'play1', target: 'menu1', sourceHandle: 'out' },
    { id: 'e3', source: 'menu1', target: 'transfer_sales', sourceHandle: 'digit_1' },
    { id: 'e4', source: 'menu1', target: 'transfer_support', sourceHandle: 'digit_2' },
  ],
  variables: [{ name: '公司名', defaultValue: 'Converact' }],
};

const sampleGraph = withCompleteMenuEdges(baseSampleGraph, 'menu1');

test('validateFlowGraph passes on a valid graph', async () => {
  const errors = validateFlowGraph(sampleGraph);
  assert.deepEqual(errors, []);
});

test('validateFlowGraph catches missing entry', async () => {
  const errors = validateFlowGraph({ ...sampleGraph, entryNodeId: 'nonexistent' });
  assert.ok(errors.some((e) => e.includes('entryNodeId')));
});

test('validateFlowGraph catches missing terminal', async () => {
  const noTerminal: IvrFlowGraph = {
    version: 1, entryNodeId: 'start',
    nodes: [{ id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} }],
    edges: [], variables: [],
  };
  const errors = validateFlowGraph(noTerminal);
  assert.ok(errors.some((e) => e.includes('no terminal')));
});

test('simulate: DTMF "1" → transfers to sales', async () => {
  const result = await simulateIvrFlow(sampleGraph, {
    dtmfSequence: ['1'],
    variables: { 公司名: 'Converact' },
  });
  assert.equal(result.terminated, true);
  assert.equal(result.finalNodeId, 'transfer_sales');
  const transferAction = result.finalAction;
  assert.equal(transferAction?.kind, 'transfer');
  if (transferAction?.kind === 'transfer') {
    assert.equal(transferAction.targetValue, 'sales');
  }
});

test('simulate: DTMF "2" → transfers to support', async () => {
  const result = await simulateIvrFlow(sampleGraph, { dtmfSequence: ['2'] });
  assert.equal(result.terminated, true);
  assert.equal(result.finalNodeId, 'transfer_support');
});

test('simulate: variable substitution in play node', async () => {
  const result = await simulateIvrFlow(sampleGraph, {
    dtmfSequence: ['1'],
    variables: { 公司名: '腾讯云' },
  });
  const playStep = result.steps.find((s) => s.nodeType === 'play');
  assert.ok(playStep);
  if (playStep?.action.kind === 'play') {
    assert.ok(playStep.action.text.includes('腾讯云'));
    assert.ok(!playStep.action.text.includes('{{'));
  }
});

test('simulate: empty DTMF → menu timeout routes to timeout node', async () => {
  const result = await simulateIvrFlow(sampleGraph, { dtmfSequence: [] });
  assert.ok(result.steps.some((s) => s.nodeId === 'menu1_timeout'));
});

test('simulate: traces all steps in order', async () => {
  const result = await simulateIvrFlow(sampleGraph, { dtmfSequence: ['1'] });
  const types = result.steps.map((s) => s.nodeType);
  assert.deepEqual(types, ['start', 'play', 'menu', 'transfer']);
});

test('simulate: condition node evaluates true/false correctly', async () => {
  const graph: IvrFlowGraph = {
    version: 1, entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'cond', type: 'condition', name: 'C', position: { x: 200, y: 0 }, data: {
        logic: 'and', rules: [{ field: 'vip', op: 'eq', value: 'yes' }],
      } },
      { id: 't1', type: 'transfer', name: 'VIP', position: { x: 400, y: -50 }, data: { targetType: 'agent_ring_all', targetValue: 'vip-agent' } },
      { id: 't2', type: 'transfer', name: '普通', position: { x: 400, y: 50 }, data: { targetType: 'queue', targetValue: 'general' } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'cond', sourceHandle: 'out' },
      { id: 'e2', source: 'cond', target: 't1', sourceHandle: 'true' },
      { id: 'e3', source: 'cond', target: 't2', sourceHandle: 'false' },
    ],
    variables: [],
  };
  // VIP=yes → true → t1
  const vipResult = await simulateIvrFlow(graph, { dtmfSequence: [], variables: { vip: 'yes' } });
  assert.equal(vipResult.finalNodeId, 't1');
  // VIP=no → false → t2
  const normalResult = await simulateIvrFlow(graph, { dtmfSequence: [], variables: { vip: 'no' } });
  assert.equal(normalResult.finalNodeId, 't2');
});

test('simulate: max steps prevents infinite loops', async () => {
  // Circular graph: a→b→a→b...
  const graph: IvrFlowGraph = {
    version: 1, entryNodeId: 'a',
    nodes: [
      { id: 'a', type: 'play', name: 'A', position: { x: 0, y: 0 }, data: { contents: [{ playType: 'tts', text: 'loop' }] } },
      { id: 'b', type: 'play', name: 'B', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'loop' }] } },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b', sourceHandle: 'out' },
      { id: 'e2', source: 'b', target: 'a', sourceHandle: 'out' },
    ],
    variables: [],
  };
  const result = await simulateIvrFlow(graph, { dtmfSequence: [], maxSteps: 10 });
  assert.equal(result.terminated, false);
  assert.ok(result.error?.includes('max steps'));
  assert.ok(result.steps.length <= 10);
});

test('simulate: set_var stores variable for later nodes', async () => {
  const graph: IvrFlowGraph = {
    version: 1, entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'set1', type: 'set_var', name: 'Set', position: { x: 200, y: 0 }, data: { variableName: 'level', valueType: 'string', value: 'gold' } },
      { id: 'cond', type: 'condition', name: 'C', position: { x: 400, y: 0 }, data: { logic: 'and', rules: [{ field: 'level', op: 'eq', value: 'gold' }] } },
      { id: 't1', type: 'transfer', name: 'Gold', position: { x: 600, y: 0 }, data: { targetType: 'agent_ring_all', targetValue: 'gold-agent' } },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'set1', sourceHandle: 'out' },
      { id: 'e2', source: 'set1', target: 'cond', sourceHandle: 'out' },
      { id: 'e3', source: 'cond', target: 't1', sourceHandle: 'true' },
    ],
    variables: [],
  };
  const result = await simulateIvrFlow(graph, { dtmfSequence: [] });
  assert.equal(result.terminated, true);
  assert.equal(result.finalNodeId, 't1');
  assert.equal(result.variables['level'], 'gold');
});
