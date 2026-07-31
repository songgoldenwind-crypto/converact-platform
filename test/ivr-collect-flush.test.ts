import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function playCollectGraph(): IvrFlowGraph {
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
        data: { contents: [{ playType: 'tts', text: 'welcome' }] },
      },
      {
        id: 'c1',
        type: 'collect',
        name: 'C',
        position: { x: 100, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'enter account' }],
          minDigits: 4,
          maxDigits: 6,
          storeVariable: 'account',
        },
      },
      { id: 'dc', type: 'disconnect', name: 'End', position: { x: 200, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'c1', sourceHandle: 'out' },
      { id: 'e2', source: 'c1', target: 'dc', sourceHandle: 'out' },
    ],
  };
}

test('play queue + collect: prompt_queue with enqueued + collect prompt', async () => {
  const step = await advanceSingleStep(createRuntimeContext(playCollectGraph()));
  assert.equal(step.context.currentNodeId, 'c1');
  assert.equal(step.action.kind, 'collect_digits');
  if (step.action.kind === 'collect_digits') {
    assert.equal(step.action.promptQueue?.length, 2);
    assert.equal(step.action.promptQueue?.[0]?.text, 'welcome');
    assert.equal(step.action.promptQueue?.[1]?.text, 'enter account');
  }
  const rwi = ivrActionToRwi(step.action, 'call-col');
  assert.equal(rwi?.command, 'gather_digits');
  const queue = (rwi?.params as { prompt_queue?: Array<{ prompt?: string }> }).prompt_queue;
  assert.equal(queue?.length, 2);
  assert.equal(queue?.[0]?.prompt, 'welcome');
  assert.equal(queue?.[1]?.prompt, 'enter account');
});

test('collect without upstream queue: prompt_queue is collect prompt only', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'c1',
    variables: [],
    nodes: [
      {
        id: 'c1',
        type: 'collect',
        name: 'C',
        position: { x: 0, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'pin' }],
          minDigits: 4,
          maxDigits: 4,
          storeVariable: 'pin',
        },
      },
      { id: 'dc', type: 'disconnect', name: 'End', position: { x: 100, y: 0 }, data: {} },
    ],
    edges: [{ id: 'e1', source: 'c1', target: 'dc', sourceHandle: 'out' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph));
  assert.equal(step.action.kind, 'collect_digits');
  if (step.action.kind === 'collect_digits') {
    assert.equal(step.action.promptQueue?.length, 1);
    assert.equal(step.action.promptQueue?.[0]?.text, 'pin');
  }
});
