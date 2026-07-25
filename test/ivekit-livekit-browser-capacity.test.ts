import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { LiveKitCapacityProcessInput } from '../scripts/capacity/generators/livekit.js';
import type { LiveKitBrowserRoomMeasurement } from '../scripts/ivekit-livekit-browser-capacity.js';

const RUNNER_PATH = new URL('../scripts/ivekit-livekit-browser-capacity.ts', import.meta.url);

test('LiveKit browser capacity collector is a packaged executable', () => {
  assert.equal(existsSync(RUNNER_PATH), true);
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['ivekit:capacity:livekit-browser'],
    'tsx scripts/ivekit-livekit-browser-capacity.ts'
  );
  assert.equal(
    packageJson.scripts['ivekit:capacity:livekit-browser-evidence'],
    'tsx scripts/ivekit-livekit-browser-evidence.ts'
  );
});

test('LiveKit browser capacity collector validates exact token coverage without leaking tokens', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.parseLiveKitBrowserTokenBundle, 'function');

  const input = {
    ordinal_start: 4,
    ordinal_end_exclusive: 6,
    room_prefix: 'capacity-room',
    participants_per_room: 2
  };
  const records = module.parseLiveKitBrowserTokenBundle([
    tokenLine(4, 0),
    tokenLine(4, 1),
    tokenLine(5, 0),
    tokenLine(5, 1)
  ].join('\n'), input);

  assert.equal(records.length, 4);
  assert.deepEqual(
    records.map((record) => [record.room_ordinal, record.participant_ordinal]),
    [[4, 0], [4, 1], [5, 0], [5, 1]]
  );

  const secret = 'secret-token-that-must-not-leak.aaa.bbb';
  assert.throws(
    () => module.parseLiveKitBrowserTokenBundle([
      tokenLine(4, 0, secret),
      tokenLine(4, 0, secret),
      tokenLine(5, 0),
      tokenLine(5, 1)
    ].join('\n'), input),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.doesNotMatch((error as Error).message, /secret-token/);
      assert.match((error as Error).message, /duplicate|coverage/i);
      return true;
    }
  );
});

test('LiveKit visual frame markers detect corruption instead of producing false latency', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.encodeLiveKitVisualMarker, 'function');
  assert.equal(typeof module.decodeLiveKitVisualMarker, 'function');

  const encoded = module.encodeLiveKitVisualMarker(42_731);
  assert.equal(encoded.length, 28);
  assert.equal(module.decodeLiveKitVisualMarker(encoded.map((bit) => bit ? 240 : 15)), 42_731);

  const corrupted: number[] = encoded.map((bit) => bit ? 240 : 15);
  corrupted[11] = corrupted[11] > 128 ? 0 : 255;
  assert.equal(module.decodeLiveKitVisualMarker(corrupted), null);
  assert.equal(module.decodeLiveKitVisualMarker(corrupted.slice(1)), null);
});

test('LiveKit selected ICE evidence proves relay pairs without retaining addresses', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.inspectLiveKitSelectedIceCandidatePairs, 'function');

  const relay = module.inspectLiveKitSelectedIceCandidatePairs([
    new Map<string, Record<string, unknown>>([
      ['transport-1', {
        id: 'transport-1',
        type: 'transport',
        selectedCandidatePairId: 'pair-1'
      }],
      ['pair-1', {
        id: 'pair-1',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local-1',
        remoteCandidateId: 'remote-1',
        currentRoundTripTime: 0.012
      }],
      ['local-1', {
        id: 'local-1',
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        address: '203.0.113.10',
        port: 54_321,
        url: 'turn:turn.example.com:3478?transport=udp'
      }],
      ['remote-1', {
        id: 'remote-1',
        type: 'remote-candidate',
        candidateType: 'host',
        address: '198.51.100.20',
        port: 7_882
      }]
    ])
  ]);

  assert.deepEqual(relay, {
    selected_pair_count: 1,
    relay_pair_count: 1,
    transport_protocols: ['udp'],
    current_round_trip_ms: [12]
  });
  assert.doesNotMatch(JSON.stringify(relay), /203\.0\.113\.10|198\.51\.100\.20|turn\.example\.com/);

  const direct = module.inspectLiveKitSelectedIceCandidatePairs([
    new Map<string, Record<string, unknown>>([
      ['pair-direct', {
        id: 'pair-direct',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local-direct'
      }],
      ['local-direct', {
        id: 'local-direct',
        type: 'local-candidate',
        candidateType: 'host',
        protocol: 'udp'
      }]
    ])
  ]);
  assert.equal(direct.selected_pair_count, 1);
  assert.equal(direct.relay_pair_count, 0);
});

test('LiveKit inbound video evidence preserves standard WebRTC freeze counters', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.inspectLiveKitInboundVideoStats, 'function');

  const stats = module.inspectLiveKitInboundVideoStats(
    new Map<string, Record<string, unknown>>([
      ['audio', {
        id: 'audio',
        type: 'inbound-rtp',
        kind: 'audio',
        packetsReceived: 4_000
      }],
      ['video', {
        id: 'video',
        type: 'inbound-rtp',
        kind: 'video',
        framesDecoded: 1_800,
        keyFramesDecoded: 12,
        freezeCount: 3,
        totalFreezesDuration: 1.25,
        pliCount: 4,
        firCount: 1,
        nackCount: 87
      }]
    ])
  );

  assert.deepEqual(stats, {
    inbound_video_stream_count: 1,
    standard_freeze_stats_available: true,
    freeze_count: 3,
    total_freeze_duration_ms: 1_250,
    frames_decoded: 1_800,
    key_frames_decoded: 12,
    pli_count: 4,
    fir_count: 1,
    nack_count: 87
  });
});

