import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IVR_BRANCH,
  menuRequiredDigitHandles,
  REQUIRED_HANDLES_BY_TYPE,
} from '../src/agent-runtime/ivr/ivr-branch-handles.js';
import {
  requireEdge,
  resolveEdge,
  validateFlowGraph,
  validateFlowGraphDetailed,
  type IvrFlowGraph,
} from '../src/agent-runtime/ivr/ivr-types.js';

function minimalGraph(overrides: Partial<IvrFlowGraph> = {}): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'n1', type: 'play', name: 'P', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'n1', sourceHandle: 'out' },
      { id: 'e2', source: 'n1', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
    ...overrides,
  };
}

test('requireEdge: exact handle match returns target', () => {
  const graph = minimalGraph();
  const r = requireEdge(graph, 'start', IVR_BRANCH.OUT);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.target, 'n1');
});

test('requireEdge: missing handle returns ok false without fallback', () => {
  const graph = minimalGraph();
  const r = requireEdge(graph, 'n1', IVR_BRANCH.TIMEOUT);
  assert.deepEqual(r, { ok: false, handle: IVR_BRANCH.TIMEOUT });
});

test('resolveEdge: still falls back to out when handle missing', () => {
  const graph = minimalGraph();
  assert.equal(resolveEdge(graph, 'n1', IVR_BRANCH.TIMEOUT), 't1');
});

test('IVR_BRANCH.digit formats digit handles', () => {
  assert.equal(IVR_BRANCH.digit('1'), 'digit_1');
});

test('menuRequiredDigitHandles: routeType=node requires digit edge', () => {
  const handles = menuRequiredDigitHandles({
    data: {
      options: [
        { digit: '1', routeType: 'node', routeTarget: 'sales' },
        { digit: '2', routeType: 'queue', routeTarget: 'support' },
      ],
    },
  });
  assert.deepEqual(handles, ['digit_1']);
});

test('menuRequiredDigitHandles: unset routeType requires digit edge', () => {
  const handles = menuRequiredDigitHandles({
    data: { options: [{ digit: '9' }] },
  });
  assert.deepEqual(handles, ['digit_9']);
});

test('REQUIRED_HANDLES_BY_TYPE: menu requires timeout invalid max_retries', () => {
  const rule = REQUIRED_HANDLES_BY_TYPE.menu;
  assert.ok(rule);
  assert.deepEqual(rule.required, ['timeout', 'invalid', 'max_retries']);
  assert.equal(typeof rule.dynamic, 'function');
});

test('REQUIRED_HANDLES_BY_TYPE: queue requires at_capacity and error', () => {
  const rule = REQUIRED_HANDLES_BY_TYPE.queue;
  assert.ok(rule);
  assert.ok(rule.required.includes(IVR_BRANCH.AT_CAPACITY));
  assert.ok(rule.required.includes(IVR_BRANCH.ERROR));
});

test('REQUIRED_HANDLES_BY_TYPE: survey requires submitted invalid and timeout', () => {
  assert.deepEqual(REQUIRED_HANDLES_BY_TYPE.survey.required, ['submitted', 'invalid', 'timeout']);
});

test('REQUIRED_HANDLES_BY_TYPE: transfer terminal has no required handles', () => {
  assert.deepEqual(REQUIRED_HANDLES_BY_TYPE.transfer.required, []);
});

test('REQUIRED_HANDLES_BY_TYPE: subflow requires error edge', () => {
  assert.ok(REQUIRED_HANDLES_BY_TYPE.subflow.required.includes(IVR_BRANCH.ERROR));
});

test('REQUIRED_HANDLES_BY_TYPE: ai_dialogue requires timeout and error', () => {
  const rule = REQUIRED_HANDLES_BY_TYPE.ai_dialogue;
  assert.ok(rule.required.includes(IVR_BRANCH.TIMEOUT));
  assert.ok(rule.required.includes(IVR_BRANCH.ERROR));
});

test('REQUIRED_HANDLES_BY_TYPE: compliance recording_consent dynamic handles', () => {
  const dynamic = REQUIRED_HANDLES_BY_TYPE.compliance.dynamic!;
  assert.deepEqual(
    dynamic({ type: 'compliance', data: { complianceType: 'recording_consent' } }),
    ['acknowledged', 'declined', IVR_BRANCH.TIMEOUT]
  );
});

test('REQUIRED_HANDLES_BY_TYPE: compliance ai_disclosure only static out', () => {
  const dynamic = REQUIRED_HANDLES_BY_TYPE.compliance.dynamic!;
  assert.deepEqual(
    dynamic({ type: 'compliance', data: { complianceType: 'ai_disclosure' } }),
    []
  );
});

