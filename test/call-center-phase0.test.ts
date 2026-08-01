import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { decideCallRoute } from '../src/agent-runtime/call-center/call-router.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { OutboundTaskStore } from '../src/agent-runtime/call-center/outbound-task-store.js';
import {
  handleCallRouterCommand,
  createOutboundTaskCommand,
  createLiveKitRoomCommand,
  handleAgentDispatchCommand,
  issueLiveKitTokenCommand
} from '../src/agent-runtime/call-center/application.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { LiveKitRoomStore } from '../src/agent-runtime/livekit/room-store.js';
import { issueLiveKitToken } from '../src/agent-runtime/livekit/token-service.js';
import { routeCallCenterApi } from '../src/call-center-http.js';

test('call center schema tables exist after migration', () => {
  const db = createDatabase(':memory:');
  const tables = ['livekit_rooms', 'call_recordings', 'ai_conversation_turns', 'agent_seats', 'outbound_tasks', 'voice_agent_specs'];
  for (const table of tables) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(row, `missing table ${table}`);
  }
});

test('inbound call routes to queue when idle seat exists', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Call Center Demo' });
  const seatStore = new AgentSeatStore(db);
  seatStore.upsertSeat({ tenant_id: tenant.id, user_id: 'u1', display_name: 'Agent 1', skills: ['japanese'] });
  seatStore.updateStatus(tenant.id, seatStore.listSeats(tenant.id)[0].id, 'idle');

  const response = decideCallRoute(
    {
      call_id: 'call-1',
      from_uri: 'sip:+81311112222@trunk',
      to_uri: 'sip:+81333334444@pbx',
      direction: 'inbound',
      headers: { 'X-Tenant-Id': tenant.id }
    },
    {
      seatStore,
      outboundTaskStore: new OutboundTaskStore(db),
      defaultTenantId: tenant.id
    }
  );

  assert.equal(response.action, 'queue');
  assert.equal(response.queue_name, 'default');
});

test('inbound call forwards to livekit when no idle seats', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'AI Only' });
  const response = decideCallRoute(
    {
      call_id: 'call-2',
      direction: 'inbound',
      headers: { 'X-Tenant-Id': tenant.id }
    },
    {
      seatStore: new AgentSeatStore(db),
      outboundTaskStore: new OutboundTaskStore(db),
      defaultTenantId: tenant.id
    }
  );
  assert.equal(response.action, 'forward');
  assert.ok(response.targets?.[0]?.includes('livekit'));
});

test('outbound task creation and dev livekit token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-call-center-'));
  try {
    const db = createDatabase(join(dir, 'opc.sqlite'));
    const tenant = createTenant(db, { name: 'Outbound Demo' });
    const created = createOutboundTaskCommand(db, {
      tenant_id: tenant.id,
      phone_number: '+81312345678',
      channel: 'pstn_voice',
      strategy: { script_id: 'demo', language: 'ja' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, 'pending');

    const roomStore = new LiveKitRoomStore(db);
    const room = await roomStore.createRoom({
      tenant_id: tenant.id,
      purpose: 'pstn_bridge',
      metadata: { outbound_task_id: created.data.id }
    });
    assert.match(room.room_name, new RegExp(`^${tenant.id}-pstn_bridge-`));

    const token = await issueLiveKitToken({
      room_name: room.room_name,
      identity: 'customer_test',
      role: 'customer',
      tenant_id: tenant.id
    });
    assert.match(token.token, /^dev-token:/);
    assert.equal(token.configured, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy livekit token command refuses closed rooms', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Closed Token Command' });
  const created = await createLiveKitRoomCommand(db, {
    tenant_id: tenant.id,
    purpose: 'video_service',
    room_name: 'closed-token-command-room'
  });
  const room = created.data;
  new LiveKitRoomStore(db).closeRoom(room.room_name);

  await assert.rejects(
    () =>
      issueLiveKitTokenCommand(db, {
        room_name: room.room_name,
        identity: 'agent_closed',
        role: 'agent',
        tenant_id: tenant.id
      }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /room is closed/);
      return true;
    }
  );

  db.close();
});

