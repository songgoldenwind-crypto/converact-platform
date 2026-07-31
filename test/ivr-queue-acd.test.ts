import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AcdEnqueueResult } from '../src/agent-runtime/ivr/ivr-acd-adapter.js';
import { mapIvrStrategyToAcd } from '../src/agent-runtime/ivr/ivr-acd-adapter.js';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function queueGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'q1',
    variables: [],
    nodes: [
      {
        id: 'q1',
        type: 'queue',
        name: 'Sales Q',
        position: { x: 0, y: 0 },
        data: { queueName: 'sales', strategy: 'fifo', timeoutSec: 300, timeoutAction: 'voicemail' },
      },
      { id: 'out', type: 'transfer', name: 'Agent', position: { x: 200, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
      { id: 'tout', type: 'play', name: 'Timeout', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'timeout' }] } },
      { id: 'cap', type: 'play', name: 'Full', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'full' }] } },
      { id: 'err', type: 'play', name: 'Err', position: { x: 200, y: 300 }, data: { contents: [{ playType: 'tts', text: 'err' }] } },
    ],
    edges: [
      { id: 'e1', source: 'q1', target: 'out', sourceHandle: 'out' },
      { id: 'e2', source: 'q1', target: 'tout', sourceHandle: 'timeout' },
      { id: 'e3', source: 'q1', target: 'cap', sourceHandle: 'at_capacity' },
      { id: 'e4', source: 'q1', target: 'err', sourceHandle: 'error' },
    ],
  };
}

function mockEnqueue(result: AcdEnqueueResult) {
  return async () => result;
}

test('mapIvrStrategyToAcd: fifo → longest_idle', () => {
  assert.equal(mapIvrStrategyToAcd('fifo'), 'longest_idle');
});

test('queue pending → waiting on node', async () => {
  const graph = queueGraph();
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    acdEnqueue: mockEnqueue({ status: 'pending', queueEntryId: 'e1' }),
    callSessionId: 'call-1',
  });
  assert.equal(step.context.waiting?.kind, 'queue');
  assert.equal(step.context.waiting?.nodeId, 'q1');
  assert.equal(step.context.currentNodeId, 'q1');
  assert.equal(step.context.variables.queue_result, 'pending');
});

test('queue connected → out edge', async () => {
  const graph = queueGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (
    await advanceSingleStep(ctx, {
      acdEnqueue: mockEnqueue({ status: 'pending', queueEntryId: 'e1' }),
      callSessionId: 'call-1',
    })
  ).context;
  const step = await advanceSingleStep(ctx, {
    queueEvent: { kind: 'connected', agentId: 'agent-42' },
  });
  assert.equal(step.nextNodeId, 'out');
  assert.equal(step.context.variables.agent_id, 'agent-42');
  assert.equal(step.context.variables.last_branch_handle, 'out');
  assert.equal(step.context.waiting, undefined);
});

test('queue timeout → timeout edge', async () => {
  const graph = queueGraph();
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, { acdEnqueue: mockEnqueue({ status: 'pending', queueEntryId: 'e1' }) })).context;
  const step = await advanceSingleStep(ctx, { queueEvent: { kind: 'timeout' } });
  assert.equal(step.nextNodeId, 'tout');
  assert.equal(step.context.variables.queue_result, 'timeout');
  assert.equal(step.context.variables.last_branch_handle, 'timeout');
});

test('queue at_capacity → at_capacity edge', async () => {
  const graph = queueGraph();
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    acdEnqueue: mockEnqueue({ status: 'at_capacity' }),
    callSessionId: 'call-1',
  });
  assert.equal(step.nextNodeId, 'cap');
  assert.equal(step.context.variables.queue_result, 'at_capacity');
  assert.equal(step.context.variables.last_branch_handle, 'at_capacity');
});

test('queue enqueue error → error edge', async () => {
  const graph = queueGraph();
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    acdEnqueue: mockEnqueue({ status: 'error', reason: 'queue_not_found' }),
    callSessionId: 'call-1',
  });
  assert.equal(step.nextNodeId, 'err');
  assert.equal(step.context.variables.queue_result, 'error');
  assert.equal(step.context.variables.last_error, 'queue_not_found');
  assert.equal(step.context.variables.last_branch_handle, 'error');
});

test('queue immediate connected on enqueue → out edge', async () => {
  const graph = queueGraph();
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    acdEnqueue: mockEnqueue({ status: 'connected', agentId: 'agent-99', queueEntryId: 'e2' }),
    callSessionId: 'call-1',
  });
  assert.equal(step.nextNodeId, 'out');
  assert.equal(step.context.variables.agent_id, 'agent-99');
});

test('queue waitMusic → RWI wait_music param', async () => {
  const graph = queueGraph();
  graph.nodes[0].data = { ...graph.nodes[0].data, waitMusic: 'hold-music-01' };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    acdEnqueue: mockEnqueue({ status: 'pending', queueEntryId: 'e1' }),
    callSessionId: 'call-1',
  });
  const { ivrActionToRwi } = await import('../src/agent-runtime/ivr/ivr-rwi-bridge.js');
  const rwi = ivrActionToRwi(step.action, 'call-1');
  assert.equal((rwi?.params as { wait_music?: string }).wait_music, 'hold-music-01');
});
