import type { ExternalJsonGeneratorPlan } from './external-json.js';

export interface LiveKitCapacityPlanInput {
  binary: string;
  binary_version: string;
  binary_sha256: string;
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  livekit_url: string;
  token_bundle_path: string;
  room_prefix: string;
  participants_per_room: number;
  camera_publishers_per_room: number;
  audio_publishers_per_room: number;
  screen_room_count: number;
  overlay_screen_room_count: number;
  forced_turn_participant_ratio: number;
  track_egress_count: number;
  room_composite_egress_count: number;
  duration_seconds: number;
  camera_bitrate_bps: number;
  camera_bitrate_minimum_bps?: number;
  subscriber_video_quality?: 'auto' | 'low' | 'medium' | 'high';
  receiver_jitter_buffer_target_ms?: number;
  connection_preparation_mode?: 'cold' | 'signal_prewarmed';
  screen_bitrate_bps: number;
  reconnect_participant_ratio: number;
  reconnect_blackout_ms: number;
  reconnect_start_window_ms: number;
  quality_limits: LiveKitQualityLimits;
  result_path: string;
}

export interface LiveKitQualityLimits {
  livekit_join_p95_ms: number;
  livekit_join_p99_ms: number;
  livekit_first_audio_p99_ms: number;
  livekit_first_video_frame_p99_ms: number;
  livekit_first_screen_frame_p99_ms: number;
  livekit_glass_to_glass_p95_ms: number;
  livekit_glass_to_glass_p99_ms: number;
  livekit_screen_glass_to_glass_p95_ms: number;
  endpoint_packet_loss_p95_ratio: number;
  jitter_p95_ms: number;
  jitter_p99_ms: number;
  video_freeze_ratio: number;
  video_freezes_per_minute: number;
  camera_receiver_frames_per_second_min: number;
  video_frame_gap_p95_ms: number;
  video_frame_gap_p99_ms: number;
  av_sync_absolute_p95_ms: number;
  reconnect_success_ratio: number;
  reconnect_recovery_p99_ms: number;
  room_camera_bitrate_jain_fairness_min: number;
  room_camera_bitrate_min_to_median_ratio_min: number;
}

export interface LiveKitCapacityQualityContract {
  camera_bitrate:
    | {
        mode: 'target_tolerance';
        target_bps: number;
        tolerance_ratio: 0.1;
      }
    | {
        mode: 'adaptive_minimum';
        target_bps: number;
        minimum_bps: number;
      };
  endpoint_packet_loss_p95_ratio: number;
  quality_limits: LiveKitQualityLimits;
}

export interface LiveKitCapacityProcessInput extends Record<string, unknown> {
  schema_version: '1.3.0';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  layout: 'many_small_rooms';
  livekit_url: string;
  token_bundle_path: string;
  room_prefix: string;
  room_count: number;
  participants_per_room: number;
  expected_participants: number;
  camera_publishers_per_room: number;
  audio_publishers_per_room: number;
  screen_room_count: number;
  overlay_screen_room_count: number;
  forced_turn_participant_count: number;
  reconnect_participant_count: number;
  reconnect_blackout_ms: number;
  reconnect_start_window_ms: number;
  subscriber_video_quality?: 'auto' | 'low' | 'medium' | 'high';
  receiver_jitter_buffer_target_ms?: number;
  connection_preparation_mode?: 'cold' | 'signal_prewarmed';
  quality_limits: LiveKitQualityLimits;
  track_egress_count: number;
  room_composite_egress_count: number;
  duration_seconds: number;
  camera: {
    width: 1280;
    height: 720;
    fps: 30;
    bitrate_bps: number;
    minimum_bitrate_bps?: number;
    simulcast: true;
  };
  screen: { width: 1920; height: 1080; fps: 15; bitrate_bps: number };
  audio: { codec: 'opus'; bitrate_bps: 32_000 };
  result_path: string;
}

export interface LiveKitCapacityPlan extends ExternalJsonGeneratorPlan<LiveKitCapacityProcessInput> {
  protocol: 'livekit_webrtc';
  source: LiveKitCapacityPlanInput;
}

