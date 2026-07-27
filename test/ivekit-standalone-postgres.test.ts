import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
import { RustDeskAuthorizationCodeStore } from '../src/agent-runtime/collaboration/rustdesk-authorization-code-store.js';
import { TranslationService } from '../src/agent-runtime/collaboration/translation-service.js';
import type { TranslationProvider } from '../src/agent-runtime/collaboration/translation-provider.js';
import { IntelligenceProviderGovernanceStore } from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { TinodeFileDeliveryGate } from '../src/agent-runtime/collaboration/tinode-file-delivery-gate.js';
import { TinodeMessageMutationStore } from '../src/agent-runtime/collaboration/tinode-message-mutation.js';
import { TinodeOperationsService } from '../src/agent-runtime/collaboration/tinode-operations.js';
import { withPgTenant } from '../src/db-pg-tenant.js';
import { MediaCallService } from '../src/agent-runtime/livekit/media-call-service.js';
import { MediaCallStore } from '../src/agent-runtime/livekit/media-call-store.js';
import { MediaQualityService } from '../src/agent-runtime/livekit/media-quality-service.js';
import { MediaQualityStore } from '../src/agent-runtime/livekit/media-quality-store.js';
import {
  ControlledVoiceProviderFactory,
  EncryptedVoiceAddressProtector,
  PostgresVoiceCallStore,
  PostgresVoiceCommandStore,
  PostgresVoiceConfigurationStore,
  PostgresVoiceProviderEventStore,
  PostgresVoiceRecordingStore,
  VoiceProviderRegistry,
  routeIveKitVoiceApi,
  type VoiceCallCommand,
  type VoiceProviderEvent,
  type VoiceRecording
} from '../src/agent-runtime/ivekit/voice/index.js';

const freshAdminUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_DATABASE_URL || '';
const freshRuntimeUrl = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const upgradeAdminUrl = process.env.OPC_IVEKIT_UPGRADE_TEST_DATABASE_URL || '';
const upgradeRuntimeUrl = process.env.OPC_IVEKIT_UPGRADE_TEST_RUNTIME_DATABASE_URL || '';
const runtimePassword = process.env.OPC_IVEKIT_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const testSourceCommit = 'c'.repeat(40);
const freshTest = freshAdminUrl && freshRuntimeUrl && runtimePassword ? test : test.skip;
const upgradeTest = upgradeAdminUrl && upgradeRuntimeUrl && runtimePassword ? test : test.skip;

const voiceFoundationTables = [
  'ivekit_voice_deployment_profiles',
  'ivekit_voice_capability_snapshots',
  'ivekit_voice_sip_trunks',
  'ivekit_voice_dids',
  'ivekit_voice_extensions',
  'ivekit_voice_routes',
  'ivekit_voice_route_versions',
  'ivekit_voice_calls',
  'ivekit_voice_call_participants',
  'ivekit_voice_call_commands',
  'ivekit_voice_configuration_commands',
  'ivekit_voice_provider_events',
  'ivekit_voice_livekit_bridges',
  'ivekit_voice_recordings',
  'ivekit_voice_consents',
  'ivekit_voice_policies',
  'ivekit_voice_webrtc_sessions',
  'ivekit_voice_parking_slots'
];

const voiceExtensionTables = [
  'ivekit_voice_route_snapshot_revisions',
  'ivekit_recording_manifests',
  'ivekit_recording_segments',
  'ivekit_recording_segment_events',
  'ivekit_recording_upload_leases',
  'ivekit_recording_segment_uploads',
  'ivekit_recording_upload_parts',
  'ivekit_voice_extension_sessions',
  'ivekit_voice_cdr_durability_contracts',
  'ivekit_voice_dialog_terminal_repairs',
  'ivekit_voice_terminal_repair_worker_leases',
  'ivekit_voice_cdr_calls',
  'ivekit_voice_cdr_legs',
  'ivekit_voice_cdr_submissions',
  'ivekit_voice_cdr_receipts'
];

const ivrFoundationTables = [
  'ivekit_ivr_flows',
  'ivekit_ivr_flow_versions',
  'ivekit_ivr_sessions',
  'ivekit_ivr_session_steps',
  'ivekit_ivr_pending_actions',
  'ivekit_ivr_audio_assets',
  'ivekit_ivr_time_groups',
  'ivekit_ivr_region_groups',
  'ivekit_ivr_ring_groups',
  'ivekit_ivr_settings'
];

const contactCenterTables = [
  'ivekit_cc_skills',
  'ivekit_cc_agents',
  'ivekit_cc_agent_skills',
  'ivekit_cc_agent_presence',
  'ivekit_cc_queues',
  'ivekit_cc_queue_memberships',
  'ivekit_cc_queue_skill_requirements',
  'ivekit_cc_queue_entries',
  'ivekit_cc_assignments',
  'ivekit_cc_callbacks',
  'ivekit_cc_supervisor_sessions',
  'ivekit_cc_routing_cursors',
  'ivekit_cc_configuration_idempotency',
  'ivekit_cc_overflow_actions'
];

const providerGovernanceTables = [
  'collaboration_intelligence_provider_runtime',
  'collaboration_intelligence_provider_leases'
];

const contentIntelligenceTables = ['collaboration_visual_observations'];

const notificationTables = [
  'ivekit_notification_templates',
  'ivekit_notification_template_versions',
  'ivekit_notification_preferences',
  'ivekit_notification_endpoints',
  'ivekit_notification_endpoint_runtime',
  'ivekit_notifications',
  'ivekit_notification_deliveries',
  'ivekit_notification_inbox_items',
  'ivekit_notification_receipts'
];

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

function opcMigrationsWithoutVoiceFoundation(): { directory: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-v3-shaped-migrations-'));
  const directory = join(root, 'migrations');
  mkdirSync(directory);
  for (const name of readdirSync(resolve('src/migrations')).filter((name) => name.endsWith('.sql'))) {
    if ([
      '046_ivekit_voice_foundation.sql',
      '047_ivekit_ivr_foundation.sql',
      '048_ivekit_voice_operations.sql',
      '049_ivekit_voice_route_deployment.sql',
      '050_ivekit_ivr_runtime.sql',
      '051_ivekit_ivr_resources.sql',
      '052_ivekit_contact_center.sql',
      '053_ivekit_contact_center_configuration_idempotency.sql',
      '054_ivekit_contact_center_worker.sql',
      '055_ivekit_contact_center_callbacks.sql',
      '056_ivekit_contact_center_overflow.sql',
      '057_ivekit_voice_action_capabilities.sql',
      '058_ivekit_voice_parking.sql',
      '059_ivekit_provider_governance.sql',
      '060_ivekit_content_intelligence.sql',
      '079_ivekit_voice_route_snapshot_revision.sql',
      '086_ivekit_recording_manifests.sql',
      '090_ivekit_runtime_security.sql',
      '094_ivekit_voice_extension_sessions.sql',
      '097_ivekit_realtime_intelligence.sql',
      '103_ivekit_voice_cdr_convergence.sql'
    ].includes(name)) continue;
    copyFileSync(resolve('src/migrations', name), join(directory, name));
  }
  return {
    directory,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

async function seedVoiceIvrTenant(pg: Pool, suffix: string): Promise<void> {
  const tenantId = `ivekit_rls_${suffix}`;
  const profileId = `ivekit_voice_profile_${suffix}`;
  const routeId = `ivekit_voice_route_${suffix}`;
  const callId = `ivekit_voice_call_${suffix}`;
  const flowId = `ivekit_ivr_flow_${suffix}`;
  const hash = (label: string) => createHash('sha256').update(`${suffix}:${label}`).digest('hex');
  const graph = JSON.stringify({
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 100, y: 0 }, data: {} }
    ],
    edges: [{ id: 'start-end', source: 'start', target: 'end', sourceHandle: 'out' }],
    variables: []
  });
  await pg.query(
    `INSERT INTO ivekit_voice_deployment_profiles
      (id, tenant_id, name, adapter, status)
     VALUES ($1, $2, $3, 'controlled', 'enabled')`,
    [profileId, tenantId, `Controlled ${suffix}`]
  );
  await pg.query(
    `INSERT INTO ivekit_voice_routes
      (id, tenant_id, profile_id, name, direction, status)
     VALUES ($1, $2, $3, $4, 'both', 'active')`,
    [routeId, tenantId, profileId, `Route ${suffix}`]
  );
  await pg.query(
    `INSERT INTO ivekit_voice_route_versions
      (id, tenant_id, route_id, version, rules, payload_hash, published_by)
     VALUES ($1, $2, $3, 1, '{}'::JSONB, $4, 'postgres-test')`,
    [`ivekit_voice_route_version_${suffix}`, tenantId, routeId, hash('route')]
  );
  await pg.query(
    `INSERT INTO ivekit_voice_calls
      (id, tenant_id, business_ref_type, business_ref_id, provider_profile_id,
       direction, from_address_kind, from_address_ciphertext, from_address_hmac,
       from_address_redacted, to_address_kind, to_address_ciphertext, to_address_hmac,
       to_address_redacted, idempotency_key)
     VALUES ($1, $2, 'order', $3, $4, 'inbound', 'e164', $5, $6, '+86******01',
             'extension', $7, $8, '10**', $9)`,
    [
      callId,
      tenantId,
      `ORDER-${suffix}`,
      profileId,
      `cipher-from-${suffix}`,
      hash('from'),
      `cipher-to-${suffix}`,
      hash('to'),
      `voice-call-${suffix}`
    ]
  );
  await pg.query(
    `INSERT INTO ivekit_ivr_flows
      (id, tenant_id, name, status, draft_graph, current_published_version)
     VALUES ($1, $2, $3, 'published', $4::JSONB, 1)`,
    [flowId, tenantId, `Flow ${suffix}`, graph]
  );
  await pg.query(
    `INSERT INTO ivekit_ivr_flow_versions
      (id, tenant_id, flow_id, version, graph, graph_hash, published_by)
     VALUES ($1, $2, $3, 1, $4::JSONB, $5, 'postgres-test')`,
    [`ivekit_ivr_flow_version_${suffix}`, tenantId, flowId, graph, hash('graph')]
  );
  await pg.query(
    `INSERT INTO ivekit_ivr_sessions
      (id, tenant_id, call_id, flow_id, flow_version, current_node_id)
     VALUES ($1, $2, $3, $4, 1, 'start')`,
    [`ivekit_ivr_session_${suffix}`, tenantId, callId, flowId]
  );
  await pg.query(
    `INSERT INTO ivekit_ivr_session_steps
      (id, tenant_id, session_id, step_index, flow_id, flow_version, node_id, action)
     VALUES ($1, $2, $3, 0, $4, 1, 'start', '{"kind":"wait"}'::JSONB)`,
    [`ivekit_ivr_step_${suffix}`, tenantId, `ivekit_ivr_session_${suffix}`, flowId]
  );
}

