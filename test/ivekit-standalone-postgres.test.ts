import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { Pool } from 'pg';

import { buildIveKitStandaloneContext } from '../scripts/ivekit-standalone-build-context.js';
import { runMigrations } from '../src/db-pg.js';
import { applyIveKitMigrations } from '../src/ivekit-migrations.js';
import { initializeIveKitRuntimeRole } from '../src/ivekit-runtime-role.js';
import { IveKitTenantEventStore } from '../src/agent-runtime/ivekit/tenant-event-store.js';
import {
  AttachmentProcessingService,
  type AttachmentTextProvider
} from '../src/agent-runtime/collaboration/attachment-processing.js';
import {
  QualityReviewService,
  type QualityReviewProvider
} from '../src/agent-runtime/collaboration/quality-review.js';
import { RustDeskDeviceCommandStore } from '../src/agent-runtime/collaboration/rustdesk-device-command-store.js';
import { TranslationService } from '../src/agent-runtime/collaboration/translation-service.js';
import type { TranslationProvider } from '../src/agent-runtime/collaboration/translation-provider.js';
import { withPgTenant } from '../src/db-pg-tenant.js';

const freshAdminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const freshRuntimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const upgradeAdminUrl = process.env.OPC_IVEKIT_UPGRADE_TEST_DATABASE_URL || '';
const upgradeRuntimeUrl = process.env.OPC_IVEKIT_UPGRADE_TEST_RUNTIME_DATABASE_URL || '';
const runtimePassword = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const testSourceCommit = 'c'.repeat(40);
const freshTest = freshAdminUrl && freshRuntimeUrl && runtimePassword ? test : test.skip;
const upgradeTest = upgradeAdminUrl && upgradeRuntimeUrl && runtimePassword ? test : test.skip;

