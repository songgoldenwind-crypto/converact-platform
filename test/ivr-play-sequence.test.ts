import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function multiPlayGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'Multi',
        position: { x: 0, y: 0 },
        data: {
          contents: [
            { playType: 'tts', text: 'segment-one' },
            { playType: 'tts', text: 'segment-two' },
            { playType: 'tts', text: 'segment-three' },
          ],
        },
      },
      {
        id: 'next',
        type: 'play',
        name: 'Done',
        position: { x: 200, y: 0 },
        data: { contents: [{ playType: 'tts', text: 'after' }] },
      },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'next', sourceHandle: 'out' }],
  };
}

test('Q1: three contents enqueue once; playCompleted not required between segments', async () => {
  const step = await advanceSingleStep(createRuntimeContext(multiPlayGraph()));
  assert.equal(step.context.audioQueue?.length, 3);
  assert.notEqual(step.action.kind, 'play');
  assert.equal(step.context.currentNodeId, 'next');
});

test('Q1: single content play enqueues one and advances to disconnect sync point', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'One',
        position: { x: 0, y: 0 },
        data: { contents: [{ playType: 'tts', text: 'only' }] },
      },
      {
        id: 'next',
        type: 'disconnect',
        name: 'End',
        position: { x: 200, y: 0 },
        data: {},
      },
    ],
    edges: [{ id: 'e1', source: 'p1', target: 'next', sourceHandle: 'out' }],
  };

  const first = await advanceSingleStep(createRuntimeContext(graph));
  assert.equal(first.context.audioQueue?.length, 1);
  assert.equal(first.context.audioQueue?.[0]?.text, 'only');
  assert.equal(first.action.kind, 'flush_play_queue');
  assert.equal(first.context.pendingDisconnectFlush, 'next');
});
