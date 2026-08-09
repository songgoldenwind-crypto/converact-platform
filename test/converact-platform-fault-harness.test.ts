import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertEvidenceArtifactSafe,
  evaluateControlledFaultScenario,
  faultScenarioCatalog,
  summarizeFaultCampaign
} from '../services/converact-service/acceptance/platform-fault-matrix/evidence-contract.mjs';
import {
  buildDatabaseEvidence
} from '../services/converact-service/acceptance/platform-fault-matrix/database-probe.js';
import {
  buildBackupRestoreEvidence,
  buildBoundedCapacityEvidence,
  buildDrainEvidence
} from '../services/converact-service/acceptance/platform-fault-matrix/campaign-evidence.mjs';
import {
  runBoundedCapacityWorkload
} from '../services/converact-service/acceptance/platform-fault-matrix/capacity-probe.js';
import {
  PLATFORM_DRAIN_AUTHORITIES,
  signPlatformDrainReceipt,
  type PlatformDrainAuthority
} from '../src/agent-runtime/converact/platform-foundation/index.js';

const acceptanceRoot = new URL(
  '../services/converact-service/acceptance/platform-fault-matrix/',
  import.meta.url
);
const machineMatrix = JSON.parse(readFileSync(new URL(
  '../architecture-foundation/execution/goal-02/fault-matrix-v1.json',
  import.meta.url
), 'utf8')) as {
  dependencies: Array<{ dependency: string; failure_modes: string[] }>;
};

const identity = {
  goal_id: 'G02',
  goal_sha256: '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9',
  source_commit: 'a'.repeat(40),
  config_sha256: 'b'.repeat(64),
  raw_output_sha256: 'c'.repeat(64),
  image_digests: [
    'postgres@sha256:' + 'd'.repeat(64),
    'node@sha256:' + 'e'.repeat(64)
  ],
  node_binary_sha256: 'f'.repeat(64),
  node_version: 'v24.5.0',
  host: 'validation.example',
  hardware: '2 vCPU; 8 GiB',
  clock: 'UTC synchronized; monotonic process clock',
  workload: 'one bounded scenario',
  seed: 'g02-seed-1',
  started_at: '2026-08-01T16:00:00.000Z',
  completed_at: '2026-08-01T16:01:00.000Z'
};

test('fault harness catalog exactly mirrors every machine dependency and mode', () => {
  const catalog = faultScenarioCatalog();
  assert.deepEqual(
    catalog.map((entry) => ({
      dependency: entry.dependency,
      failure_modes: [...entry.failure_modes]
    })),
    machineMatrix.dependencies.map((entry) => ({
      dependency: entry.dependency,
      failure_modes: entry.failure_modes
    }))
  );
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(catalog.every(Object.isFrozen), true);
});

test('unexecuted scenario remains not_run and cannot carry a production claim', () => {
  const result = evaluateControlledFaultScenario({
    dependency: 'database',
    failure_mode: 'restart',
    executed: false,
    blocker: 'validation dependency unavailable'
  });
  assert.deepEqual(result, {
    dependency: 'database',
    failure_mode: 'restart',
    status: 'not_run',
    production_eligible: false,
    real_human_media: false,
    blocker: 'validation dependency unavailable',
    evidence: null
  });
});

test('controlled evidence needs actual fault identity raw output and every check', () => {
  const valid = evaluateControlledFaultScenario({
    dependency: 'database',
    failure_mode: 'restart',
    executed: true,
    actual_fault: true,
    identity,
    media_probe: {
      kind: 'synthetic_transport',
      established_before_fault: true,
      continuous_during_fault: true,
      completed_after_recovery: true
    },
    checks: [
      { id: 'runtime_rls', passed: true },
      { id: 'restart_reconcile', passed: true }
    ]
  });
  assert.equal(valid.status, 'verified_controlled');
  assert.equal(valid.production_eligible, false);
  assert.equal(valid.real_human_media, false);

  for (const invalid of [
    { actual_fault: false, identity, checks: [{ id: 'x', passed: true }] },
    { actual_fault: true, identity: { ...identity, source_commit: 'main' }, checks: [{ id: 'x', passed: true }] },
    { actual_fault: true, identity, checks: [{ id: 'x', passed: false }] }
  ]) {
    const result = evaluateControlledFaultScenario({
      dependency: 'database',
      failure_mode: 'restart',
      executed: true,
      media_probe: {
        kind: 'synthetic_transport',
        established_before_fault: true,
        continuous_during_fault: true,
        completed_after_recovery: true
      },
      ...invalid
    } as never);
    assert.equal(result.status, 'failed');
    assert.equal(result.production_eligible, false);
  }
});

test('synthetic transport cannot be relabelled as real long human media', () => {
  const synthetic = evaluateControlledFaultScenario({
    dependency: 'observability',
    failure_mode: 'collector_down',
    executed: true,
    actual_fault: true,
    identity,
    media_probe: {
      kind: 'synthetic_transport',
      established_before_fault: true,
      continuous_during_fault: true,
      completed_after_recovery: true
    },
    checks: [{ id: 'bounded_drop', passed: true }]
  });
  assert.equal(synthetic.status, 'verified_controlled');
  assert.equal(synthetic.real_human_media, false);
  assert.throws(() => evaluateControlledFaultScenario({
    dependency: 'observability',
    failure_mode: 'collector_down',
    executed: true,
    actual_fault: true,
    identity,
    media_probe: {
      kind: 'real_human_media',
      established_before_fault: true,
      continuous_during_fault: true,
      completed_after_recovery: true
    },
    checks: [{ id: 'bounded_drop', passed: true }]
  }), /human_media_identity_required/);
});

