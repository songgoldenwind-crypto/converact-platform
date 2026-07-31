import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToRwi } from '../src/agent-runtime/ivr/ivr-rwi-bridge.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

function playFlushMenuGraph(): IvrFlowGraph {
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
            { playType: 'tts', text: 'one' },
            { playType: 'tts', text: 'two' },
          ],
        },
      },
      {
        id: 'f1',
        type: 'flush_audio',
        name: 'Flush',
        position: { x: 100, y: 0 },
        data: {},
      },
      {
        id: 'm1',
        type: 'menu',
        name: 'Menu',
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
        position: { x: 300, y: 0 },
        data: { targetType: 'queue', targetValue: 'sales' },
      },
    ],
    edges: [
      { id: 'e1', source: 'p1', target: 'f1', sourceHandle: 'out' },
      { id: 'e2', source: 'f1', target: 'm1', sourceHandle: 'out' },
      { id: 'e3', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
    ],
  };
}

test('flush_audio with queued audio emits flush_play_queue and waits', async () => {
  let ctx = createRuntimeContext(playFlushMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  const flush = await advanceSingleStep(ctx);
  assert.equal(flush.context.currentNodeId, 'f1');
  assert.equal(flush.action.kind, 'flush_play_queue');
  if (flush.action.kind === 'flush_play_queue') {
    assert.equal(flush.action.promptQueue.length, 2);
    assert.equal(flush.action.promptQueue[0]?.text, 'one');
  }
  assert.equal(flush.context.pendingFlushAudio, 'f1');
  assert.equal(flush.context.audioQueue?.length, 2);
});

test('flushCompleted clears queue and walks to menu', async () => {
  let ctx = createRuntimeContext(playFlushMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  ctx = (await advanceSingleStep(ctx)).context;
  const done = await advanceSingleStep(ctx, { flushCompleted: true });
  assert.equal(done.context.currentNodeId, 'm1');
  assert.equal(done.context.pendingFlushAudio, undefined);
  assert.equal(done.context.audioQueue?.length ?? 0, 0);
  assert.equal(done.action.kind, 'menu');
});

test('flush_audio with empty queue passthrough to out', async () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'f1',
    variables: [],
    nodes: [
      { id: 'f1', type: 'flush_audio', name: 'Flush', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'm1',
        type: 'menu',
        name: 'Menu',
        position: { x: 100, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: 'menu' }],
          options: [],
          timeoutSec: 5,
          maxRetries: 1,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'f1', target: 'm1', sourceHandle: 'out' }],
  };
  const step = await advanceSingleStep(createRuntimeContext(graph));
  assert.equal(step.context.currentNodeId, 'm1');
  assert.equal(step.action.kind, 'menu');
});

test('flush_audio pending does not re-emit flush_play_queue', async () => {
  let ctx = createRuntimeContext(playFlushMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  ctx = (await advanceSingleStep(ctx)).context;
  const pending = await advanceSingleStep(ctx);
  assert.equal(pending.action.kind, 'log');
  if (pending.action.kind === 'log') {
    assert.equal(pending.action.message, 'flush_audio pending');
  }
  assert.equal(pending.context.pendingFlushAudio, 'f1');
});

test('play menu transfer: welcome not replayed at transfer flush', async () => {
  let ctx = createRuntimeContext(playFlushMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  ctx = (await advanceSingleStep(ctx)).context;
  ctx = (await advanceSingleStep(ctx, { flushCompleted: true })).context;
  ctx = (await advanceSingleStep(ctx, { dtmf: '1' })).context;
  const transfer = await advanceSingleStep(ctx);
  assert.equal(transfer.action.kind, 'transfer');
  assert.equal(transfer.context.audioQueue?.length ?? 0, 0);
});

test('RWI maps flush_play_queue command', async () => {
  let ctx = createRuntimeContext(playFlushMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  const flush = await advanceSingleStep(ctx);
  const rwi = ivrActionToRwi(flush.action, 'call-flush');
  assert.equal(rwi?.command, 'flush_play_queue');
  const queue = (rwi?.params as { prompt_queue?: Array<{ prompt?: string }> }).prompt_queue;
  assert.equal(queue?.length, 2);
  assert.equal(queue?.[0]?.prompt, 'one');
});
