import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  executeExternalJsonGenerator
} from '../scripts/capacity/generators/external-json.js';
import {
  buildRtpMediaTwinPlan,
  evaluateRtpMediaTwinEvidence,
  evaluateRtpMediaTwinPlanEvidence
} from '../scripts/capacity/generators/rtp-media-twin.js';
import {
  buildLiveKitCapacityPlan,
  evaluateLiveKitCapacityEvidence,
  evaluateLiveKitCapacityPlanEvidence
} from '../scripts/capacity/generators/livekit.js';
import {
  buildRustDeskSyntheticPlan,
  evaluateRustDeskSyntheticEvidence,
  evaluateRustDeskSyntheticPlanEvidence
} from '../scripts/capacity/generators/rustdesk.js';

test('RTP media twin plan binds SIP session manifest, packet rate and immutable binary identity', () => {
  const plan = buildRtpMediaTwinPlan({
    binary: '/opt/ivekit/bin/ivekit-rtp-twin',
    binary_version: '0.1.0',
    binary_sha256: 'a'.repeat(64),
    run_id: 'run-rtp-001',
    shard_id: 'interaction/sip-voice/0-1000',
    worker_id: 'rtp-worker-a',
    lease_epoch: '7',
    ordinal_start: 0,
    ordinal_end_exclusive: 1000,
    session_manifest_path: '/var/lib/ivekit/run-rtp-001/sip-sessions.jsonl',
    codec: 'pcmu',
    payload_type: 0,
    clock_rate_hz: 8_000,
    packetization_ms: 20,
    directions_per_session: 2,
    duration_seconds: 120,
    local_bind_ip: '10.20.0.20',
    result_path: '/var/lib/ivekit/run-rtp-001/rtp-evidence.json',
    maximum_loss_ratio: 0.001,
    maximum_jitter_p99_ms: 30
  });

  assert.equal(plan.protocol, 'rtp');
  assert.equal(plan.input.expected_sessions, 1000);
  assert.equal(plan.input.expected_packet_rate, 100_000);
  assert.equal(plan.input.session_manifest_path.endsWith('sip-sessions.jsonl'), true);
  assert.equal(plan.binary_sha256, 'a'.repeat(64));
  assert.equal(JSON.stringify(plan).includes('srtp_key'), false);
});

test('RTP evidence distinguishes generator under-rate from SUT packet loss', () => {
  const common = {
    run_id: 'run-rtp-001',
    shard_id: 'interaction/sip-voice/0-1000',
    worker_id: 'rtp-worker-a',
    lease_epoch: '7',
    expected_sessions: 1000,
    expected_packet_rate: 100_000,
    duration_seconds: 120,
    maximum_loss_ratio: 0.001,
    maximum_jitter_p99_ms: 30,
    binary_version: '0.1.0',
    binary_sha256: 'a'.repeat(64)
  };
  const invalid = evaluateRtpMediaTwinEvidence({
    ...common,
    raw: {
      protocol_handshake_count: 1000,
      active_peak_sessions: 1000,
      sent_packets: 10_000_000,
      received_packets: 10_000_000,
      actual_packet_rate: 80_000,
      receive_loss_ratio: 0,
      duplicate_packet_count: 0,
      out_of_order_packet_count: 0,
      jitter_p99_ms: 5,
      stale_epoch_action_count: 0,
      generator_cpu_p95_ratio: 0.45,
      generator_nic_p95_ratio: 0.5,
      host_packet_drop_count: 0
    }
  });
  assert.equal(invalid.status, 'invalid_generator_capacity');

  const sutFailure = evaluateRtpMediaTwinEvidence({
    ...common,
    raw: {
      protocol_handshake_count: 1000,
      active_peak_sessions: 1000,
      sent_packets: 12_000_000,
      received_packets: 11_940_000,
      actual_packet_rate: 100_000,
      receive_loss_ratio: 0.005,
      duplicate_packet_count: 0,
      out_of_order_packet_count: 0,
      jitter_p99_ms: 5,
      stale_epoch_action_count: 0,
      generator_cpu_p95_ratio: 0.45,
      generator_nic_p95_ratio: 0.5,
      host_packet_drop_count: 0
    }
  });
  assert.equal(sutFailure.status, 'controlled_failed');
  assert.equal(sutFailure.failure_class, 'sut_or_protocol');
});

