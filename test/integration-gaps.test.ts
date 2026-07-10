import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { CallHoldService } from '../src/agent-runtime/call-center/agent-tools/call-hold.js';
import { CallTransferService } from '../src/agent-runtime/call-center/agent-tools/call-transfer.js';
import { WarmTransferBridgeService } from '../src/agent-runtime/call-center/agent-tools/warm-transfer-bridge.js';
import { ConferenceService } from '../src/agent-runtime/call-center/agent-tools/conference.js';
import { computePredictiveDialPlan, isPredictiveStrategy } from '../src/agent-runtime/call-center/dialer/predictive-engine.js';
import { transcribeVoicemailRecording } from '../src/agent-runtime/call-center/agent-tools/voicemail-transcribe.js';

before(() => {
  useMemoryRedisForTests();
});

test('predictive engine scales with idle agents and slows on abandon', () => {
  const boost = computePredictiveDialPlan({
    idleAgents: 5,
    busyAgents: 1,
    ringingCalls: 0,
    answerRate: 0.4,
    abandonRate: 0.01
  });
  assert.ok(boost.concurrentDials >= 2);

  const slow = computePredictiveDialPlan({
    idleAgents: 5,
    busyAgents: 1,
    ringingCalls: 0,
    answerRate: 0.4,
    abandonRate: 0.08
  });
  assert.ok(slow.concurrentDials <= boost.concurrentDials);
  assert.equal(isPredictiveStrategy({ dial_mode: 'predictive' }), true);
});

test('hold service updates metadata and tolerates missing RWI', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Hold' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'rwi-hold-1',
    phone: '+8613900000033',
    status: 'active',
    metadata: { hold_music_url: 'https://example.com/hold.ogg' }
  });

  const service = new CallHoldService(voiceStore);
  const held = await service.hold(tenant.id, session.id, 'seat-x');
  assert.equal(held.on_hold, true);
  assert.equal(held.rustpbx?.applied, false);

  const resumed = await service.resume(tenant.id, session.id, 'seat-x');
  assert.equal(resumed.on_hold, false);
});

test('warm transfer bridge prepares consult room', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Warm' });
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const fromSeat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'A' });
  const targetSeat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u2', display_name: 'B' });
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'rwi-warm-1',
    phone: '+8613900000022',
    status: 'active'
  });

  const bridge = new WarmTransferBridgeService(voiceStore, seatStore, roomStore);
  const consult = await bridge.prepareConsult(tenant.id, session.id, fromSeat.id, targetSeat.id);
  assert.ok(consult.consult_room_name.includes('warm'));
  assert.ok(consult.target_invite?.token);
});

test('warm transfer consult refuses a closed media room', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Warm Closed' });
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const fromSeat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'A' });
  const targetSeat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u2', display_name: 'B' });
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'rwi-warm-closed',
    phone: '+8613900000044',
    status: 'active'
  });
  const room = await roomStore.createRoom({
    tenant_id: tenant.id,
    purpose: 'conference',
    call_session_id: session.id,
    metadata: { warm_transfer: true }
  });
  roomStore.closeRoom(room.room_name);

  const bridge = new WarmTransferBridgeService(voiceStore, seatStore, roomStore);
  await assert.rejects(
    () => bridge.prepareConsult(tenant.id, session.id, fromSeat.id, targetSeat.id),
    /media room is closed/
  );
});

test('conference invite refuses a closed media room', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Conference Closed' });
  const voiceStore = new VoiceStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'rwi-conf-closed',
    phone: '+8613900000055',
    status: 'active'
  });
  const room = await roomStore.createRoom({
    tenant_id: tenant.id,
    purpose: 'conference',
    call_session_id: session.id,
    metadata: { conference: true }
  });
  roomStore.closeRoom(room.room_name);

  const conference = new ConferenceService(voiceStore, roomStore);
  await assert.rejects(
    () =>
      conference.addParticipant({
        tenantId: tenant.id,
        callSessionId: session.id,
        seatId: 'seat-1',
        participantIdentity: 'customer-closed'
      }),
    /media room is closed/
  );
});

test('warm transfer complete updates pending metadata', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Warm2' });
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const fromSeat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'A' });
  const targetSeat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u2', display_name: 'B' });
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'rwi-warm-2',
    phone: '+8613900000011',
    status: 'active',
    metadata: {
      warm_transfer_pending: true,
      warm_transfer_from_seat_id: fromSeat.id,
      warm_transfer_target_seat_id: targetSeat.id
    }
  });

  const service = new CallTransferService(voiceStore, seatStore, roomStore);
  const result = service.completeWarmTransfer({
    tenantId: tenant.id,
    callSessionId: session.id,
    fromSeatId: fromSeat.id,
    targetSeatId: targetSeat.id
  });
  assert.equal(result.status, 'completed');
});

test('voicemail transcribe returns empty without ASR configured', async () => {
  const original = process.env.OPC_ASR_API_URL;
  delete process.env.OPC_ASR_API_URL;
  delete process.env.ASR_API_URL;
  const result = await transcribeVoicemailRecording('');
  assert.equal(result.source, 'empty');
  if (original) process.env.OPC_ASR_API_URL = original;
});
