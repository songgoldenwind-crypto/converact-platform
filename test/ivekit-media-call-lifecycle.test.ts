import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { routeIveKitMediaApi } from '../src/agent-runtime/converact/media-http.js';
import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { createDatabase } from '../src/db.js';
import { MemoryPg } from '../src/db-pg.js';
import { signAccessToken } from '../src/middleware/auth.js';

const JWT_SECRET = 'ivekit-media-call-lifecycle-secret-32-bytes';

test('iveKit media call lifecycle is durable idempotent and tenant scoped', async () => {
  const previousSecret = process.env.CONVERACT_JWT_SECRET;
  const previousApiKey = process.env.CONVERACT_API_KEY;
  process.env.CONVERACT_JWT_SECRET = JWT_SECRET;
  process.env.CONVERACT_API_KEY = 'ivekit-media-call-system-key';
  const db = createDatabase(':memory:');
  const pg = new MemoryPg();
  const tenantId = 'tenant_media_calls';
  const host = jwtHeaders(tenantId, 'host-engineer');
  const customer = jwtHeaders(tenantId, 'customer-led');
  try {
    const created = await mediaRoute(db, pg, 'POST', '/api/ivekit/media/calls', {
      media: 'video',
      participant_identities: ['customer-led'],
      business_ref: { type: 'service_order', id: 'SO-CALL-1' },
      ring_timeout_seconds: 30
    }, host) as MediaResponse;
    assert.equal(created.status, 201);
    assert.equal(typeof created.afterCommit, 'function');
    assert.equal(created.data.call.status, 'created');
    assert.equal(created.data.call.initiated_by, 'host-engineer');
    assert.equal(created.data.call.business_ref.tenant_id, tenantId);
    assert.equal(created.data.participants.find((item) => item.identity === 'host-engineer')?.role, 'host');
    assert.equal(created.data.participants.find((item) => item.identity === 'host-engineer')?.status, 'joined');
    assert.equal(created.data.participants.find((item) => item.identity === 'customer-led')?.status, 'invited');

    await assert.rejects(
      () => mediaRoute(
        db,
        pg,
        'GET',
        `/api/ivekit/media/calls/${created.data.call.id}`,
        null,
        jwtHeaders('tenant_media_calls_foreign', 'foreign-user')
      ),
      hasStatus(404)
    );
    await assert.rejects(
      () => mediaRoute(
        db,
        pg,
        'GET',
        `/api/ivekit/media/calls/${created.data.call.id}`,
        null,
        jwtHeaders(tenantId, 'tenant-outsider')
      ),
      hasStatus(404)
    );

    const ringing = await action(db, pg, created.data.call.id, 'ring', 'ring-1', host);
    assert.equal(ringing.data.call.status, 'ringing');
    assert.equal(
      ringing.data.participants.find((item) => item.identity === 'customer-led')?.status,
      'ringing'
    );
    await assert.rejects(
      () => mediaRoute(
        db,
        pg,
        'POST',
        `/api/ivekit/media/calls/${created.data.call.id}/join`,
        { identity: 'host-engineer' },
        host
      ),
      hasStatus(409)
    );
    await assert.rejects(
      () => mediaRoute(
        db,
        pg,
        'POST',
        `/api/ivekit/media/calls/${created.data.call.id}/join`,
        { identity: 'customer-led' },
        host
      ),
      hasStatus(403)
    );

    const accepted = await action(db, pg, created.data.call.id, 'accept', 'accept-1', customer);
    assert.equal(accepted.data.call.status, 'accepted');
    assert.equal(
      accepted.data.participants.find((item) => item.identity === 'customer-led')?.status,
      'accepted'
    );
    const hostJoin = await mediaRoute(
      db,
      pg,
      'POST',
      `/api/ivekit/media/calls/${created.data.call.id}/join`,
      { identity: 'host-engineer' },
      host
    ) as { status: number; data: { role: string; token: { token: string } } };
    assert.equal(hostJoin.status, 201);
    assert.equal(hostJoin.data.role, 'host');
    assert.match(hostJoin.data.token.token, /^dev-token:/);
    const customerJoin = await mediaRoute(
      db,
      pg,
      'POST',
      `/api/ivekit/media/calls/${created.data.call.id}/join`,
      { identity: 'customer-led' },
      customer
    ) as { status: number; data: { role: string; roomName: string; joinPath?: string } };
    assert.equal(customerJoin.status, 201);
    assert.equal(customerJoin.data.role, 'participant');
    assert.equal(customerJoin.data.roomName, created.data.call.room_name);
    assert.equal(customerJoin.data.joinPath, undefined);

    const active = await action(db, pg, created.data.call.id, 'activate', 'activate-1', host);
    assert.equal(active.data.call.status, 'active');
    const replayedAccept = await action(db, pg, created.data.call.id, 'accept', 'accept-1', customer);
    assert.equal(replayedAccept.data.call.status, 'accepted');
    assert.equal(replayedAccept.afterCommit, undefined);

    const ended = await action(db, pg, created.data.call.id, 'end', 'end-1', host, 'completed');
    assert.equal(ended.data.call.status, 'ended');
    assert.equal(ended.data.call.end_reason, 'completed');
    await assert.rejects(
      () => mediaRoute(
        db,
        pg,
        'POST',
        `/api/ivekit/media/calls/${created.data.call.id}/join`,
        { identity: 'host-engineer' },
        host
      ),
      hasStatus(409)
    );
    await assert.rejects(
      () => action(db, pg, created.data.call.id, 'fail', 'terminal-fail', host),
      hasStatus(409)
    );

    const timeoutCall = await createAndRing(db, pg, tenantId, 'SO-CALL-TIMEOUT', host);
    await assert.rejects(
      () => action(db, pg, timeoutCall.data.call.id, 'timeout', 'timeout-1', host),
      hasStatus(409)
    );

    const competing = await createAndRing(db, pg, tenantId, 'SO-CALL-COMPETE', host);
    const outcomes = await Promise.allSettled([
      action(db, pg, competing.data.call.id, 'accept', 'compete-accept', customer),
      action(db, pg, competing.data.call.id, 'reject', 'compete-reject', customer)
    ]);
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
    const current = await mediaRoute(
      db,
      pg,
      'GET',
      `/api/ivekit/media/calls/${competing.data.call.id}`,
      null,
      host
    ) as MediaResponse;
    assert.equal(['accepted', 'rejected'].includes(current.data.call.status), true);

    const keyCallA = await createAndRing(db, pg, tenantId, 'SO-CALL-KEY-A', host);
    const keyCallB = await createAndRing(db, pg, tenantId, 'SO-CALL-KEY-B', host);
    const keyOutcomes = await Promise.allSettled([
      action(db, pg, keyCallA.data.call.id, 'cancel', 'cross-call-key', host),
      action(db, pg, keyCallB.data.call.id, 'cancel', 'cross-call-key', host)
    ]);
    assert.equal(keyOutcomes.filter((item) => item.status === 'fulfilled').length, 1);
    const keyRejected = keyOutcomes.find((item) => item.status === 'rejected') as PromiseRejectedResult;
    assert.equal((keyRejected.reason as { status?: number }).status, 409);

    const joinRace = await createAndRing(db, pg, tenantId, 'SO-CALL-JOIN-RACE', host);
    await action(db, pg, joinRace.data.call.id, 'accept', 'join-race-accept', customer);
    const service = new MediaCallService(new MediaCallStore(pg));
    const joinStarted = deferred<void>();
    const releaseJoin = deferred<void>();
    const joinAuthorization = service.withJoinAuthorization(
      tenantId,
      joinRace.data.call.id,
      'customer-led',
      async () => {
        joinStarted.resolve();
        await releaseJoin.promise;
        return 'authorized';
      }
    );
    await joinStarted.promise;
    let endSettled = false;
    const endDuringJoin = service.transition({
      tenant_id: tenantId,
      call_id: joinRace.data.call.id,
      action: 'end',
      actor_identity: 'host-engineer',
      idempotency_key: 'join-race-end'
    }).finally(() => {
      endSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(endSettled, false);
    releaseJoin.resolve();
    assert.equal(await joinAuthorization, 'authorized');
    assert.equal((await endDuringJoin).snapshot.call.status, 'ended');
    await assert.rejects(
      () => service.withJoinAuthorization(
        tenantId,
        joinRace.data.call.id,
        'customer-led',
        async () => 'must-not-run'
      ),
      hasStatus(409)
    );

    const apiCreated = await mediaRoute(db, pg, 'POST', '/api/ivekit/media/calls', {
      media: 'voice',
      participant_identities: ['api-customer'],
      business_ref: { type: 'support_ticket', id: 'API-ACTOR-1' }
    }, {
      'X-API-Key': 'ivekit-media-call-system-key',
      'X-Tenant-Id': tenantId,
      'X-User-Id': 'api-host'
    }) as MediaResponse;
    assert.equal(apiCreated.data.call.initiated_by, 'api-host');

    const participants = await mediaRoute(
      db,
      pg,
      'GET',
      `/api/ivekit/media/calls/${created.data.call.id}/participants`,
      null,
      host
    ) as { data: { items: MediaParticipant[]; next_cursor: null; has_more: false } };
    assert.equal(participants.data.items.length, 2);
    assert.equal(participants.data.next_cursor, null);
    assert.equal(participants.data.has_more, false);
  } finally {
    db.close();
    restoreEnv('CONVERACT_JWT_SECRET', previousSecret);
    restoreEnv('CONVERACT_API_KEY', previousApiKey);
  }
});

test('media calls allow multiple invitees to accept and expire only after the ring deadline', async () => {
  const pg = new MemoryPg();
  let now = new Date('2026-07-12T10:00:00.000Z');
  const service = new MediaCallService(new MediaCallStore(pg), { now: () => now });
  const tenantId = 'tenant_multi_party';
  const created = await service.createCall({
    tenant_id: tenantId,
    initiated_by: 'host-1',
    media: 'video',
    participant_identities: ['guest-1', 'guest-2'],
    business_ref: { tenant_id: tenantId, type: 'order', id: 'order-multi', metadata: {} },
    ring_timeout_seconds: 30
  });
  await service.transition({
    tenant_id: tenantId, call_id: created.call.id, action: 'ring',
    actor_identity: 'host-1', idempotency_key: 'multi-ring'
  });
  const first = await service.transition({
    tenant_id: tenantId, call_id: created.call.id, action: 'accept',
    actor_identity: 'guest-1', idempotency_key: 'multi-accept-1'
  });
  assert.equal(first.snapshot.call.status, 'accepted');
  const second = await service.transition({
    tenant_id: tenantId, call_id: created.call.id, action: 'accept',
    actor_identity: 'guest-2', idempotency_key: 'multi-accept-2'
  });
  assert.equal(second.snapshot.call.status, 'accepted');
  assert.deepEqual(
    second.snapshot.participants.filter((item) => item.status === 'accepted').map((item) => item.identity).sort(),
    ['guest-1', 'guest-2']
  );
  assert.equal(
    await service.withJoinAuthorization(tenantId, created.call.id, 'guest-2', async () => 'authorized'),
    'authorized'
  );

  const expiring = await service.createCall({
    tenant_id: tenantId,
    initiated_by: 'host-1',
    media: 'voice',
    participant_identities: ['guest-3'],
    business_ref: { tenant_id: tenantId, type: 'order', id: 'order-timeout', metadata: {} },
    ring_timeout_seconds: 30
  });
  await service.transition({
    tenant_id: tenantId, call_id: expiring.call.id, action: 'ring',
    actor_identity: 'host-1', idempotency_key: 'timeout-ring'
  });
  await assert.rejects(
    () => service.transition({
      tenant_id: tenantId, call_id: expiring.call.id, action: 'timeout',
      actor_identity: 'host-1', idempotency_key: 'timeout-too-early'
    }),
    hasStatus(409)
  );
  now = new Date('2026-07-12T10:00:31.000Z');
  const summary = await service.timeoutExpired(tenantId, 25);
  assert.deepEqual(summary, { scanned: 1, timed_out: 1, skipped: 0 });
  const expired = await service.getCall(tenantId, expiring.call.id);
  assert.equal(expired?.call.status, 'timed_out');
  assert.equal(expired?.participants.find((item) => item.identity === 'guest-3')?.status, 'missed');
});

test('iveKit media call migration defines indexed FORCE RLS lifecycle tables', () => {
  const path = 'src/migrations/034_ivekit_media_calls.sql';
  assert.equal(existsSync(path), true);
  const sql = readFileSync(path, 'utf8');
  for (const table of [
    'ivekit_media_calls',
    'ivekit_media_call_participants',
    'ivekit_media_call_actions'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`CREATE POLICY tenant_isolation ON ${table}`));
  }
  assert.match(sql, /UNIQUE \(tenant_id, call_id, identity\)/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /UNIQUE \(tenant_id, id\)/);
  assert.equal(
    (sql.match(/FOREIGN KEY \(tenant_id, call_id\) REFERENCES ivekit_media_calls\(tenant_id, id\)/g) || []).length,
    2
  );
  assert.match(sql, /idx_ivekit_media_calls_business_ref/);
  assert.match(sql, /idx_ivekit_media_calls_room/);
  assert.match(sql, /idx_ivekit_media_calls_status_expiry/);
  assert.match(sql, /idx_ivekit_media_call_participants_identity/);
});

async function createAndRing(
  db: unknown,
  pg: MemoryPg,
  tenantId: string,
  businessRefId: string,
  headers: Record<string, string>
): Promise<MediaResponse> {
  const created = await mediaRoute(db, pg, 'POST', '/api/ivekit/media/calls', {
    media: 'video',
    participant_identities: ['customer-led'],
    business_ref: { type: 'service_order', id: businessRefId }
  }, headers) as MediaResponse;
  await action(db, pg, created.data.call.id, 'ring', `${businessRefId}-ring`, headers);
  return created;
}

function action(
  db: unknown,
  pg: MemoryPg,
  callId: string,
  actionName: string,
  idempotencyKey: string,
  headers: Record<string, string>,
  reason?: string
): Promise<MediaResponse> {
  return mediaRoute(
    db,
    pg,
    'POST',
    `/api/ivekit/media/calls/${callId}/actions`,
    { action: actionName, ...(reason ? { reason } : {}) },
    { ...headers, 'Idempotency-Key': idempotencyKey }
  ) as Promise<MediaResponse>;
}

function mediaRoute(
  db: unknown,
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>
) {
  return routeIveKitMediaApi(
    db,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    '',
    headers,
    { pg }
  );
}

function jwtHeaders(tenantId: string, identity: string): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken({ sub: identity, tid: tenantId, role: 'operator' })}` };
}

function hasStatus(expected: number) {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, expected);
    return true;
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

type MediaParticipant = {
  identity: string;
  role: string;
  status: string;
};

type MediaResponse = {
  status?: number;
  afterCommit?: () => void;
  data: {
    call: {
      id: string;
      tenant_id: string;
      room_name: string;
      status: string;
      initiated_by: string;
      business_ref: { tenant_id: string; type: string; id: string };
      end_reason: string;
    };
    participants: MediaParticipant[];
  };
};
