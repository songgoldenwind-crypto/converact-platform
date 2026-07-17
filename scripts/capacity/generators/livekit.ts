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
  screen_bitrate_bps: number;
  result_path: string;
}

export interface LiveKitCapacityProcessInput extends Record<string, unknown> {
  schema_version: '1.0.0';
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
  track_egress_count: number;
  room_composite_egress_count: number;
  duration_seconds: number;
  camera: { width: 1280; height: 720; fps: 30; bitrate_bps: number; simulcast: true };
  screen: { width: 1920; height: 1080; fps: 15; bitrate_bps: number };
  audio: { codec: 'opus'; bitrate_bps: 32_000 };
  result_path: string;
}

export interface LiveKitCapacityPlan extends ExternalJsonGeneratorPlan<LiveKitCapacityProcessInput> {
  protocol: 'livekit_webrtc';
  source: LiveKitCapacityPlanInput;
}

export interface LiveKitCapacityRawEvidence {
  connected_rooms: number;
  connected_participants: number;
  published_camera_tracks: number;
  published_audio_tracks: number;
  published_screen_tracks: number;
  subscribed_tracks: number;
  encoded_video_packet_count: number;
  encoded_audio_packet_count: number;
  camera_average_bitrate_bps: number;
  screen_average_bitrate_bps: number;
  forced_turn_participants: number;
  track_egress_completed: number;
  room_composite_egress_completed: number;
  reconnect_count: number;
  stale_epoch_action_count: number;
  generator_cpu_p95_ratio: number;
  generator_nic_p95_ratio: number;
  host_packet_drop_count: number;
}

export interface LiveKitCapacityEvidence {
  protocol: 'livekit_webrtc';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  failure_class: 'none' | 'generator' | 'sut_or_protocol';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  reasons: string[];
  binary_version: string;
  binary_sha256: string;
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
  bounded(input.screen_bitrate_bps, 100_000, 50_000_000, 'screen bitrate');
  const url = new URL(input.livekit_url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('invalid LiveKit URL');
  }
  const expectedParticipants = roomCount * input.participants_per_room;
  const processInput: LiveKitCapacityProcessInput = {
    schema_version: '1.0.0',
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
    track_egress_count: input.track_egress_count,
    room_composite_egress_count: input.room_composite_egress_count,
    duration_seconds: input.duration_seconds,
    camera: {
      width: 1280,
      height: 720,
      fps: 30,
      bitrate_bps: input.camera_bitrate_bps,
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
  screen_bitrate_bps: number;
  binary_version: string;
  binary_sha256: string;
  raw: LiveKitCapacityRawEvidence;
}): LiveKitCapacityEvidence {
  safeId(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeId(input.worker_id, 'worker ID');
  epoch(input.lease_epoch);
  sha(input.binary_sha256);
  const raw = finiteRaw(input.raw);
  const reasons: string[] = [];
  const generatorInvalid = raw.generator_cpu_p95_ratio > 0.6 ||
    raw.generator_nic_p95_ratio > 0.7 || raw.host_packet_drop_count > 0;
  if (raw.generator_cpu_p95_ratio > 0.6) reasons.push('LiveKit generator CPU P95 exceeds 60%');
  if (raw.generator_nic_p95_ratio > 0.7) reasons.push('LiveKit generator NIC P95 exceeds 70%');
  if (raw.host_packet_drop_count > 0) reasons.push('LiveKit generator host reported packet drops');
  exact(raw.connected_rooms, input.expected_rooms, 'connected rooms', reasons);
  exact(raw.connected_participants, input.expected_participants, 'connected participants', reasons);
  exact(raw.published_camera_tracks, input.expected_camera_tracks, 'camera tracks', reasons);
  exact(raw.published_audio_tracks, input.expected_audio_tracks, 'audio tracks', reasons);
  exact(raw.published_screen_tracks, input.expected_screen_tracks, 'screen tracks', reasons);
  exact(raw.forced_turn_participants, input.expected_forced_turn_participants, 'forced TURN participants', reasons);
  exact(raw.track_egress_completed, input.expected_track_egress, 'TrackEgress completions', reasons);
  exact(
    raw.room_composite_egress_completed,
    input.expected_room_composite_egress,
    'RoomComposite Egress completions',
    reasons
  );
  if (raw.encoded_video_packet_count <= 0) reasons.push('no encoded video packets were observed');
  if (raw.encoded_audio_packet_count <= 0) reasons.push('no encoded audio packets were observed');
  bitrate(raw.camera_average_bitrate_bps, input.camera_bitrate_bps, 'camera', reasons);
  if (input.expected_screen_tracks > 0) {
    bitrate(raw.screen_average_bitrate_bps, input.screen_bitrate_bps, 'screen', reasons);
  }
  if (raw.stale_epoch_action_count > 0) reasons.push('LiveKit stale lease actions were observed');
  const passed = reasons.length === 0;
  return {
    protocol: 'livekit_webrtc',
    evidence_level: 'controlled',
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
    screen_bitrate_bps: plan.input.screen.bitrate_bps,
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
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid LiveKit evidence ${field}`);
    }
  }
  return structuredClone(raw);
}

function exact(actual: number, expected: number, label: string, reasons: string[]): void {
  if (actual !== expected) reasons.push(`LiveKit ${label} ${actual} does not equal ${expected}`);
}

function bitrate(actual: number, expected: number, label: string, reasons: string[]): void {
  if (actual < expected * 0.9 || actual > expected * 1.1) {
    reasons.push(`LiveKit ${label} bitrate is outside 10% tolerance`);
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
