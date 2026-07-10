/**
 * Remaining IVR hardening: optimistic session revision, barge-in gate,
 * production side-effects reuse, busy/no_answer contract.
 */
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { IvrSessionStore } from '../src/agent-runtime/ivr/ivr-session-store.js';
import { createProductionSideEffects, clearProductionSideEffectsCache } from '../src/agent-runtime/ivr/ivr-production-effects.js';
import { isBargeInProductionEnabled } from '../src/agent-runtime/ivr/ivr-production-gates.js';
import { advanceIvrStep } from '../src/agent-runtime/ivr/ivr-inbound-routing.js';
import { createRuntimeContext, advanceSingleStep } from '../src/agent-runtime/ivr/ivr-executor.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { withCompleteMenuEdges } from './helpers/ivr-complete-menu-graph.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import type { IvrRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function emptyCtx(): IvrRuntimeContext {
  return {
    graph: { version: 1, entryNodeId: 's', nodes: [], edges: [], variables: [] },
    currentNodeId: 's',
    variables: {},
    flowStack: [],
  };
}

afterEach(() => {
  delete process.env.IVR_BARGE_IN_PRODUCTION;
  clearProductionSideEffectsCache();
});

test('session upsert optimistic revision: stale write throws 409', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Rev' });
  const store = new IvrSessionStore(db);

  store.upsert({
    callSessionId: 'call-rev',
    tenantId: tenant.id,
    flowId: 'f1',
    context: emptyCtx(),
    stepCount: 1,
    terminated: false,
  });
  const v1 = store.get('call-rev', tenant.id);
  assert.ok(v1);
  assert.equal(v1.revision, 0);

  store.upsert({
    callSessionId: 'call-rev',
    tenantId: tenant.id,
    flowId: 'f1',
    context: emptyCtx(),
    stepCount: 2,
    terminated: false,
    expectedRevision: 0,
  });
  const v2 = store.get('call-rev', tenant.id);
  assert.equal(v2?.revision, 1);
  assert.equal(v2?.step_count, 2);

  assert.throws(
    () =>
      store.upsert({
        callSessionId: 'call-rev',
        tenantId: tenant.id,
        flowId: 'f1',
        context: emptyCtx(),
        stepCount: 99,
        terminated: false,
        expectedRevision: 0, // stale
      }),
    (err: unknown) => (err as { status?: number }).status === 409
  );
  assert.equal(store.get('call-rev', tenant.id)?.step_count, 2);
});

test('isBargeInProductionEnabled reads IVR_BARGE_IN_PRODUCTION', () => {
  assert.equal(isBargeInProductionEnabled(), false);
  process.env.IVR_BARGE_IN_PRODUCTION = '1';
  assert.equal(isBargeInProductionEnabled(), true);
});

