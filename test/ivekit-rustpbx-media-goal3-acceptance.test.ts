import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  GOAL3_ACCEPTANCE_CHECKS,
  buildRustPbxMediaGoal3Acceptance,
  type RustPbxMediaGoal3AcceptanceInput
} from '../scripts/ivekit-rustpbx-media-goal3-acceptance.js';

const contract = JSON.parse(readFileSync(
  'docs/capacity/contracts/voice-media-goal3-v1.json',
  'utf8'
)) as Record<string, any>;

test('Goal 3 acceptance derives profile-scoped functional evidence without capacity claims', () => {
  const evidence = buildRustPbxMediaGoal3Acceptance(validInput(), contract);

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.identity_status, 'passed');
  assert.equal(evidence.profiles.ordinary, 'passed');
  assert.equal(evidence.profiles.t1, 'passed');
  assert.equal(evidence.capacity_claim, 'none');
  assert.deepEqual(evidence.not_run, [
    'capacity',
    'kernel_forwarding',
    'transcoding'
  ]);
  assert.equal(evidence.environment.led_services_unchanged, true);
});

test('Goal 3 acceptance retains an invalid mixed identity but cannot promote it', () => {
  const input = validInput();
  input.source_identity.rustpbx_commit = 'b'.repeat(40);

  const evidence = buildRustPbxMediaGoal3Acceptance(input, contract);

  assert.equal(evidence.status, 'invalid_identity');
  assert.equal(evidence.identity_status, 'failed');
  assert.equal(evidence.profiles.ordinary, 'not_run');
  assert.equal(evidence.profiles.t1, 'not_run');
  assert.deepEqual(evidence.identity_errors, ['rustpbx_commit_mismatch']);
});

test('Goal 3 acceptance reports ordinary and T1 independently when T1 is not run', () => {
  const input = validInput();
  for (const id of [
    't1_shadow_quorum_fail_closed',
    't1_owner_takeover_under_5000ms'
  ] as const) {
    input.checks[id] = {
      status: 'not_run',
      evidence_sha256: digest(id),
      duration_ms: 0,
      measurements: {},
      reason: 'single_zone_server'
    };
  }

  const evidence = buildRustPbxMediaGoal3Acceptance(input, contract);

  assert.equal(evidence.status, 'incomplete');
  assert.equal(evidence.profiles.ordinary, 'passed');
  assert.equal(evidence.profiles.t1, 'not_run');
  assert.ok(evidence.not_run.includes('t1_owner_takeover_under_5000ms'));
  assert.ok(evidence.not_run.includes('t1_shadow_quorum_fail_closed'));
});

test('Goal 3 acceptance rejects secret-bearing or raw unbounded observations', () => {
  const secretInput = validInput();
  secretInput.checks.tracing_continuity.measurements = {
    authorization: 'Bearer exposed-secret-value'
  };
  assert.throws(
    () => buildRustPbxMediaGoal3Acceptance(secretInput, contract),
    /secret material/i
  );

  const rawLogInput = validInput();
  rawLogInput.checks.tracing_continuity.measurements = {
    raw_log: 'x'.repeat(1_100_000)
  };
  assert.throws(
    () => buildRustPbxMediaGoal3Acceptance(rawLogInput, contract),
    /bounded|1 MiB/i
  );
});

test('Goal 3 acceptance CLI is exposed through the root package', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['ivekit:rustpbx-media-goal3:acceptance'],
    'node --import tsx scripts/ivekit-rustpbx-media-goal3-acceptance.ts'
  );
});

function validInput(): RustPbxMediaGoal3AcceptanceInput {
  const checks = Object.fromEntries(GOAL3_ACCEPTANCE_CHECKS.map(({ id }) => [
    id,
    {
      status: 'passed',
      evidence_sha256: digest(id),
      duration_ms: id === 't1_owner_takeover_under_5000ms' ? 1_250 : 100,
      measurements: id === 't1_owner_takeover_under_5000ms'
        ? { takeover_rto_ms: 1_250 }
        : id === 'orphan_cleanup_under_60000ms'
          ? { orphan_cleanup_ms: 15_000 }
        : {}
    }
  ])) as RustPbxMediaGoal3AcceptanceInput['checks'];
  return {
    schema_version: '1.0.0',
    attempt_id: 'goal3-server-attempt-1',
    started_at: '2026-07-27T12:00:00.000Z',
    finished_at: '2026-07-27T12:10:00.000Z',
    source_identity: {
      opc_commit: '62c779501313e83331e0e41d2b9862feb76911a3',
      rustpbx_commit: '6c49ee76baa54fdbf8f98020cc9bee158c7c15de',
      rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
      rustrtc_commit: '166c6d22984429eb6b509920c14fcd69f974f0b3',
      rtpengine_commit: '506cfa74386a5373e40fca139a932917f22f0524',
      rustpbx_patch_ids: [...contract.required_patch_ids],
      rustpbx_patch_set_sha256: '1'.repeat(64),
      rtpengine_patch_set_sha256: '2'.repeat(64),
      rustpbx_image_digest: `sha256:${'3'.repeat(64)}`,
      rtpengine_image_digest: `sha256:${'4'.repeat(64)}`,
      runtime_config_sha256: '5'.repeat(64),
      host_kernel: 'Linux 6.8.0-124-generic x86_64'
    },
    environment: {
      environment_class: 'real_server',
      project_name: 'ivekit-goal3-62c7795',
      led_container_fingerprint_before: '6'.repeat(64),
      led_container_fingerprint_after: '6'.repeat(64)
    },
    checks,
    optional_capabilities: {
      kernel_forwarding: {
        status: 'not_run',
        evidence_sha256: digest('kernel_forwarding'),
        reason: 'userspace_runtime'
      },
      recording: {
        status: 'passed',
        evidence_sha256: digest('recording')
      },
      transcoding: {
        status: 'not_run',
        evidence_sha256: digest('transcoding'),
        reason: 'transcoding_provider_not_installed'
      },
      capacity: {
        status: 'not_run',
        evidence_sha256: digest('capacity'),
        reason: 'functional_acceptance_only'
      }
    }
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
