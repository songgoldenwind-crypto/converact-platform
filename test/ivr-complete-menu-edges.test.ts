import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { completeFlowMissingEdges } from '../src/agent-runtime/ivr/ivr-complete-menu-edges.js';
import { validateFlowGraphDetailed } from '../src/agent-runtime/ivr/ivr-types.js';

const base: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
    {
      id: 'menu1',
      type: 'menu',
      name: 'M',
      position: { x: 100, y: 50 },
      data: {
        prompt: [{ playType: 'tts', text: 'x' }],
        options: [{ digit: '1', label: 'a', routeType: 'node', routeTarget: '' }],
      },
    },
    { id: 't1', type: 'transfer', name: 'T', position: { x: 400, y: 0 }, data: { targetType: 'queue', targetValue: 'q' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'menu1', sourceHandle: 'out' },
    { id: 'e2', source: 'menu1', target: 't1', sourceHandle: 'digit_1' },
  ],
  variables: [],
};

test('completeFlowMissingEdges clears menu warnings', () => {
  const { graph, applied } = completeFlowMissingEdges(base);
  assert.equal(applied.length, 1);
  const report = validateFlowGraphDetailed(graph);
  assert.equal(report.warnings.length, 0);
});

test('completeFlowMissingEdges places nodes near menu position', () => {
  const { graph } = completeFlowMissingEdges(base);
  const timeout = graph.nodes.find((n) => n.id === 'menu1_timeout');
  assert.ok(timeout);
  assert.ok((timeout?.position.x ?? 0) > 100);
});