test('production advance: plain dtmf during queued gather ignored when barge-in gate off', async () => {
  delete process.env.IVR_BARGE_IN_PRODUCTION;
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Barge gate off' });
  const store = new IvrFlowStore(db);
  const graph: IvrFlowGraph = withCompleteMenuEdges(
    {
      version: 1,
      entryNodeId: 'start',
      variables: [],
      nodes: [
        { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'm1',
          type: 'menu',
          name: 'M',
          position: { x: 100, y: 0 },
          data: {
            prompt: [{ playType: 'tts', text: 'menu' }],
            options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
            timeoutSec: 5,
            maxRetries: 3,
          },
        },
        {
          id: 't1',
          type: 'transfer',
          name: 'T',
          position: { x: 200, y: 0 },
          data: { targetType: 'seat_id', targetValue: 's1' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'm1', sourceHandle: 'out' },
        { id: 'e2', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
      ],
    },
    'm1'
  );
  store.saveFlow(tenant.id, 'ivr_gate_off', 'g', graph);
  store.publishFlow(tenant.id, 'ivr_gate_off');

  const ctx = createRuntimeContext(graph);
  const state = {
    callSessionId: 'call-gate-off',
    tenantId: tenant.id,
    flowId: 'ivr_gate_off',
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
      promptQueue: [{ text: 'menu', promptType: 'tts' as const }],
    },
  };

  const step = await advanceIvrStep(state, db, { dtmf: '1' });
  // Gate off: dtmf is NOT rewritten to bargeInDigits; queued audio remains.
  assert.equal(step.state.context.pendingDigits, undefined);
  assert.ok((step.state.context.audioQueue?.length ?? 0) > 0);
});

test('production advance: plain dtmf during queued gather becomes barge-in when gate on', async () => {
  process.env.IVR_BARGE_IN_PRODUCTION = '1';
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Barge gate on' });
  const store = new IvrFlowStore(db);
  const graph: IvrFlowGraph = withCompleteMenuEdges(
    {
      version: 1,
      entryNodeId: 'start',
      variables: [],
      nodes: [
        { id: 'start', type: 'start', name: 'S', position: { x: 0, y: 0 }, data: {} },
        {
          id: 'm1',
          type: 'menu',
          name: 'M',
          position: { x: 100, y: 0 },
          data: {
            prompt: [{ playType: 'tts', text: 'menu' }],
            options: [{ digit: '1', label: 'one', routeType: 'node', routeTarget: '' }],
            timeoutSec: 5,
            maxRetries: 3,
          },
        },
        {
          id: 't1',
          type: 'transfer',
          name: 'T',
          position: { x: 200, y: 0 },
          data: { targetType: 'seat_id', targetValue: 's1' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'm1', sourceHandle: 'out' },
        { id: 'e2', source: 'm1', target: 't1', sourceHandle: 'digit_1' },
      ],
    },
    'm1'
  );
  store.saveFlow(tenant.id, 'ivr_gate_on', 'g', graph);
  store.publishFlow(tenant.id, 'ivr_gate_on');

  const ctx = createRuntimeContext(graph);
  const state = {
    callSessionId: 'call-gate-on',
    tenantId: tenant.id,
    flowId: 'ivr_gate_on',
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
      promptQueue: [{ text: 'menu', promptType: 'tts' as const }],
    },
  };

  const step = await advanceIvrStep(state, db, { dtmf: '1' });
  assert.equal(step.state.context.pendingDigits, '1');
  assert.equal(step.state.context.audioQueue?.length ?? 0, 0);
});

test('createProductionSideEffects reuses instance per db+tenant', () => {
  const db = createDatabase(':memory:');
  const a = createProductionSideEffects(db, 't1');
  const b = createProductionSideEffects(db, 't1');
  const c = createProductionSideEffects(db, 't2');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('production sync transfer never returns busy/no_answer (only connected|failed)', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Busy contract' });
  const voice = new VoiceStore(db);
  const seats = new AgentSeatStore(db);
  const session = voice.createCallSession({ tenant_id: tenant.id, direction: 'inbound', status: 'active' });
  const from = seats.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'F' });
  const target = seats.upsertSeat({ tenant_id: tenant.id, user_id: 'u2', display_name: 'T' });
  const effects = createProductionSideEffects(db, tenant.id);

  const ok = await effects.executeTransfer!(
    { targetType: 'seat_id', targetValue: target.id, fromSeatId: from.id },
    {},
    session.id
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, 'connected');

  const fail = await effects.executeTransfer!(
    { targetType: 'seat_id', targetValue: 'missing', fromSeatId: from.id },
    {},
    session.id
  );
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, 'failed');
  assert.notEqual(fail.reason, 'busy');
  assert.notEqual(fail.reason, 'no_answer');
});

test('async transferEvent still routes busy/no_answer edges', async () => {
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
        data: { targetType: 'seat_id', targetValue: 's1' },
      },
      { id: 'busy', type: 'play', name: 'B', position: { x: 100, y: 0 }, data: { contents: [{ playType: 'tts', text: 'b' }] } },
      { id: 'na', type: 'play', name: 'N', position: { x: 100, y: 50 }, data: { contents: [{ playType: 'tts', text: 'n' }] } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'busy', sourceHandle: 'busy' },
      { id: 'e2', source: 't1', target: 'na', sourceHandle: 'no_answer' },
      { id: 'e3', source: 't1', target: 'busy', sourceHandle: 'failed' },
    ],
  };
  let ctx = createRuntimeContext(graph);
  ctx = (await advanceSingleStep(ctx, {})).context;
  assert.equal(ctx.waiting?.kind, 'transfer');
  const busy = await advanceSingleStep(ctx, { transferEvent: { kind: 'busy' } });
  assert.equal(busy.nextNodeId, 'busy');
});

test('migration 023_ivr_tenant_rls.sql exists and targets IVR tables', () => {
  const dir = join(process.cwd(), 'src/migrations');
  const files = readdirSync(dir);
  assert.ok(files.includes('023_ivr_tenant_rls.sql'), `got ${files.join(',')}`);
  const sql = readFileSync(join(dir, '023_ivr_tenant_rls.sql'), 'utf8');
  for (const table of [
    'ivr_sessions',
    'ivr_session_steps',
    'ivr_time_groups',
    'ivr_region_groups',
    'ivr_group_call_groups',
    'ivr_flow_history',
  ]) {
    assert.match(sql, new RegExp(table));
  }
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
});
