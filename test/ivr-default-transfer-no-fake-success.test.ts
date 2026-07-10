/**
 * defaultSideEffects.executeTransfer must not pretend success (stuck waiting forever).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSideEffects } from '../src/agent-runtime/ivr/ivr-side-effects.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

test('defaultSideEffects.executeTransfer fails loud (not ok:true)', async () => {
  const result = await defaultSideEffects.executeTransfer!(
    { targetType: 'seat_id', targetValue: 'seat-1' },
    {},
    'call-sim'
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.ok(result.error);
});

test('advance with defaultSideEffects routes transfer to failed edge (no stuck waiting)', async () => {
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
        data: { targetType: 'seat_id', targetValue: 'seat-1' },
      },
      {
        id: 'fail',
        type: 'play',
        name: 'F',
        position: { x: 200, y: 0 },
        data: { contents: [{ playType: 'tts', text: 'fail' }] },
      },
    ],
    edges: [{ id: 'e1', source: 't1', target: 'fail', sourceHandle: 'failed' }],
  };

  const step = await advanceSingleStep(createRuntimeContext(graph), {
    sideEffects: defaultSideEffects,
    callSessionId: 'call-default-xfer',
  });
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.waiting, undefined);
  assert.equal(step.context.variables.transfer_result, 'failed');
});
