import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceSingleStep,
  createRuntimeContext,
} from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import type { RecordingExecResult } from '../src/agent-runtime/ivr/ivr-side-effects.js';

function recordingGraph(action: string): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'r1',
    variables: [],
    nodes: [
      {
        id: 'r1',
        type: 'recording',
        name: 'Rec',
        position: { x: 0, y: 0 },
        data: { action, format: 'wav' },
      },
      { id: 'next', type: 'play', name: 'Next', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
    ],
    edges: [{ id: 'e1', source: 'r1', target: 'next', sourceHandle: 'out' }],
  };
}

test('recording start writes egress_id', async () => {
  const step = await advanceSingleStep(createRuntimeContext(recordingGraph('start')), {
    roomName: 'room-1',
    sideEffects: {
      executeRecording: async () => ({ success: true, egressId: 'eg-123' }),
    },
  });
  assert.equal(step.context.variables.egress_id, 'eg-123');
  assert.equal(step.nextNodeId, 'next');
});

test('recording stop writes recording_url', async () => {
  let ctx = createRuntimeContext(recordingGraph('start'));
  ctx = (
    await advanceSingleStep(ctx, {
      roomName: 'room-1',
      sideEffects: { executeRecording: async () => ({ success: true, egressId: 'eg-1' }) },
    })
  ).context;
  const stopGraph = recordingGraph('stop');
  stopGraph.entryNodeId = 'r1';
  ctx.graph = stopGraph;
  ctx.currentNodeId = 'r1';
  const step = await advanceSingleStep(ctx, {
    roomName: 'room-1',
    sideEffects: {
      executeRecording: async (): Promise<RecordingExecResult> => ({
        success: true,
        recordingUrl: 'https://storage/rec.wav',
      }),
    },
  });
  assert.equal(step.context.variables.recording_url, 'https://storage/rec.wav');
});

test('recording stop without prior start still advances out', async () => {
  const step = await advanceSingleStep(createRuntimeContext(recordingGraph('stop')), {
    roomName: 'room-1',
    sideEffects: { executeRecording: async () => ({ success: true }) },
  });
  assert.equal(step.nextNodeId, 'next');
  assert.equal(step.context.variables.egress_id, undefined);
});

test('recording pause sets recording_paused', async () => {
  const step = await advanceSingleStep(createRuntimeContext(recordingGraph('pause')), {
    roomName: 'room-1',
    sideEffects: { executeRecording: async () => ({ success: true }) },
  });
  assert.equal(step.context.variables.recording_paused, 'true');
});

test('recording resume clears pause flag', async () => {
  const step = await advanceSingleStep(createRuntimeContext(recordingGraph('resume')), {
    roomName: 'room-1',
    sideEffects: { executeRecording: async () => ({ success: true }) },
  });
  assert.equal(step.context.variables.recording_paused, 'false');
});

test('recording start skipped when compliance_ack=false', async () => {
  let called = false;
  const step = await advanceSingleStep(
    createRuntimeContext(recordingGraph('start'), { compliance_ack: 'false' }),
    {
      roomName: 'room-1',
      sideEffects: {
        executeRecording: async () => {
          called = true;
          return { success: true, egressId: 'eg-should-not' };
        },
      },
    }
  );
  assert.equal(called, false);
  assert.equal(step.context.variables.recording_skipped, 'consent_declined');
  assert.equal(step.context.variables.recording_paused, 'true');
  assert.equal(step.nextNodeId, 'next');
});