freshTest('standalone PostgreSQL fresh migration is minimal, checksummed, idempotent, and RLS enforced', async () => {
  const admin = new Pool({ connectionString: freshAdminUrl, max: 1 });
  const runtime = new Pool({ connectionString: freshRuntimeUrl, max: 4 });
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
    for (const forbidden of [
      'users', 'voice_call_sessions', 'leads', 'campaigns', 'ivr_flows',
      'ivr_sessions', 'audio_library'
    ]) {
      assert.equal(tables.rows.some((row) => row.tablename === forbidden), false, forbidden);
    }
    for (const required of [
      'tenants',
      'collaboration_sessions',
      'collaboration_intelligence_policies',
      'collaboration_intelligence_source_links',
      'collaboration_translation_jobs',
      'collaboration_intelligence_provider_runtime',
      'collaboration_intelligence_provider_leases',
      'ivekit_media_calls',
      'ivekit_media_quality_snapshots',
      'ivekit_media_connection_events',
      'ivekit_tenant_events',
      'rustdesk_gateway_sessions',
      'rustdesk_authorization_codes',
      ...voiceFoundationTables,
      ...ivrFoundationTables,
      ...contactCenterTables,
      ...notificationTables,
      'ivekit_audit_events',
      'ivekit_rate_limit_buckets',
      'ivekit_retention_policies',
      'ivekit_legal_holds',
      'ivekit_retention_runs',
      'ivekit_audit_retention_checkpoints',
      'ivekit_runtime_heartbeats'
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

    await admin.query(`
      INSERT INTO tenants (id, name) VALUES
        ('ivekit_rls_a', 'A'),
        ('ivekit_rls_b', 'B'),
        ('ivekit_retention_held', 'Retention held'),
        ('ivekit_retention_ready', 'Retention ready')
    `);
    await admin.query(`
      INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id)
      VALUES ('ivekit_mutation_recovery_session', 'ivekit_rls_a', 'test', 'mutation-recovery');
      INSERT INTO collaboration_messages
        (id, tenant_id, session_id, sender_identity, message_type, body,
         provider, provider_topic_id, provider_message_id)
      VALUES
        ('ivekit_mutation_recovery_message', 'ivekit_rls_a',
         'ivekit_mutation_recovery_session', 'sender', 'text', 'before',
         'tinode', 'grpMutationRecovery', '12');
      INSERT INTO collaboration_message_mutations
        (id, tenant_id, session_id, message_id, version, action, actor_identity,
         before_body_hash, after_body_hash)
      VALUES
        ('ivekit_mutation_recovery', 'ivekit_rls_a',
         'ivekit_mutation_recovery_session', 'ivekit_mutation_recovery_message',
         1, 'edit', 'sender', repeat('a', 64), repeat('b', 64));
      INSERT INTO tinode_message_mutation_outbox
        (id, tenant_id, session_id, message_id, mutation_id, mutation_version,
         action, provider_topic_id, body, status, attempt_count, max_attempts,
         claim_token, claimed_until)
      VALUES
        ('ivekit_mutation_recovery_outbox', 'ivekit_rls_a',
         'ivekit_mutation_recovery_session', 'ivekit_mutation_recovery_message',
         'ivekit_mutation_recovery', 1, 'edit', 'grpMutationRecovery', 'after',
         'processing', 1, 3, 'expired-claim', '2026-07-15T00:00:00.000Z')
    `);
    const recoveredMutationClaim = await new TinodeMessageMutationStore(runtime).claimNext({
      tenant_id: 'ivekit_rls_a',
      now: new Date('2026-07-16T00:00:00.000Z'),
      lease_ms: 30_000
    });
    assert.equal(recoveredMutationClaim?.id, 'ivekit_mutation_recovery_outbox');
    assert.equal(recoveredMutationClaim?.recovered_from_processing, true);
    const heldEvent = await admin.query<{ id: string }>(`
      INSERT INTO ivekit_tenant_events (tenant_id, event_type, expires_at)
      VALUES ('ivekit_retention_held', 'retention.held', '2026-07-01T00:00:00.000Z')
      RETURNING id::text
    `);
    await admin.query(`
      INSERT INTO ivekit_tenant_events (tenant_id, event_type, expires_at)
      VALUES ('ivekit_retention_ready', 'retention.ready', '2026-07-02T00:00:00.000Z')
    `);
    await admin.query(`
      INSERT INTO ivekit_legal_holds
        (id, tenant_id, category, resource_type, resource_id, reason_code,
         idempotency_key, placed_by)
      VALUES
        ('ivekit_event_hold', 'ivekit_retention_held', 'tenant_events', 'tenant_event',
         $1, 'legal_case', 'ivekit-event-hold', 'retention-test')
    `, [heldEvent.rows[0]!.id]);
    const retentionTenants = await admin.query<{ tenant_id: string }>(`
      SELECT tenant_id FROM opc_ivekit_event_retention_tenant_ids(
        '2026-07-15T00:00:00.000Z'::timestamptz,
        1
      )
    `);
    assert.deepEqual(retentionTenants.rows, [{ tenant_id: 'ivekit_retention_ready' }]);
    await admin.query(`DELETE FROM ivekit_legal_holds WHERE id = 'ivekit_event_hold'`);
    await admin.query(`
      DELETE FROM ivekit_tenant_events
      WHERE tenant_id IN ('ivekit_retention_held', 'ivekit_retention_ready')
    `);
    await admin.query(`
      DELETE FROM tenants WHERE id IN ('ivekit_retention_held', 'ivekit_retention_ready')
    `);
    await admin.query(`
      INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES
        ('ivekit_authorization_session_a', 'ivekit_rls_a', 'order', 'AUTH-A', 'Authorization A'),
        ('ivekit_authorization_session_b', 'ivekit_rls_b', 'order', 'AUTH-B', 'Authorization B');
      INSERT INTO remote_assistance_sessions
        (id, tenant_id, collaboration_session_id, business_ref_type, business_ref_id,
         status, mode, adapter_provider, started_by)
      VALUES
        ('ivekit_authorization_remote_a', 'ivekit_rls_a', 'ivekit_authorization_session_a',
         'order', 'AUTH-A', 'active', 'remote_desktop_gateway', 'rustdesk', 'engineer-a'),
        ('ivekit_authorization_remote_b', 'ivekit_rls_b', 'ivekit_authorization_session_b',
         'order', 'AUTH-B', 'active', 'remote_desktop_gateway', 'rustdesk', 'engineer-b');
      INSERT INTO rustdesk_devices
        (id, tenant_id, business_ref_type, business_ref_id, rustdesk_id, display_name)
      VALUES
        ('ivekit_authorization_device_a', 'ivekit_rls_a', 'order', 'AUTH-A', 'rustdesk-auth-a', 'Auth A'),
        ('ivekit_authorization_device_b', 'ivekit_rls_b', 'order', 'AUTH-B', 'rustdesk-auth-b', 'Auth B');
      INSERT INTO rustdesk_gateway_sessions
        (external_id, tenant_id, target_id, permissions, actor_identity, launch_url)
      VALUES
        ('ivekit_authorization_gateway_a', 'ivekit_rls_a', 'rustdesk-auth-a',
         '["view_screen"]', 'engineer-a', 'https://opc.example.test/remote/rustdesk/launch')
    `);
    const authorizationCodes = new RustDeskAuthorizationCodeStore(runtime, {
      secret: 'ivekit-postgres-authorization-code-secret-at-least-32-bytes'
    });
    const authorizationCode = await authorizationCodes.create({
      tenant_id: 'ivekit_rls_a',
      remote_session_id: 'ivekit_authorization_remote_a',
      device_id: 'ivekit_authorization_device_a',
      scopes: ['view_screen'],
      requested_by: 'customer-a',
      idempotency_key: 'ivekit-authorization-postgres-a',
      now: '2099-01-01T00:00:00.000Z'
    });
    assert.match(authorizationCode.code || '', /^\d{8}$/);
    assert.equal(await authorizationCodes.get({
      tenant_id: 'ivekit_rls_b',
      authorization_id: authorizationCode.authorization.id,
      now: '2099-01-01T00:01:00.000Z'
    }), null);
    await authorizationCodes.verify({
      tenant_id: 'ivekit_rls_a',
      authorization_id: authorizationCode.authorization.id,
      code: authorizationCode.code!,
      verified_by: 'engineer-a',
      now: '2099-01-01T00:01:00.000Z'
    });
    const consumedAuthorization = await authorizationCodes.consume({
      tenant_id: 'ivekit_rls_a',
      authorization_id: authorizationCode.authorization.id,
      verified_by: 'engineer-a',
      external_id: 'ivekit_authorization_gateway_a',
      now: '2099-01-01T00:02:00.000Z'
    });
    assert.equal(consumedAuthorization.status, 'consumed');
    const authorizationStorage = await admin.query<{
      code_salt: string;
      code_hmac: string;
      status: string;
    }>(
      `SELECT code_salt, code_hmac, status
       FROM rustdesk_authorization_codes
       WHERE id = $1`,
      [authorizationCode.authorization.id]
    );
    assert.match(authorizationStorage.rows[0]?.code_salt || '', /^[a-f0-9]{32}$/);
    assert.match(authorizationStorage.rows[0]?.code_hmac || '', /^[a-f0-9]{64}$/);
    assert.equal(authorizationStorage.rows[0]?.status, 'consumed');
    assert.equal(JSON.stringify(authorizationStorage.rows).includes(authorizationCode.code!), false);
    await admin.query(`
      INSERT INTO ivekit_media_calls
        (id, tenant_id, room_name, media, status, initiated_by,
         business_ref_type, business_ref_id, title)
      VALUES
        ('ivekit_quality_call_a', 'ivekit_rls_a', 'ivekit-quality-room-a', 'video', 'active',
         'quality-host-a', 'acceptance', 'QUALITY-A', 'Quality A'),
        ('ivekit_quality_call_b', 'ivekit_rls_b', 'ivekit-quality-room-b', 'video', 'active',
         'quality-host-b', 'acceptance', 'QUALITY-B', 'Quality B');
      INSERT INTO ivekit_media_call_participants
        (id, tenant_id, call_id, identity, role, status, display_name, joined_at)
      VALUES
        ('ivekit_quality_participant_a', 'ivekit_rls_a', 'ivekit_quality_call_a',
         'quality-host-a', 'host', 'joined', 'Quality A', CURRENT_TIMESTAMP),
        ('ivekit_quality_participant_b', 'ivekit_rls_b', 'ivekit_quality_call_b',
         'quality-host-b', 'host', 'joined', 'Quality B', CURRENT_TIMESTAMP)
    `);
    await admin.query(`
      INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id, title)
      VALUES
        ('ivekit_visual_session_a', 'ivekit_rls_a', 'order', 'VISUAL-A', 'Visual A'),
        ('ivekit_visual_session_b', 'ivekit_rls_b', 'order', 'VISUAL-B', 'Visual B');
      INSERT INTO collaboration_messages
        (id, tenant_id, session_id, sender_identity, message_type, body)
      VALUES
        ('ivekit_visual_message_a', 'ivekit_rls_a', 'ivekit_visual_session_a', 'agent-a', 'video', ''),
        ('ivekit_visual_message_b', 'ivekit_rls_b', 'ivekit_visual_session_b', 'agent-b', 'video', '');
      INSERT INTO collaboration_message_attachments
        (id, tenant_id, session_id, message_id, kind, storage_url, filename,
         content_type, size_bytes, checksum, processing_status)
      VALUES
        ('ivekit_visual_attachment_a', 'ivekit_rls_a', 'ivekit_visual_session_a',
         'ivekit_visual_message_a', 'video', 'ivekit://controlled/visual-a',
         'visual-a.mp4', 'video/mp4', 128, '${'a'.repeat(64)}', 'ready'),
        ('ivekit_visual_attachment_b', 'ivekit_rls_b', 'ivekit_visual_session_b',
         'ivekit_visual_message_b', 'video', 'ivekit://controlled/visual-b',
         'visual-b.mp4', 'video/mp4', 128, '${'b'.repeat(64)}', 'ready');
      INSERT INTO collaboration_attachment_processing_jobs
        (id, tenant_id, session_id, message_id, attachment_id, processor, status)
      VALUES
        ('ivekit_visual_job_a', 'ivekit_rls_a', 'ivekit_visual_session_a',
         'ivekit_visual_message_a', 'ivekit_visual_attachment_a', 'video_frame_ocr', 'succeeded'),
        ('ivekit_visual_job_b', 'ivekit_rls_b', 'ivekit_visual_session_b',
         'ivekit_visual_message_b', 'ivekit_visual_attachment_b', 'video_frame_ocr', 'succeeded');
      INSERT INTO collaboration_visual_observations
        (id, tenant_id, session_id, message_id, attachment_id, processor_job_id,
         observation_type, value_hash, symbology, confidence, frame_timestamp_ms)
      VALUES
        ('ivekit_visual_observation_a', 'ivekit_rls_a', 'ivekit_visual_session_a',
         'ivekit_visual_message_a', 'ivekit_visual_attachment_a', 'ivekit_visual_job_a',
         'qr_code', '${'c'.repeat(64)}', 'QR_CODE', 0.99, 2000),
        ('ivekit_visual_observation_b', 'ivekit_rls_b', 'ivekit_visual_session_b',
         'ivekit_visual_message_b', 'ivekit_visual_attachment_b', 'ivekit_visual_job_b',
         'barcode', '${'d'.repeat(64)}', 'CODE_128', 0.98, 4000)
    `);
    const governanceProfile = createIntelligenceProviderRegistry({
      OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
        id: 'translation-postgres', capability: 'translation', mode: 'self_hosted',
        base_url: 'http://translation-worker:8080', timeout_ms: 1_000,
        reservation_ttl_ms: 6_000, max_concurrency: 1
      }])
    }).requireProfile('translation-postgres', 'translation');
    const reservations = await Promise.all([
      new IntelligenceProviderGovernanceStore(runtime).reserve({
        tenant_id: 'ivekit_rls_a', capability: 'translation',
        profile: governanceProfile, route_attempt: 1
      }),
      new IntelligenceProviderGovernanceStore(runtime).reserve({
        tenant_id: 'ivekit_rls_a', capability: 'translation',
        profile: governanceProfile, route_attempt: 1
      })
    ]);
    assert.equal(reservations.filter((reservation) => reservation.granted).length, 1);
    const deniedReservation = reservations.find((reservation) => reservation.granted === false);
    assert.equal(deniedReservation?.granted, false);
    if (deniedReservation?.granted === false) {
      assert.equal(deniedReservation.reason, 'concurrency_exhausted');
    }
    const grantedReservation = reservations.find((reservation) => reservation.granted);
    if (!grantedReservation?.granted) throw new Error('one PostgreSQL reservation must be granted');
    await new IntelligenceProviderGovernanceStore(runtime).complete({
      tenant_id: 'ivekit_rls_a', lease_id: grantedReservation.lease_id, outcome: 'success'
    });
    const governanceRuntime = await new IntelligenceProviderGovernanceStore(runtime)
      .listRuntime('ivekit_rls_a');
    assert.equal(governanceRuntime[0]?.profile_id, 'translation-postgres');

    const quotaProfile = createIntelligenceProviderRegistry({
      OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([{
        id: 'translation-postgres-quota', capability: 'translation', mode: 'self_hosted',
        base_url: 'http://translation-worker:8080', timeout_ms: 1_000,
        reservation_ttl_ms: 6_000, max_concurrency: 2, requests_per_minute: 1
      }])
    }).requireProfile('translation-postgres-quota', 'translation');
    const quotaReservations = await Promise.all([
      new IntelligenceProviderGovernanceStore(runtime).reserve({
        tenant_id: 'ivekit_rls_a', capability: 'translation',
        profile: quotaProfile, route_attempt: 1
      }),
      new IntelligenceProviderGovernanceStore(runtime).reserve({
        tenant_id: 'ivekit_rls_a', capability: 'translation',
        profile: quotaProfile, route_attempt: 1
      })
    ]);
    assert.equal(quotaReservations.filter((reservation) => reservation.granted).length, 1);
    const quotaDenied = quotaReservations.find((reservation) => reservation.granted === false);
    assert.equal(quotaDenied?.granted, false);
    if (quotaDenied?.granted === false) {
      assert.equal(quotaDenied.reason, 'minute_quota_exhausted');
    }
    const quotaGranted = quotaReservations.find((reservation) => reservation.granted);
    if (!quotaGranted?.granted) throw new Error('one PostgreSQL quota reservation must be granted');
    await new IntelligenceProviderGovernanceStore(runtime).complete({
      tenant_id: 'ivekit_rls_a', lease_id: quotaGranted.lease_id, outcome: 'success'
    });

    const tenantBReservation = await new IntelligenceProviderGovernanceStore(runtime).reserve({
      tenant_id: 'ivekit_rls_b', capability: 'translation',
      profile: governanceProfile, route_attempt: 1
    });
    if (!tenantBReservation.granted) throw new Error('tenant B provider reservation must be granted');
    await new IntelligenceProviderGovernanceStore(runtime).complete({
      tenant_id: 'ivekit_rls_b', lease_id: tenantBReservation.lease_id, outcome: 'success'
    });

    const secureFiles = new SecureFileStore(runtime);
    const secureFile = await secureFiles.createUpload({
      tenant_id: 'ivekit_rls_a',
      session_id: 'ivekit_visual_session_a',
      created_by: 'postgres-test',
      kind: 'image',
      filename: 'postgres-contract.png',
      declared_mime: 'image/png',
      upload_mode: 'multipart',
      expected_size_bytes: 6,
      part_size_bytes: 6,
      idempotency_key: 'postgres-secure-file-a',
      payload_hash: 'f'.repeat(64),
      retention_until: '2000-01-01T00:00:00.000Z'
    });
    const securePart = {
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id, part_number: 1,
      size_bytes: 6, sha256: 'a'.repeat(64),
      object_key: `ivekit_rls_a/${secureFile.id}/parts/1`, etag: 'postgres-etag-1'
    };
    const firstPart = await secureFiles.recordPart(securePart);
    assert.deepEqual(await secureFiles.recordPart(securePart), firstPart);
    await assert.rejects(
      () => secureFiles.recordPart({ ...securePart, sha256: 'b'.repeat(64) }),
      (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
    );
    const completedSecureFile = await secureFiles.completeUpload({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id, size_bytes: 6,
      sha256: 'c'.repeat(64), object_key: `ivekit_rls_a/${secureFile.id}/original`
    });
    assert.equal(completedSecureFile.status, 'scanning');
    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      await tenantPg.query(
        `INSERT INTO collaboration_messages
          (id, tenant_id, session_id, sender_identity, message_type, body,
           provider, provider_topic_id, provider_payload, provider_delivery_status)
         VALUES ($1, $2, $3, 'agent-a', 'image', '', 'tinode', 'grp-postgres',
                 'secure attachment', 'pending')`,
        ['ivekit_secure_message_a', 'ivekit_rls_a', 'ivekit_visual_session_a']
      );
      await tenantPg.query(
        `INSERT INTO collaboration_message_attachments
          (id, tenant_id, session_id, message_id, kind, filename, content_type,
           size_bytes, checksum, processing_status, secure_file_id)
         VALUES ($1, $2, $3, $4, 'image', 'postgres-contract.png', 'image/png',
                 6, $5, 'pending', $6)`,
        [
          'ivekit_secure_attachment_a',
          'ivekit_rls_a',
          'ivekit_visual_session_a',
          'ivekit_secure_message_a',
          'c'.repeat(64),
          secureFile.id
        ]
      );
    });
    const deliveryGate = new TinodeFileDeliveryGate({ pg: runtime });
    const waitingTransition = await deliveryGate.reconcileMessage({
      tenant_id: 'ivekit_rls_a', message_id: 'ivekit_secure_message_a'
    });
    assert.equal(waitingTransition?.status, 'blocked_by_file_security');
    assert.equal(waitingTransition?.pending_file_count, 1);
    const waitingMessage = await withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(
      `SELECT provider_delivery_status, provider_delivery_attempts
       FROM collaboration_messages WHERE id = $1`,
      ['ivekit_secure_message_a']
    ));
    assert.equal(waitingMessage.rows[0]?.provider_delivery_status, 'blocked_by_file_security');
    assert.equal(Number(waitingMessage.rows[0]?.provider_delivery_attempts), 0);
    await admin.query(
      `INSERT INTO collaboration_chat_bindings
        (id, tenant_id, session_id, provider, provider_topic_id, provider_status)
       VALUES ('ivekit_tinode_binding_a', 'ivekit_rls_a', 'ivekit_visual_session_a',
               'tinode', 'grp-postgres', 'bound')`
    );
    await admin.query(
      `INSERT INTO tinode_inbound_events
        (id, tenant_id, binding_id, provider_topic_id, event_kind,
         provider_sequence, dedupe_key, payload_hash, payload, status,
         attempt_count, error_code, error_message, processed_at)
       VALUES ('ivekit_tinode_event_a', 'ivekit_rls_a', 'ivekit_tinode_binding_a',
               'grp-postgres', 'data', 10, 'data:10', $1,
               '{"topic":"grp-postgres","seq":10}'::JSONB, 'dead_letter', 1,
               'provider_user_unmapped', 'provider user is not mapped', CURRENT_TIMESTAMP)`,
      ['e'.repeat(64)]
    );
    await admin.query(
      `INSERT INTO tinode_inbound_dead_letters
        (id, tenant_id, binding_id, event_id, error_code, error_message,
         payload_hash, retryable)
       VALUES ('ivekit_tinode_dead_a', 'ivekit_rls_a', 'ivekit_tinode_binding_a',
               'ivekit_tinode_event_a', 'provider_user_unmapped',
               'provider user is not mapped', $1, 0)`,
      ['e'.repeat(64)]
    );
    const tinodeOperations = new TinodeOperationsService({ pg: runtime });
    const tinodeSnapshot = await tinodeOperations.snapshot('ivekit_rls_a');
    assert.equal(tinodeSnapshot.delivery.blocked_by_file_security, 1);
    assert.equal(tinodeSnapshot.dead_letters.open, 1);
    assert.equal(tinodeSnapshot.dead_letters.terminal, 1);
    assert.equal((await tinodeOperations.listDeadLetters({
      tenant_id: 'ivekit_rls_a'
    }))[0]?.id, 'ivekit_tinode_dead_a');
    assert.equal((await tinodeOperations.listDeadLetters({
      tenant_id: 'ivekit_rls_b'
    })).length, 0);
    const manualReplay = await tinodeOperations.replayDeadLetter({
      tenant_id: 'ivekit_rls_a', dead_letter_id: 'ivekit_tinode_dead_a',
      requested_by: 'postgres-admin', idempotency_key: 'postgres-replay-1'
    });
    assert.equal(manualReplay.replayed, false);
    assert.equal(manualReplay.dead_letter.retryable, true);
    assert.equal((await tinodeOperations.replayDeadLetter({
      tenant_id: 'ivekit_rls_a', dead_letter_id: 'ivekit_tinode_dead_a',
      requested_by: 'postgres-admin', idempotency_key: 'postgres-replay-1'
    })).replayed, true);
    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(
        `UPDATE collaboration_secure_files SET status = 'ready' WHERE id = $1`,
        [secureFile.id]
      )),
      /invalid secure file status transition|check constraint|check_violation/i
    );
    assert.ok((await secureFiles.discoverScanTenantIds()).includes('ivekit_rls_a'));
    const scanClaims = await secureFiles.claimScanJobs({
      tenant_id: 'ivekit_rls_a', worker_id: 'postgres-scan-worker-a',
      limit: 1, lease_ms: 30_000, max_attempts: 3
    });
    assert.equal(scanClaims.length, 1);
    assert.equal(scanClaims[0]?.file.id, secureFile.id);
    assert.equal((await secureFiles.claimScanJobs({
      tenant_id: 'ivekit_rls_a', worker_id: 'postgres-scan-worker-b',
      limit: 1, lease_ms: 30_000, max_attempts: 3
    })).length, 0);
    const processingSecureFile = await secureFiles.finishScanJob({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id,
      worker_id: 'postgres-scan-worker-a', claim_token: scanClaims[0]!.claim_token,
      outcome: 'clean', detected_mime: 'image/png', mime_conflict: false,
      scanner_name: 'postgres-controlled', scanner_mode: 'controlled',
      scanner_request_id: 'postgres-request-1', scan_metadata: { engine: 'controlled' }
    });
    assert.equal(processingSecureFile.status, 'processing');
    assert.equal(processingSecureFile.threat_status, 'clean');
    assert.equal(processingSecureFile.scan_attempt_count, 1);
    assert.equal(processingSecureFile.scanner_name, 'postgres-controlled');
    const derivatives = new SecureFileDerivativeStore(runtime);
    assert.ok((await derivatives.discoverTenantIds()).includes('ivekit_rls_a'));
    const derivativeJobs = await derivatives.ensureJobs({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id,
      provider_profile_id: 'postgres-ffmpeg'
    });
    assert.deepEqual(derivativeJobs.map((job) => job.derivative_kind), ['image_thumbnail']);
    const derivativeClaims = await derivatives.claimJobs({
      tenant_id: 'ivekit_rls_a', worker_id: 'postgres-derivative-worker-a',
      limit: 1, lease_ms: 30_000, max_attempts: 3
    });
    assert.equal(derivativeClaims.length, 1);
    assert.equal((await derivatives.claimJobs({
      tenant_id: 'ivekit_rls_a', worker_id: 'postgres-derivative-worker-b',
      limit: 1, lease_ms: 30_000, max_attempts: 3
    })).length, 0);
    const readyDerivative = await derivatives.finishJob({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id,
      derivative_kind: 'image_thumbnail', worker_id: 'postgres-derivative-worker-a',
      claim_token: derivativeClaims[0]!.claim_token, outcome: 'ready',
      object_key: `ivekit_rls_a/${secureFile.id}/derivatives/image-thumbnail`,
      mime: 'image/jpeg', size_bytes: 5, sha256: 'd'.repeat(64),
      provider_request_id: 'postgres-derivative-request-1',
      provider_metadata: { engine: 'controlled' }
    });
    assert.equal(readyDerivative.status, 'ready');
    const readySecureFile = await derivatives.convergeFile({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id
    });
    assert.equal(readySecureFile.status, 'ready');
    const rustDeskEvidence = await secureFiles.createUpload({
      tenant_id: 'ivekit_rls_a',
      session_id: 'ivekit_visual_session_a',
      created_by: 'rustdesk-edge-postgres',
      kind: 'file',
      filename: 'rustdesk-evidence.pdf',
      declared_mime: 'application/pdf',
      upload_mode: 'single',
      expected_size_bytes: 4,
      idempotency_key: 'postgres-rustdesk-evidence-a',
      payload_hash: '9'.repeat(64),
      metadata: { source: 'rustdesk_companion_evidence' }
    });
    await secureFiles.beginUpload({
      tenant_id: 'ivekit_rls_a', secure_file_id: rustDeskEvidence.id
    });
    await secureFiles.completeUpload({
      tenant_id: 'ivekit_rls_a', secure_file_id: rustDeskEvidence.id,
      size_bytes: 4, sha256: '8'.repeat(64),
      object_key: `ivekit_rls_a/${rustDeskEvidence.id}/original`
    });
    await secureFiles.transitionStatus({
      tenant_id: 'ivekit_rls_a', secure_file_id: rustDeskEvidence.id,
      from_status: 'scanning', to_status: 'processing', threat_status: 'clean',
      detected_mime: 'application/pdf', mime_conflict: false
    });
    await secureFiles.transitionStatus({
      tenant_id: 'ivekit_rls_a', secure_file_id: rustDeskEvidence.id,
      from_status: 'processing', to_status: 'ready'
    });
    assert.deepEqual(
      (await secureFiles.listRustDeskEvidenceIntelligenceCandidates()).map((file) => file.id),
      [rustDeskEvidence.id]
    );
    const readyTransition = await deliveryGate.reconcileFile({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id
    });
    assert.equal(readyTransition[0]?.status, 'pending');
    assert.equal(readyTransition[0]?.reason, 'all_files_ready');
    assert.ok((await secureFiles.discoverCleanupTenantIds()).includes('ivekit_rls_a'));
    const cleanupClaims = await secureFiles.claimCleanupJobs({
      tenant_id: 'ivekit_rls_a', worker_id: 'postgres-cleanup-worker-a',
      limit: 1, lease_ms: 30_000
    });
    assert.equal(cleanupClaims.length, 1);
    assert.equal((await secureFiles.claimCleanupJobs({
      tenant_id: 'ivekit_rls_a', worker_id: 'postgres-cleanup-worker-b',
      limit: 1, lease_ms: 30_000
    })).length, 0);
    await derivatives.expireJobs({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id
    });
    const expiredSecureFile = await secureFiles.finishCleanupJob({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id,
      worker_id: 'postgres-cleanup-worker-a', claim_token: cleanupClaims[0]!.claim_token,
      outcome: 'expired'
    });
    assert.equal(expiredSecureFile.status, 'expired');
    const terminalTransition = await deliveryGate.reconcileFile({
      tenant_id: 'ivekit_rls_a', secure_file_id: secureFile.id
    });
    assert.equal(terminalTransition[0]?.status, 'blocked');
    assert.equal(terminalTransition[0]?.terminal_file_count, 1);
    assert.equal((await secureFiles.listParts('ivekit_rls_a', secureFile.id))[0]?.status, 'aborted');
    assert.equal((await derivatives.listJobs('ivekit_rls_a', secureFile.id))[0]?.status, 'expired');
    await assert.rejects(
      () => secureFiles.getFile('ivekit_rls_b', secureFile.id),
      (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 404
    );

    await seedVoiceIvrTenant(admin, 'a');
    await seedVoiceIvrTenant(admin, 'b');
    await admin.query(`
      INSERT INTO ivekit_cc_skills (id, tenant_id, name, created_by, updated_by)
      VALUES
        ('ivekit_cc_skill_a', 'ivekit_rls_a', 'Skill A', 'postgres-test', 'postgres-test'),
        ('ivekit_cc_skill_b', 'ivekit_rls_b', 'Skill B', 'postgres-test', 'postgres-test')
    `);

    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      const calls = await tenantPg.query<{ tenant_id: string; id: string }>(
        `SELECT tenant_id, id FROM ivekit_voice_calls ORDER BY id`
      );
      assert.deepEqual(calls.rows, [{ tenant_id: 'ivekit_rls_a', id: 'ivekit_voice_call_a' }]);
      const sessions = await tenantPg.query<{ tenant_id: string; id: string }>(
        `SELECT tenant_id, id FROM ivekit_ivr_sessions ORDER BY id`
      );
      assert.deepEqual(sessions.rows, [{ tenant_id: 'ivekit_rls_a', id: 'ivekit_ivr_session_a' }]);
      const skills = await tenantPg.query<{ tenant_id: string; id: string }>(
        `SELECT tenant_id, id FROM ivekit_cc_skills ORDER BY id`
      );
      assert.deepEqual(skills.rows, [{ tenant_id: 'ivekit_rls_a', id: 'ivekit_cc_skill_a' }]);
      const providerRuntime = await tenantPg.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM collaboration_intelligence_provider_runtime ORDER BY tenant_id`
      );
      assert.deepEqual(providerRuntime.rows, [{ tenant_id: 'ivekit_rls_a' }]);
      const providerLeases = await tenantPg.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM collaboration_intelligence_provider_leases ORDER BY tenant_id`
      );
      assert.deepEqual(providerLeases.rows, [{ tenant_id: 'ivekit_rls_a' }]);
      const observations = await tenantPg.query<{
        id: string;
        tenant_id: string;
        value_hash: string;
        frame_timestamp_ms: number;
      }>(`
        SELECT id, tenant_id, value_hash, frame_timestamp_ms
        FROM collaboration_visual_observations
        ORDER BY id
      `);
      assert.deepEqual(observations.rows, [{
        id: 'ivekit_visual_observation_a',
        tenant_id: 'ivekit_rls_a',
        value_hash: 'c'.repeat(64),
        frame_timestamp_ms: 2000
      }]);
      await assert.rejects(
        () => tenantPg.query(`
          INSERT INTO ivekit_cc_skills (id, tenant_id, name, created_by, updated_by)
          VALUES ('ivekit_cc_cross_tenant', 'ivekit_rls_b', 'Cross tenant', 'postgres-test', 'postgres-test')
        `),
        /row-level security policy/i
      );
    });
    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      await assert.rejects(
        () => tenantPg.query(`
          INSERT INTO collaboration_intelligence_provider_runtime
            (tenant_id, capability, profile_id)
          VALUES ('ivekit_rls_b', 'translation', 'cross-tenant-provider')
        `),
        /row-level security policy/i
      );
    });
    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      await assert.rejects(
        () => tenantPg.query(`
          INSERT INTO collaboration_visual_observations
            (id, tenant_id, session_id, message_id, attachment_id, processor_job_id,
             observation_type, value_hash)
          VALUES
            ('ivekit_visual_cross_tenant', 'ivekit_rls_b', 'ivekit_visual_session_b',
             'ivekit_visual_message_b', 'ivekit_visual_attachment_b', 'ivekit_visual_job_b',
             'qr_code', '${'e'.repeat(64)}')
        `),
        /row-level security policy/i
      );
    });

    await admin.query(`
      INSERT INTO ivekit_voice_configuration_commands
        (id, tenant_id, profile_id, resource_type, resource_id, operation, state,
         idempotency_key, payload_hash, attempt_count, max_attempts, lease_until, worker_id)
      VALUES
        ('ivekit_voice_config_a_pending', 'ivekit_rls_a', 'ivekit_voice_profile_a',
         'sip_trunk', 'trunk-a', 'apply', 'pending', 'voice-config-a-pending',
         '${'a'.repeat(64)}', 0, 3, NULL, ''),
        ('ivekit_voice_config_a_expired', 'ivekit_rls_a', 'ivekit_voice_profile_a',
         'route', 'route-a', 'apply', 'processing', 'voice-config-a-expired',
         '${'b'.repeat(64)}', 1, 3, '2026-07-12T11:59:00.000Z', 'crashed-worker'),
        ('ivekit_voice_config_a_race', 'ivekit_rls_a', 'ivekit_voice_profile_a',
         'extension', 'extension-a', 'apply', 'pending', 'voice-config-a-race',
         '${'c'.repeat(64)}', 0, 3, NULL, ''),
        ('ivekit_voice_config_b_pending', 'ivekit_rls_b', 'ivekit_voice_profile_b',
         'sip_trunk', 'trunk-b', 'apply', 'pending', 'voice-config-b-pending',
         '${'d'.repeat(64)}', 0, 3, NULL, '')
    `);

    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      const commands = await tenantPg.query<{ id: string; tenant_id: string }>(`
        SELECT id, tenant_id
        FROM ivekit_voice_configuration_commands
        ORDER BY id
      `);
      assert.deepEqual(commands.rows, [
        { id: 'ivekit_voice_config_a_expired', tenant_id: 'ivekit_rls_a' },
        { id: 'ivekit_voice_config_a_pending', tenant_id: 'ivekit_rls_a' },
        { id: 'ivekit_voice_config_a_race', tenant_id: 'ivekit_rls_a' }
      ]);
      const foreignClaim = await tenantPg.query(`
        UPDATE ivekit_voice_configuration_commands
        SET worker_id = 'cross-tenant-worker'
        WHERE id = 'ivekit_voice_config_b_pending'
        RETURNING id
      `);
      assert.equal(foreignClaim.rowCount, 0);
    });

    const discoveredVoiceTenants = await runtime.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM opc_worker_tenant_ids('voice_configuration', $1::TIMESTAMPTZ, 10)
       ORDER BY tenant_id`,
      ['2026-07-12T12:00:00.000Z']
    );
    assert.deepEqual(discoveredVoiceTenants.rows, [
      { tenant_id: 'ivekit_rls_a' },
      { tenant_id: 'ivekit_rls_b' }
    ]);

    const directProfiles = await runtime.query(
      `SELECT id FROM ivekit_voice_deployment_profiles WHERE id = 'ivekit_voice_profile_b'`
    );
    assert.equal(directProfiles.rowCount, 0);
    const profileContext = await runtime.query<{
      tenant_id: string;
      profile_id: string;
      adapter: string;
      secret_refs: Record<string, unknown>;
    }>(`SELECT * FROM opc_ivekit_voice_profile_context($1)`, ['ivekit_voice_profile_b']);
    assert.deepEqual(profileContext.rows, [{
      tenant_id: 'ivekit_rls_b',
      profile_id: 'ivekit_voice_profile_b',
      adapter: 'controlled',
      secret_refs: {}
    }]);

    const firstWorker = await runtime.connect();
    const secondWorker = await runtime.connect();
    try {
      await firstWorker.query('BEGIN');
      await secondWorker.query('BEGIN');
      await firstWorker.query(`SELECT set_config('app.current_tenant', 'ivekit_rls_a', true)`);
      await secondWorker.query(`SELECT set_config('app.current_tenant', 'ivekit_rls_a', true)`);
      const firstClaim = await firstWorker.query(`
        WITH candidate AS (
          SELECT id
          FROM ivekit_voice_configuration_commands
          WHERE id = 'ivekit_voice_config_a_race' AND state = 'pending'
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ivekit_voice_configuration_commands command
        SET state = 'processing', worker_id = 'voice-worker-one',
            lease_until = '2026-07-12T12:01:00.000Z'
        FROM candidate
        WHERE command.id = candidate.id
        RETURNING command.id
      `);
      assert.deepEqual(firstClaim.rows, [{ id: 'ivekit_voice_config_a_race' }]);
      const secondClaim = await secondWorker.query(`
        WITH candidate AS (
          SELECT id
          FROM ivekit_voice_configuration_commands
          WHERE id = 'ivekit_voice_config_a_race' AND state = 'pending'
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ivekit_voice_configuration_commands command
        SET state = 'processing', worker_id = 'voice-worker-two',
            lease_until = '2026-07-12T12:01:00.000Z'
        FROM candidate
        WHERE command.id = candidate.id
        RETURNING command.id
      `);
      assert.equal(secondClaim.rowCount, 0);
      await secondWorker.query('ROLLBACK');
      await firstWorker.query('ROLLBACK');
    } finally {
      secondWorker.release();
      firstWorker.release();
    }

    await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      const reclaimed = await tenantPg.query<{ id: string; worker_id: string }>(`
        WITH candidate AS (
          SELECT id
          FROM ivekit_voice_configuration_commands
          WHERE id = 'ivekit_voice_config_a_expired'
            AND state = 'processing'
            AND lease_until <= '2026-07-12T12:00:00.000Z'
          FOR UPDATE SKIP LOCKED
        )
        UPDATE ivekit_voice_configuration_commands command
        SET worker_id = 'voice-recovery-worker',
            lease_until = '2026-07-12T12:01:00.000Z',
            attempt_count = attempt_count + 1
        FROM candidate
        WHERE command.id = candidate.id
        RETURNING command.id, command.worker_id
      `);
      assert.deepEqual(reclaimed.rows, [{
        id: 'ivekit_voice_config_a_expired',
        worker_id: 'voice-recovery-worker'
      }]);
    });

    const configurationStore = new PostgresVoiceConfigurationStore(runtime);
    const profile = await configurationStore.getProfile('ivekit_rls_a', 'ivekit_voice_profile_a');
    assert.equal(profile?.name, 'Controlled a');
    const updatedProfile = await configurationStore.updateProfile({
      ...profile!,
      name: 'Controlled a updated',
      updated_by: 'postgres-store-test',
      updated_at: '2026-07-12T12:00:00.000Z'
    }, profile!.revision);
    assert.equal(updatedProfile.revision, 2);
    await assert.rejects(
      () => configurationStore.updateProfile(updatedProfile, profile!.revision),
      (error: unknown) => (error as { code?: string }).code === 'revision_conflict'
    );

    const callStore = new PostgresVoiceCallStore(runtime);
    const voiceCall = await callStore.get('ivekit_rls_a', 'ivekit_voice_call_a');
    assert.deepEqual(voiceCall?.from, { kind: 'e164', redacted: '+86******01' });
    const updatedCall = await callStore.update({
      ...voiceCall!,
      metadata: { postgres_store_verified: true },
      updated_at: '2026-07-12T12:00:00.000Z'
    }, voiceCall!.revision);
    assert.equal(updatedCall.revision, 2);
    await assert.rejects(
      () => callStore.update(updatedCall, voiceCall!.revision),
      (error: unknown) => (error as { code?: string }).code === 'revision_conflict'
    );

    const mediaCallService = new MediaCallService(new MediaCallStore(runtime));
    const mediaBridge = await mediaCallService.ensureVoiceBridge({
      tenant_id: 'ivekit_rls_a', voice_call_id: voiceCall!.id, initiated_by: 'postgres-store-test',
      participant_identity: 'voice-sip-postgres-a', idempotency_key: 'voice-bridge-postgres-a',
      business_ref: { tenant_id: 'ivekit_rls_a', type: 'order', id: 'VOICE-BRIDGE-A' }
    });
    assert.deepEqual(await mediaCallService.ensureVoiceBridge({
      tenant_id: 'ivekit_rls_a', voice_call_id: voiceCall!.id, initiated_by: 'postgres-store-test',
      participant_identity: 'voice-sip-postgres-a', idempotency_key: 'voice-bridge-postgres-a',
      business_ref: { tenant_id: 'ivekit_rls_a', type: 'order', id: 'VOICE-BRIDGE-A' }
    }), mediaBridge);

    const previousApiKey = process.env.OPC_API_KEY;
    process.env.OPC_API_KEY = 'ivekit-voice-http-postgres-key';
    try {
      const registry = new VoiceProviderRegistry();
      registry.register('controlled', new ControlledVoiceProviderFactory({
        now: () => new Date('2026-07-12T12:00:00.000Z')
      }));
      const voiceHttpOptions = {
        provider_registry: registry,
        address_protector: new EncryptedVoiceAddressProtector({
          encryption_key: Buffer.alloc(32, 1).toString('base64'),
          hmac_key: Buffer.alloc(32, 2).toString('base64')
        })
      };
      const authHeaders = {
        'x-api-key': 'ivekit-voice-http-postgres-key',
        'x-tenant-id': 'ivekit_rls_a',
        'x-user-id': 'postgres-http-admin'
      };
      const invokeVoice = (
        method: string,
        path: string,
        body: Record<string, unknown> = {},
        headers: Record<string, string> = authHeaders
      ) => routeIveKitVoiceApi(
        runtime, method, path, new URL(`http://localhost${path}`), body,
        JSON.stringify(body), headers, voiceHttpOptions
      ) as Promise<{ status?: number; data: any }>;

      await invokeVoice('PATCH', '/api/ivekit/voice/policy', {
        revision: null, require_outbound_consent: true, recording_mode: 'consent_required',
        recording_retention_days: 30, require_ai_disclosure: true,
        allowed_calling_windows: [], masking_policy: {}, status: 'active'
      });
      await invokeVoice('POST', '/api/ivekit/voice/consents', {
        subject_ref_type: 'order', subject_ref_id: 'VOICE-HTTP-A',
        business_ref_type: 'order', business_ref_id: 'VOICE-HTTP-A',
        consent_type: 'outbound_call', status: 'granted', evidence_ref: 'evidence-http-a',
        expires_at: null
      });
      const preflight = await invokeVoice(
        'POST', '/api/ivekit/voice/profiles/ivekit_voice_profile_a/preflight'
      );
      assert.equal(preflight.data.status, 'ready');
      const clearNumber = '+8613800138000';
      const created = await invokeVoice('POST', '/api/ivekit/voice/calls', {
        profile_id: 'ivekit_voice_profile_a',
        from: { kind: 'extension', value: '1001' },
        to: { kind: 'e164', value: clearNumber },
        business_ref: { type: 'order', id: 'VOICE-HTTP-A' }, metadata: {}
      }, { ...authHeaders, 'idempotency-key': 'voice-http-call-a' });
      assert.equal(created.status, 202);
      assert.equal(created.data.call.to.redacted, '+86******8000');
      assert.equal(created.data.command.kind, 'originate');
      assert.equal(JSON.stringify(created).includes(clearNumber), false);
      assert.equal(JSON.stringify(created).includes('ciphertext'), false);
      const listed = await invokeVoice('GET', '/api/ivekit/voice/calls?limit=100');
      assert.equal(listed.data.items.some((item: { id: string }) => item.id === created.data.call.id), true);
      await withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(
        `UPDATE ivekit_voice_call_commands
         SET state = 'succeeded', completed_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1 AND id = $2`,
        ['ivekit_rls_a', created.data.command.id]
      ));
    } finally {
      if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
      else process.env.OPC_API_KEY = previousApiKey;
    }

    const commandStore = new PostgresVoiceCommandStore(runtime);
    const durableCallCommand: VoiceCallCommand = {
      id: 'ivekit_voice_store_call_command',
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_voice_call_a',
      kind: 'hangup',
      state: 'pending',
      idempotency_key: 'ivekit-voice-store-call-command',
      payload_hash: 'e'.repeat(64),
      payload: { reason: 'controlled_acceptance' },
      attempt_count: 0,
      max_attempts: 3,
      next_attempt_at: null,
      lease_until: null,
      worker_id: '',
      provider_command_id: '',
      result: {},
      error_code: '',
      error_message: '',
      created_at: '2026-07-12T12:00:00.000Z',
      updated_at: '2026-07-12T12:00:00.000Z',
      completed_at: null
    };
    assert.equal((await commandStore.insertCall(durableCallCommand)).id, durableCallCommand.id);
    assert.equal((await commandStore.insertCall(durableCallCommand)).id, durableCallCommand.id);
    const claimedCallCommands = await commandStore.claimCallDue({
      tenant_id: 'ivekit_rls_a',
      worker_id: 'voice-postgres-store-worker',
      now: new Date('2026-07-12T12:00:01.000Z'),
      lease_ms: 30_000,
      limit: 10
    });
    assert.deepEqual(claimedCallCommands.map((command) => command.id), [durableCallCommand.id]);
    const completedCallCommand = await commandStore.completeCall({
      tenant_id: 'ivekit_rls_a',
      command_id: durableCallCommand.id,
      worker_id: 'voice-postgres-store-worker',
      state: 'succeeded',
      result: { accepted: true }
    });
    assert.equal(completedCallCommand.state, 'succeeded');
    await assert.rejects(
      () => commandStore.completeCall({
        tenant_id: 'ivekit_rls_a',
        command_id: durableCallCommand.id,
        worker_id: 'stale-voice-worker',
        state: 'succeeded'
      }),
      (error: unknown) => (error as { code?: string }).code === 'lease_lost'
    );

    const providerEventStore = new PostgresVoiceProviderEventStore(runtime);
    const providerEvent: VoiceProviderEvent = {
      id: 'ivekit_voice_store_event',
      tenant_id: 'ivekit_rls_a',
      profile_id: 'ivekit_voice_profile_a',
      call_id: 'ivekit_voice_call_a',
      external_event_id: 'ivekit-provider-event-store-a',
      canonical_hash: 'f'.repeat(64),
      event_type: 'call.ringing',
      provider_state: 'ringing',
      safe_payload: { state: 'ringing' },
      processing_state: 'pending',
      attempt_count: 0,
      next_attempt_at: null,
      lease_until: null,
      worker_id: '',
      error_code: '',
      occurred_at: '2026-07-12T12:00:00.000Z',
      received_at: '2026-07-12T12:00:00.000Z',
      processed_at: null
    };
    assert.equal((await providerEventStore.insert(providerEvent)).replayed, false);
    assert.equal((await providerEventStore.insert(providerEvent)).replayed, true);
    const claimedEvents = await providerEventStore.claimDue({
      tenant_id: 'ivekit_rls_a',
      worker_id: 'voice-event-store-worker',
      now: new Date('2026-07-12T12:00:01.000Z'),
      lease_ms: 30_000,
      limit: 10
    });
    assert.deepEqual(claimedEvents.map((event) => event.id), [providerEvent.id]);
    assert.equal((await providerEventStore.complete({
      tenant_id: 'ivekit_rls_a',
      event_id: providerEvent.id,
      worker_id: 'voice-event-store-worker'
    })).processing_state, 'processed');

    const recordingStore = new PostgresVoiceRecordingStore(runtime);
    const recording: VoiceRecording = {
      id: 'ivekit_voice_store_recording',
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_voice_call_a',
      profile_id: 'ivekit_voice_profile_a',
      provider_recording_id: 'provider-recording-store-a',
      status: 'available',
      recording_mode: 'always',
      consent_id: null,
      object_ref: 'ivekit://recording/store-a',
      evidence_ref: 'evidence-store-a',
      checksum: '1'.repeat(64),
      duration_ms: 1200,
      retention_until: '2026-08-12T12:00:00.000Z',
      captured_at: '2026-07-12T12:00:00.000Z',
      deleted_at: null,
      metadata: { controlled: true },
      created_at: '2026-07-12T12:00:00.000Z',
      updated_at: '2026-07-12T12:00:00.000Z'
    };
    assert.equal((await recordingStore.insertRecording(recording)).id, recording.id);
    assert.equal((await recordingStore.insertRecording(recording)).id, recording.id);

    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(`
        INSERT INTO ivekit_voice_deployment_profiles
          (id, tenant_id, name, adapter)
        VALUES ('ivekit_cross_tenant_voice_profile', 'ivekit_rls_b', 'Cross tenant', 'controlled')
      `)),
      /row-level security|policy/i
    );
    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(`
        INSERT INTO ivekit_voice_calls
          (id, tenant_id, business_ref_type, business_ref_id, provider_profile_id,
           direction, from_address_kind, from_address_ciphertext, from_address_hmac,
           from_address_redacted, to_address_kind, to_address_ciphertext, to_address_hmac,
           to_address_redacted, idempotency_key)
        VALUES
          ('ivekit_bad_hmac', 'ivekit_rls_a', 'order', 'BAD-HMAC', 'ivekit_voice_profile_a',
           'outbound', 'e164', 'cipher-a', '${'a'.repeat(63)}', '+86******11',
           'e164', 'cipher-b', '${'b'.repeat(64)}', '+86******12', 'bad-hmac')
      `)),
      /check constraint/i
    );
    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(`
        INSERT INTO ivekit_voice_calls
          (id, tenant_id, business_ref_type, business_ref_id, provider_profile_id,
           direction, from_address_kind, from_address_ciphertext, from_address_hmac,
           from_address_redacted, to_address_kind, to_address_ciphertext, to_address_hmac,
           to_address_redacted, idempotency_key)
        VALUES
          ('ivekit_duplicate_call', 'ivekit_rls_a', 'order', 'DUPLICATE', 'ivekit_voice_profile_a',
           'outbound', 'e164', 'cipher-a', '${'a'.repeat(64)}', '+86******11',
           'e164', 'cipher-b', '${'b'.repeat(64)}', '+86******12', 'voice-call-a')
      `)),
      /duplicate key|unique constraint/i
    );
    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(`
        INSERT INTO ivekit_voice_call_commands
          (id, tenant_id, call_id, kind, idempotency_key, payload_hash, attempt_count, max_attempts)
        VALUES
          ('ivekit_bad_attempts', 'ivekit_rls_a', 'ivekit_voice_call_a', 'hangup',
           'bad-attempts', '${'c'.repeat(64)}', 2, 1)
      `)),
      /check constraint/i
    );
    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(`
        INSERT INTO ivekit_ivr_flow_versions
          (id, tenant_id, flow_id, version, graph, graph_hash, published_by)
        VALUES
          ('ivekit_duplicate_flow_version', 'ivekit_rls_a', 'ivekit_ivr_flow_a', 1,
           '{}'::JSONB, '${'d'.repeat(64)}', 'postgres-test')
      `)),
      /duplicate key|unique constraint/i
    );
    await assert.rejects(
      () => withPgTenant(runtime, 'ivekit_rls_a', (tenantPg) => tenantPg.query(`
        INSERT INTO ivekit_ivr_sessions
          (id, tenant_id, call_id, flow_id, flow_version)
        VALUES
          ('ivekit_cross_tenant_session', 'ivekit_rls_a', 'ivekit_voice_call_b',
           'ivekit_ivr_flow_a', 1)
      `)),
      /foreign key constraint/i
    );

    const deployedRouteVersion = await admin.query<{ deployment_state: string; provider_revision: string }>(`
      UPDATE ivekit_voice_route_versions
      SET deployment_state = 'applied', provider_revision = 'changed'
      WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_voice_route_version_a'
      RETURNING deployment_state, provider_revision
    `);
    assert.deepEqual(deployedRouteVersion.rows, [{
      deployment_state: 'applied', provider_revision: 'changed'
    }]);

    for (const statement of [
      `UPDATE ivekit_voice_route_versions SET rules = '{"action":"reject"}'::JSONB
       WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_voice_route_version_a'`,
      `DELETE FROM ivekit_voice_route_versions
       WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_voice_route_version_a'`,
      `UPDATE ivekit_ivr_flow_versions SET graph = '{}'::JSONB
       WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_ivr_flow_version_a'`,
      `DELETE FROM ivekit_ivr_flow_versions
       WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_ivr_flow_version_a'`,
      `UPDATE ivekit_ivr_session_steps SET branch_taken = 'changed'
       WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_ivr_step_a'`,
      `DELETE FROM ivekit_ivr_session_steps
       WHERE tenant_id = 'ivekit_rls_a' AND id = 'ivekit_ivr_step_a'`
    ]) await assert.rejects(() => admin.query(statement), /immutable/i);

    await admin.query(`INSERT INTO tenants (id, name) VALUES ('ivekit_rls_cascade', 'Cascade')`);
    await seedVoiceIvrTenant(admin, 'cascade');
    await admin.query(`DELETE FROM tenants WHERE id = 'ivekit_rls_cascade'`);
    assert.equal((await admin.query(
      `SELECT id FROM ivekit_ivr_session_steps WHERE tenant_id = 'ivekit_rls_cascade'`
    )).rowCount, 0);

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
    const queuedQuality = await qualityRecovery.enqueueMessage({
      tenant_id: 'ivekit_rls_a',
      message_id: 'ivekit_worker_quality_message'
    }, { automatic: false });
    assert.ok(queuedQuality);
    await admin.query(`
      UPDATE collaboration_quality_review_jobs
      SET id = 'ivekit_worker_quality_job', status = 'processing', attempt_count = 1,
          lease_until = '2026-07-12T11:59:00.000Z', worker_id = 'crashed-quality-worker'
      WHERE tenant_id = 'ivekit_rls_a' AND message_id = 'ivekit_worker_quality_message'
    `);
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

    const qosNow = new Date('2026-07-12T09:00:00.000Z');
    const quality = new MediaQualityService(new MediaQualityStore(runtime), {
      now: () => qosNow,
      degraded_samples: 2,
      recovery_samples: 2,
      retention_ms: 60_000,
      max_future_skew_ms: 120_000
    });
    const qosSample = (
      sampleId: string,
      override: Record<string, unknown> = {}
    ) => ({
      participant_identity: 'quality-host-a',
      connection_revision: 1,
      sample_id: sampleId,
      track_source: 'camera' as const,
      quality_level: 'good' as const,
      rtt_ms: 80,
      jitter_ms: 10,
      packet_loss_ratio: 0.01,
      bitrate_bps: 1_500_000,
      quality_score: 4.5,
      sampled_at: '2026-07-12T08:59:50.000Z',
      ...override
    });
    await quality.reportQuality({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a',
      snapshots: [qosSample('qos-bad-1', { packet_loss_ratio: 0.2 })]
    });
    const degraded = await quality.reportQuality({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a',
      snapshots: [qosSample('qos-bad-2', { rtt_ms: 600 })]
    });
    assert.deepEqual(degraded.transitions.map((item) => item.event_type), ['degraded']);
    const qosReplay = await quality.reportQuality({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a',
      snapshots: [qosSample('qos-bad-2', { rtt_ms: 600 })]
    });
    assert.deepEqual({ accepted: qosReplay.accepted, replayed: qosReplay.replayed }, {
      accepted: 0,
      replayed: 1
    });
    await assert.rejects(
      () => quality.reportQuality({
        tenant_id: 'ivekit_rls_a',
        call_id: 'ivekit_quality_call_a',
        snapshots: [qosSample('qos-bad-2', { rtt_ms: 700 })]
      }),
      (error: Error & { status?: number }) => error.status === 409
    );
    await quality.reportQuality({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a',
      snapshots: [qosSample('qos-good-1')]
    });
    const recoveredQuality = await quality.reportQuality({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a',
      snapshots: [qosSample('qos-good-2')]
    });
    assert.deepEqual(recoveredQuality.transitions.map((item) => item.event_type), ['recovered']);

    const rejoining = await quality.reportConnectionEvent({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a',
      event: {
        participant_identity: 'quality-host-a',
        event_id: 'qos-connection-rejoining',
        connection_revision: 2,
        event_type: 'rejoining',
        reason_code: 'network_change',
        occurred_at: '2026-07-12T08:59:55.000Z'
      }
    });
    assert.equal(rejoining.participant_state.connection_state, 'rejoining');
    await assert.rejects(
      () => quality.reportConnectionEvent({
        tenant_id: 'ivekit_rls_a',
        call_id: 'ivekit_quality_call_a',
        event: {
          participant_identity: 'quality-host-a',
          event_id: 'qos-connection-stale',
          connection_revision: 1,
          event_type: 'disconnected',
          reason_code: 'late_adapter',
          occurred_at: '2026-07-12T08:59:56.000Z'
        }
      }),
      (error: Error & { status?: number }) => error.status === 409
    );
    const qualitySummary = await quality.getSummary({
      tenant_id: 'ivekit_rls_a',
      call_id: 'ivekit_quality_call_a'
    });
    assert.equal(qualitySummary?.participants[0]?.connection_revision, 2);
    assert.equal(qualitySummary?.participants[0]?.quality_state, 'unknown');
    assert.equal(qualitySummary?.recent_snapshots.length, 4);
    assert.equal(await withPgTenant(runtime, 'ivekit_rls_a', async (tenantPg) => {
      const foreignQuality = await tenantPg.query(
        `SELECT id FROM ivekit_media_quality_snapshots WHERE tenant_id = 'ivekit_rls_b'`
      );
      return foreignQuality.rowCount;
    }), 0);
    assert.equal(await quality.prune({
      tenant_id: 'ivekit_rls_a',
      before: '2026-07-12T09:01:01.000Z',
      limit: 100
    }), 4);

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
  const legacyMigrations = opcMigrationsWithoutVoiceFoundation();
  try {
    await runMigrations(admin, {
      directory: legacyMigrations.directory,
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
    await admin.query(`
      INSERT INTO ivekit_media_calls
        (id, tenant_id, room_name, media, initiated_by,
         business_ref_type, business_ref_id, title)
      VALUES
        ('ivekit_upgrade_media', 'ivekit_upgrade_tenant', 'ivekit-upgrade-room', 'video',
         'upgrade-test', 'order', 'UP-1', 'Preserved media')
    `);
    await admin.query(`
      INSERT INTO remote_assistance_sessions
        (id, tenant_id, collaboration_session_id, business_ref_type, business_ref_id,
         status, mode, started_by)
      VALUES
        ('ivekit_upgrade_remote', 'ivekit_upgrade_tenant', 'ivekit_upgrade_session',
         'order', 'UP-1', 'active', 'platform_remote_control', 'upgrade-test')
    `);
    await admin.query(`
      INSERT INTO collaboration_intelligence_policies
        (tenant_id, translation_enabled, translation_profile_id, updated_by)
      VALUES ('ivekit_upgrade_tenant', TRUE, 'upgrade-translation', 'upgrade-test')
    `);
    const preservedBefore = await admin.query<{ snapshot: Record<string, unknown> }>(`
      SELECT jsonb_build_object(
        'campaign', (SELECT to_jsonb(c) FROM campaigns c WHERE id = 'ivekit_upgrade_campaign'),
        'session', (SELECT to_jsonb(s) FROM collaboration_sessions s WHERE id = 'ivekit_upgrade_session'),
        'media', (SELECT to_jsonb(m) FROM ivekit_media_calls m WHERE id = 'ivekit_upgrade_media'),
        'remote', (SELECT to_jsonb(r) FROM remote_assistance_sessions r WHERE id = 'ivekit_upgrade_remote'),
        'intelligence', (SELECT to_jsonb(i)
          - 'ocr_profile_ids' - 'asr_profile_ids' - 'quality_profile_ids' - 'translation_profile_ids'
          FROM collaboration_intelligence_policies i WHERE tenant_id = 'ivekit_upgrade_tenant')
      ) AS snapshot
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
    assert.equal(
      Number(productTablesAfter.rows[0].count) - Number(productTablesBefore.rows[0].count),
      voiceFoundationTables.length + ivrFoundationTables.length + contactCenterTables.length +
        providerGovernanceTables.length + contentIntelligenceTables.length +
        voiceExtensionTables.length
    );
    const sharedTablesAfter = await admin.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = ANY($1::TEXT[])
      ORDER BY tablename
    `, [[
      ...voiceFoundationTables,
      ...ivrFoundationTables,
      ...contactCenterTables,
      ...providerGovernanceTables,
      ...contentIntelligenceTables,
      ...voiceExtensionTables
    ]]);
    assert.deepEqual(
      sharedTablesAfter.rows.map((row) => row.tablename),
      [
        ...voiceFoundationTables,
        ...ivrFoundationTables,
        ...contactCenterTables,
        ...providerGovernanceTables,
        ...contentIntelligenceTables,
        ...voiceExtensionTables
      ].sort()
    );
    assert.equal((await admin.query(
      `SELECT id FROM campaigns WHERE id = 'ivekit_upgrade_campaign'`
    )).rowCount, 1);
    assert.equal((await admin.query(
      `SELECT id FROM collaboration_sessions WHERE id = 'ivekit_upgrade_session'`
    )).rowCount, 1);
    const preservedAfter = await admin.query<{ snapshot: Record<string, unknown> }>(`
      SELECT jsonb_build_object(
        'campaign', (SELECT to_jsonb(c) FROM campaigns c WHERE id = 'ivekit_upgrade_campaign'),
        'session', (SELECT to_jsonb(s) FROM collaboration_sessions s WHERE id = 'ivekit_upgrade_session'),
        'media', (SELECT to_jsonb(m) FROM ivekit_media_calls m WHERE id = 'ivekit_upgrade_media'),
        'remote', (SELECT to_jsonb(r) FROM remote_assistance_sessions r WHERE id = 'ivekit_upgrade_remote'),
        'intelligence', (SELECT to_jsonb(i)
          - 'ocr_profile_ids' - 'asr_profile_ids' - 'quality_profile_ids' - 'translation_profile_ids'
          FROM collaboration_intelligence_policies i WHERE tenant_id = 'ivekit_upgrade_tenant')
      ) AS snapshot
    `);
    assert.deepEqual(preservedAfter.rows[0].snapshot, preservedBefore.rows[0].snapshot);
    const upgradedPolicy = await admin.query<{ translation_profile_ids: string[] }>(`
      SELECT translation_profile_ids
      FROM collaboration_intelligence_policies
      WHERE tenant_id = 'ivekit_upgrade_tenant'
    `);
    assert.deepEqual(upgradedPolicy.rows[0]?.translation_profile_ids, ['upgrade-translation']);

    const standaloneVersions = await admin.query<{ version: string; count: string }>(`
      SELECT version, count(*)::text AS count
      FROM schema_migrations
      WHERE version IN (
        '000_ivekit_foundation',
        '043_ivekit_intelligence_translation',
        '044_quality_review_policy_routing',
        '045_translation_worker_routing',
        '046_ivekit_voice_foundation',
        '047_ivekit_ivr_foundation',
        '048_ivekit_voice_operations',
        '049_ivekit_voice_route_deployment',
        '050_ivekit_ivr_runtime',
        '051_ivekit_ivr_resources',
        '052_ivekit_contact_center',
        '053_ivekit_contact_center_configuration_idempotency',
        '054_ivekit_contact_center_worker',
        '055_ivekit_contact_center_callbacks',
        '056_ivekit_contact_center_overflow',
        '057_ivekit_voice_action_capabilities',
        '058_ivekit_voice_parking',
        '059_ivekit_provider_governance',
        '060_ivekit_content_intelligence',
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
      { version: '046_ivekit_voice_foundation', count: '1' },
      { version: '047_ivekit_ivr_foundation', count: '1' },
      { version: '048_ivekit_voice_operations', count: '1' },
      { version: '049_ivekit_voice_route_deployment', count: '1' },
      { version: '050_ivekit_ivr_runtime', count: '1' },
      { version: '051_ivekit_ivr_resources', count: '1' },
      { version: '052_ivekit_contact_center', count: '1' },
      { version: '053_ivekit_contact_center_configuration_idempotency', count: '1' },
      { version: '054_ivekit_contact_center_worker', count: '1' },
      { version: '055_ivekit_contact_center_callbacks', count: '1' },
      { version: '056_ivekit_contact_center_overflow', count: '1' },
      { version: '057_ivekit_voice_action_capabilities', count: '1' },
      { version: '058_ivekit_voice_parking', count: '1' },
      { version: '059_ivekit_provider_governance', count: '1' },
      { version: '060_ivekit_content_intelligence', count: '1' },
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
    legacyMigrations.cleanup();
    migrations.cleanup();
    await runtime.end();
    await admin.end();
  }
});
