import assert from 'node:assert/strict';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createWebAssistJoinPath } from '../src/agent-runtime/ivekit/remote-assist-token.js';
import { createLiveKitMediaModule } from '../src/agent-runtime/livekit/index.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { createTenant } from '../src/platform/tenant-core.js';

const API_KEY = 'test-web-assist-recording-key';

function authHeaders(tenantId: string, userId = 'engineer-web-assist-recording'): Record<string, string> {
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
    input.headers ?? authHeaders('tenant_web_assist_recording'),
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
    body: { business_ref: { type: 'service_order', id: 'order-web-assist-recording' } },
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

async function grantPublicConsent(input: {
  pg: MemoryPg;
  db: unknown;
  tenantId: string;
  remoteSessionId: string;
  token: string;
}) {
  await route({
    pg: input.pg,
    db: input.db,
    method: 'POST',
    path:
      `/api/collaboration/remote-assistance/${input.remoteSessionId}/web-assist/consent/grant` +
      `?tenant_id=${input.tenantId}&token=${encodeURIComponent(input.token)}`,
    body: { scopes: ['view_screen', 'record_screen'], expires_at: '2099-01-01T00:00:00.000Z' },
    headers: {}
  });
}

test('public Web Assist customer can start and stop screen recording with evidence', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Recording Public' }).id;
  const roomName = 'web-assist-recording-room';
  const remoteSessionId = await createWebAssistSession({ pg, db, tenantId, roomName });
  const token = signedWebAssistToken({
    tenantId,
    remoteSessionId,
    actorIdentity: 'buyer-web-assist-recording',
    role: 'customer'
  });
  const signedParams = `tenant_id=${tenantId}&token=${encodeURIComponent(token)}`;
  await grantPublicConsent({ pg, db, tenantId, remoteSessionId, token });

  const started = (await route({
    pg,
    db,
    method: 'POST',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/recordings/start?${signedParams}`,
    body: { format: 'mp4' },
    headers: {}
  })) as {
    status: number;
    data: {
      id: string;
      tenant_id: string;
      format: string;
      has_video: number;
      storage_url: string;
      egress_id: string;
      business_ref: { type: string; id: string };
      evidence_record_id: string;
      evidence_record: { id: string; kind: string; storage_url: string; metadata: Record<string, unknown> };
    };
  };

  assert.equal(started.status, 201);
  assert.equal(started.data.tenant_id, tenantId);
  assert.equal(started.data.format, 'mp4');
  assert.equal(started.data.has_video, 1);
  assert.equal(started.data.business_ref.type, 'service_order');
  assert.equal(started.data.business_ref.id, 'order-web-assist-recording');
  assert.equal(started.data.evidence_record.kind, 'video_recording');
  assert.equal(started.data.evidence_record.storage_url, started.data.storage_url);
  assert.equal(started.data.evidence_record.metadata.recording_id, started.data.id);
  assert.equal(started.data.evidence_record.metadata.room_name, roomName);

  const stopped = (await route({
    pg,
    db,
    method: 'POST',
    path:
      `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/recordings/` +
      `${encodeURIComponent(started.data.egress_id)}/stop?${signedParams}`,
    headers: {}
  })) as { status: number; data: { id: string; egress_id: string } };

  assert.equal(stopped.status, 201);
  assert.equal(stopped.data.id, started.data.id);
  assert.equal(stopped.data.egress_id, started.data.egress_id);

  const timeline = (await route({
    pg,
    db,
    method: 'GET',
    path: `/api/collaboration/remote-assistance/${remoteSessionId}/timeline`,
    headers: authHeaders(tenantId)
  })) as {
    data: {
      evidence: Array<{ id: string; kind: string }>;
      audit_events: Array<{ event_type: string; metadata: Record<string, unknown> }>;
    };
  };

  assert.equal(timeline.data.evidence.some((record) => record.id === started.data.evidence_record_id), true);
  assert.equal(
    timeline.data.audit_events.some((event) => event.event_type === 'remote.web_assist.recording.started'),
    true
  );
  assert.equal(
    timeline.data.audit_events.some((event) => event.event_type === 'remote.web_assist.recording.stopped'),
    true
  );
  db.close();
});

test('public Web Assist recording start requires active customer consent', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Recording Consent Gate' }).id;
  const remoteSessionId = await createWebAssistSession({
    pg,
    db,
    tenantId,
    roomName: 'web-assist-recording-consent-room'
  });
  const token = signedWebAssistToken({
    tenantId,
    remoteSessionId,
    actorIdentity: 'buyer-web-assist-recording-blocked',
    role: 'customer'
  });

  const result = (await route({
    pg,
    db,
    method: 'POST',
    path:
      `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/recordings/start` +
      `?tenant_id=${tenantId}&token=${encodeURIComponent(token)}`,
    body: { format: 'mp4' },
    headers: {}
  })) as { status: number; data: { error: string } };

  assert.equal(result.status, 403);
  assert.match(result.data.error, /active consent required/);
  db.close();
});

test('public Web Assist recording endpoint only accepts customer join tokens', async () => {
  process.env.OPC_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const db = createDatabase(':memory:');
  const tenantId = createTenant(db, { name: 'Web Assist Recording Role Gate' }).id;
  const remoteSessionId = await createWebAssistSession({
    pg,
    db,
    tenantId,
    roomName: 'web-assist-recording-role-room'
  });
  const token = signedWebAssistToken({
    tenantId,
    remoteSessionId,
    actorIdentity: 'engineer-web-assist-recording-blocked',
    role: 'engineer'
  });

  const result = (await route({
    pg,
    db,
    method: 'POST',
    path:
      `/api/collaboration/remote-assistance/${remoteSessionId}/web-assist/recordings/start` +
      `?tenant_id=${tenantId}&token=${encodeURIComponent(token)}`,
    body: { format: 'mp4' },
    headers: {}
  })) as { status: number; data: { error: string } };

  assert.equal(result.status, 403);
  assert.match(result.data.error, /customer token required/);
  db.close();
});