function menuGraphBase(overrides: {
  menuId?: string;
  menuEdges?: IvrFlowGraph['edges'];
  menuData?: Record<string, unknown>;
}): IvrFlowGraph {
  const menuId = overrides.menuId ?? 'menu_main';
  return {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      {
        id: menuId,
        type: 'menu',
        name: 'M',
        position: { x: 100, y: 0 },
        data: overrides.menuData ?? {
          options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: 't' }],
        },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: overrides.menuEdges ?? [
      { id: 'e0', source: 'start', target: menuId, sourceHandle: 'out' },
      { id: 'e1', source: menuId, target: 't1', sourceHandle: 'digit_1' },
    ],
    variables: [],
  };
}

test('validateFlowGraphDetailed: menu missing timeout → warning on menu_main', () => {
  const report = validateFlowGraphDetailed(menuGraphBase({}));
  const timeout = report.warnings.find((w) => w.nodeId === 'menu_main' && w.handle === 'timeout');
  assert.ok(timeout);
  assert.equal(report.errors.length, 0);
});

test('validateFlowGraphDetailed: menu option routeType=queue digit_1 edge not required', () => {
  const graph = menuGraphBase({
    menuData: {
      options: [{ digit: '1', label: 'q', routeType: 'queue', routeTarget: 'sales' }],
    },
    menuEdges: [
      { id: 'e0', source: 'start', target: 'menu_main', sourceHandle: 'out' },
      { id: 'et', source: 'menu_main', target: 't1', sourceHandle: 'timeout' },
      { id: 'ei', source: 'menu_main', target: 't1', sourceHandle: 'invalid' },
      { id: 'em', source: 'menu_main', target: 't1', sourceHandle: 'max_retries' },
    ],
  });
  const report = validateFlowGraphDetailed(graph);
  const digitWarn = report.warnings.find((w) => w.handle === 'digit_1');
  assert.equal(digitWarn, undefined);
});

test('validateFlowGraphDetailed: menu queue option missing routeTarget warns', () => {
  const graph = menuGraphBase({
    menuData: {
      options: [{ digit: '1', label: '销售', routeType: 'queue', routeTarget: '' }],
    },
    menuEdges: [
      { id: 'e0', source: 'start', target: 'menu_main', sourceHandle: 'out' },
      { id: 'et', source: 'menu_main', target: 't1', sourceHandle: 'timeout' },
      { id: 'ei', source: 'menu_main', target: 't1', sourceHandle: 'invalid' },
      { id: 'em', source: 'menu_main', target: 't1', sourceHandle: 'max_retries' },
    ],
  });
  const w = validateFlowGraphDetailed(graph).warnings.find((x) => x.handle === 'digit_1');
  assert.ok(w?.message.includes('routeTarget'));
});

test('validateFlowGraphDetailed: menu option routeType=node requires digit_1 edge', () => {
  const report = validateFlowGraphDetailed(menuGraphBase({}));
  const digit = report.warnings.find((w) => w.handle === 'digit_1');
  assert.ok(!digit, 'digit_1 edge present');
  const missing = validateFlowGraphDetailed(
    menuGraphBase({
      menuEdges: [{ id: 'e0', source: 'start', target: 'menu_main', sourceHandle: 'out' }],
    })
  ).warnings.find((w) => w.handle === 'digit_1');
  assert.ok(missing);
});

test('validateFlowGraphDetailed: collect missing invalid → warning', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'c1', type: 'collect', name: 'C', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'c1', sourceHandle: 'out' },
      { id: 'e1', source: 'c1', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  const invalid = validateFlowGraphDetailed(graph).warnings.find((w) => w.handle === 'invalid');
  assert.ok(invalid);
});

test('validateFlowGraphDetailed: queue requires at_capacity and error handles', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'q1', type: 'queue', name: 'Q', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'q1', sourceHandle: 'out' },
      { id: 'e1', source: 'q1', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  const handles = validateFlowGraphDetailed(graph).warnings.map((w) => w.handle);
  assert.ok(handles.includes('at_capacity'));
  assert.ok(handles.includes('error'));
});

test('validateFlowGraphDetailed: webhook missing fail edge → warning', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'w1', type: 'webhook', name: 'W', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'w1', sourceHandle: 'out' },
      { id: 'e1', source: 'w1', target: 't1', sourceHandle: 'success' },
    ],
    variables: [],
  };
  const fail = validateFlowGraphDetailed(graph).warnings.find((w) => w.handle === 'fail');
  assert.ok(fail);
});

test('validateFlowGraphDetailed: webhook missing timeout → warning (phase A)', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'w1', type: 'webhook', name: 'W', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'w1', sourceHandle: 'out' },
      { id: 'e1', source: 'w1', target: 't1', sourceHandle: 'success' },
      { id: 'e2', source: 'w1', target: 't1', sourceHandle: 'fail' },
    ],
    variables: [],
  };
  const timeout = validateFlowGraphDetailed(graph).warnings.find((w) => w.handle === 'timeout');
  assert.ok(timeout);
});