test('legacy ai agent dispatch requires tenant_id and matching room tenant', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Dispatch Tenant A' });
  const otherTenant = createTenant(db, { name: 'Dispatch Tenant B' });
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.createCallSession({
    tenant_id: tenant.id,
    provider: 'rustpbx',
    direction: 'outbound',
    status: 'active',
    phone: '+81312345678'
  });
  const room = await createLiveKitRoomCommand(db, {
    tenant_id: tenant.id,
    purpose: 'pstn_bridge',
    call_session_id: session.id,
    room_name: 'legacy-dispatch-tenant-room'
  });

  assert.throws(
    () =>
      handleAgentDispatchCommand(db, { voiceStore }, {
        room_name: room.data.room_name,
        action: 'end_call',
        reason: 'missing tenant',
        customer_summary: 'done'
      } as any),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /tenant_id is required/);
      return true;
    }
  );

  assert.throws(
    () =>
      handleAgentDispatchCommand(db, { voiceStore }, {
        tenant_id: otherTenant.id,
        room_name: room.data.room_name,
        action: 'end_call',
        reason: 'wrong tenant',
        customer_summary: 'done'
      } as any),
    (error) => {
      assert.equal((error as { status?: number }).status, 404);
      assert.match((error as Error).message, /room not found/);
      return true;
    }
  );

  const result = handleAgentDispatchCommand(db, { voiceStore }, {
    tenant_id: tenant.id,
    room_name: room.data.room_name,
    action: 'end_call',
    reason: 'tenant matched',
    customer_summary: 'done'
  } as any);
  assert.equal((result.data as { action_taken: string }).action_taken, 'call_ended');
  assert.equal(voiceStore.getCallSession(tenant.id, session.id)?.status, 'completed');
  db.close();
});

test('legacy livekit http management endpoints require converact api key when configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Legacy LiveKit HTTP Auth' });
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_API_KEY = 'legacy-livekit-key';
  try {
    await assert.rejects(
      () =>
        routeCallCenterApi(
          db,
          {},
          'POST',
          '/api/livekit/rooms',
          new URL('http://localhost/api/livekit/rooms'),
          {
            tenant_id: tenant.id,
            purpose: 'video_service',
            room_name: 'legacy-http-auth-room'
          },
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /invalid converact api key/);
        return true;
      }
    );

    const created = await routeCallCenterApi(
      db,
      {},
      'POST',
      '/api/livekit/rooms',
      new URL('http://localhost/api/livekit/rooms'),
      {
        tenant_id: tenant.id,
        purpose: 'video_service',
        room_name: 'legacy-http-auth-room'
      },
      '',
      { 'x-api-key': 'legacy-livekit-key' }
    ) as { status?: number; data?: { room_name?: string } };
    assert.equal(created.status, 201);
    assert.equal(created.data?.room_name, 'legacy-http-auth-room');

    await assert.rejects(
      () =>
        routeCallCenterApi(
          db,
          {},
          'GET',
          '/api/livekit/token',
          new URL(`http://localhost/api/livekit/token?room_name=legacy-http-auth-room&identity=agent1&role=agent&tenant_id=${tenant.id}`),
          undefined,
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /invalid converact api key/);
        return true;
      }
    );

    const token = await routeCallCenterApi(
      db,
      {},
      'GET',
      '/api/livekit/token',
      new URL(`http://localhost/api/livekit/token?room_name=legacy-http-auth-room&identity=agent1&role=agent&tenant_id=${tenant.id}`),
      undefined,
      '',
      { 'x-api-key': 'legacy-livekit-key' }
    ) as { data?: { token?: string } };
    assert.match(String(token.data?.token), /^dev-token:/);
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.CONVERACT_API_KEY;
    } else {
      process.env.CONVERACT_API_KEY = previousApiKey;
    }
    db.close();
  }
});