export interface LiveKitCapacityRawEvidence {
  latency_distribution_schema_version:
    '1.0.0' | '1.1.0' | '1.2.0' | '1.3.0' | '1.4.0' | '1.5.0' | '1.6.0' |
    '1.7.0';
  connected_rooms: number;
  connected_participants: number;
  published_camera_tracks: number;
  published_audio_tracks: number;
  published_screen_tracks: number;
  subscribed_tracks: number;
  encoded_video_packet_count: number;
  encoded_audio_packet_count: number;
  camera_average_bitrate_bps: number;
  camera_total_average_bitrate_bps: number;
  camera_simulcast_layer_count_max: number;
  camera_primary_target_bitrate_bps: number;
  camera_primary_frame_width: number;
  camera_primary_frame_height: number;
  camera_primary_frames_per_second: number;
  camera_sender_bandwidth_limited_seconds: number;
  camera_sender_cpu_limited_seconds: number;
  camera_receiver_frames_decoded: number;
  camera_receiver_frames_dropped: number;
  camera_receiver_frames_received: number;
  camera_subscriber_video_quality: 'auto' | 'low' | 'medium' | 'high';
  camera_receiver_frame_width_min: number;
  camera_receiver_frame_height_min: number;
  camera_receiver_frames_per_second: number;
  room_camera_receiver_frames_per_second_min: number;
  video_frame_gap_p95_max_ms: number;
  video_frame_gap_p99_max_ms: number;
  video_frame_gap_max_ms: number;
  steady_state_warmup_ms: number;
  receiver_jitter_buffer_target_ms?: number;
  receiver_jitter_buffer_target_applied_track_count?: number;
  connection_preparation_mode?: 'cold' | 'signal_prewarmed';
  primary_media_publish_completed_p99_ms?: number;
  remote_tracks_ready_p99_ms?: number;
  first_audio_after_remote_tracks_ready_p99_ms?: number;
  first_video_frame_after_remote_tracks_ready_p99_ms?: number;
  screen_average_bitrate_bps: number;
  room_quality_sample_count: number;
  room_camera_bitrate_jain_fairness_index: number;
  room_camera_bitrate_min_to_median_ratio: number;
  room_join_p95_max_ms: number;
  room_first_audio_p99_max_ms: number;
  room_first_video_frame_p99_max_ms: number;
  room_glass_to_glass_p95_max_ms: number;
  room_endpoint_packet_loss_p95_max_ratio: number;
  room_jitter_p95_max_ms: number;
  room_video_freeze_ratio_max: number;
  room_av_sync_absolute_p95_max_ms: number;
  forced_turn_participants: number;
  forced_turn_relay_only_configured_participants?: number;
  forced_turn_selected_candidate_pair_count?: number;
  forced_turn_relay_candidate_pair_count?: number;
  forced_turn_scope?: 'none' | 'relay_only_selected_candidate_pair';
  forced_turn_transport_scope?: 'none' | 'udp' | 'tcp' | 'mixed' | 'unknown';
  forced_turn_current_round_trip_sample_count?: number;
  forced_turn_current_round_trip_p95_ms?: number;
  track_egress_completed: number;
  room_composite_egress_completed: number;
  join_sample_count: number;
  join_p50_ms: number;
  join_p95_ms: number;
  join_p99_ms: number;
  first_audio_sample_count: number;
  first_audio_p50_ms: number;
  first_audio_p95_ms: number;
  first_audio_p99_ms: number;
  first_video_frame_sample_count: number;
  first_video_frame_p50_ms: number;
  first_video_frame_p95_ms: number;
  first_video_frame_p99_ms: number;
  first_screen_frame_sample_count: number;
  first_screen_frame_p50_ms: number;
  first_screen_frame_p95_ms: number;
  first_screen_frame_p99_ms: number;
  glass_to_glass_sample_count: number;
  glass_to_glass_p50_ms: number;
  glass_to_glass_p95_ms: number;
  glass_to_glass_p99_ms: number;
  screen_glass_to_glass_sample_count: number;
  screen_glass_to_glass_p50_ms: number;
  screen_glass_to_glass_p95_ms: number;
  screen_glass_to_glass_p99_ms: number;
  endpoint_packet_loss_sample_count: number;
  endpoint_packet_loss_p50_ratio: number;
  endpoint_packet_loss_p95_ratio: number;
  endpoint_packet_loss_p99_ratio: number;
  jitter_sample_count: number;
  jitter_p50_ms: number;
  jitter_p95_ms: number;
  jitter_p99_ms: number;
  video_freeze_ratio: number;
  video_freezes_per_minute: number;
  video_freeze_measurement_scope?:
    'webrtc_inbound_rtp' | 'render_callback_fallback';
  video_webrtc_freeze_stats_track_count?: number;
  video_render_callback_freeze_duration_ms?: number;
  video_render_callback_freeze_count?: number;
  video_render_callback_stall_overlap_duration_ms?: number;
  browser_event_loop_stall_duration_ms?: number;
  browser_event_loop_stall_count?: number;
  browser_event_loop_stall_max_ms?: number;
  browser_event_loop_stall_ratio?: number;
  av_sync_absolute_sample_count: number;
  av_sync_absolute_p50_ms: number;
  av_sync_absolute_p95_ms: number;
  av_sync_absolute_p99_ms: number;
  audio_endpoint_scope: 'decoded_frame' | 'playout';
  reconnect_attempt_count: number;
  reconnect_success_count: number;
  reconnect_recovery_sample_count: number;
  reconnect_recovery_p50_ms: number;
  reconnect_recovery_p95_ms: number;
  reconnect_recovery_p99_ms: number;
  reconnect_scope: 'none' | 'room_correlated_cdp_offline';
  reconnect_blackout_ms: number;
  reconnect_blackout_observed_ms: number;
  reconnect_recovery_endpoint_scope: 'none' | 'decoded_audio_video';
  reconnect_room_count?: number;
  reconnect_attempt_start_spread_ms?: number;
  reconnect_peak_attempts_per_second?: number;
  reconnect_storm_scope?: 'none' | 'multi_room_correlated_cdp_offline';
  stale_epoch_action_count: number;
  generator_observation_source: 'external' | 'linux_proc_tree';
  generator_observation_sample_count: number;
  generator_network_interface: string;
  generator_nic_capacity_bps: number;
  generator_cpu_p95_ratio: number;
  host_cpu_p95_ratio: number;
  generator_nic_p95_ratio: number;
  host_packet_drop_count: number;
  host_witness_source?: 'linux_boot_id_sha256';
  host_boot_id_sha256?: string;
}

export interface LiveKitCapacityEvidence {
  protocol: 'livekit_webrtc';
  evidence_level: 'controlled';
  capacity_claim: 'none';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  reasons: string[];
  binary_version: string;
  binary_sha256: string;
  quality_contract: LiveKitCapacityQualityContract;
  raw: LiveKitCapacityRawEvidence;
}

export function buildLiveKitCapacityPlan(input: LiveKitCapacityPlanInput): LiveKitCapacityPlan {
  common(input);
  const roomCount = input.ordinal_end_exclusive - input.ordinal_start;
  bounded(input.participants_per_room, 2, 64, 'participants per room');
  bounded(input.camera_publishers_per_room, 0, input.participants_per_room, 'camera publishers');
  bounded(input.audio_publishers_per_room, 0, input.participants_per_room, 'audio publishers');
  bounded(input.screen_room_count, 0, roomCount, 'screen room count');
  bounded(input.overlay_screen_room_count, 0, roomCount, 'overlay screen room count');
  ratio(input.forced_turn_participant_ratio, 'forced TURN ratio');
  bounded(input.track_egress_count, 0, roomCount * 4, 'track Egress count');
  bounded(input.room_composite_egress_count, 0, roomCount, 'RoomComposite Egress count');
  bounded(input.duration_seconds, 1, 86_400, 'duration');
  bounded(input.camera_bitrate_bps, 100_000, 20_000_000, 'camera bitrate');
  if (input.camera_bitrate_minimum_bps !== undefined) {
    bounded(
      input.camera_bitrate_minimum_bps,
      100_000,
      input.camera_bitrate_bps,
      'camera bitrate minimum'
    );
  }
  if (!['auto', 'low', 'medium', 'high'].includes(
    input.subscriber_video_quality || 'auto'
  )) {
    throw new Error('invalid LiveKit subscriber video quality');
  }
  bounded(
    input.receiver_jitter_buffer_target_ms ?? 0,
    0,
    4_000,
    'receiver jitter buffer target'
  );
  if (!['cold', 'signal_prewarmed'].includes(
    input.connection_preparation_mode || 'cold'
  )) {
    throw new Error('invalid LiveKit connection preparation mode');
  }
  bounded(input.screen_bitrate_bps, 100_000, 50_000_000, 'screen bitrate');
  ratio(input.reconnect_participant_ratio, 'reconnect participant ratio');
  if (input.reconnect_participant_ratio === 0) {
    bounded(input.reconnect_blackout_ms, 0, 0, 'reconnect blackout');
    bounded(input.reconnect_start_window_ms, 0, 0, 'reconnect start window');
  } else {
    bounded(input.reconnect_blackout_ms, 1_000, 30_000, 'reconnect blackout');
    bounded(input.reconnect_start_window_ms, 1, 1_000, 'reconnect start window');
  }
  validateQualityLimits(input.quality_limits);
  const url = new URL(input.livekit_url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid LiveKit URL');
  }
  const expectedParticipants = roomCount * input.participants_per_room;
  const reconnectParticipantCount = Math.round(
    expectedParticipants * input.reconnect_participant_ratio
  );
  if (reconnectParticipantCount % input.participants_per_room !== 0) {
    throw new Error('reconnect participants must cover whole rooms');
  }
  const processInput: LiveKitCapacityProcessInput = {
    schema_version: '1.3.0',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    ordinal_start: input.ordinal_start,
    ordinal_end_exclusive: input.ordinal_end_exclusive,
    layout: 'many_small_rooms',
    livekit_url: input.livekit_url,
    token_bundle_path: absolute(input.token_bundle_path, 'token bundle'),
    room_prefix: safeId(input.room_prefix, 'room prefix'),
    room_count: roomCount,
    participants_per_room: input.participants_per_room,
    expected_participants: expectedParticipants,
    camera_publishers_per_room: input.camera_publishers_per_room,
    audio_publishers_per_room: input.audio_publishers_per_room,
    screen_room_count: input.screen_room_count,
    overlay_screen_room_count: input.overlay_screen_room_count,
    forced_turn_participant_count: Math.round(expectedParticipants * input.forced_turn_participant_ratio),
    reconnect_participant_count: reconnectParticipantCount,
    reconnect_blackout_ms: input.reconnect_blackout_ms,
    reconnect_start_window_ms: input.reconnect_start_window_ms,
    subscriber_video_quality: input.subscriber_video_quality || 'auto',
    receiver_jitter_buffer_target_ms:
      input.receiver_jitter_buffer_target_ms ?? 0,
    connection_preparation_mode:
      input.connection_preparation_mode || 'cold',
    quality_limits: structuredClone(input.quality_limits),
    track_egress_count: input.track_egress_count,
    room_composite_egress_count: input.room_composite_egress_count,
    duration_seconds: input.duration_seconds,
    camera: {
      width: 1280,
      height: 720,
      fps: 30,
      bitrate_bps: input.camera_bitrate_bps,
      ...(input.camera_bitrate_minimum_bps !== undefined
        ? { minimum_bitrate_bps: input.camera_bitrate_minimum_bps }
        : {}),
      simulcast: true
    },
    screen: {
      width: 1920,
      height: 1080,
      fps: 15,
      bitrate_bps: input.screen_bitrate_bps
    },
    audio: { codec: 'opus', bitrate_bps: 32_000 },
    result_path: absolute(input.result_path, 'result path')
  };
  return {
    protocol: 'livekit_webrtc',
    source: structuredClone(input),
    executable: absolute(input.binary, 'binary'),
    binary_version: input.binary_version,
    binary_sha256: input.binary_sha256,
    args: ['run', '--input-json', '-', '--result', processInput.result_path],
    input: processInput,
    result_path: processInput.result_path,
    timeout_ms: (input.duration_seconds + 60) * 1_000
  };
}

