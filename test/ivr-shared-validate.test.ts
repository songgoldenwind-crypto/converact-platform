/**
 * P0 — shared/ivr 校验 SSOT：flat 图归一化、visual_menu、globalShortcuts 冲突。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateFlowGraphDetailed } from '../shared/ivr/validate-flow-graph.js';
import { normalizeGraphForValidation } from '../shared/ivr/graph-types.js';
import type { IvrFlowGraph } from '../shared/ivr/graph-types.js';

function terminalTransfer(id: string, x: number): IvrFlowGraph['nodes'][0] {
  return { id, type: 'transfer', name: 'T', position: { x, y: 0 }, data: { targetType: 'queue', targetValue: 'q' } };
}

test('flat designer menu: missing timeout/invalid warns like nested data shape', () => {
  const flat: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'm1',
    variables: [],
    nodes: [
      {
        id: 'm1',
        type: 'menu',
        name: 'M',
        position: { x: 0, y: 0 },
        options: [{ digit: '1', routeType: 'node', routeTarget: '' }],
      } as unknown as IvrFlowGraph['nodes'][0],
      terminalTransfer('t1', 200),
    ],
    edges: [{ id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' }],
  };
  const nested: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'm1',
    variables: [],
    nodes: [
      {
        id: 'm1',
        type: 'menu',
        name: 'M',
        position: { x: 0, y: 0 },
        data: { options: [{ digit: '1', routeType: 'node', routeTarget: '' }] },
      },
      terminalTransfer('t1', 200),
    ],
    edges: [{ id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' }],
  };

  const flatHandles = validateFlowGraphDetailed(flat).warnings.map((w) => w.handle).sort();
  const nestedHandles = validateFlowGraphDetailed(nested).warnings.map((w) => w.handle).sort();
  assert.deepEqual(flatHandles, nestedHandles);
  assert.ok(flatHandles.includes('timeout'));
  assert.ok(flatHandles.includes('invalid'));
});

test('visual_menu items via flat shape → dynamic digit handle warnings', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'vm1',
    variables: [],
    nodes: [
      {
        id: 'vm1',
        type: 'visual_menu',
        name: 'VM',
        position: { x: 0, y: 0 },
        items: [{ digit: '2', label: 'two' }],
      } as unknown as IvrFlowGraph['nodes'][0],
      terminalTransfer('t1', 200),
    ],
    edges: [],
  };
  const handles = validateFlowGraphDetailed(graph).warnings.map((w) => w.handle);
  assert.ok(handles.includes('digit_2'));
  assert.ok(handles.includes('timeout'));
  assert.ok(handles.includes('invalid'));
});

test('non-empty data stub must not hide top-level options from validation', () => {
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
        data: { placeholder: true },
        options: [{ digit: '3', routeType: 'node', routeTarget: '' }],
      } as unknown as IvrFlowGraph['nodes'][0],
      terminalTransfer('t1', 200),
    ],
    edges: [],
  };
  const normalized = normalizeGraphForValidation(graph).nodes[0];
  const options = (normalized.data.options as unknown[]) ?? [];
  assert.ok(options.length > 0, 'options must be visible after normalize');
  const handles = validateFlowGraphDetailed(graph).warnings.map((w) => w.handle);
  assert.ok(handles.includes('digit_3'), 'missing digit_3 edge should warn');
});

test('globalShortcuts digit conflict with menu option warns', () => {
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
          options: [{ digit: '1', routeType: 'node', routeTarget: '' }],
        },
      },
      terminalTransfer('t1', 200),
    ],
    edges: [
      { id: 'e1', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
      { id: 'e2', source: 'm1', target: 't1', sourceHandle: 'timeout' },
      { id: 'e3', source: 'm1', target: 't1', sourceHandle: 'invalid' },
      { id: 'e4', source: 'm1', target: 't1', sourceHandle: 'max_retries' },
    ],
    globalShortcuts: [{ digit: '1', action: 'repeat_last' }],
  };
  const conflict = validateFlowGraphDetailed(graph).warnings.find(
    (w) => w.nodeId === 'm1' && w.handle === 'digit_1' && w.message.includes('全局快捷键')
  );
  assert.ok(conflict);
});

test('structural error: missing entryNodeId', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: '',
    variables: [],
    nodes: [terminalTransfer('t1', 0)],
    edges: [],
  };
  assert.ok(validateFlowGraphDetailed(graph).errors.some((e) => e.message.includes('entryNodeId')));
});
