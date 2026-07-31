import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createWebAssistJoinPath } from '../src/agent-runtime/converact/remote-assist-token.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { createTenant } from '../src/platform/tenant-core.js';

const API_KEY = 'test-web-assist-consent-key';

function authHeaders(tenantId: string, userId = 'engineer-web-assist-consent'): Record<string, string> {
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
    input.headers ?? authHeaders('tenant_web_assist_consent'),
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
    body: { business_ref: { type: 'service_order', id: 'order-web-assist-consent' } },
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

  return remoteResult.data.id;
}

function signedWebAssistToken(input: {
  tenantId: string;
  remoteSessionId: string;
  actorIdentity: string;
  role: 'customer' | 'engineer';
}) {
  const joinPath = createWebAssistJoinPath({
    tenant_id: input.tenantId,
    remote_session_id: input.remoteSessionId,
    actor_identity: input.actorIdentity,
    role: input.role,
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  return new URL(`http://localhost${joinPath}`).searchParams.get('token') || '';
}

test('public Web Assist customer can grant and revoke consent with the signed join token', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Consent Public' }).id;
  const roomName = 'web-assist-consent-room';
  const remoteSessionId = await createWebAssistSession({ pg, db, tenantId, roomName });
  const token = signedWebAssistToken({
    tenantId,
    remoteSessionId,
    actorIdentity: 'buyer-web-assist-consent',
    role: 'customer'
  });
  const signedParams = `tenant_id=${tenantId}&token=${encodeURIComponent(token)}`;

  const blockedJoin = (await route({
    pg,
    db,
    method: 'GET',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/media/join?${signedParams}`,
    headers: {}
  })) as { status: number; data: { error: string } };
  assert.equal(blockedJoin.status, 403);

  const grantResult = (await route({
    pg,
    db,
    method: 'POST',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/consent/grant?${signedParams}`,
    body: { scopes: ['view_screen', 'record_screen'], expires_at: '2099-01-01T00:00:00.000Z' },
    headers: {}
  })) as {
    status: number;
    data: {
      event_type: string;
      actor_identity: string;
      scopes: string[];
    };
  };

  assert.equal(grantResult.status, 201);
  assert.equal(grantResult.data.event_type, 'granted');
  assert.equal(grantResult.data.actor_identity, 'buyer-web-assist-consent');
  assert.deepEqual(grantResult.data.scopes, ['view_screen', 'record_screen']);

  const allowedJoin = (await route({
    pg,
    db,
    method: 'GET',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/media/join?${signedParams}`,
    headers: {}
  })) as {
    data: {
      token: { token: string; room_name: string };
    };
  };

  assert.equal(allowedJoin.data.token.room_name, roomName);
  assert.equal(allowedJoin.data.token.token, `dev-token:${roomName}:buyer-web-assist-consent:customer`);

  const revokeResult = (await route({
    pg,
    db,
    method: 'POST',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/consent/revoke?${signedParams}`,
    body: { scopes: ['view_screen', 'record_screen'] },
    headers: {}
  })) as {
    status: number;
    data: { event_type: string; actor_identity: string };
  };

  assert.equal(revokeResult.status, 201);
  assert.equal(revokeResult.data.event_type, 'revoked');
  assert.equal(revokeResult.data.actor_identity, 'buyer-web-assist-consent');

  const blockedAfterRevoke = (await route({
    pg,
    db,
    method: 'GET',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/media/join?${signedParams}`,
    headers: {}
  })) as { status: number; data: { error: string } };
  assert.equal(blockedAfterRevoke.status, 403);
  db.close();
});

test('public Web Assist consent endpoint only accepts customer join tokens', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Consent Role Gate' }).id;
  const remoteSessionId = await createWebAssistSession({
    pg,
    db,
    tenantId,
    roomName: 'web-assist-consent-role-room'
  });
  const engineerToken = signedWebAssistToken({
    tenantId,
    remoteSessionId,
    actorIdentity: 'engineer-cannot-customer-consent',
    role: 'engineer'
  });

  const result = (await route({
    pg,
    db,
    method: 'POST',
    path:
      `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/consent/grant` +
      `?tenant_id=${tenantId}&token=${encodeURIComponent(engineerToken)}`,
    body: { scopes: ['view_screen'] },
    headers: {}
  })) as { status: number; data: { error: string } };

  assert.equal(result.status, 403);
  assert.match(result.data.error, /customer token required/);
  db.close();
});