test('LiveKit browser measurements aggregate endpoint tails and freeze time into evaluator evidence', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.summarizeLiveKitBrowserMeasurements, 'function');

  const raw = module.summarizeLiveKitBrowserMeasurements([
    roomMeasurement(4, {
      join_ms: [120, 180],
      primary_media_publish_completed_ms: 230,
      remote_tracks_ready_ms: 260,
      first_audio_after_remote_tracks_ready_ms: 90,
      first_video_frame_after_remote_tracks_ready_ms: 130,
      first_audio_ms: [250],
      first_video_ms: [310],
      glass_to_glass_ms: [80, 120],
      endpoint_packet_loss_ratio: [0, 0.01],
      jitter_ms: [4, 8],
      av_sync_absolute_ms: [15, 30],
      video_freeze_duration_ms: 100,
      video_freeze_count: 1,
      video_render_callback_freeze_duration_ms: 100,
      video_render_callback_freeze_count: 1
    }),
    roomMeasurement(5, {
      join_ms: [140, 220],
      primary_media_publish_completed_ms: 270,
      remote_tracks_ready_ms: 310,
      first_audio_after_remote_tracks_ready_ms: 110,
      first_video_frame_after_remote_tracks_ready_ms: 170,
      first_audio_ms: [280],
      first_video_ms: [350],
      glass_to_glass_ms: [90, 150],
      endpoint_packet_loss_ratio: [0.002, 0.004],
      jitter_ms: [5, 10],
      av_sync_absolute_ms: [20, 40],
      video_freeze_duration_ms: 0,
      video_freeze_count: 0,
      video_render_callback_freeze_duration_ms: 0,
      video_render_callback_freeze_count: 0
    })
  ], {
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.3,
    host_packet_drop_count: 0,
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: 'a'.repeat(64)
  });

  assert.equal(raw.connected_rooms, 2);
  assert.equal(raw.connected_participants, 4);
  assert.equal(raw.published_camera_tracks, 2);
  assert.equal(raw.published_audio_tracks, 2);
  assert.equal(raw.subscribed_tracks, 4);
  assert.equal(raw.encoded_video_packet_count, 2_200);
  assert.equal(raw.encoded_audio_packet_count, 4_200);
  assert.equal(raw.camera_average_bitrate_bps, 1_500_000);
  assert.equal(raw.latency_distribution_schema_version, '1.7.0');
  assert.equal(raw.connection_preparation_mode, 'signal_prewarmed');
  assert.equal(raw.primary_media_publish_completed_p99_ms, 270);
  assert.equal(raw.remote_tracks_ready_p99_ms, 310);
  assert.equal(raw.first_audio_after_remote_tracks_ready_p99_ms, 110);
  assert.equal(raw.first_video_frame_after_remote_tracks_ready_p99_ms, 170);
  assert.equal(raw.room_quality_sample_count, 2);
  assert.equal(raw.room_camera_bitrate_jain_fairness_index, 1);
  assert.equal(raw.room_camera_bitrate_min_to_median_ratio, 1);
  assert.equal(raw.room_join_p95_max_ms, 220);
  assert.equal(raw.room_first_audio_p99_max_ms, 280);
  assert.equal(raw.room_first_video_frame_p99_max_ms, 350);
  assert.equal(raw.room_glass_to_glass_p95_max_ms, 150);
  assert.equal(raw.room_endpoint_packet_loss_p95_max_ratio, 0.01);
  assert.equal(raw.room_jitter_p95_max_ms, 10);
  assert.equal(raw.room_video_freeze_ratio_max, 0.01);
  assert.equal(raw.room_av_sync_absolute_p95_max_ms, 40);
  assert.equal(raw.forced_turn_scope, 'none');
  assert.equal(raw.forced_turn_relay_only_configured_participants, 0);
  assert.equal(raw.forced_turn_selected_candidate_pair_count, 0);
  assert.equal(raw.forced_turn_relay_candidate_pair_count, 0);
  assert.equal(raw.forced_turn_transport_scope, 'none');
  assert.equal(raw.forced_turn_current_round_trip_sample_count, 0);
  assert.equal(raw.forced_turn_current_round_trip_p95_ms, 0);
  assert.equal(raw.join_sample_count, 4);
  assert.equal(raw.join_p50_ms, 140);
  assert.equal(raw.join_p95_ms, 220);
  assert.equal(raw.join_p99_ms, 220);
  assert.equal(raw.first_audio_sample_count, 2);
  assert.equal(raw.first_audio_p50_ms, 250);
  assert.equal(raw.first_audio_p95_ms, 280);
  assert.equal(raw.first_audio_p99_ms, 280);
  assert.equal(raw.first_video_frame_sample_count, 2);
  assert.equal(raw.first_video_frame_p50_ms, 310);
  assert.equal(raw.first_video_frame_p95_ms, 350);
  assert.equal(raw.first_video_frame_p99_ms, 350);
  assert.equal(raw.glass_to_glass_sample_count, 4);
  assert.equal(raw.glass_to_glass_p50_ms, 90);
  assert.equal(raw.glass_to_glass_p95_ms, 150);
  assert.equal(raw.glass_to_glass_p99_ms, 150);
  assert.equal(raw.endpoint_packet_loss_sample_count, 4);
  assert.equal(raw.endpoint_packet_loss_p50_ratio, 0.002);
  assert.equal(raw.endpoint_packet_loss_p95_ratio, 0.01);
  assert.equal(raw.endpoint_packet_loss_p99_ratio, 0.01);
  assert.equal(raw.jitter_sample_count, 4);
  assert.equal(raw.jitter_p50_ms, 5);
  assert.equal(raw.jitter_p95_ms, 10);
  assert.equal(raw.jitter_p99_ms, 10);
  assert.equal(raw.video_freeze_ratio, 0.005);
  assert.equal(raw.video_freezes_per_minute, 3);
  assert.equal(raw.video_freeze_measurement_scope, 'webrtc_inbound_rtp');
  assert.equal(raw.video_webrtc_freeze_stats_track_count, 2);
  assert.equal(raw.video_render_callback_freeze_duration_ms, 100);
  assert.equal(raw.video_render_callback_freeze_count, 1);
  assert.equal(raw.video_render_callback_stall_overlap_duration_ms, 0);
  assert.equal(raw.browser_event_loop_stall_duration_ms, 0);
  assert.equal(raw.browser_event_loop_stall_count, 0);
  assert.equal(raw.browser_event_loop_stall_max_ms, 0);
  assert.equal(raw.browser_event_loop_stall_ratio, 0);
  assert.equal(raw.av_sync_absolute_sample_count, 4);
  assert.equal(raw.av_sync_absolute_p50_ms, 20);
  assert.equal(raw.av_sync_absolute_p95_ms, 40);
  assert.equal(raw.av_sync_absolute_p99_ms, 40);
  assert.equal(raw.audio_endpoint_scope, 'decoded_frame');
  assert.equal(raw.generator_observation_source, 'external');
  assert.equal(raw.generator_observation_sample_count, 60);
  assert.equal(raw.generator_network_interface, 'lo');
  assert.equal(raw.generator_nic_capacity_bps, 10_000_000_000);
  assert.equal(raw.host_cpu_p95_ratio, 0.5);
  assert.equal(raw.host_witness_source, 'linux_boot_id_sha256');
  assert.equal(raw.host_boot_id_sha256, 'a'.repeat(64));
  assert.equal(raw.reconnect_attempt_count, 1);
  assert.equal(raw.reconnect_success_count, 1);
  assert.equal(raw.reconnect_recovery_sample_count, 1);
  assert.equal(raw.reconnect_recovery_p50_ms, 900);
  assert.equal(raw.reconnect_recovery_p95_ms, 900);
  assert.equal(raw.reconnect_recovery_p99_ms, 900);
  assert.equal(raw.reconnect_scope, 'room_correlated_cdp_offline');
  assert.equal(raw.reconnect_blackout_ms, 3_000);
  assert.equal(raw.reconnect_blackout_observed_ms, 3_010);
  assert.equal(raw.reconnect_recovery_endpoint_scope, 'decoded_audio_video');
  assert.equal(raw.reconnect_room_count, 1);
  assert.equal(raw.reconnect_attempt_start_spread_ms, 0);
  assert.equal(raw.reconnect_peak_attempts_per_second, 1);
  assert.equal(raw.reconnect_storm_scope, 'none');
});

