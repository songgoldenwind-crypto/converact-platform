import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrSideEffects } from '../src/agent-runtime/ivr/ivr-side-effects.js';

function transferGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 't1',
    variables: [],
    nodes: [
      {
        id: 't1',
        type: 'transfer',
        name: 'T',
        position: { x: 0, y: 0 },
        data: { targetType: 'agent_ring_all', targetValue: 'seat-1', connectTimeoutSec: 15 },
      },
      { id: 'vm', type: 'voicemail', name: 'VM', position: { x: 200, y: 0 }, data: { maxDurationSec: 60 } },
      { id: 'busy', type: 'play', name: 'B', position: { x: 200, y: 100 }, data: { contents: [{ playType: 'tts', text: 'busy' }] } },
      { id: 'fail', type: 'play', name: 'F', position: { x: 200, y: 200 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'vm', sourceHandle: 'no_answer' },
      { id: 'e2', source: 't1', target: 'busy', sourceHandle: 'busy' },
      { id: 'e3', source: 't1', target: 'fail', sourceHandle: 'failed' },
    ],
  };
}

test('executeTransfer sync busy → routes to busy edge without waiting', async () => {
  const graph = transferGraph();
  const sideEffects: IvrSideEffects = {
    async executeTransfer() {
      return { ok: false, reason: 'busy', error: 'line_busy' };
    },
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { sideEffects, callSessionId: 'call-1' });
  assert.equal(step.nextNodeId, 'busy');
  assert.equal(step.context.variables.transfer_result, 'busy');
  assert.equal(step.context.waiting, undefined);
});

test('executeTransfer sync no_answer → routes to no_answer edge', async () => {
  const graph = transferGraph();
  const sideEffects: IvrSideEffects = {
    async executeTransfer() {
      return { ok: false, reason: 'no_answer' };
    },
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { sideEffects, callSessionId: 'call-2' });
  assert.equal(step.nextNodeId, 'vm');
  assert.equal(step.context.variables.transfer_result, 'no_answer');
});

test('executeTransfer sync connected → routes to out when present', async () => {
  const graph: IvrFlowGraph = {
    ...transferGraph(),
    nodes: [
      ...transferGraph().nodes,
      { id: 'ok', type: 'play', name: 'OK', position: { x: 400, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
    ],
    edges: [
      ...transferGraph().edges,
      { id: 'e4', source: 't1', target: 'ok', sourceHandle: 'out' },
    ],
  };
  const sideEffects: IvrSideEffects = {
    async executeTransfer() {
      return { ok: true, reason: 'connected' };
    },
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), { sideEffects, callSessionId: 'call-3' });
  assert.equal(step.nextNodeId, 'ok');
  assert.equal(step.context.variables.transfer_result, 'connected');
});

test('transfer group_call resolves member_seat_ids for RWI', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 't1',
    variables: [],
    nodes: [
      {
        id: 't1',
        type: 'transfer',
        name: 'GC',
        position: { x: 0, y: 0 },
        data: { targetType: 'group_call', targetValue: 'gc-sales' },
      },
    ],
    edges: [],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph), {
    groupCallResolver: (id) => (id === 'gc-sales' ? ['seat_a', 'seat_b'] : []),
    callSessionId: 'call-gc',
  });
  assert.equal(step.terminated, true);
  const { ivrActionToRwi } = await import('../src/agent-runtime/ivr/ivr-rwi-bridge.js');
  const rwi = ivrActionToRwi(step.action, 'call-gc');
  assert.deepEqual((rwi?.params as { member_seat_ids?: string[] }).member_seat_ids, ['seat_a', 'seat_b']);
});
