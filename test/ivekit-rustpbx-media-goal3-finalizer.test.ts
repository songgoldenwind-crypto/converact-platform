import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildRustPbxMediaGoal3FinalEvidence,
  type RustPbxMediaGoal3FinalizerInput
} from '../scripts/ivekit-rustpbx-media-goal3-finalize.js';
import type {
  RustPbxMediaGoal3AcceptanceEvidence
} from '../scripts/ivekit-rustpbx-media-goal3-acceptance.js';

test('Goal 3 finalizer derives functional pass without inventing capacity', () => {
  const input = finalizerInput([acceptance('attempt-1', 1_250)]);

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'functional_pass');
  assert.equal(evidence.capacity_claim, 'none');
  assert.equal(evidence.acceptance.accepted_attempts, 1);
  assert.equal(evidence.t1_takeover.repetitions, 1);
  assert.ok(evidence.blocking_reasons.includes('t1-repeat-count-below-3'));
  assert.ok(evidence.blocking_reasons.includes('production-gates-incomplete'));
});

test('Goal 3 finalizer requires three exact T1 repetitions for production', () => {
  const input = finalizerInput([
    acceptance('attempt-1', 1_000),
    acceptance('attempt-2', 1_500),
    acceptance('attempt-3', 2_000)
  ]);
  passProduction(input);

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'production_pass');
  assert.deepEqual(evidence.t1_takeover, {
    repetitions: 3,
    p50_ms: 1_500,
    p95_ms: 2_000,
    p99_ms: 2_000,
    target_ms: 5_000,
    status: 'passed'
  });
  assert.equal(evidence.capacity_claim, 'none');
});

test('Goal 3 finalizer retains mixed identity attempts without promotion', () => {
  const invalid = acceptance('attempt-invalid', 900);
  invalid.source_identity.opc_commit = 'b'.repeat(40);
  invalid.identity_status = 'failed';
  invalid.status = 'invalid_identity';
  invalid.identity_errors = ['opc_commit_mismatch'];
  const input = finalizerInput([invalid]);

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'implemented');
  assert.equal(evidence.acceptance.accepted_attempts, 0);
  assert.equal(
    evidence.acceptance.attempts[0].disposition,
    'retained_identity_mismatch'
  );
});

test('Goal 3 finalizer compares source identity semantically', () => {
  const input = finalizerInput([acceptance('attempt-reordered', 1_000)]);
  input.acceptance_attempts[0].source_identity = Object.fromEntries(
    Object.entries(input.acceptance_attempts[0].source_identity).reverse()
  ) as unknown as RustPbxMediaGoal3AcceptanceEvidence['source_identity'];

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'functional_pass');
  assert.equal(evidence.acceptance.accepted_attempts, 1);
});

test('Goal 3 finalizer does not promote mismatched supply-chain identity', () => {
  const input = finalizerInput([
    acceptance('attempt-1', 1_000),
    acceptance('attempt-2', 1_200),
    acceptance('attempt-3', 1_400)
  ]);
  passProduction(input);
  input.supply_chain.source_identity.rustpbx_image_digest =
    `sha256:${'9'.repeat(64)}`;

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'functional_pass');
  assert.equal(evidence.supply_chain.identity_status, 'failed');
  assert.ok(evidence.blocking_reasons.includes('supply-chain-identity-mismatch'));
});

test('Goal 3 finalizer does not promote mismatched production-gate identity', () => {
  const input = finalizerInput([
    acceptance('attempt-1', 1_000),
    acceptance('attempt-2', 1_200),
    acceptance('attempt-3', 1_400)
  ]);
  passProduction(input);
  input.production_gates.dual_zone.runtime_config_sha256 = '9'.repeat(64);

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'functional_pass');
  assert.equal(evidence.production_gate_identity_status, 'failed');
  assert.ok(evidence.blocking_reasons.includes('production-gate-identity-mismatch'));
});

test('Goal 3 finalizer promotes capacity only from an exact production campaign', () => {
  const input = finalizerInput([
    acceptance('attempt-1', 1_000),
    acceptance('attempt-2', 1_200),
    acceptance('attempt-3', 1_400)
  ]);
  passProduction(input);
  input.capacity_campaign = {
    status: 'passed',
    evidence_sha256: digest('capacity'),
    opc_commit: input.source_identity.opc_commit,
    rustpbx_image_digest: input.source_identity.rustpbx_image_digest,
    rtpengine_image_digest: input.source_identity.rtpengine_image_digest,
    runtime_config_sha256: input.source_identity.runtime_config_sha256,
    claim: 'single_node_measured',
    measurements: {
      max_concurrent_calls: 2_500,
      steady_cps: 100,
      p99_setup_ms: 220
    }
  };

  const evidence = buildRustPbxMediaGoal3FinalEvidence(input);

  assert.equal(evidence.status, 'capacity_pass');
  assert.equal(evidence.capacity_claim, 'single_node_measured');
});

