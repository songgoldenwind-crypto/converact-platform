import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createWebAssistJoinPath } from '../src/agent-runtime/converact/remote-assist-token.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { createTenant } from '../src/platform/tenant-core.js';

const API_KEY = 'test-web-assist-media-key';

function authHeaders(tenantId: string, userId = 'engineer-web-assist-media'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(input: {
  pg: MemoryPg;
  db: unknown;
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return routeCollaborationApi(
    input.pg,
    input.method,
    input.path,
    new URL(`http://localhost${input.path}`),
    input.body ?? null,
    '',
    input.headers ?? authHeaders('tenant_web_assist_media'),
    { db: input.db }
  );
}

async function createWebAssistSession(input: { pg: MemoryPg; db: unknown; tenantId: string; roomName: string }) {
  await createLiveKitMediaModule({ db: input.db }).rooms.createRoom({
    tenant_id: input.tenantId,
    purpose: 'screen_share',
    room_name: input.roomName,
    metadata: { media_kind: 'video' }
  });

  const sessionResult = (await route({
    pg: input.pg,
    db: input.db,
    method: 'POST',
    path: '/api/collaboration/sessions',
    body: { business_ref: { type: 'service_order', id: 'order-web-assist-media' } },
    headers: authHeaders(input.tenantId)
  })) as { data: { id: string } };

  const remoteResult = (await route({
    pg: input.pg,
    db: input.db,
    method: 'POST',
    path: '/api/collaboration/remote-assistance/sessions',
    body: {
      collaboration_session_id: sessionResult.data.id,
      mode: 'web_remote_assist',
      adapter_provider: 'ivekit_web',
      metadata: { media_room_name: input.roomName }
    },
    headers: authHeaders(input.tenantId)
  })) as { data: { id: string } };

  await route({
    pg: input.pg,
    db: input.db,
    method: 'POST',
    path: `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
    body: {
      actor_identity: 'buyer-web-assist-media',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    headers: authHeaders(input.tenantId)
  });

  return remoteResult.data.id;
}

test('public Web Assist token can join the shared LiveKit screen room', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Media Public' }).id;
  const roomName = 'web-assist-room-public';
  const remoteSessionId = await createWebAssistSession({ pg, db, tenantId, roomName });
  const joinPath = createWebAssistJoinPath({
    tenant_id: tenantId,
    remote_session_id: remoteSessionId,
    actor_identity: 'buyer-web-assist-media',
    role: 'customer',
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const token = new URL(`http://localhost${joinPath}`).searchParams.get('token') || '';

  const joinResult = (await route({
    pg,
    db,
    method: 'GET',
    path:
      `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/media/join` +
      `?tenant_id=${tenantId}&token=${encodeURIComponent(token)}`,
    headers: {}
  })) as {
    data: {
      mode: string;
      token: { token: string; room_name: string };
    };
  };

  assert.equal(joinResult.data.mode, 'webrtc');
  assert.equal(joinResult.data.token.room_name, roomName);
  assert.equal(joinResult.data.token.token, `dev-token:${roomName}:buyer-web-assist-media:customer`);
  db.close();
});

test('authenticated engineer can join the same Web Assist LiveKit screen room', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Media Engineer' }).id;
  const roomName = 'web-assist-room-engineer';
  const remoteSessionId = await createWebAssistSession({ pg, db, tenantId, roomName });

  const joinResult = (await route({
    pg,
    db,
    method: 'GET',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/media/join?identity=engineer-join`,
    headers: authHeaders(tenantId, 'engineer-join')
  })) as {
    data: {
      mode: string;
      token: { token: string; room_name: string };
    };
  };

  assert.equal(joinResult.data.mode, 'webrtc');
  assert.equal(joinResult.data.token.room_name, roomName);
  assert.equal(joinResult.data.token.token, `dev-token:${roomName}:engineer-join:agent`);
  db.close();
});
