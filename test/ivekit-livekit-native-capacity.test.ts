import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateLiveKitNativeCapacity,
  parseLiveKitCliLoadTestSummary
} from '../scripts/capacity/generators/livekit-native.js';
import {
  buildLiveKitNativeWorkloadManifest
} from '../scripts/capacity/generators/livekit-native-workload.js';

const SUMMARY = [
  'Subscriber summaries:',
  '┌────────┬────────┬───────────────────────┬─────────────────┬───────┐',
  '│ Tester │ Tracks │ Bitrate               │ Total Pkt. Loss │ Error │',
  '├────────┼────────┼───────────────────────┼─────────────────┼───────┤',
  '│ Total  │ 90/90  │ 25.7mbps (1.7mbps avg) │ 0 (0%)          │ 0     │',
  '└────────┴────────┴───────────────────────┴─────────────────┴───────┘'
].join('\n');
const GENERATOR_BOOT_SHA256 = 'a'.repeat(64);
const SUT_BOOT_SHA256 = 'b'.repeat(64);
const WORKLOAD = buildLiveKitNativeWorkloadManifest({
  run_id: 'livekit-native-bound-workload',
  executable_sha256: 'c'.repeat(64),
  args: [
    '--dev', 'load-test',
    '--room', 'private-large-room',
    '--duration', '60s',
    '--video-publishers', '3',
    '--audio-publishers', '3',
    '--subscribers', '15',
    '--identity-prefix', 'private-peer-prefix',
    '--video-resolution', 'high',
    '--num-per-second', '20',
    '--layout', '3x3'
  ]
});

test('LiveKit native capacity parser extracts the final aggregate summary', () => {
  assert.deepEqual(parseLiveKitCliLoadTestSummary(SUMMARY), {
    received_tracks: 90,
    expected_tracks: 90,
    aggregate_bitrate_bps: 25_700_000,
    average_subscriber_bitrate_bps: 1_700_000,
    packet_loss_count: 0,
    packet_loss_ratio: 0,
    error_count: 0
  });
});

test('LiveKit native capacity accepts a reconciled zero-loss point with valid generator headroom', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-v3-a3-s15',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({
      generator_cpu_p95_ratio: 0.30,
      host_cpu_p95_ratio: 0.60,
      generator_nic_p95_ratio: 0.06
    }),
    sut: pidObservation({
      generator_cpu_p95_ratio: 0.21,
      host_cpu_p95_ratio: 0.59,
      generator_nic_p95_ratio: 0.06
    })
  });

  assert.equal(evidence.status, 'controlled_pass');
  assert.equal(evidence.failure_class, 'none');
  assert.equal(evidence.distinct_hosts_required, false);
  assert.equal(evidence.host_scope, 'unverified');
  assert.deepEqual(evidence.reasons, []);
});

test('LiveKit native capacity strict mode rejects observations without boot-domain witnesses', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-missing-host-witness',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    require_distinct_hosts: true,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({}),
    sut: pidObservation({})
  });

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.failure_class, 'generator');
  assert.equal(evidence.distinct_hosts_required, true);
  assert.equal(evidence.host_scope, 'unverified');
  assert.match(evidence.reasons.join('\n'), /boot-domain witness.*missing/i);
});

test('LiveKit native capacity strict mode rejects generator and SUT in one boot domain', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-same-host',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    require_distinct_hosts: true,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({
      host_witness_source: 'linux_boot_id_sha256',
      host_boot_id_sha256: GENERATOR_BOOT_SHA256
    }),
    sut: pidObservation({
      host_witness_source: 'linux_boot_id_sha256',
      host_boot_id_sha256: GENERATOR_BOOT_SHA256
    })
  });

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.failure_class, 'generator');
  assert.equal(evidence.host_scope, 'same_boot_domain');
  assert.match(evidence.reasons.join('\n'), /same boot domain/i);
});

test('LiveKit native capacity strict mode accepts distinct boot domains', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-distinct-hosts',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    require_distinct_hosts: true,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({
      host_witness_source: 'linux_boot_id_sha256',
      host_boot_id_sha256: GENERATOR_BOOT_SHA256
    }),
    sut: pidObservation({
      host_witness_source: 'linux_boot_id_sha256',
      host_boot_id_sha256: SUT_BOOT_SHA256
    })
  });

  assert.equal(evidence.status, 'controlled_pass');
  assert.equal(evidence.failure_class, 'none');
  assert.equal(evidence.distinct_hosts_required, true);
  assert.equal(evidence.host_scope, 'distinct_boot_domain');
  assert.deepEqual(evidence.reasons, []);
});