test('RTP plan-bound evidence derives immutable expected load from the executed plan', () => {
  const plan = buildRtpMediaTwinPlan(rtpPlanInput());
  const result = evaluateRtpMediaTwinPlanEvidence(plan, {
    protocol_handshake_count: 1000,
    active_peak_sessions: 1000,
    sent_packets: 12_000_000,
    received_packets: 12_000_000,
    actual_packet_rate: 100_000,
    receive_loss_ratio: 0,
    duplicate_packet_count: 0,
    out_of_order_packet_count: 0,
    jitter_p99_ms: 5,
    stale_epoch_action_count: 0,
    generator_cpu_p95_ratio: 0.4,
    generator_nic_p95_ratio: 0.5,
    host_packet_drop_count: 0
  });
  assert.equal(result.status, 'controlled_pass', result.reasons.join('\n'));
  assert.equal(result.expected_sessions, plan.input.expected_sessions);
});

test('LiveKit plan models many rooms, screen, TURN and Egress instead of one giant room', () => {
  const plan = buildLiveKitCapacityPlan({
    binary: '/opt/ivekit/bin/ivekit-livekit-loadgen',
    binary_version: 'lk-loadtest-fork@abc123',
    binary_sha256: 'b'.repeat(64),
    run_id: 'run-livekit-001',
    shard_id: 'interaction/livekit-av/0-100',
    worker_id: 'livekit-worker-a',
    lease_epoch: '8',
    ordinal_start: 0,
    ordinal_end_exclusive: 100,
    livekit_url: 'wss://livekit.example.com',
    token_bundle_path: '/run/secrets/livekit-loadgen-tokens.jsonl',
    room_prefix: 'cap-run-livekit-001',
    participants_per_room: 2,
    camera_publishers_per_room: 1,
    audio_publishers_per_room: 1,
    screen_room_count: 30,
    overlay_screen_room_count: 20,
    forced_turn_participant_ratio: 0.2,
    track_egress_count: 20,
    room_composite_egress_count: 1,
    duration_seconds: 300,
    camera_bitrate_bps: 1_500_000,
    subscriber_video_quality: 'medium',
    receiver_jitter_buffer_target_ms: 400,
    connection_preparation_mode: 'signal_prewarmed',
    screen_bitrate_bps: 2_000_000,
    reconnect_participant_ratio: 0.1,
    reconnect_blackout_ms: 3_000,
    reconnect_start_window_ms: 1_000,
    quality_limits: liveKitQualityLimits(),
    result_path: '/var/lib/ivekit/run-livekit-001/evidence.json'
  });

  assert.equal(plan.input.room_count, 100);
  assert.equal(plan.input.expected_participants, 200);
  assert.equal(plan.input.screen_room_count, 30);
  assert.equal(plan.input.forced_turn_participant_count, 40);
  assert.equal(plan.input.reconnect_participant_count, 20);
  assert.equal(plan.input.reconnect_blackout_ms, 3_000);
  assert.equal(plan.input.reconnect_start_window_ms, 1_000);
  assert.equal(plan.input.subscriber_video_quality, 'medium');
  assert.equal(plan.input.receiver_jitter_buffer_target_ms, 400);
  assert.equal(plan.input.connection_preparation_mode, 'signal_prewarmed');
  assert.equal(plan.input.schema_version, '1.3.0');
  assert.equal(plan.input.quality_limits.livekit_first_video_frame_p99_ms, 2_000);
  assert.equal(plan.input.track_egress_count, 20);
  assert.equal(plan.input.room_composite_egress_count, 1);
  assert.equal(plan.input.layout, 'many_small_rooms');
  assert.equal(JSON.stringify(plan).includes('api_secret'), false);
});

