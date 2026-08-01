import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLiveKitNetworkQualityContract,
  bindLiveKitNetworkImpairmentEvidence
} from '../scripts/capacity/generators/livekit-network-evidence.js';
import {
  parseLiveKitNetworkEvidenceArgs
} from '../scripts/converact-livekit-network-evidence.js';

const lease = {
  run_id: 'run-capacity-001',
  shard_id: 'interaction/livekit_av/0-1',
  worker_id: 'livekit-worker-a',
  lease_epoch: '7'
};

const qualityLimits = {
  livekit_join_p95_ms: 3_000,
  livekit_join_p99_ms: 5_000,
  livekit_first_audio_p99_ms: 3_000,
  livekit_first_video_frame_p99_ms: 3_500,
  livekit_first_screen_frame_p99_ms: 3_500,
  livekit_glass_to_glass_p95_ms: 800,
  livekit_glass_to_glass_p99_ms: 1_200,
  livekit_screen_glass_to_glass_p95_ms: 1_000,
  endpoint_packet_loss_p95_ratio: 0.06,
  jitter_p95_ms: 60,
  jitter_p99_ms: 80,
  video_freeze_ratio: 0.1,
  video_freezes_per_minute: 10,
  camera_receiver_frames_per_second_min: 12,
  video_frame_gap_p95_ms: 250,
  video_frame_gap_p99_ms: 600,
  av_sync_absolute_p95_ms: 300,
  reconnect_success_ratio: 0.99,
  reconnect_recovery_p99_ms: 8_000,
  room_camera_bitrate_jain_fairness_min: 0.9,
  room_camera_bitrate_min_to_median_ratio_min: 0.7
};

const profile = {
  id: 'lossy_jitter',
  round_trip_time_ms: 120,
  jitter_ms: 40,
  packet_loss_ratio: 0.05,
  downstream_kbps: 3_000,
  upstream_kbps: 1_500,
  blackout_ms: 0,
  livekit_acceptance: {
    schema_version: '1.0.0',
    camera_bitrate_minimum_bps: 450_000,
    quality_limits: qualityLimits
  }
};

test('parses an attested network evidence bundle without weakening legacy diagnostics', () => {
  assert.deepEqual(parseLiveKitNetworkEvidenceArgs([
    '--media', '/runtime/evaluated.json',
    '--apply', '/runtime/apply.json',
    '--release', '/runtime/release.json',
    '--window', '/runtime/window.json',
    '--network-path-attestation', '/runtime/network-path-attestation.json',
    '--result', '/runtime/network-evidence.json'
  ]), {
    media_path: '/runtime/evaluated.json',
    apply_path: '/runtime/apply.json',
    release_path: '/runtime/release.json',
    window_path: '/runtime/window.json',
    network_path_attestation_path: '/runtime/network-path-attestation.json',
    result_path: '/runtime/network-evidence.json'
  });
});

test('network campaigns fail closed when a profile omits its LiveKit acceptance contract', () => {
  const contract = validInput().media_evidence.quality_contract;
  assert.doesNotThrow(() => assertLiveKitNetworkQualityContract(profile, contract));
  const { livekit_acceptance: _, ...uncontracted } = profile;
  assert.throws(
    () => assertLiveKitNetworkQualityContract(uncontracted, contract),
    /acceptance contract/i
  );
});

function validInput() {
  return {
    media_evidence: {
      protocol: 'livekit_webrtc',
      evidence_level: 'controlled',
      capacity_claim: 'none',
      status: 'controlled_pass',
      run_id: lease.run_id,
      shard_id: lease.shard_id,
      worker_id: lease.worker_id,
      lease_epoch: lease.lease_epoch,
      quality_contract: {
        camera_bitrate: {
          mode: 'adaptive_minimum' as const,
          target_bps: 1_500_000,
          minimum_bps: 450_000
        },
        endpoint_packet_loss_p95_ratio: 0.06,
        quality_limits: qualityLimits
      }
    },
    media_evidence_sha256: 'a'.repeat(64),
    network_path_attestation: {
      schema_version: '1.0.0' as const,
      lease,
      observed_at: '2026-07-23T23:59:59.000Z',
      namespace_ordinal: 0,
      livekit_port: 7_880,
      namespace_name: 'ivkgen0',
      host_interface_name: 'ivkh0',
      generator_interface_name: 'ivkn0',
      ifb_interface_name: 'ivkifb0',
      host_address: '10.203.24.1/30',
      generator_address: '10.203.24.2/30',
      default_route_via: '10.203.24.1'
    },
    network_path_attestation_sha256: 'b'.repeat(64),
    apply_receipt: {
      schema_version: '1.1.0' as const,
      lease,
      interface_name: 'ivkn0',
      ifb_interface_name: 'ivkifb0',
      profile,
      applied_at: '2026-07-24T00:00:00.000Z',
      command_count: 6
    },
    release_receipt: {
      schema_version: '1.0.0' as const,
      lease,
      released: true as const,
      released_at: '2026-07-24T00:01:02.000Z'
    },
    measurement_started_at: '2026-07-24T00:00:01.000Z',
    measurement_completed_at: '2026-07-24T00:01:01.000Z'
  };
}

