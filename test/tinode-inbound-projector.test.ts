import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { buildIveKitStandaloneContext } from '../scripts/ivekit-standalone-build-context.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { TinodeInboundProjector } from '../src/agent-runtime/collaboration/tinode-inbound-projector.js';
import { normalizeTinodeInboundPacket } from '../src/agent-runtime/collaboration/tinode-inbound-protocol.js';
import { TinodeInboundStore } from '../src/agent-runtime/collaboration/tinode-inbound-store.js';
import { TinodeInboundService } from '../src/agent-runtime/collaboration/tinode-inbound-worker.js';
import { QualityReviewService } from '../src/agent-runtime/collaboration/quality-review.js';
import { applyIveKitMigrations } from '../src/ivekit-migrations.js';
import { initializeIveKitRuntimeRole } from '../src/ivekit-runtime-role.js';
import { withPgTenant } from '../src/db-pg-tenant.js';

const adminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const runtimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const runtimePassword = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const maybe = adminUrl && runtimeUrl && runtimePassword ? test : test.skip;

maybe('Tinode inbound projector mirrors text, Drafty attachments, replacements, deletes, and policy scans', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const runtime = new Pool({ connectionString: runtimeUrl, max: 2 });
  const root = mkdtempSync(join(tmpdir(), 'ivekit-tinode-inbound-projector-'));
  const context = join(root, 'context');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const tenantId = `tenant_projector_${suffix}`;
  const sessionId = `collab_projector_${suffix}`;
  const bindingId = `cbind_projector_${suffix}`;
  const participantId = `cpart_projector_${suffix}`;
  const providerUserId = `usrProjector${suffix}`;
  const topic = `grpProjector${suffix}`;
  const now = new Date('2026-07-12T12:00:00.000Z');
  try {
    buildIveKitStandaloneContext({
      repoRoot: resolve('.'),
      outputDir: context,
      sourceCommit: 'tinode-projector-test',
      generatedAt: now.toISOString()
    });
    await initializeIveKitRuntimeRole(admin, runtimePassword);
    await applyIveKitMigrations(admin, {
      directory: join(context, 'migrations'),
      advisoryLockName: 'ivekit_tinode_inbound_projector_test'
    });
    await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, 'Tinode projector']);
    await admin.query(
      `INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id, title)
       VALUES ($1, $2, 'order', $3, 'Tinode projector')`,
      [sessionId, tenantId, `ORDER-${suffix}`]
    );
    await admin.query(
      `INSERT INTO collaboration_participants
        (id, tenant_id, session_id, identity, role)
       VALUES ($1, $2, $3, 'customer-projector', 'customer')`,
      [participantId, tenantId, sessionId]
    );
    await admin.query(
      `INSERT INTO collaboration_chat_bindings
        (id, tenant_id, session_id, provider, provider_topic_id, provider_status)
       VALUES ($1, $2, $3, 'tinode', $4, 'bound')`,
      [bindingId, tenantId, sessionId, topic]
    );
    await admin.query(
      `INSERT INTO collaboration_provider_users
        (id, tenant_id, session_id, binding_id, provider, provider_user_id, identity)
       VALUES ($1, $2, $3, $4, 'tinode', $5, 'customer-projector')`,
      [`cpuser_${suffix}`, tenantId, sessionId, bindingId, providerUserId]
    );

    const store = new TinodeInboundStore({ pg: runtime, now: () => now });
    const projector = new TinodeInboundProjector({ now: () => now, mutationWindowMs: 86_400_000 });
    const claim = await store.claimNext({ tenant_id: tenantId, lease_ms: 60_000 });
    assert.ok(claim);
    const project = (event: ReturnType<typeof normalizeTinodeInboundPacket>) =>
      store.processEvent(claim, event, (pg) => projector.project(pg, claim, event));

    const created = await project(normalizeTinodeInboundPacket({
      data: { topic, seq: 1, from: providerUserId, content: 'call me at +86 138 0000 1111' }
    }, { expectedTopic: topic, allowedAttachmentHosts: ['files.example.com'] }));
    assert.equal(created.status, 'projected');
    assert.ok(created.message_id);

    const edited = await project(normalizeTinodeInboundPacket({
      data: {
        topic,
        seq: 2,
        from: providerUserId,
        head: { replace: 'msg:1' },
        content: 'edited body'
      }
    }, { expectedTopic: topic, allowedAttachmentHosts: ['files.example.com'] }));
    assert.equal(edited.message_id, created.message_id);

    const attachment = await project(normalizeTinodeInboundPacket({
      data: {
        topic,
        seq: 3,
        from: providerUserId,
        content: {
          txt: 'photo',
          fmt: [{ at: 0, len: 5, key: 0 }],
          ent: [{
            tp: 'IM',
            data: {
              ref: 'https://files.example.com/photo.jpg',
              mime: 'image/jpeg',
              name: 'photo.jpg',
              size: 4321,
              val: 'embedded-bytes-must-not-persist'
            }
          }]
        }
      }
    }, { expectedTopic: topic, allowedAttachmentHosts: ['files.example.com'] }));
    assert.ok(attachment.message_id);

    const deleted = await project(normalizeTinodeInboundPacket({
      meta: { topic, del: { clear: 1, delseq: [{ low: 1, hi: 4 }] } }
    }, { expectedTopic: topic, allowedAttachmentHosts: ['files.example.com'] }));
    assert.equal(deleted.status, 'projected');
    await store.releaseClaim(claim);

    const service = new TinodeInboundService({
      store,
      source: {
        async pull(input) {
          assert.deepEqual(input, {
            provider_topic_id: topic,
            last_data_seq: 3,
            last_del_id: 1,
            limit: 25
          });
          return [{
            data: { topic, seq: 4, from: providerUserId, content: 'quality review this inbound message' }
          }];
        }
      },
      projector,
      config: {
        tenantLimit: 10,
        pullLimit: 25,
        claimLeaseMs: 60_000,
        retryDelayMs: 5_000,
        deadLetterMaxAttempts: 3,
        allowedAttachmentHosts: ['files.example.com']
      },
      onProjected: async ({ pg, claim: projectedClaim, event, projection }) => {
        if (event.kind === 'data' && projection.status === 'projected' && projection.message_id) {
          await new QualityReviewService({ pg }).enqueueMessage({
            tenant_id: projectedClaim.tenant_id,
            message_id: projection.message_id
          });
        }
      }
    });
    const serviceResult = await service.runDue();
    assert.equal(serviceResult.projected, 1);

    const messages = await admin.query(
      `SELECT id, body, current_body, message_type, provider_sequence, provider_version,
              provider_sender_id, deleted_at, deleted_by
       FROM collaboration_messages WHERE tenant_id = $1 ORDER BY provider_sequence`,
      [tenantId]
    );
    assert.equal(messages.rowCount, 3);
    assert.deepEqual(messages.rows.map((row) => Number(row.provider_sequence)), [1, 3, 4]);
    assert.equal(messages.rows[0].current_body, 'edited body');
    assert.equal(messages.rows[0].deleted_by, 'tinode');
    assert.ok(messages.rows[0].deleted_at);
    assert.equal(messages.rows[1].message_type, 'image');
    assert.ok(messages.rows[1].deleted_at);
    assert.equal(messages.rows.every((row) => row.provider_sender_id === providerUserId), true);
    const messageDtos = await withPgTenant(runtime, tenantId, (pg) =>
      new CollaborationStore(pg).listMessages({ tenant_id: tenantId, session_id: sessionId, limit: 20 })
    );
    assert.deepEqual(messageDtos.map((message) => ({
      origin: message.provider_origin,
      sequence: message.provider_sequence,
      version: message.provider_version,
      sender: message.provider_sender_id
    })), [
      { origin: 'tinode', sequence: 1, version: 2, sender: providerUserId },
      { origin: 'tinode', sequence: 3, version: 3, sender: providerUserId },
      { origin: 'tinode', sequence: 4, version: 4, sender: providerUserId }
    ]);

    const attachments = await admin.query(
      `SELECT storage_url, filename, content_type, size_bytes, metadata
       FROM collaboration_message_attachments WHERE tenant_id = $1`,
      [tenantId]
    );
    assert.equal(attachments.rowCount, 1);
    assert.equal(attachments.rows[0].storage_url, 'https://files.example.com/photo.jpg');
    assert.equal(JSON.stringify(attachments.rows[0]).includes('embedded-bytes-must-not-persist'), false);
    assert.equal(Number((await admin.query(
      `SELECT count(*) FROM collaboration_message_mutations WHERE tenant_id = $1`,
      [tenantId]
    )).rows[0].count), 3);
    assert.equal(Number((await admin.query(
      `SELECT count(*) FROM collaboration_policy_events WHERE tenant_id = $1`,
      [tenantId]
    )).rows[0].count) >= 1, true);
    assert.equal(Number((await admin.query(
      `SELECT count(*) FROM collaboration_quality_review_jobs WHERE tenant_id = $1`,
      [tenantId]
    )).rows[0].count), 1);
    const cursor = await admin.query(
      `SELECT last_data_seq, last_del_id FROM tinode_inbound_cursors
       WHERE tenant_id = $1 AND binding_id = $2`,
      [tenantId, bindingId]
    );
    assert.deepEqual({
      data: Number(cursor.rows[0].last_data_seq),
      del: Number(cursor.rows[0].last_del_id)
    }, { data: 4, del: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
    await runtime.end();
    await admin.end();
  }
});
