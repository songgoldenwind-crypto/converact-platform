import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildVoiceMediaGoal2FinalEvidence,
  collectVoiceMediaGoal2FinalEvidence,
  type VoiceMediaGoal2FinalizerInput
} from '../scripts/ivekit-voice-media-goal2-finalize.js';

const CONVERACT_COMMIT = 'a'.repeat(40);
const RTPENGINE_COMMIT = 'b'.repeat(40);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const OLD_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const BUILDER_DIGEST = `sha256:${'e'.repeat(64)}`;
const ARCHIVE_SHA = 'f'.repeat(64);
const PATCH_SHA = '1'.repeat(64);
const EVIDENCE_SHA = '2'.repeat(64);
const CONFIG_DIGEST = `sha256:${'3'.repeat(64)}`;

const REQUIRED_CHECKS = [
  'plaintext_offer_answer',
  'plaintext_relay_endpoint',
  'plaintext_bidirectional_rtp',
  'plaintext_packet_integrity',
  'plaintext_sequence_and_ssrc',
  'plaintext_loss_and_jitter',
  'plaintext_rtcp',
  'sdes_srtp_offer_answer',
  'sdes_srtp_bidirectional',
  'srtp_plaintext_absent',
  'control_plane_outage_continuity',
  'wal_restart_recovery',
  'idempotent_delete',
  'drain_rejects_new',
  'hard_capacity_rejects_new',
  'stale_epoch_rejected',
  'higher_epoch_takeover',
  'before_write_failure_classified',
  'after_write_disconnect_reconciled',
  'rtpengine_failure_classified'
] as const;

