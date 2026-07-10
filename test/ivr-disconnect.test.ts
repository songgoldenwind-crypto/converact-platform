import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
  simulateIvrFlow,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import { validateFlowGraph, type IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const disconnectOnlyGraph = (contents?: Array<{ playType: string; text?: string }>): IvrFlowGraph => ({
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
    {
      id: 'dc1',
      type: 'disconnect',
      name: '挂断',
      position: { x: 200, y: 0 },
      data: { endReason: 'completed', ...(contents ? { contents } : {}) },
    },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'dc1', sourceHandle: 'out' }],
  variables: [],
});

test('disconnect without contents → hangup only, terminated', async () => {
  const graph = disconnectOnlyGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, {});

  assert.equal(step.action.kind, 'disconnect');
  if (step.action.kind === 'disconnect') {
    assert.equal(step.action.phase, 'hangup');
    assert.equal(step.action.endReason, 'completed');
  }
  assert.equal(step.terminated, true);
  assert.equal(step.context.currentNodeId, null);
  assert.equal(step.context.variables.end_reason, 'completed');

  const rwi = ivrActionToRwi(step.action, 'call-1');
  assert.equal(rwi?.command, 'hangup');
});

test('disconnect with farewell play → flush then hangup', async () => {
  const graph = disconnectOnlyGraph([{ playType: 'tts', text: '再见' }]);
  const result = await simulateIvrFlow(graph, { dtmfSequence: [] });

  assert.equal(result.terminated, true);
  assert.equal(result.finalNodeId, 'dc1');
  assert.equal(result.variables.end_reason, 'completed');

  const disconnectSteps = result.steps.filter((s) => s.nodeType === 'disconnect');
  assert.equal(disconnectSteps.length, 1);

  const hangup = disconnectSteps[0]?.action;
  assert.equal(hangup?.kind, 'disconnect');
  if (hangup?.kind === 'disconnect') {
    assert.equal(hangup.phase, 'hangup');
  }

  const hangupRwi = ivrActionToRwi(hangup!, 'call-1');
  assert.equal(hangupRwi?.command, 'hangup');
});

test('flow ending at disconnect satisfies hasTerminal validation', async () => {
  const graph = disconnectOnlyGraph();
  const errors = validateFlowGraph(graph);
  assert.deepEqual(errors, []);
});

test('subflow return does not skip disconnect terminal', async () => {
  const subGraph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'sub_start',
    nodes: [
      { id: 'sub_start', type: 'start', name: 'Sub', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'sub_dc',
        type: 'disconnect',
        name: 'Sub DC',
        position: { x: 100, y: 0 },
        data: { endReason: 'abandoned', returnCode: 'ok' },
      },
    ],
    edges: [{ id: 'se1', source: 'sub_start', target: 'sub_dc', sourceHandle: 'out' }],
    variables: [],
  };

  const parentGraph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
      { id: 'sf', type: 'subflow', name: 'SF', position: { x: 100, y: 0 }, data: { flowId: 'child' } },
      {
        id: 'after',
        type: 'transfer',
        name: 'After',
        position: { x: 200, y: 0 },
        data: { targetType: 'queue', targetValue: 'should-reach' },
      },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'sf', sourceHandle: 'out' },
      { id: 'e2', source: 'sf', target: 'after', sourceHandle: 'out' },
      { id: 'e3', source: 'sf', target: 'after', sourceHandle: 'error' },
    ],
    variables: [],
  };

  let ctx = createRuntimeContext(parentGraph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const entered = await advanceSingleStep(ctx, {
    sideEffects: {
      executeSubflow: async () => ({ success: true, graph: subGraph }),
    },
    tenantId: 't1',
  });
  assert.equal(entered.context.currentNodeId, 'sub_start');
  assert.equal(entered.context.flowStack.length, 1);

  ctx = entered.context;
  ctx = (await advanceSingleStep(ctx, {})).context;
  const ended = await advanceSingleStep(ctx, {});

  assert.equal(ended.terminated, false);
  assert.equal(ended.nextNodeId, 'after');
  assert.equal(ended.context.currentNodeId, 'after');
  assert.equal(ended.context.flowStack.length, 0);
});
