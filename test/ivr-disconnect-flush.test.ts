import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
  simulateIvrFlow,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function playDisconnectGraph(farewell?: string): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'P',
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'tts', text: 'thanks' }] },
      },
      {
        id: 'dc1',
        type: 'disconnect',
        name: 'End',
        position: { x: 100, y: 0 },
        data: {
          endReason: 'completed',
          ...(farewell ? { contents: [{ playType: 'tts', text: farewell }] } : {}),
        },
      },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'dc1', sourceHandle: 'out' }],
  };
}

test('upstream queue + disconnect: flush_play_queue then hangup', async () => {
  const flushed = await advanceSingleStep(createRuntimeContext(playDisconnectGraph()));
  assert.equal(flushed.action.kind, 'flush_play_queue');
  if (flushed.action.kind === 'flush_play_queue') {
    assert.equal(flushed.action.promptQueue.length, 1);
    assert.equal(flushed.action.promptQueue[0]?.text, 'thanks');
  }
  assert.equal(flushed.context.pendingDisconnectFlush, 'dc1');

  const done = await advanceSingleStep(flushed.context, { flushCompleted: true });
  assert.equal(done.terminated, true);
  assert.equal(done.action.kind, 'disconnect');
  if (done.action.kind === 'disconnect') {
    assert.equal(done.action.phase, 'hangup');
  }
});

test('disconnect farewell contents merged into single flush_play_queue', async () => {
  const flushed = await advanceSingleStep(createRuntimeContext(playDisconnectGraph('再见')));
  assert.equal(flushed.action.kind, 'flush_play_queue');
  if (flushed.action.kind === 'flush_play_queue') {
    assert.equal(flushed.action.promptQueue.length, 2);
    assert.equal(flushed.action.promptQueue[0]?.text, 'thanks');
    assert.equal(flushed.action.promptQueue[1]?.text, '再见');
  }
  const rwi = ivrActionToRwi(flushed.action, 'call-dc');
  assert.equal(rwi?.command, 'flush_play_queue');
});

test('simulate: farewell flush then hangup in one disconnect step', async () => {
  const result = await simulateIvrFlow(playDisconnectGraph('再见'), { dtmfSequence: [] });
  assert.equal(result.terminated, true);
  assert.equal(result.finalNodeId, 'dc1');
  const hangup = result.steps.find((s) => s.action.kind === 'disconnect');
  assert.ok(hangup);
  if (hangup?.action.kind === 'disconnect') {
    assert.equal(hangup.action.phase, 'hangup');
  }
});