describe('iveKit RTPengine Goal 2 finalizer', () => {
  it('is part of the Goal 2 gate and has a runnable CLI', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    assert.match(
      packageJson.scripts['test:ivekit:voice-media-goal2'] || '',
      /test\/ivekit-voice-media-goal2-finalizer\.test\.ts/
    );
    assert.equal(
      packageJson.scripts['ivekit:voice-media-goal2:finalize'],
      'node --import tsx scripts/ivekit-voice-media-goal2-finalize.ts'
    );
  });

  it('hashes retained attempts and writes an exclusive mode-0600 result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ivekit-goal2-finalizer-'));
    const input = validInput();
    const attempt = input.acceptance_attempts[0]!;
    const paths = {
      contract: join(directory, 'contract.json'),
      supplyChain: join(directory, 'supply-chain.json'),
      stages: join(directory, 'stages.json'),
      attempt: join(directory, 'attempt.json'),
      attempts: join(directory, 'attempts.json'),
      failures: join(directory, 'failures.json'),
      output: join(directory, 'final.json')
    };
    try {
      await Promise.all([
        writeJson(paths.contract, input.contract),
        writeJson(paths.supplyChain, input.supply_chain),
        writeJson(paths.stages, input.stages),
        writeJson(paths.attempt, attempt.document),
        writeJson(paths.failures, input.failure_evidence)
      ]);
      const attemptSha = await sha256File(paths.attempt);
      await writeJson(paths.attempts, [{
        attempt_id: attempt.attempt_id,
        evidence_path: paths.attempt,
        evidence_sha256: attemptSha,
        host_kernel: attempt.host_kernel,
        generator: attempt.generator,
        reconciliation: attempt.reconciliation
      }]);

      const result = await collectVoiceMediaGoal2FinalEvidence({
        IVEKIT_RTPENGINE_GOAL2_CONTRACT: paths.contract,
        IVEKIT_RTPENGINE_GOAL2_SUPPLY_CHAIN: paths.supplyChain,
        IVEKIT_RTPENGINE_GOAL2_STAGES: paths.stages,
        IVEKIT_RTPENGINE_GOAL2_ATTEMPTS: paths.attempts,
        IVEKIT_RTPENGINE_GOAL2_FAILURE_EVIDENCE: paths.failures,
        IVEKIT_RTPENGINE_GOAL2_GENERATED_AT: input.generated_at,
        IVEKIT_RTPENGINE_GOAL2_CAPACITY_CLAIM: 'none',
        IVEKIT_RTPENGINE_GOAL2_OUTPUT: paths.output
      });

      assert.equal(result.status, 'implemented');
      assert.equal((await stat(paths.output)).mode & 0o777, 0o600);
      assert.deepEqual(
        JSON.parse(await readFile(paths.output, 'utf8')),
        result
      );
      await assert.rejects(
        collectVoiceMediaGoal2FinalEvidence({
          IVEKIT_RTPENGINE_GOAL2_CONTRACT: paths.contract,
          IVEKIT_RTPENGINE_GOAL2_SUPPLY_CHAIN: paths.supplyChain,
          IVEKIT_RTPENGINE_GOAL2_STAGES: paths.stages,
          IVEKIT_RTPENGINE_GOAL2_ATTEMPTS: paths.attempts,
          IVEKIT_RTPENGINE_GOAL2_FAILURE_EVIDENCE: paths.failures,
          IVEKIT_RTPENGINE_GOAL2_GENERATED_AT: input.generated_at,
          IVEKIT_RTPENGINE_GOAL2_CAPACITY_CLAIM: 'none',
          IVEKIT_RTPENGINE_GOAL2_OUTPUT: paths.output
        }),
        /EEXIST/
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('promotes only the exact functional artifact and retains old attempts', () => {
    const input = validInput();
    input.acceptance_attempts.unshift(acceptanceAttempt({
      attempt_id: 'old-image-attempt',
      image_digest: OLD_IMAGE_DIGEST
    }));

    const result = buildVoiceMediaGoal2FinalEvidence(input);

    assert.equal(result.status, 'implemented');
    assert.deepEqual(result.verification, {
      source_identity: 'passed',
      patch_apply: 'passed',
      compile: 'passed',
      unit: 'passed',
      integration: 'passed',
      real_environment: 'passed',
      benchmark: 'not_run'
    });
    assert.equal(result.claim.capacity_claim, 'none');
    assert.equal(result.claim.production_eligible, false);
    assert.equal(result.runtime_modes.userspace, 'passed');
    assert.equal(result.runtime_modes.kernel, 'not_run');
    assert.deepEqual(
      result.acceptance_attempts.map((attempt) => ({
        attempt_id: attempt.attempt_id,
        disposition: attempt.disposition
      })),
      [
        {
          attempt_id: 'old-image-attempt',
          disposition: 'retained_identity_mismatch'
        },
        {
          attempt_id: 'exact-userspace-attempt',
          disposition: 'accepted_functional'
        }
      ]
    );
    assert.ok(result.claim.blocking_reasons.includes('benchmark-not-run'));
    assert.ok(result.claim.blocking_reasons.includes('kernel-mode-not-run'));
    assert.ok(result.claim.blocking_reasons.includes('failure-matrix-incomplete'));
  });

  it('rejects missing immutable identity', () => {
    const input = validInput();
    input.supply_chain.identity.image_digest = '';

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /runtime image digest is required/
    );
  });

  it('rejects a measured claim without three valid repetitions', () => {
    const input = validInput();
    input.requested_capacity_claim = 'userspace_measured';
    input.acceptance_attempts[0]!.generator.status = 'valid_capacity';

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /three valid userspace repetitions are required/
    );
  });

  it('does not promote an attempt with a reconciliation delta', () => {
    const input = validInput();
    input.acceptance_attempts[0]!.reconciliation.observed_sessions = 1;

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /no exact functional acceptance attempt/
    );
  });

  it('does not promote an overloaded generator attempt', () => {
    const input = validInput();
    input.acceptance_attempts[0]!.generator.status = 'overloaded';

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /no exact functional acceptance attempt/
    );
  });

  it('rejects evidence captured after the finalizer clock', () => {
    const input = validInput();
    input.generated_at = '2026-07-26T04:56:59.999Z';

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /evidence timestamp exceeds finalizer time/
    );
  });

  it('rejects a passed failure row with incomplete evidence', () => {
    const input = validInput();
    input.failure_evidence[0] = {
      failure_id: 'stale-owner-epoch',
      status: 'passed',
      evidence: ['rejection_before_transport']
    };

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /failure evidence is incomplete: stale-owner-epoch/
    );
  });

  it('rejects mixed userspace and kernel capacity repetitions', () => {
    const input = validInput();
    input.requested_capacity_claim = 'userspace_measured';
    input.acceptance_attempts = [
      acceptanceAttempt({
        attempt_id: 'userspace-1',
        generator_status: 'valid_capacity'
      }),
      acceptanceAttempt({
        attempt_id: 'userspace-2',
        generator_status: 'valid_capacity'
      }),
      acceptanceAttempt({
        attempt_id: 'kernel-1',
        runtime_mode: 'kernel',
        generator_status: 'valid_capacity',
        kernel_module_sha256: EVIDENCE_SHA
      })
    ];

    assert.throws(
      () => buildVoiceMediaGoal2FinalEvidence(input),
      /capacity repetitions mix runtime modes/
    );
  });
});

