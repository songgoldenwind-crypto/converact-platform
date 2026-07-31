import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { TransferOrchestrator } from '../src/agent-runtime/call-center/transfer-orchestrator.js';

function setup() {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Transfer Test' });
  const seatStore = new AgentSeatStore(db);
  const voiceStore = new VoiceStore(db);
  const orchestrator = new TransferOrchestrator(seatStore, voiceStore);

  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    status: 'active',
    phone: '+81300001111'
  });

  return { db, tenant, seatStore, voiceStore, orchestrator, session };
}

test('assigns available seat when idle seats exist', () => {
  const { tenant, seatStore, orchestrator, session } = setup();
  const seat = seatStore.upsertSeat({
    tenant_id: tenant.id,
    user_id: 'agent-1',
    display_name: 'Agent One',
    skills: ['japanese']
  });
  seatStore.updateStatus(tenant.id, seat.id, 'idle');

  const result = orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-1'
  });

  assert.equal(result.action_taken, 'seat_assigned');
  assert.ok(result.seat);
  assert.equal(result.seat.id, seat.id);
  assert.equal(result.seat.display_name, 'Agent One');
});

test('returns no_seats_available when all seats are busy', () => {
  const { tenant, seatStore, orchestrator, session } = setup();
  const seat = seatStore.upsertSeat({
    tenant_id: tenant.id,
    user_id: 'agent-2',
    display_name: 'Agent Two'
  });
  seatStore.updateStatus(tenant.id, seat.id, 'busy');

  const result = orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-2'
  });

  assert.equal(result.action_taken, 'no_seats_available');
  assert.equal(result.seat, undefined);
});

test('updates seat status to busy after assignment', () => {
  const { tenant, seatStore, orchestrator, session } = setup();
  const seat = seatStore.upsertSeat({
    tenant_id: tenant.id,
    user_id: 'agent-3',
    display_name: 'Agent Three'
  });
  seatStore.updateStatus(tenant.id, seat.id, 'idle');

  orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-3'
  });

  const updated = seatStore.getSeat(seat.id);
  assert.equal(updated?.status, 'busy');
  assert.equal(updated?.current_call_session_id, session.id);
});

test('updates call session metadata with transfer info', () => {
  const { tenant, seatStore, voiceStore, orchestrator, session } = setup();
  const seat = seatStore.upsertSeat({
    tenant_id: tenant.id,
    user_id: 'agent-4',
    display_name: 'Agent Four'
  });
  seatStore.updateStatus(tenant.id, seat.id, 'idle');

  orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-4',
    reason: 'customer requested'
  });

  const updatedSession = voiceStore.getCallSession(tenant.id, session.id);
  assert.equal(updatedSession.metadata.transferred_to_seat_id, seat.id);
  assert.equal(updatedSession.metadata.transferred_to_user, 'Agent Four');
  assert.equal(updatedSession.metadata.transfer_reason, 'customer requested');
  assert.ok(updatedSession.metadata.transfer_at);
});

test('returns correct language messages', () => {
  const { tenant, orchestrator, session } = setup();

  const zhResult = orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-zh'
  });
  assert.ok(zhResult.message_for_customer.includes('坐席'));

  const enResult = orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-en',
    language: 'en'
  });
  assert.ok(enResult.message_for_customer.includes('agents'));

  const jaResult = orchestrator.execute({
    tenantId: tenant.id,
    callSessionId: session.id,
    roomName: 'room-ja',
    language: 'ja'
  });
  assert.ok(jaResult.message_for_customer.includes('担当者'));
});