test('LiveKit evidence cannot pass on declared tracks without encoded packet and TURN proof', () => {
  const result = evaluateLiveKitCapacityEvidence({
    run_id: 'run-livekit-001',
    shard_id: 'interaction/livekit-av/0-100',
    worker_id: 'livekit-worker-a',
    lease_epoch: '8',
    expected_rooms: 100,
    expected_participants: 200,
    expected_camera_tracks: 100,
    expected_audio_tracks: 100,
    expected_screen_tracks: 50,
    expected_forced_turn_participants: 40,
    expected_track_egress: 20,
    expected_room_composite_egress: 1,
    camera_bitrate_bps: 1_500_000,
    screen_bitrate_bps: 2_000_000,
    expected_reconnect_participants: 20,
    expected_reconnect_rooms: 10,
    expected_reconnect_blackout_ms: 3_000,
    expected_reconnect_start_window_ms: 1_000,
    quality_limits: liveKitQualityLimits(),
    binary_version: 'lk-loadtest-fork@abc123',
    binary_sha256: 'b'.repeat(64),
    raw: {
      connected_rooms: 100,
      connected_participants: 200,
      published_camera_tracks: 100,
      published_audio_tracks: 100,
      published_screen_tracks: 50,
      subscribed_tracks: 250,
      encoded_video_packet_count: 0,
      encoded_audio_packet_count: 0,
      camera_average_bitrate_bps: 1_500_000,
      screen_average_bitrate_bps: 2_000_000,
      forced_turn_participants: 0,
      forced_turn_relay_only_configured_participants: 40,
      forced_turn_selected_candidate_pair_count: 0,
      forced_turn_relay_candidate_pair_count: 0,
      forced_turn_scope: 'relay_only_selected_candidate_pair',
      forced_turn_transport_scope: 'none',
      forced_turn_current_round_trip_sample_count: 0,
      forced_turn_current_round_trip_p95_ms: 0,
      track_egress_completed: 20,
      room_composite_egress_completed: 1,
      ...liveKitLatencyDistributions(),
      join_p95_ms: 2_000,
      join_p99_ms: 3_000,
      first_audio_p99_ms: 1_000,
      first_video_frame_p99_ms: 1_500,
      glass_to_glass_p95_ms: 180,
      glass_to_glass_p99_ms: 300,
      endpoint_packet_loss_p95_ratio: 0.005,
      jitter_p95_ms: 10,
      jitter_p99_ms: 20,
      video_freeze_ratio: 0.005,
      video_freezes_per_minute: 0.5,
      av_sync_absolute_p95_ms: 50,
      audio_endpoint_scope: 'playout',
      reconnect_attempt_count: 20,
      reconnect_success_count: 20,
      reconnect_recovery_p99_ms: 3_000,
      stale_epoch_action_count: 0,
      generator_observation_source: 'external',
      generator_observation_sample_count: 60,
      generator_network_interface: 'eth0',
      generator_nic_capacity_bps: 25_000_000_000,
      generator_cpu_p95_ratio: 0.4,
      host_cpu_p95_ratio: 0.5,
      generator_nic_p95_ratio: 0.5,
      host_packet_drop_count: 0
    }
  });
  assert.equal(result.status, 'controlled_failed');
  assert.match(result.reasons.join('\n'), /encoded|TURN/i);
});

