import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';

import {
  evaluateVoiceMediaAttempt,
  type VoiceMediaAttemptInput
} from '../scripts/capacity/voice-media-attempt-evidence.js';

function input(
  overrides: Partial<VoiceMediaAttemptInput> = {}
): VoiceMediaAttemptInput {
  const base: VoiceMediaAttemptInput = {
    schema_version: '1.0.0',
    run_id: 'voice-run-001',
    attempt_id: 'steady-r1',
    profile_id: 'vos-eq-v1-rtp-10k-v1',
    phase_id: 'steady',
    repetition: 1,
    observation_kind: 'phase_end',
    started_at: '2026-07-25T04:00:00.000Z',
    finished_at: '2026-07-25T05:00:00.000Z',
    source_identity: {
      profile_sha256: 'a'.repeat(64),
      fork_manifest_sha256: 'b'.repeat(64),
      sut_release_id: 'rtpengine-mr26.0.1.13-506cfa7',
      generator_release_id: 'rtp-twin-v1-deadbeef'
    },
    counters: {
      attempted: 10_000,
      connected: 10_000,
      failed: 0,
      active: 0,
      completed: 10_000
    },
    generator: {
      expected_packet_rate: 2_000_000,
      actual_packet_rate: 2_000_000,
      cpu_p95_ratio: 0.45,
      nic_p95_ratio: 0.5,
      host_packet_drop_count: 0,
      scheduler_lag_p99_seconds: 0.002
    },
    clock: {
      clock_source: 'chrony',
      ntp_offset_seconds: 0.001,
      captured_at: '2026-07-25T04:59:59.000Z'
    },
    media: {
      expected_sessions: 20_000,
      protocol_handshake_count: 20_000,
      sent_packets: 3_600_000_000,
      received_packets: 3_599_900_000,
      receive_loss_ratio: 0.00002777777777777778,
      duplicate_packet_count: 0,
      out_of_order_packet_count: 0,
      jitter_p99_seconds: 0.004
    },
    sut: {
      setup_success_ratio: 1,
      relay_latency_p99_seconds: 0.006,
      unexpected_restart_count: 0,
      oom_kill_count: 0
    },
    thresholds: {
      generator_packet_rate_tolerance_ratio: 0.01,
      generator_cpu_p95_ratio: 0.6,
      generator_nic_p95_ratio: 0.7,
      generator_scheduler_lag_p99_seconds: 0.01,
      clock_offset_seconds: 0.05,
      setup_success_ratio: 0.9999,
      server_packet_loss_ratio: 0.001,
      jitter_p99_seconds: 0.02,
      relay_latency_p99_seconds: 0.01
    }
  };
  return {
    ...base,
    ...overrides,
    source_identity: {
      ...base.source_identity,
      ...overrides.source_identity
    },
    counters: { ...base.counters, ...overrides.counters },
    generator: { ...base.generator, ...overrides.generator },
    clock: { ...base.clock, ...overrides.clock },
    media: { ...base.media, ...overrides.media },
    sut: { ...base.sut, ...overrides.sut },
    thresholds: { ...base.thresholds, ...overrides.thresholds }
  };
}

function schemaValid(value: unknown): boolean {
  const schema = JSON.parse(readFileSync(
    'docs/capacity/schemas/voice-media-attempt-evidence.schema.json',
    'utf8'
  ));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (candidate: string) => !Number.isNaN(Date.parse(candidate))
  });
  return ajv.compile(schema)(value) === true;
}

test('voice media attempt emits reconciled passing evidence', () => {
  const evidence = evaluateVoiceMediaAttempt(input());

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.failure_class, 'none');
  assert.deepEqual(evidence.counters, {
    attempted: 10_000,
    connected: 10_000,
    failed: 0,
    active: 0,
    completed: 10_000
  });
  assert.deepEqual(evidence.reconciliation, {
    attempted_minus_connected_failed: 0,
    connected_minus_active_completed: 0,
    reconciled: true
  });
  assert.equal(evidence.generator_qualification.qualified, true);
  assert.equal(evidence.sut_evaluation.passed, true);
  assert.equal(schemaValid(evidence), true);
});

test('generator saturation wins over a simultaneous SUT symptom', () => {
  const evidence = evaluateVoiceMediaAttempt(input({
    generator: {
      cpu_p95_ratio: 0.61
    } as VoiceMediaAttemptInput['generator'],
    media: {
      receive_loss_ratio: 0.02
    } as VoiceMediaAttemptInput['media']
  }));

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.failure_class, 'generator');
  assert.ok(evidence.generator_qualification.reasons.includes('generator_cpu_exceeded'));
  assert.ok(evidence.sut_evaluation.reasons.includes('server_packet_loss_exceeded'));
  assert.equal(schemaValid(evidence), true);
});

test('counter mismatch invalidates the generator attempt and preserves deltas', () => {
  const evidence = evaluateVoiceMediaAttempt(input({
    counters: {
      attempted: 10_000,
      connected: 9_999,
      failed: 0,
      active: 0,
      completed: 9_999
    }
  }));

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.reconciliation.attempted_minus_connected_failed, 1);
  assert.equal(evidence.reconciliation.connected_minus_active_completed, 0);
  assert.ok(
    evidence.generator_qualification.reasons.includes(
      'attempted_connected_failed_reconciliation_failed'
    )
  );
});

test('steady-state evidence permits active sessions when counters reconcile', () => {
  const evidence = evaluateVoiceMediaAttempt(input({
    observation_kind: 'steady_state',
    counters: {
      attempted: 10_000,
      connected: 10_000,
      failed: 0,
      active: 8_000,
      completed: 2_000
    }
  }));

  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.reconciliation.reconciled, true);
});

test('phase-end evidence rejects residual active sessions as a protocol failure', () => {
  const evidence = evaluateVoiceMediaAttempt(input({
    counters: {
      attempted: 10_000,
      connected: 10_000,
      failed: 0,
      active: 1,
      completed: 9_999
    }
  }));

  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.failure_class, 'sut_or_protocol');
  assert.ok(evidence.sut_evaluation.reasons.includes('phase_end_active_sessions_remaining'));
});
