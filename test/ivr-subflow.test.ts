import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { MAX_SUBFLOW_DEPTH } from '../src/agent-runtime/ivr/ivr-subflow-handler.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function parentGraph(opts?: { withErrorEdge?: boolean }): IvrFlowGraph {
  const edges = [
    { id: 'e1', source: 'start', target: 'sf', sourceHandle: 'out' },
    { id: 'e2', source: 'sf', target: 'after', sourceHandle: 'out' },
  ];
  if (opts?.withErrorEdge !== false) {
    edges.push({ id: 'e3', source: 'sf', target: 'err', sourceHandle: 'error' });
  }
  return {
    version: 1,
    entryNodeId: 'start',
    variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'sf', type: 'subflow', name: 'SF', position: { x: 100, y: 0 }, data: { flowId: 'child' } },
      { id: 'after', type: 'play', name: 'After', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'back' }] } },
      { id: 'err', type: 'play', name: 'Err', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'err' }] } },
    ],
    edges,
  };
}

const okSubGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'sub_start',
  nodes: [
    { id: 'sub_start', type: 'start', name: 'Sub', position: { x: 0, y: 0 }, data: {} },
    { id: 'sub_dc', type: 'disconnect', name: 'Sub DC', position: { x: 100, y: 0 }, data: { endReason: 'completed', returnCode: 'ok' } },
  ],
  edges: [{ id: 'se1', source: 'sub_start', target: 'sub_dc', sourceHandle: 'out' }],
  variables: [],
};

const errorSubGraph: IvrFlowGraph = {
  ...okSubGraph,
  nodes: [
    okSubGraph.nodes[0],
    { id: 'sub_dc', type: 'disconnect', name: 'Sub DC', position: { x: 100, y: 0 }, data: { endReason: 'abandoned', returnCode: 'error' } },
  ],
};

test('subflow not found → error edge', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, {
    tenantId: 't1',
    sideEffects: {
      executeSubflow: async () => ({ success: false, error: 'subflow not found' }),
    },
  });
  assert.equal(step.nextNodeId, 'err');
  assert.equal(step.context.variables.subflow_error, 'subflow not found');
});

test('subflow without loader → error edge', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, {});
  assert.equal(step.nextNodeId, 'err');
  assert.equal(step.context.variables.subflow_error, 'subflow_load_failed');
});

test('subflow load success enters child graph', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, {
    tenantId: 't1',
    sideEffects: { executeSubflow: async () => ({ success: true, graph: okSubGraph }) },
  });
  assert.equal(step.context.currentNodeId, 'sub_start');
  assert.equal(step.context.flowStack.length, 1);
  assert.equal(step.context.subflowDepth, 1);
  assert.equal(step.context.flowStack[0].returnNodeId, 'after');
  assert.equal(step.context.flowStack[0].errorReturnNodeId, 'err');
});

test('subflow disconnect returnCode ok → parent out edge', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      sideEffects: { executeSubflow: async () => ({ success: true, graph: okSubGraph }) },
    })
  ).context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  const ended = await advanceSingleStep(ctx, {});

  assert.equal(ended.terminated, false);
  assert.equal(ended.nextNodeId, 'after');
  assert.equal(ended.context.currentNodeId, 'after');
  assert.equal(ended.context.flowStack.length, 0);
});

test('subflow disconnect returnCode error → parent error edge + branch', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      sideEffects: { executeSubflow: async () => ({ success: true, graph: errorSubGraph }) },
    })
  ).context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  const ended = await advanceSingleStep(ctx, {});

  assert.equal(ended.nextNodeId, 'err');
  assert.equal(ended.context.variables.last_branch_handle, 'error');
});

test('subflow depth exceeded → error edge', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = { ...ctx, subflowDepth: MAX_SUBFLOW_DEPTH };
  const step = await advanceSingleStep(ctx, {
    tenantId: 't1',
    sideEffects: { executeSubflow: async () => ({ success: true, graph: okSubGraph }) },
  });
  assert.equal(step.nextNodeId, 'err');
  assert.equal(step.context.variables.subflow_error, 'max_depth_exceeded');
  assert.equal(step.context.variables.last_branch_handle, 'error');
});

test('subflow not found without error edge → _branch_miss', async () => {
  const graph = parentGraph({ withErrorEdge: false });
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, {
    tenantId: 't1',
    sideEffects: {
      executeSubflow: async () => ({ success: false, error: 'subflow not found' }),
    },
  });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables._branch_miss, 'sf:error');
});

test('subflow return ok → parent out branch_taken', async () => {
  const graph = parentGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  ctx = (
    await advanceSingleStep(ctx, {
      tenantId: 't1',
      sideEffects: { executeSubflow: async () => ({ success: true, graph: okSubGraph }) },
    })
  ).context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  const ended = await advanceSingleStep(ctx, {});
  assert.equal(ended.nextNodeId, 'after');
  assert.equal(ended.context.variables.last_branch_handle, 'out');
});