function standaloneMigrations(): { directory: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-standalone-postgres-'));
  const outputDir = join(root, 'context');
  buildIveKitStandaloneContext({
    repoRoot: resolve('.'),
    outputDir,
    sourceCommit: testSourceCommit,
    generatedAt: '2026-07-12T00:00:00.000Z'
  });
  return {
    directory: join(outputDir, 'migrations'),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

freshTest('standalone PostgreSQL fresh migration is minimal, checksummed, idempotent, and RLS enforced', async () => {
  const admin = new Pool({ connectionString: freshAdminUrl, max: 1 });
  const runtime = new Pool({ connectionString: freshRuntimeUrl, max: 1 });
  const migrations = standaloneMigrations();
  try {
    await initializeIveKitRuntimeRole(admin, runtimePassword);
    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_fresh_migrations'
    });

    const tables = await admin.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    for (const forbidden of ['users', 'voice_call_sessions', 'leads', 'campaigns', 'ivr_flows']) {
      assert.equal(tables.rows.some((row) => row.tablename === forbidden), false, forbidden);
    }
    for (const required of [
      'tenants',
      'collaboration_sessions',
      'collaboration_intelligence_policies',
      'collaboration_intelligence_source_links',
      'collaboration_translation_jobs',
      'ivekit_media_calls',
      'ivekit_tenant_events',
      'rustdesk_gateway_sessions'
    ]) assert.equal(tables.rows.some((row) => row.tablename === required), true, required);

    const checksums = await admin.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM schema_migrations ORDER BY version`
    );
    const expectedVersions = readdirSync(migrations.directory)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -4))
      .sort();
    assert.deepEqual(checksums.rows.map((row) => row.version), expectedVersions);
    assert.equal(checksums.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)), true);

    const rlsGaps = await admin.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_schema = n.nspname
       AND col.table_name = c.relname
       AND col.column_name = 'tenant_id'
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
    `);
    assert.deepEqual(rlsGaps.rows, []);

    const privileges = await admin.query<{
      can_create: boolean;
      can_read_ledger: boolean;
      is_superuser: boolean;
      bypasses_rls: boolean;
      can_create_role: boolean;
    }>(`
      SELECT
        has_schema_privilege('opc_runtime', 'public', 'CREATE') AS can_create,
        has_table_privilege('opc_runtime', 'public.schema_migrations', 'SELECT') AS can_read_ledger,
        rolsuper AS is_superuser,
        rolbypassrls AS bypasses_rls,
        rolcreaterole AS can_create_role
      FROM pg_roles
      WHERE rolname = 'opc_runtime'
    `);
    assert.deepEqual(privileges.rows[0], {
      can_create: false,
      can_read_ledger: false,
      is_superuser: false,
      bypasses_rls: false,
      can_create_role: false
    });

    await admin.query(`INSERT INTO tenants (id, name) VALUES ('ivekit_rls_a', 'A'), ('ivekit_rls_b', 'B')`);
    await admin.query(`
      INSERT INTO collaboration_intelligence_policies
        (tenant_id, translation_enabled, translation_profile_id, updated_by)
      VALUES
        ('ivekit_rls_a', TRUE, 'translation-a', 'admin'),
        ('ivekit_rls_b', TRUE, 'translation-b', 'admin')
    `);
    const recoveryNow = new Date('2026-07-12T12:00:00.000Z');
    const qualityBody = 'controlled quality recovery source';
    const translationBody = 'controlled translation recovery source';
    const qualityHash = createHash('sha256').update(qualityBody).digest('hex');
    const translationHash = createHash('sha256').update(translationBody).digest('hex');
    await admin.query(`
      INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES ('ivekit_worker_recovery_session', 'ivekit_rls_a', 'order', 'RECOVERY-1', 'Worker recovery');
      INSERT INTO collaboration_messages
        (id, tenant_id, session_id, sender_identity, message_type, body)
      VALUES
        ('ivekit_worker_attachment_message', 'ivekit_rls_a', 'ivekit_worker_recovery_session', 'agent-a', 'file', ''),
        ('ivekit_worker_quality_message', 'ivekit_rls_a', 'ivekit_worker_recovery_session', 'agent-a', 'text', '${qualityBody}'),
        ('ivekit_worker_translation_message', 'ivekit_rls_a', 'ivekit_worker_recovery_session', 'agent-a', 'text', '${translationBody}');
      INSERT INTO collaboration_message_attachments
        (id, tenant_id, session_id, message_id, kind, storage_url, filename,
         content_type, size_bytes, checksum, processing_status)
      VALUES
        ('ivekit_worker_attachment', 'ivekit_rls_a', 'ivekit_worker_recovery_session',
         'ivekit_worker_attachment_message', 'image', 'ivekit://controlled/recovery',
         'recovery.txt', 'text/plain', 19, 'sha256-worker-recovery', 'pending');
      INSERT INTO collaboration_attachment_processing_jobs
        (id, tenant_id, session_id, message_id, attachment_id, processor, status,
         attempt_count, max_attempts, lease_until, worker_id)
      VALUES
        ('ivekit_worker_attachment_job', 'ivekit_rls_a', 'ivekit_worker_recovery_session',
         'ivekit_worker_attachment_message', 'ivekit_worker_attachment', 'ocr', 'processing',
         1, 3, '2026-07-12T11:59:00.000Z', 'crashed-attachment-worker');
      INSERT INTO collaboration_quality_review_jobs
        (id, tenant_id, session_id, message_id, input_hash, status, attempt_count,
         max_attempts, lease_until, worker_id, automatic)
      VALUES
        ('ivekit_worker_quality_job', 'ivekit_rls_a', 'ivekit_worker_recovery_session',
         'ivekit_worker_quality_message', '${qualityHash}', 'processing', 1, 3,
         '2026-07-12T11:59:00.000Z', 'crashed-quality-worker', FALSE);
      INSERT INTO collaboration_translation_jobs
        (id, tenant_id, session_id, message_id, source_type, source_ref_id,
         source_language, target_language, source_hash, status, attempt_count, max_attempts,
         lease_until, worker_id, idempotency_key, payload_hash, automatic)
      VALUES
        ('ivekit_worker_translation_job', 'ivekit_rls_a', 'ivekit_worker_recovery_session',
         'ivekit_worker_translation_message', 'message', 'ivekit_worker_translation_message',
         'auto', 'zh-CN', '${translationHash}', 'processing', 1, 3,
         '2026-07-12T11:59:00.000Z', 'crashed-translation-worker',
         'ivekit-worker-translation-recovery', '${'d'.repeat(64)}', FALSE)
    `);
    const attachmentProvider: AttachmentTextProvider = {
      processor: 'ocr',
      name: 'controlled-recovery-ocr',
      mode: 'self_hosted',
      profile_id: 'controlled-recovery-ocr',
      extract: async () => ({ text: 'controlled OCR recovery', confidence: 0.99 })
    };
    const qualityProvider: QualityReviewProvider = {
      name: 'controlled-recovery-quality',
      mode: 'self_hosted',
      profile_id: 'controlled-recovery-quality',
      review: async () => ({ findings: [], metadata: { recovery: true } })
    };
    const translationProvider: TranslationProvider = {
      name: 'controlled-recovery-translation',
      mode: 'self_hosted',
      profile_id: 'controlled-recovery-translation',
      translate: async (input) => ({
        translated_text: `[${input.target_language}] ${input.text}`,
        detected_language: 'en-US',
        confidence: 0.99
      })
    };
    const attachmentRecovery = new AttachmentProcessingService({
      pg: runtime,
      providers: { ocr: attachmentProvider },
      resolveObject: async () => ({ status: 'readable', content: Buffer.from('controlled recovery') }),
      now: () => recoveryNow,
      claimLeaseMs: 30_000
    });
    const qualityRecovery = new QualityReviewService({
      pg: runtime,
      provider: qualityProvider,
      now: () => recoveryNow,
      claimLeaseMs: 30_000
    });
    const translationRecovery = new TranslationService({
      pg: runtime,
      provider: translationProvider,
      now: () => recoveryNow,
      claimLeaseMs: 30_000
    });
    assert.deepEqual(await attachmentRecovery.runDue({ tenant_id: 'ivekit_rls_a', limit: 10 }), {
      candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0
    });
    assert.deepEqual(await qualityRecovery.runDue({ tenant_id: 'ivekit_rls_a', limit: 10 }), {
      candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0
    });
    assert.deepEqual(await translationRecovery.runDue({ tenant_id: 'ivekit_rls_a', limit: 10 }), {
      candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0
    });
    const recoveredJobs = await admin.query<{
      id: string;
      status: string;
      attempt_count: number;
      worker_id: string;
      lease_until: string | null;
    }>(`
      SELECT id, status, attempt_count, worker_id, lease_until
      FROM (
        SELECT id, status, attempt_count, worker_id, lease_until
        FROM collaboration_attachment_processing_jobs
        WHERE id = 'ivekit_worker_attachment_job'
        UNION ALL
        SELECT id, status, attempt_count, worker_id, lease_until
        FROM collaboration_quality_review_jobs
        WHERE id = 'ivekit_worker_quality_job'
        UNION ALL
        SELECT id, status, attempt_count, worker_id, lease_until
        FROM collaboration_translation_jobs
        WHERE id = 'ivekit_worker_translation_job'
      ) recovered
      ORDER BY id
    `);
    assert.deepEqual(recoveredJobs.rows, [
      { id: 'ivekit_worker_attachment_job', status: 'succeeded', attempt_count: 2, worker_id: '', lease_until: null },
      { id: 'ivekit_worker_quality_job', status: 'succeeded', attempt_count: 2, worker_id: '', lease_until: null },
      { id: 'ivekit_worker_translation_job', status: 'succeeded', attempt_count: 2, worker_id: '', lease_until: null }
    ]);
    await admin.query(`
      INSERT INTO rustdesk_devices
        (id, tenant_id, business_ref_type, business_ref_id, rustdesk_id, display_name)
      VALUES ('ivekit_recovery_device', 'ivekit_rls_a', 'order', 'A-1', '123456789', 'Recovery device');
      INSERT INTO rustdesk_gateway_sessions
        (external_id, tenant_id, target_id, actor_identity)
      VALUES
        ('ivekit_recovery_executed', 'ivekit_rls_a', 'ivekit_recovery_device', 'tester'),
        ('ivekit_recovery_uncertain', 'ivekit_rls_a', 'ivekit_recovery_device', 'tester');
      INSERT INTO rustdesk_device_commands
        (id, tenant_id, device_id, external_id, requested_by, requested_reason)
      VALUES
        ('ivekit_recovery_command_executed', 'ivekit_rls_a', 'ivekit_recovery_device', 'ivekit_recovery_executed', 'tester', 'gateway_ended'),
        ('ivekit_recovery_command_uncertain', 'ivekit_rls_a', 'ivekit_recovery_device', 'ivekit_recovery_uncertain', 'tester', 'gateway_ended')
    `);
    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      const visiblePolicies = await tenantPg.query<{ tenant_id: string; translation_profile_id: string }>(
        `SELECT tenant_id, translation_profile_id
         FROM collaboration_intelligence_policies
         ORDER BY tenant_id`
      );
      assert.deepEqual(visiblePolicies.rows, [{
        tenant_id: 'ivekit_rls_a',
        translation_profile_id: 'translation-a'
      }]);
      await assert.rejects(
        () => tenantPg.query(`
          UPDATE collaboration_intelligence_policies
          SET translation_profile_id = 'cross-tenant-write'
          WHERE tenant_id = 'ivekit_rls_b'
          RETURNING tenant_id
        `).then((result) => {
          if (result.rowCount === 0) throw new Error('row-level security blocked cross-tenant policy update');
          return result;
        }),
        /row-level security/i
      );

      const commands = new RustDeskDeviceCommandStore(tenantPg);
      const executedClaim = (await commands.claimNext({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        edge_instance_id: 'ivekit-recovery-edge',
        lease_ms: 1_000,
        now: '2026-07-12T00:00:00.000Z'
      }))!;
      assert.equal(executedClaim.command.id, 'ivekit_recovery_command_executed');
      const resumed = await commands.recover({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        command_id: executedClaim.command.id,
        edge_instance_id: 'ivekit-recovery-edge',
        attempt: 1,
        state: 'executed',
        lease_ms: 30_000,
        now: '2026-07-12T00:00:05.000Z'
      });
      assert.equal(resumed.action, 'resume_report');
      assert.equal(resumed.command.attempt_count, 1);
      await commands.complete({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        command_id: executedClaim.command.id,
        claim_token: resumed.claim_token!,
        status: 'succeeded',
        execution_method: 'session_adapter',
        exit_code: 0,
        duration_ms: 10,
        stdout_bytes: 0,
        stderr_bytes: 0,
        now: '2026-07-12T00:00:05.100Z'
      });

      const uncertainClaim = (await commands.claimNext({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        edge_instance_id: 'ivekit-recovery-edge',
        lease_ms: 1_000,
        now: '2026-07-12T00:01:00.000Z'
      }))!;
      assert.equal(uncertainClaim.command.id, 'ivekit_recovery_command_uncertain');
      const uncertain = await commands.recover({
        tenant_id: 'ivekit_rls_a',
        device_id: 'ivekit_recovery_device',
        command_id: uncertainClaim.command.id,
        edge_instance_id: 'ivekit-recovery-edge',
        attempt: 1,
        state: 'executing',
        lease_ms: 30_000,
        now: '2026-07-12T00:01:05.000Z'
      });
      assert.equal(uncertain.action, 'quarantine');
      assert.equal(uncertain.command.status, 'failed');
      assert.equal(uncertain.command.result_metadata.error_code, 'edge_recovery_execution_uncertain');
    });
    await admin.query(`
      INSERT INTO collaboration_sessions (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES ('ivekit_rls_session_b', 'ivekit_rls_b', 'order', 'B-1', 'private B')
    `);

    const eventStore = new IveKitTenantEventStore(runtime, {
      cursor_secret: 'standalone-postgres-event-secret'
    });
    const eventHead = await eventStore.headCursor('ivekit_rls_a');
    const durableEvent = await eventStore.append({
      tenant_id: 'ivekit_rls_a',
      type: 'tenant.acceptance.updated',
      data: { acceptance_id: 'event-a' }
    });
    const replay = await eventStore.list({
      tenant_id: 'ivekit_rls_a',
      user_id: 'runtime-user-a',
      role: 'operator',
      cursor: eventHead,
      limit: 10
    });
    assert.deepEqual(replay.items.map((event) => event.event_id), [durableEvent.event_id]);
    const foreignReplay = await eventStore.list({
      tenant_id: 'ivekit_rls_b',
      user_id: 'runtime-user-b',
      role: 'admin',
      cursor: await eventStore.headCursor('ivekit_rls_b'),
      limit: 10
    });
    assert.deepEqual(foreignReplay.items, []);

    let retentionNow = new Date('2026-07-12T10:00:00.000Z');
    const retentionStore = new IveKitTenantEventStore(runtime, {
      cursor_secret: 'standalone-postgres-retention-secret',
      retention_ms: 1_000,
      now: () => retentionNow
    });
    await retentionStore.append({
      tenant_id: 'ivekit_rls_a',
      type: 'tenant.expired.acceptance',
      data: { acceptance_id: 'expired-event-a' }
    });
    retentionNow = new Date('2026-07-12T10:00:02.000Z');
    assert.deepEqual(await retentionStore.pruneExpired({
      now: retentionNow,
      tenant_limit: 10,
      batch_size: 100
    }), { tenants: 1, deleted: 1 });

    const client = await runtime.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', 'ivekit_rls_a', true)`);
      await client.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
      const foreign = await client.query(
        `SELECT id FROM collaboration_sessions WHERE tenant_id = 'ivekit_rls_b'`
      );
      assert.equal(foreign.rowCount, 0);
      await assert.rejects(
        () => client.query(`
          INSERT INTO collaboration_sessions
            (id, tenant_id, business_ref_type, business_ref_id)
          VALUES ('ivekit_cross_tenant_write', 'ivekit_rls_b', 'order', 'B-2')
        `),
        /row-level security|policy/i
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_fresh_migrations'
    });
    const preserved = await admin.query(
      `SELECT id FROM collaboration_sessions WHERE id = 'ivekit_rls_session_b'`
    );
    assert.equal(preserved.rowCount, 1);
  } finally {
    migrations.cleanup();
    await runtime.end();
    await admin.end();
  }
});

