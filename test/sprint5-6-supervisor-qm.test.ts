import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { CallQueueStore } from '../src/agent-runtime/call-center/inbound/call-queue.js';
import { WallboardService } from '../src/agent-runtime/call-center/agent-tools/wallboard.js';
import { SupervisorService } from '../src/agent-runtime/call-center/agent-tools/supervisor.js';
import { VoicemailStore } from '../src/agent-runtime/call-center/agent-tools/voicemail.js';
import { ParkPickupService } from '../src/agent-runtime/call-center/agent-tools/park-pickup.js';
import { QmStore } from '../src/agent-runtime/call-center/qm/qm-store.js';
import { triggerAutoQmEvaluation } from '../src/agent-runtime/call-center/qm/auto-evaluate.js';
import { run } from '../src/db.js';
import { getWallboardCommand } from '../src/agent-runtime/call-center/application.js';

before(() => {
  useMemoryRedisForTests();
});

test('supervisor voicemail park schema exists', () => {
  const db = createDatabase(':memory:');
  for (const table of ['voicemails', 'call_park_slots', 'qm_appeals']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(row);
  }
});

test('wallboard snapshot aggregates seats and queues', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'WB' });
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'a', display_name: 'A' });
  seatStore.updateStatus(tenant.id, seat.id, 'idle');
  const queueStore = new CallQueueStore(db);
  queueStore.createQueue({ tenant_id: tenant.id, name: 'sales' });

  const snapshot = new WallboardService(db, seatStore, queueStore).getSnapshot(tenant.id);
  assert.equal(snapshot.seats.idle, 1);
  assert.equal(snapshot.queues.length, 1);
  assert.equal(snapshot.queues[0].queue_name, 'sales');
});

test('supervisor listen mode issues dev token', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Sup' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 's1',
    status: 'active'
  });
  const service = new SupervisorService(voiceStore, new LiveKitRoomStore(db));
  const result = await service.joinMonitor({
    tenantId: tenant.id,
    supervisorUserId: 'sup-1',
    callSessionId: session.id,
    mode: 'listen'
  });
  assert.equal(result.mode, 'listen');
  assert.ok(result.livekit.token.includes('supervisor_listen'));
});

test('supervisor monitor refuses a closed media room', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Sup Closed' });
  const voiceStore = new VoiceStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 's-closed',
    status: 'active'
  });
  const room = await roomStore.createRoom({
    tenant_id: tenant.id,
    purpose: 'pstn_bridge',
    call_session_id: session.id,
    metadata: { monitor: true }
  });
  roomStore.closeRoom(room.room_name);

  const service = new SupervisorService(voiceStore, roomStore);
  await assert.rejects(
    () =>
      service.joinMonitor({
        tenantId: tenant.id,
        supervisorUserId: 'sup-closed',
        callSessionId: session.id,
        mode: 'listen'
      }),
    /media room is closed/
  );
});

test('park and pickup call', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Park' });
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const seatA = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'a', display_name: 'A' });
  const seatB = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'b', display_name: 'B' });
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'p1',
    status: 'active'
  });

  const service = new ParkPickupService(db, voiceStore, seatStore);
  const parked = service.parkCall(tenant.id, session.id, seatA.id, 3);
  assert.equal(parked.slot, 3);

  const picked = service.pickupCall(tenant.id, 3, seatB.id);
  assert.equal(picked.call_session_id, session.id);
});

test('voicemail store creates and lists messages', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'VM' });
  const store = new VoicemailStore(db);
  store.createVoicemail({
    tenant_id: tenant.id,
    from_number: '+8613912345678',
    transcript: '请回电'
  });
  assert.equal(store.listVoicemails(tenant.id).length, 1);
});

test('qm appeal workflow', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Appeal' });
  const store = new QmStore(db);
  const evaluation = store.createEvaluation({
    tenant_id: tenant.id,
    call_session_id: 'vsession_test',
    scores: {
      politeness: 0.3,
      compliance: 0.3,
      problem_resolution: 0.3,
      upsell_effectiveness: 0.3,
      script_adherence: 0.3
    },
    summary: '低分',
    overall_score: 0.3
  });
  const appeal = store.createAppeal({
    tenant_id: tenant.id,
    evaluation_id: evaluation.id,
    call_session_id: evaluation.call_session_id,
    appellant_user_id: 'agent-1',
    reason: '客户态度恶劣导致评分偏低'
  });
  assert.equal(appeal.status, 'pending');
  const resolved = store.resolveAppeal(appeal.id, tenant.id, 'supervisor-1', 'approved', '同意申诉');
  assert.equal(resolved?.status, 'approved');
});

test('auto qm evaluation runs on call with turns', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'AutoQM' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'outbound',
    rustpbx_call_id: 'q1',
    status: 'completed'
  });
  run(
    db,
    `INSERT INTO ai_conversation_turns (id, call_session_id, turn_index, role, content)
     VALUES ('turn1', ?, 0, 'customer', '你好'), ('turn2', ?, 1, 'ai', '您好，我是智能客服')`,
    [session.id, session.id]
  );

  await triggerAutoQmEvaluation(db, tenant.id, session.id);
  const evaluation = new QmStore(db).getEvaluationBySession(session.id);
  assert.ok(evaluation);
});

test('getWallboardCommand returns snapshot and alerts', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'WB HTTP' });
  const result = getWallboardCommand(db, tenant.id) as { data: { snapshot: unknown; alerts: unknown[] } };
  assert.ok(result.data.snapshot);
  assert.ok(Array.isArray(result.data.alerts));
});

test('qm dashboard view model matches frontend shape', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'QM VM' });
  const store = new QmStore(db);
  store.createEvaluation({
    tenant_id: tenant.id,
    call_session_id: 'vs_low',
    scores: {
      politeness: 0.4,
      compliance: 0.4,
      problem_resolution: 0.4,
      upsell_effectiveness: 0.4,
      script_adherence: 0.4
    },
    summary: '一般',
    violations: ['未披露AI'],
    overall_score: 0.4
  });
  const vm = store.getDashboardViewModel(tenant.id);
  assert.ok(vm.dimension_averages.length === 5);
  assert.ok(vm.score_distribution.length >= 1);
});