test('legacy livekit http management endpoints fail closed in production when converact api key is not configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Legacy LiveKit Production Auth' });
  const previousApiKey = process.env.CONVERACT_API_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  delete process.env.CONVERACT_API_KEY;
  process.env.NODE_ENV = 'production';

  try {
    await assert.rejects(
      () =>
        routeCallCenterApi(
          db,
          {},
          'POST',
          '/api/livekit/rooms',
          new URL('http://localhost/api/livekit/rooms'),
          {
            tenant_id: tenant.id,
            purpose: 'video_service',
            room_name: 'legacy-http-production-auth-room'
          },
          '',
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /converact api key is required/);
        return true;
      }
    );
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.CONVERACT_API_KEY;
    } else {
      process.env.CONVERACT_API_KEY = previousApiKey;
    }
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
    db.close();
  }
});

test('legacy livekit webhook fails closed in production when LiveKit webhook credentials are not configured', async () => {
  const db = createDatabase(':memory:');
  const previousNodeEnv = process.env.NODE_ENV;
  const previousLiveKitUrl = process.env.LIVEKIT_URL;
  const previousLiveKitKey = process.env.LIVEKIT_API_KEY;
  const previousLiveKitSecret = process.env.LIVEKIT_API_SECRET;
  const previousConveractLiveKitUrl = process.env.CONVERACT_LIVEKIT_URL;
  const previousConveractLiveKitKey = process.env.CONVERACT_LIVEKIT_API_KEY;
  const previousConveractLiveKitSecret = process.env.CONVERACT_LIVEKIT_API_SECRET;
  process.env.NODE_ENV = 'production';
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.CONVERACT_LIVEKIT_URL;
  delete process.env.CONVERACT_LIVEKIT_API_KEY;
  delete process.env.CONVERACT_LIVEKIT_API_SECRET;

  try {
    await assert.rejects(
      () =>
        routeCallCenterApi(
          db,
          {},
          'POST',
          '/api/webhooks/livekit',
          new URL('http://localhost/api/webhooks/livekit'),
          null,
          JSON.stringify({
            event: 'room_started',
            room: { name: 'legacy-livekit-webhook-production-room', sid: 'RM_unsigned' }
          }),
          {}
        ),
      (error) => {
        assert.equal((error as { status?: number }).status, 401);
        assert.match((error as Error).message, /livekit webhook credentials are required/);
        return true;
      }
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousLiveKitUrl === undefined) delete process.env.LIVEKIT_URL;
    else process.env.LIVEKIT_URL = previousLiveKitUrl;
    if (previousLiveKitKey === undefined) delete process.env.LIVEKIT_API_KEY;
    else process.env.LIVEKIT_API_KEY = previousLiveKitKey;
    if (previousLiveKitSecret === undefined) delete process.env.LIVEKIT_API_SECRET;
    else process.env.LIVEKIT_API_SECRET = previousLiveKitSecret;
    if (previousConveractLiveKitUrl === undefined) delete process.env.CONVERACT_LIVEKIT_URL;
    else process.env.CONVERACT_LIVEKIT_URL = previousConveractLiveKitUrl;
    if (previousConveractLiveKitKey === undefined) delete process.env.CONVERACT_LIVEKIT_API_KEY;
    else process.env.CONVERACT_LIVEKIT_API_KEY = previousConveractLiveKitKey;
    if (previousConveractLiveKitSecret === undefined) delete process.env.CONVERACT_LIVEKIT_API_SECRET;
    else process.env.CONVERACT_LIVEKIT_API_SECRET = previousConveractLiveKitSecret;
    db.close();
  }
});

test('call router command returns forward for outbound', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Router Demo' });
  const response = await handleCallRouterCommand(db, {}, {
    call_id: 'call-3',
    to_uri: 'sip:+81399998888@trunk',
    direction: 'outbound',
    headers: { 'X-Tenant-Id': tenant.id }
  });
  assert.equal(response.action, 'forward');
});
