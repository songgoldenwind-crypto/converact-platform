import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { advanceIvrStep } from '../src/agent-runtime/ivr/ivr-inbound-routing.js';
import { createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const baseGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
    {
      id: 'p1',
      type: 'play',
      name: 'P',
      position: { x: 100, y: 0 },
      data: { contents: [{ playType: 'tts', text: 'welcome' }], bargeIn: true },
    },
    {
      id: 'm1',
      type: 'menu',
      name: 'M',
      position: { x: 200, y: 0 },
      data: {
        prompt: [{ playType: 'tts', text: 'menu' }],
        options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
        timeoutSec: 5,
        maxRetries: 3,
      },
    },
    { id: 't1', type: 'transfer', name: 'T', position: { x: 300, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'p1', sourceHandle: 'out' },
    { id: 'e2', source: 'p1', target: 'm1', sourceHandle: 'out' },
    { id: 'e3', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
  ],
  variables: [],
};

afterEach(() => {
  delete process.env.IVR_BARGE_IN_PRODUCTION;
});

function menuGatherState(graph: IvrFlowGraph, callSessionId: string, tenantId: string, flowId: string) {
  const ctx = createRuntimeContext(graph);
  return {
    callSessionId,
    tenantId,
    flowId,
    context: {
      ...ctx,
      currentNodeId: 'm1',
      audioQueue: [{ text: 'welcome', promptType: 'tts' as const, interruptible: true, sourceNodeId: 'p1' }],
      interaction: { nodeId: 'm1', kind: 'menu' as const, awaiting: true as const },
    },
    stepCount: 2,
    terminated: false,
    lastAction: {
      kind: 'menu' as const,
      prompt: 'menu',
      options: [{ digit: '1', label: 'one' }],
      node: 'm1',
      promptQueue: [
        { text: 'welcome', promptType: 'tts' as const, interruptible: true },
        { text: 'menu', promptType: 'tts' as const },
      ],
    },
  };
}

test('E1: graph-configured queued menu barge-in works without an environment gate', async () => {
  delete process.env.IVR_BARGE_IN_PRODUCTION;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Barge E1' });
  const store = new IvrFlowStore(db);
  const graph = withCompleteMenuEdges(baseGraph, 'm1');
  store.saveFlow(tenant.id, 'ivr_barge_1', 'barge', graph);
  store.publishFlow(tenant.id, 'ivr_barge_1');

  const state = menuGatherState(graph, 'call-1', tenant.id, 'ivr_barge_1');
  const step = await advanceIvrStep(state, db, { dtmf: '1' });
  assert.equal(step.state.context.pendingDigits, '1');
  assert.equal(step.state.context.audioQueue?.length ?? 0, 0);
});

test('E1: deprecated IVR_BARGE_IN_PRODUCTION does not change queued gather semantics', async () => {
  process.env.IVR_BARGE_IN_PRODUCTION = '1';
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Barge E1 Gate' });
  const store = new IvrFlowStore(db);
  const graph = withCompleteMenuEdges(baseGraph, 'm1');
  store.saveFlow(tenant.id, 'ivr_barge_2', 'barge', graph);
  store.publishFlow(tenant.id, 'ivr_barge_2');

  const state = menuGatherState(graph, 'call-2', tenant.id, 'ivr_barge_2');
  const step = await advanceIvrStep(state, db, { dtmf: '1' });
  assert.equal(step.state.context.pendingDigits, '1');
  assert.equal(step.state.context.audioQueue?.length ?? 0, 0);
});