export function evaluateLiveKitCapacityEvidence(input: {
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  expected_rooms: number;
  expected_participants: number;
  expected_camera_tracks: number;
  expected_audio_tracks: number;
  expected_screen_tracks: number;
  expected_forced_turn_participants: number;
  expected_track_egress: number;
  expected_room_composite_egress: number;
  camera_bitrate_bps: number;
  camera_bitrate_minimum_bps?: number;
  screen_bitrate_bps: number;
  expected_subscriber_video_quality?: 'auto' | 'low' | 'medium' | 'high';
  expected_receiver_jitter_buffer_target_ms?: number;
  expected_connection_preparation_mode?: 'cold' | 'signal_prewarmed';
  expected_reconnect_participants: number;
  expected_reconnect_rooms: number;
  expected_reconnect_blackout_ms: number;
  expected_reconnect_start_window_ms: number;
  quality_limits: LiveKitQualityLimits;
  binary_version: string;
  binary_sha256: string;
  raw: LiveKitCapacityRawEvidence;
}): LiveKitCapacityEvidence {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  safeId(input.binary_version, 'binary version');
  epoch(input.lease_epoch);
  sha(input.binary_sha256);
  validateQualityLimits(input.quality_limits);
  if (input.camera_bitrate_minimum_bps !== undefined) {
    bounded(
      input.camera_bitrate_minimum_bps,
      100_000,
      input.camera_bitrate_bps,
      'camera bitrate minimum'
    );
  }
  bounded(
    input.expected_reconnect_participants,
    0,
    input.expected_participants,
    'expected reconnect participants'
  );
  if (input.expected_reconnect_participants === 0) {
    bounded(input.expected_reconnect_rooms, 0, 0, 'expected reconnect rooms');
    bounded(input.expected_reconnect_blackout_ms, 0, 0, 'expected reconnect blackout');
    bounded(
      input.expected_reconnect_start_window_ms,
      0,
      0,
      'expected reconnect start window'
    );
  } else {
    bounded(
      input.expected_reconnect_rooms,
      1,
      input.expected_reconnect_participants,
      'expected reconnect rooms'
    );
    bounded(
      input.expected_reconnect_blackout_ms,
      1_000,
      30_000,
      'expected reconnect blackout'
    );
    bounded(
      input.expected_reconnect_start_window_ms,
      1,
      1_000,
      'expected reconnect start window'
    );
  }
  const raw = finiteRaw(input.raw);
  const reasons: string[] = [];
  const browserMeasurementSchema =
    raw.latency_distribution_schema_version === '1.6.0' ||
    raw.latency_distribution_schema_version === '1.7.0';
  const expectedVideoReceiverTracks =
    input.expected_camera_tracks + input.expected_screen_tracks;
  const standardFreezeTrackCount =
    raw.video_webrtc_freeze_stats_track_count ?? 0;
  const browserMeasurementInvalid = browserMeasurementSchema && (
    raw.video_freeze_measurement_scope !== 'webrtc_inbound_rtp' ||
    standardFreezeTrackCount !== expectedVideoReceiverTracks ||
    (raw.browser_event_loop_stall_max_ms ?? 0) > 500 ||
    (raw.browser_event_loop_stall_ratio ?? 0) > 0.01
  );
  const generatorInvalid = raw.generator_cpu_p95_ratio > 0.6 ||
    raw.host_cpu_p95_ratio > 0.85 ||
    raw.generator_nic_p95_ratio > 0.7 || raw.host_packet_drop_count > 0 ||
    browserMeasurementInvalid;
  if (raw.generator_cpu_p95_ratio > 0.6) reasons.push('LiveKit generator CPU P95 exceeds 60%');
  if (raw.host_cpu_p95_ratio > 0.85) reasons.push('LiveKit generator host CPU P95 exceeds 85%');
  if (raw.generator_nic_p95_ratio > 0.7) reasons.push('LiveKit generator NIC P95 exceeds 70%');
  if (raw.host_packet_drop_count > 0) reasons.push('LiveKit generator host reported packet drops');
  if (browserMeasurementSchema) {
    if (raw.video_freeze_measurement_scope !== 'webrtc_inbound_rtp') {
      reasons.push(
        'LiveKit browser standard inbound-RTP freeze evidence is unavailable'
      );
    }
    if (standardFreezeTrackCount !== expectedVideoReceiverTracks) {
      reasons.push(
        'LiveKit browser standard freeze-stat track coverage does not match expected video tracks'
      );
    }
    if ((raw.browser_event_loop_stall_max_ms ?? 0) > 500) {
      reasons.push('LiveKit browser event-loop stall maximum exceeds 500 ms');
    }
    if ((raw.browser_event_loop_stall_ratio ?? 0) > 0.01) {
      reasons.push('LiveKit browser event-loop stall ratio exceeds 1%');
    }
    if (input.expected_subscriber_video_quality !== undefined &&
        raw.camera_subscriber_video_quality !==
          input.expected_subscriber_video_quality) {
      reasons.push('LiveKit subscriber video quality does not match the plan');
    }
    if (input.expected_receiver_jitter_buffer_target_ms !== undefined) {
      exact(
        raw.receiver_jitter_buffer_target_ms ?? -1,
        input.expected_receiver_jitter_buffer_target_ms,
        'receiver jitter-buffer target',
        reasons
      );
    }
    if (input.expected_connection_preparation_mode !== undefined &&
        raw.connection_preparation_mode !==
          input.expected_connection_preparation_mode) {
      reasons.push(
        'LiveKit connection preparation mode does not match the plan'
      );
    }
  }
  positiveSamples(raw.join_sample_count, 'join', reasons);
  positiveSamples(raw.first_audio_sample_count, 'first audio', reasons);
  positiveSamples(raw.first_video_frame_sample_count, 'first video frame', reasons);
  positiveSamples(raw.glass_to_glass_sample_count, 'glass-to-glass', reasons);
  positiveSamples(raw.endpoint_packet_loss_sample_count, 'endpoint packet loss', reasons);
  positiveSamples(raw.jitter_sample_count, 'jitter', reasons);
  positiveSamples(raw.av_sync_absolute_sample_count, 'A/V sync', reasons);
  if (input.expected_screen_tracks > 0) {
    if (raw.latency_distribution_schema_version !== '1.1.0' &&
        raw.latency_distribution_schema_version !== '1.2.0' &&
        raw.latency_distribution_schema_version !== '1.3.0' &&
        raw.latency_distribution_schema_version !== '1.4.0' &&
        raw.latency_distribution_schema_version !== '1.5.0' &&
        raw.latency_distribution_schema_version !== '1.6.0' &&
        raw.latency_distribution_schema_version !== '1.7.0') {
      reasons.push('LiveKit screen latency distribution schema is missing');
    }
    positiveSamples(raw.first_screen_frame_sample_count, 'first screen frame', reasons);
    positiveSamples(raw.screen_glass_to_glass_sample_count, 'screen glass-to-glass', reasons);
  }
  exact(raw.connected_rooms, input.expected_rooms, 'connected rooms', reasons);
  exact(raw.connected_participants, input.expected_participants, 'connected participants', reasons);
  exact(raw.published_camera_tracks, input.expected_camera_tracks, 'camera tracks', reasons);
  exact(raw.published_audio_tracks, input.expected_audio_tracks, 'audio tracks', reasons);
  exact(raw.published_screen_tracks, input.expected_screen_tracks, 'screen tracks', reasons);
  exact(raw.forced_turn_participants, input.expected_forced_turn_participants, 'forced TURN participants', reasons);
  const turnConfigured = raw.forced_turn_relay_only_configured_participants ?? 0;
  const selectedTurnPairs = raw.forced_turn_selected_candidate_pair_count ?? 0;
  const relayTurnPairs = raw.forced_turn_relay_candidate_pair_count ?? 0;
  const turnRttSamples = raw.forced_turn_current_round_trip_sample_count ?? 0;
  if (input.expected_forced_turn_participants > 0) {
    if (raw.latency_distribution_schema_version !== '1.3.0' &&
        raw.latency_distribution_schema_version !== '1.4.0' &&
        raw.latency_distribution_schema_version !== '1.5.0' &&
        raw.latency_distribution_schema_version !== '1.6.0' &&
        raw.latency_distribution_schema_version !== '1.7.0') {
      reasons.push('LiveKit forced TURN selected-candidate evidence schema is missing');
    }
    exact(
      turnConfigured,
      input.expected_forced_turn_participants,
      'relay-only configured participants',
      reasons
    );
    if (raw.forced_turn_scope !== 'relay_only_selected_candidate_pair') {
      reasons.push('LiveKit forced TURN scope does not prove selected relay candidate pairs');
    }
    if (selectedTurnPairs <= 0) {
      reasons.push('LiveKit forced TURN selected candidate-pair evidence is missing');
    }
    exact(
      relayTurnPairs,
      selectedTurnPairs,
      'selected relay candidate pairs',
      reasons
    );
    if (!raw.forced_turn_transport_scope ||
        raw.forced_turn_transport_scope === 'none' ||
        raw.forced_turn_transport_scope === 'unknown') {
      reasons.push('LiveKit forced TURN transport protocol is unproven');
    }
    positiveSamples(turnRttSamples, 'forced TURN round-trip', reasons);
  } else if ((raw.latency_distribution_schema_version === '1.3.0' ||
      raw.latency_distribution_schema_version === '1.4.0' ||
      raw.latency_distribution_schema_version === '1.5.0' ||
      raw.latency_distribution_schema_version === '1.6.0' ||
      raw.latency_distribution_schema_version === '1.7.0') &&
      (turnConfigured !== 0 ||
       selectedTurnPairs !== 0 ||
       relayTurnPairs !== 0 ||
       turnRttSamples !== 0 ||
       raw.forced_turn_scope !== 'none' ||
       raw.forced_turn_transport_scope !== 'none')) {
    reasons.push('LiveKit forced TURN provenance exists without a planned TURN participant');
  }
  if (input.expected_rooms > 1) {
    if (raw.latency_distribution_schema_version !== '1.4.0' &&
        raw.latency_distribution_schema_version !== '1.5.0' &&
        raw.latency_distribution_schema_version !== '1.6.0' &&
        raw.latency_distribution_schema_version !== '1.7.0') {
      reasons.push('LiveKit room fairness evidence schema is missing');
    } else {
      exact(
        raw.room_quality_sample_count,
        input.expected_rooms,
        'room quality samples',
        reasons
      );
      minimum(
        raw.room_camera_bitrate_jain_fairness_index,
        input.quality_limits.room_camera_bitrate_jain_fairness_min,
        'room camera bitrate Jain fairness',
        reasons
      );
      minimum(
        raw.room_camera_bitrate_min_to_median_ratio,
        input.quality_limits.room_camera_bitrate_min_to_median_ratio_min,
        'room camera bitrate minimum-to-median ratio',
        reasons
      );
      maximum(
        raw.room_join_p95_max_ms,
        input.quality_limits.livekit_join_p95_ms,
        'worst-room join P95',
        reasons
      );
      maximum(
        raw.room_first_audio_p99_max_ms,
        input.quality_limits.livekit_first_audio_p99_ms,
        'worst-room first audio P99',
        reasons
      );
      maximum(
        raw.room_first_video_frame_p99_max_ms,
        input.quality_limits.livekit_first_video_frame_p99_ms,
        'worst-room first video frame P99',
        reasons
      );
      maximum(
        raw.room_glass_to_glass_p95_max_ms,
        input.quality_limits.livekit_glass_to_glass_p95_ms,
        'worst-room glass-to-glass P95',
        reasons
      );
      maximum(
        raw.room_endpoint_packet_loss_p95_max_ratio,
        input.quality_limits.endpoint_packet_loss_p95_ratio,
        'worst-room endpoint packet loss P95',
        reasons
      );
      maximum(
        raw.room_jitter_p95_max_ms,
        input.quality_limits.jitter_p95_ms,
        'worst-room jitter P95',
        reasons
      );
      maximum(
        raw.room_video_freeze_ratio_max,
        input.quality_limits.video_freeze_ratio,
        'worst-room video freeze ratio',
        reasons
      );
      maximum(
        raw.room_av_sync_absolute_p95_max_ms,
        input.quality_limits.av_sync_absolute_p95_ms,
        'worst-room A/V sync absolute P95',
        reasons
      );
    }
  }
  exact(raw.track_egress_completed, input.expected_track_egress, 'TrackEgress completions', reasons);
  exact(
    raw.room_composite_egress_completed,
    input.expected_room_composite_egress,
    'RoomComposite Egress completions',
    reasons
  );
  if (raw.encoded_video_packet_count <= 0) reasons.push('no encoded video packets were observed');
  if (raw.encoded_audio_packet_count <= 0) reasons.push('no encoded audio packets were observed');
  cameraBitrate(
    raw.camera_average_bitrate_bps,
    input.camera_bitrate_bps,
    input.camera_bitrate_minimum_bps,
    reasons
  );
  if (input.expected_screen_tracks > 0) {
    bitrate(raw.screen_average_bitrate_bps, input.screen_bitrate_bps, 'screen', reasons);
  }
  maximum(raw.join_p95_ms, input.quality_limits.livekit_join_p95_ms, 'join P95', reasons);
  maximum(raw.join_p99_ms, input.quality_limits.livekit_join_p99_ms, 'join P99', reasons);
  maximum(raw.first_audio_p99_ms, input.quality_limits.livekit_first_audio_p99_ms, 'first audio P99', reasons);
  maximum(
    raw.first_video_frame_p99_ms,
    input.quality_limits.livekit_first_video_frame_p99_ms,
    'first video frame P99',
    reasons
  );
  if (input.expected_screen_tracks > 0) {
    maximum(
      raw.first_screen_frame_p99_ms,
      input.quality_limits.livekit_first_screen_frame_p99_ms,
      'first screen frame P99',
      reasons
    );
    maximum(
      raw.screen_glass_to_glass_p95_ms,
      input.quality_limits.livekit_screen_glass_to_glass_p95_ms,
      'screen glass-to-glass P95',
      reasons
    );
  }
  maximum(
    raw.glass_to_glass_p95_ms,
    input.quality_limits.livekit_glass_to_glass_p95_ms,
    'glass-to-glass P95',
    reasons
  );
  maximum(
    raw.glass_to_glass_p99_ms,
    input.quality_limits.livekit_glass_to_glass_p99_ms,
    'glass-to-glass P99',
    reasons
  );
  maximum(
    raw.endpoint_packet_loss_p95_ratio,
    input.quality_limits.endpoint_packet_loss_p95_ratio,
    'endpoint packet loss P95',
    reasons
  );
  maximum(raw.jitter_p95_ms, input.quality_limits.jitter_p95_ms, 'jitter P95', reasons);
  maximum(raw.jitter_p99_ms, input.quality_limits.jitter_p99_ms, 'jitter P99', reasons);
  maximum(raw.video_freeze_ratio, input.quality_limits.video_freeze_ratio, 'video freeze ratio', reasons);
  maximum(
    raw.video_freezes_per_minute,
    input.quality_limits.video_freezes_per_minute,
    'video freezes per minute',
    reasons
  );
  minimum(
    raw.room_camera_receiver_frames_per_second_min,
    input.quality_limits.camera_receiver_frames_per_second_min,
    'received frame rate',
    reasons
  );
  maximum(
    raw.video_frame_gap_p95_max_ms,
    input.quality_limits.video_frame_gap_p95_ms,
    'frame-gap P95',
    reasons
  );
  maximum(
    raw.video_frame_gap_p99_max_ms,
    input.quality_limits.video_frame_gap_p99_ms,
    'frame-gap P99',
    reasons
  );
  maximum(
    raw.av_sync_absolute_p95_ms,
    input.quality_limits.av_sync_absolute_p95_ms,
    'A/V sync absolute P95',
    reasons
  );
  if (raw.audio_endpoint_scope !== 'playout') {
    reasons.push('LiveKit audio endpoint evidence did not reach playout');
  }
  exact(
    raw.reconnect_attempt_count,
    input.expected_reconnect_participants,
    'reconnect attempts',
    reasons
  );
  if (raw.reconnect_success_count > raw.reconnect_attempt_count) {
    reasons.push('LiveKit reconnect successes exceed attempts');
  }
  if (input.expected_reconnect_participants > 0) {
    if (raw.latency_distribution_schema_version !== '1.2.0' &&
        raw.latency_distribution_schema_version !== '1.3.0' &&
        raw.latency_distribution_schema_version !== '1.4.0' &&
        raw.latency_distribution_schema_version !== '1.5.0' &&
        raw.latency_distribution_schema_version !== '1.6.0' &&
        raw.latency_distribution_schema_version !== '1.7.0') {
      reasons.push('LiveKit reconnect evidence schema is missing');
    }
    if (raw.reconnect_scope !== 'room_correlated_cdp_offline') {
      reasons.push('LiveKit reconnect scope is not a controlled CDP endpoint blackout');
    }
    if (raw.reconnect_recovery_endpoint_scope !== 'decoded_audio_video') {
      reasons.push('LiveKit reconnect recovery did not reach decoded audio and video');
    }
    exact(
      raw.reconnect_blackout_ms,
      input.expected_reconnect_blackout_ms,
      'reconnect blackout milliseconds',
      reasons
    );
    if (raw.reconnect_blackout_observed_ms < input.expected_reconnect_blackout_ms * 0.9) {
      reasons.push('LiveKit observed reconnect blackout is shorter than 90% of the plan');
    }
    positiveSamples(raw.reconnect_recovery_sample_count, 'reconnect recovery', reasons);
    const reconnectSuccessRatio = raw.reconnect_success_count / raw.reconnect_attempt_count;
    if (reconnectSuccessRatio < input.quality_limits.reconnect_success_ratio) {
      reasons.push(`LiveKit reconnect success ratio ${reconnectSuccessRatio} is below ${input.quality_limits.reconnect_success_ratio}`);
    }
    maximum(
      raw.reconnect_recovery_p99_ms,
      input.quality_limits.reconnect_recovery_p99_ms,
      'reconnect recovery P99',
      reasons
    );
    if (input.expected_reconnect_rooms > 1) {
      if (raw.latency_distribution_schema_version !== '1.5.0' &&
          raw.latency_distribution_schema_version !== '1.6.0' &&
          raw.latency_distribution_schema_version !== '1.7.0') {
        reasons.push('LiveKit reconnect storm evidence schema is missing');
      } else {
        exact(
          raw.reconnect_room_count ?? 0,
          input.expected_reconnect_rooms,
          'reconnect storm rooms',
          reasons
        );
        maximum(
          raw.reconnect_attempt_start_spread_ms ?? 0,
          input.expected_reconnect_start_window_ms,
          'reconnect attempt start spread',
          reasons
        );
        exact(
          raw.reconnect_peak_attempts_per_second ?? 0,
          input.expected_reconnect_participants,
          'reconnect peak attempts per second',
          reasons
        );
        if (raw.reconnect_storm_scope !== 'multi_room_correlated_cdp_offline') {
          reasons.push('LiveKit reconnect storm scope is not multi-room correlated CDP offline');
        }
      }
    }
  } else if ((raw.latency_distribution_schema_version === '1.2.0' ||
      raw.latency_distribution_schema_version === '1.3.0' ||
      raw.latency_distribution_schema_version === '1.4.0' ||
      raw.latency_distribution_schema_version === '1.5.0' ||
      raw.latency_distribution_schema_version === '1.6.0' ||
      raw.latency_distribution_schema_version === '1.7.0') &&
      (raw.reconnect_scope !== 'none' ||
       raw.reconnect_blackout_ms !== 0 ||
       raw.reconnect_blackout_observed_ms !== 0 ||
       raw.reconnect_recovery_endpoint_scope !== 'none' ||
       (raw.reconnect_room_count ?? 0) !== 0 ||
       (raw.reconnect_attempt_start_spread_ms ?? 0) !== 0 ||
       (raw.reconnect_peak_attempts_per_second ?? 0) !== 0 ||
       raw.reconnect_storm_scope !== 'none')) {
    reasons.push('LiveKit reconnect provenance exists without a planned reconnect');
  }
  if (raw.stale_epoch_action_count > 0) reasons.push('LiveKit stale lease actions were observed');
  const passed = reasons.length === 0;
  return {
    protocol: 'livekit_webrtc',
    evidence_level: 'controlled',
    capacity_claim: 'none',
    status: passed ? 'controlled_pass'
      : generatorInvalid ? 'invalid_generator_capacity' : 'controlled_failed',
    failure_class: passed ? 'none' : generatorInvalid ? 'generator' : 'sut_or_protocol',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    reasons,
    binary_version: input.binary_version,
    binary_sha256: input.binary_sha256,
    quality_contract: {
      camera_bitrate: input.camera_bitrate_minimum_bps === undefined
        ? {
            mode: 'target_tolerance',
            target_bps: input.camera_bitrate_bps,
            tolerance_ratio: 0.1
          }
        : {
            mode: 'adaptive_minimum',
            target_bps: input.camera_bitrate_bps,
            minimum_bps: input.camera_bitrate_minimum_bps
          },
      endpoint_packet_loss_p95_ratio:
        input.quality_limits.endpoint_packet_loss_p95_ratio,
      quality_limits: structuredClone(input.quality_limits)
    },
    raw
  };
}