test('LiveKit browser measurements preserve sender and receiver diagnostics for variance analysis', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const measurement = roomMeasurement(4) as LiveKitBrowserRoomMeasurement &
    Record<string, number | number[]>;
  Object.assign(measurement, {
    camera_subscriber_video_quality: 'medium',
    camera_total_bitrate_bps: [1_420_000],
    camera_simulcast_layer_count: 3,
    camera_primary_target_bitrate_bps: 900_000,
    camera_primary_frame_width: 1280,
    camera_primary_frame_height: 720,
    camera_primary_frames_per_second: 30,
    camera_sender_bandwidth_limited_seconds: 4.5,
    camera_sender_cpu_limited_seconds: 0.25,
    camera_receiver_frames_decoded: 1_800,
    camera_receiver_frames_dropped: 10,
    camera_receiver_frames_received: 600,
    camera_receiver_frame_width: 640,
    camera_receiver_frame_height: 360,
    video_observation_duration_ms: 60_000,
    video_frame_gap_p95_ms: 40,
    video_frame_gap_p99_ms: 80,
    video_frame_gap_max_ms: 620,
    receiver_jitter_buffer_target_ms: 200,
    receiver_jitter_buffer_target_applied_track_count: 2
  });

  const raw = module.summarizeLiveKitBrowserMeasurements([measurement], {
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.3,
    host_packet_drop_count: 0
  }) as unknown as Record<string, unknown>;

  assert.equal(raw.camera_total_average_bitrate_bps, 1_420_000);
  assert.equal(raw.camera_simulcast_layer_count_max, 3);
  assert.equal(raw.camera_primary_target_bitrate_bps, 900_000);
  assert.equal(raw.camera_primary_frame_width, 1280);
  assert.equal(raw.camera_primary_frame_height, 720);
  assert.equal(raw.camera_primary_frames_per_second, 30);
  assert.equal(raw.camera_sender_bandwidth_limited_seconds, 4.5);
  assert.equal(raw.camera_sender_cpu_limited_seconds, 0.25);
  assert.equal(raw.camera_receiver_frames_decoded, 1_800);
  assert.equal(raw.camera_receiver_frames_dropped, 10);
  assert.equal(raw.camera_receiver_frames_received, 600);
  assert.equal(raw.camera_subscriber_video_quality, 'medium');
  assert.equal(raw.camera_receiver_frame_width_min, 640);
  assert.equal(raw.camera_receiver_frame_height_min, 360);
  assert.equal(raw.camera_receiver_frames_per_second, 30);
  assert.equal(raw.room_camera_receiver_frames_per_second_min, 30);
  assert.equal(raw.video_frame_gap_p95_max_ms, 40);
  assert.equal(raw.video_frame_gap_p99_max_ms, 80);
  assert.equal(raw.video_frame_gap_max_ms, 620);
  assert.equal(raw.steady_state_warmup_ms, 5_000);
  assert.equal(raw.receiver_jitter_buffer_target_ms, 200);
  assert.equal(raw.receiver_jitter_buffer_target_applied_track_count, 2);
});

test('LiveKit browser measurements prove a bounded multi-room reconnect storm', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const raw = module.summarizeLiveKitBrowserMeasurements([
    roomMeasurement(4, {
      reconnect_attempt_count: 2,
      reconnect_success_count: 2,
      reconnect_recovery_ms: [700],
      reconnect_blackout_started_at_ms: 10_000
    }),
    roomMeasurement(5, {
      reconnect_attempt_count: 2,
      reconnect_success_count: 2,
      reconnect_recovery_ms: [900],
      reconnect_scope: 'room_correlated_cdp_offline',
      reconnect_blackout_ms: 3_000,
      reconnect_blackout_observed_ms: 3_020,
      reconnect_recovery_endpoint_scope: 'decoded_audio_video',
      reconnect_blackout_started_at_ms: 10_400
    })
  ], {
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.3,
    host_packet_drop_count: 0
  });

  assert.equal(raw.latency_distribution_schema_version, '1.7.0');
  assert.equal(raw.reconnect_attempt_count, 4);
  assert.equal(raw.reconnect_success_count, 4);
  assert.equal(raw.reconnect_room_count, 2);
  assert.equal(raw.reconnect_attempt_start_spread_ms, 400);
  assert.equal(raw.reconnect_peak_attempts_per_second, 4);
  assert.equal(raw.reconnect_storm_scope, 'multi_room_correlated_cdp_offline');
});

test('LiveKit browser measurements keep screen-share latency and bitrate independent', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const raw = module.summarizeLiveKitBrowserMeasurements([
    roomMeasurement(4, {
      published_screen_tracks: 1,
      subscribed_tracks: 3,
      encoded_video_packet_count: 1_600,
      screen_bitrate_bps: [1_950_000],
      first_screen_frame_ms: [420],
      screen_glass_to_glass_ms: [110, 170, 230]
    })
  ], {
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.3,
    host_packet_drop_count: 0,
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: 'b'.repeat(64)
  });

  assert.equal(raw.published_screen_tracks, 1);
  assert.equal(raw.screen_average_bitrate_bps, 1_950_000);
  assert.equal(raw.first_screen_frame_sample_count, 1);
  assert.equal(raw.first_screen_frame_p50_ms, 420);
  assert.equal(raw.first_screen_frame_p95_ms, 420);
  assert.equal(raw.first_screen_frame_p99_ms, 420);
  assert.equal(raw.screen_glass_to_glass_sample_count, 3);
  assert.equal(raw.screen_glass_to_glass_p50_ms, 170);
  assert.equal(raw.screen_glass_to_glass_p95_ms, 230);
  assert.equal(raw.screen_glass_to_glass_p99_ms, 230);
});

