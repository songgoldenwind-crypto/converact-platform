import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { DidStore } from '../src/agent-runtime/call-center/inbound/did-store.js';
import { CallQueueStore } from '../src/agent-runtime/call-center/inbound/call-queue.js';
import { AcdEngine } from '../src/agent-runtime/call-center/inbound/acd-engine.js';
import { AutoAttendantService } from '../src/agent-runtime/call-center/inbound/auto-attendant.js';
import { QueueCallbackService } from '../src/agent-runtime/call-center/inbound/queue-callback.js';
import { buildInboundRouterDeps, routeInboundCall } from '../src/agent-runtime/call-center/inbound/inbound-router.js';
import { handleCallRouterCommand } from '../src/agent-runtime/call-center/application.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { onboardCallCenterTenant } from '../src/tenant-onboarding.js';

function openBusinessHours(db: unknown, tenantId: string): void {
  new AutoAttendantService(db).upsertConfig(tenantId, {
    business_hours: {
      sun: [0, 24],
      mon: [0, 24],
      tue: [0, 24],
      wed: [0, 24],
      thu: [0, 24],
      fri: [0, 24],
      sat: [0, 24]
    }
  });
}

before(() => {
  useMemoryRedisForTests();
});

test('inbound ACD schema tables exist', () => {
  const db = createDatabase(':memory:');
  for (const table of [
    'call_queues',
    'queue_members',
    'did_numbers',
    'queue_entries',
    'queue_callbacks',
    'auto_attendant_config'
  ]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(row, `missing table ${table}`);
  }
});

test('DID routes inbound call to tenant queue with position announcement', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Inbound Demo' });
  openBusinessHours(db, tenant.id);
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.upsertSeat({
    tenant_id: tenant.id,
    user_id: 'agent-1',
    display_name: 'Agent 1',
    skills: ['sales']
  });
  seatStore.updateStatus(tenant.id, seat.id, 'idle');

  const queueStore = new CallQueueStore(db);
  const queue = queueStore.createQueue({ tenant_id: tenant.id, name: 'sales', music_url: 'https://cdn/hold.mp3' });
  queueStore.addMember(queue.id, seat.id, 2);

  const didStore = new DidStore(db);
  didStore.createDid({
    tenant_id: tenant.id,
    number: '+8613800138000',
    route_type: 'queue',
    route_target: queue.id
  });

  const deps = buildInboundRouterDeps(db, { defaultTenantId: tenant.id });
  const result = await routeInboundCall(
    {
      call_id: 'rustpbx-in-1',
      from_uri: 'sip:+8613911112222@trunk',
      to_uri: 'sip:+8613800138000@pbx',
      direction: 'inbound'
    },
    deps
  );

  assert.equal(result.response.action, 'queue');
  assert.equal(result.response.queue_name, 'sales');
  assert.ok(result.response.metadata?.position_announcement?.includes('前面'));
  assert.equal(result.context.assigned_seat_id, seat.id);
  assert.equal(result.context.queue_position, 1);
});

test('ACD longest_idle picks seat with older heartbeat', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'ACD Demo' });
  const seatStore = new AgentSeatStore(db);
  const seatA = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'a', display_name: 'A' });
  const seatB = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'b', display_name: 'B' });
  seatStore.updateStatus(tenant.id, seatA.id, 'idle');
  seatStore.updateStatus(tenant.id, seatB.id, 'idle');
  seatStore.heartbeat(tenant.id, seatA.id);
  await new Promise((r) => setTimeout(r, 5));
  seatStore.heartbeat(tenant.id, seatB.id);

  const queueStore = new CallQueueStore(db);
  const queue = queueStore.createQueue({ tenant_id: tenant.id, name: 'default', strategy: 'longest_idle' });
  queueStore.addMember(queue.id, seatA.id);
  queueStore.addMember(queue.id, seatB.id);

  const acd = new AcdEngine(db, seatStore, queueStore);
  const picked = acd.findBestSeat(queue.id, 'longest_idle');
  assert.equal(picked?.id, seatA.id);
});

test('after hours routes to announcement when auto attendant configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'After Hours' });
  const attendant = new AutoAttendantService(db);
  attendant.upsertConfig(tenant.id, {
    business_hours: {},
    after_hours_route_type: 'announcement',
    announcement_text: '已下班'
  });

  const deps = buildInboundRouterDeps(db, { defaultTenantId: tenant.id });
  const result = await routeInboundCall(
    {
      call_id: 'rustpbx-in-2',
      direction: 'inbound',
      headers: { 'X-Tenant-Id': tenant.id }
    },
    deps
  );

  assert.equal(result.response.action, 'ivr');
  assert.equal(result.response.metadata?.announcement, '已下班');
  assert.equal(result.context.after_hours, true);
});

test('queue overflow to AI when queue is full', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Overflow' });
  openBusinessHours(db, tenant.id);
  const queueStore = new CallQueueStore(db);
  const queue = queueStore.createQueue({
    tenant_id: tenant.id,
    name: 'tiny',
    max_size: 1,
    overflow_target: 'ai'
  });
  new DidStore(db).createDid({
    tenant_id: tenant.id,
    number: '+8613800138001',
    route_type: 'queue',
    route_target: queue.id
  });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    direction: 'inbound',
    rustpbx_call_id: 'existing',
    phone: '+8613900000001'
  });
  queueStore.enqueue(queue.id, session.id);

  const deps = buildInboundRouterDeps(db, { defaultTenantId: tenant.id, voiceStore });
  const result = await routeInboundCall(
    {
      call_id: 'rustpbx-in-3',
      direction: 'inbound',
      to_uri: 'sip:+8613800138001@pbx',
      headers: { 'X-Tenant-Id': tenant.id }
    },
    deps
  );

  assert.equal(result.response.action, 'forward');
  assert.equal(result.response.metadata?.routed_to, 'ai_inbound_agent');
  assert.equal(result.context.overflow_applied, true);
});

test('queue callback offered after wait threshold', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Callback' });
  const queueStore = new CallQueueStore(db);
  const queue = queueStore.createQueue({ tenant_id: tenant.id, name: 'cb', callback_after_sec: 30 });
  const service = new QueueCallbackService(db);
  assert.equal(service.shouldOfferCallback(queue.id, 10), false);
  assert.equal(service.shouldOfferCallback(queue.id, 60), true);
  const cb = service.createCallback({
    tenant_id: tenant.id,
    queue_id: queue.id,
    phone_number: '+8613912345678'
  });
  assert.equal(cb.status, 'pending');
});

test('onboarding seeds default queue and DID', () => {
  const db = createDatabase(':memory:');
  const result = onboardCallCenterTenant(db, {
    tenantId: 'tenant_demo_1',
    tenantName: 'Demo',
    userId: 'user-1',
    userName: 'Owner'
  });
  assert.ok(result.default_queue_id);
  assert.ok(result.default_did_id);
  const queueStore = new CallQueueStore(db);
  const queue = queueStore.getQueue(result.default_queue_id);
  assert.equal(queue?.name, 'default');
});

test('handleCallRouterCommand uses inbound router for inbound direction', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Router HTTP' });
  openBusinessHours(db, tenant.id);
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'U1' });
  seatStore.updateStatus(tenant.id, seat.id, 'idle');

  const response = await handleCallRouterCommand(db, {}, {
    call_id: 'call-http-1',
    direction: 'inbound',
    headers: { 'X-Tenant-Id': tenant.id }
  }) as { action: string; metadata?: Record<string, string> };

  assert.equal(response.action, 'queue');
  assert.ok(response.metadata?.call_session_id);
});
