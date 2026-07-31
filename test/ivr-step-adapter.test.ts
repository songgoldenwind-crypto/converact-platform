import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToStepNode } from '../src/agent-runtime/ivr/ivr-step-adapter.js';
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

test('Step IVR: menu maps to prompt chain ending in dtmf_menu', async () => {
  const step = await advanceSingleStep(createRuntimeContext(playMenuGraph()));
  const node = ivrActionToStepNode(step.action);
  assert.equal(node?.type, 'prompt');
  assert.equal(node?.tts_text, 'welcome-one');

  let tail = node?.next as Record<string, unknown>;
  assert.equal(tail?.type, 'prompt');
  assert.equal(tail?.tts_text, 'welcome-two');

  tail = tail?.next as Record<string, unknown>;
  assert.equal(tail?.type, 'dtmf_menu');
  assert.equal(tail?.tts_text, 'press 1');
  assert.equal(tail?.timeout_ms, 10000);
});

test('Step IVR: transfer maps to queue', async () => {
  let ctx = createRuntimeContext(playMenuGraph());
  ctx = (await advanceSingleStep(ctx)).context;
  ctx = (await advanceSingleStep(ctx, { dtmf: '1' })).context;
  const transfer = await advanceSingleStep(ctx);
  const node = ivrActionToStepNode(transfer.action);
  assert.deepEqual(node, { type: 'queue', queue: 'sales' });
});
