import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createDatabase, one } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { OutboundTaskStore } from '../src/agent-runtime/call-center/outbound-task-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { OutboundDialer } from '../src/agent-runtime/call-center/outbound-dialer.js';
import { MemoryRedis } from '../src/agent-runtime/call-center/redis-client.js';
import { RedisTaskLockStore } from '../src/agent-runtime/call-center/task-lock.js';
import { dialerWaitRegistry } from '../src/agent-runtime/call-center/dialer-wait-registry.js';
import { LogSMSSender } from '../src/agent-runtime/call-center/sms-sender.js';
import { isInDialingWindow, isTaskReadyForRetry } from '../src/agent-runtime/call-center/retry-policy.js';
import { initPostgres, resetPostgresForTests, type MemoryPg } from '../src/db-pg.js';
import { verifyMediaInvite } from '../src/agent-runtime/livekit/invite-token.js';

process.env.OPC_DIALER_IGNORE_WINDOW = '1';
process.env.OPC_DIALER_ANSWER_TIMEOUT_MS = '500';

let pg: MemoryPg;

// The outbound compliance gate is fail-closed when Postgres is unavailable
// (commit a4b1ef5). The dialer tests use SQLite :memory: for call data but
// the compliance gate queries the Postgres pool — so we must initialize the
// in-memory Postgres and seed each tenant there, else every call is blocked
// with 'compliance_database_unavailable'. Also freeze compliance time to a
// weekday business hour so the time-window check passes.
before(async () => {
  process.env.OPC_USE_MEMORY_PG = '1';
  process.env.OPC_COMPLIANCE_NOW = '2026-06-23T02:00:00Z'; // 11:00 Asia/Tokyo, Tue
  resetPostgresForTests(null);
  pg = (await initPostgres()) as MemoryPg;
});

/** Seed a tenant row into the compliance Postgres pool so getTenantStatus passes. */
function seedTenantForCompliance(tenantId: string, name: string): void {
  pg.query(`INSERT INTO tenants (id, name, plan_code) VALUES ($1, $2, 'free')
            ON CONFLICT (id) DO NOTHING`, [tenantId, name]);
}

type MockRwiOptions = {
  answerDelayMs?: number;
  answerCall?: boolean;
  originateError?: Error & { code?: string };
};

function createMockRwi(options: MockRwiOptions = {}) {
  const { answerDelayMs = 5, answerCall = true, originateError } = options;
  const originateCalls: unknown[] = [];
  const bridgeCalls: { callId: string; target: string }[] = [];
  const handlers = new Set<(event: any) => void>();
  const instanceId = Math.random().toString(36).slice(2, 8);
  let callSeq = 0;
  return {
    connected: true,
    originateCalls,
    bridgeCalls,
    async connect() {
      this.connected = true;
    },
    disconnect() {
      this.connected = false;
    },
    isConnected() {
      return this.connected;
    },
    onEvent(handler: (event: any) => void) {
      handlers.add(handler);
    },
    offEvent(handler: (event: any) => void) {
      handlers.delete(handler);
    },
    async originate(params: unknown) {
      if (originateError) throw originateError;
      originateCalls.push(params);
      const callId = `mock-call-${instanceId}-${++callSeq}`;
      if (answerCall) {
        setTimeout(() => {
          for (const h of handlers) {
            h({ event: 'call_state_change', call_id: callId, state: 'answered' });
          }
        }, answerDelayMs);
      }
      return { call_id: callId };
    },
    async bridge(callId: string, target: string) {
      bridgeCalls.push({ callId, target });
    },
    async hangup() {},
    async transfer() {},
    async hold() {},
    async unhold() {}
  };
}

function createTestDialer(db: unknown, rwi: ReturnType<typeof createMockRwi>) {
  dialerWaitRegistry.resetForTests();
  const voiceStore = new VoiceStore(db);
  const outboundTaskStore = new OutboundTaskStore(db);
  const roomStore = new LiveKitRoomStore(db);
  const taskLock = new RedisTaskLockStore(new MemoryRedis());
  const smsSender = new LogSMSSender();
  return {
    voiceStore,
    outboundTaskStore,
    roomStore,
    rwi,
    smsSender,
    dialer: new OutboundDialer({
      db,
      voiceStore,
      outboundTaskStore,
      roomStore,
      taskLock,
      rwiClient: rwi as any,
      smsSender,
      instanceId: `test-dialer-${Math.random().toString(36).slice(2, 8)}`,
      sipBridgeTarget: 'sip:livekit@localhost:5061',
      defaultTrunk: 'twilio-japan',
      h5BaseUrl: 'http://localhost:5173'
    })
  };
}