test('LiveKit evaluator fails closed on missing or inconsistent latency distributions', async () => {
  const collector = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const evaluator = await import('../scripts/capacity/generators/livekit.js');
  const raw = collector.summarizeLiveKitBrowserMeasurements([
    roomMeasurement(5)
  ], {
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.3,
    host_packet_drop_count: 0,
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: 'c'.repeat(64)
  });
  const common = {
    run_id: 'run-livekit-browser-001',
    shard_id: 'interaction/livekit-av/5-6',
    worker_id: 'livekit-browser-a',
    lease_epoch: '8',
    expected_rooms: 1,
    expected_participants: 2,
    expected_camera_tracks: 1,
    expected_audio_tracks: 1,
    expected_screen_tracks: 0,
    expected_forced_turn_participants: 0,
    expected_track_egress: 0,
    expected_room_composite_egress: 0,
    camera_bitrate_bps: 1_500_000,
    screen_bitrate_bps: 2_000_000,
    expected_reconnect_participants: 0,
    expected_reconnect_rooms: 0,
    expected_reconnect_blackout_ms: 0,
    expected_reconnect_start_window_ms: 0,
    quality_limits: liveKitBrowserInput().quality_limits,
    binary_version: 'browser-collector-test',
    binary_sha256: 'a'.repeat(64)
  };
  const legacy = { ...raw } as Partial<typeof raw>;
  delete legacy.latency_distribution_schema_version;

  assert.throws(
    () => evaluator.evaluateLiveKitCapacityEvidence({
      ...common,
      raw: legacy as typeof raw
    }),
    /latency distribution schema/i
  );
  assert.throws(
    () => evaluator.evaluateLiveKitCapacityEvidence({
      ...common,
      raw: {
        ...raw,
        join_p50_ms: raw.join_p99_ms + 1
      }
    }),
    /join.*percentile order/i
  );

  const stalled = evaluator.evaluateLiveKitCapacityEvidence({
    ...common,
    raw: {
      ...raw,
      browser_event_loop_stall_duration_ms: 1_000,
      browser_event_loop_stall_count: 1,
      browser_event_loop_stall_max_ms: 1_000,
      browser_event_loop_stall_ratio: 0.1
    }
  });
  assert.equal(stalled.status, 'invalid_generator_capacity');
  assert.equal(stalled.failure_class, 'generator');
  assert.equal(
    stalled.reasons.some((reason: string) => /browser event-loop stall/i.test(reason)),
    true
  );
});

test('LiveKit browser measurements reject missing decoded-media samples', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const measurement = roomMeasurement(4);
  measurement.glass_to_glass_ms = [];

  assert.throws(
    () => module.summarizeLiveKitBrowserMeasurements([measurement], {
      generator_observation_source: 'external',
      generator_observation_sample_count: 60,
      generator_network_interface: 'lo',
      generator_nic_capacity_bps: 10_000_000_000,
      generator_cpu_p95_ratio: 0.4,
      host_cpu_p95_ratio: 0.5,
      generator_nic_p95_ratio: 0.3,
      host_packet_drop_count: 0
    }),
    /glass-to-glass samples/i
  );
});

test('LiveKit browser baseline accepts one real audio-video publisher per two-peer room', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.validateLiveKitBrowserBaselineInput, 'function');
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput(liveKitBrowserInput()));
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    screen_room_count: 1
  }));
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    reconnect_participant_count: 2,
    reconnect_blackout_ms: 3_000,
    reconnect_start_window_ms: 1_000
  }));
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    reconnect_participant_count: 4,
    reconnect_blackout_ms: 3_000,
    reconnect_start_window_ms: 1_000
  }));
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    receiver_jitter_buffer_target_ms: 200
  }));
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      receiver_jitter_buffer_target_ms: 4_001
    }),
    /jitter buffer target/i
  );
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    subscriber_video_quality: 'medium'
  }));
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      subscriber_video_quality: 'ultra'
    }),
    /subscriber video quality/i
  );
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    camera: {
      ...liveKitBrowserInput().camera,
      minimum_bitrate_bps: 450_000
    }
  }));
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      camera: {
        ...liveKitBrowserInput().camera,
        minimum_bitrate_bps: 1_500_001
      }
    }),
    /camera bitrate minimum/i
  );
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      screen_room_count: 2,
      overlay_screen_room_count: 1
    }),
    /screen room count/i
  );
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      reconnect_participant_count: 1,
      reconnect_blackout_ms: 3_000,
      reconnect_start_window_ms: 1_000
    }),
    /whole two-participant rooms/i
  );
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      reconnect_participant_count: 2,
      reconnect_blackout_ms: 0,
      reconnect_start_window_ms: 1_000
    }),
    /reconnect blackout/i
  );
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      reconnect_participant_count: 4,
      reconnect_blackout_ms: 3_000,
      reconnect_start_window_ms: 0
    }),
    /reconnect start window/i
  );
});

test('LiveKit browser baseline accepts bounded forced TURN participant coverage', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    forced_turn_participant_count: 1
  }));
  assert.doesNotThrow(() => module.validateLiveKitBrowserBaselineInput({
    ...liveKitBrowserInput(),
    forced_turn_participant_count: 4
  }));
  assert.throws(
    () => module.validateLiveKitBrowserBaselineInput({
      ...liveKitBrowserInput(),
      forced_turn_participant_count: 5
    }),
    /forced TURN participants/i
  );
});

test('LiveKit browser baseline rejects remaining unimplemented scenarios', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  for (const override of [
    { participants_per_room: 3, expected_participants: 6 },
    { track_egress_count: 1 }
  ]) {
    assert.throws(
      () => module.validateLiveKitBrowserBaselineInput({
        ...liveKitBrowserInput(),
        ...override
      }),
      /baseline collector does not support/i
    );
  }
});

test('LiveKit reconnect blackout uses CDP and restores the endpoint network', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.executeLiveKitBrowserReconnectBlackout, 'function');
  const calls: string[] = [];
  const page = {
    async waitForFunction() {
      calls.push('media-ready');
    },
    async evaluate(_fn: unknown, phase: string) {
      calls.push(`phase:${phase}`);
    }
  };
  const cdp = {
    async send(method: string, params?: Record<string, unknown>) {
      calls.push(
        method === 'Network.emulateNetworkConditions'
          ? `offline:${String(params?.offline)}`
          : method
      );
    },
    async detach() {
      calls.push('detach');
    }
  };

  await module.executeLiveKitBrowserReconnectBlackout({
    page,
    cdp,
    blackout_ms: 3_000,
    warmup_ms: 500,
    async sleep(milliseconds: number) {
      calls.push(`sleep:${milliseconds}`);
    }
  });

  assert.deepEqual(calls, [
    'media-ready',
    'Network.enable',
    'sleep:500',
    'phase:blackout_started',
    'offline:true',
    'sleep:3000',
    'offline:false',
    'phase:restored',
    'Network.disable',
    'detach'
  ]);
});

test('LiveKit reconnect blackout restores CDP network state after injection failure', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const calls: string[] = [];
  let sleeps = 0;

  await assert.rejects(
    module.executeLiveKitBrowserReconnectBlackout({
      page: {
        async waitForFunction() {
          calls.push('media-ready');
        },
        async evaluate(_fn: unknown, phase: string) {
          calls.push(`phase:${phase}`);
        }
      },
      cdp: {
        async send(method: string, params?: Record<string, unknown>) {
          calls.push(
            method === 'Network.emulateNetworkConditions'
              ? `offline:${String(params?.offline)}`
              : method
          );
        },
        async detach() {
          calls.push('detach');
        }
      },
      blackout_ms: 3_000,
      warmup_ms: 500,
      async sleep() {
        sleeps += 1;
        if (sleeps === 2) throw new Error('injected timer failure');
      }
    }),
    /injected timer failure/
  );
  assert.deepEqual(calls.slice(-4), [
    'offline:false',
    'phase:restored',
    'Network.disable',
    'detach'
  ]);
});