test('Goal 3 finalizer requires actionable unexpired vulnerability exceptions', () => {
  const input = finalizerInput([acceptance('attempt-1', 1_000)]);
  input.supply_chain.critical_vulnerabilities = [{
    vulnerability_id: 'CVE-2026-12345',
    exception: {
      owner: '',
      reason: 'upstream_fix_pending',
      expires_at: '2026-08-30T00:00:00.000Z',
      remediation_status: 'in_progress'
    }
  }];

  assert.throws(
    () => buildRustPbxMediaGoal3FinalEvidence(input),
    /vulnerability exception/i
  );
});

test('Goal 3 finalizer CLI is exposed through the root package', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['ivekit:rustpbx-media-goal3:finalize'],
    'node --import tsx scripts/ivekit-rustpbx-media-goal3-finalize.ts'
  );
});

function finalizerInput(
  attempts: RustPbxMediaGoal3AcceptanceEvidence[]
): RustPbxMediaGoal3FinalizerInput {
  const sourceIdentity = structuredClone(attempts[0]?.source_identity ??
    acceptance('identity', 1_000).source_identity);
  return {
    schema_version: '1.0.0',
    generated_at: '2026-07-27T14:00:00.000Z',
    source_identity: sourceIdentity,
    acceptance_attempts: attempts,
    regressions: Object.fromEntries([
      'goal0',
      'goal1',
      'goal2',
      'kamailio',
      'rustpbx',
      'cdr',
      'recording_isolation',
      'package_typecheck'
    ].map((id) => [id, {
      status: 'passed',
      evidence_sha256: digest(id),
      opc_commit: sourceIdentity.opc_commit
    }])) as RustPbxMediaGoal3FinalizerInput['regressions'],
    supply_chain: {
      generated_at: '2026-07-27T13:50:00.000Z',
      source_identity: {
        opc_commit: sourceIdentity.opc_commit,
        rustpbx_image_digest: sourceIdentity.rustpbx_image_digest,
        rtpengine_image_digest: sourceIdentity.rtpengine_image_digest
      },
      artifacts: {
        cyclonedx: artifact('cyclonedx'),
        spdx: artifact('spdx'),
        trivy: artifact('trivy'),
        secret_scan: artifact('secret_scan'),
        provenance: artifact('provenance'),
        signature: artifact('signature')
      },
      secret_finding_count: 0,
      critical_vulnerabilities: []
    },
    production_gates: {
      dual_zone: productionStatus(sourceIdentity, 'not_run', 'single_zone_server'),
      production_mtls: productionStatus(sourceIdentity, 'passed'),
      three_node_nats: productionStatus(sourceIdentity, 'not_run', 'single_node_server'),
      production_postgres: productionStatus(sourceIdentity, 'not_run', 'single_node_server'),
      production_object_storage: productionStatus(sourceIdentity, 'not_run', 'test_object_storage'),
      complete_failure_matrix: productionStatus(sourceIdentity, 'not_run', 'failure_matrix_pending')
    },
    capacity_campaign: {
      status: 'not_run',
      evidence_sha256: digest('capacity-not-run'),
      reason: 'functional_acceptance_only'
    }
  };
}

function passProduction(input: RustPbxMediaGoal3FinalizerInput): void {
  for (const key of Object.keys(input.production_gates) as
    Array<keyof typeof input.production_gates>) {
    input.production_gates[key] = productionStatus(
      input.source_identity,
      'passed'
    );
  }
}