function validInput(): VoiceMediaGoal2FinalizerInput {
  return {
    generated_at: '2026-07-26T05:00:00.000Z',
    contract: {
      contract_id: 'voice-media-goal2-v1',
      source: {
        commit: RTPENGINE_COMMIT,
        archive_sha256: ARCHIVE_SHA
      },
      failure_matrix: [
        {
          failure_id: 'stale-owner-epoch',
          required_evidence: [
            'rejection_before_transport',
            'current_owner_epoch'
          ]
        },
        {
          failure_id: 'command-replay',
          required_evidence: ['stable_cookie', 'single_transport_effect']
        }
      ]
    },
    supply_chain: {
      status: 'passed',
      generated_at: '2026-07-26T04:55:00.000Z',
      identity: {
        source_commit: CONVERACT_COMMIT,
        image_reference: 'ivekit/rtpengine',
        image_digest: IMAGE_DIGEST,
        rtpengine_source_commit: RTPENGINE_COMMIT,
        archive_sha256: ARCHIVE_SHA,
        patch_set_sha256: PATCH_SHA,
        toolchain_image_digest: BUILDER_DIGEST,
        builder_image_digest: BUILDER_DIGEST,
        architecture: 'amd64'
      },
      signature: { status: 'not_run' },
      policy: {
        critical_vulnerability_count: 1,
        excepted_critical_vulnerability_count: 1,
        secret_finding_count: 0,
        exceptions: [{
          vulnerability_id: 'CVE-2026-6653',
          expires_at: '2026-08-09T00:00:00.000Z'
        }]
      }
    },
    stages: [
      stage('patch_apply', { patch_set_sha256: PATCH_SHA }),
      stage('compile', { image_digest: IMAGE_DIGEST }),
      stage('unit', { image_digest: IMAGE_DIGEST }),
      stage('integration', { image_digest: IMAGE_DIGEST })
    ],
    acceptance_attempts: [acceptanceAttempt()],
    failure_evidence: [
      {
        failure_id: 'stale-owner-epoch',
        status: 'passed',
        evidence: [
          'rejection_before_transport',
          'current_owner_epoch'
        ]
      },
      {
        failure_id: 'command-replay',
        status: 'not_run',
        reason: 'Cross-cookie native replay evidence is retained separately'
      }
    ],
    requested_capacity_claim: 'none'
  };
}

function stage(
  name: VoiceMediaGoal2FinalizerInput['stages'][number]['stage'],
  identity: {
    patch_set_sha256?: string;
    image_digest?: string;
  }
): VoiceMediaGoal2FinalizerInput['stages'][number] {
  return {
    stage: name,
    status: 'passed',
    generated_at: '2026-07-26T04:56:00.000Z',
    source_commit: CONVERACT_COMMIT,
    evidence_sha256: EVIDENCE_SHA,
    ...identity
  };
}

function acceptanceAttempt(options: {
  attempt_id?: string;
  image_digest?: string;
  runtime_mode?: 'userspace' | 'kernel';
  generator_status?: 'functional' | 'valid_capacity' | 'overloaded';
  kernel_module_sha256?: string;
} = {}): VoiceMediaGoal2FinalizerInput['acceptance_attempts'][number] {
  const checks = Object.fromEntries(
    REQUIRED_CHECKS.map((check) => [check, true])
  ) as Record<(typeof REQUIRED_CHECKS)[number], boolean>;
  return {
    attempt_id: options.attempt_id || 'exact-userspace-attempt',
    evidence_sha256: EVIDENCE_SHA,
    host_kernel: '6.8.0-71-generic',
    ...(options.kernel_module_sha256
      ? { kernel_module_sha256: options.kernel_module_sha256 }
      : {}),
    generator: {
      status: options.generator_status || 'functional',
      evidence_ref: 'packet-generator-bounded-run'
    },
    reconciliation: {
      expected_sessions: 2,
      observed_sessions: 2
    },
    document: {
      schema_version: 1,
      status: 'passed',
      capacity_claim: 'none',
      source_commit: CONVERACT_COMMIT,
      rtpengine_image_digest: options.image_digest || IMAGE_DIGEST,
      config_hash: CONFIG_DIGEST,
      runtime_mode: options.runtime_mode || 'userspace',
      generated_at: '2026-07-26T04:57:00.000Z',
      checks
    }
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function sha256File(path: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}