test('campaign summary never promotes partial or failed matrix coverage', () => {
  const database = evaluateControlledFaultScenario({
    dependency: 'database',
    failure_mode: 'restart',
    executed: true,
    actual_fault: true,
    identity,
    media_probe: {
      kind: 'synthetic_transport',
      established_before_fault: true,
      continuous_during_fault: true,
      completed_after_recovery: true
    },
    checks: [{ id: 'restart_reconcile', passed: true }]
  });
  const summary = summarizeFaultCampaign([database]);
  assert.deepEqual(summary, {
    status: 'partial',
    production_eligible: false,
    verified_controlled: 1,
    failed: 0,
    not_run: 11,
    real_human_media_dependencies: 0,
    complete_matrix: false
  });
});

test('evidence rejects secret-shaped fields and values', () => {
  assert.throws(() => evaluateControlledFaultScenario({
    dependency: 'database',
    failure_mode: 'restart',
    executed: true,
    actual_fault: true,
    identity: { ...identity, api_token: 'should-never-be-evidence' },
    media_probe: {
      kind: 'synthetic_transport',
      established_before_fault: true,
      continuous_during_fault: true,
      completed_after_recovery: true
    },
    checks: [{ id: 'x', passed: true }]
  } as never), /evidence_secret_forbidden/);

  for (const secret of [
    'Bearer abcdefghijklmnopqrstuvwxyz012345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZW5hbnQtYSJ9.abcdefghijklmnop',
    'api_key=sk-test-abcdefghijklmnopqrstuvwxyz',
    'password=qwe.312..',
    'postgresql://runtime-user:runtime-password@database.internal/platform'
  ]) {
    assert.throws(() => evaluateControlledFaultScenario({
      dependency: 'database',
      failure_mode: 'restart',
      executed: false,
      blocker: `generic note ${secret}`
    }), /evidence_secret_forbidden/, secret);
    assert.throws(() => assertEvidenceArtifactSafe(`raw log: ${secret}\n`),
      /evidence_secret_forbidden/, secret);
  }
});

