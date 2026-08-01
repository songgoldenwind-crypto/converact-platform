import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import test from 'node:test';

import { createDatabase } from '../src/db.js';
import { one, run } from '../src/db-compat.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createLiveKitMediaModule, LiveKitRoomStore } from '../src/agent-runtime/livekit/index.js';

const policy = JSON.parse(readFileSync('services/converact-service/source-policy.json', 'utf8')) as {
  migrations: string[];
};

test('standalone foundation creates only the communication prerequisites', () => {
  const sql = readFileSync('services/converact-service/migrations/000_ivekit_foundation.sql', 'utf8');
  const created = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)/gi)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(created, ['audit_logs', 'call_recordings', 'livekit_rooms', 'tenants']);
  for (const forbidden of [
    'users', 'leads', 'campaigns', 'voice_call_sessions', 'ivr_', 'crm_', 'outbound_'
  ]) assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}`, 'i'), forbidden);
  assert.match(sql, /call_recordings[\s\S]*call_session_id TEXT NOT NULL/);
  assert.doesNotMatch(sql, /call_recordings[\s\S]*media_call_id/);
});

test('standalone migration order includes RLS and communication overlays but excludes Converact schemas', () => {
  const migrations = policy.migrations.map((path) => basename(path));
  assert.deepEqual(migrations.slice(0, 3), [
    '000_ivekit_foundation.sql',
    '009_tenant_rls.sql',
    '010_force_rls.sql'
  ]);
  for (const excluded of [
    '001_init.sql',
    '005_full_schema.sql',
    '023_ivr_tenant_rls.sql',
    '031_legacy_runtime_schema_rls.sql',
    '032_runtime_least_privilege.sql'
  ]) assert.equal(migrations.includes(excluded), false, excluded);
  assert.equal(migrations.includes('042_ivekit_tenant_events.sql'), true);
  assert.equal(migrations.includes('043_ivekit_intelligence_translation.sql'), true);
  assert.equal(migrations.includes('044_quality_review_policy_routing.sql'), true);
  assert.equal(migrations.includes('045_translation_worker_routing.sql'), true);
  assert.equal(migrations.includes('046_ivekit_voice_foundation.sql'), true);
  assert.equal(migrations.includes('047_ivekit_ivr_foundation.sql'), true);
  assert.equal(migrations.includes('048_ivekit_voice_operations.sql'), true);
  assert.equal(migrations.includes('049_ivekit_voice_route_deployment.sql'), true);
  assert.equal(migrations.includes('050_ivekit_ivr_runtime.sql'), true);
  assert.equal(migrations.includes('051_ivekit_ivr_resources.sql'), true);
  assert.equal(migrations.includes('052_ivekit_contact_center.sql'), true);
  assert.equal(migrations.includes('053_ivekit_contact_center_configuration_idempotency.sql'), true);
  assert.equal(migrations.includes('054_ivekit_contact_center_worker.sql'), true);
  assert.equal(migrations.includes('055_ivekit_contact_center_callbacks.sql'), true);
  assert.equal(migrations.includes('056_ivekit_contact_center_overflow.sql'), true);
  assert.equal(migrations.includes('057_ivekit_voice_action_capabilities.sql'), true);
  assert.equal(migrations.includes('058_ivekit_voice_parking.sql'), true);
  assert.equal(migrations.includes('059_ivekit_provider_governance.sql'), true);
  assert.equal(migrations.includes('060_ivekit_content_intelligence.sql'), true);
  assert.equal(migrations.includes('061_ivekit_file_security.sql'), true);
  assert.equal(migrations.includes('062_tinode_file_delivery_operations.sql'), true);
  assert.equal(migrations.includes('063_livekit_media_quality.sql'), true);
  assert.equal(migrations.includes('064_rustdesk_authorization_codes.sql'), true);
  assert.equal(migrations.includes('065_ivekit_notifications.sql'), true);
  assert.equal(migrations.includes('066_ivekit_audit.sql'), true);
  assert.equal(migrations.includes('067_ivekit_rate_limits.sql'), true);
  assert.equal(migrations.includes('068_ivekit_retention.sql'), true);
  assert.equal(migrations.includes('069_ivekit_runtime_heartbeats.sql'), true);
  assert.equal(migrations.includes('070_ivekit_notification_operations.sql'), true);
  assert.equal(migrations.includes('071_ivekit_notification_health.sql'), true);
  assert.equal(migrations.includes('072_ivekit_notification_events.sql'), true);
  assert.equal(migrations.includes('073_ivekit_integration_webhooks.sql'), true);
  assert.equal(migrations.includes('074_tinode_message_mutation_outbox.sql'), true);
  assert.equal(migrations.includes('075_rustdesk_emergency_fallback.sql'), true);
  assert.equal(migrations.includes('077_ivekit_capacity_orchestrator.sql'), true);
  assert.equal(migrations.includes('078_ivekit_cell_leases.sql'), true);
  assert.equal(migrations.includes('079_ivekit_voice_route_snapshot_revision.sql'), true);
  assert.equal(migrations.includes('080_ivekit_interaction_placements.sql'), true);
  assert.equal(migrations.includes('081_ivekit_notification_worker_partition.sql'), true);
  assert.equal(migrations.includes('082_ivekit_capacity_worker_checkpoints.sql'), true);
  assert.equal(migrations.includes('083_ivekit_cell_admission_reservations.sql'), true);
  assert.equal(migrations.includes('084_ivekit_cell_lease_topology.sql'), true);
  assert.equal(migrations.includes('085_ivekit_interaction_placement_handoffs.sql'), true);
  assert.equal(migrations.includes('086_ivekit_recording_manifests.sql'), true);
  assert.equal(migrations.includes('087_livekit_egress_jobs.sql'), true);
  assert.equal(migrations.includes('088_livekit_egress_reconciliation.sql'), true);
  assert.equal(migrations.includes('089_livekit_egress_capacity_metrics.sql'), true);
  assert.equal(migrations.includes('093_ivekit_cell_admission_rls.sql'), true);
  assert.equal(migrations.includes('094_ivekit_voice_extension_sessions.sql'), true);
  assert.equal(migrations.includes('095_rustdesk_authorization_claims.sql'), true);
  assert.equal(migrations.includes('101_ivekit_migration_readiness.sql'), true);
  assert.equal(migrations.includes('102_ivekit_voice_dialog_takeovers.sql'), true);
  assert.equal(migrations.includes('103_ivekit_voice_cdr_convergence.sql'), true);
  assert.equal(migrations.includes('104_ivekit_cell_admission_ledger_runtime.sql'), true);
  assert.equal(migrations.includes('105_tinode_closed_session_inbound.sql'), true);
  assert.equal(migrations.includes('106_tinode_open_session_mutation_queue.sql'), true);
  assert.equal(migrations.includes('107_ivekit_sip_effect_oracle.sql'), true);
  assert.equal(migrations.includes('108_converact_platform_identity_consent.sql'), true);
  assert.equal(migrations.includes('109_converact_platform_event_receipts.sql'), true);
  assert.equal(migrations.includes('110_converact_platform_usage_ledger.sql'), true);
  assert.equal(migrations.includes('111_converact_platform_key_lifecycle.sql'), true);
  assert.equal(migrations.includes('112_converact_platform_history_receipt_integrity.sql'), true);
  assert.equal(
    migrations.indexOf('043_ivekit_intelligence_translation.sql') <
      migrations.indexOf('044_quality_review_policy_routing.sql') &&
      migrations.indexOf('044_quality_review_policy_routing.sql') <
      migrations.indexOf('045_translation_worker_routing.sql') &&
      migrations.indexOf('045_translation_worker_routing.sql') <
      migrations.indexOf('046_ivekit_voice_foundation.sql') &&
      migrations.indexOf('046_ivekit_voice_foundation.sql') <
      migrations.indexOf('047_ivekit_ivr_foundation.sql') &&
      migrations.indexOf('047_ivekit_ivr_foundation.sql') <
      migrations.indexOf('048_ivekit_voice_operations.sql') &&
      migrations.indexOf('048_ivekit_voice_operations.sql') <
      migrations.indexOf('049_ivekit_voice_route_deployment.sql') &&
      migrations.indexOf('049_ivekit_voice_route_deployment.sql') <
      migrations.indexOf('050_ivekit_ivr_runtime.sql') &&
      migrations.indexOf('050_ivekit_ivr_runtime.sql') <
      migrations.indexOf('051_ivekit_ivr_resources.sql') &&
      migrations.indexOf('051_ivekit_ivr_resources.sql') <
      migrations.indexOf('052_ivekit_contact_center.sql') &&
      migrations.indexOf('052_ivekit_contact_center.sql') <
      migrations.indexOf('053_ivekit_contact_center_configuration_idempotency.sql') &&
      migrations.indexOf('053_ivekit_contact_center_configuration_idempotency.sql') <
      migrations.indexOf('054_ivekit_contact_center_worker.sql') &&
      migrations.indexOf('054_ivekit_contact_center_worker.sql') <
      migrations.indexOf('055_ivekit_contact_center_callbacks.sql') &&
      migrations.indexOf('055_ivekit_contact_center_callbacks.sql') <
      migrations.indexOf('056_ivekit_contact_center_overflow.sql') &&
      migrations.indexOf('056_ivekit_contact_center_overflow.sql') <
      migrations.indexOf('057_ivekit_voice_action_capabilities.sql') &&
      migrations.indexOf('057_ivekit_voice_action_capabilities.sql') <
      migrations.indexOf('058_ivekit_voice_parking.sql') &&
      migrations.indexOf('058_ivekit_voice_parking.sql') <
      migrations.indexOf('059_ivekit_provider_governance.sql') &&
      migrations.indexOf('059_ivekit_provider_governance.sql') <
      migrations.indexOf('060_ivekit_content_intelligence.sql') &&
      migrations.indexOf('060_ivekit_content_intelligence.sql') <
      migrations.indexOf('061_ivekit_file_security.sql') &&
      migrations.indexOf('061_ivekit_file_security.sql') <
      migrations.indexOf('062_tinode_file_delivery_operations.sql') &&
      migrations.indexOf('062_tinode_file_delivery_operations.sql') <
      migrations.indexOf('063_livekit_media_quality.sql') &&
      migrations.indexOf('063_livekit_media_quality.sql') <
      migrations.indexOf('064_rustdesk_authorization_codes.sql') &&
      migrations.indexOf('064_rustdesk_authorization_codes.sql') <
      migrations.indexOf('065_ivekit_notifications.sql') &&
      migrations.indexOf('065_ivekit_notifications.sql') <
      migrations.indexOf('066_ivekit_audit.sql') &&
      migrations.indexOf('066_ivekit_audit.sql') <
      migrations.indexOf('067_ivekit_rate_limits.sql') &&
      migrations.indexOf('067_ivekit_rate_limits.sql') <
      migrations.indexOf('068_ivekit_retention.sql') &&
      migrations.indexOf('068_ivekit_retention.sql') <
      migrations.indexOf('069_ivekit_runtime_heartbeats.sql') &&
      migrations.indexOf('069_ivekit_runtime_heartbeats.sql') <
      migrations.indexOf('070_ivekit_notification_operations.sql') &&
      migrations.indexOf('070_ivekit_notification_operations.sql') <
      migrations.indexOf('071_ivekit_notification_health.sql') &&
      migrations.indexOf('071_ivekit_notification_health.sql') <
      migrations.indexOf('072_ivekit_notification_events.sql') &&
      migrations.indexOf('072_ivekit_notification_events.sql') <
      migrations.indexOf('073_ivekit_integration_webhooks.sql') &&
      migrations.indexOf('073_ivekit_integration_webhooks.sql') <
      migrations.indexOf('074_tinode_message_mutation_outbox.sql') &&
      migrations.indexOf('074_tinode_message_mutation_outbox.sql') <
      migrations.indexOf('075_rustdesk_emergency_fallback.sql') &&
      migrations.indexOf('075_rustdesk_emergency_fallback.sql') <
      migrations.indexOf('076_rustdesk_evidence_intelligence_reconciliation.sql') &&
      migrations.indexOf('076_rustdesk_evidence_intelligence_reconciliation.sql') <
      migrations.indexOf('077_ivekit_capacity_orchestrator.sql') &&
      migrations.indexOf('077_ivekit_capacity_orchestrator.sql') <
      migrations.indexOf('078_ivekit_cell_leases.sql') &&
      migrations.indexOf('078_ivekit_cell_leases.sql') <
      migrations.indexOf('079_ivekit_voice_route_snapshot_revision.sql') &&
      migrations.indexOf('079_ivekit_voice_route_snapshot_revision.sql') <
      migrations.indexOf('080_ivekit_interaction_placements.sql') &&
      migrations.indexOf('080_ivekit_interaction_placements.sql') <
      migrations.indexOf('081_ivekit_notification_worker_partition.sql') &&
      migrations.indexOf('081_ivekit_notification_worker_partition.sql') <
      migrations.indexOf('082_ivekit_capacity_worker_checkpoints.sql') &&
      migrations.indexOf('082_ivekit_capacity_worker_checkpoints.sql') <
      migrations.indexOf('083_ivekit_cell_admission_reservations.sql') &&
      migrations.indexOf('083_ivekit_cell_admission_reservations.sql') <
      migrations.indexOf('084_ivekit_cell_lease_topology.sql') &&
      migrations.indexOf('084_ivekit_cell_lease_topology.sql') <
      migrations.indexOf('085_ivekit_interaction_placement_handoffs.sql') &&
      migrations.indexOf('085_ivekit_interaction_placement_handoffs.sql') <
      migrations.indexOf('086_ivekit_recording_manifests.sql') &&
      migrations.indexOf('086_ivekit_recording_manifests.sql') <
      migrations.indexOf('087_livekit_egress_jobs.sql') &&
      migrations.indexOf('087_livekit_egress_jobs.sql') <
      migrations.indexOf('088_livekit_egress_reconciliation.sql') &&
      migrations.indexOf('088_livekit_egress_reconciliation.sql') <
      migrations.indexOf('089_livekit_egress_capacity_metrics.sql') &&
      migrations.indexOf('089_livekit_egress_capacity_metrics.sql') <
      migrations.indexOf('090_ivekit_runtime_security.sql') &&
      migrations.indexOf('090_ivekit_runtime_security.sql') <
      migrations.indexOf('091_ivekit_capacity_scaling_campaigns.sql') &&
      migrations.indexOf('091_ivekit_capacity_scaling_campaigns.sql') <
      migrations.indexOf('092_ivekit_capacity_platform_campaigns.sql') &&
      migrations.indexOf('092_ivekit_capacity_platform_campaigns.sql') <
      migrations.indexOf('093_ivekit_cell_admission_rls.sql') &&
      migrations.indexOf('093_ivekit_cell_admission_rls.sql') <
      migrations.indexOf('094_ivekit_voice_extension_sessions.sql') &&
      migrations.indexOf('094_ivekit_voice_extension_sessions.sql') <
      migrations.indexOf('095_rustdesk_authorization_claims.sql') &&
      migrations.indexOf('095_rustdesk_authorization_claims.sql') <
      migrations.indexOf('101_ivekit_migration_readiness.sql') &&
      migrations.indexOf('101_ivekit_migration_readiness.sql') <
      migrations.indexOf('102_ivekit_voice_dialog_takeovers.sql') &&
      migrations.indexOf('102_ivekit_voice_dialog_takeovers.sql') <
      migrations.indexOf('103_ivekit_voice_cdr_convergence.sql') &&
      migrations.indexOf('103_ivekit_voice_cdr_convergence.sql') <
      migrations.indexOf('104_ivekit_cell_admission_ledger_runtime.sql') &&
      migrations.indexOf('104_ivekit_cell_admission_ledger_runtime.sql') <
      migrations.indexOf('105_tinode_closed_session_inbound.sql') &&
      migrations.indexOf('105_tinode_closed_session_inbound.sql') <
      migrations.indexOf('106_tinode_open_session_mutation_queue.sql') &&
      migrations.indexOf('106_tinode_open_session_mutation_queue.sql') <
      migrations.indexOf('107_ivekit_sip_effect_oracle.sql') &&
      migrations.indexOf('107_ivekit_sip_effect_oracle.sql') <
      migrations.indexOf('108_converact_platform_identity_consent.sql') &&
      migrations.indexOf('108_converact_platform_identity_consent.sql') <
      migrations.indexOf('109_converact_platform_event_receipts.sql') &&
      migrations.indexOf('109_converact_platform_event_receipts.sql') <
      migrations.indexOf('110_converact_platform_usage_ledger.sql') &&
      migrations.indexOf('110_converact_platform_usage_ledger.sql') <
      migrations.indexOf('111_converact_platform_key_lifecycle.sql') &&
      migrations.indexOf('111_converact_platform_key_lifecycle.sql') <
      migrations.indexOf('112_converact_platform_history_receipt_integrity.sql'),
    true
  );
  assert.equal(migrations.at(-1), '112_converact_platform_history_receipt_integrity.sql');
  const runtimeSecurity = readFileSync(
    'services/converact-service/migrations/090_ivekit_runtime_security.sql',
    'utf8'
  );
  assert.match(runtimeSecurity, /current_user = 'opc_admin'/);
  assert.match(runtimeSecurity, /opc_rustdesk_session_by_external_id/);
  assert.match(runtimeSecurity, /opc_ivekit_cc_worker_tenant_ids/);
  assert.match(runtimeSecurity, /opc_notification_worker_tenant_ids/);
  assert.match(runtimeSecurity, /opc_ivekit_claim_interaction_placements/);
  assert.match(runtimeSecurity, /opc_ivekit_placement_tenant_ids/);
  assert.match(runtimeSecurity, /opc_notification_health_tenant_ids/);
  assert.match(runtimeSecurity, /opc_ivekit_delete_expired_audit_events/);
  assert.match(runtimeSecurity, /opc_tinode_mutation_tenant_ids/);
  assert.match(runtimeSecurity, /opc_rustdesk_evidence_intelligence_candidates/);
  assert.doesNotMatch(runtimeSecurity, /\busers\b|voice_call_sessions|call-center|ivr_/i);
});

test('standalone service exposes a compiled migration entrypoint', () => {
  const servicePackage = JSON.parse(readFileSync('services/converact-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const dockerfile = readFileSync('services/converact-service/Dockerfile', 'utf8');
  assert.equal(servicePackage.scripts.migrate, 'node dist/converact-migrate.js');
  assert.match(dockerfile, /COPY migrations \.\/migrations/);
  assert.doesNotMatch(dockerfile, /tsx|scripts\/run-postgres-migrations/);
});

test('standalone service owns compiled runtime-role bootstrap and Compose ordering', () => {
  const servicePackage = JSON.parse(readFileSync('services/converact-service/package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const compose = readFileSync('services/converact-service/docker-compose.yml', 'utf8');
  const envExample = readFileSync('services/converact-service/env.example', 'utf8');

  assert.equal(servicePackage.scripts['init:runtime-role'], 'node dist/converact-init-runtime-role.js');
  assert.match(compose, /runtime-role-init:[\s\S]*dist\/converact-init-runtime-role\.js/);
  assert.match(compose, /migrate:[\s\S]*runtime-role-init:[\s\S]*condition: service_completed_successfully/);
  assert.match(compose, /converact:[\s\S]*migrate:[\s\S]*condition: service_completed_successfully/);
  assert.match(compose, /PGUSER: opc_runtime/);
  assert.match(compose, /CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT: \$\{CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT:-0\}/);
  assert.match(compose, /CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET: \$\{CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET:-\}/);
  assert.match(envExample, /^CONVERACT_RUSTDESK_REQUIRE_PHYSICAL_DISCONNECT=0$/m);
  assert.match(envExample, /^CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET=$/m);
  assert.doesNotMatch(compose, /\.\.\/\.\.|converact-platform|src\/server\.ts/);
});

test('generic media module does not write the legacy Converact voice session', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Standalone media tenant' });
  run(db, 'INSERT INTO voice_call_sessions (id, tenant_id) VALUES (?, ?)', ['voice_generic', tenant.id]);

  await createLiveKitMediaModule({ db }).rooms.createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    call_session_id: 'voice_generic',
    room_name: 'standalone-generic-room'
  });

  const row = one(db, 'SELECT * FROM voice_call_sessions WHERE id = ?', ['voice_generic']);
  assert.equal(row?.livekit_room_name, '');
  db.close();
});

test('legacy direct room store keeps Converact voice session synchronization', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Legacy media tenant' });
  run(db, 'INSERT INTO voice_call_sessions (id, tenant_id) VALUES (?, ?)', ['voice_legacy', tenant.id]);

  await new LiveKitRoomStore(db).createRoom({
    tenant_id: tenant.id,
    purpose: 'video_service',
    call_session_id: 'voice_legacy',
    room_name: 'legacy-room'
  });

  const row = one(db, 'SELECT * FROM voice_call_sessions WHERE id = ?', ['voice_legacy']);
  assert.equal(row?.livekit_room_name, 'legacy-room');
  db.close();
});