test('LiveKit reconnect blackout detaches CDP when media readiness fails', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const calls: string[] = [];

  await assert.rejects(
    module.executeLiveKitBrowserReconnectBlackout({
      page: {
        async waitForFunction() {
          calls.push('media-ready');
          throw new Error('media readiness failed');
        },
        async evaluate() {
          calls.push('unexpected-phase');
        }
      },
      cdp: {
        async send(method: string) {
          calls.push(method);
        },
        async detach() {
          calls.push('detach');
        }
      },
      blackout_ms: 3_000
    }),
    /media readiness failed/
  );
  assert.deepEqual(calls, ['media-ready', 'detach']);
});

test('LiveKit browser CLI binds stdin and result path to the immutable plan', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.parseLiveKitBrowserCapacityArgs, 'function');
  const input = liveKitBrowserInput();
  assert.deepEqual(
    module.parseLiveKitBrowserCapacityArgs(
      ['run', '--input-json', '-', '--result', input.result_path],
      input
    ),
    { command: 'run', result_path: input.result_path }
  );
  assert.throws(
    () => module.parseLiveKitBrowserCapacityArgs(
      ['run', '--input-json', '-', '--result', '/tmp/other.json'],
      input
    ),
    /result path/i
  );
});

test('LiveKit collector retries one transient Chromium network-change navigation', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  let calls = 0;
  await module.navigateLiveKitCollectorPage({
    async goto() {
      calls += 1;
      if (calls === 1) throw new Error('page.goto: net::ERR_NETWORK_CHANGED');
    }
  }, 'http://10.203.24.1:7880/', 0);
  assert.equal(calls, 2);

  await assert.rejects(
    module.navigateLiveKitCollectorPage({
      async goto() {
        throw new Error('page.goto: net::ERR_CONNECTION_REFUSED');
      }
    }, 'http://10.203.24.1:7880/', 0),
    /ERR_CONNECTION_REFUSED/
  );
});