test('LiveKit plan-bound evidence uses room layout to derive all expected tracks', () => {
  const plan = buildLiveKitCapacityPlan(liveKitPlanInput());
  const result = evaluateLiveKitCapacityPlanEvidence(plan, {
    connected_rooms: 100,
    connected_participants: 200,
    published_camera_tracks: 100,
    published_audio_tracks: 100,
    published_screen_tracks: 50,
    subscribed_tracks: 250,
    encoded_video_packet_count: 1,
    encoded_audio_packet_count: 1,
    camera_average_bitrate_bps: 1_500_000,
    screen_average_bitrate_bps: 2_000_000,
    forced_turn_participants: 40,
    track_egress_completed: 20,
    room_composite_egress_completed: 1,
    ...liveKitLatencyDistributions(),
    join_p95_ms: 2_000,
    join_p99_ms: 3_000,
    first_audio_p99_ms: 1_000,
    first_video_frame_p99_ms: 1_500,
    glass_to_glass_p95_ms: 180,
    glass_to_glass_p99_ms: 300,
    endpoint_packet_loss_p95_ratio: 0.005,
    jitter_p95_ms: 10,
    jitter_p99_ms: 20,
    video_freeze_ratio: 0.005,
    video_freezes_per_minute: 0.5,
    av_sync_absolute_p95_ms: 50,
    audio_endpoint_scope: 'playout',
    reconnect_attempt_count: 20,
    reconnect_success_count: 20,
    reconnect_recovery_p99_ms: 3_000,
    stale_epoch_action_count: 0,
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'eth0',
    generator_nic_capacity_bps: 25_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.5,
    host_packet_drop_count: 0
  });
  assert.equal(result.status, 'controlled_pass', result.reasons.join('\n'));
  assert.equal(result.capacity_claim, 'none');

  const adaptivePlan = buildLiveKitCapacityPlan({
    ...liveKitPlanInput(),
    camera_bitrate_minimum_bps: 450_000
  });
  const adaptive = evaluateLiveKitCapacityPlanEvidence(adaptivePlan, {
    ...result.raw,
    camera_average_bitrate_bps: 638_499
  });
  assert.equal(adaptive.status, 'controlled_pass', adaptive.reasons.join('\n'));
  assert.deepEqual(adaptive.quality_contract.camera_bitrate, {
    mode: 'adaptive_minimum',
    target_bps: 1_500_000,
    minimum_bps: 450_000
  });

  const belowAdaptiveFloor = evaluateLiveKitCapacityPlanEvidence(adaptivePlan, {
    ...result.raw,
    camera_average_bitrate_bps: 449_999
  });
  assert.equal(belowAdaptiveFloor.status, 'controlled_failed');
  assert.match(belowAdaptiveFloor.reasons.join('\n'), /camera.*below.*450000/i);

  const lowReceivedFrameRate = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    room_camera_receiver_frames_per_second_min: 10
  });
  assert.equal(lowReceivedFrameRate.status, 'controlled_failed');
  assert.match(lowReceivedFrameRate.reasons.join('\n'), /received frame rate/i);

  const excessiveFrameGap = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    video_frame_gap_p95_max_ms: 120
  });
  assert.equal(excessiveFrameGap.status, 'controlled_failed');
  assert.match(excessiveFrameGap.reasons.join('\n'), /frame-gap P95/i);

  const unfairRooms = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    room_camera_bitrate_jain_fairness_index: 0.8
  });
  assert.equal(unfairRooms.status, 'controlled_failed');
  assert.match(unfairRooms.reasons.join('\n'), /room camera bitrate Jain fairness/i);

  const hiddenBadRoom = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    room_glass_to_glass_p95_max_ms: 500
  });
  assert.equal(hiddenBadRoom.status, 'controlled_failed');
  assert.match(hiddenBadRoom.reasons.join('\n'), /worst-room glass-to-glass P95/i);

  const legacyRoomAggregate = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    latency_distribution_schema_version: '1.3.0'
  });
  assert.equal(legacyRoomAggregate.status, 'controlled_failed');
  assert.match(legacyRoomAggregate.reasons.join('\n'), /room fairness evidence schema/i);

  const legacyReconnectStorm = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    latency_distribution_schema_version: '1.4.0'
  });
  assert.equal(legacyReconnectStorm.status, 'controlled_failed');
  assert.match(legacyReconnectStorm.reasons.join('\n'), /reconnect storm evidence schema/i);

  const spreadReconnectStorm = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    reconnect_attempt_start_spread_ms: 1_001
  });
  assert.equal(spreadReconnectStorm.status, 'controlled_failed');
  assert.match(spreadReconnectStorm.reasons.join('\n'), /reconnect attempt start spread/i);

  const declaredTurnOnly = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    forced_turn_participants: 40,
    forced_turn_relay_only_configured_participants: 40,
    forced_turn_selected_candidate_pair_count: 0,
    forced_turn_relay_candidate_pair_count: 0,
    forced_turn_scope: 'relay_only_selected_candidate_pair',
    forced_turn_transport_scope: 'none',
    forced_turn_current_round_trip_sample_count: 0,
    forced_turn_current_round_trip_p95_ms: 0
  });
  assert.equal(declaredTurnOnly.status, 'controlled_failed');
  assert.match(declaredTurnOnly.reasons.join('\n'), /selected candidate-pair/i);

  const decodedOnly = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    audio_endpoint_scope: 'decoded_frame'
  });
  assert.equal(decodedOnly.status, 'controlled_failed');
  assert.match(decodedOnly.reasons.join('\n'), /playout/i);

  const saturatedHost = evaluateLiveKitCapacityPlanEvidence(plan, {
    ...result.raw,
    host_cpu_p95_ratio: 0.86
  });
  assert.equal(saturatedHost.status, 'invalid_generator_capacity');
  assert.match(saturatedHost.reasons.join('\n'), /host CPU/i);
});

test('LiveKit evidence rejects healthy track counts when endpoint QoE violates the contract', () => {
  const plan = buildLiveKitCapacityPlan(liveKitPlanInput());
  const result = evaluateLiveKitCapacityPlanEvidence(plan, {
    connected_rooms: 100,
    connected_participants: 200,
    published_camera_tracks: 100,
    published_audio_tracks: 100,
    published_screen_tracks: 50,
    subscribed_tracks: 250,
    encoded_video_packet_count: 1,
    encoded_audio_packet_count: 1,
    camera_average_bitrate_bps: 1_500_000,
    screen_average_bitrate_bps: 2_000_000,
    forced_turn_participants: 40,
    track_egress_completed: 20,
    room_composite_egress_completed: 1,
    ...liveKitLatencyDistributions(),
    join_p95_ms: 2_000,
    join_p99_ms: 3_000,
    first_audio_p99_ms: 1_000,
    first_video_frame_p99_ms: 2_500,
    glass_to_glass_p95_ms: 180,
    glass_to_glass_p99_ms: 300,
    endpoint_packet_loss_p95_ratio: 0.005,
    jitter_p95_ms: 10,
    jitter_p99_ms: 20,
    video_freeze_ratio: 0.02,
    video_freezes_per_minute: 2,
    av_sync_absolute_p95_ms: 50,
    audio_endpoint_scope: 'playout',
    reconnect_attempt_count: 20,
    reconnect_success_count: 19,
    reconnect_recovery_p99_ms: 6_000,
    stale_epoch_action_count: 0,
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'eth0',
    generator_nic_capacity_bps: 25_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.5,
    host_packet_drop_count: 0
  });

  assert.equal(result.status, 'controlled_failed');
  assert.match(result.reasons.join('\n'), /first video|freeze|reconnect/i);
});

