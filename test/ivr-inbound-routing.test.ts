import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { startIvrSession, advanceIvrStep, resolveIvrRoute } from '../src/agent-runtime/ivr/ivr-inbound-routing.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';

const baseSampleGraph: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
    { id: 'play1', type: 'play', name: '欢迎', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: '欢迎致电' }] } },
    { id: 'menu1', type: 'menu', name: '菜单', position: { x: 400, y: 0 }, data: {
      prompt: [{ playType: 'tts', text: '按1销售' }],
      options: [{ digit: '1', label: '销售', routeType: 'node', routeTarget: '' }],
      timeoutSec: 5, maxRetries: 3,
    } },
    { id: 'transfer1', type: 'transfer', name: '转销售', position: { x: 600, y: 0 }, data: { targetType: 'queue', targetValue: 'sales' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'play1', sourceHandle: 'out' },
    { id: 'e2', source: 'play1', target: 'menu1', sourceHandle: 'out' },
    { id: 'e3', source: 'menu1', target: 'transfer1', sourceHandle: 'digit_1' },
  ],
  variables: [],
};

const sampleGraph = withCompleteMenuEdges(baseSampleGraph, 'menu1');

function setupWithFlow() {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Inbound Test' });
  const store = new IvrFlowStore(db);
  const flow = store.saveFlow(tenant.id, 'ivr_flow_1', '售后IVR', sampleGraph);
  store.publishFlow(tenant.id, flow.id);
  return { db, tenantId: tenant.id, flowId: flow.id };
}

test('resolveIvrRoute returns first prompt when a published flow exists', async () => {
  const { db, tenantId } = setupWithFlow();
  const route = await resolveIvrRoute(db, tenantId, 'call-session-1');
  assert.equal(route.action, 'ivr');
  assert.equal(route.hasFlow, true);
  if (route.hasFlow) {
    assert.ok(route.flowId);
    assert.ok(route.firstPrompt.includes('欢迎') || route.firstPrompt.includes('按1'));
    assert.ok(route.session);
  }
});

test('resolveIvrRoute returns hasFlow=false when no flow exists', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'No IVR' });
  const route = await resolveIvrRoute(db, tenant.id, 'call-session-x');
  assert.equal(route.action, 'ivr');
  assert.equal(route.hasFlow, false);
});

test('startIvrSession loads the published flow', () => {
  const { db, tenantId, flowId } = setupWithFlow();
  const session = startIvrSession(db, tenantId, 'call-1', flowId);
  assert.ok(session);
  assert.equal(session!.flowId, flowId);
  assert.equal(session!.context.currentNodeId, 'start');
  assert.equal(session!.terminated, false);
});

test('startIvrSession returns null when no flow configured', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Empty' });
  const session = startIvrSession(db, tenant.id, 'call-1');
  assert.equal(session, null);
});

test('advanceIvrStep executes start then play walks to menu', async () => {
  const { db, tenantId, flowId } = setupWithFlow();
  const session = startIvrSession(db, tenantId, 'call-1', flowId);
  assert.ok(session);
  const first = await advanceIvrStep(session!, db);
  assert.equal(first.action!.kind, 'log');
  assert.equal(first.state.context.currentNodeId, 'play1');

  const second = await advanceIvrStep(first.state, db);
  assert.equal(second.action!.kind, 'menu');
  assert.equal(second.state.context.currentNodeId, 'menu1');
  assert.equal(second.state.context.audioQueue?.length ?? 0, 0);
  assert.equal(second.state.context.pendingAdvanceNodeId, undefined);
});

test('resolveIvrRoute injects channelVariables into start pushParams', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'IVR Channel Vars' });
  const store = new IvrFlowStore(db);
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    variables: [],
    nodes: [
      {
        id: 'start',
        type: 'start',
        name: '开始',
        position: { x: 0, y: 0 },
        data: {
          pushParams: [{ key: 'region', source: 'channel.caller_area_code' }],
        },
      },
      {
        id: 'play1',
        type: 'play',
        name: '欢迎',
        position: { x: 200, y: 0 },
        data: { contents: [{ playType: 'tts', text: '欢迎' }] },
      },
      { id: 'end', type: 'disconnect', name: '结束', position: { x: 400, y: 0 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'play1', sourceHandle: 'out' },
      { id: 'e2', source: 'play1', target: 'end', sourceHandle: 'out' },
    ],
  };
  const flow = store.saveFlow(tenant.id, 'ivr_ch', 'Channel', graph);
  store.publishFlow(tenant.id, flow.id);

  const route = await resolveIvrRoute(db, tenant.id, 'call-ch', flow.id, {
    channelVariables: { caller_area_code: '021' },
  });
  assert.equal(route.hasFlow, true);
  if (route.hasFlow) {
    assert.equal(route.session.context.variables.region, '021');
    assert.equal(route.session.channelVariables?.caller_area_code, '021');
  }
});

test('advanceIvrStep on terminated session stays terminated', async () => {
  const { db, tenantId, flowId } = setupWithFlow();
  const session = startIvrSession(db, tenantId, 'call-1', flowId);
  assert.ok(session);
  session!.terminated = true;
  const { terminated } = await advanceIvrStep(session!, db);
  assert.equal(terminated, true);
});
