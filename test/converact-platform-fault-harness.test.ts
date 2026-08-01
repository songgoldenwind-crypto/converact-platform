import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  evaluateControlledFaultScenario,
  faultScenarioCatalog,
  summarizeFaultCampaign
} from '../services/converact-service/acceptance/platform-fault-matrix/evidence-contract.mjs';
import {
  buildDatabaseEvidence
} from '../services/converact-service/acceptance/platform-fault-matrix/database-probe.js';

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
});

test('acceptance entrypoints are project-scoped digest-pinned and explicit about non-claims', () => {
  const script = readFileSync(new URL('accept.sh', acceptanceRoot), 'utf8');
  const compose = readFileSync(new URL('docker-compose.yml', acceptanceRoot), 'utf8');
  const readme = readFileSync(new URL('README.md', acceptanceRoot), 'utf8');

  assert.match(script, /G02_PLATFORM_FAULT_MATRIX/);
  assert.match(script, /docker compose --project-name/);
  assert.doesNotMatch(script, /docker (?:system )?prune|docker stop \$\(docker ps/);
  assert.match(compose, /\?POSTGRES_IMAGE immutable digest reference is required/);
  assert.match(compose, /127\.0\.0\.1:/);
  assert.match(readme, /synthetic.*not.*real.*human media/is);
  assert.match(readme, /production[_ -]eligible.*false/is);
  assert.match(readme, /not_run/);
});

test('database evidence requires actual RLS restart recovery and synthetic continuity facts', () => {
  const result = buildDatabaseEvidence({
    identity,
    prepare: {
      status: 'passed', process_pid: 101, migration_head: '111_converact_platform_key_lifecycle',
      tenant_a_visible: 1, tenant_b_visible_from_a: 0, no_context_visible: 0,
      cross_tenant_insert_denied: true, inbox_inserted: true,
      accepted_receipt_inserted: true, usage_inserted: true
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
      accepted_receipt_replayed: true, completed_receipt_inserted: true,
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
      status: 'passed', process_pid: 101, migration_head: '111_converact_platform_key_lifecycle',
      tenant_a_visible: 1, tenant_b_visible_from_a: 0, no_context_visible: 0,
      cross_tenant_insert_denied: true, inbox_inserted: true,
      accepted_receipt_inserted: true, usage_inserted: true
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
      accepted_receipt_replayed: true, completed_receipt_inserted: true,
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