test('RustDesk synthetic plan requires native protocol driver and separates Windows correctness', () => {
  const plan = buildRustDeskSyntheticPlan({
    binary: '/opt/ivekit/bin/ivekit-rustdesk-synthetic',
    binary_version: 'rustdesk@1.4.9+synthetic.1',
    binary_sha256: 'c'.repeat(64),
    run_id: 'run-rustdesk-001',
    shard_id: 'interaction/rustdesk-remote/0-100',
    worker_id: 'rustdesk-worker-a',
    lease_epoch: '9',
    ordinal_start: 0,
    ordinal_end_exclusive: 100,
    id_server: 'rustdesk-id.example.com:21116',
    relay_server: 'rustdesk-relay.example.com:21117',
    public_key_fingerprint: `sha256:${'d'.repeat(64)}`,
    identity_bundle_path: '/run/secrets/rustdesk-synthetic-identities.jsonl',
    office_trace_path: '/opt/ivekit/traces/office.trace',
    office_trace_sha256: 'e'.repeat(64),
    high_motion_trace_path: '/opt/ivekit/traces/high-motion.trace',
    high_motion_trace_sha256: 'f'.repeat(64),
    file_fixture_path: '/opt/ivekit/fixtures/10mb.bin',
    file_fixture_sha256: '1'.repeat(64),
    forced_relay_ratio: 0.4,
    high_motion_session_ratio: 0.1,
    file_transfer_session_ratio: 0.05,
    reconnect_session_ratio: 0.1,
    quality_limits: rustDeskQualityLimits(),
    duration_seconds: 300,
    result_path: '/var/lib/ivekit/run-rustdesk-001/evidence.json',
    driver: 'rustdesk_native'
  });
  assert.equal(plan.input.expected_sessions, 100);
  assert.equal(plan.input.expected_forced_relay_sessions, 40);
  assert.equal(plan.input.expected_reconnect_sessions, 10);
  assert.equal(plan.input.correctness_lane, 'synthetic_protocol_only');
  assert.equal(plan.input.latency_lane, 'synthetic_protocol_delivery_only');
  assert.equal(plan.input.driver, 'rustdesk_native');

  assert.throws(() => buildRustDeskSyntheticPlan({
    ...plan.source,
    driver: 'random_udp' as any
  }), /native/i);
});

test('RustDesk evidence requires hbbs/hbbr handshakes and exact relay observation', () => {
  const result = evaluateRustDeskSyntheticEvidence({
    run_id: 'run-rustdesk-001',
    shard_id: 'interaction/rustdesk-remote/0-100',
    worker_id: 'rustdesk-worker-a',
    lease_epoch: '9',
    expected_sessions: 100,
    expected_forced_relay_sessions: 40,
    expected_file_transfers: 5,
    expected_reconnect_sessions: 10,
    quality_limits: rustDeskQualityLimits(),
    binary_version: 'rustdesk@1.4.9+synthetic.1',
    binary_sha256: 'c'.repeat(64),
    raw: {
      hbbs_registration_count: 0,
      hbbs_rendezvous_count: 0,
      hbbr_relay_handshake_count: 0,
      active_peak_sessions: 100,
      direct_session_count: 60,
      relay_session_count: 40,
      media_bytes_sent: 1_000_000,
      media_bytes_received: 1_000_000,
      input_event_count: 100,
      clipboard_event_count: 100,
      file_transfer_completed_count: 5,
      file_transfer_checksum_mismatch_count: 0,
      control_ack_p95_ms: 100,
      control_ack_p99_ms: 200,
      media_update_p95_ms: 150,
      media_update_p99_ms: 300,
      reconnect_attempt_count: 10,
      reconnect_success_count: 10,
      reconnect_recovery_p99_ms: 3_000,
      stale_epoch_action_count: 0,
      generator_cpu_p95_ratio: 0.4,
      generator_nic_p95_ratio: 0.4,
      host_packet_drop_count: 0
    }
  });
  assert.equal(result.status, 'controlled_failed');
  assert.match(result.reasons.join('\n'), /hbbs|hbbr/i);
});

