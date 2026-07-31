import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function playMenuGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'p1',
    variables: [],
    nodes: [
      {
        id: 'p1',
        type: 'play',
        name: 'Welcome',
        position: { x: 0, y: 0 },
        data: {
          contents: [
            { playType: 'tts', text: 'welcome-one' },
            { playType: 'tts', text: 'welcome-two' },
          ],
        },
      },
      {
        id: 'm1',
        type: 'menu',
        name: 'Main',
        position: { x: 200, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'press 1' }],
          options: [{ digit: '1', label: 'sales', routeType: 'node', routeTarget: 't1' }],
          timeoutSec: 10,
          maxRetries: 1,
        },
      },
      {
        id: 't1',
        type: 'transfer',
        name: 'Sales',
        position: { x: 400, y: 0 },
        data: { targetType: 'queue', targetValue: 'sales' },
      },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'm1', sourceHandle: 'out' },
      { id: 'e2', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
    ],
  };
}

test('M1: play enqueues segments and advances to menu without per-segment play action', async () => {
  const step = await advanceSingleStep(createRuntimeContext(playMenuGraph()));
  assert.equal(step.context.currentNodeId, 'm1');
  assert.equal(step.context.audioQueue?.length ?? 0, 0);
  assert.equal(step.action.kind, 'menu');
});

test('M1: menu RWI includes prompt_queue with enqueued + menu prompt', async () => {
  const step = await advanceSingleStep(createRuntimeContext(playMenuGraph()));
  const rwi = ivrActionToRwi(step.action, 'call-m1');
  assert.equal(rwi?.command, 'gather_digits');
  const queue = (rwi?.params as { prompt_queue?: Array<{ prompt?: string }> }).prompt_queue;
  assert.equal(queue?.length, 3);
  assert.equal(queue?.[0]?.prompt, 'welcome-one');
  assert.equal(queue?.[1]?.prompt, 'welcome-two');
  assert.equal(queue?.[2]?.prompt, 'press 1');
});

test('M1: menu route to transfer does not replay flushed welcome', async () => {
  let ctx = createRuntimeContext(playMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  ctx = (await advanceSingleStep(ctx, { dtmf: '1' })).context;
  const transfer = await advanceSingleStep(ctx);
  assert.equal(transfer.action.kind, 'transfer');
  assert.equal(transfer.context.audioQueue?.length ?? 0, 0);
});

test('M1: barge-in during queue clears audioQueue and passes digit to menu', async () => {
  let ctx = createRuntimeContext(playMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  const stepped = await advanceSingleStep(ctx, { bargeInDigits: '1' });
  assert.equal(stepped.context.audioQueue?.length ?? 0, 0);
  assert.equal(stepped.context.pendingDigits, '1');
});
