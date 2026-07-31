import assert from 'node:assert/strict';
import test from 'node:test';

import { routeIveKitEventApi } from '../src/agent-runtime/ivekit/event-http.js';
import { IveKitTenantEventStore } from '../src/agent-runtime/ivekit/tenant-event-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

function authHeaders(tenantId: string, userId: string): Record<string, string> {
  const token = signAccessToken({ sub: userId, tid: tenantId, role: 'operator' });
  return { authorization: `Bearer ${token}` };
}

test('iveKit event HTTP exposes head and explicit replay recovery states', async () => {
  process.env.OPC_JWT_SECRET = 'ivekit-event-http-secret';
  const pg = new MemoryPg();
  const tenantId = 'tenant_event_http';
  const headers = authHeaders(tenantId, 'viewer-1');

  const initial = (await routeIveKitEventApi(
    pg,
    'GET',
    '/api/ivekit/events',
    new URL('http://localhost/api/ivekit/events'),
    headers
  )) as { status?: number; data: { items: unknown[]; next_cursor: string; snapshot_required: boolean } };
  assert.deepEqual(initial.data.items, []);
  assert.equal(initial.data.snapshot_required, false);
  assert.ok(initial.data.next_cursor);

  const events = new IveKitTenantEventStore(pg);
  const appended = await events.append({
    tenant_id: tenantId,
    type: 'tenant.notice.updated',
    data: { notice_id: 'notice-1' }
  });
  const replayUrl = new URL('http://localhost/api/ivekit/events');
  replayUrl.searchParams.set('cursor', initial.data.next_cursor);
  replayUrl.searchParams.set('limit', '10');
  const replay = (await routeIveKitEventApi(
    pg,
    'GET',
    replayUrl.pathname,
    replayUrl,
    headers
  )) as {
    status?: number;
    data: { items: Array<{ event_id: string; type: string }>; next_cursor: string; snapshot_required: boolean };
  };
  assert.equal(replay.status, undefined);
  assert.equal(replay.data.snapshot_required, false);
  assert.deepEqual(replay.data.items.map((event) => event.event_id), [appended.event_id]);
  assert.ok(replay.data.next_cursor);

  replayUrl.searchParams.set('cursor', replay.data.next_cursor);
  const converged = (await routeIveKitEventApi(
    pg,
    'GET',
    replayUrl.pathname,
    replayUrl,
    headers
  )) as { data: { items: unknown[] } };
  assert.deepEqual(converged.data.items, []);

  replayUrl.searchParams.set('cursor', `${appended.cursor}x`);
  const invalid = (await routeIveKitEventApi(
    pg,
    'GET',
    replayUrl.pathname,
    replayUrl,
    headers
  )) as { status: number; data: { snapshot_required: boolean; reason: string } };
  assert.equal(invalid.status, 409);
  assert.equal(invalid.data.snapshot_required, true);
  assert.equal(invalid.data.reason, 'invalid_cursor');

  assert.equal(await routeIveKitEventApi(
    pg,
    'POST',
    '/api/ivekit/events',
    new URL('http://localhost/api/ivekit/events'),
    headers
  ), undefined);
});

test('iveKit event replay can be disabled independently', async () => {
  process.env.OPC_JWT_SECRET = 'ivekit-event-http-secret';
  process.env.OPC_IVEKIT_EVENT_REPLAY_ENABLED = '0';
  try {
    await assert.rejects(
      () => routeIveKitEventApi(
        new MemoryPg(),
        'GET',
        '/api/ivekit/events',
        new URL('http://localhost/api/ivekit/events'),
        authHeaders('tenant_event_disabled', 'viewer-disabled')
      ),
      (error: unknown) => (error as { status?: number }).status === 503
    );
  } finally {
    delete process.env.OPC_IVEKIT_EVENT_REPLAY_ENABLED;
  }
});