test('raw evidence scanner binds every safe artifact and rejects a secret in a generic log', () => {
  const root = mkdtempSync(join(tmpdir(), 'converact-g02-evidence-scan-'));
  const scanner = new URL(
    '../services/converact-service/acceptance/platform-fault-matrix/evidence-secret-scan.mjs',
    import.meta.url
  );
  try {
    const safeA = join(root, 'a.log');
    const safeB = join(root, 'b.json');
    const manifest = join(root, 'raw-output.sha256');
    writeFileSync(safeA, 'bounded non-secret output\n');
    writeFileSync(safeB, '{"status":"passed"}\n');
    execFileSync(process.execPath, [scanner.pathname, manifest, safeB, safeA], { stdio: 'pipe' });
    assert.deepEqual(
      readFileSync(manifest, 'utf8').trim().split('\n').map((line) => line.slice(66)),
      ['a.log', 'b.json']
    );

    const secret = join(root, 'generic.log');
    const rejectedManifest = join(root, 'rejected.sha256');
    writeFileSync(secret, '{"note":"password=qwe.312.."}\n');
    assert.throws(
      () => execFileSync(process.execPath, [scanner.pathname, rejectedManifest, secret], { stdio: 'pipe' }),
      /Command failed/
    );
    assert.throws(() => readFileSync(rejectedManifest, 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acceptance entrypoints are project-scoped digest-pinned and explicit about non-claims', () => {
  const script = readFileSync(new URL('accept.sh', acceptanceRoot), 'utf8');
  const compose = readFileSync(new URL('docker-compose.yml', acceptanceRoot), 'utf8');
  const readme = readFileSync(new URL('README.md', acceptanceRoot), 'utf8');

  assert.match(script, /G02_PLATFORM_FAULT_MATRIX/);
  assert.match(script, /docker compose --project-name/);
  assert.match(script, /evidence-secret-scan\.mjs/);
  assert.match(script, /RAW_ARTIFACTS/);
  assert.match(script, /RAW_OUTPUT_SHA256=\$\(sha256sum "\$RAW_MANIFEST"/);
  assert.doesNotMatch(script, /docker (?:system )?prune|docker stop \$\(docker ps/);
  assert.match(compose, /\?POSTGRES_IMAGE immutable digest reference is required/);
  assert.match(compose, /internal: true/);
  assert.match(readme, /synthetic.*not.*real.*human media/is);
  assert.match(readme, /production[_ -]eligible.*false/is);
  assert.match(readme, /not_run/);
});

test('database remains unpublished while the host probe uses its private bridge address', () => {
  const script = readFileSync(new URL('accept.sh', acceptanceRoot), 'utf8');
  const compose = readFileSync(new URL('docker-compose.yml', acceptanceRoot), 'utf8');
  const readme = readFileSync(new URL('README.md', acceptanceRoot), 'utf8');

  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(script, /POSTGRES_ADDRESS=\$\(docker inspect/);
  assert.match(script, /export PGHOST="\$POSTGRES_ADDRESS" PGPORT=5432/);
  assert.match(readme, /no published database port.*private internal bridge/is);
});

test('database evidence requires actual RLS restart recovery and synthetic continuity facts', () => {
  const result = buildDatabaseEvidence({
    identity,
    prepare: {
      status: 'passed', process_pid: 101, migration_head: '114_converact_sip_effect_transport_completed_validate',
      tenant_a_visible: 1, tenant_b_visible_from_a: 0, no_context_visible: 0,
      cross_tenant_insert_denied: true, inbox_inserted: true,
      accepted_receipt_inserted: true, completed_receipt_inserted: true, usage_inserted: true
    },
    outage: { status: 'passed', query_failed_during_outage: true },
    restart: {
      status: 'passed', same_container: true,
      before_started_at: '2026-08-01T16:00:01.000Z',
      after_started_at: '2026-08-01T16:00:05.123456789Z',
      validation_resources_remaining: 0, unrelated_containers_unchanged: true
    },
    recover: {
      status: 'passed', process_pid: 202, tenant_a_visible: 1,
      tenant_b_visible_from_a: 0, no_context_visible: 0,
      inbox_replayed: true, inbox_conflict_rejected: true,
      accepted_receipt_replayed: true, completed_receipt_replayed: true,
      observed_receipt_inserted: true, usage_replayed: true,
      stale_writer_rejected: true, immutable_update_rejected: true
    },
    media: {
      status: 'passed', kind: 'synthetic_transport', sent_packets: 1500,
      received_packets: 1500, lost_packets: 0, duplicate_packets: 0,
      maximum_gap_ms: 31, established_before_fault: true,
      continuous_during_fault: true, completed_after_recovery: true
    }
  });
  assert.equal(result.status, 'verified_controlled');
  assert.equal(result.real_human_media, false);
  assert.equal(result.production_eligible, false);
  assert.equal(result.evidence.checks.length, 8);

  const sameProcess = buildDatabaseEvidence({
    identity,
    prepare: {
      status: 'passed', process_pid: 101, migration_head: '114_converact_sip_effect_transport_completed_validate',
      tenant_a_visible: 1, tenant_b_visible_from_a: 0, no_context_visible: 0,
      cross_tenant_insert_denied: true, inbox_inserted: true,
      accepted_receipt_inserted: true, completed_receipt_inserted: true, usage_inserted: true
    },
    outage: { status: 'passed', query_failed_during_outage: true },
    restart: {
      status: 'passed', same_container: true,
      before_started_at: '2026-08-01T16:00:01.000Z',
      after_started_at: '2026-08-01T16:00:05.123456789Z',
      validation_resources_remaining: 0, unrelated_containers_unchanged: true
    },
    recover: {
      status: 'passed', process_pid: 101, tenant_a_visible: 1,
      tenant_b_visible_from_a: 0, no_context_visible: 0,
      inbox_replayed: true, inbox_conflict_rejected: true,
      accepted_receipt_replayed: true, completed_receipt_replayed: true,
      observed_receipt_inserted: true, usage_replayed: true,
      stale_writer_rejected: true, immutable_update_rejected: true
    },
    media: {
      status: 'passed', kind: 'synthetic_transport', sent_packets: 1500,
      received_packets: 1500, lost_packets: 0, duplicate_packets: 0,
      maximum_gap_ms: 31, established_before_fault: true,
      continuous_during_fault: true, completed_after_recovery: true
    }
  });
  assert.equal(sameProcess.status, 'failed');
});

test('database runner has bounded actual stop-start lifecycle and cleanup', () => {
  const script = readFileSync(new URL('accept.sh', acceptanceRoot), 'utf8');
  assert.match(script, /compose up --detach postgres/);
  assert.match(
    script,
    /net\.createConnection\(\{ host: process\.env\.PGHOST, port: Number\(process\.env\.PGPORT\) \}/
  );
  assert.match(script, /compose stop --timeout [0-9]+ postgres/);
  assert.match(script, /compose start postgres/);
  assert.match(script, /database-probe\.ts.*prepare/s);
  assert.match(script, /database-probe\.ts.*outage/s);
  assert.match(script, /database-probe\.ts.*recover/s);
  assert.match(script, /database-probe\.ts.*finalize/s);
  assert.match(script, /git -C "\$ROOT_DIR" rev-parse HEAD/);
  assert.match(script, /git -C "\$ROOT_DIR" status --porcelain/);
  assert.match(script, /NODE_VERSION.*v24/);
  assert.match(script, /CONVERACT_G02_NODE_IMAGE/);
  assert.match(script, /NODE_BINARY_SHA256/);
  assert.match(script, /trap cleanup EXIT HUP INT TERM/);
  assert.match(script, /compose down --volumes --remove-orphans/);
});

test('backup restore evidence requires a distinct empty target and measured zero-loss RPO/RTO', () => {
  const result = buildBackupRestoreEvidence({
    identity,
    backup: {
      status: 'passed',
      process_pid: 101,
      source_database_id: 'source-db-a',
      backup_id: 'restore-proof-a',
      artifact_sha256: '1'.repeat(64),
      checkpoint_records: 7,
      checkpoint_digest: '2'.repeat(64),
      object_count: 1,
      object_digest: '3'.repeat(64),
      backup_started_at: '2026-08-01T16:00:01.000Z',
      backup_completed_at: '2026-08-01T16:00:02.000Z'
    },
    restore: {
      status: 'passed',
      target_database_id: 'restore-db-b',
      backup_id: 'restore-proof-a',
      target_was_empty: true,
      restore_process_pid: 201,
      fresh_process_pid: 202,
      migration_head: '114_converact_sip_effect_transport_completed_validate',
      restored_records: 7,
      restored_digest: '2'.repeat(64),
      restored_object_count: 1,
      restored_object_digest: '3'.repeat(64),
      measured_rpo_ms: 0,
      measured_rto_ms: 3_250,
      rto_clock_domain: 'monotonic',
      rto_measurement_scope: 'restore_runtime_role_fresh_process_verify',
      runtime_rls_verified: true,
      append_only_verified: true,
      unrelated_containers_unchanged: true,
      validation_resources_remaining: 0
    }
  });
  assert.equal(result.status, 'verified_controlled');
  assert.equal(result.production_eligible, false);
  assert.equal(result.measured_rpo_ms, 0);
  assert.equal(result.measured_rto_ms, 3_250);

  assert.equal(buildBackupRestoreEvidence({
    identity,
    backup: {
      status: 'passed', process_pid: 101, source_database_id: 'same-db', artifact_sha256: '1'.repeat(64),
      backup_id: 'restore-proof-a',
      checkpoint_records: 7, checkpoint_digest: '2'.repeat(64),
      object_count: 1, object_digest: '3'.repeat(64),
      backup_started_at: '2026-08-01T16:00:01.000Z',
      backup_completed_at: '2026-08-01T16:00:02.000Z'
    },
    restore: {
      status: 'passed', target_database_id: 'same-db', target_was_empty: true,
      backup_id: 'restore-proof-a',
      restore_process_pid: 201,
      fresh_process_pid: 202, migration_head: '114_converact_sip_effect_transport_completed_validate',
      restored_records: 7, restored_digest: '2'.repeat(64), measured_rpo_ms: 0,
      restored_object_count: 1, restored_object_digest: '3'.repeat(64),
      measured_rto_ms: 3_250, runtime_rls_verified: true, append_only_verified: true,
      rto_clock_domain: 'monotonic',
      rto_measurement_scope: 'restore_runtime_role_fresh_process_verify',
      unrelated_containers_unchanged: true, validation_resources_remaining: 0
    }
  }).status, 'failed');

  assert.equal(buildBackupRestoreEvidence({
    identity,
    backup: {
      status: 'passed', process_pid: 202, source_database_id: 'source-db-a',
      backup_id: 'restore-proof-a',
      artifact_sha256: '1'.repeat(64), checkpoint_records: 7,
      checkpoint_digest: '2'.repeat(64), object_count: 1, object_digest: '3'.repeat(64),
      backup_started_at: '2026-08-01T16:00:01.000Z',
      backup_completed_at: '2026-08-01T16:00:02.000Z'
    },
    restore: {
      status: 'passed', target_database_id: 'restore-db-b', target_was_empty: true,
      backup_id: 'restore-proof-a',
      restore_process_pid: 201,
      fresh_process_pid: 202, migration_head: '114_converact_sip_effect_transport_completed_validate',
      restored_records: 7, restored_digest: '2'.repeat(64),
      restored_object_count: 1, restored_object_digest: '3'.repeat(64),
      measured_rpo_ms: 0, measured_rto_ms: 3_250, runtime_rls_verified: true,
      rto_clock_domain: 'monotonic',
      rto_measurement_scope: 'restore_runtime_role_fresh_process_verify',
      append_only_verified: true, unrelated_containers_unchanged: true,
      validation_resources_remaining: 0
    }
  }).status, 'failed');

  assert.equal(buildBackupRestoreEvidence({
    identity,
    backup: {
      status: 'passed', process_pid: 101, source_database_id: 'source-db-a',
      backup_id: 'restore-proof-a',
      artifact_sha256: '1'.repeat(64), checkpoint_records: 7,
      checkpoint_digest: '2'.repeat(64), object_count: 1, object_digest: '3'.repeat(64),
      backup_started_at: '2026-08-01T16:00:01.000Z',
      backup_completed_at: '2026-08-01T16:00:02.000Z'
    },
    restore: {
      status: 'passed', target_database_id: 'restore-db-b', target_was_empty: true,
      backup_id: 'restore-proof-a',
      restore_process_pid: 201,
      fresh_process_pid: 202, migration_head: '114_converact_sip_effect_transport_completed_validate',
      restored_records: 7, restored_digest: '2'.repeat(64),
      restored_object_count: 1, restored_object_digest: '4'.repeat(64),
      measured_rpo_ms: 0, measured_rto_ms: 3_250, runtime_rls_verified: true,
      rto_clock_domain: 'monotonic',
      rto_measurement_scope: 'restore_runtime_role_fresh_process_verify',
      append_only_verified: true, unrelated_containers_unchanged: true,
      validation_resources_remaining: 0
    }
  }).status, 'failed');

  assert.equal(buildBackupRestoreEvidence({
    identity,
    backup: {
      status: 'passed', process_pid: 101, source_database_id: 'source-db-a',
      backup_id: 'restore-proof-a', artifact_sha256: '1'.repeat(64), checkpoint_records: 7,
      checkpoint_digest: '2'.repeat(64), object_count: 1, object_digest: '3'.repeat(64),
      backup_started_at: '2026-08-01T16:00:01.000Z',
      backup_completed_at: '2026-08-01T16:00:02.000Z'
    },
    restore: {
      status: 'passed', target_database_id: 'restore-db-b', target_was_empty: true,
      backup_id: 'restore-proof-b', restore_process_pid: 201, fresh_process_pid: 202,
      migration_head: '114_converact_sip_effect_transport_completed_validate',
      restored_records: 7, restored_digest: '2'.repeat(64),
      restored_object_count: 1, restored_object_digest: '3'.repeat(64),
      measured_rpo_ms: 0, measured_rto_ms: 3_250, runtime_rls_verified: true,
      rto_clock_domain: 'monotonic',
      rto_measurement_scope: 'restore_runtime_role_fresh_process_verify',
      append_only_verified: true, unrelated_containers_unchanged: true,
      validation_resources_remaining: 0
    }
  }).status, 'failed');

  assert.equal(buildBackupRestoreEvidence({
    identity,
    backup: {
      status: 'passed', process_pid: 101, source_database_id: 'source-db-a',
      backup_id: 'restore-proof-a', artifact_sha256: '1'.repeat(64), checkpoint_records: 7,
      checkpoint_digest: '2'.repeat(64), object_count: 1, object_digest: '3'.repeat(64),
      backup_started_at: '2026-08-01T16:00:01.000Z',
      backup_completed_at: '2026-08-01T16:00:02.000Z'
    },
    restore: {
      status: 'passed', target_database_id: 'restore-db-b', target_was_empty: true,
      backup_id: 'restore-proof-a', restore_process_pid: 201, fresh_process_pid: 202,
      migration_head: '114_converact_sip_effect_transport_completed_validate',
      restored_records: 7, restored_digest: '2'.repeat(64),
      restored_object_count: 1, restored_object_digest: '3'.repeat(64),
      measured_rpo_ms: 0, measured_rto_ms: 3_250,
      rto_clock_domain: 'wall',
      rto_measurement_scope: 'restore_runtime_role_fresh_process_verify',
      runtime_rls_verified: true, append_only_verified: true,
      unrelated_containers_unchanged: true, validation_resources_remaining: 0
    }
  }).status, 'failed');
});

test('backup restore runner is exact-source project-scoped and destroys only validation resources', () => {
  const script = readFileSync(new URL('restore-accept.sh', acceptanceRoot), 'utf8');
  const probe = readFileSync(new URL('restore-probe.ts', acceptanceRoot), 'utf8');
  assert.match(script, /G02_PLATFORM_RESTORE_EVIDENCE/);
  assert.match(script, /git -C "\$ROOT_DIR" rev-parse HEAD/);
  assert.match(script, /git -C "\$ROOT_DIR" status --porcelain/);
  assert.match(script, /POSTGRES_IMAGE.*@sha256/);
  assert.match(script, /SOURCE_PROJECT=.*\$\{RUN_ID\}.*source/);
  assert.match(script, /TARGET_PROJECT=.*\$\{RUN_ID\}.*target/);
  assert.match(script, /compose_source up --detach postgres/);
  assert.match(script, /compose_source down --volumes --remove-orphans/);
  assert.match(script, /compose_target up --detach postgres/);
  assert.match(script, /restore-probe\.ts.*backup/s);
  assert.match(script, /restore-probe\.ts.*orchestrate/s);
  assert.doesNotMatch(script, /RTO_STARTED_MS|Date\.now\(\)/);
  assert.match(probe, /performance\.now\(\)/);
  assert.match(probe, /restore_runtime_role_fresh_process_verify/);
  assert.doesNotMatch(probe, /measured_rto_ms:\s*Math\.max\([^\n]*Date\.now/);
  assert.match(script, /target-empty\.json/);
  assert.match(script, /trap cleanup EXIT HUP INT TERM/);
  assert.doesNotMatch(script, /docker (?:system )?prune/);
  assert.doesNotMatch(script, /docker (?:stop|rm) /);
});

test('restore probe preserves opaque container identity while resolving only file paths', () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONVERACT_G02_FAULT_RUN_ID: 'restore-parse',
    CONVERACT_G02_RESTORE_CONFIRM: 'G02_PLATFORM_RESTORE_EVIDENCE'
  };
  delete env.CONVERACT_UPLOAD_DIR;
  assert.throws(() => execFileSync(process.execPath, [
    '--import', 'tsx', new URL('restore-probe.ts', acceptanceRoot).pathname,
    'backup', 'a'.repeat(12), '/tmp/converact-unused-backup', '/tmp/converact-unused-output'
  ], { cwd: process.cwd(), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  (error: unknown) => String((error as { stderr?: unknown }).stderr || '').trim()
    === 'converact_upload_dir_invalid');
});

test('drain evidence requires observed processes, exact phases, signed zeros and rolling decisions', () => {
  const activeZeroReceipts = [
    'platform_worker_leases',
    'domain_event_inflight',
    'communication_attached_generations',
    'recording_attached_generations',
    'ai_attached_generations',
    'unobserved_effect_receipts',
    'billing_projection_conflicts'
  ].map((authority, index) => ({
    authority,
    key_id: `drain-${authority}-key-v1`,
    receipt_revision: 2,
    active_count: '0',
    body_sha256: String(index + 1).repeat(64).slice(0, 64),
    signature_sha256: String(index + 2).repeat(64).slice(0, 64)
  }));
  const validInput = {
    identity,
    status: 'passed',
    duration_ms: 1_200,
    clock_domain: 'monotonic',
    orchestrator_pid: 300,
    drain_node_pid: 301,
    lost_node_pid: 302,
    recovery_node_pid: 303,
    fresh_verifier_pid: 304,
    drain_node_exit_code: 0,
    drain_node_exit_signal: null,
    lost_node_exit_code: null,
    lost_node_exit_signal: 'SIGKILL',
    recovery_node_exit_code: 0,
    recovery_node_exit_signal: null,
    fresh_verifier_exit_code: 0,
    fresh_verifier_exit_signal: null,
    phase_sequence: [
      'accepting', 'route_draining', 'worker_draining', 'authority_draining',
      'active_zero_verified', 'quiesced', 'stopped'
    ],
    drain_rejection_code: 'component_node_draining',
    established_mutations_before_drain: 1,
    established_mutations_during_drain: 1,
    established_close_state: 'closed',
    active_zero_receipts: activeZeroReceipts,
    receipts_manifest_sha256: '8'.repeat(64),
    fresh_receipt_verification_count: 7,
    fresh_receipt_verified_phase: 'active_zero_verified',
    initial_owner_node_id: 'node-a',
    post_loss_owner_node_id: 'node-b',
    initial_owner_epoch: '4294967297',
    post_loss_owner_epoch: '4294967298',
    stale_owner_error_code: 'stale_owner_epoch',
    post_loss_new_work_state: 'active',
    rolling_schema: {
      n_plus_1_reads_n: 'accepted',
      additive_minor: 'accepted',
      unknown_major: 'quarantined:unsupported_schema_version',
      duplicate: 'replay',
      stale: 'stale',
      gap: 'gap_requires_reconcile',
      distinct_ordering_key: 'insert'
    },
    unrelated_containers_before_sha256: '9'.repeat(64),
    unrelated_containers_after_sha256: '9'.repeat(64),
    container_actions: 0,
    validation_processes_remaining: 0
  };
  const result = buildDrainEvidence(boundDrainEvidenceFixture(validInput));
  assert.equal(result.status, 'verified_controlled');
  assert.equal(result.production_eligible, false);

  assert.equal(buildDrainEvidence(validInput).status, 'failed');

  const booleanOnly = {
    identity,
    process_a_pid: 301,
    process_b_pid: 302,
    initial_owner_node_id: 'node-a',
    post_drain_owner_node_id: 'node-b',
    drain_rejected_new_work: true,
    established_work_survived_drain: true,
    active_zero_observed: true,
    offline_after_active_zero: true,
    process_loss_observed: true,
    stale_owner_rejected: true,
    n_minus_1_schema_accepted: true,
    duplicate_replayed: true,
    unrelated_containers_unchanged: true,
    validation_processes_remaining: 0
  };
  assert.equal(buildDrainEvidence(booleanOnly).status, 'failed');

  assert.equal(buildDrainEvidence(forgedDrainSignatureFixture(validInput)).status, 'failed');
  assert.equal(buildDrainEvidence(extraDrainResultFieldFixture(validInput)).status, 'failed');
  assert.equal(buildDrainEvidence(boundDrainEvidenceFixture({
    ...validInput,
    phase_sequence: ['accepting', 'route_draining', 'stopped']
  })).status, 'failed');
  assert.equal(buildDrainEvidence(boundDrainEvidenceFixture({
    ...validInput,
    lost_node_exit_signal: 'SIGTERM'
  })).status, 'failed');
  assert.equal(buildDrainEvidence(boundDrainEvidenceFixture({
    ...validInput,
    fresh_verifier_pid: 303
  })).status, 'failed');
});

function boundDrainEvidenceFixture(summaryInput: Record<string, any>) {
  const drainId = 'drain-unit-evidence';
  const nodeId = 'node-drain';
  const ownerEpoch = '4294967297';
  const authorityKeyIds = {} as Record<PlatformDrainAuthority, string>;
  const publicKeys: Record<string, string> = {};
  const privateKeys = new Map<PlatformDrainAuthority, ReturnType<typeof generateKeyPairSync>['privateKey']>();
  for (const authority of PLATFORM_DRAIN_AUTHORITIES) {
    const pair = generateKeyPairSync('ed25519');
    const keyId = `drain-${authority}-key-v1`;
    authorityKeyIds[authority] = keyId;
    publicKeys[keyId] = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    privateKeys.set(authority, pair.privateKey);
  }
  const signed = (revision: number, final: boolean) => PLATFORM_DRAIN_AUTHORITIES.map((authority) =>
    signPlatformDrainReceipt({
      key_id: authorityKeyIds[authority],
      private_key: privateKeys.get(authority)!,
      body: {
        schema_version: '1.0.0',
        drain_id: drainId,
        node_id: nodeId,
        owner_epoch: ownerEpoch,
        authority,
        receipt_revision: revision,
        active_count: !final && authority === 'communication_attached_generations' ? '1' : '0',
        active_id_digest: sha256(`${authority}:${revision}`),
        observed_at: final ? '2026-08-01T16:00:02.000Z' : '2026-08-01T16:00:01.000Z',
        expires_at: '2026-08-01T16:02:00.000Z'
      }
    }));
  const transitions = {
    initial_receipts: signed(1, false),
    active_zero_receipts: signed(2, true)
  };
  const summarize = (receipts: typeof transitions.active_zero_receipts) => receipts.map((receipt) => ({
    authority: receipt.body.authority,
    key_id: receipt.key_id,
    receipt_revision: receipt.body.receipt_revision,
    active_count: receipt.body.active_count,
    body_sha256: sha256(JSON.stringify(receipt.body)),
    signature_sha256: sha256(receipt.signature)
  }));
  const containerSnapshot = 'stopped-container-snapshot\n';
  const { identity: _ignoredIdentity, ...summary } = summaryInput;
  const result = {
    ...summary,
    drain_id: drainId,
    drain_node_id: nodeId,
    drain_owner_epoch: ownerEpoch,
    initial_nonzero_receipts: summarize(transitions.initial_receipts),
    active_zero_receipts: summarize(transitions.active_zero_receipts),
    receipts_manifest_sha256: sha256(JSON.stringify(transitions)),
    unrelated_containers_before_sha256: sha256(containerSnapshot),
    unrelated_containers_after_sha256: sha256(containerSnapshot)
  };
  const rawArtifacts: Record<string, string> = {
    'drain-public-keys.json': prettyJson({
      drain_id: drainId,
      node_id: nodeId,
      owner_epoch: ownerEpoch,
      authority_key_ids: authorityKeyIds,
      public_keys: publicKeys
    }),
    'drain-receipts.json': prettyJson(transitions),
    'drain-result.json': prettyJson(result),
    'drain-run.log': `${JSON.stringify(result)}\n`,
    'unrelated-containers-after.tsv': containerSnapshot,
    'unrelated-containers-before.tsv': containerSnapshot
  };
  const rawManifest = Object.keys(rawArtifacts).sort().map(
    (name) => `${sha256(rawArtifacts[name]!)}  ${name}\n`
  ).join('');
  return {
    identity: { ...identity, raw_output_sha256: sha256(rawManifest) },
    raw_manifest: rawManifest,
    raw_artifacts: rawArtifacts
  };
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function forgedDrainSignatureFixture(summaryInput: Record<string, any>) {
  const bound = boundDrainEvidenceFixture(summaryInput);
  const transitions = JSON.parse(bound.raw_artifacts['drain-receipts.json']!);
  const result = JSON.parse(bound.raw_artifacts['drain-result.json']!);
  transitions.active_zero_receipts[0].signature = 'A'.repeat(86);
  result.active_zero_receipts[0].signature_sha256 = sha256('A'.repeat(86));
  result.receipts_manifest_sha256 = sha256(JSON.stringify(transitions));
  bound.raw_artifacts['drain-receipts.json'] = prettyJson(transitions);
  bound.raw_artifacts['drain-result.json'] = prettyJson(result);
  bound.raw_artifacts['drain-run.log'] = `${JSON.stringify(result)}\n`;
  bound.raw_manifest = Object.keys(bound.raw_artifacts).sort().map(
    (name) => `${sha256(bound.raw_artifacts[name]!)}  ${name}\n`
  ).join('');
  bound.identity.raw_output_sha256 = sha256(bound.raw_manifest);
  return bound;
}

function extraDrainResultFieldFixture(summaryInput: Record<string, any>) {
  const bound = boundDrainEvidenceFixture(summaryInput);
  const result = JSON.parse(bound.raw_artifacts['drain-result.json']!);
  result.real_human_media = true;
  bound.raw_artifacts['drain-result.json'] = prettyJson(result);
  bound.raw_artifacts['drain-run.log'] = `${JSON.stringify(result)}\n`;
  bound.raw_manifest = Object.keys(bound.raw_artifacts).sort().map(
    (name) => `${sha256(bound.raw_artifacts[name]!)}  ${name}\n`
  ).join('');
  bound.identity.raw_output_sha256 = sha256(bound.raw_manifest);
  return bound;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('drain probe uses production admission/event/drain code and actual child loss', async () => {
  const { runDrainCampaign } = await import(
    '../services/converact-service/acceptance/platform-fault-matrix/drain-probe.js'
  );
  const campaign = await runDrainCampaign({ run_id: 'unit-drain' });
  const result = campaign.result;
  assert.equal(result.status, 'passed');
  assert.equal(result.lost_node_exit_signal, 'SIGKILL');
  assert.equal(result.drain_rejection_code, 'component_node_draining');
  assert.equal(result.stale_owner_error_code, 'stale_owner_epoch');
  assert.deepEqual(result.phase_sequence, [
    'accepting', 'route_draining', 'worker_draining', 'authority_draining',
    'active_zero_verified', 'quiesced', 'stopped'
  ]);
  assert.equal(result.active_zero_receipts.length, 7);
  assert.equal(result.active_zero_receipts.every((entry: any) => entry.active_count === '0'), true);
  assert.equal(result.initial_nonzero_receipts.length, 7);
  assert.equal(result.initial_nonzero_receipts.find(
    (entry: any) => entry.authority === 'communication_attached_generations'
  )?.active_count, '1');
  assert.equal(campaign.receipt_transitions.initial_receipts.length, 7);
  assert.equal(campaign.receipt_transitions.active_zero_receipts.length, 7);
  assert.equal(result.fresh_receipt_verification_count, 7);
  assert.equal(new Set([
    result.orchestrator_pid,
    result.drain_node_pid,
    result.lost_node_pid,
    result.recovery_node_pid,
    result.fresh_verifier_pid
  ]).size, 5);
  assert.equal(result.validation_processes_remaining, 0);
});

test('drain runner is exact-source read-only to containers and retains bounded evidence', () => {
  const script = readFileSync(new URL('drain-accept.sh', acceptanceRoot), 'utf8');
  const probe = readFileSync(new URL('drain-probe.ts', acceptanceRoot), 'utf8');
  const node = readFileSync(new URL('drain-node.ts', acceptanceRoot), 'utf8');
  assert.match(script, /G02_PLATFORM_DRAIN_EVIDENCE/);
  assert.match(script, /git -C "\$ROOT_DIR" rev-parse HEAD/);
  assert.match(script, /git -C "\$ROOT_DIR" status --porcelain/);
  assert.match(script, /requires Node v24/);
  assert.match(script, /snapshot_containers/);
  assert.match(script, /cmp -s "\$BEFORE_CONTAINERS" "\$AFTER_CONTAINERS"/);
  assert.match(script, /docker ps -q/);
  assert.match(script, /evidence-secret-scan\.mjs/);
  assert.match(script, /drain-receipts\.json/);
  assert.doesNotMatch(script, /printf \\"/);
  assert.doesNotMatch(script, /docker (?:compose\s+)?(?:up|start|stop|kill|rm|down)|docker system prune/);
  assert.match(probe, /fork\(/);
  assert.match(probe, /SIGKILL/);
  assert.match(probe, /CellAdmissionController/);
  assert.match(probe, /decodePlatformEvent/);
  assert.match(probe, /decideInboxWrite/);
  assert.match(probe, /PlatformDrainCoordinator/);
  assert.match(probe, /raw_manifest/);
  assert.match(probe, /raw_artifacts/);
  assert.match(node, /ComponentNodeAdmissionController/);
  assert.match(node, /signPlatformDrainReceipt/);
});

test('capacity evidence requires observed hard bounds for active pending retry and fanout', () => {
  const result = buildBoundedCapacityEvidence({
    identity,
    status: 'passed',
    operations: 200_000,
    duration_ms: 2_000,
    accepted: 120_000,
    overloaded: 80_000,
    rejected_overloaded: 60_000,
    rejected_retry_exhausted: 10_000,
    rejected_fanout_exceeded: 10_000,
    configured_active_limit: 64,
    configured_pending_limit: 256,
    configured_retry_limit: 3,
    configured_fanout_limit: 8,
    observed_max_active: 64,
    observed_max_pending: 256,
    observed_max_retry: 3,
    observed_max_fanout: 8,
    attempted_max_retry: 4,
    attempted_max_fanout: 9,
    configured_retained_lease_limit: 320,
    observed_max_retained_leases: 320,
    queued_requests_at_completion: 0,
    policy_rejections_preserved_admission_counters: true,
    p99_operation_us: 80,
    event_loop_delay_p99_ms: 12,
    rss_start_bytes: 80_000_000,
    rss_peak_bytes: 96_000_000,
    rss_end_bytes: 88_000_000,
    counter_integrity: true,
    no_unbounded_queue: true
  });
  assert.equal(result.status, 'verified_controlled');
  assert.equal(result.production_eligible, false);

  assert.equal(buildBoundedCapacityEvidence({
    identity,
    status: 'passed',
    operations: 200_000,
    duration_ms: 2_000,
    accepted: 120_000,
    overloaded: 80_000,
    rejected_overloaded: 60_000,
    rejected_retry_exhausted: 10_000,
    rejected_fanout_exceeded: 10_000,
    configured_active_limit: 64,
    configured_pending_limit: 256,
    configured_retry_limit: 3,
    configured_fanout_limit: 8,
    observed_max_active: 65,
    observed_max_pending: 256,
    observed_max_retry: 3,
    observed_max_fanout: 8,
    attempted_max_retry: 4,
    attempted_max_fanout: 9,
    configured_retained_lease_limit: 320,
    observed_max_retained_leases: 320,
    queued_requests_at_completion: 0,
    policy_rejections_preserved_admission_counters: true,
    p99_operation_us: 80,
    event_loop_delay_p99_ms: 12,
    rss_start_bytes: 80_000_000,
    rss_peak_bytes: 96_000_000,
    rss_end_bytes: 88_000_000,
    counter_integrity: true,
    no_unbounded_queue: true
  }).status, 'failed');

  assert.equal(buildBoundedCapacityEvidence({
    identity,
    status: 'failed',
    operations: 200_000,
    duration_ms: 2_000,
    accepted: 120_000,
    overloaded: 80_000,
    rejected_overloaded: 60_000,
    rejected_retry_exhausted: 10_000,
    rejected_fanout_exceeded: 10_000,
    configured_active_limit: 64,
    configured_pending_limit: 256,
    configured_retry_limit: 3,
    configured_fanout_limit: 8,
    observed_max_active: 64,
    observed_max_pending: 256,
    observed_max_retry: 3,
    observed_max_fanout: 8,
    attempted_max_retry: 4,
    attempted_max_fanout: 9,
    configured_retained_lease_limit: 320,
    observed_max_retained_leases: 320,
    queued_requests_at_completion: 0,
    policy_rejections_preserved_admission_counters: true,
    p99_operation_us: 80,
    event_loop_delay_p99_ms: 12,
    rss_start_bytes: 80_000_000,
    rss_peak_bytes: 96_000_000,
    rss_end_bytes: 88_000_000,
    counter_integrity: true,
    no_unbounded_queue: true
  }).status, 'failed');
});

test('capacity probe executes overload against the production bounded work gate', async () => {
  const result = await runBoundedCapacityWorkload({ operations: 20_000 });
  assert.equal(result.status, 'passed');
  assert.equal(result.operations, 20_000);
  assert.equal(result.accepted + result.overloaded, result.operations);
  assert.equal(result.configured_active_limit, 64);
  assert.equal(result.observed_max_active, result.configured_active_limit);
  assert.equal(result.observed_max_pending, result.configured_pending_limit);
  assert.equal(result.observed_max_retry, result.configured_retry_limit);
  assert.equal(result.observed_max_fanout, result.configured_fanout_limit);
  assert.equal(result.attempted_max_retry, result.configured_retry_limit + 1);
  assert.equal(result.attempted_max_fanout, result.configured_fanout_limit + 1);
  assert.ok(result.rejected_overloaded > 0);
  assert.ok(result.rejected_retry_exhausted > 0);
  assert.ok(result.rejected_fanout_exceeded > 0);
  assert.equal(result.configured_retained_lease_limit, 320);
  assert.equal(result.observed_max_retained_leases, result.configured_retained_lease_limit);
  assert.equal(result.queued_requests_at_completion, 0);
  assert.equal(result.policy_rejections_preserved_admission_counters, true);
  assert.equal(
    result.overloaded,
    result.rejected_overloaded
      + result.rejected_retry_exhausted
      + result.rejected_fanout_exceeded
  );
  assert.equal(result.counter_integrity, true);
  assert.equal(result.no_unbounded_queue, true);
  assert.ok(result.p99_operation_us > 0);
});

test('capacity runner is exact-source bounded and cannot alter unrelated containers', () => {
  const script = readFileSync(new URL('control-accept.sh', acceptanceRoot), 'utf8');
  assert.match(script, /G02_PLATFORM_CONTROL_EVIDENCE/);
  assert.match(script, /git -C "\$ROOT_DIR" rev-parse HEAD/);
  assert.match(script, /git -C "\$ROOT_DIR" status --porcelain/);
  assert.match(script, /NODE_VERSION.*v24/);
  assert.match(script, /CONVERACT_G02_CAPACITY_OPERATIONS/);
  assert.match(script, /capacity-probe\.ts.*run/s);
  assert.match(script, /capacity-probe\.ts.*finalize/s);
  assert.match(script, /evidence-secret-scan\.mjs/);
  assert.match(script, /unrelated-containers-before\.tsv/);
  assert.match(script, /unrelated-containers-after\.tsv/);
  assert.doesNotMatch(script, /docker (?:system )?prune|docker (?:stop|rm) /);
  assert.doesNotMatch(script, /awk '[^']*\\"/);
  assert.match(script, /production_eligible.*false/is);
});