function acceptance(
  attemptId: string,
  takeoverRtoMs: number
): RustPbxMediaGoal3AcceptanceEvidence {
  const checks = Object.fromEntries([
    'deployment_readiness',
    'invite_183_prack_200_ack_bye',
    'cancel_before_offer',
    'cancel_after_offer',
    'cancel_200_race',
    'update_reinvite_hold_resume',
    'dtmf_session_timer',
    'rtp_rtcp_bidirectional',
    'sdes_srtp_bidirectional',
    'effective_sdp_sequence_continuity',
    'rustpbx_owner_outage_media_continuity',
    'media_control_outage_media_continuity',
    'media_control_unknown_reconcile',
    'rtpengine_outage_classified',
    'recorder_outage_isolation',
    'object_storage_outage_isolation',
    'postgres_outage_contract',
    'nats_outage_ordinary_continuity',
    't1_shadow_quorum_fail_closed',
    't1_owner_takeover_under_5000ms',
    'orphan_cleanup_under_60000ms',
    'rolling_rollback_media_continuity',
    'dual_leg_cdr_convergence',
    'tracing_continuity',
    'led_services_unchanged'
  ].map((id) => [id, {
    status: 'passed',
    evidence_sha256: digest(`${attemptId}-${id}`),
    duration_ms: id === 't1_owner_takeover_under_5000ms'
      ? takeoverRtoMs
      : 100,
    measurements: id === 't1_owner_takeover_under_5000ms'
      ? { takeover_rto_ms: takeoverRtoMs }
      : id === 'orphan_cleanup_under_60000ms'
        ? { orphan_cleanup_ms: 15_000 }
        : {}
  }])) as RustPbxMediaGoal3AcceptanceEvidence['checks'];
  return {
    schema_version: '1.0.0',
    evidence_type: 'rustpbx_media_goal3_acceptance',
    attempt_id: attemptId,
    status: 'passed',
    identity_status: 'passed',
    identity_errors: [],
    started_at: '2026-07-27T12:00:00.000Z',
    finished_at: '2026-07-27T12:10:00.000Z',
    generated_at: '2026-07-27T12:10:00.000Z',
    source_identity: {
      opc_commit: 'a'.repeat(40),
      rustpbx_commit: '6c49ee76baa54fdbf8f98020cc9bee158c7c15de',
      rsipstack_commit: '8318e97b1170de4e5245b120afec1cdf53e3d716',
      rustrtc_commit: '166c6d22984429eb6b509920c14fcd69f974f0b3',
      rtpengine_commit: '506cfa74386a5373e40fca139a932917f22f0524',
      rustpbx_patch_ids: [
        'rustpbx-ivekit-media-control-client-v1',
        'rustpbx-ivekit-media-lifecycle-v1',
        'rustpbx-ivekit-dialog-shadow-v1',
        'rustpbx-ivekit-dialog-recovery-v1',
        'rustpbx-ivekit-dual-leg-cdr-v1'
      ],
      rustpbx_patch_set_sha256: '1'.repeat(64),
      rtpengine_patch_set_sha256: '2'.repeat(64),
      rustpbx_image_digest: `sha256:${'3'.repeat(64)}`,
      rtpengine_image_digest: `sha256:${'4'.repeat(64)}`,
      runtime_config_sha256: '5'.repeat(64),
      host_kernel: 'Linux 6.8.0-124-generic x86_64'
    },
    environment: {
      environment_class: 'real_server',
      project_name: 'ivekit-goal3-finalizer',
      led_container_fingerprint_before: '6'.repeat(64),
      led_container_fingerprint_after: '6'.repeat(64),
      led_services_unchanged: true
    },
    profiles: { ordinary: 'passed', t1: 'passed' },
    checks,
    optional_capabilities: {
      kernel_forwarding: status('not_run', 'userspace_runtime'),
      recording: status('passed'),
      transcoding: status('not_run', 'transcoding_not_run'),
      capacity: status('not_run', 'functional_acceptance_only')
    },
    not_run: [
      'capacity',
      'kernel_forwarding',
      'transcoding'
    ],
    capacity_claim: 'none',
    raw_input_sha256: digest(`${attemptId}-raw`)
  };
}

function status(
  value: 'passed' | 'not_run',
  reason?: string
): { status: 'passed' | 'not_run'; evidence_sha256: string; reason?: string } {
  return {
    status: value,
    evidence_sha256: digest(`${value}-${reason || 'evidence'}`),
    ...(reason ? { reason } : {})
  };
}

function artifact(name: string) {
  return { status: 'passed' as const, sha256: digest(name) };
}

function productionStatus(
  identity: RustPbxMediaGoal3AcceptanceEvidence['source_identity'],
  value: 'passed' | 'not_run',
  reason?: string
) {
  return {
    ...status(value, reason),
    opc_commit: identity.opc_commit,
    runtime_config_sha256: identity.runtime_config_sha256
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