test('retry policy respects delay after no_answer', () => {
  const task = {
    status: 'pending',
    scheduled_at: null,
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    result: { hangup_cause: 'no_answer' }
  } as any;
  assert.equal(isTaskReadyForRetry(task), false);
});

test('retry policy allows re-pick after no_answer delay elapsed', () => {
  const task = {
    status: 'pending',
    scheduled_at: null,
    updated_at: new Date(Date.now() - 31_000).toISOString(),
    created_at: new Date(Date.now() - 60_000).toISOString(),
    result: { hangup_cause: 'no_answer' }
  } as any;
  assert.equal(isTaskReadyForRetry(task), true);
});

test('dialer respects max concurrent limit', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Dialer Tenant' });
  seedTenantForCompliance(tenant.id, 'Dialer Tenant');
  const { dialer, outboundTaskStore, rwi } = createTestDialer(
    db,
    createMockRwi({ answerDelayMs: 300 })
  );

  for (let i = 0; i < 6; i++) {
    outboundTaskStore.createTask({
      tenant_id: tenant.id,
      phone_number: `+8131234567${i}`,
      channel: 'pstn_voice',
      strategy: { script_id: 'demo', language: 'ja' }
    });
  }

  process.env.MAX_CONCURRENT_OUTBOUND_PER_TENANT = '5';
  await dialer.pickAndExecute();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rwi.originateCalls.length, 5);
});

test('dialer pstn flow reaches connected on answer', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'PSTN Flow' });
  seedTenantForCompliance(tenant.id, 'PSTN Flow');
  const { dialer, outboundTaskStore, rwi } = createTestDialer(db, createMockRwi());

  const task = outboundTaskStore.createTask({
    tenant_id: tenant.id,
    phone_number: '+81312345678',
    channel: 'pstn_voice',
    strategy: { script_id: 'demo', language: 'ja' }
  });

  await dialer.executeTask({ ...task, call_session_id: null });

  const updated = outboundTaskStore.getTask(task.id);
  assert.ok(updated);
  assert.equal(updated.status, 'connected');
  assert.equal(rwi.originateCalls.length, 1);
  assert.equal(rwi.bridgeCalls.length, 1);
  assert.equal(rwi.bridgeCalls[0]?.target, 'sip:livekit@localhost:5061');
});

test('dialer pickAndExecute moves pending task to dialing', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Pick Task' });
  seedTenantForCompliance(tenant.id, 'Pick Task');
  const { dialer, outboundTaskStore } = createTestDialer(db, createMockRwi());

  const task = outboundTaskStore.createTask({
    tenant_id: tenant.id,
    phone_number: '+81312345679',
    channel: 'pstn_voice',
    strategy: { script_id: 'demo', language: 'ja' }
  });

  await dialer.pickAndExecute();
  await new Promise((r) => setTimeout(r, 100));
  const updated = outboundTaskStore.getTask(task.id);
  assert.ok(updated);
  assert.equal(updated.status, 'connected');
  assert.ok(updated.call_session_id);
  assert.ok(updated.started_at);
});

test('dialer handles originate failure as failed task', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Originate Fail' });
  seedTenantForCompliance(tenant.id, 'Originate Fail');
  const err = Object.assign(new Error('No trunk'), { code: 'trunk_unavailable' });
  const { dialer, outboundTaskStore } = createTestDialer(db, createMockRwi({ originateError: err }));

  const task = outboundTaskStore.createTask({
    tenant_id: tenant.id,
    phone_number: '+81312345680',
    channel: 'pstn_voice',
    strategy: { script_id: 'demo', language: 'ja' }
  });

  await dialer.pickAndExecute();
  await new Promise((r) => setTimeout(r, 100));
  const updated = outboundTaskStore.getTask(task.id);
  assert.ok(updated);
  assert.equal(updated.status, 'failed');
  assert.equal(updated.result?.hangup_cause, 'no_trunk');
});

