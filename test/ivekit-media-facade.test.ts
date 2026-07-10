import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { routeIveKitMediaApi } from '../src/agent-runtime/ivekit/media-http.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { createDatabase } from '../src/db.js';
import { createServer as createOpcServer } from '../src/http.js';
import { createTenant } from '../src/platform/tenant-core.js';

const API_KEY = 'test-ivekit-media-key';
const LIVEKIT_ENV_KEYS = [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'OPC_LIVEKIT_URL',
  'OPC_LIVEKIT_API_KEY',
  'OPC_LIVEKIT_API_SECRET',
  'OPC_MEDIA_INVITE_SECRET',
  'LIVEKIT_MEDIA_INVITE_SECRET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY'
];

function authHeaders(tenantId: string, userId = 'led-backend'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(
  db: unknown,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders('tenant_ivekit_media')
) {
  return routeIveKitMediaApi(
    db,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers
  );
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearLiveKitEnv(): void {
  for (const key of LIVEKIT_ENV_KEYS) delete process.env[key];
}

test('iveKit media facade exposes deployment capabilities through platform auth', async () => {
  const envSnapshot = snapshotEnv(['OPC_API_KEY', ...LIVEKIT_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  process.env.LIVEKIT_URL = 'wss://livekit.example.com';
  process.env.LIVEKIT_API_KEY = 'livekit-key';
  process.env.LIVEKIT_API_SECRET = 'livekit-secret';
  process.env.OPC_MEDIA_INVITE_SECRET = 'invite-secret';
  process.env.MINIO_ACCESS_KEY = 'minio-key';
  process.env.MINIO_SECRET_KEY = 'minio-secret';
  const db = createDatabase(':memory:');
  try {
    const result = await route(
      db,
      'GET',
      '/api/ivekit/media/capabilities',
      null,
      authHeaders('tenant_capabilities')
    ) as {
      data: {
        provider: string;
        tenant_id: string;
        capabilities: Record<string, unknown>;
        config: Record<string, unknown>;
      };
    };

    assert.equal(result.data.provider, 'livekit');
    assert.equal(result.data.tenant_id, 'tenant_capabilities');
    assert.equal(result.data.capabilities.rooms, true);
    assert.equal(result.data.capabilities.join, true);
    assert.equal(result.data.capabilities.recording, true);
    assert.equal(result.data.capabilities.web_assist, true);
    assert.equal(result.data.config.livekit_url_configured, true);
    assert.equal(result.data.config.livekit_api_key_configured, true);
    assert.equal(result.data.config.livekit_api_secret_configured, true);
    assert.equal(result.data.config.invite_secret_configured, true);
    assert.equal(result.data.config.egress_configured, true);
    assert.equal(JSON.stringify(result).includes('livekit-secret'), false);
    assert.equal(JSON.stringify(result).includes('minio-secret'), false);
  } finally {
    db.close();
    restoreEnv(envSnapshot);
  }
});

test('iveKit media facade creates rooms, prepares joins, lists participants, and starts recordings', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'iveKit Media Tenant' }).id;

  const created = await route(
    db,
    'POST',
    '/api/ivekit/media/rooms',
    {
      tenant_id: 'tenant_from_body_must_be_ignored',
      purpose: 'video_service',
      room_name: 'led-media-room-1',
      business_ref: {
        type: 'service_order',
        id: 'order-led-media-1',
        display_name: 'LED media order',
        metadata: { project: 'led' }
      },
      metadata: { source: 'led' }
    },
    authHeaders(tenantId)
  ) as { status: number; data: { tenant_id: string; room_name: string; metadata: Record<string, any> } };

  assert.equal(created.status, 201);
  assert.equal(created.data.tenant_id, tenantId);
  assert.equal(created.data.room_name, 'led-media-room-1');
  assert.deepEqual(created.data.metadata.business_ref, {
    tenant_id: tenantId,
    type: 'service_order',
    id: 'order-led-media-1',
    display_name: 'LED media order',
    metadata: { project: 'led' }
  });

  const join = await route(
    db,
    'POST',
    '/api/ivekit/media/rooms/led-media-room-1/join',
    {
      identity: 'customer-led-1',
      role: 'customer',
      media: 'video',
      channel: 'webrtc'
    },
    authHeaders(tenantId)
  ) as { status: number; data: { mode: string; roomName: string; token: { token: string }; joinPath: string } };

  assert.equal(join.status, 201);
  assert.equal(join.data.mode, 'webrtc');
  assert.equal(join.data.roomName, 'led-media-room-1');
  assert.match(join.data.token.token, /^dev-token:/);
  assert.equal(join.data.joinPath, `/video?room=led-media-room-1&tenant_id=${tenantId}`);

  createLiveKitMediaModule({ db }).participants.upsertJoined({
    tenant_id: tenantId,
    room_name: 'led-media-room-1',
    identity: 'customer-led-1',
    role: 'customer',
    metadata: { display_name: 'LED Customer' }
  });

  const participants = await route(
    db,
    'GET',
    '/api/ivekit/media/rooms/led-media-room-1/participants',
    null,
    authHeaders(tenantId)
  ) as { data: Array<{ identity: string; role: string; status: string }> };

  assert.equal(participants.data[0]?.identity, 'customer-led-1');
  assert.equal(participants.data[0]?.role, 'customer');
  assert.equal(participants.data[0]?.status, 'joined');

  const recording = await route(
    db,
    'POST',
    '/api/ivekit/media/rooms/led-media-room-1/recordings/start',
    {
      business_ref: {
        type: 'service_order',
        id: 'order-led-media-1',
        display_name: 'LED media order'
      },
      format: 'mp4',
      has_video: true
    },
    authHeaders(tenantId)
  ) as { status: number; data: { tenant_id: string; business_ref: { id: string }; has_video: number; format: string } };

  assert.equal(recording.status, 201);
  assert.equal(recording.data.tenant_id, tenantId);
  assert.equal(recording.data.business_ref.id, 'order-led-media-1');
  assert.equal(recording.data.has_video, 1);
  assert.equal(recording.data.format, 'mp4');
  db.close();
});

test('iveKit media facade keeps rooms tenant scoped', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantA = createTenant(db, { name: 'Tenant A' }).id;
  const tenantB = createTenant(db, { name: 'Tenant B' }).id;
  await route(
    db,
    'POST',
    '/api/ivekit/media/rooms',
    {
      purpose: 'video_service',
      room_name: 'tenant-scoped-media-room',
      business_ref: { type: 'service_order', id: 'order-tenant-a' }
    },
    authHeaders(tenantA)
  );

  await assert.rejects(
    () =>
      route(
        db,
        'POST',
        '/api/ivekit/media/rooms/tenant-scoped-media-room/join',
        {
          identity: 'customer-cross-tenant',
          role: 'customer'
        },
        authHeaders(tenantB)
      ),
    /media room not found/
  );
  db.close();
});

test('iveKit media facade is registered in the main HTTP router', async () => {
  process.env.OPC_API_KEY = API_KEY;
  clearLiveKitEnv();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'HTTP Router Media Tenant' }).id;
  const server = createOpcServer(db);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ivekit/media/capabilities`, {
      headers: authHeaders(tenantId)
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { provider: string; tenant_id: string };
    assert.equal(payload.provider, 'livekit');
    assert.equal(payload.tenant_id, tenantId);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