export function evaluateLiveKitCapacityPlanEvidence(
  plan: LiveKitCapacityPlan,
  raw: LiveKitCapacityRawEvidence
): LiveKitCapacityEvidence {
  return evaluateLiveKitCapacityEvidence({
    run_id: plan.input.run_id,
    shard_id: plan.input.shard_id,
    worker_id: plan.input.worker_id,
    lease_epoch: plan.input.lease_epoch,
    expected_rooms: plan.input.room_count,
    expected_participants: plan.input.expected_participants,
    expected_camera_tracks:
      plan.input.room_count * plan.input.camera_publishers_per_room,
    expected_audio_tracks:
      plan.input.room_count * plan.input.audio_publishers_per_room,
    expected_screen_tracks:
      plan.input.screen_room_count + plan.input.overlay_screen_room_count,
    expected_forced_turn_participants: plan.input.forced_turn_participant_count,
    expected_track_egress: plan.input.track_egress_count,
    expected_room_composite_egress: plan.input.room_composite_egress_count,
    camera_bitrate_bps: plan.input.camera.bitrate_bps,
    camera_bitrate_minimum_bps: plan.input.camera.minimum_bitrate_bps,
    screen_bitrate_bps: plan.input.screen.bitrate_bps,
    expected_subscriber_video_quality:
      plan.input.subscriber_video_quality || 'auto',
    expected_receiver_jitter_buffer_target_ms:
      plan.input.receiver_jitter_buffer_target_ms || 0,
    expected_connection_preparation_mode:
      plan.input.connection_preparation_mode || 'signal_prewarmed',
    expected_reconnect_participants: plan.input.reconnect_participant_count,
    expected_reconnect_rooms:
      plan.input.reconnect_participant_count / plan.input.participants_per_room,
    expected_reconnect_blackout_ms: plan.input.reconnect_blackout_ms,
    expected_reconnect_start_window_ms: plan.input.reconnect_start_window_ms,
    quality_limits: plan.input.quality_limits,
    binary_version: plan.binary_version,
    binary_sha256: plan.binary_sha256,
    raw
  });
}

