import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';

function transferWithPrePromptGraph(): IvrFlowGraph {
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
}

test('preTransferPrompt: enqueue + flush_play_queue then transfer waiting', async () => {
  const graph = transferWithPrePromptGraph();
  const first = await advanceSingleStep(createRuntimeContext(graph), { callSessionId: 'call-pre' });
  assert.equal(first.action.kind, 'flush_play_queue');
  if (first.action.kind === 'flush_play_queue') {
    assert.equal(first.action.promptQueue[0]?.text, '正在为您转接');
  }
  assert.equal(first.context.pendingTransferFlush, 't1');
  assert.equal(first.context.preTransferPromptEnqueued, 't1');
  assert.equal(first.context.waiting, undefined);

  const second = await advanceSingleStep(first.context, { flushCompleted: true, callSessionId: 'call-pre' });
  assert.equal(second.context.preTransferPromptPlayed, 't1');
  assert.equal(second.context.pendingTransferFlush, undefined);
  assert.equal(second.context.audioQueue?.length ?? 0, 0);
  assert.equal(second.context.waiting?.kind, 'transfer');
  assert.equal(second.action.kind, 'transfer');
});

test('play queue + preTransferPrompt: single flush_play_queue with both segments', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'P',
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'tts', text: 'welcome' }] },
      },
      {
        id: 't1',
        type: 'transfer',
        name: 'T',
        position: { x: 100, y: 0 },
        data: {
          targetType: 'queue',
          targetValue: 'sales',
          preTransferPrompt: [{ playType: 'tts', text: 'transferring' }],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 't1', sourceHandle: 'out' }],
  };
  const flushed = await advanceSingleStep(createRuntimeContext(graph));
  assert.equal(flushed.action.kind, 'flush_play_queue');
  if (flushed.action.kind === 'flush_play_queue') {
    assert.equal(flushed.action.promptQueue.length, 2);
    assert.equal(flushed.action.promptQueue[0]?.text, 'welcome');
    assert.equal(flushed.action.promptQueue[1]?.text, 'transferring');
  }
  assert.equal(flushed.context.pendingTransferFlush, 't1');
  const rwi = ivrActionToRwi(flushed.action, 'call-tr');
  assert.equal(rwi?.command, 'flush_play_queue');
});

test('terminal transfer with upstream queue: flush then terminate', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'P',
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'tts', text: 'bye' }] },
      },
      {
        id: 't1',
        type: 'transfer',
        name: 'T',
        position: { x: 100, y: 0 },
        data: { targetType: 'queue', targetValue: 'sales' },
      },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 't1', sourceHandle: 'out' }],
  };
  const flushed = await advanceSingleStep(createRuntimeContext(graph));
  assert.equal(flushed.action.kind, 'flush_play_queue');
  const done = await advanceSingleStep(flushed.context, { flushCompleted: true });
  assert.equal(done.terminated, true);
  assert.equal(done.action.kind, 'transfer');
});
