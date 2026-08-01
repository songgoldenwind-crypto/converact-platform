import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import { platformPayloadDigest, type PlatformEventV2 } from '../src/agent-runtime/converact/platform-foundation/event-envelope.js';
import type { EffectReceipt, EffectReceiptStage } from '../src/agent-runtime/converact/platform-foundation/effect-receipt.js';
import {
  PlatformFoundationStoreError,
  PostgresPlatformEventReceiptStore
} from '../src/agent-runtime/converact/platform-foundation/postgres-event-receipt-store.js';

class RecordingPg implements PgQueryable {
  calls: Array<{ text: string; params: unknown[] }> = [];
  constructor(private readonly respond: (text: string, params: unknown[]) => unknown[] = () => []) {}
  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push({ text, params });
    const rows = this.respond(text, params) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('inbox insert is tenant scoped and exact digest replay is idempotent', async () => {
  const insertedPg = new RecordingPg((sql) => /INSERT INTO converact_platform_inbox/i.test(sql)
    ? [inboxRow()]
    : []);
  const inserted = await new PostgresPlatformEventReceiptStore(insertedPg).appendInbox({
    tenant_id: 'tenant-a', consumer_id: 'projection-a', event: platformEvent()
  });
  assert.deepEqual(inserted, { status: 'inserted' });

  const replayPg = new RecordingPg((sql) => /INSERT INTO converact_platform_inbox/i.test(sql)
    ? []
    : /FROM converact_platform_inbox/i.test(sql) ? [inboxRow()] : []);
  const replay = await new PostgresPlatformEventReceiptStore(replayPg).appendInbox({
    tenant_id: 'tenant-a', consumer_id: 'projection-a', event: platformEvent()
  });
  assert.deepEqual(replay, { status: 'replay' });
  assertTenantQueries(replayPg, 'converact_platform_inbox');
});

test('inbox changed digest conflicts instead of overwriting', async () => {
  const pg = new RecordingPg((sql) => /INSERT INTO converact_platform_inbox/i.test(sql)
    ? []
    : /FROM converact_platform_inbox/i.test(sql)
      ? [inboxRow({ payload_digest: 'f'.repeat(64) })]
      : []);
  await assert.rejects(
    () => new PostgresPlatformEventReceiptStore(pg).appendInbox({
      tenant_id: 'tenant-a', consumer_id: 'projection-a', event: platformEvent()
    }),
    (error: unknown) => (error as PlatformFoundationStoreError).code === 'platform_inbox_conflict'
  );
});

test('inbox serializes an ordering scope and does not apply stale revisions', async () => {
  const incoming = platformEvent({ event_id: 'event-stale', aggregate_revision: 7 });
  const pg = new RecordingPg((sql) => {
    if (/ORDER BY inbox\.aggregate_revision DESC/i.test(sql)) {
      return [inboxRow({
        event_id: 'event-newer',
        aggregate_revision: 8,
        payload_digest: 'e'.repeat(64)
      })];
    }
    if (/INSERT INTO converact_platform_inbox/i.test(sql)) return [inboxRow()];
    return [];
  });

  const result = await new PostgresPlatformEventReceiptStore(pg).appendInbox({
    tenant_id: 'tenant-a', consumer_id: 'projection-a', event: incoming
  });

  assert.deepEqual(result, { status: 'stale' });
  assert.equal(
    pg.calls.some((call) => /INSERT INTO converact_platform_inbox/i.test(call.text)),
    true,
    'a stale event is persisted as an inbox receipt but must not be applied'
  );
  const orderingLock = pg.calls.find((call) => /pg_advisory_xact_lock/i.test(call.text));
  assert.ok(orderingLock);
  assert.match(orderingLock.text, /\$1::text[\s\S]*\$2::text[\s\S]*\$3::text/i);
});

test('inbox freezes revision gaps and same-revision conflicts before persistence', async () => {
  for (const [event, expectedCode] of [
    [platformEvent({ event_id: 'event-gap', aggregate_revision: 10 }), 'platform_inbox_gap_requires_reconcile'],
    [platformEvent({
      event_id: 'event-same-revision',
      aggregate_revision: 7,
      payload_digest: 'f'.repeat(64)
    }), 'platform_inbox_conflict']
  ] as const) {
    const pg = new RecordingPg((sql) => {
      if (/ORDER BY inbox\.aggregate_revision DESC/i.test(sql)) return [inboxRow()];
      if (/INSERT INTO converact_platform_inbox/i.test(sql)) return [inboxRow()];
      return [];
    });
    await assert.rejects(
      () => new PostgresPlatformEventReceiptStore(pg).appendInbox({
        tenant_id: 'tenant-a', consumer_id: 'projection-a', event
      }),
      (error: unknown) => (error as PlatformFoundationStoreError).code === expectedCode,
      expectedCode
    );
    assert.equal(pg.calls.some((call) => /INSERT INTO converact_platform_inbox/i.test(call.text)), false);
  }
});

test('effect receipt append uses latest generation and owner epoch fencing', async () => {
  const accepted = receipt('accepted');
  const completed = receipt('completed');
  const pg = new RecordingPg((sql) => {
    if (/MAX\(current_receipt\.generation\)/i.test(sql)) return [accepted];
    if (/INSERT INTO converact_platform_effect_receipts/i.test(sql)) return [completed];
    return [];
  });
  const result = await new PostgresPlatformEventReceiptStore(pg).appendEffectReceipt(completed);
  assert.deepEqual(result, { status: 'inserted' });
  assert.match(pg.calls.find((call) => /MAX\(current_receipt\.generation\)/i.test(call.text))!.text, /LIMIT 3/i);

  const stalePg = new RecordingPg((sql) => /MAX\(current_receipt\.generation\)/i.test(sql)
    ? [accepted]
    : []);
  await assert.rejects(
    () => new PostgresPlatformEventReceiptStore(stalePg).appendEffectReceipt(
      receipt('completed', { owner_epoch: 7 })
    ),
    (error: unknown) => (error as PlatformFoundationStoreError).code === 'platform_effect_stale_writer'
  );
  assert.equal(stalePg.calls.some((call) => /INSERT INTO converact_platform_effect_receipts/i.test(call.text)), false);
});

test('state-observed receipt replays from a complete persisted generation', async () => {
  const history = [receipt('accepted'), receipt('completed'), receipt('state_observed')];
  const pg = new RecordingPg((sql) => /MAX\(current_receipt\.generation\)/i.test(sql)
    ? history
    : []);
  const replay = await new PostgresPlatformEventReceiptStore(pg).appendEffectReceipt(
    receipt('state_observed')
  );
  assert.deepEqual(replay, { status: 'replay' });
  assert.equal(pg.calls.some((call) => /INSERT INTO converact_platform_effect_receipts/i.test(call.text)), false);
});

test('outbox claim is tenant-scoped skip-locked and strictly bounded', async () => {
  const pg = new RecordingPg((sql) => /WITH candidate AS/i.test(sql) ? [{
    id: 'outbox-a', tenant_id: 'tenant-a', event_id: 'event-a', payload_digest: 'a'.repeat(64),
    aggregate_revision: 7, ordering_key: 'tenant-a:interaction:a', lease_until: '2026-08-01T12:01:00.000Z'
  }] : []);
  const store = new PostgresPlatformEventReceiptStore(pg);
  const claims = await store.claimOutbox({
    tenant_id: 'tenant-a', worker_id: 'worker-a', lease_token_hash: 'b'.repeat(64),
    now: new Date('2026-08-01T12:00:00.000Z'), lease_ms: 60_000, limit: 20
  });
  assert.equal(claims.length, 1);
  const query = pg.calls.find((call) => /WITH candidate AS/i.test(call.text))!;
  assert.match(query.text, /FOR UPDATE SKIP LOCKED/i);
  assert.match(query.text, /outbox\.tenant_id = \$1/i);
  assert.equal(query.params[2], 20);
  await assert.rejects(() => store.claimOutbox({
    tenant_id: 'tenant-a', worker_id: 'worker-a', lease_token_hash: 'b'.repeat(64),
    now: new Date('2026-08-01T12:00:00.000Z'), lease_ms: 60_000, limit: 201
  }), /platform_claim_invalid/);
});

function platformEvent(overrides: Partial<PlatformEventV2> = {}): PlatformEventV2 {
  const data = { state: 'ready' };
  return {
    schema_version: 2, source_schema_version: 2, event_id: 'event-a',
    event_type: 'interaction.state.changed', tenant_id: 'tenant-a',
    producer_identity: 'interaction-worker-a', authority: 'Converact Interaction',
    aggregate_type: 'interaction', aggregate_id: 'interaction-a', aggregate_revision: 7,
    ordering_key: 'tenant-a:interaction:a', idempotency_key: 'interaction-a:7',
    payload_digest: platformPayloadDigest(data), occurred_at: '2026-08-01T12:00:00.000Z',
    observed_at: '2026-08-01T12:00:00.010Z', correlation: { correlation_id: 'correlation-a' },
    causation_event_id: null, purpose: 'state_projection', region_policy: 'tenant-primary',
    retention_policy: 'event-30d', data, extensions: {}, ...overrides
  };
}

function inboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const event = platformEvent();
  return {
    tenant_id: 'tenant-a', consumer_id: 'projection-a', event_id: event.event_id,
    payload_digest: event.payload_digest, aggregate_revision: event.aggregate_revision,
    ordering_key: event.ordering_key, ...overrides
  };
}

function receipt(stage: EffectReceiptStage, overrides: Partial<EffectReceipt> = {}): EffectReceipt {
  return {
    receipt_id: `receipt-${stage}`, tenant_id: 'tenant-a', effect_id: 'effect-a',
    event_id: `event-${stage}`, correlation_id: 'correlation-a', stage, generation: 4,
    writer_id: 'effect-worker-a', owner_epoch: 8,
    receipt_digest: ({ accepted: 'a', completed: 'b', state_observed: 'c' } as const)[stage].repeat(64),
    observed_at: '2026-08-01T12:00:00.000Z', ...overrides
  };
}

function assertTenantQueries(pg: RecordingPg, table: string): void {
  const calls = pg.calls.filter((call) => new RegExp(table, 'i').test(call.text));
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.match(call.text, /tenant_id = \$1|\(tenant_id,[\s\S]*VALUES\s*\(\$1,/i);
    assert.equal(call.params[0], 'tenant-a');
  }
}
