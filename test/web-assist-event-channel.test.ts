import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { createWebAssistJoinPath } from '../src/agent-runtime/converact/remote-assist-token.js';
import { MemoryPg } from '../src/db-pg.js';

const API_KEY = 'test-web-assist-event-key';

function authHeaders(tenantId: string, userId = 'agent-web-assist'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders('tenant_web_assist_events')
) {
  return routeCollaborationApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers
  );
}

test('Web Assist events can be recorded through collaboration HTTP', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_web_assist_events';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    {
      business_ref: { type: 'service_order', id: 'order-web-assist-events' }
    },
    authHeaders(tenantId)
  )) as { data: { id: string } };

  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: sessionResult.data.id,
      mode: 'web_remote_assist',
      adapter_provider: 'converact_web'
    },
    authHeaders(tenantId)
  )) as { data: { id: string } };

  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
    {
      actor_identity: 'buyer-web-assist',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    authHeaders(tenantId)
  );

  const eventResult = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/events`,
    {
      actor_identity: 'buyer-web-assist',
      event_type: 'pointer.move',
      payload: { x: 320, y: 180 }
    },
    authHeaders(tenantId)
  )) as {
    status: number;
    data: {
      remote_session_id: string;
      actor_identity: string;
      event_type: string;
      payload: Record<string, unknown>;
    };
  };
  assert.equal(eventResult.status, 201);
  assert.equal(eventResult.data.remote_session_id, remoteResult.data.id);
  assert.equal(eventResult.data.actor_identity, 'buyer-web-assist');
  assert.equal(eventResult.data.event_type, 'pointer.move');
  assert.deepEqual(eventResult.data.payload, { x: 320, y: 180 });

  const timeline = (await route(
    pg,
    'GET',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/timeline`,
    null,
    authHeaders(tenantId)
  )) as { data: { audit_events: Array<{ event_type: string }> } };
  assert.equal(
    timeline.data.audit_events.some((event) => event.event_type === 'remote.web_assist.pointer.move'),
    true
  );
});

test('public Web Assist tokens can record customer browser events', async () => {
  process.env.CONVERACT_API_KEY = API_KEY;
  const pg = new MemoryPg();
  const tenantId = 'tenant_web_assist_public_events';

  const sessionResult = (await route(
    pg,
    'POST',
    '/api/collaboration/sessions',
    {
      business_ref: { type: 'service_order', id: 'order-web-assist-public-events' }
    },
    authHeaders(tenantId)
  )) as { data: { id: string } };

  const remoteResult = (await route(
    pg,
    'POST',
    '/api/collaboration/remote-assistance/sessions',
    {
      collaboration_session_id: sessionResult.data.id,
      mode: 'web_remote_assist',
      adapter_provider: 'converact_web'
    },
    authHeaders(tenantId)
  )) as { data: { id: string } };

  await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/consent/grant`,
    {
      actor_identity: 'buyer-public-web-assist',
      scopes: ['view_screen'],
      expires_at: '2099-01-01T00:00:00.000Z'
    },
    authHeaders(tenantId)
  );

  const joinPath = createWebAssistJoinPath({
    tenant_id: tenantId,
    remote_session_id: remoteResult.data.id,
    actor_identity: 'buyer-public-web-assist',
    role: 'customer',
    expires_at: '2099-01-01T00:00:00.000Z'
  });
  const token = new URL(`http://localhost${joinPath}`).searchParams.get('token') || '';
  const eventResult = (await route(
    pg,
    'POST',
    `/api/collaboration/remote-assistance/${remoteResult.data.id}/web-assist/events?tenant_id=${tenantId}&token=${encodeURIComponent(token)}`,
    {
      event_type: 'screen.share_started',
      payload: { video: true }
    },
    {}
  )) as {
    status: number;
    data: {
      actor_identity: string;
      event_type: string;
      payload: Record<string, unknown>;
    };
  };

  assert.equal(eventResult.status, 201);
  assert.equal(eventResult.data.actor_identity, 'buyer-public-web-assist');
  assert.equal(eventResult.data.event_type, 'screen.share_started');
  assert.deepEqual(eventResult.data.payload, { video: true });
});

test('Web Assist events use the shared tenant WebSocket broadcast channel', () => {
  const source = readFileSync('src/agent-runtime/collaboration/collaboration-http.ts', 'utf8');
  assert.match(source, /wsBroadcast\(input\.tenantId, 'remote\.web_assist\.event', event\)/);
  assert.match(source, /\/web-assist\\\/events/);
});