test('LiveKit native capacity strict workload mode rejects a missing command binding', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-bound-workload',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    require_workload_binding: true,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({}),
    sut: pidObservation({})
  });

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.workload_binding_required, true);
  assert.equal(evidence.workload_scope, 'unverified');
  assert.match(evidence.reasons.join('\n'), /workload manifest.*missing/i);
});

test('LiveKit native capacity rejects a workload that does not match the observed command', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-bound-workload',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    require_workload_binding: true,
    workload: WORKLOAD,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({
      schema_version: '1.1.0',
      executable_sha256: WORKLOAD.executable_sha256,
      command_arg_count: WORKLOAD.command_arg_count,
      command_args_sha256: 'd'.repeat(64)
    }),
    sut: pidObservation({})
  });

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.workload_scope, 'unverified');
  assert.match(evidence.reasons.join('\n'), /command arguments.*do not match/i);
});

test('LiveKit native capacity accepts a workload bound to the observed executable and arguments', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-bound-workload',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    require_workload_binding: true,
    workload: WORKLOAD,
    summary: parseLiveKitCliLoadTestSummary(SUMMARY),
    generator: commandObservation({
      schema_version: '1.1.0',
      executable_sha256: WORKLOAD.executable_sha256,
      command_arg_count: WORKLOAD.command_arg_count,
      command_args_sha256: WORKLOAD.command_args_sha256
    }),
    sut: pidObservation({})
  });

  assert.equal(evidence.status, 'controlled_pass');
  assert.equal(evidence.workload_binding_required, true);
  assert.equal(evidence.workload_scope, 'verified');
  assert.equal(evidence.workload?.topology, 'single_large_room');
  assert.equal(evidence.workload?.expected_subscribed_tracks, 90);
  assert.deepEqual(evidence.reasons, []);
});

test('LiveKit native capacity rejects same-host saturation before claiming an SFU frontier', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-v4-a4-s20',
    expected_tracks: 160,
    maximum_packet_loss_ratio: 0.001,
    summary: {
      received_tracks: 160,
      expected_tracks: 160,
      aggregate_bitrate_bps: 77_700_000,
      average_subscriber_bitrate_bps: 3_900_000,
      packet_loss_count: 0,
      packet_loss_ratio: 0,
      error_count: 0
    },
    generator: commandObservation({
      generator_cpu_p95_ratio: 0.44,
      host_cpu_p95_ratio: 0.985,
      generator_nic_p95_ratio: 0.12
    }),
    sut: pidObservation({
      generator_cpu_p95_ratio: 0.44,
      host_cpu_p95_ratio: 0.985,
      generator_nic_p95_ratio: 0.12
    })
  });

  assert.equal(evidence.status, 'invalid_generator_capacity');
  assert.equal(evidence.failure_class, 'generator');
  assert.match(evidence.reasons.join('\n'), /host CPU/i);
});

test('LiveKit native capacity reports protocol quality failure independently of generator validity', () => {
  const evidence = evaluateLiveKitNativeCapacity({
    run_id: 'livekit-native-loss',
    expected_tracks: 90,
    maximum_packet_loss_ratio: 0.001,
    summary: {
      received_tracks: 90,
      expected_tracks: 90,
      aggregate_bitrate_bps: 25_700_000,
      average_subscriber_bitrate_bps: 1_700_000,
      packet_loss_count: 500,
      packet_loss_ratio: 0.002,
      error_count: 0
    },
    generator: commandObservation({}),
    sut: pidObservation({})
  });

  assert.equal(evidence.status, 'controlled_failed');
  assert.equal(evidence.failure_class, 'sut_or_protocol');
  assert.match(evidence.reasons.join('\n'), /packet loss/i);
});

function commandObservation(overrides: Record<string, unknown>) {
  return {
    schema_version: '1.0.0' as const,
    mode: 'run' as const,
    observed_pid: 100,
    executable: '/opt/ivekit/lk',
    exit_code: 0,
    signal: null,
    generator_observation_source: 'linux_proc_tree' as const,
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 1_000_000_000,
    generator_cpu_p95_ratio: 0.3,
    host_cpu_p95_ratio: 0.6,
    generator_nic_p95_ratio: 0.06,
    host_packet_drop_count: 0,
    ...overrides
  };
}

function pidObservation(overrides: Record<string, unknown>) {
  return {
    schema_version: '1.0.0' as const,
    mode: 'pid' as const,
    observed_pid: 200,
    duration_seconds: 70,
    generator_observation_source: 'linux_proc_tree' as const,
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 1_000_000_000,
    generator_cpu_p95_ratio: 0.2,
    host_cpu_p95_ratio: 0.6,
    generator_nic_p95_ratio: 0.06,
    host_packet_drop_count: 0,
    ...overrides
  };
}