test('validateFlowGraphDetailed: valid complete menu graph → no warnings', () => {
  const graph = menuGraphBase({
    menuEdges: [
      { id: 'e0', source: 'start', target: 'menu_main', sourceHandle: 'out' },
      { id: 'e1', source: 'menu_main', target: 't1', sourceHandle: 'digit_1' },
      { id: 'et', source: 'menu_main', target: 't1', sourceHandle: 'timeout' },
      { id: 'ei', source: 'menu_main', target: 't1', sourceHandle: 'invalid' },
      { id: 'em', source: 'menu_main', target: 't1', sourceHandle: 'max_retries' },
    ],
  });
  const report = validateFlowGraphDetailed(graph);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.length, 0);
});

test('validateFlowGraphDetailed returns nodeId and handle', () => {
  const w = validateFlowGraphDetailed(menuGraphBase({})).warnings[0];
  assert.ok(w.nodeId);
  assert.ok(w.handle);
  assert.ok(w.message);
});

test('validateFlowGraph legacy graph without max_retries → warning not string[] error', () => {
  assert.equal(validateFlowGraph(menuGraphBase({})).length, 0);
  const maxRetry = validateFlowGraphDetailed(menuGraphBase({})).warnings.find(
    (w) => w.handle === 'max_retries'
  );
  assert.ok(maxRetry);
});

test('validateFlowGraphDetailed: transfer terminal → no outgoing required', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e0', source: 'start', target: 't1', sourceHandle: 'out' }],
    variables: [],
  };
  const report = validateFlowGraphDetailed(graph);
  assert.equal(report.warnings.length, 0);
});

test('validateFlowGraphDetailed: subflow requires error edge', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'sf', type: 'subflow', name: 'SF', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'sf', sourceHandle: 'out' },
      { id: 'e1', source: 'sf', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  assert.ok(validateFlowGraphDetailed(graph).warnings.some((w) => w.handle === 'error'));
});

test('validateFlowGraphDetailed: compliance recording_consent requires acknowledged/declined/timeout', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'cp',
        type: 'compliance',
        name: 'C',
        position: { x: 100, y: 0 },
        data: { complianceType: 'recording_consent' },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'cp', sourceHandle: 'out' },
      { id: 'e1', source: 'cp', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  const handles = validateFlowGraphDetailed(graph).warnings.map((w) => w.handle);
  assert.ok(handles.includes('acknowledged'));
  assert.ok(handles.includes('declined'));
  assert.ok(handles.includes('timeout'));
});

test('REQUIRED_HANDLES_BY_TYPE: avatar_switch requires success/declined/error', () => {
  assert.deepEqual(REQUIRED_HANDLES_BY_TYPE.avatar_switch.required.sort(), ['declined', 'error', 'success']);
});

test('REQUIRED_HANDLES_BY_TYPE: video_play requires out/skipped/error', () => {
  assert.deepEqual(REQUIRED_HANDLES_BY_TYPE.video_play.required.sort(), ['error', 'out', 'skipped']);
});

test('validateFlowGraphDetailed: avatar_switch missing declined warns', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'av1',
    nodes: [
      { id: 'av1', type: 'avatar_switch', name: 'AV', position: { x: 0, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 'av1', target: 'x', sourceHandle: 'success' }],
    variables: [],
  };
  const result = validateFlowGraphDetailed(graph);
  assert.ok(result.warnings.some((w) => w.handle === 'declined'));
});

test('validateFlowGraphDetailed: exactly one start node required', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'start2', type: 'start', name: 'S2', position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [],
    variables: [],
  };
  assert.ok(
    validateFlowGraphDetailed(graph).errors.some((e) => e.message.includes('exactly one start'))
  );
});

test('validateFlowGraphDetailed: compliance ai_disclosure only requires out', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'cp',
        type: 'compliance',
        name: 'C',
        position: { x: 100, y: 0 },
        data: { complianceType: 'ai_disclosure' },
      },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'cp', sourceHandle: 'out' },
      { id: 'e1', source: 'cp', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  assert.equal(validateFlowGraphDetailed(graph).warnings.length, 0);
});

test('validateFlowGraphDetailed: ai_dialogue requires timeout and error', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'ai', type: 'ai_dialogue', name: 'AI', position: { x: 100, y: 0 }, data: {} },
      { id: 't1', type: 'transfer', name: 'T', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'ai', sourceHandle: 'out' },
      { id: 'e1', source: 'ai', target: 't1', sourceHandle: 'out' },
    ],
    variables: [],
  };
  const handles = validateFlowGraphDetailed(graph).warnings.map((w) => w.handle);
  assert.ok(handles.includes('timeout'));
  assert.ok(handles.includes('error'));
});
