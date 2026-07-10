/**
 * Production seat-bridge for IVR transfer (audit P0 / 校准 — todo transfer 去 stub).
 *
 * Replaces the {ok:true} fake-success stub. Drives the REAL
 * createProductionSideEffects factory (ivr-production-effects.ts) with an
 * in-memory SQLite db seeded with seats + a voice call session, then advances
 * an IVR transfer node. Asserts the real CallTransferService.transfer path is
 * reached and that the {ok,reason} contract the transfer handler needs
 * (ivr-transfer-handler.ts:226-251) is honoured — so OUT / failed branches
 * route correctly instead of the flow sticking in a waiting state.
 *
 * Scope mirrored in production code: only seat_id + single-seat group_call are
 * bridged. extension/queue/phone and missing-from-seat fail LOUD (explicit
 * {ok:false,reason:'failed'}) rather than the prior silent fake success.
 *
 * busy/no_answer edges are NOT asserted here: CallTransferService.transfer
 * (blind) only returns 'completed' or throws — see the production-effects
 * JSDoc explaining this is reserved for a future dial path with call-leg
 * state. Asserting them here would be theatre.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { createProductionSideEffects } from '../src/agent-runtime/ivr/ivr-production-effects.js';
import { advanceSingleStep, createRuntimeContext } from '../src/agent-runtime/ivr/ivr-executor.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';

const TENANT_NAME = 'IVR Xfer Prod Bridge';

function seedSessionAndSeats(db: unknown): { tenantId: string; callSessionId: string; fromSeatId: string; targetSeatId: string } {
  // Tenant row must exist first — voice_call_sessions FK references tenants(id).
  const tenant = createTenant(db, { name: TENANT_NAME });
  const tenantId = tenant.id;
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const session = voiceStore.createCallSession({ tenant_id: tenantId, direction: 'inbound', status: 'active' });
  const fromSeat = seatStore.upsertSeat({ tenant_id: tenantId, user_id: 'u-from', display_name: 'From Seat' });
  const targetSeat = seatStore.upsertSeat({ tenant_id: tenantId, user_id: 'u-target', display_name: 'Target Seat' });
  return { tenantId, callSessionId: session.id, fromSeatId: fromSeat.id, targetSeatId: targetSeat.id };
}

function transferGraph(targetType: string, targetValue: string, opts: { fromSeatId?: string; memberSeatIds?: string[] } = {}): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 't1',
    variables: [],
    nodes: [
      {
        id: 't1',
        type: 'transfer',
        name: 'T',
        position: { x: 0, y: 0 },
        data: {
          targetType,
          targetValue,
          fromSeatId: opts.fromSeatId,
          memberSeatIds: opts.memberSeatIds,
          connectTimeoutSec: 5,
        } as Record<string, unknown>,
      },
      { id: 'ok', type: 'play', name: 'OK', position: { x: 200, y: 0 }, data: { contents: [{ playType: 'tts', text: 'ok' }] } },
      { id: 'fail', type: 'play', name: 'F', position: { x: 200, y: 120 }, data: { contents: [{ playType: 'tts', text: 'fail' }] } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'ok', sourceHandle: 'out' },
      { id: 'e2', source: 't1', target: 'fail', sourceHandle: 'failed' },
    ],
  };
}

// ─── Happy path: seat_id bridge succeeds → routes to OUT, real bridge mutates seats ─
test('production executeTransfer seat_id success → connected → OUT edge; real seat status mutates', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, fromSeatId, targetSeatId } = seedSessionAndSeats(db);
  const seatStore = new AgentSeatStore(db);

  const effects = createProductionSideEffects(db, tenantId);
  const step = await advanceSingleStep(createRuntimeContext(transferGraph('seat_id', targetSeatId, { fromSeatId })), {
    sideEffects: effects,
    callSessionId,
  });

  assert.equal(step.nextNodeId, 'ok', 'seat bridge success must route to OUT edge');
  assert.equal(step.context.variables.transfer_result, 'connected');
  assert.equal(step.context.waiting, undefined, 'must NOT stick in waiting state (the old stub behaviour)');

  // The real CallTransferService.transfer(blind) sets target busy + source wrap_up.
  assert.equal(seatStore.getSeat(targetSeatId)?.status, 'busy', 'target seat must become busy via real bridge');
  assert.equal(seatStore.getSeat(fromSeatId)?.status, 'wrap_up', 'source seat must enter wrap_up via real bridge');
});

// ─── fromSeatId resolved from variable when not in nodeData ─────────────────
test('production executeTransfer picks up from_seat_id from variables', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, fromSeatId, targetSeatId } = seedSessionAndSeats(db);
  const effects = createProductionSideEffects(db, tenantId);

  const graph = transferGraph('seat_id', targetSeatId); // no fromSeatId in nodeData
  const ctx = createRuntimeContext(graph);
  ctx.variables.from_seat_id = fromSeatId;

  const step = await advanceSingleStep(ctx, { sideEffects: effects, callSessionId });
  assert.equal(step.nextNodeId, 'ok');
  assert.equal(step.context.variables.transfer_result, 'connected');
});

// ─── group_call single-seat resolves and bridges ───────────────────────────
test('production executeTransfer group_call with one resolved seat → OUT', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, fromSeatId, targetSeatId } = seedSessionAndSeats(db);
  const effects = createProductionSideEffects(db, tenantId);

  const step = await advanceSingleStep(
    createRuntimeContext(transferGraph('group_call', 'gc-1', { fromSeatId, memberSeatIds: [targetSeatId] })),
    { sideEffects: effects, callSessionId }
  );
  assert.equal(step.nextNodeId, 'ok', 'single-seat group_call must bridge through');
  assert.equal(step.context.variables.transfer_result, 'connected');
});

// ─── group_call multi-seat: not yet implemented → explicit failed (not fake ok) ─
test('production executeTransfer group_call multi-seat → failed (loud, not fake success)', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, fromSeatId } = seedSessionAndSeats(db);
  const effects = createProductionSideEffects(db, tenantId);

  const step = await advanceSingleStep(
    createRuntimeContext(transferGraph('group_call', 'gc-2', { fromSeatId, memberSeatIds: ['s1', 's2'] })),
    { sideEffects: effects, callSessionId }
  );
  assert.equal(step.nextNodeId, 'fail', 'multi-seat dial must fail loud into failed edge');
  assert.equal(step.context.variables.transfer_result, 'failed');
  assert.match(step.context.variables.last_error ?? '', /exactly one resolved member seat|not implemented/i);
});

// ─── unsupported targetType (extension/queue/phone) → failed, never ok:true ───
test('production executeTransfer unsupported targetType (phone) → failed, never fake success', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, fromSeatId } = seedSessionAndSeats(db);
  const effects = createProductionSideEffects(db, tenantId);

  const step = await advanceSingleStep(
    createRuntimeContext(transferGraph('phone', '+819012345678', { fromSeatId })),
    { sideEffects: effects, callSessionId }
  );
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.transfer_result, 'failed');
  assert.match(step.context.variables.last_error ?? '', /not yet supported via call transfer service/i);
});

// ─── missing fromSeatId (AI-only session) → failed, not silent waiting ───────
test('production executeTransfer without a source seat → failed (no more silent waiting)', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, targetSeatId } = seedSessionAndSeats(db);
  const effects = createProductionSideEffects(db, tenantId);

  // No fromSeatId in nodeData, no from_seat_id/current_seat_id variables.
  const step = await advanceSingleStep(createRuntimeContext(transferGraph('seat_id', targetSeatId)), {
    sideEffects: effects,
    callSessionId,
  });
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.transfer_result, 'failed');
  assert.match(step.context.variables.last_error ?? '', /source seat/i);
});

// ─── target seat missing → CallTransferService throws → failed (not ok:true) ─
test('production executeTransfer with non-existent target seat → failed via thrown error', async () => {
  const db = createDatabase(':memory:');
  const { tenantId, callSessionId, fromSeatId } = seedSessionAndSeats(db);
  const effects = createProductionSideEffects(db, tenantId);

  const step = await advanceSingleStep(
    createRuntimeContext(transferGraph('seat_id', 'seat-does-not-exist', { fromSeatId })),
    { sideEffects: effects, callSessionId }
  );
  assert.equal(step.nextNodeId, 'fail');
  assert.equal(step.context.variables.transfer_result, 'failed');
  assert.match(step.context.variables.last_error ?? '', /target seat not found/i, 'CallTransferService 404 must surface');
});