test('RustDesk plan-bound evidence derives relay and file expectations from the native plan', () => {
  const plan = buildRustDeskSyntheticPlan(rustDeskPlanInput());
  const result = evaluateRustDeskSyntheticPlanEvidence(plan, {
    hbbs_registration_count: 100,
    hbbs_rendezvous_count: 100,
    hbbr_relay_handshake_count: 40,
    active_peak_sessions: 100,
    direct_session_count: 60,
    relay_session_count: 40,
    media_bytes_sent: 1_000_000,
    media_bytes_received: 1_000_000,
    input_event_count: 100,
    clipboard_event_count: 100,
    file_transfer_completed_count: 5,
    file_transfer_checksum_mismatch_count: 0,
    control_ack_p95_ms: 100,
    control_ack_p99_ms: 200,
    media_update_p95_ms: 150,
    media_update_p99_ms: 300,
    reconnect_attempt_count: 10,
    reconnect_success_count: 10,
    reconnect_recovery_p99_ms: 3_000,
    stale_epoch_action_count: 0,
    generator_cpu_p95_ratio: 0.4,
    generator_nic_p95_ratio: 0.4,
    host_packet_drop_count: 0
  });
  assert.equal(result.status, 'controlled_pass');
});

test('RustDesk synthetic evidence rejects protocol success when latency or reconnect quality fails', () => {
  const plan = buildRustDeskSyntheticPlan(rustDeskPlanInput());
  const result = evaluateRustDeskSyntheticPlanEvidence(plan, {
    hbbs_registration_count: 100,
    hbbs_rendezvous_count: 100,
    hbbr_relay_handshake_count: 40,
    active_peak_sessions: 100,
    direct_session_count: 60,
    relay_session_count: 40,
    media_bytes_sent: 1_000_000,
    media_bytes_received: 1_000_000,
    input_event_count: 100,
    clipboard_event_count: 100,
    file_transfer_completed_count: 5,
    file_transfer_checksum_mismatch_count: 0,
    control_ack_p95_ms: 180,
    control_ack_p99_ms: 300,
    media_update_p95_ms: 250,
    media_update_p99_ms: 450,
    reconnect_attempt_count: 10,
    reconnect_success_count: 9,
    reconnect_recovery_p99_ms: 6_000,
    stale_epoch_action_count: 0,
    generator_cpu_p95_ratio: 0.4,
    generator_nic_p95_ratio: 0.4,
    host_packet_drop_count: 0
  });

  assert.equal(result.status, 'controlled_failed');
  assert.match(result.reasons.join('\n'), /control|media update|reconnect/i);
});

