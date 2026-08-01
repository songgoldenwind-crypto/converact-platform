import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  evaluateControlledFaultScenario,
  faultScenarioCatalog,
  summarizeFaultCampaign
} from '../services/converact-service/acceptance/platform-fault-matrix/evidence-contract.mjs';

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
  image_digests: ['postgres@sha256:' + 'd'.repeat(64)],
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