test('dialer retries on no_answer', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'No Answer' });
  seedTenantForCompliance(tenant.id, 'No Answer');
  const { dialer, outboundTaskStore } = createTestDialer(db, createMockRwi({ answerCall: false }));

  const task = outboundTaskStore.createTask({
    tenant_id: tenant.id,
    phone_number: '+81312345681',
    channel: 'pstn_voice',
    strategy: { script_id: 'demo', language: 'ja' }
  });

  await dialer.executeTask({ ...task, call_session_id: null });
  const updated = outboundTaskStore.getTask(task.id);
  assert.ok(updated);
  assert.equal(updated.status, 'pending');
  assert.equal(updated.attempt_count, 1);
  assert.equal(updated.result?.hangup_cause, 'no_answer');
});

test('dialer video_link_sms reaches connected when customer joins', async () => {
  const previousInviteSecret = process.env.OPC_MEDIA_INVITE_SECRET;
  process.env.OPC_DIALER_CUSTOMER_JOIN_TIMEOUT_MS = '2000';
  process.env.OPC_MEDIA_INVITE_SECRET = 'dialer-video-invite-secret';

  try {
    const db = createDatabase(':memory:');
    const tenant = createTenant(db, { name: 'Video SMS' });
    seedTenantForCompliance(tenant.id, 'Video SMS');
    const { dialer, outboundTaskStore, smsSender } = createTestDialer(db, createMockRwi());

    const task = outboundTaskStore.createTask({
      tenant_id: tenant.id,
      phone_number: '+81312345682',
      channel: 'video_link_sms',
      strategy: { script_id: 'demo', language: 'ja' }
    });

    const executePromise = dialer.executeTask({ ...task, call_session_id: null });
    await new Promise((r) => setTimeout(r, 30));
    const partial = outboundTaskStore.getTask(task.id);
    assert.ok(partial?.call_session_id);
    const roomRow = one(db, 'SELECT room_name FROM livekit_rooms WHERE call_session_id = ?', [
      partial.call_session_id
    ]);
    assert.ok(roomRow?.room_name);

    assert.equal(smsSender.sent.length, 1);
    const inviteUrlMatch = smsSender.sent[0]?.body.match(/https?:\/\/[^\s]+/);
    assert.ok(inviteUrlMatch);
    const inviteUrl = new URL(inviteUrlMatch[0]);
    assert.equal(inviteUrl.pathname, '/video');
    assert.equal(inviteUrl.searchParams.get('room'), String(roomRow.room_name));
    assert.equal(inviteUrl.searchParams.get('tenant_id'), tenant.id);
    assert.equal(inviteUrl.searchParams.has('token'), false);
    assert.ok(inviteUrl.searchParams.get('expires_at'));
    assert.ok(inviteUrl.searchParams.get('invite'));
    assert.equal(
      verifyMediaInvite({
        tenantId: tenant.id,
        roomName: String(roomRow.room_name),
        role: 'customer',
        media: 'video',
        expiresAt: inviteUrl.searchParams.get('expires_at'),
        invite: inviteUrl.searchParams.get('invite')
      }),
      true
    );

    dialerWaitRegistry.notifyParticipantJoined(String(roomRow.room_name), 'customer-1');
    await executePromise;

    const updated = outboundTaskStore.getTask(task.id);
    assert.ok(updated);
    assert.equal(updated.status, 'connected');
  } finally {
    if (previousInviteSecret == null) delete process.env.OPC_MEDIA_INVITE_SECRET;
    else process.env.OPC_MEDIA_INVITE_SECRET = previousInviteSecret;
  }
});

test('dialing window blocks outside JST business hours when enabled', () => {
  delete process.env.OPC_DIALER_IGNORE_WINDOW;
  const lateNight = new Date('2026-06-15T20:00:00Z');
  assert.equal(isInDialingWindow('t1', lateNight), false);
  process.env.OPC_DIALER_IGNORE_WINDOW = '1';
});