test('external generator bounds result files and terminates on lease cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-capacity-generator-'));
  const resultPath = join(directory, 'result.json');
  const writerPath = join(directory, 'writer.cjs');
  const sleeperPath = join(directory, 'sleeper.cjs');
  const executable = process.execPath;
  const binarySha256 = createHash('sha256')
    .update(readFileSync(executable))
    .digest('hex');
  try {
    writeFileSync(writerPath, [
      "const fs = require('node:fs');",
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const value = JSON.parse(input);",
      "  fs.writeFileSync(value.result_path, JSON.stringify({ payload: 'x'.repeat(256) }));",
      "});"
    ].join('\n'));
    await assert.rejects(
      () => executeExternalJsonGenerator({
        executable,
        binary_version: process.version,
        binary_sha256: binarySha256,
        args: [writerPath],
        input: { result_path: resultPath },
        result_path: resultPath,
        timeout_ms: 1_000,
        max_result_bytes: 128
      }),
      /size limit/i
    );

    writeFileSync(sleeperPath, "process.stdin.resume(); setTimeout(() => {}, 10_000);\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const aborted = await executeExternalJsonGenerator({
      executable,
      binary_version: process.version,
      binary_sha256: binarySha256,
      args: [sleeperPath],
      input: { result_path: resultPath },
      result_path: resultPath,
      timeout_ms: 1_000
    }, { signal: controller.signal });
    assert.equal(aborted.aborted, true);
    assert.equal(aborted.raw, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function rtpPlanInput() {
  return {
    binary: '/opt/ivekit/bin/ivekit-rtp-twin',
    binary_version: '0.1.0',
    binary_sha256: 'a'.repeat(64),
    run_id: 'run-rtp-001',
    shard_id: 'interaction/sip-voice/0-1000',
    worker_id: 'rtp-worker-a',
    lease_epoch: '7',
    ordinal_start: 0,
    ordinal_end_exclusive: 1000,
    session_manifest_path: '/var/lib/ivekit/run-rtp-001/sip-sessions.jsonl',
    codec: 'pcmu' as const,
    payload_type: 0,
    clock_rate_hz: 8_000,
    packetization_ms: 20,
    directions_per_session: 2 as const,
    duration_seconds: 120,
    local_bind_ip: '10.20.0.20',
    result_path: '/var/lib/ivekit/run-rtp-001/rtp-evidence.json',
    maximum_loss_ratio: 0.001,
    maximum_jitter_p99_ms: 30
  };
}

function liveKitPlanInput() {
  return {
    binary: '/opt/ivekit/bin/ivekit-livekit-loadgen',
    binary_version: 'lk-loadtest-fork@abc123',
    binary_sha256: 'b'.repeat(64),
    run_id: 'run-livekit-001',
    shard_id: 'interaction/livekit-av/0-100',
    worker_id: 'livekit-worker-a',
    lease_epoch: '8',
    ordinal_start: 0,
    ordinal_end_exclusive: 100,
    livekit_url: 'wss://livekit.example.com',
    token_bundle_path: '/run/secrets/livekit-loadgen-tokens.jsonl',
    room_prefix: 'cap-run-livekit-001',
    participants_per_room: 2,
    camera_publishers_per_room: 1,
    audio_publishers_per_room: 1,
    screen_room_count: 30,
    overlay_screen_room_count: 20,
    forced_turn_participant_ratio: 0.2,
    track_egress_count: 20,
    room_composite_egress_count: 1,
    duration_seconds: 300,
    camera_bitrate_bps: 1_500_000,
    screen_bitrate_bps: 2_000_000,
    reconnect_participant_ratio: 0.1,
    reconnect_blackout_ms: 3_000,
    reconnect_start_window_ms: 1_000,
    quality_limits: liveKitQualityLimits(),
    result_path: '/var/lib/ivekit/run-livekit-001/evidence.json'
  };
}

function liveKitQualityLimits() {
  return {
    livekit_join_p95_ms: 3_000,
    livekit_join_p99_ms: 5_000,
    livekit_first_audio_p99_ms: 1_500,
    livekit_first_video_frame_p99_ms: 2_000,
    livekit_first_screen_frame_p99_ms: 2_000,
    livekit_glass_to_glass_p95_ms: 250,
    livekit_glass_to_glass_p99_ms: 400,
    livekit_screen_glass_to_glass_p95_ms: 300,
    endpoint_packet_loss_p95_ratio: 0.01,
    jitter_p95_ms: 20,
    jitter_p99_ms: 30,
    video_freeze_ratio: 0.01,
    video_freezes_per_minute: 1,
    camera_receiver_frames_per_second_min: 24,
    video_frame_gap_p95_ms: 100,
    video_frame_gap_p99_ms: 150,
    av_sync_absolute_p95_ms: 80,
    reconnect_success_ratio: 0.999,
    reconnect_recovery_p99_ms: 5_000,
    room_camera_bitrate_jain_fairness_min: 0.95,
    room_camera_bitrate_min_to_median_ratio_min: 0.8
  };
}

function liveKitLatencyDistributions() {
  return {
    latency_distribution_schema_version: '1.5.0' as const,
    camera_total_average_bitrate_bps: 2_100_000,
    camera_simulcast_layer_count_max: 3,
    camera_primary_target_bitrate_bps: 1_500_000,
    camera_primary_frame_width: 1280,
    camera_primary_frame_height: 720,
    camera_primary_frames_per_second: 30,
    camera_sender_bandwidth_limited_seconds: 0,
    camera_sender_cpu_limited_seconds: 0,
    camera_receiver_frames_decoded: 18_000,
    camera_receiver_frames_dropped: 0,
    camera_receiver_frames_received: 18_000,
    camera_subscriber_video_quality: 'auto' as const,
    camera_receiver_frame_width_min: 1280,
    camera_receiver_frame_height_min: 720,
    camera_receiver_frames_per_second: 30,
    room_camera_receiver_frames_per_second_min: 30,
    video_frame_gap_p95_max_ms: 40,
    video_frame_gap_p99_max_ms: 80,
    video_frame_gap_max_ms: 100,
    steady_state_warmup_ms: 5_000,
    forced_turn_relay_only_configured_participants: 40,
    forced_turn_selected_candidate_pair_count: 40,
    forced_turn_relay_candidate_pair_count: 40,
    forced_turn_scope: 'relay_only_selected_candidate_pair' as const,
    forced_turn_transport_scope: 'udp' as const,
    forced_turn_current_round_trip_sample_count: 40,
    forced_turn_current_round_trip_p95_ms: 12,
    join_sample_count: 100,
    join_p50_ms: 1_000,
    first_audio_sample_count: 100,
    first_audio_p50_ms: 500,
    first_audio_p95_ms: 800,
    first_video_frame_sample_count: 100,
    first_video_frame_p50_ms: 800,
    first_video_frame_p95_ms: 1_200,
    first_screen_frame_sample_count: 100,
    first_screen_frame_p50_ms: 900,
    first_screen_frame_p95_ms: 1_400,
    first_screen_frame_p99_ms: 1_800,
    glass_to_glass_sample_count: 100,
    glass_to_glass_p50_ms: 100,
    screen_glass_to_glass_sample_count: 100,
    screen_glass_to_glass_p50_ms: 120,
    screen_glass_to_glass_p95_ms: 220,
    screen_glass_to_glass_p99_ms: 350,
    endpoint_packet_loss_sample_count: 100,
    endpoint_packet_loss_p50_ratio: 0.001,
    endpoint_packet_loss_p99_ratio: 0.008,
    jitter_sample_count: 100,
    jitter_p50_ms: 5,
    av_sync_absolute_sample_count: 100,
    av_sync_absolute_p50_ms: 20,
    av_sync_absolute_p99_ms: 60,
    reconnect_recovery_sample_count: 20,
    reconnect_recovery_p50_ms: 1_000,
    reconnect_recovery_p95_ms: 2_500,
    reconnect_scope: 'room_correlated_cdp_offline' as const,
    reconnect_blackout_ms: 3_000,
    reconnect_blackout_observed_ms: 3_010,
    reconnect_recovery_endpoint_scope: 'decoded_audio_video' as const,
    reconnect_room_count: 10,
    reconnect_attempt_start_spread_ms: 500,
    reconnect_peak_attempts_per_second: 20,
    reconnect_storm_scope: 'multi_room_correlated_cdp_offline' as const,
    room_quality_sample_count: 100,
    room_camera_bitrate_jain_fairness_index: 0.99,
    room_camera_bitrate_min_to_median_ratio: 0.95,
    room_join_p95_max_ms: 2_500,
    room_first_audio_p99_max_ms: 1_400,
    room_first_video_frame_p99_max_ms: 1_800,
    room_glass_to_glass_p95_max_ms: 220,
    room_endpoint_packet_loss_p95_max_ratio: 0.008,
    room_jitter_p95_max_ms: 18,
    room_video_freeze_ratio_max: 0.008,
    room_av_sync_absolute_p95_max_ms: 70
  };
}

function rustDeskPlanInput() {
  return {
    binary: '/opt/ivekit/bin/ivekit-rustdesk-synthetic',
    binary_version: 'rustdesk@1.4.9+synthetic.1',
    binary_sha256: 'c'.repeat(64),
    run_id: 'run-rustdesk-001',
    shard_id: 'interaction/rustdesk-remote/0-100',
    worker_id: 'rustdesk-worker-a',
    lease_epoch: '9',
    ordinal_start: 0,
    ordinal_end_exclusive: 100,
    id_server: 'rustdesk-id.example.com:21116',
    relay_server: 'rustdesk-relay.example.com:21117',
    public_key_fingerprint: `sha256:${'d'.repeat(64)}`,
    identity_bundle_path: '/run/secrets/rustdesk-synthetic-identities.jsonl',
    office_trace_path: '/opt/ivekit/traces/office.trace',
    office_trace_sha256: 'e'.repeat(64),
    high_motion_trace_path: '/opt/ivekit/traces/high-motion.trace',
    high_motion_trace_sha256: 'f'.repeat(64),
    file_fixture_path: '/opt/ivekit/fixtures/10mb.bin',
    file_fixture_sha256: '1'.repeat(64),
    forced_relay_ratio: 0.4,
    high_motion_session_ratio: 0.1,
    file_transfer_session_ratio: 0.05,
    reconnect_session_ratio: 0.1,
    quality_limits: rustDeskQualityLimits(),
    duration_seconds: 300,
    result_path: '/var/lib/ivekit/run-rustdesk-001/evidence.json',
    driver: 'rustdesk_native' as const
  };
}

function rustDeskQualityLimits() {
  return {
    control_ack_p95_ms: 150,
    control_ack_p99_ms: 250,
    media_update_p95_ms: 200,
    media_update_p99_ms: 350,
    reconnect_success_ratio: 0.999,
    reconnect_recovery_p99_ms: 5_000
  };
}