function common(input: LiveKitCapacityPlanInput): void {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  epoch(input.lease_epoch);
  if (!input.binary_version || input.binary_version.length > 255) throw new Error('invalid LiveKit binary version');
  sha(input.binary_sha256);
  bounded(input.ordinal_start, 0, 1_000_000_000, 'ordinal start');
  bounded(input.ordinal_end_exclusive, input.ordinal_start + 1, 1_000_000_000, 'ordinal end');
}

function finiteRaw<T extends object>(raw: T): T {
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (field === 'latency_distribution_schema_version') {
      if (value !== '1.0.0' && value !== '1.1.0' &&
          value !== '1.2.0' && value !== '1.3.0' &&
          value !== '1.4.0' && value !== '1.5.0' &&
          value !== '1.6.0' && value !== '1.7.0') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'video_freeze_measurement_scope') {
      if (value !== 'webrtc_inbound_rtp' &&
          value !== 'render_callback_fallback') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'audio_endpoint_scope') {
      if (value !== 'decoded_frame' && value !== 'playout') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'camera_subscriber_video_quality') {
      if (!['auto', 'low', 'medium', 'high'].includes(String(value))) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'connection_preparation_mode') {
      if (value !== 'cold' && value !== 'signal_prewarmed') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'generator_observation_source') {
      if (value !== 'external' && value !== 'linux_proc_tree') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'reconnect_scope') {
      if (value !== 'none' && value !== 'room_correlated_cdp_offline') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'reconnect_recovery_endpoint_scope') {
      if (value !== 'none' && value !== 'decoded_audio_video') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'reconnect_storm_scope') {
      if (value !== 'none' && value !== 'multi_room_correlated_cdp_offline') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'forced_turn_scope') {
      if (value !== 'none' && value !== 'relay_only_selected_candidate_pair') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'forced_turn_transport_scope') {
      if (!['none', 'udp', 'tcp', 'mixed', 'unknown'].includes(String(value))) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'generator_network_interface') {
      if (typeof value !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value)) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'host_witness_source') {
      if (value !== 'linux_boot_id_sha256') {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (field === 'host_boot_id_sha256') {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid LiveKit evidence ${field}`);
    }
  }
  const evidence = raw as LiveKitCapacityRawEvidence;
  const hasHostWitnessSource = evidence.host_witness_source !== undefined;
  const hasHostBootHash = evidence.host_boot_id_sha256 !== undefined;
  if (hasHostWitnessSource !== hasHostBootHash) {
    throw new Error('invalid LiveKit host witness pair');
  }
  if (evidence.latency_distribution_schema_version !== '1.0.0' &&
      evidence.latency_distribution_schema_version !== '1.1.0' &&
      evidence.latency_distribution_schema_version !== '1.2.0' &&
      evidence.latency_distribution_schema_version !== '1.3.0' &&
      evidence.latency_distribution_schema_version !== '1.4.0' &&
      evidence.latency_distribution_schema_version !== '1.5.0' &&
      evidence.latency_distribution_schema_version !== '1.6.0' &&
      evidence.latency_distribution_schema_version !== '1.7.0') {
    throw new Error('invalid LiveKit latency distribution schema');
  }
  const reconnectSchema = evidence.latency_distribution_schema_version === '1.2.0' ||
    evidence.latency_distribution_schema_version === '1.3.0' ||
    evidence.latency_distribution_schema_version === '1.4.0' ||
    evidence.latency_distribution_schema_version === '1.5.0' ||
    evidence.latency_distribution_schema_version === '1.6.0' ||
    evidence.latency_distribution_schema_version === '1.7.0';
  if (reconnectSchema &&
      !['none', 'room_correlated_cdp_offline'].includes(evidence.reconnect_scope)) {
    throw new Error('invalid LiveKit reconnect scope');
  }
  if (reconnectSchema &&
      !['none', 'decoded_audio_video'].includes(
        evidence.reconnect_recovery_endpoint_scope
      )) {
    throw new Error('invalid LiveKit reconnect recovery endpoint scope');
  }
  if (evidence.latency_distribution_schema_version === '1.3.0' ||
      evidence.latency_distribution_schema_version === '1.4.0' ||
      evidence.latency_distribution_schema_version === '1.5.0' ||
      evidence.latency_distribution_schema_version === '1.6.0' ||
      evidence.latency_distribution_schema_version === '1.7.0') {
    if (!['none', 'relay_only_selected_candidate_pair'].includes(
      evidence.forced_turn_scope || ''
    )) {
      throw new Error('invalid LiveKit forced TURN scope');
    }
    if (!['none', 'udp', 'tcp', 'mixed', 'unknown'].includes(
      evidence.forced_turn_transport_scope || ''
    )) {
      throw new Error('invalid LiveKit forced TURN transport scope');
    }
    for (const field of [
      'forced_turn_relay_only_configured_participants',
      'forced_turn_selected_candidate_pair_count',
      'forced_turn_relay_candidate_pair_count',
      'forced_turn_current_round_trip_sample_count',
      'forced_turn_current_round_trip_p95_ms'
    ] as const) {
      const value = evidence[field];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
    }
  }
  if (evidence.latency_distribution_schema_version === '1.4.0' ||
      evidence.latency_distribution_schema_version === '1.5.0' ||
      evidence.latency_distribution_schema_version === '1.6.0' ||
      evidence.latency_distribution_schema_version === '1.7.0') {
    if (!Number.isSafeInteger(evidence.room_quality_sample_count) ||
        evidence.room_quality_sample_count <= 0) {
      throw new Error('invalid LiveKit evidence room_quality_sample_count');
    }
    for (const field of [
      'room_camera_bitrate_jain_fairness_index',
      'room_camera_bitrate_min_to_median_ratio',
      'room_endpoint_packet_loss_p95_max_ratio',
      'room_video_freeze_ratio_max'
    ] as const) {
      ratio(evidence[field], `LiveKit evidence ${field}`);
    }
  }
  if (evidence.latency_distribution_schema_version === '1.5.0' ||
      evidence.latency_distribution_schema_version === '1.6.0' ||
      evidence.latency_distribution_schema_version === '1.7.0') {
    if (!Number.isSafeInteger(evidence.reconnect_room_count) ||
        (evidence.reconnect_room_count ?? -1) < 0) {
      throw new Error('invalid LiveKit evidence reconnect_room_count');
    }
    if (!Number.isSafeInteger(evidence.reconnect_peak_attempts_per_second) ||
        (evidence.reconnect_peak_attempts_per_second ?? -1) < 0) {
      throw new Error('invalid LiveKit evidence reconnect_peak_attempts_per_second');
    }
    if (!Number.isFinite(evidence.reconnect_attempt_start_spread_ms) ||
        (evidence.reconnect_attempt_start_spread_ms ?? -1) < 0) {
      throw new Error('invalid LiveKit evidence reconnect_attempt_start_spread_ms');
    }
    if (!['none', 'multi_room_correlated_cdp_offline'].includes(
      evidence.reconnect_storm_scope || ''
    )) {
      throw new Error('invalid LiveKit reconnect storm scope');
    }
  }
  if (evidence.latency_distribution_schema_version === '1.6.0' ||
      evidence.latency_distribution_schema_version === '1.7.0') {
    if (evidence.video_freeze_measurement_scope !== 'webrtc_inbound_rtp' &&
        evidence.video_freeze_measurement_scope !==
          'render_callback_fallback') {
      throw new Error('invalid LiveKit video freeze measurement scope');
    }
    for (const field of [
      'video_webrtc_freeze_stats_track_count',
      'video_render_callback_freeze_count',
      'browser_event_loop_stall_count',
      'receiver_jitter_buffer_target_ms',
      'receiver_jitter_buffer_target_applied_track_count'
    ] as const) {
      if (!Number.isSafeInteger(evidence[field]) ||
          Number(evidence[field]) < 0) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
    }
    for (const field of [
      'video_render_callback_freeze_duration_ms',
      'video_render_callback_stall_overlap_duration_ms',
      'browser_event_loop_stall_duration_ms',
      'browser_event_loop_stall_max_ms'
    ] as const) {
      if (!Number.isFinite(evidence[field]) || Number(evidence[field]) < 0) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
    }
    ratio(
      Number(evidence.browser_event_loop_stall_ratio),
      'LiveKit evidence browser_event_loop_stall_ratio'
    );
    if (Number(evidence.video_render_callback_stall_overlap_duration_ms) >
        Number(evidence.video_render_callback_freeze_duration_ms)) {
      throw new Error(
        'invalid LiveKit render-callback stall overlap duration'
      );
    }
    if (Number(evidence.receiver_jitter_buffer_target_ms) > 4_000) {
      throw new Error('invalid LiveKit receiver jitter-buffer target');
    }
    if (Number(evidence.receiver_jitter_buffer_target_ms) === 0) {
      if (Number(evidence.receiver_jitter_buffer_target_applied_track_count) !== 0) {
        throw new Error(
          'invalid LiveKit default jitter-buffer applied-track evidence'
        );
      }
    } else if (Number(
      evidence.receiver_jitter_buffer_target_applied_track_count
    ) !== evidence.subscribed_tracks) {
      throw new Error(
        'invalid LiveKit receiver jitter-buffer applied-track coverage'
      );
    }
  }
  if (evidence.latency_distribution_schema_version === '1.7.0') {
    if (!['cold', 'signal_prewarmed'].includes(
      evidence.connection_preparation_mode || ''
    )) {
      throw new Error('invalid LiveKit connection preparation mode');
    }
    for (const field of [
      'primary_media_publish_completed_p99_ms',
      'remote_tracks_ready_p99_ms',
      'first_audio_after_remote_tracks_ready_p99_ms',
      'first_video_frame_after_remote_tracks_ready_p99_ms'
    ] as const) {
      if (!Number.isFinite(evidence[field]) || Number(evidence[field]) < 0) {
        throw new Error(`invalid LiveKit evidence ${field}`);
      }
    }
  }
  latencyDistribution(evidence, 'join', true);
  latencyDistribution(evidence, 'first_audio', true);
  latencyDistribution(evidence, 'first_video_frame', true);
  if (evidence.latency_distribution_schema_version === '1.1.0' ||
      evidence.latency_distribution_schema_version === '1.2.0' ||
      evidence.latency_distribution_schema_version === '1.3.0' ||
      evidence.latency_distribution_schema_version === '1.4.0' ||
      evidence.latency_distribution_schema_version === '1.5.0' ||
      evidence.latency_distribution_schema_version === '1.6.0' ||
      evidence.latency_distribution_schema_version === '1.7.0') {
    latencyDistribution(evidence, 'first_screen_frame', true);
    latencyDistribution(evidence, 'screen_glass_to_glass', true);
  }
  latencyDistribution(evidence, 'glass_to_glass', true);
  latencyDistribution(evidence, 'endpoint_packet_loss', false);
  latencyDistribution(evidence, 'jitter', true);
  latencyDistribution(evidence, 'av_sync_absolute', true);
  latencyDistribution(evidence, 'reconnect_recovery', true);
  if (!Number.isSafeInteger(evidence.generator_observation_sample_count) ||
      evidence.generator_observation_sample_count <= 0) {
    throw new Error('invalid LiveKit evidence generator_observation_sample_count');
  }
  if (!Number.isSafeInteger(evidence.generator_nic_capacity_bps) ||
      evidence.generator_nic_capacity_bps <= 0) {
    throw new Error('invalid LiveKit evidence generator_nic_capacity_bps');
  }
  return structuredClone(raw);
}

function latencyDistribution(
  evidence: LiveKitCapacityRawEvidence,
  name: 'join' | 'first_audio' | 'first_video_frame' | 'glass_to_glass' |
    'first_screen_frame' | 'screen_glass_to_glass' | 'endpoint_packet_loss' |
    'jitter' | 'av_sync_absolute' | 'reconnect_recovery',
  milliseconds: boolean
): void {
  const record = evidence as unknown as Record<string, unknown>;
  const suffix = milliseconds ? 'ms' : 'ratio';
  const sampleCount = record[`${name}_sample_count`];
  const p50 = record[`${name}_p50_${suffix}`];
  const p95 = record[`${name}_p95_${suffix}`];
  const p99 = record[`${name}_p99_${suffix}`];
  if (!Number.isSafeInteger(sampleCount) || Number(sampleCount) < 0) {
    throw new Error(`invalid LiveKit ${name} sample count`);
  }
  if (![p50, p95, p99].every((value) => typeof value === 'number' && Number.isFinite(value)) ||
      Number(p50) > Number(p95) || Number(p95) > Number(p99)) {
    throw new Error(`invalid LiveKit ${name} percentile order`);
  }
  if (!milliseconds && [p50, p95, p99].some((value) => Number(value) > 1)) {
    throw new Error(`invalid LiveKit ${name} ratio`);
  }
}

function exact(actual: number, expected: number, label: string, reasons: string[]): void {
  if (actual !== expected) reasons.push(`LiveKit ${label} ${actual} does not equal ${expected}`);
}

function bitrate(actual: number, expected: number, label: string, reasons: string[]): void {
  if (actual < expected * 0.9 || actual > expected * 1.1) {
    reasons.push(`LiveKit ${label} bitrate is outside 10% tolerance`);
  }
}

function cameraBitrate(
  actual: number,
  target: number,
  minimum: number | undefined,
  reasons: string[]
): void {
  if (minimum === undefined) {
    bitrate(actual, target, 'camera', reasons);
    return;
  }
  if (actual < minimum) {
    reasons.push(`LiveKit camera bitrate ${actual} is below adaptive minimum ${minimum}`);
  }
  if (actual > target * 1.1) {
    reasons.push('LiveKit camera bitrate exceeds 110% of the configured target');
  }
}

function maximum(actual: number, limit: number, label: string, reasons: string[]): void {
  if (actual > limit) reasons.push(`LiveKit ${label} ${actual} exceeds ${limit}`);
}

function minimum(actual: number, limit: number, label: string, reasons: string[]): void {
  if (actual < limit) reasons.push(`LiveKit ${label} ${actual} is below ${limit}`);
}

function positiveSamples(actual: number, label: string, reasons: string[]): void {
  if (actual <= 0) reasons.push(`LiveKit ${label} has no samples`);
}

function validateQualityLimits(limits: LiveKitQualityLimits): void {
  if (!limits || typeof limits !== 'object') throw new Error('invalid LiveKit quality limits');
  const ratios: Array<keyof LiveKitQualityLimits> = [
    'endpoint_packet_loss_p95_ratio',
    'video_freeze_ratio',
    'reconnect_success_ratio',
    'room_camera_bitrate_jain_fairness_min',
    'room_camera_bitrate_min_to_median_ratio_min'
  ];
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid LiveKit quality limit ${field}`);
  }
  for (const field of ratios) ratio(limits[field], `LiveKit quality limit ${field}`);
  if (limits.reconnect_success_ratio <= 0 ||
      limits.camera_receiver_frames_per_second_min <= 0 ||
      limits.room_camera_bitrate_jain_fairness_min <= 0 ||
      limits.room_camera_bitrate_min_to_median_ratio_min <= 0) {
    throw new Error('invalid LiveKit positive quality ratio');
  }
  if (limits.livekit_join_p95_ms > limits.livekit_join_p99_ms) {
    throw new Error('LiveKit join P95 limit exceeds P99 limit');
  }
  if (limits.livekit_glass_to_glass_p95_ms > limits.livekit_glass_to_glass_p99_ms) {
    throw new Error('LiveKit glass-to-glass P95 limit exceeds P99 limit');
  }
  if (limits.jitter_p95_ms > limits.jitter_p99_ms) {
    throw new Error('LiveKit jitter P95 limit exceeds P99 limit');
  }
  if (limits.video_frame_gap_p95_ms > limits.video_frame_gap_p99_ms) {
    throw new Error('LiveKit video frame-gap P95 limit exceeds P99 limit');
  }
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) throw new Error(`invalid ${label}`);
  return value;
}

function safeShard(value: string): void {
  if (!value || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]+$/.test(value)) {
    throw new Error('invalid shard ID');
  }
}

function epoch(value: string): void {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('invalid lease epoch');
}

function sha(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid SHA-256');
}

function bounded(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`invalid ${label}`);
  }
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid ${label}`);
}

function absolute(value: string, label: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value) || value.split('/').includes('..')) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}
