import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { ivrActionToStepNode } from '../src/agent-runtime/ivr/ivr-step-adapter.js';
import { IvrSessionStore } from '../src/agent-runtime/ivr/ivr-session-store.js';
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

test('IvrSessionStore persists lastAction for Step IVR session_start replay', async () => {
  const db = createDatabase(':memory:');
  const store = new IvrSessionStore(db);
  const step = await advanceSingleStep(createRuntimeContext(playMenuGraph()));
  assert.equal(step.action.kind, 'menu');

  store.upsert({
    callSessionId: 'vsession_test',
    tenantId: 'tenant_a',
    flowId: 'flow_m1',
    context: step.context,
    stepCount: 1,
    terminated: false,
    lastAction: step.action,
  });

  const loaded = store.get('vsession_test', 'tenant_a');
  assert.ok(loaded?.last_action);
  assert.equal(loaded.last_action?.kind, 'menu');

  const node = ivrActionToStepNode(loaded.last_action);
  assert.equal(node?.type, 'prompt');
  assert.equal(node?.tts_text, 'welcome-one');
  const tail = node?.next as Record<string, unknown>;
  assert.equal(tail?.type, 'prompt');
  assert.equal(tail?.tts_text, 'welcome-two');
  const menu = tail?.next as Record<string, unknown>;
  assert.equal(menu?.type, 'dtmf_menu');
  assert.equal(menu?.tts_text, 'press 1');
});
