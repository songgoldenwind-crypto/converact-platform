import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { DispositionStore } from '../src/agent-runtime/call-center/agent-tools/disposition.js';
import { CallHoldService } from '../src/agent-runtime/call-center/agent-tools/call-hold.js';
import { CallTransferService } from '../src/agent-runtime/call-center/agent-tools/call-transfer.js';
import { CallQueueStore } from '../src/agent-runtime/call-center/inbound/call-queue.js';
import { QueueCallbackService } from '../src/agent-runtime/call-center/inbound/queue-callback.js';
import { QueueCallbackProcessor } from '../src/agent-runtime/call-center/queue-callback-processor.js';
import { OutboundTaskStore } from '../src/agent-runtime/call-center/outbound-task-store.js';
import {
  holdCallCommand,
  endAgentCallCommand,
  listDispositionCodesCommand,
  transferCallCommand
} from '../src/agent-runtime/call-center/application.js';
import { EgressManager } from '../src/agent-runtime/call-center/egress-manager.js';
import { readEgressConfigFromEnv } from '../src/recording-policy.js';

before(() => {
  useMemoryRedisForTests();
});

test('agent tools schema tables exist', () => {
  const db = createDatabase(':memory:');
  for (const table of ['disposition_codes', 'call_dispositions']) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(row, `missing table ${table}`);
  }
});

test('disposition codes seed and persist on call end', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Dispo' });
  const store = new DispositionStore(db);
  store.seedDefaults(tenant.id);
  assert.ok(store.listCodes(tenant.id).length >= 6);

  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'A' });
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c1',
    phone: '+8613900000001',
    status: 'active'
  });

  await endAgentCallCommand(db, tenant.id, seat.id, session.id, 'u1', {
    disposition: 'callback',
    notes: '明天下午回呼'
  });

  const saved = store.getCallDisposition(session.id);
  assert.equal(saved?.disposition_code, 'callback');
  assert.equal(saved?.notes, '明天下午回呼');
});

test('hold and resume update session metadata', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Hold' });
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'A' });
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c2',
    status: 'active'
  });

  const hold = await holdCallCommand(db, tenant.id, session.id, seat.id, 'u1');
  assert.equal((hold as { data: { on_hold: boolean } }).data.on_hold, true);

  const updated = voiceStore.getCallSession(tenant.id, session.id);
  const metadata = updated?.metadata as Record<string, unknown>;
  assert.equal(metadata.on_hold, true);
});

test('blind transfer reassigns target seat and emits transfer', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Xfer' });
  const voiceStore = new VoiceStore(db);
  const seatStore = new AgentSeatStore(db);
  const seatA = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'a', display_name: 'A' });
  const seatB = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'b', display_name: 'B' });
  seatStore.updateStatus(tenant.id, seatA.id, 'busy');
  seatStore.updateStatus(tenant.id, seatB.id, 'idle');

  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c3',
    status: 'active'
  });

  const roomStore = new LiveKitRoomStore(db);
  await roomStore.createRoom({
    tenant_id: tenant.id,
    purpose: 'pstn_bridge',
    call_session_id: session.id
  });

  const result = transferCallCommand(
    db,
    tenant.id,
    session.id,
    { from_seat_id: seatA.id, target_seat_id: seatB.id, mode: 'blind' },
    'a'
  );
  assert.equal((result as { data: { status: string } }).data.status, 'completed');
  assert.equal(seatStore.getSeat(seatB.id)?.status, 'busy');
});

test('queue callback processor creates outbound tasks', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'CB' });
  const queue = new CallQueueStore(db).createQueue({ tenant_id: tenant.id, name: 'cb' });
  const callback = new QueueCallbackService(db).createCallback({
    tenant_id: tenant.id,
    queue_id: queue.id,
    phone_number: '+8613911122233'
  });
  assert.equal(callback.status, 'pending');

  const processor = new QueueCallbackProcessor(db, new OutboundTaskStore(db));
  const created = processor.processPending();
  assert.equal(created, 1);

  const tasks = new OutboundTaskStore(db).listTasks(tenant.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].phone_number, '+8613911122233');
  assert.equal((tasks[0].strategy as { source?: string }).source, 'queue_callback');
});

test('egress manager creates recording row without livekit configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Rec' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'c4',
    status: 'active'
  });

  const egress = new EgressManager(db, readEgressConfigFromEnv());
  const record = await egress.startRecording(tenant.id, session.id, 'room-test', { format: 'ogg' });
  assert.ok(record.id);
  assert.ok(record.storage_url.includes(session.id));
});

test('listDispositionCodesCommand seeds defaults', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'List' });
  const result = listDispositionCodesCommand(db, tenant.id);
  assert.ok((result as { data: unknown[] }).data.length >= 6);
});
