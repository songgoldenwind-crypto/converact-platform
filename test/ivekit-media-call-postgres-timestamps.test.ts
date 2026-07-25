import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import {
  runMediaCallTimeoutBatch
} from '../src/agent-runtime/livekit/media-call-timeout-worker.js';
import {
  MemoryPg,
  type PgQueryable
} from '../src/db-pg.js';

const TENANT_ID = 'tenant-pg-timestamp';
const HOST_ID = 'host-1';
const GUEST_ID = 'guest-1';
const RING_NOW = new Date('2026-07-25T08:00:00.000Z');

test('durable calls round-trip PostgreSQL Date timestamps through every lifecycle action', async () => {
  const pg = new DateReturningPg();
  const service = new MediaCallService(
    new MediaCallStore(pg),
    { now: () => RING_NOW }
  );
  const created = await createCall(service, 'order-lifecycle');
  const ringing = await transition(service, created.call.id, 'ring', 'ring-1');

  assert.equal(
    ringing.snapshot.call.ring_expires_at,
    '2026-07-25T08:00:30.000Z'
  );
  const accepted = await transition(
    service,
    created.call.id,
    'accept',
    'accept-1',
    GUEST_ID
  );
  await transition(service, created.call.id, 'activate', 'activate-1');
  const ended = await transition(
    service,
    created.call.id,
    'end',
    'end-1'
  );
  const replayed = await transition(
    service,
    created.call.id,
    'accept',
    'accept-1',
    GUEST_ID
  );

  assert.equal(accepted.snapshot.call.status, 'accepted');
  assert.equal(ended.snapshot.call.status, 'ended');
  assert.equal(replayed.snapshot.call.status, 'accepted');
  assertCanonicalTimestamps(ended.snapshot);

  const cancellable = await createCall(service, 'order-cancel');
  await transition(service, cancellable.call.id, 'ring', 'ring-cancel');
  const cancelled = await transition(
    service,
    cancellable.call.id,
    'cancel',
    'cancel-1'
  );
  assert.equal(cancelled.snapshot.call.status, 'cancelled');
  assertCanonicalTimestamps(cancelled.snapshot);
});

test('timeout worker expires ringing calls decoded from PostgreSQL Date values', async () => {
  const pg = new DateReturningPg();
  const service = new MediaCallService(
    new MediaCallStore(pg),
    { now: () => RING_NOW }
  );
  const created = await createCall(service, 'order-timeout');
  await transition(service, created.call.id, 'ring', 'ring-timeout');

  const summary = await runMediaCallTimeoutBatch({
    pg,
    now: new Date('2026-07-25T08:00:31.000Z'),
    tenantLimit: 10,
    batchSize: 10
  });
  const snapshot = await service.getCall(TENANT_ID, created.call.id);

  assert.deepEqual(summary, {
    tenants: 1,
    scanned: 1,
    timed_out: 1,
    skipped: 0
  });
  assert.equal(snapshot?.call.status, 'timed_out');
  assertCanonicalTimestamps(snapshot!);
});

class DateReturningPg extends MemoryPg implements PgQueryable {
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>> {
    for (const value of params ?? []) {
      if (typeof value === 'string' &&
          /^[A-Z][a-z]{2} [A-Z][a-z]{2} .+ GMT[+-]\d{4}/.test(value)) {
        throw new Error(
          `invalid input syntax for type timestamp with time zone: "${value}"`
        );
      }
    }
    const result = await super.query(text, params);
    return {
      ...result,
      rows: result.rows.map((row) => dateRow(row)) as R[]
    };
  }
}

function dateRow(row: QueryResultRow): QueryResultRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (key.endsWith('_at') &&
        typeof value === 'string' &&
        Number.isFinite(Date.parse(value))) {
      return [key, new Date(value)];
    }
    return [key, value];
  }));
}

function createCall(service: MediaCallService, businessId: string) {
  return service.createCall({
    tenant_id: TENANT_ID,
    initiated_by: HOST_ID,
    media: 'video',
    participant_identities: [GUEST_ID],
    business_ref: {
      tenant_id: TENANT_ID,
      type: 'order',
      id: businessId,
      metadata: {}
    },
    ring_timeout_seconds: 30
  });
}

function transition(
  service: MediaCallService,
  callId: string,
  action: 'ring' | 'accept' | 'activate' | 'end' | 'cancel',
  idempotencyKey: string,
  actorIdentity = HOST_ID
) {
  return service.transition({
    tenant_id: TENANT_ID,
    call_id: callId,
    action,
    actor_identity: actorIdentity,
    idempotency_key: idempotencyKey
  });
}

function assertCanonicalTimestamps(
  snapshot: Awaited<ReturnType<MediaCallService['getCall']>>
): void {
  assert.ok(snapshot);
  const values = [
    snapshot.call.ring_expires_at,
    snapshot.call.accepted_at,
    snapshot.call.started_at,
    snapshot.call.ended_at,
    snapshot.call.created_at,
    snapshot.call.updated_at,
    ...snapshot.participants.flatMap((participant) => [
      participant.invited_at,
      participant.accepted_at,
      participant.joined_at,
      participant.left_at,
      participant.updated_at
    ])
  ].filter((value): value is string => value !== null);
  for (const value of values) {
    assert.equal(new Date(value).toISOString(), value);
  }
}