upgradeTest('existing OPC schema upgrades through standalone runner without product or communication data loss', async () => {
  const admin = new Pool({ connectionString: upgradeAdminUrl, max: 1 });
  const runtime = new Pool({ connectionString: upgradeRuntimeUrl, max: 1 });
  const migrations = standaloneMigrations();
  try {
    await runMigrations(admin, {
      directory: resolve('src/migrations'),
      advisoryLockName: 'ivekit_test_opc_root_migrations'
    });
    await admin.query(`INSERT INTO tenants (id, name) VALUES ('ivekit_upgrade_tenant', 'Upgrade tenant')`);
    await admin.query(`
      INSERT INTO campaigns (id, tenant_id, name)
      VALUES ('ivekit_upgrade_campaign', 'ivekit_upgrade_tenant', 'Preserved campaign')
    `);
    await admin.query(`
      INSERT INTO collaboration_sessions (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES ('ivekit_upgrade_session', 'ivekit_upgrade_tenant', 'order', 'UP-1', 'Preserved session')
    `);
    const productTablesBefore = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `);

    await initializeIveKitRuntimeRole(admin, runtimePassword);
    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_upgrade_migrations'
    });
    await applyIveKitMigrations(admin, {
      directory: migrations.directory,
      advisoryLockName: 'ivekit_test_upgrade_migrations'
    });

    const productTablesAfter = await admin.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `);
    assert.equal(Number(productTablesAfter.rows[0].count) >= Number(productTablesBefore.rows[0].count), true);
    assert.equal((await admin.query(
      `SELECT id FROM campaigns WHERE id = 'ivekit_upgrade_campaign'`
    )).rowCount, 1);
    assert.equal((await admin.query(
      `SELECT id FROM collaboration_sessions WHERE id = 'ivekit_upgrade_session'`
    )).rowCount, 1);

    const standaloneVersions = await admin.query<{ version: string; count: string }>(`
      SELECT version, count(*)::text AS count
      FROM schema_migrations
      WHERE version IN (
        '000_ivekit_foundation',
        '043_ivekit_intelligence_translation',
        '044_quality_review_policy_routing',
        '045_translation_worker_routing',
        '090_ivekit_runtime_security'
      )
      GROUP BY version
      ORDER BY version
    `);
    assert.deepEqual(standaloneVersions.rows, [
      { version: '000_ivekit_foundation', count: '1' },
      { version: '043_ivekit_intelligence_translation', count: '1' },
      { version: '044_quality_review_policy_routing', count: '1' },
      { version: '045_translation_worker_routing', count: '1' },
      { version: '090_ivekit_runtime_security', count: '1' }
    ]);

    await assert.rejects(
      () => runtime.query('SELECT version FROM schema_migrations'),
      /permission denied/i
    );
    await assert.rejects(
      () => runtime.query('CREATE TABLE ivekit_runtime_must_not_create (id TEXT)'),
      /permission denied/i
    );
  } finally {
    migrations.cleanup();
    await runtime.end();
    await admin.end();
  }
});
