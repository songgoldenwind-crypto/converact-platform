import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { buildIveKitStandaloneContext } from '../scripts/ivekit-standalone-build-context.js';
import {
  TinodeInboundProjectionError,
  TinodeInboundStore
} from '../src/agent-runtime/collaboration/tinode-inbound-store.js';
import {
  describeRejectedTinodePacket,
  normalizeTinodeInboundPacket
} from '../src/agent-runtime/collaboration/tinode-inbound-protocol.js';
import { applyIveKitMigrations } from '../src/ivekit-migrations.js';
import { initializeIveKitRuntimeRole } from '../src/ivekit-runtime-role.js';

const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const runtimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const runtimePassword = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const maybe = adminUrl && runtimeUrl && runtimePassword ? test : test.skip;

maybe('Tinode inbound claim, inbox replay, drift detection, dead letter, and cursor are durable', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const runtime = new Pool({ connectionString: runtimeUrl, max: 2 });
  const root = mkdtempSync(join(tmpdir(), 'ivekit-tinode-inbound-store-'));
  const context = join(root, 'context');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenantId = `tenant_inbound_${suffix}`;
  const sessionId = `collab_inbound_${suffix}`;
  const bindingId = `cbind_inbound_${suffix}`;
  const topic = `grpInbound${suffix}`;
  let now = new Date('2026-07-12T12:00:00.000Z');
  try {
    buildIveKitStandaloneContext({
      repoRoot: resolve('.'),
      outputDir: context,
      sourceCommit: 'tinode-inbound-test',
      generatedAt: now.toISOString()
    });
    await initializeIveKitRuntimeRole(admin, runtimePassword);
    await applyIveKitMigrations(admin, {
      directory: join(context, 'migrations'),
      advisoryLockName: 'ivekit_tinode_inbound_store_test'
    });
    await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'Tinode inbound']);
    await admin.query(
      `INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id, title)
       VALUES ($1, $2, 'order', $3, 'Tinode inbound')`,
      [sessionId, tenantId, `ORDER-${suffix}`]
    );
    await admin.query(
      `INSERT INTO collaboration_chat_bindings
        (id, tenant_id, session_id, provider, provider_topic_id, provider_status)
       VALUES ($1, $2, $3, 'tinode', $4, 'bound')`,
      [bindingId, tenantId, sessionId, topic]
    );

    const store = new TinodeInboundStore({ pg: runtime, now: () => now });
    assert.deepEqual(await store.discoverTenantIds({ limit: 10 }), [tenantId]);
    const concurrentStore = new TinodeInboundStore({ pg: runtime, now: () => now });
    const claims = await Promise.all([
      store.claimNext({ tenant_id: tenantId, lease_ms: 60_000 }),
      concurrentStore.claimNext({ tenant_id: tenantId, lease_ms: 60_000 })
    ]);
    const claim = claims.find((candidate) => candidate !== null) || null;
    assert.ok(claim);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claim.cursor.last_data_seq, 0);
    assert.equal(await store.claimNext({ tenant_id: tenantId, lease_ms: 30_000 }), null);

    const first = normalizeTinodeInboundPacket({
      data: { topic, seq: 1, from: 'usrInbound', content: 'hello' }
    }, { expectedTopic: topic, allowedAttachmentHosts: [] });
    const projected = await store.processEvent(claim, first, async () => ({ status: 'ignored' }));
    assert.equal(projected.status, 'ignored');
    assert.equal(projected.replayed, false);
    const replay = await store.processEvent(claim, first, async () => {
      throw new Error('replay must not invoke projector');
    });
    assert.equal(replay.replayed, true);

    const drift = normalizeTinodeInboundPacket({
      data: { topic, seq: 1, from: 'usrInbound', content: 'changed' }
    }, { expectedTopic: topic, allowedAttachmentHosts: [] });
    await assert.rejects(
      () => store.processEvent(claim, drift, async () => ({ status: 'ignored' })),
      /payload drift/i
    );

    const poison = normalizeTinodeInboundPacket({
      data: { topic, seq: 2, from: 'usrUnknown', content: 'poison' }
    }, { expectedTopic: topic, allowedAttachmentHosts: [] });
    const deadLetter = await store.processEvent(claim, poison, async () => {
      throw new TinodeInboundProjectionError('provider_user_unmapped', 'provider user is not mapped', true);
    });
    assert.equal(deadLetter.status, 'dead_letter');
    assert.equal(deadLetter.replayed, false);
    now = new Date('2026-07-12T12:00:31.000Z');
    const retried = await store.retryDueDeadLetters(
      claim,
      { limit: 10, maxAttempts: 3, retryDelayMs: 5_000 },
      async (_pg, event) => {
        assert.equal(event.dedupe_key, 'data:2');
        return { status: 'ignored' };
      }
    );
    assert.equal(retried.length, 1);
    assert.equal(retried[0].result.status, 'ignored');
    const rejectedPacket = {
      data: {
        topic,
        seq: 3,
        from: 'usrInbound',
        content: { txt: '', ent: [{ tp: 'IM', data: { val: 'must-not-persist' } }] }
      }
    };
    let rejectedError: unknown;
    try {
      normalizeTinodeInboundPacket(rejectedPacket, { expectedTopic: topic, allowedAttachmentHosts: [] });
    } catch (error) {
      rejectedError = error;
    }
    const rejectedEvent = describeRejectedTinodePacket(rejectedPacket, topic, rejectedError);
    const rejected = await store.rejectEvent(claim, rejectedEvent);
    assert.equal(rejected.status, 'dead_letter');
    const interruptedEvent = normalizeTinodeInboundPacket({
      data: { topic, seq: 4, from: 'usrInbound', content: 'transaction recovery' }
    }, { expectedTopic: topic, allowedAttachmentHosts: [] });
    await assert.rejects(
      () => store.processEvent(claim, interruptedEvent, async () => {
        throw new Error('simulated transaction interruption');
      }),
      /simulated transaction interruption/
    );
    const afterInterruption = await admin.query(
      `SELECT
         (SELECT last_data_seq FROM tinode_inbound_cursors WHERE tenant_id = $1 AND binding_id = $2) AS seq,
         (SELECT count(*) FROM tinode_inbound_events WHERE tenant_id = $1) AS event_count`,
      [tenantId, bindingId]
    );
    assert.equal(Number(afterInterruption.rows[0].seq), 3);
    assert.equal(Number(afterInterruption.rows[0].event_count), 3);
    const recovered = await store.processEvent(claim, interruptedEvent, async () => ({ status: 'ignored' }));
    assert.equal(recovered.status, 'ignored');
    await store.releaseClaim(claim);

    const cursor = await admin.query(
      `SELECT last_data_seq, last_del_id, lease_token_hash, lease_until
       FROM tinode_inbound_cursors WHERE tenant_id = $1 AND binding_id = $2`,
      [tenantId, bindingId]
    );
    assert.equal(Number(cursor.rows[0].last_data_seq), 4);
    assert.equal(Number(cursor.rows[0].last_del_id), 0);
    assert.equal(cursor.rows[0].lease_token_hash, '');
    assert.equal(cursor.rows[0].lease_until, null);
    assert.equal(Number((await admin.query(
      `SELECT count(*) FROM tinode_inbound_events WHERE tenant_id = $1`
    , [tenantId])).rows[0].count), 4);
    const storedDeadLetter = await admin.query(
      `SELECT error_code, payload_hash, retryable, retry_count, resolved_at
       FROM tinode_inbound_dead_letters WHERE tenant_id = $1`,
      [tenantId]
    );
    assert.deepEqual(storedDeadLetter.rows.map((row) => ({
      error_code: row.error_code,
      payload_hash: row.payload_hash,
      retryable: Number(row.retryable),
      retry_count: Number(row.retry_count),
      resolved: Boolean(row.resolved_at)
    })).sort((left, right) => String(left.error_code).localeCompare(String(right.error_code))), [{
      error_code: 'embedded_attachment_not_supported',
      payload_hash: rejectedEvent.payload_hash,
      retryable: 0,
      retry_count: 0,
      resolved: false
    }, {
      error_code: 'provider_user_unmapped',
      payload_hash: poison.payload_hash,
      retryable: 1,
      retry_count: 1,
      resolved: true
    }]);
    const rejectedPayload = await admin.query(
      `SELECT payload FROM tinode_inbound_events
       WHERE tenant_id = $1 AND binding_id = $2 AND dedupe_key = 'data:3'`,
      [tenantId, bindingId]
    );
    assert.equal(JSON.stringify(rejectedPayload.rows[0].payload).includes('must-not-persist'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await runtime.end();
    await admin.end();
  }
});