test('adaptive LiveKit publication reserves bandwidth and batches primary tracks', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const options = module.buildLiveKitVideoPublishOptions({
    width: 1280,
    height: 720,
    fps: 30,
    bitrate_bps: 1_500_000,
    minimum_bitrate_bps: 450_000,
    simulcast: true
  });
  assert.equal(options.simulcast, true);
  assert.equal(options.degradationPreference, 'maintain-framerate');
  assert.equal(options.backupCodec, false);
  assert.equal(options.videoEncoding.maxBitrate, 750_000);
  assert.equal(options.videoSimulcastLayers[1]?.encoding.maxBitrate, 600_000);
  assert.equal(
    options.videoSimulcastLayers.every(
      (layer: { width: number; height: number }) =>
        Number.isFinite(layer.width) && Number.isFinite(layer.height)
    ),
    true,
    'LiveKit VideoPreset layers require top-level width and height'
  );
  assert.equal(
    options.videoEncoding.maxBitrate +
      options.videoSimulcastLayers.reduce(
        (sum: number, layer: { encoding: { maxBitrate: number } }) =>
          sum + layer.encoding.maxBitrate,
        0
      ) <= 1_500_000,
    true
  );
  const constrainedOptions = module.buildLiveKitVideoPublishOptions({
    width: 1280,
    height: 720,
    fps: 30,
    bitrate_bps: 1_500_000,
    minimum_bitrate_bps: 450_000,
    simulcast: true
  }, 'medium');
  assert.equal(constrainedOptions.simulcast, false);
  assert.equal(constrainedOptions.videoEncoding.maxBitrate, 600_000);
  assert.deepEqual(constrainedOptions.videoSimulcastLayers, []);

  const pageFunction = module.measureLiveKitBaselineRoomInPage.toString();
  const prewarmConnectionAt = pageFunction.indexOf('.prepareConnection(');
  const connectTimerAt = pageFunction.indexOf('connectStartedAt[index]=');
  assert.equal(
    prewarmConnectionAt >= 0 && prewarmConnectionAt < connectTimerAt,
    true,
    'production join timing must use a connection prepared before the call action'
  );
  assert.match(
    pageFunction,
    /videoMediaTrack\.contentHint\s*=\s*['"]motion['"]/,
    'camera test media must ask Chromium to preserve motion cadence'
  );
  const drawFrameSource = pageFunction.match(
    /function drawFrame\(\)[\s\S]*?function drawScreenFrame/
  )?.[0] || '';
  assert.doesNotMatch(
    drawFrameSource,
    /randomState\s*=\s*\(Math\.imul\(randomState/,
    'baseline camera media must not replace the full frame with random noise'
  );
  assert.match(
    drawFrameSource,
    /motionOffset/,
    'baseline camera media must retain deterministic local motion'
  );
  assert.match(
    pageFunction,
    /remoteVideoStatsStart[\s\S]*remoteVideo\.getReceiverStats\(\)/,
    'receiver frame diagnostics must be scoped to the formal measurement window'
  );
  assert.match(
    pageFunction,
    /STEADY_STATE_WARMUP_MS[\s\S]*frameTimes\.length\s*=\s*0/,
    'steady-state QoE must reset startup frame samples after a bounded warmup'
  );
  assert.match(
    pageFunction,
    /eventLoopStallDurations\.reduce/,
    'serialized browser diagnostics must aggregate event-loop stalls in-page'
  );
  assert.doesNotMatch(
    pageFunction,
    /\bsum\(eventLoopStallDurations/,
    'serialized browser diagnostics must not call the Node-side sum helper'
  );
  assert.match(
    pageFunction,
    /jitterBufferTarget/,
    'weak-network measurements must apply the contracted receiver jitter buffer'
  );
  assert.match(
    pageFunction,
    /timeout\(waitForEndpointStartup\(\)[\s\S]*applyReceiverJitterBufferTarget\(\)/,
    'receiver buffering must increase only after first audio and video playout'
  );
  assert.match(
    pageFunction,
    /AUDIO_MARKER_FREQUENCIES_HZ/,
    'audio pulses must carry a bounded frequency code instead of relying on arrival time'
  );
  assert.match(
    pageFunction,
    /function audioMarkerSlot/,
    'decoded and playout audio must recover the marker frequency slot'
  );
  assert.match(
    pageFunction,
    /latestMarkerAt\(now,\s*slot\)/,
    'audio detections must match only a marker with the decoded frequency slot'
  );
  assert.match(
    pageFunction,
    /oscillator\.frequency\.setValueAtTime/,
    'each emitted audio pulse must schedule its marker frequency explicitly'
  );
  assert.match(
    pageFunction,
    /AUDIO_STARTUP_PULSE_SECONDS/,
    'startup audio must use a bounded longer pulse that survives playout initialization'
  );
  assert.match(
    pageFunction,
    /STARTUP_MARKER_INTERVAL_MS/,
    'startup markers must retry faster than steady-state latency probes'
  );
  assert.match(
    pageFunction,
    /AUDIO_STARTUP_CARRIER_HZ/,
    'the published audio track must be active before the subscriber attaches'
  );
  assert.match(
    pageFunction,
    /publisherGain\.gain\.value\s*=\s*(?:0)?\.8/,
    'first-audio timing must not begin from a silent published track'
  );
  assert.match(
    pageFunction,
    /if\s*\(firstAudioMs\s*===\s*(?:undefined|void 0)\)[\s\S]*if\s*\(slot\s*===\s*(?:undefined|void 0)\)\s*return/,
    'first playout audio must be recorded before frequency-marker matching'
  );
  const firstRenderedVideoAt = pageFunction.indexOf('firstVideoMs=');
  const firstDecodedMarkerAt = pageFunction.indexOf('marker!==null');
  assert.equal(
    firstRenderedVideoAt >= 0 &&
      firstDecodedMarkerAt >= 0 &&
      firstRenderedVideoAt < firstDecodedMarkerAt,
    true,
    'first-video timing must use the first rendered frame, not marker recognition'
  );
  const audioProbeAt = pageFunction.indexOf('audioSampleTimer=setInterval');
  const videoFrameProbeAt = pageFunction.lastIndexOf(
    'requestVideoFrameCallback(onVideoFrame)'
  );
  assert.equal(
    audioProbeAt >= 0 &&
      videoFrameProbeAt >= 0 &&
      audioProbeAt < videoFrameProbeAt,
    true,
    'audio playout probing must start before video marker decoding'
  );
  assert.match(
    pageFunction,
    /canvas\.width\s*=\s*cameraOutputWidth/,
    'a constrained subscriber must encode the requested source resolution directly'
  );
  assert.match(
    pageFunction,
    /remoteVideoElement\.videoWidth[\s\S]*\/\s*cameraOutputWidth/,
    'marker decoding must use the effective camera source dimensions'
  );
  assert.match(
    pageFunction,
    /emittedPulseCount\s*===\s*0/,
    'only the first startup pulse may use the longer duration'
  );
  assert.match(
    pageFunction,
    /publication\?\.setVideoQuality\?\./,
    'an explicit weak-network subscription quality must reach LiveKit'
  );
  assert.match(
    pageFunction,
    /sdk\.VideoQuality\.MEDIUM/,
    'the medium weak-network policy must use the LiveKit quality enum'
  );
  assert.match(
    pageFunction,
    /Promise\.all\(\[\s*rooms\[0\]\.localParticipant\.publishTrack\(localAudio[\s\S]*rooms\[0\]\.localParticipant\.publishTrack\(localVideo/,
    'audio and video must share one concurrent publication batch'
  );
});

test('LiveKit browser evidence CLI writes private non-overwriting evaluated evidence', async () => {
  const collector = await import('../scripts/ivekit-livekit-browser-capacity.js');
  const evidenceCli = await import('../scripts/ivekit-livekit-browser-evidence.js');
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-livekit-browser-evidence-'));
  const inputPath = join(directory, 'input.json');
  const rawPath = join(directory, 'raw.json');
  const resultPath = join(directory, 'evaluated.json');
  const input = {
    ...liveKitBrowserInput(),
    camera: {
      ...liveKitBrowserInput().camera,
      minimum_bitrate_bps: 450_000
    },
    reconnect_participant_count: 4,
    reconnect_blackout_ms: 3_000,
    reconnect_start_window_ms: 1_000
  };
  const raw = collector.summarizeLiveKitBrowserMeasurements([
    roomMeasurement(4, {
      reconnect_attempt_count: 2,
      reconnect_success_count: 2,
      reconnect_recovery_ms: [700],
      reconnect_blackout_started_at_ms: 10_000,
      camera_bitrate_bps: [600_000, 650_000],
      audio_endpoint_scope: 'playout'
    }),
    roomMeasurement(5, {
      reconnect_attempt_count: 2,
      reconnect_success_count: 2,
      reconnect_recovery_ms: [900],
      reconnect_scope: 'room_correlated_cdp_offline',
      reconnect_blackout_ms: 3_000,
      reconnect_blackout_observed_ms: 3_020,
      reconnect_blackout_started_at_ms: 10_400,
      reconnect_recovery_endpoint_scope: 'decoded_audio_video',
      camera_bitrate_bps: [610_000, 640_000],
      audio_endpoint_scope: 'playout'
    })
  ], {
    generator_observation_source: 'external',
    generator_observation_sample_count: 60,
    generator_network_interface: 'lo',
    generator_nic_capacity_bps: 10_000_000_000,
    generator_cpu_p95_ratio: 0.4,
    host_cpu_p95_ratio: 0.5,
    generator_nic_p95_ratio: 0.3,
    host_packet_drop_count: 0
  });
  writeFileSync(inputPath, `${JSON.stringify(input)}\n`, { mode: 0o600 });
  writeFileSync(rawPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 });

  try {
    const args = evidenceCli.parseLiveKitBrowserEvidenceArgs([
      '--input', inputPath,
      '--raw', rawPath,
      '--binary-version', 'browser-collector@test',
      '--binary-sha256', 'a'.repeat(64),
      '--result', resultPath
    ]);
    const evidence = await evidenceCli.runLiveKitBrowserEvidence(args);
    assert.equal(evidence.status, 'controlled_pass', evidence.reasons.join('\n'));
    assert.equal(evidence.raw.reconnect_room_count, 2);
    assert.equal(evidence.raw.reconnect_attempt_start_spread_ms, 400);
    assert.equal(evidence.quality_contract.camera_bitrate.mode, 'adaptive_minimum');
    assert.equal(statSync(resultPath).mode & 0o777, 0o600);
    await assert.rejects(
      evidenceCli.runLiveKitBrowserEvidence(args),
      /already exists/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('LiveKit browser run writes only aggregated evidence after exact token validation', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.runLiveKitBrowserCapacity, 'function');
  const input = liveKitBrowserInput();
  const bundle = [
    tokenLine(4, 0),
    tokenLine(4, 1),
    tokenLine(5, 0),
    tokenLine(5, 1)
  ].join('\n');
  let written: { path: string; value: unknown } | undefined;
  let measuredTokens: string[] = [];

  const result = await module.runLiveKitBrowserCapacity(input, {
    async readTokenBundle(path: string) {
      assert.equal(path, input.token_bundle_path);
      return bundle;
    },
    async measureRooms(
      receivedInput: ReturnType<typeof liveKitBrowserInput>,
      records: ReadonlyArray<{ token: string }>
    ) {
      assert.equal(receivedInput, input);
      measuredTokens = records.map((record) => record.token);
      return [roomMeasurement(4), roomMeasurement(5)];
    },
    async observeGenerator() {
      return {
        generator_observation_source: 'external',
        generator_observation_sample_count: 60,
        generator_network_interface: 'lo',
        generator_nic_capacity_bps: 10_000_000_000,
        generator_cpu_p95_ratio: 0.4,
        host_cpu_p95_ratio: 0.5,
        generator_nic_p95_ratio: 0.3,
        host_packet_drop_count: 0
      };
    },
    async writeResult(path: string, value: unknown) {
      written = { path, value };
    }
  });

  assert.equal(measuredTokens.length, 4);
  assert.equal(written?.path, input.result_path);
  assert.deepEqual(written?.value, result);
  assert.equal(result.connected_rooms, 2);
  assert.doesNotMatch(JSON.stringify(result), /header\.payload|secret|token/i);
});

test('LiveKit browser token input and result evidence use private non-overwriting files', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.readPrivateLiveKitTokenBundle, 'function');
  assert.equal(typeof module.writePrivateLiveKitCapacityResult, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-livekit-browser-capacity-'));
  const tokenFile = join(directory, 'tokens.jsonl');
  const resultFile = join(directory, 'result.json');
  try {
    writeFileSync(tokenFile, `${tokenLine(4, 0)}\n`, { mode: 0o600 });
    assert.match(await module.readPrivateLiveKitTokenBundle(tokenFile), /capacity-peer-4-0/);

    chmodSync(tokenFile, 0o644);
    await assert.rejects(
      module.readPrivateLiveKitTokenBundle(tokenFile),
      /mode 0600/i
    );

    await module.writePrivateLiveKitCapacityResult(resultFile, {
      connected_rooms: 1
    });
    assert.equal(statSync(resultFile).mode & 0o777, 0o600);
    await assert.rejects(
      module.writePrivateLiveKitCapacityResult(resultFile, {
        connected_rooms: 2
      }),
      /already exists/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('LiveKit browser default runtime exposes a real Playwright measurement boundary', async () => {
  const module = await import('../scripts/ivekit-livekit-browser-capacity.js');
  assert.equal(typeof module.createDefaultLiveKitBrowserCapacityRuntime, 'function');
  assert.equal(typeof module.measureLiveKitBaselineRoomInPage, 'function');
  const serializedPageFunction = module.measureLiveKitBaselineRoomInPage.toString();
  assert.match(
    serializedPageFunction,
    /\b__name\b/,
    'the regression fixture must exercise the esbuild helper boundary'
  );
  assert.match(
    module.LIVEKIT_BROWSER_PAGE_BOOTSTRAP,
    /\bvar __name\b/,
    'the browser bootstrap must install the helper before evaluating the page function'
  );
  assert.match(
    serializedPageFunction,
    /MediaStreamTrackProcessor/,
    'decoded audio diagnostics must use the browser media-frame boundary'
  );
  assert.match(
    serializedPageFunction,
    /recordDecodedAudioSignal/,
    'decoded audio diagnostics must remain separate from playout timing'
  );
  assert.match(
    serializedPageFunction,
    /recordPlayoutAudioSignal/,
    'A/V timing must retain playout audio markers separately from decoded frames'
  );
  assert.match(
    serializedPageFunction,
    /captureStream/,
    'headless A/V timing must capture the media-element playout stream'
  );
  assert.match(
    serializedPageFunction,
    /createMediaStreamSource/,
    'the captured playout stream must feed the Web Audio timing analyser'
  );
  assert.doesNotMatch(
    serializedPageFunction,
    /createMediaElementSource/,
    'headless evidence must not depend on an unavailable physical audio sink'
  );
  assert.match(
    serializedPageFunction,
    /audio_endpoint_scope:"playout"/,
    'browser A/V evidence must declare the playout endpoint it measures'
  );
  assert.match(
    serializedPageFunction,
    /frameWidth/,
    'simulcast bitrate must select a concrete encoded layer'
  );
  assert.match(
    serializedPageFunction,
    /connectStartedAt/,
    'first-media timing must retain the actual room connect start'
  );
  assert.match(
    serializedPageFunction,
    /ScreenShare/,
    'screen evidence must publish and identify a real LiveKit screen-share track'
  );
  assert.match(
    serializedPageFunction,
    /screenGlassToGlassMs/,
    'screen evidence must use an independent visual-marker latency family'
  );
  assert.match(
    serializedPageFunction,
    /RoomEvent\.Reconnecting/,
    'reconnect evidence must observe media reconnects'
  );
  assert.match(
    serializedPageFunction,
    /RoomEvent\.SignalReconnecting/,
    'reconnect evidence must observe signal-only reconnects'
  );
  assert.match(
    serializedPageFunction,
    /reconnectRestoredAt/,
    'reconnect recovery must wait for post-blackout decoded media'
  );
  assert.match(
    serializedPageFunction,
    /iceTransportPolicy/,
    'forced TURN participants must be configured relay-only'
  );
  assert.match(
    module.LIVEKIT_BROWSER_PAGE_BOOTSTRAP,
    /selectedCandidatePairId/,
    'forced TURN evidence must inspect the selected ICE candidate pair'
  );
  assert.match(
    module.LIVEKIT_BROWSER_PAGE_BOOTSTRAP,
    /candidateType/,
    'forced TURN evidence must prove a relay local candidate'
  );
  assert.equal(
    serializedPageFunction.match(/ivekit-capacity-av/g)?.length,
    2,
    'camera and microphone must share one media stream for A/V synchronization'
  );
  assert.match(
    serializedPageFunction,
    /markerBlockSize=Math\.max\(8,Math\.min\(32,Math\.floor\(cameraOutputWidth\/markerBlockCount\)\)\)/,
    'visual markers must fit both the primary and constrained VP8 source'
  );
  const runtimeFactory = module.createDefaultLiveKitBrowserCapacityRuntime.toString();
  assert.match(runtimeFactory, /LinuxProcessTreeObserver/);
  assert.match(runtimeFactory, /OPC_IVEKIT_LIVEKIT_GENERATOR_INTERFACE/);
  assert.match(runtimeFactory, /OPC_IVEKIT_LIVEKIT_GENERATOR_NIC_BPS/);
  assert.match(runtimeFactory, /newCDPSession/);
  assert.match(runtimeFactory, /executeLiveKitBrowserReconnectBlackout/);
});

function tokenLine(
  roomOrdinal: number,
  participantOrdinal: number,
  token = `header.payload.signature-${roomOrdinal}-${participantOrdinal}`
): string {
  return JSON.stringify({
    room_ordinal: roomOrdinal,
    participant_ordinal: participantOrdinal,
    room_name: `capacity-room-${roomOrdinal}`,
    identity: `capacity-peer-${roomOrdinal}-${participantOrdinal}`,
    token
  });
}

function roomMeasurement(
  roomOrdinal: number,
  overrides: Partial<LiveKitBrowserRoomMeasurement> = {}
): LiveKitBrowserRoomMeasurement {
  return {
    room_ordinal: roomOrdinal,
    connected_participants: 2,
    published_camera_tracks: 1,
    published_audio_tracks: 1,
    published_screen_tracks: 0,
    subscribed_tracks: 2,
    encoded_video_packet_count: 1_100,
    encoded_audio_packet_count: 2_100,
    camera_bitrate_bps: [1_400_000, 1_600_000],
    camera_total_bitrate_bps: [2_100_000],
    camera_simulcast_layer_count: 3,
    camera_primary_target_bitrate_bps: 1_500_000,
    camera_primary_frame_width: 1280,
    camera_primary_frame_height: 720,
    camera_primary_frames_per_second: 30,
    camera_sender_bandwidth_limited_seconds: 0,
    camera_sender_cpu_limited_seconds: 0,
    camera_receiver_frames_decoded: 300,
    camera_receiver_frames_dropped: 0,
    camera_receiver_frames_received: 300,
    camera_subscriber_video_quality: 'auto',
    camera_receiver_frame_width: 1280,
    camera_receiver_frame_height: 720,
    video_frame_gap_p95_ms: 40,
    video_frame_gap_p99_ms: 80,
    video_frame_gap_max_ms: 100,
    steady_state_warmup_ms: 5_000,
    screen_bitrate_bps: [],
    forced_turn_participants: 0,
    forced_turn_relay_only_configured_participants: 0,
    forced_turn_selected_candidate_pair_count: 0,
    forced_turn_relay_candidate_pair_count: 0,
    forced_turn_transport_protocols: [],
    forced_turn_current_round_trip_ms: [],
    forced_turn_scope: 'none',
    track_egress_completed: 0,
    room_composite_egress_completed: 0,
    join_ms: [120, 180],
    connection_preparation_mode: 'signal_prewarmed',
    primary_media_publish_completed_ms: 230,
    remote_tracks_ready_ms: 260,
    first_audio_after_remote_tracks_ready_ms: 90,
    first_video_frame_after_remote_tracks_ready_ms: 130,
    first_audio_ms: [250],
    first_video_ms: [310],
    glass_to_glass_ms: [80, 120],
    endpoint_packet_loss_ratio: [0, 0.01],
    jitter_ms: [4, 8],
    video_freeze_duration_ms: 50,
    video_observation_duration_ms: 10_000,
    video_freeze_count: 0,
    video_freeze_measurement_scope: 'webrtc_inbound_rtp',
    video_webrtc_freeze_stats_track_count: 1,
    video_render_callback_freeze_duration_ms: 50,
    video_render_callback_freeze_count: 0,
    video_render_callback_stall_overlap_duration_ms: 0,
    measurement_window_duration_ms: 10_000,
    browser_event_loop_stall_duration_ms: 0,
    browser_event_loop_stall_count: 0,
    browser_event_loop_stall_max_ms: 0,
    receiver_jitter_buffer_target_ms: 0,
    receiver_jitter_buffer_target_applied_track_count: 0,
    av_sync_absolute_ms: [15, 30],
    first_screen_frame_ms: [],
    screen_glass_to_glass_ms: [],
    audio_endpoint_scope: 'decoded_frame',
    reconnect_attempt_count: roomOrdinal === 4 ? 1 : 0,
    reconnect_success_count: roomOrdinal === 4 ? 1 : 0,
    reconnect_recovery_ms: roomOrdinal === 4 ? [900] : [],
    reconnect_scope: roomOrdinal === 4 ? 'room_correlated_cdp_offline' : 'none',
    reconnect_blackout_ms: roomOrdinal === 4 ? 3_000 : 0,
    reconnect_blackout_observed_ms: roomOrdinal === 4 ? 3_010 : 0,
    reconnect_blackout_started_at_ms: roomOrdinal === 4 ? 10_000 : 0,
    reconnect_recovery_endpoint_scope: roomOrdinal === 4
      ? 'decoded_audio_video'
      : 'none',
    stale_epoch_action_count: 0,
    ...overrides
  };
}

function liveKitBrowserInput(): LiveKitCapacityProcessInput {
  return {
    schema_version: '1.3.0',
    run_id: 'run-livekit-browser-001',
    shard_id: 'interaction/livekit-av/4-6',
    worker_id: 'livekit-browser-a',
    lease_epoch: '8',
    ordinal_start: 4,
    ordinal_end_exclusive: 6,
    layout: 'many_small_rooms',
    livekit_url: 'ws://127.0.0.1:7880',
    token_bundle_path: '/run/secrets/livekit-browser-tokens.jsonl',
    room_prefix: 'capacity-room',
    room_count: 2,
    participants_per_room: 2,
    expected_participants: 4,
    camera_publishers_per_room: 1,
    audio_publishers_per_room: 1,
    screen_room_count: 0,
    overlay_screen_room_count: 0,
    forced_turn_participant_count: 0,
    reconnect_participant_count: 0,
    reconnect_blackout_ms: 0,
    reconnect_start_window_ms: 0,
    quality_limits: {
      livekit_join_p95_ms: 3_000,
      livekit_join_p99_ms: 5_000,
      livekit_first_audio_p99_ms: 2_000,
      livekit_first_video_frame_p99_ms: 2_000,
      livekit_first_screen_frame_p99_ms: 2_000,
      livekit_glass_to_glass_p95_ms: 200,
      livekit_glass_to_glass_p99_ms: 400,
      livekit_screen_glass_to_glass_p95_ms: 300,
      endpoint_packet_loss_p95_ratio: 0.02,
      jitter_p95_ms: 20,
      jitter_p99_ms: 40,
      video_freeze_ratio: 0.02,
      video_freezes_per_minute: 1,
      camera_receiver_frames_per_second_min: 24,
      video_frame_gap_p95_ms: 100,
      video_frame_gap_p99_ms: 150,
      av_sync_absolute_p95_ms: 80,
      reconnect_success_ratio: 0.99,
      reconnect_recovery_p99_ms: 5_000,
      room_camera_bitrate_jain_fairness_min: 0.95,
      room_camera_bitrate_min_to_median_ratio_min: 0.8
    },
    track_egress_count: 0,
    room_composite_egress_count: 0,
    duration_seconds: 30,
    camera: {
      width: 1280,
      height: 720,
      fps: 30,
      bitrate_bps: 1_500_000,
      simulcast: true
    },
    screen: {
      width: 1920,
      height: 1080,
      fps: 15,
      bitrate_bps: 2_000_000
    },
    audio: { codec: 'opus', bitrate_bps: 32_000 },
    result_path: '/var/lib/ivekit/run-livekit-browser-001/evidence.json'
  };
}
