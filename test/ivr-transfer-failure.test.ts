import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { isTransferTerminal } from '../src/agent-runtime/ivr/ivr-transfer-handler.js';
import { createRuntimeContext, advanceSingleStep } from '../src/agent-runtime/ivr/ivr-executor.js';

function transferGraph(withFailureEdges: boolean): IvrFlowGraph {
  const edges = withFailureEdges
    ? [
        { id: 'e1', source: 't1', target: 'vm', sourceHandle: 'no_answer' },
        { id: 'e2', source: 't1', target: 'busy', sourceHandle: 'busy' },
        { id: 'e3', source: 't1', target: 'fail', sourceHandle: 'failed' },
      ]
    : [];
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
    edges,
  };
}

test('isTransferTerminal: zero outgoing edges → terminal (legacy)', () => {
  const graph = transferGraph(false);
  assert.equal(isTransferTerminal(graph, 't1'), true);
});

test('isTransferTerminal: with failure edges → non-terminal', () => {
  const graph = transferGraph(true);
  assert.equal(isTransferTerminal(graph, 't1'), false);
});

test('isTransferTerminal: out-only edges → non-terminal', () => {
  const graph = transferGraph(false);
  graph.edges = [{ id: 'e-out', source: 't1', target: 'vm', sourceHandle: 'out' }];
  assert.equal(isTransferTerminal(graph, 't1'), false);
});

test('transfer with failure edges enters waiting on first advance', async () => {
  const graph = transferGraph(true);
  const step = await advanceSingleStep(createRuntimeContext(graph), {});
  assert.equal(step.action.kind, 'transfer');
  assert.equal(step.context.waiting?.kind, 'transfer');
  assert.equal(step.terminated, false);
});

test('transfer legacy graph terminates immediately', async () => {
  const graph = transferGraph(false);
  const step = await advanceSingleStep(createRuntimeContext(graph), {});
  assert.equal(step.terminated, true);
});

test('transfer no_answer event → no_answer edge', async () => {
  const graph = transferGraph(true);
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { transferEvent: { kind: 'no_answer' } });
  assert.equal(step.nextNodeId, 'vm');
  assert.equal(step.context.variables.transfer_result, 'no_answer');
});

test('transfer busy event → busy edge', async () => {
  const graph = transferGraph(true);
  let ctx = (await advanceSingleStep(createRuntimeContext(graph), {})).context;
  const step = await advanceSingleStep(ctx, { transferEvent: { kind: 'busy' } });
  assert.equal(step.nextNodeId, 'busy');
});

test('transfer failed event → failed edge', async () => {
  const graph = transferGraph(true);
  let ctx = (await advanceSingleStep(createRuntimeContext(graph), {})).context;
  const step = await advanceSingleStep(ctx, { transferEvent: { kind: 'failed', reason: 'network' } });
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.transfer_fail_reason, 'network');
});

test('transfer no_answer without edge → null + _branch_miss', async () => {
  const graph = transferGraph(true);
  graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'no_answer');
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  const step = await advanceSingleStep(ctx, { transferEvent: { kind: 'no_answer' } });
  assert.equal(step.nextNodeId, null);
  assert.equal(step.context.variables.last_branch_handle, 'no_answer');
  assert.equal(step.context.variables._branch_miss, 't1:no_answer');
  assert.equal(step.context.variables.transfer_result, 'no_answer');
});

test('preTransferPrompt: enqueue + flush_play_queue then transfer waiting', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 't1',
    variables: [],
    nodes: [
      {
        id: 't1',
        type: 'transfer',
        name: 'T',
        position: { x: 0, y: 0 },
        data: {
          targetType: 'agent_ring_all',
          targetValue: 'seat-1',
          preTransferPrompt: [{ playType: 'tts', text: '正在为您转接' }],
        },
      },
      { id: 'vm', type: 'voicemail', name: 'VM', position: { x: 200, y: 0 }, data: { maxDurationSec: 60 } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'vm', sourceHandle: 'no_answer' },
      { id: 'e2', source: 't1', target: 'vm', sourceHandle: 'busy' },
      { id: 'e3', source: 't1', target: 'vm', sourceHandle: 'failed' },
    ],
  };
  const first = await advanceSingleStep(createRuntimeContext(graph), { callSessionId: 'call-pre' });
  assert.equal(first.action.kind, 'flush_play_queue');
  assert.equal(first.context.pendingTransferFlush, 't1');

  const second = await advanceSingleStep(first.context, { flushCompleted: true, callSessionId: 'call-pre' });
  assert.equal(second.context.preTransferPromptPlayed, 't1');
  assert.equal(second.context.waiting?.kind, 'transfer');
  assert.equal(second.action.kind, 'transfer');
});