test('binds a LiveKit result to one applied and released network impairment lease', () => {
  const evidence = bindLiveKitNetworkImpairmentEvidence(validInput());

  assert.equal(evidence.schema_version, '1.0.0');
  assert.equal(evidence.kind, 'livekit_network_impairment_evidence');
  assert.equal(evidence.run_id, lease.run_id);
  assert.equal(evidence.network_path_qualification, 'qualified_generator_edge');
  assert.equal(evidence.network_path_attestation_sha256, 'b'.repeat(64));
  assert.equal(evidence.quality_contract_qualification, 'profile_bound');
  assert.equal(evidence.network_impairment.profile.id, profile.id);
  assert.equal(evidence.network_impairment.release.released, true);
  assert.equal(evidence.media_evidence_sha256, 'a'.repeat(64));
});

test('rejects a namespace attestation that does not match its deterministic veth plan', () => {
  const input = validInput();
  input.network_path_attestation.generator_address = '10.203.24.3/30';

  assert.throws(
    () => bindLiveKitNetworkImpairmentEvidence(input),
    /attestation.*match|network path/i
  );
});

test('rejects a network lease that does not match the LiveKit evidence assignment', () => {
  const input = validInput();
  input.release_receipt = {
    ...input.release_receipt,
    lease: { ...lease, lease_epoch: '8' }
  };

  assert.throws(
    () => bindLiveKitNetworkImpairmentEvidence(input),
    /lease.*match|assignment/i
  );
});

test('rejects a measurement window outside the applied network interval', () => {
  const input = validInput();
  input.measurement_started_at = '2026-07-23T23:59:59.000Z';

  assert.throws(
    () => bindLiveKitNetworkImpairmentEvidence(input),
    /measurement.*interval/i
  );
});

test('rejects a weak-network quality contract that hides excess packet loss', () => {
  const input = validInput();
  input.media_evidence.quality_contract.endpoint_packet_loss_p95_ratio = 0.2;

  assert.throws(
    () => bindLiveKitNetworkImpairmentEvidence(input),
    /packet loss.*profile|quality contract/i
  );
});

test('rejects media limits that do not match the profile acceptance contract', () => {
  const input = validInput();
  input.media_evidence.quality_contract.quality_limits = {
    ...qualityLimits,
    video_freeze_ratio: 0.5
  };

  assert.throws(
    () => bindLiveKitNetworkImpairmentEvidence(input),
    /acceptance contract|quality contract/i
  );
});

test('rejects an adaptive camera floor that is too low to prove usable video', () => {
  const input = validInput();
  input.media_evidence.quality_contract.camera_bitrate.minimum_bps = 100_000;

  assert.throws(
    () => bindLiveKitNetworkImpairmentEvidence(input),
    /camera.*minimum|quality contract/i
  );
});

test('marks shared loopback impairment as diagnostic rather than SUT-qualified', () => {
  const input = validInput();
  delete (input as Partial<typeof input>).network_path_attestation;
  delete (input as Partial<typeof input>).network_path_attestation_sha256;
  input.apply_receipt = {
    ...input.apply_receipt,
    interface_name: 'lo',
    ifb_interface_name: 'ifbiv0'
  };

  const evidence = bindLiveKitNetworkImpairmentEvidence(input);

  assert.equal(evidence.network_path_qualification, 'diagnostic_shared_loopback');
});

test('marks a non-loopback receipt without namespace attestation as diagnostic', () => {
  const input = validInput();
  delete (input as Partial<typeof input>).network_path_attestation;
  delete (input as Partial<typeof input>).network_path_attestation_sha256;

  const evidence = bindLiveKitNetworkImpairmentEvidence(input);

  assert.equal(
    evidence.network_path_qualification,
    'diagnostic_unattested_generator_edge'
  );
});
