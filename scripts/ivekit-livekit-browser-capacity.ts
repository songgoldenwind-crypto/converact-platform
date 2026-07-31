import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  open,
  readFile,
  unlink
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  dirname,
  isAbsolute,
  join
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  LiveKitCapacityProcessInput,
  LiveKitCapacityRawEvidence
} from './capacity/generators/livekit.js';
import {
  LinuxProcessTreeObserver
} from './capacity/generators/linux-process-tree-observer.js';

export interface LiveKitBrowserTokenBundleScope {
  ordinal_start: number;
  ordinal_end_exclusive: number;
  room_prefix: string;
  participants_per_room: number;
}

export interface LiveKitBrowserTokenRecord {
  room_ordinal: number;
  participant_ordinal: number;
  room_name: string;
  identity: string;
  token: string;
}

export interface LiveKitBrowserRoomMeasurement {
  room_ordinal: number;
  connected_participants: number;
  published_camera_tracks: number;
  published_audio_tracks: number;
  published_screen_tracks: number;
  subscribed_tracks: number;
  encoded_video_packet_count: number;
  encoded_audio_packet_count: number;
  camera_bitrate_bps: number[];
  camera_total_bitrate_bps: number[];
  camera_simulcast_layer_count: number;
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
  camera_receiver_frame_width: number;
  camera_receiver_frame_height: number;
  video_frame_gap_p95_ms: number;
  video_frame_gap_p99_ms: number;
  video_frame_gap_max_ms: number;
  steady_state_warmup_ms: number;
  receiver_jitter_buffer_target_ms: number;
  receiver_jitter_buffer_target_applied_track_count: number;
  connection_preparation_mode: 'cold' | 'signal_prewarmed';
  primary_media_publish_completed_ms: number;
  remote_tracks_ready_ms: number;
  first_audio_after_remote_tracks_ready_ms: number;
  first_video_frame_after_remote_tracks_ready_ms: number;
  screen_bitrate_bps: number[];
  forced_turn_participants: number;
  forced_turn_relay_only_configured_participants: number;
  forced_turn_selected_candidate_pair_count: number;
  forced_turn_relay_candidate_pair_count: number;
  forced_turn_transport_protocols: Array<'udp' | 'tcp' | 'unknown'>;
  forced_turn_current_round_trip_ms: number[];
  forced_turn_scope: 'none' | 'relay_only_selected_candidate_pair';
  track_egress_completed: number;
  room_composite_egress_completed: number;
  join_ms: number[];
  first_audio_ms: number[];
  first_video_ms: number[];
  first_screen_frame_ms: number[];
  glass_to_glass_ms: number[];
  screen_glass_to_glass_ms: number[];
  endpoint_packet_loss_ratio: number[];
  jitter_ms: number[];
  video_freeze_duration_ms: number;
  video_observation_duration_ms: number;
  video_freeze_count: number;
  video_freeze_measurement_scope:
    'webrtc_inbound_rtp' | 'render_callback_fallback';
  video_webrtc_freeze_stats_track_count: number;
  video_render_callback_freeze_duration_ms: number;
  video_render_callback_freeze_count: number;
  video_render_callback_stall_overlap_duration_ms: number;
  measurement_window_duration_ms: number;
  browser_event_loop_stall_duration_ms: number;
  browser_event_loop_stall_count: number;
  browser_event_loop_stall_max_ms: number;
  av_sync_absolute_ms: number[];
  audio_endpoint_scope: 'decoded_frame' | 'playout';
  reconnect_attempt_count: number;
  reconnect_success_count: number;
  reconnect_recovery_ms: number[];
  reconnect_scope: 'none' | 'room_correlated_cdp_offline';
  reconnect_blackout_ms: number;
  reconnect_blackout_observed_ms: number;
  reconnect_blackout_started_at_ms: number;
  reconnect_recovery_endpoint_scope: 'none' | 'decoded_audio_video';
  stale_epoch_action_count: number;
}

export interface LiveKitBrowserGeneratorObservation {
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

export interface LiveKitBrowserCapacityArgs {
  command: 'run';
  result_path: string;
}

export interface LiveKitBrowserCapacityRuntime {
  readTokenBundle(path: string): Promise<string>;
  measureRooms(
    input: LiveKitCapacityProcessInput,
    records: readonly LiveKitBrowserTokenRecord[]
  ): Promise<LiveKitBrowserRoomMeasurement[]>;
  observeGenerator(): Promise<LiveKitBrowserGeneratorObservation>;
  writeResult(path: string, value: LiveKitCapacityRawEvidence): Promise<void>;
}

interface BrowserPageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  addScriptTag(options: { path?: string; content?: string }): Promise<unknown>;
  evaluate<Result, Argument>(
    pageFunction: (argument: Argument) => Result | Promise<Result>,
    argument: Argument
  ): Promise<Result>;
  waitForFunction(
    pageFunction: () => unknown,
    argument?: unknown,
    options?: { timeout?: number }
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface CDPSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>;
  newCDPSession(page: BrowserPageLike): Promise<CDPSessionLike>;
  close(): Promise<void>;
}

interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

interface PlaywrightLike {
  chromium: {
    launch(options?: Record<string, unknown>): Promise<BrowserLike>;
  };
}

interface LiveKitBaselinePageInput {
  livekit_url: string;
  duration_seconds: number;
  camera: LiveKitCapacityProcessInput['camera'];
  video_publish_options: LiveKitVideoPublishOptions;
  screen: LiveKitCapacityProcessInput['screen'];
  audio: LiveKitCapacityProcessInput['audio'];
  publish_screen: boolean;
  expected_forced_turn_participants: number;
  expected_reconnect_participants: number;
  reconnect_blackout_ms: number;
  subscriber_video_quality: 'auto' | 'low' | 'medium' | 'high';
  receiver_jitter_buffer_target_ms: number;
  connection_preparation_mode: 'cold' | 'signal_prewarmed';
  records: LiveKitBrowserTokenRecord[];
}

export interface LiveKitVideoPublishOptions {
  simulcast: boolean;
  backupCodec?: false;
  degradationPreference?: 'maintain-framerate';
  videoEncoding: {
    maxBitrate: number;
    maxFramerate: number;
  };
  videoSimulcastLayers: Array<{
    width: number;
    height: number;
    encoding: {
      maxBitrate: number;
      maxFramerate: number;
    };
  }>;
}

interface LiveKitReconnectPageLike {
  waitForFunction(
    pageFunction: () => unknown,
    argument?: unknown,
    options?: { timeout?: number }
  ): Promise<unknown>;
  evaluate(
    pageFunction: (phase: string) => unknown,
    phase: string
  ): Promise<unknown>;
}

export async function executeLiveKitBrowserReconnectBlackout(input: {
  page: LiveKitReconnectPageLike;
  cdp: CDPSessionLike;
  blackout_ms: number;
  warmup_ms?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const sleep = input.sleep || ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const warmupMs = input.warmup_ms ?? 2_000;
  if (!Number.isSafeInteger(input.blackout_ms) ||
      input.blackout_ms < 1_000 || input.blackout_ms > 30_000) {
    throw new Error('LiveKit reconnect blackout milliseconds are invalid');
  }
  if (!Number.isSafeInteger(warmupMs) || warmupMs < 0 || warmupMs > 30_000) {
    throw new Error('LiveKit reconnect warmup milliseconds are invalid');
  }

  let networkEnabled = false;
  let blackoutStarted = false;
  let offline = false;
  let restored = false;
  const setOffline = async (value: boolean) => {
    await input.cdp.send('Network.emulateNetworkConditions', {
      offline: value,
      latency: 0,
      downloadThroughput: value ? 0 : -1,
      uploadThroughput: value ? 0 : -1,
      connectionType: value ? 'none' : 'wifi'
    });
  };
  const markPhase = async (phase: 'blackout_started' | 'restored') => {
    await input.page.evaluate((value) => {
      const state = globalThis as typeof globalThis & {
        __IVEKIT_CAPACITY_RECONNECT_CONTROL__?: {
          blackout_started_at: number;
          restored_at: number;
        };
      };
      const control = state.__IVEKIT_CAPACITY_RECONNECT_CONTROL__;
      if (!control) throw new Error('LiveKit reconnect page control is unavailable');
      const now = performance.timeOrigin + performance.now();
      if (value === 'blackout_started') control.blackout_started_at = now;
      if (value === 'restored') control.restored_at = now;
    }, phase);
  };

  try {
    await input.page.waitForFunction(
      () => Boolean(
        (globalThis as typeof globalThis & {
          __IVEKIT_CAPACITY_RECONNECT_CONTROL__?: { media_ready?: boolean };
        }).__IVEKIT_CAPACITY_RECONNECT_CONTROL__?.media_ready
      ),
      undefined,
      { timeout: 30_000 }
    );
    await input.cdp.send('Network.enable');
    networkEnabled = true;
    await sleep(warmupMs);
    await markPhase('blackout_started');
    blackoutStarted = true;
    await setOffline(true);
    offline = true;
    await sleep(input.blackout_ms);
    await setOffline(false);
    offline = false;
    await markPhase('restored');
    restored = true;
  } finally {
    if (offline) await setOffline(false).catch(() => undefined);
    if (blackoutStarted && !restored) {
      await markPhase('restored').catch(() => undefined);
    }
    if (networkEnabled) {
      await input.cdp.send('Network.disable').catch(() => undefined);
    }
    await input.cdp.detach().catch(() => undefined);
  }
}

const VISUAL_MARKER_SYNC = [true, false, true, false] as const;
const VISUAL_MARKER_BITS = 16;
const VISUAL_MARKER_LENGTH = VISUAL_MARKER_SYNC.length + VISUAL_MARKER_BITS + 8;

export interface LiveKitStatsReportLike {
  forEach(
    callback: (value: Record<string, unknown>, key: unknown) => void
  ): void;
}

export interface LiveKitSelectedIceCandidatePairEvidence {
  selected_pair_count: number;
  relay_pair_count: number;
  transport_protocols: Array<'udp' | 'tcp' | 'unknown'>;
  current_round_trip_ms: number[];
}

export interface LiveKitInboundVideoStatsEvidence {
  inbound_video_stream_count: number;
  standard_freeze_stats_available: boolean;
  freeze_count: number;
  total_freeze_duration_ms: number;
  frames_decoded: number;
  key_frames_decoded: number;
  pli_count: number;
  fir_count: number;
  nack_count: number;
}

export function inspectLiveKitInboundVideoStats(
  report: LiveKitStatsReportLike
): LiveKitInboundVideoStatsEvidence {
  let inboundVideoStreamCount = 0;
  let standardFreezeStatsAvailable = false;
  let freezeCount = 0;
  let totalFreezeDurationMs = 0;
  let framesDecoded = 0;
  let keyFramesDecoded = 0;
  let pliCount = 0;
  let firCount = 0;
  let nackCount = 0;
  const metric = (value: unknown): number => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  };

  report.forEach((value) => {
    const video = value.type === 'inbound-rtp' &&
      (value.kind === 'video' ||
       value.mediaType === 'video' ||
       value.framesDecoded !== undefined);
    if (!video) return;
    inboundVideoStreamCount += 1;
    if (Number.isFinite(Number(value.freezeCount)) &&
        Number.isFinite(Number(value.totalFreezesDuration))) {
      standardFreezeStatsAvailable = true;
      freezeCount += metric(value.freezeCount);
      totalFreezeDurationMs += metric(value.totalFreezesDuration) * 1_000;
    }
    framesDecoded += metric(value.framesDecoded);
    keyFramesDecoded += metric(value.keyFramesDecoded);
    pliCount += metric(value.pliCount);
    firCount += metric(value.firCount);
    nackCount += metric(value.nackCount);
  });

  return {
    inbound_video_stream_count: inboundVideoStreamCount,
    standard_freeze_stats_available: standardFreezeStatsAvailable,
    freeze_count: freezeCount,
    total_freeze_duration_ms: totalFreezeDurationMs,
    frames_decoded: framesDecoded,
    key_frames_decoded: keyFramesDecoded,
    pli_count: pliCount,
    fir_count: firCount,
    nack_count: nackCount
  };
}

export function inspectLiveKitSelectedIceCandidatePairs(
  reports: readonly LiveKitStatsReportLike[]
): LiveKitSelectedIceCandidatePairEvidence {
  let selectedPairCount = 0;
  let relayPairCount = 0;
  const transportProtocols: Array<'udp' | 'tcp' | 'unknown'> = [];
  const currentRoundTripMs: number[] = [];

  for (const report of reports) {
    const stats = new Map<string, Record<string, unknown>>();
    report.forEach((value, key) => {
      const id = typeof value.id === 'string'
        ? value.id
        : typeof key === 'string' ? key : '';
      if (id) stats.set(id, value);
    });
    const selectedIds = new Set<string>();
    for (const value of stats.values()) {
      if (value.type === 'transport' &&
          typeof value.selectedCandidatePairId === 'string') {
        selectedIds.add(value.selectedCandidatePairId);
      }
    }
    if (selectedIds.size === 0) {
      for (const [id, value] of stats) {
        if (value.type === 'candidate-pair' &&
            value.state === 'succeeded' &&
            (value.selected === true || value.nominated === true)) {
          selectedIds.add(id);
        }
      }
    }
    for (const pairId of selectedIds) {
      const pair = stats.get(pairId);
      if (!pair || pair.type !== 'candidate-pair') continue;
      const local = typeof pair.localCandidateId === 'string'
        ? stats.get(pair.localCandidateId)
        : undefined;
      selectedPairCount += 1;
      if (local?.candidateType === 'relay') relayPairCount += 1;
      const protocol = String(local?.relayProtocol || local?.protocol || '').toLowerCase();
      transportProtocols.push(protocol === 'udp' || protocol === 'tcp'
        ? protocol
        : 'unknown');
      const currentRoundTripTime = Number(pair.currentRoundTripTime);
      if (Number.isFinite(currentRoundTripTime) && currentRoundTripTime >= 0) {
        currentRoundTripMs.push(currentRoundTripTime * 1_000);
      }
    }
  }

  return {
    selected_pair_count: selectedPairCount,
    relay_pair_count: relayPairCount,
    transport_protocols: transportProtocols,
    current_round_trip_ms: currentRoundTripMs
  };
}

export const LIVEKIT_BROWSER_PAGE_BOOTSTRAP = [
  'var __name = function(target) { return target; };',
  `globalThis.__IVEKIT_INSPECT_INBOUND_VIDEO_STATS__ = (${
    inspectLiveKitInboundVideoStats.toString()
  });`,
  `globalThis.__IVEKIT_INSPECT_SELECTED_ICE_CANDIDATE_PAIRS__ = (${
    inspectLiveKitSelectedIceCandidatePairs.toString()
  });`
].join('\n');

export function parseLiveKitBrowserTokenBundle(
  raw: string,
  scope: LiveKitBrowserTokenBundleScope
): LiveKitBrowserTokenRecord[] {
  validateTokenBundleScope(scope);
  if (Buffer.byteLength(raw, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('LiveKit token bundle exceeds 64 MiB');
  }
  const records: LiveKitBrowserTokenRecord[] = [];
  const coordinates = new Set<string>();
  const identities = new Set<string>();
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const record = parseTokenRecord(line, index + 1, scope);
    const coordinate = `${record.room_ordinal}:${record.participant_ordinal}`;
    if (coordinates.has(coordinate)) {
      throw new Error(`LiveKit token bundle contains duplicate participant coordinates at line ${index + 1}`);
    }
    if (identities.has(record.identity)) {
      throw new Error(`LiveKit token bundle contains duplicate participant identity at line ${index + 1}`);
    }
    coordinates.add(coordinate);
    identities.add(record.identity);
    records.push(record);
  }

  const expected = (scope.ordinal_end_exclusive - scope.ordinal_start) *
    scope.participants_per_room;
  if (records.length !== expected) {
    throw new Error(`LiveKit token bundle coverage ${records.length} does not equal expected ${expected}`);
  }
  for (let room = scope.ordinal_start; room < scope.ordinal_end_exclusive; room += 1) {
    for (let participant = 0; participant < scope.participants_per_room; participant += 1) {
      if (!coordinates.has(`${room}:${participant}`)) {
        throw new Error('LiveKit token bundle does not exactly cover the declared room and participant range');
      }
    }
  }
  return records.sort((left, right) =>
    left.room_ordinal - right.room_ordinal ||
    left.participant_ordinal - right.participant_ordinal
  );
}

export function encodeLiveKitVisualMarker(marker: number): boolean[] {
  if (!Number.isInteger(marker) || marker < 0 || marker > 0xffff) {
    throw new Error('LiveKit visual marker must be an unsigned 16-bit integer');
  }
  const data = Array.from(
    { length: VISUAL_MARKER_BITS },
    (_, index) => Boolean(marker & (1 << (VISUAL_MARKER_BITS - index - 1)))
  );
  const checksum = crc8(marker);
  return [
    ...VISUAL_MARKER_SYNC,
    ...data,
    ...Array.from(
      { length: 8 },
      (_, index) => Boolean(checksum & (1 << (7 - index)))
    )
  ];
}

export function decodeLiveKitVisualMarker(luminance: readonly number[]): number | null {
  if (luminance.length !== VISUAL_MARKER_LENGTH ||
      luminance.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return null;
  }
  const bits = luminance.map((value) => value >= 128);
  if (VISUAL_MARKER_SYNC.some((expected, index) => bits[index] !== expected)) {
    return null;
  }
  let marker = 0;
  for (let index = 0; index < VISUAL_MARKER_BITS; index += 1) {
    marker = (marker << 1) | Number(bits[VISUAL_MARKER_SYNC.length + index]);
  }
  let checksum = 0;
  for (let index = 0; index < 8; index += 1) {
    checksum = (checksum << 1) |
      Number(bits[VISUAL_MARKER_SYNC.length + VISUAL_MARKER_BITS + index]);
  }
  return checksum === crc8(marker) ? marker : null;
}

export function summarizeLiveKitBrowserMeasurements(
  measurements: readonly LiveKitBrowserRoomMeasurement[],
  generator: LiveKitBrowserGeneratorObservation
): LiveKitCapacityRawEvidence {
  if (measurements.length === 0) throw new Error('LiveKit browser measurements are empty');
  validateGeneratorObservation(generator);
  const rooms = new Set<number>();
  for (const measurement of measurements) {
    validateRoomMeasurement(measurement);
    if (rooms.has(measurement.room_ordinal)) {
      throw new Error(`LiveKit browser room ${measurement.room_ordinal} is duplicated`);
    }
    rooms.add(measurement.room_ordinal);
  }
  const joins = measurements.flatMap((measurement) => measurement.join_ms);
  const firstAudio = measurements.flatMap((measurement) => measurement.first_audio_ms);
  const firstVideo = measurements.flatMap((measurement) => measurement.first_video_ms);
  const firstScreen = measurements.flatMap((measurement) => measurement.first_screen_frame_ms);
  const glassToGlass = measurements.flatMap((measurement) => measurement.glass_to_glass_ms);
  const screenGlassToGlass = measurements.flatMap(
    (measurement) => measurement.screen_glass_to_glass_ms
  );
  const packetLoss = measurements.flatMap((measurement) => measurement.endpoint_packet_loss_ratio);
  const jitter = measurements.flatMap((measurement) => measurement.jitter_ms);
  const avSync = measurements.flatMap((measurement) => measurement.av_sync_absolute_ms);
  const forcedTurnConfigured = sum(measurements.map(
    (measurement) => measurement.forced_turn_relay_only_configured_participants
  ));
  const forcedTurnProtocols = measurements.flatMap(
    (measurement) => measurement.forced_turn_transport_protocols
  );
  const forcedTurnRoundTrips = measurements.flatMap(
    (measurement) => measurement.forced_turn_current_round_trip_ms
  );
  const forcedTurnTransportSet = new Set(forcedTurnProtocols);
  const forcedTurnTransportScope = forcedTurnTransportSet.size === 0
    ? 'none'
    : forcedTurnTransportSet.has('unknown')
      ? forcedTurnTransportSet.size === 1 ? 'unknown' : 'mixed'
      : forcedTurnTransportSet.size === 1
        ? [...forcedTurnTransportSet][0]
        : 'mixed';
  const audioEndpointScopes = new Set(
    measurements.map((measurement) => measurement.audio_endpoint_scope)
  );
  if (audioEndpointScopes.size !== 1) {
    throw new Error('LiveKit browser audio endpoint scopes are inconsistent');
  }
  const reconnectRecovery = measurements.flatMap((measurement) => measurement.reconnect_recovery_ms);
  const reconnectMeasurements = measurements.filter(
    (measurement) => measurement.reconnect_attempt_count > 0
  );
  const reconnectBlackouts = new Set(
    reconnectMeasurements.map((measurement) => measurement.reconnect_blackout_ms)
  );
  const reconnectScopes = new Set(
    reconnectMeasurements.map((measurement) => measurement.reconnect_scope)
  );
  const reconnectEndpointScopes = new Set(
    reconnectMeasurements.map(
      (measurement) => measurement.reconnect_recovery_endpoint_scope
    )
  );
  if (reconnectBlackouts.size > 1 || reconnectScopes.size > 1 ||
      reconnectEndpointScopes.size > 1) {
    throw new Error('LiveKit browser reconnect evidence is inconsistent across rooms');
  }
  const reconnectStarts = reconnectMeasurements.map((measurement) => ({
    started_at_ms: measurement.reconnect_blackout_started_at_ms,
    attempt_count: measurement.reconnect_attempt_count
  }));
  const reconnectStartSpreadMs = reconnectStarts.length > 1
    ? Math.max(...reconnectStarts.map((start) => start.started_at_ms)) -
      Math.min(...reconnectStarts.map((start) => start.started_at_ms))
    : 0;
  const freezeDuration = sum(measurements.map((measurement) => measurement.video_freeze_duration_ms));
  const videoDuration = sum(measurements.map((measurement) => measurement.video_observation_duration_ms));
  const freezeCount = sum(measurements.map((measurement) => measurement.video_freeze_count));
  const freezeMeasurementScopes = new Set(
    measurements.map((measurement) => measurement.video_freeze_measurement_scope)
  );
  if (freezeMeasurementScopes.size !== 1) {
    throw new Error('LiveKit browser freeze measurement scopes are inconsistent');
  }
  const renderCallbackFreezeDuration = sum(
    measurements.map(
      (measurement) => measurement.video_render_callback_freeze_duration_ms
    )
  );
  const renderCallbackFreezeCount = sum(
    measurements.map((measurement) => measurement.video_render_callback_freeze_count)
  );
  const renderCallbackStallOverlapDuration = sum(
    measurements.map(
      (measurement) =>
        measurement.video_render_callback_stall_overlap_duration_ms
    )
  );
  const measurementWindowDuration = sum(
    measurements.map((measurement) => measurement.measurement_window_duration_ms)
  );
  const eventLoopStallDuration = sum(
    measurements.map((measurement) => measurement.browser_event_loop_stall_duration_ms)
  );
  const eventLoopStallCount = sum(
    measurements.map((measurement) => measurement.browser_event_loop_stall_count)
  );
  const warmupDurations = new Set(
    measurements.map((measurement) => measurement.steady_state_warmup_ms)
  );
  if (warmupDurations.size !== 1) {
    throw new Error('LiveKit browser steady-state warmup is inconsistent across rooms');
  }
  const subscriberVideoQualities = new Set(
    measurements.map((measurement) => measurement.camera_subscriber_video_quality)
  );
  if (subscriberVideoQualities.size !== 1) {
    throw new Error('LiveKit browser subscriber video quality is inconsistent across rooms');
  }
  const receiverJitterBufferTargets = new Set(
    measurements.map(
      (measurement) => measurement.receiver_jitter_buffer_target_ms
    )
  );
  if (receiverJitterBufferTargets.size !== 1) {
    throw new Error(
      'LiveKit browser receiver jitter-buffer targets are inconsistent across rooms'
    );
  }
  const connectionPreparationModes = new Set(
    measurements.map((measurement) => measurement.connection_preparation_mode)
  );
  if (connectionPreparationModes.size !== 1) {
    throw new Error(
      'LiveKit browser connection preparation modes are inconsistent across rooms'
    );
  }
  const roomCameraBitrates = measurements.map(
    (measurement) => mean(measurement.camera_bitrate_bps)
  );
  const roomCameraReceiverFramesPerSecond = measurements.map(
    (measurement) =>
      measurement.camera_receiver_frames_decoded /
      (measurement.video_observation_duration_ms / 1_000)
  );
  const roomCameraBitrateMedian = percentile(roomCameraBitrates, 0.5);

  return {
    latency_distribution_schema_version: '1.7.0',
    connected_rooms: measurements.length,
    connected_participants: sum(measurements.map((measurement) => measurement.connected_participants)),
    published_camera_tracks: sum(measurements.map((measurement) => measurement.published_camera_tracks)),
    published_audio_tracks: sum(measurements.map((measurement) => measurement.published_audio_tracks)),
    published_screen_tracks: sum(measurements.map((measurement) => measurement.published_screen_tracks)),
    subscribed_tracks: sum(measurements.map((measurement) => measurement.subscribed_tracks)),
    encoded_video_packet_count: sum(measurements.map((measurement) => measurement.encoded_video_packet_count)),
    encoded_audio_packet_count: sum(measurements.map((measurement) => measurement.encoded_audio_packet_count)),
    camera_average_bitrate_bps: mean(
      measurements.flatMap((measurement) => measurement.camera_bitrate_bps)
    ),
    camera_total_average_bitrate_bps: mean(
      measurements.flatMap((measurement) => measurement.camera_total_bitrate_bps)
    ),
    camera_simulcast_layer_count_max: Math.max(
      ...measurements.map((measurement) => measurement.camera_simulcast_layer_count)
    ),
    camera_primary_target_bitrate_bps: mean(
      measurements.map((measurement) => measurement.camera_primary_target_bitrate_bps)
    ),
    camera_primary_frame_width: mean(
      measurements.map((measurement) => measurement.camera_primary_frame_width)
    ),
    camera_primary_frame_height: mean(
      measurements.map((measurement) => measurement.camera_primary_frame_height)
    ),
    camera_primary_frames_per_second: mean(
      measurements.map((measurement) => measurement.camera_primary_frames_per_second)
    ),
    camera_sender_bandwidth_limited_seconds: sum(
      measurements.map(
        (measurement) => measurement.camera_sender_bandwidth_limited_seconds
      )
    ),
    camera_sender_cpu_limited_seconds: sum(
      measurements.map((measurement) => measurement.camera_sender_cpu_limited_seconds)
    ),
    camera_receiver_frames_decoded: sum(
      measurements.map((measurement) => measurement.camera_receiver_frames_decoded)
    ),
    camera_receiver_frames_dropped: sum(
      measurements.map((measurement) => measurement.camera_receiver_frames_dropped)
    ),
    camera_receiver_frames_received: sum(
      measurements.map((measurement) => measurement.camera_receiver_frames_received)
    ),
    camera_subscriber_video_quality:
      measurements[0].camera_subscriber_video_quality,
    camera_receiver_frame_width_min: Math.min(
      ...measurements.map((measurement) => measurement.camera_receiver_frame_width)
    ),
    camera_receiver_frame_height_min: Math.min(
      ...measurements.map((measurement) => measurement.camera_receiver_frame_height)
    ),
    camera_receiver_frames_per_second:
      sum(measurements.map((measurement) => measurement.camera_receiver_frames_decoded)) /
      (videoDuration / 1_000),
    room_camera_receiver_frames_per_second_min:
      Math.min(...roomCameraReceiverFramesPerSecond),
    video_frame_gap_p95_max_ms: Math.max(
      ...measurements.map((measurement) => measurement.video_frame_gap_p95_ms)
    ),
    video_frame_gap_p99_max_ms: Math.max(
      ...measurements.map((measurement) => measurement.video_frame_gap_p99_ms)
    ),
    video_frame_gap_max_ms: Math.max(
      ...measurements.map((measurement) => measurement.video_frame_gap_max_ms)
    ),
    steady_state_warmup_ms: measurements[0].steady_state_warmup_ms,
    receiver_jitter_buffer_target_ms:
      measurements[0].receiver_jitter_buffer_target_ms,
    receiver_jitter_buffer_target_applied_track_count: sum(
      measurements.map(
        (measurement) =>
          measurement.receiver_jitter_buffer_target_applied_track_count
      )
    ),
    connection_preparation_mode: measurements[0].connection_preparation_mode,
    primary_media_publish_completed_p99_ms: percentile(
      measurements.map(
        (measurement) => measurement.primary_media_publish_completed_ms
      ),
      0.99
    ),
    remote_tracks_ready_p99_ms: percentile(
      measurements.map((measurement) => measurement.remote_tracks_ready_ms),
      0.99
    ),
    first_audio_after_remote_tracks_ready_p99_ms: percentile(
      measurements.map(
        (measurement) =>
          measurement.first_audio_after_remote_tracks_ready_ms
      ),
      0.99
    ),
    first_video_frame_after_remote_tracks_ready_p99_ms: percentile(
      measurements.map(
        (measurement) =>
          measurement.first_video_frame_after_remote_tracks_ready_ms
      ),
      0.99
    ),
    screen_average_bitrate_bps: mean(
      measurements.flatMap((measurement) => measurement.screen_bitrate_bps),
      true
    ),
    room_quality_sample_count: measurements.length,
    room_camera_bitrate_jain_fairness_index: jainFairness(roomCameraBitrates),
    room_camera_bitrate_min_to_median_ratio:
      Math.min(...roomCameraBitrates) / roomCameraBitrateMedian,
    room_join_p95_max_ms: Math.max(...measurements.map(
      (measurement) => percentile(measurement.join_ms, 0.95)
    )),
    room_first_audio_p99_max_ms: Math.max(...measurements.map(
      (measurement) => percentile(measurement.first_audio_ms, 0.99)
    )),
    room_first_video_frame_p99_max_ms: Math.max(...measurements.map(
      (measurement) => percentile(measurement.first_video_ms, 0.99)
    )),
    room_glass_to_glass_p95_max_ms: Math.max(...measurements.map(
      (measurement) => percentile(measurement.glass_to_glass_ms, 0.95)
    )),
    room_endpoint_packet_loss_p95_max_ratio: Math.max(...measurements.map(
      (measurement) => percentile(measurement.endpoint_packet_loss_ratio, 0.95)
    )),
    room_jitter_p95_max_ms: Math.max(...measurements.map(
      (measurement) => percentile(measurement.jitter_ms, 0.95)
    )),
    room_video_freeze_ratio_max: Math.max(...measurements.map(
      (measurement) =>
        measurement.video_freeze_duration_ms / measurement.video_observation_duration_ms
    )),
    room_av_sync_absolute_p95_max_ms: Math.max(...measurements.map(
      (measurement) => percentile(measurement.av_sync_absolute_ms, 0.95)
    )),
    forced_turn_participants: sum(measurements.map((measurement) => measurement.forced_turn_participants)),
    forced_turn_relay_only_configured_participants: forcedTurnConfigured,
    forced_turn_selected_candidate_pair_count: sum(measurements.map(
      (measurement) => measurement.forced_turn_selected_candidate_pair_count
    )),
    forced_turn_relay_candidate_pair_count: sum(measurements.map(
      (measurement) => measurement.forced_turn_relay_candidate_pair_count
    )),
    forced_turn_scope: forcedTurnConfigured > 0
      ? 'relay_only_selected_candidate_pair'
      : 'none',
    forced_turn_transport_scope: forcedTurnTransportScope,
    forced_turn_current_round_trip_sample_count: forcedTurnRoundTrips.length,
    forced_turn_current_round_trip_p95_ms: percentileOrZero(
      forcedTurnRoundTrips,
      0.95
    ),
    track_egress_completed: sum(measurements.map((measurement) => measurement.track_egress_completed)),
    room_composite_egress_completed: sum(
      measurements.map((measurement) => measurement.room_composite_egress_completed)
    ),
    join_sample_count: joins.length,
    join_p50_ms: percentile(joins, 0.5),
    join_p95_ms: percentile(joins, 0.95),
    join_p99_ms: percentile(joins, 0.99),
    first_audio_sample_count: firstAudio.length,
    first_audio_p50_ms: percentile(firstAudio, 0.5),
    first_audio_p95_ms: percentile(firstAudio, 0.95),
    first_audio_p99_ms: percentile(firstAudio, 0.99),
    first_video_frame_sample_count: firstVideo.length,
    first_video_frame_p50_ms: percentile(firstVideo, 0.5),
    first_video_frame_p95_ms: percentile(firstVideo, 0.95),
    first_video_frame_p99_ms: percentile(firstVideo, 0.99),
    first_screen_frame_sample_count: firstScreen.length,
    first_screen_frame_p50_ms: percentileOrZero(firstScreen, 0.5),
    first_screen_frame_p95_ms: percentileOrZero(firstScreen, 0.95),
    first_screen_frame_p99_ms: percentileOrZero(firstScreen, 0.99),
    glass_to_glass_sample_count: glassToGlass.length,
    glass_to_glass_p50_ms: percentile(glassToGlass, 0.5),
    glass_to_glass_p95_ms: percentile(glassToGlass, 0.95),
    glass_to_glass_p99_ms: percentile(glassToGlass, 0.99),
    screen_glass_to_glass_sample_count: screenGlassToGlass.length,
    screen_glass_to_glass_p50_ms: percentileOrZero(screenGlassToGlass, 0.5),
    screen_glass_to_glass_p95_ms: percentileOrZero(screenGlassToGlass, 0.95),
    screen_glass_to_glass_p99_ms: percentileOrZero(screenGlassToGlass, 0.99),
    endpoint_packet_loss_sample_count: packetLoss.length,
    endpoint_packet_loss_p50_ratio: percentile(packetLoss, 0.5),
    endpoint_packet_loss_p95_ratio: percentile(packetLoss, 0.95),
    endpoint_packet_loss_p99_ratio: percentile(packetLoss, 0.99),
    jitter_sample_count: jitter.length,
    jitter_p50_ms: percentile(jitter, 0.5),
    jitter_p95_ms: percentile(jitter, 0.95),
    jitter_p99_ms: percentile(jitter, 0.99),
    video_freeze_ratio: freezeDuration / videoDuration,
    video_freezes_per_minute: freezeCount / (videoDuration / 60_000),
    video_freeze_measurement_scope: measurements[0].video_freeze_measurement_scope,
    video_webrtc_freeze_stats_track_count: sum(
      measurements.map(
        (measurement) => measurement.video_webrtc_freeze_stats_track_count
      )
    ),
    video_render_callback_freeze_duration_ms: renderCallbackFreezeDuration,
    video_render_callback_freeze_count: renderCallbackFreezeCount,
    video_render_callback_stall_overlap_duration_ms:
      renderCallbackStallOverlapDuration,
    browser_event_loop_stall_duration_ms: eventLoopStallDuration,
    browser_event_loop_stall_count: eventLoopStallCount,
    browser_event_loop_stall_max_ms: Math.max(
      ...measurements.map(
        (measurement) => measurement.browser_event_loop_stall_max_ms
      )
    ),
    browser_event_loop_stall_ratio:
      eventLoopStallDuration / measurementWindowDuration,
    av_sync_absolute_sample_count: avSync.length,
    av_sync_absolute_p50_ms: percentile(avSync, 0.5),
    av_sync_absolute_p95_ms: percentile(avSync, 0.95),
    av_sync_absolute_p99_ms: percentile(avSync, 0.99),
    audio_endpoint_scope: measurements[0].audio_endpoint_scope,
    reconnect_attempt_count: sum(
      measurements.map((measurement) => measurement.reconnect_attempt_count)
    ),
    reconnect_success_count: sum(
      measurements.map((measurement) => measurement.reconnect_success_count)
    ),
    reconnect_recovery_sample_count: reconnectRecovery.length,
    reconnect_recovery_p50_ms: reconnectRecovery.length
      ? percentile(reconnectRecovery, 0.5)
      : 0,
    reconnect_recovery_p95_ms: reconnectRecovery.length
      ? percentile(reconnectRecovery, 0.95)
      : 0,
    reconnect_recovery_p99_ms: reconnectRecovery.length
      ? percentile(reconnectRecovery, 0.99)
      : 0,
    reconnect_scope: reconnectMeasurements[0]?.reconnect_scope || 'none',
    reconnect_blackout_ms: reconnectMeasurements[0]?.reconnect_blackout_ms || 0,
    reconnect_blackout_observed_ms: reconnectMeasurements.length
      ? percentile(
        reconnectMeasurements.map(
          (measurement) => measurement.reconnect_blackout_observed_ms
        ),
        0.95
      )
      : 0,
    reconnect_recovery_endpoint_scope:
      reconnectMeasurements[0]?.reconnect_recovery_endpoint_scope || 'none',
    reconnect_room_count: reconnectMeasurements.length,
    reconnect_attempt_start_spread_ms: reconnectStartSpreadMs,
    reconnect_peak_attempts_per_second:
      peakReconnectAttemptsPerSecond(reconnectStarts),
    reconnect_storm_scope: reconnectMeasurements.length > 1
      ? 'multi_room_correlated_cdp_offline'
      : 'none',
    stale_epoch_action_count: sum(
      measurements.map((measurement) => measurement.stale_epoch_action_count)
    ),
    ...generator
  };
}

export function validateLiveKitBrowserBaselineInput(
  value: unknown
): asserts value is LiveKitCapacityProcessInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LiveKit browser input must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input.schema_version !== '1.3.0' || input.layout !== 'many_small_rooms') {
    throw new Error('LiveKit browser input schema or layout is unsupported');
  }
  safeIdentifier(input.run_id, 'run ID');
  safeShard(input.shard_id);
  safeIdentifier(input.worker_id, 'worker ID');
  if (!/^[1-9][0-9]{0,18}$/.test(String(input.lease_epoch || ''))) {
    throw new Error('LiveKit browser lease epoch is invalid');
  }
  const ordinalStart = baselineInteger(input.ordinal_start, 0, 10_000_000, 'room ordinal start');
  const ordinalEnd = baselineInteger(
    input.ordinal_end_exclusive,
    ordinalStart + 1,
    10_000_001,
    'room ordinal end'
  );
  const roomCount = baselineInteger(input.room_count, 1, 10_000_000, 'room count');
  if (roomCount !== ordinalEnd - ordinalStart) {
    throw new Error('LiveKit browser room count does not match its ordinal range');
  }
  safeIdentifier(input.room_prefix, 'room prefix');
  absolutePath(input.token_bundle_path, 'token bundle path');
  absolutePath(input.result_path, 'result path');
  const livekitUrl = new URL(String(input.livekit_url || ''));
  if (!['ws:', 'wss:'].includes(livekitUrl.protocol) ||
      livekitUrl.username || livekitUrl.password) {
    throw new Error('LiveKit browser URL is invalid');
  }
  const durationSeconds = baselineInteger(input.duration_seconds, 5, 86_400, 'duration');
  const participants = baselineInteger(input.participants_per_room, 2, 64, 'participants per room');
  const expectedParticipants = baselineInteger(
    input.expected_participants,
    2,
    640_000_000,
    'expected participants'
  );
  if (expectedParticipants !== roomCount * participants) {
    throw new Error('LiveKit browser expected participant count does not match its room layout');
  }
  if (!input.camera || typeof input.camera !== 'object' ||
      !input.audio || typeof input.audio !== 'object' ||
      !input.screen || typeof input.screen !== 'object' ||
      !input.quality_limits || typeof input.quality_limits !== 'object') {
    throw new Error('LiveKit browser media and quality settings are required');
  }
  const camera = input.camera as Record<string, unknown>;
  const cameraTargetBitrate = baselineInteger(
    camera.bitrate_bps,
    100_000,
    20_000_000,
    'camera bitrate'
  );
  if (camera.minimum_bitrate_bps !== undefined) {
    baselineInteger(
      camera.minimum_bitrate_bps,
      100_000,
      cameraTargetBitrate,
      'camera bitrate minimum'
    );
  }
  if (input.subscriber_video_quality !== undefined &&
      !['auto', 'low', 'medium', 'high'].includes(
        String(input.subscriber_video_quality)
      )) {
    throw new Error('LiveKit browser subscriber video quality is invalid');
  }
  if (input.receiver_jitter_buffer_target_ms !== undefined) {
    baselineInteger(
      input.receiver_jitter_buffer_target_ms,
      0,
      4_000,
      'receiver jitter buffer target'
    );
  }
  if (input.connection_preparation_mode !== undefined &&
      !['cold', 'signal_prewarmed'].includes(
        String(input.connection_preparation_mode)
      )) {
    throw new Error('LiveKit browser connection preparation mode is invalid');
  }
  const screenRoomCount = baselineInteger(
    input.screen_room_count,
    0,
    roomCount,
    'screen room count'
  );
  const overlayScreenRoomCount = baselineInteger(
    input.overlay_screen_room_count,
    0,
    roomCount,
    'overlay screen room count'
  );
  if (screenRoomCount + overlayScreenRoomCount > roomCount) {
    throw new Error('LiveKit browser screen room count exceeds the room range');
  }
  baselineInteger(
    input.forced_turn_participant_count,
    0,
    expectedParticipants,
    'forced TURN participants'
  );
  const reconnectParticipants = baselineInteger(
    input.reconnect_participant_count,
    0,
    expectedParticipants,
    'reconnect participant count'
  );
  const reconnectBlackoutMs = baselineInteger(
    input.reconnect_blackout_ms,
    0,
    30_000,
    'reconnect blackout'
  );
  const reconnectStartWindowMs = baselineInteger(
    input.reconnect_start_window_ms,
    0,
    1_000,
    'reconnect start window'
  );
  if (reconnectParticipants === 0 &&
      (reconnectBlackoutMs !== 0 || reconnectStartWindowMs !== 0)) {
    throw new Error(
      'LiveKit reconnect blackout and start window require reconnect participants'
    );
  }
  if (reconnectParticipants > 0) {
    if (reconnectParticipants % participants !== 0) {
      throw new Error(
        'LiveKit browser reconnect participants must cover whole two-participant rooms'
      );
    }
    if (reconnectBlackoutMs < 1_000) {
      throw new Error('LiveKit reconnect blackout must be at least 1000 milliseconds');
    }
    if (reconnectStartWindowMs < 1) {
      throw new Error('LiveKit reconnect start window must be at least 1 millisecond');
    }
    if (durationSeconds * 1_000 < reconnectBlackoutMs + 10_000) {
      throw new Error('LiveKit reconnect duration leaves insufficient recovery time');
    }
  }

  const unsupported = [
    participants !== 2,
    input.camera_publishers_per_room !== 1,
    input.audio_publishers_per_room !== 1,
    input.track_egress_count !== 0,
    input.room_composite_egress_count !== 0
  ];
  if (unsupported.some(Boolean)) {
    throw new Error(
      'LiveKit browser baseline collector does not support this participant, screen, or Egress scenario'
    );
  }
}

export function buildLiveKitVideoPublishOptions(
  camera: LiveKitCapacityProcessInput['camera'],
  subscriberVideoQuality: 'auto' | 'low' | 'medium' | 'high' = 'auto'
): LiveKitVideoPublishOptions {
  if (subscriberVideoQuality === 'medium') {
    return {
      simulcast: false,
      backupCodec: false,
      degradationPreference: 'maintain-framerate',
      videoEncoding: {
        maxBitrate: Math.floor(camera.bitrate_bps * 0.4),
        maxFramerate: camera.fps
      },
      videoSimulcastLayers: []
    };
  }
  if (camera.minimum_bitrate_bps === undefined || !camera.simulcast) {
    return {
      simulcast: camera.simulcast,
      videoEncoding: {
        maxBitrate: camera.bitrate_bps,
        maxFramerate: camera.fps
      },
      videoSimulcastLayers: []
    };
  }
  const lowFrameRate = Math.min(camera.fps, 15);
  return {
    simulcast: true,
    backupCodec: false,
    degradationPreference: 'maintain-framerate',
    videoEncoding: {
      maxBitrate: Math.floor(camera.bitrate_bps * 0.5),
      maxFramerate: camera.fps
    },
    videoSimulcastLayers: [
      {
        width: Math.max(160, Math.floor(camera.width / 4)),
        height: Math.max(90, Math.floor(camera.height / 4)),
        encoding: {
          maxBitrate: Math.floor(camera.bitrate_bps * 0.1),
          maxFramerate: lowFrameRate
        }
      },
      {
        width: Math.max(320, Math.floor(camera.width / 2)),
        height: Math.max(180, Math.floor(camera.height / 2)),
        encoding: {
          maxBitrate: Math.floor(camera.bitrate_bps * 0.4),
          maxFramerate: camera.fps
        }
      }
    ]
  };
}

export function parseLiveKitBrowserCapacityArgs(
  args: readonly string[],
  input: LiveKitCapacityProcessInput
): LiveKitBrowserCapacityArgs {
  if (args.length !== 5 || args[0] !== 'run' ||
      args[1] !== '--input-json' || args[2] !== '-' || args[3] !== '--result') {
    throw new Error('usage: run --input-json - --result <absolute-path>');
  }
  const resultPath = absolutePath(args[4], 'result path');
  if (resultPath !== input.result_path) {
    throw new Error('LiveKit browser CLI result path does not match the immutable plan');
  }
  return { command: 'run', result_path: resultPath };
}

export async function runLiveKitBrowserCapacity(
  input: LiveKitCapacityProcessInput,
  runtime: LiveKitBrowserCapacityRuntime
): Promise<LiveKitCapacityRawEvidence> {
  validateLiveKitBrowserBaselineInput(input);
  const tokenBundle = await runtime.readTokenBundle(input.token_bundle_path);
  const records = parseLiveKitBrowserTokenBundle(tokenBundle, {
    ordinal_start: input.ordinal_start,
    ordinal_end_exclusive: input.ordinal_end_exclusive,
    room_prefix: input.room_prefix,
    participants_per_room: input.participants_per_room
  });
  const measurements = await runtime.measureRooms(input, records);
  const generator = await runtime.observeGenerator();
  const result = summarizeLiveKitBrowserMeasurements(measurements, generator);
  await runtime.writeResult(input.result_path, result);
  return result;
}

export async function readPrivateLiveKitTokenBundle(path: string): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('LiveKit token bundle must be a regular file');
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error('LiveKit token bundle must use mode 0600');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('LiveKit token bundle must be owned by the current user');
  }
  if (stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    throw new Error('LiveKit token bundle size is invalid');
  }
  return readFile(path, 'utf8');
}

export async function writePrivateLiveKitCapacityResult(
  path: string,
  value: unknown
): Promise<void> {
  absolutePath(path, 'result path');
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('LiveKit capacity result already exists');
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function createDefaultLiveKitBrowserCapacityRuntime(
  env: NodeJS.ProcessEnv = process.env
): Promise<LiveKitBrowserCapacityRuntime> {
  const playwright = await loadLiveKitBrowserDependency<PlaywrightLike>('playwright');
  const livekitClientPath = resolveLiveKitBrowserDependency('livekit-client');
  const maximumRooms = optionalBoundedInteger(
    env.OPC_IVEKIT_LIVEKIT_BROWSER_MAX_ROOMS,
    16,
    1,
    256,
    'OPC_IVEKIT_LIVEKIT_BROWSER_MAX_ROOMS'
  );
  const observationFile = String(
    env.OPC_IVEKIT_LIVEKIT_GENERATOR_OBSERVATION_FILE || ''
  ).trim();
  const generatorInterface = String(
    env.OPC_IVEKIT_LIVEKIT_GENERATOR_INTERFACE || ''
  ).trim();
  const generatorNicBps = Number(
    env.OPC_IVEKIT_LIVEKIT_GENERATOR_NIC_BPS || 0
  );
  const generatorSampleIntervalMs = optionalBoundedInteger(
    env.OPC_IVEKIT_LIVEKIT_GENERATOR_SAMPLE_INTERVAL_MS,
    1_000,
    100,
    10_000,
    'OPC_IVEKIT_LIVEKIT_GENERATOR_SAMPLE_INTERVAL_MS'
  );
  if (observationFile) {
    absolutePath(observationFile, 'generator observation path');
  } else {
    if (process.platform !== 'linux') {
      throw new Error(
        'OPC_IVEKIT_LIVEKIT_GENERATOR_OBSERVATION_FILE is required outside Linux'
      );
    }
    linuxNetworkInterface(generatorInterface);
    if (!Number.isSafeInteger(generatorNicBps) || generatorNicBps <= 0) {
      throw new Error('OPC_IVEKIT_LIVEKIT_GENERATOR_NIC_BPS is invalid');
    }
  }
  let measuredGenerator: LiveKitBrowserGeneratorObservation | null = null;

  return {
    readTokenBundle: readPrivateLiveKitTokenBundle,
    async measureRooms(input, records) {
      const grouped = groupLiveKitBrowserRecords(records);
      if (grouped.length > maximumRooms) {
        throw new Error(
          `LiveKit browser shard has ${grouped.length} rooms but this generator is calibrated for ${maximumRooms}`
        );
      }
      const observer = observationFile
        ? null
        : new LinuxProcessTreeObserver({
          root_pid: process.pid,
          interface_name: generatorInterface,
          nic_capacity_bps: generatorNicBps,
          sample_interval_ms: generatorSampleIntervalMs
        });
      await observer?.start();
      let browser: BrowserLike | null = null;
      let context: BrowserContextLike | null = null;
      let observationError: unknown;
      try {
        browser = await playwright.chromium.launch({
          headless: true,
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows'
          ]
        });
        context = await browser.newContext({
          viewport: {
            width: Math.min(input.camera.width, 1280),
            height: Math.min(input.camera.height, 720)
          }
        });
        const reconnectRoomCount =
          input.reconnect_participant_count / input.participants_per_room;
        return await Promise.all(grouped.map(async (roomRecords) => {
          const page = await context.newPage();
          try {
            await navigateLiveKitCollectorPage(
              page,
              toLiveKitHttpUrl(input.livekit_url)
            );
            await page.addScriptTag({ content: LIVEKIT_BROWSER_PAGE_BOOTSTRAP });
            await page.addScriptTag({ path: livekitClientPath });
            const participantOffset = (
              roomRecords[0].room_ordinal - input.ordinal_start
            ) * input.participants_per_room;
            const forcedTurnParticipants = Math.max(
              0,
              Math.min(
                input.participants_per_room,
                input.forced_turn_participant_count - participantOffset
              )
            );
            const reconnectRoom = roomRecords[0].room_ordinal -
              input.ordinal_start < reconnectRoomCount;
            const measurement = page.evaluate(measureLiveKitBaselineRoomInPage, {
              livekit_url: input.livekit_url,
              duration_seconds: input.duration_seconds,
              camera: input.camera,
              video_publish_options: buildLiveKitVideoPublishOptions(
                input.camera,
                input.subscriber_video_quality
              ),
              screen: input.screen,
              audio: input.audio,
              publish_screen: roomRecords[0].room_ordinal - input.ordinal_start <
                input.screen_room_count + input.overlay_screen_room_count,
              expected_forced_turn_participants: forcedTurnParticipants,
              expected_reconnect_participants: reconnectRoom
                ? input.participants_per_room
                : 0,
              reconnect_blackout_ms: reconnectRoom
                ? input.reconnect_blackout_ms
                : 0,
              subscriber_video_quality:
                input.subscriber_video_quality || 'auto',
              receiver_jitter_buffer_target_ms:
                Number(input.receiver_jitter_buffer_target_ms || 0),
              connection_preparation_mode:
                input.connection_preparation_mode || 'signal_prewarmed',
              records: roomRecords
            });
            if (!reconnectRoom) return await measurement;
            const cdp = await context.newCDPSession(page);
            const [result] = await Promise.all([
              measurement,
              executeLiveKitBrowserReconnectBlackout({
                page,
                cdp,
                blackout_ms: input.reconnect_blackout_ms
              })
            ]);
            return result;
          } finally {
            await page.close().catch(() => undefined);
          }
        }));
      } finally {
        if (observer) {
          try {
            measuredGenerator = await observer.stop();
          } catch (error) {
            observationError = error;
          }
        }
        await context?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
        if (observationError) throw observationError;
      }
    },
    async observeGenerator() {
      if (!observationFile) {
        if (!measuredGenerator) {
          throw new Error('LiveKit Linux generator observation is unavailable');
        }
        return structuredClone(measuredGenerator);
      }
      const raw = await readPrivateLiveKitTokenBundle(observationFile);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error('LiveKit generator observation file is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('LiveKit generator observation file is invalid');
      }
      const observation = parsed as LiveKitBrowserGeneratorObservation;
      validateGeneratorObservation(observation);
      return structuredClone(observation);
    },
    writeResult: writePrivateLiveKitCapacityResult
  };
}

export async function measureLiveKitBaselineRoomInPage(
  input: LiveKitBaselinePageInput
): Promise<LiveKitBrowserRoomMeasurement> {
  type ReceiverStats = {
    packetsLost?: number;
    packetsReceived?: number;
    jitter?: number;
    audioLevel?: number;
    totalAudioEnergy?: number;
  };
  type VideoReceiverStats = ReceiverStats & {
    framesDecoded?: number;
    framesDropped?: number;
    framesReceived?: number;
    frameWidth?: number;
    frameHeight?: number;
  };
  type SenderStats = {
    packetsSent?: number;
    bytesSent?: number;
    framesSent?: number;
    frameWidth?: number;
    frameHeight?: number;
    framesPerSecond?: number;
    rid?: string;
    targetBitrate?: number;
    qualityLimitationDurations?: {
      bandwidth?: number;
      cpu?: number;
    };
  };
  type RemoteTrack = {
    kind: string;
    mediaStreamTrack: unknown;
    receiver?: {
      getStats(): Promise<LiveKitStatsReportLike>;
      jitterBufferTarget?: number;
    };
    attach(element?: unknown): unknown;
    getReceiverStats(): Promise<ReceiverStats | VideoReceiverStats | undefined>;
  };
  type LocalTrack = {
    stop(): void;
    getSenderStats(): Promise<SenderStats | SenderStats[] | undefined>;
  };
  type RoomClient = {
    state: string;
    on(event: string, handler: (...args: unknown[]) => void): void;
    prepareConnection(url: string, token: string): Promise<void>;
    connect(
      url: string,
      token: string,
      options?: { rtcConfig: { iceTransportPolicy: 'relay' } }
    ): Promise<void>;
    disconnect(): Promise<void>;
    engine: {
      rtcConfig: { iceTransportPolicy?: string };
      pcManager?: {
        publisher: { getStats(): Promise<LiveKitStatsReportLike> };
        subscriber?: { getStats(): Promise<LiveKitStatsReportLike> };
      };
    };
    localParticipant: {
      publishTrack(
        track: LocalTrack,
        options?: Record<string, unknown>
      ): Promise<unknown>;
    };
  };
  type LiveKitBrowserSdk = {
    Room: new (options?: Record<string, unknown>) => RoomClient;
    RoomEvent: {
      TrackSubscribed: string;
      SignalReconnecting: string;
      Reconnecting: string;
      Reconnected: string;
    };
    Track: {
      Kind: { Video: string; Audio: string };
      Source: { Camera: string; Microphone: string; ScreenShare: string };
    };
    VideoQuality: {
      LOW: number;
      MEDIUM: number;
      HIGH: number;
    };
    LocalVideoTrack: new (
      track: unknown,
      constraints?: Record<string, unknown>,
      userProvidedTrack?: boolean
    ) => LocalTrack;
    LocalAudioTrack: new (
      track: unknown,
      constraints?: Record<string, unknown>,
      userProvidedTrack?: boolean,
      audioContext?: unknown
    ) => LocalTrack;
  };

  const state = globalThis as typeof globalThis & {
    LivekitClient?: LiveKitBrowserSdk;
    document?: any;
    AudioContext?: new (options?: Record<string, unknown>) => any;
    MediaStreamTrackProcessor?: new (options: { track: unknown }) => {
      readable: {
        getReader(): {
          read(): Promise<{ done: boolean; value?: any }>;
          cancel(): Promise<void>;
        };
      };
    };
    __IVEKIT_CAPACITY_RECONNECT_CONTROL__?: {
      media_ready: boolean;
      blackout_started_at: number;
      restored_at: number;
    };
    __IVEKIT_INSPECT_SELECTED_ICE_CANDIDATE_PAIRS__?: (
      reports: readonly LiveKitStatsReportLike[]
    ) => LiveKitSelectedIceCandidatePairEvidence;
    __IVEKIT_INSPECT_INBOUND_VIDEO_STATS__?: (
      report: LiveKitStatsReportLike
    ) => LiveKitInboundVideoStatsEvidence;
  };
  const sdk = state.LivekitClient;
  if (!sdk) throw new Error('LiveKit browser SDK is unavailable');
  if (!state.document || !state.AudioContext) {
    throw new Error('LiveKit browser media globals are unavailable');
  }
  const browserDocument = state.document;
  const BrowserAudioContext = state.AudioContext;
  if (input.records.length !== 2 ||
      input.records[0].room_ordinal !== input.records[1].room_ordinal) {
    throw new Error('LiveKit browser page requires exactly one two-peer room');
  }
  if (!Number.isSafeInteger(input.expected_forced_turn_participants) ||
      input.expected_forced_turn_participants < 0 ||
      input.expected_forced_turn_participants > input.records.length) {
    throw new Error('LiveKit browser page forced TURN participant count is invalid');
  }

  const rooms = input.records.map(() => new sdk.Room({
    adaptiveStream: false,
    dynacast: false,
    stopLocalTrackOnUnpublish: true
  }));
  const reconnectControl = input.expected_reconnect_participants > 0
    ? {
      media_ready: false,
      blackout_started_at: 0,
      restored_at: 0
    }
    : undefined;
  if (reconnectControl) {
    state.__IVEKIT_CAPACITY_RECONNECT_CONTROL__ = reconnectControl;
  }
  const reconnectingRooms = new Set<number>();
  const reconnectedRooms = new Set<number>();
  let lastReconnectedAt = 0;
  rooms.forEach((room, index) => {
    const recordReconnectAttempt = () => {
      reconnectingRooms.add(index);
    };
    room.on(sdk.RoomEvent.SignalReconnecting, recordReconnectAttempt);
    room.on(sdk.RoomEvent.Reconnecting, recordReconnectAttempt);
    room.on(sdk.RoomEvent.Reconnected, () => {
      reconnectedRooms.add(index);
      lastReconnectedAt = performance.timeOrigin + performance.now();
    });
  });
  const joinMs: number[] = [];
  const connectStartedAt: number[] = [];
  let remoteVideo: RemoteTrack | undefined;
  let remoteScreen: RemoteTrack | undefined;
  let remoteAudio: RemoteTrack | undefined;
  let resolveRemoteTracks: (() => void) | undefined;
  const remoteTracksReady = new Promise<void>((resolve) => {
    resolveRemoteTracks = resolve;
  });
  rooms[1].on(sdk.RoomEvent.TrackSubscribed, (
    value: unknown,
    publicationValue: unknown
  ) => {
    const track = value as RemoteTrack;
    const publication = publicationValue as {
      source?: string;
      setVideoQuality?(quality: number): void;
    } | undefined;
    if (track.kind === sdk.Track.Kind.Video &&
        publication?.source === sdk.Track.Source.ScreenShare) {
      remoteScreen = track;
    } else if (track.kind === sdk.Track.Kind.Video) {
      remoteVideo = track;
      const requestedQuality = input.subscriber_video_quality === 'low'
        ? sdk.VideoQuality.LOW
        : input.subscriber_video_quality === 'medium'
          ? sdk.VideoQuality.MEDIUM
          : input.subscriber_video_quality === 'high'
            ? sdk.VideoQuality.HIGH
            : undefined;
      if (requestedQuality !== undefined && input.video_publish_options.simulcast) {
        publication?.setVideoQuality?.(requestedQuality);
      }
    }
    if (track.kind === sdk.Track.Kind.Audio) remoteAudio = track;
    if (remoteVideo && remoteAudio && (!input.publish_screen || remoteScreen)) {
      resolveRemoteTracks?.();
    }
  });

  const cameraScaleDivisor = input.subscriber_video_quality === 'low'
    ? 4
    : input.subscriber_video_quality === 'medium'
      ? 2
      : 1;
  const cameraOutputWidth = Math.max(
    320,
    Math.floor(input.camera.width / cameraScaleDivisor)
  );
  const cameraOutputHeight = Math.max(
    180,
    Math.floor(input.camera.height / cameraScaleDivisor)
  );
  const canvas = browserDocument.createElement('canvas');
  canvas.width = cameraOutputWidth;
  canvas.height = cameraOutputHeight;
  const canvasContext = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: false
  });
  if (!canvasContext) throw new Error('LiveKit marker canvas is unavailable');
  const screenCanvas = input.publish_screen
    ? browserDocument.createElement('canvas')
    : undefined;
  if (screenCanvas) {
    screenCanvas.width = input.screen.width;
    screenCanvas.height = input.screen.height;
  }
  const screenCanvasContext = screenCanvas?.getContext('2d', {
    alpha: false,
    willReadFrequently: false
  });
  if (input.publish_screen && !screenCanvasContext) {
    throw new Error('LiveKit screen marker canvas is unavailable');
  }
  const markerBlockCount = 28;
  const markerBlockSize = Math.max(
    8,
    Math.min(32, Math.floor(cameraOutputWidth / markerBlockCount))
  );
  const STEADY_STATE_WARMUP_MS = 5_000;
  const EVENT_LOOP_SAMPLE_MS = 100;
  const EVENT_LOOP_STALL_THRESHOLD_MS = 250;
  const AUDIO_MARKER_FREQUENCIES_HZ = [
    700, 900, 1_100, 1_300, 1_500, 1_700, 1_900, 2_100
  ];
  const AUDIO_STARTUP_CARRIER_HZ = 500;
  const AUDIO_MARKER_MAX_AGE_MS = 5_000;
  const AUDIO_MARKER_PULSE_SECONDS = 0.12;
  const AUDIO_STARTUP_PULSE_SECONDS = 0.5;
  const STARTUP_MARKER_INTERVAL_MS = 250;
  let currentMarker = 0;
  let emittedPulseCount = 0;
  let animationFrame = 0;
  const cameraSeed = 0x1a2b3c4d ^ input.records[0].room_ordinal;
  let screenAnimationFrame = 0;
  let screenRandomState = 0x5e6f7788 ^ input.records[0].room_ordinal;
  const sentMarkers = new Map<number, number>();
  const videoDetections = new Map<number, number>();
  const screenDetections = new Map<number, number>();
  const decodedAudioDetections = new Map<number, number>();
  const audioDetections = new Map<number, number>();
  const glassToGlassMs: number[] = [];
  const screenGlassToGlassMs: number[] = [];
  const avSyncAbsoluteMs: number[] = [];
  const frameTimes: number[] = [];
  const screenFrameTimes: number[] = [];
  const videoFreezeIntervals: Array<{ start_ms: number; end_ms: number }> = [];
  const screenFreezeIntervals: Array<{ start_ms: number; end_ms: number }> = [];
  const eventLoopStallIntervals: Array<{ start_ms: number; end_ms: number }> = [];
  let videoFreezeDurationMs = 0;
  let screenFreezeDurationMs = 0;
  let videoFreezeCount = 0;
  let screenFreezeCount = 0;
  let firstVideoMs: number | undefined;
  let firstScreenFrameMs: number | undefined;
  let firstAudioMs: number | undefined;
  let firstVideoFrameAt: number | undefined;
  let firstAudioAt: number | undefined;
  let primaryMediaPublishCompletedAt: number | undefined;
  let remoteTracksReadyAt: number | undefined;
  let postReconnectVideoAt: number | undefined;
  let postReconnectAudioAt: number | undefined;
  let lastDecodedMarker = -1;
  let lastDecodedScreenMarker = -1;
  let maximumAudioRms = 0;
  let maximumPlayoutAudioRms = 0;
  let maximumAudioLevel = 0;
  let maximumTotalAudioEnergy = 0;
  let previousTotalAudioEnergy = 0;
  let maximumAudioEnergyDelta = 0;
  let audioSampleInFlight = false;
  let renderTimer: ReturnType<typeof setInterval> | undefined;
  let screenRenderTimer: ReturnType<typeof setInterval> | undefined;
  let pulseTimer: ReturnType<typeof setInterval> | undefined;
  let audioSampleTimer: ReturnType<typeof setInterval> | undefined;
  let eventLoopTimer: ReturnType<typeof setInterval> | undefined;
  let eventLoopExpectedAt = 0;
  let videoCallbackId: number | undefined;
  let screenCallbackId: number | undefined;
  let publisherAudioContext: any;
  let receiverAudioContext: any;
  let oscillator: any;
  let publisherGain: any;
  let localVideo: LocalTrack | undefined;
  let localScreen: LocalTrack | undefined;
  let localAudio: LocalTrack | undefined;
  let canvasStream: any;
  let screenCanvasStream: any;
  let playoutStream: any;
  let remoteVideoElement: any;
  let remoteScreenElement: any;
  let remoteAudioElement: any;
  let stopAudioFrameReader = false;
  let audioFrameReader: {
    read(): Promise<{ done: boolean; value?: any }>;
    cancel(): Promise<void>;
  } | undefined;
  let audioFrameLoop: Promise<void> | undefined;

  function markerBits(marker: number): boolean[] {
    function pageCrc8(value: number): number {
      let crc = 0;
      for (const byte of [(value >>> 8) & 0xff, value & 0xff]) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
          crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
        }
      }
      return crc;
    }
    const checksum = pageCrc8(marker);
    return [
      true, false, true, false,
      ...Array.from({ length: 16 }, (_, index) =>
        Boolean(marker & (1 << (15 - index)))
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        Boolean(checksum & (1 << (7 - index)))
      )
    ];
  }
  function decodeMarker(luminance: number[]): number | null {
    if (luminance.length !== markerBlockCount) return null;
    const bits = luminance.map((value) => value >= 128);
    if (!bits[0] || bits[1] || !bits[2] || bits[3]) return null;
    let marker = 0;
    for (let index = 0; index < 16; index += 1) {
      marker = (marker << 1) | Number(bits[4 + index]);
    }
    const expected = markerBits(marker).slice(20);
    return expected.every((bit, index) => bit === bits[20 + index])
      ? marker
      : null;
  }
  function drawFrame(): void {
    const block = 64;
    for (let y = 0; y < canvas.height; y += block) {
      for (let x = 0; x < canvas.width; x += block) {
        const blockIndex = (Math.floor(y / block) * 31) + Math.floor(x / block);
        const color = Math.imul(cameraSeed ^ blockIndex, 2_654_435_761) >>> 0;
        const red = 48 + (color & 0x3f);
        const green = 72 + ((color >>> 8) & 0x3f);
        const blue = 96 + ((color >>> 16) & 0x3f);
        canvasContext.fillStyle = `rgb(${red},${green},${blue})`;
        canvasContext.fillRect(x, y, block, block);
      }
    }
    const motionWidth = Math.max(96, Math.floor(canvas.width / 8));
    const motionOffset =
      (animationFrame * 8) % (canvas.width + motionWidth) - motionWidth;
    canvasContext.fillStyle = '#32b7a6';
    canvasContext.fillRect(
      motionOffset,
      Math.floor(canvas.height * 0.42),
      motionWidth,
      Math.max(80, Math.floor(canvas.height / 5))
    );
    const bits = markerBits(currentMarker);
    for (let index = 0; index < bits.length; index += 1) {
      canvasContext.fillStyle = bits[index] ? '#ffffff' : '#000000';
      canvasContext.fillRect(
        index * markerBlockSize,
        0,
        markerBlockSize,
        markerBlockSize
      );
    }
    animationFrame += 1;
    canvasContext.fillStyle = '#ffffff';
    canvasContext.fillRect(0, markerBlockSize, 180, 24);
    canvasContext.fillStyle = '#000000';
    canvasContext.font = '18px monospace';
    canvasContext.fillText(
      `${input.records[0].room_ordinal}:${currentMarker}:${animationFrame}`,
      4,
      markerBlockSize + 19
    );
  }
  function drawScreenFrame(): void {
    const context = screenCanvasContext;
    if (!screenCanvas || !context) return;
    const block = 48;
    for (let y = 0; y < screenCanvas.height; y += block) {
      for (let x = 0; x < screenCanvas.width; x += block) {
        screenRandomState =
          (Math.imul(screenRandomState, 1_103_515_245) + 12_345) >>> 0;
        const red = screenRandomState & 0xff;
        const green = (screenRandomState >>> 8) & 0xff;
        const blue = (screenRandomState >>> 16) & 0xff;
        context.fillStyle = `rgb(${red},${green},${blue})`;
        context.fillRect(x, y, block, block);
      }
    }
    const bits = markerBits(currentMarker);
    for (let index = 0; index < bits.length; index += 1) {
      context.fillStyle = bits[index] ? '#ffffff' : '#000000';
      context.fillRect(
        index * markerBlockSize,
        0,
        markerBlockSize,
        markerBlockSize
      );
    }
    screenAnimationFrame += 1;
    context.fillStyle = '#ffffff';
    context.fillRect(0, markerBlockSize, 260, 24);
    context.fillStyle = '#000000';
    context.font = '18px monospace';
    context.fillText(
      `screen:${input.records[0].room_ordinal}:${currentMarker}:${screenAnimationFrame}`,
      4,
      markerBlockSize + 19
    );
  }
  async function timeout<T>(
    promise: Promise<T>,
    milliseconds: number,
    label: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`LiveKit ${label} timed out`)),
            milliseconds
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  function senderStats(
    value: SenderStats | SenderStats[] | undefined
  ): SenderStats[] {
    return Array.isArray(value) ? value : value ? [value] : [];
  }
  function senderStatKey(stats: SenderStats, index: number): string {
    if (stats.rid) return `rid:${stats.rid}`;
    const width = Math.max(0, Number(stats.frameWidth || 0));
    const height = Math.max(0, Number(stats.frameHeight || 0));
    return width > 0 && height > 0
      ? `dimensions:${width}x${height}`
      : `index:${index}`;
  }
  function senderStatDeltas(
    before: SenderStats[],
    after: SenderStats[]
  ): SenderStats[] {
    const starting = new Map(
      before.map((stats, index) => [senderStatKey(stats, index), stats])
    );
    return after.map((stats, index) => {
      const prior = starting.get(senderStatKey(stats, index));
      return {
        ...stats,
        packetsSent: Math.max(
          0,
          Number(stats.packetsSent || 0) - Number(prior?.packetsSent || 0)
        ),
        bytesSent: Math.max(
          0,
          Number(stats.bytesSent || 0) - Number(prior?.bytesSent || 0)
        ),
        qualityLimitationDurations: {
          bandwidth: Math.max(
            0,
            Number(stats.qualityLimitationDurations?.bandwidth || 0) -
              Number(prior?.qualityLimitationDurations?.bandwidth || 0)
          ),
          cpu: Math.max(
            0,
            Number(stats.qualityLimitationDurations?.cpu || 0) -
              Number(prior?.qualityLimitationDurations?.cpu || 0)
          )
        }
      };
    });
  }
  function pagePercentile(values: readonly number[], ratio: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
  }
  function audioMarkerSlot(
    samples: Float32Array,
    sampleRate: number
  ): number | undefined {
    if (samples.length < 128 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
      return undefined;
    }
    let bestSlot = -1;
    let bestPower = 0;
    let secondPower = 0;
    for (let slot = 0; slot < AUDIO_MARKER_FREQUENCIES_HZ.length; slot += 1) {
      const angularFrequency =
        2 * Math.PI * AUDIO_MARKER_FREQUENCIES_HZ[slot] / sampleRate;
      const coefficient = 2 * Math.cos(angularFrequency);
      let previous = 0;
      let previousPrevious = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const window = 0.5 -
          0.5 * Math.cos(2 * Math.PI * index / (samples.length - 1));
        const current =
          samples[index] * window + coefficient * previous - previousPrevious;
        previousPrevious = previous;
        previous = current;
      }
      const power = Math.max(
        0,
        previous * previous + previousPrevious * previousPrevious -
          coefficient * previous * previousPrevious
      );
      if (power > bestPower) {
        secondPower = bestPower;
        bestPower = power;
        bestSlot = slot;
      } else if (power > secondPower) {
        secondPower = power;
      }
    }
    return bestSlot >= 0 && bestPower > Math.max(1e-8, secondPower * 1.5)
      ? bestSlot
      : undefined;
  }
  function latestMarkerAt(now: number, slot: number): number | undefined {
    return [...sentMarkers.entries()]
      .filter(([marker, sentAt]) =>
        marker % AUDIO_MARKER_FREQUENCIES_HZ.length === slot &&
        sentAt <= now &&
        now - sentAt < AUDIO_MARKER_MAX_AGE_MS
      )
      .sort((left, right) => right[1] - left[1])[0]?.[0];
  }
  function recordDecodedAudioSignal(
    level: number,
    slot: number | undefined,
    now: number
  ): void {
    maximumAudioRms = Math.max(maximumAudioRms, level);
    if (level <= 0.01 || slot === undefined) return;
    const marker = latestMarkerAt(now, slot);
    if (marker !== undefined && !decodedAudioDetections.has(marker)) {
      decodedAudioDetections.set(marker, now);
      const sentAt = sentMarkers.get(marker) as number;
      const reconnectRestoredAt = reconnectControl?.restored_at || 0;
      if (reconnectRestoredAt > 0 && sentAt >= reconnectRestoredAt &&
          postReconnectAudioAt === undefined) {
        postReconnectAudioAt = now;
      }
    }
  }
  function recordPlayoutAudioSignal(
    level: number,
    slot: number | undefined,
    now: number
  ): void {
    maximumPlayoutAudioRms = Math.max(maximumPlayoutAudioRms, level);
    if (level <= 0.01) return;
    if (firstAudioMs === undefined) {
      firstAudioAt = now;
      firstAudioMs = now - connectStartedAt[1];
    }
    if (slot === undefined) return;
    const marker = latestMarkerAt(now, slot);
    if (marker !== undefined && !audioDetections.has(marker)) {
      audioDetections.set(marker, now);
    }
  }
  function lossRatio(stats: ReceiverStats | undefined): number {
    const lost = Math.max(0, Number(stats?.packetsLost || 0));
    const received = Math.max(0, Number(stats?.packetsReceived || 0));
    return lost + received > 0 ? lost / (lost + received) : 0;
  }
  function emptyInboundVideoStats(): LiveKitInboundVideoStatsEvidence {
    return {
      inbound_video_stream_count: 0,
      standard_freeze_stats_available: false,
      freeze_count: 0,
      total_freeze_duration_ms: 0,
      frames_decoded: 0,
      key_frames_decoded: 0,
      pli_count: 0,
      fir_count: 0,
      nack_count: 0
    };
  }
  async function inboundVideoStats(
    track: RemoteTrack | undefined
  ): Promise<LiveKitInboundVideoStatsEvidence> {
    const inspect = state.__IVEKIT_INSPECT_INBOUND_VIDEO_STATS__;
    if (!inspect || !track?.receiver?.getStats) return emptyInboundVideoStats();
    return inspect(await track.receiver.getStats());
  }
  function metricDelta(
    start: LiveKitInboundVideoStatsEvidence,
    end: LiveKitInboundVideoStatsEvidence,
    field: 'freeze_count' | 'total_freeze_duration_ms'
  ): number {
    return Math.max(0, end[field] - start[field]);
  }
  function overlapDuration(
    interval: { start_ms: number; end_ms: number },
    witnesses: readonly { start_ms: number; end_ms: number }[]
  ): number {
    return witnesses.reduce((total, witness) =>
      total + Math.max(
        0,
        Math.min(interval.end_ms, witness.end_ms) -
          Math.max(interval.start_ms, witness.start_ms)
      ), 0);
  }

  try {
    eventLoopExpectedAt = performance.timeOrigin + performance.now() +
      EVENT_LOOP_SAMPLE_MS;
    eventLoopTimer = setInterval(() => {
      const now = performance.timeOrigin + performance.now();
      if (now - eventLoopExpectedAt >= EVENT_LOOP_STALL_THRESHOLD_MS) {
        eventLoopStallIntervals.push({
          start_ms: eventLoopExpectedAt,
          end_ms: now
        });
      }
      eventLoopExpectedAt = now + EVENT_LOOP_SAMPLE_MS;
    }, EVENT_LOOP_SAMPLE_MS);
    if (input.connection_preparation_mode === 'signal_prewarmed') {
      await timeout(
        Promise.all(rooms.map((room, index) =>
          room.prepareConnection(input.livekit_url, input.records[index].token)
        )),
        10_000,
        'connection prewarm'
      );
    }
    await Promise.all(rooms.map(async (room, index) => {
      connectStartedAt[index] = performance.timeOrigin + performance.now();
      await room.connect(
        input.livekit_url,
        input.records[index].token,
        index < input.expected_forced_turn_participants
          ? { rtcConfig: { iceTransportPolicy: 'relay' } }
          : undefined
      );
      joinMs[index] = performance.timeOrigin + performance.now() -
        connectStartedAt[index];
    }));
    if (rooms.some((room) => room.state !== 'connected')) {
      throw new Error('LiveKit browser room did not connect both participants');
    }

    drawFrame();
    renderTimer = setInterval(drawFrame, Math.max(10, Math.round(1_000 / input.camera.fps)));
    canvasStream = canvas.captureStream(input.camera.fps);
    const videoMediaTrack = canvasStream.getVideoTracks()[0];
    if (!videoMediaTrack) throw new Error('LiveKit marker video track is unavailable');
    videoMediaTrack.contentHint = 'motion';
    localVideo = new sdk.LocalVideoTrack(videoMediaTrack, undefined, true);
    if (input.publish_screen) {
      drawScreenFrame();
      screenRenderTimer = setInterval(
        drawScreenFrame,
        Math.max(10, Math.round(1_000 / input.screen.fps))
      );
      screenCanvasStream = screenCanvas.captureStream(input.screen.fps);
      const screenMediaTrack = screenCanvasStream.getVideoTracks()[0];
      if (!screenMediaTrack) {
        throw new Error('LiveKit marker screen track is unavailable');
      }
      screenMediaTrack.contentHint = 'detail';
      localScreen = new sdk.LocalVideoTrack(screenMediaTrack, undefined, true);
    }

    publisherAudioContext = new BrowserAudioContext({ sampleRate: 48_000 });
    await publisherAudioContext.resume();
    oscillator = publisherAudioContext.createOscillator();
    oscillator.frequency.value = AUDIO_STARTUP_CARRIER_HZ;
    publisherGain = publisherAudioContext.createGain();
    publisherGain.gain.value = 0.8;
    const destination = publisherAudioContext.createMediaStreamDestination();
    oscillator.connect(publisherGain);
    publisherGain.connect(destination);
    oscillator.start();
    const audioMediaTrack = destination.stream.getAudioTracks()[0];
    if (!audioMediaTrack) throw new Error('LiveKit marker audio track is unavailable');
    localAudio = new sdk.LocalAudioTrack(
      audioMediaTrack,
      undefined,
      true,
      publisherAudioContext
    );

    await Promise.all([
      rooms[0].localParticipant.publishTrack(localAudio, {
        name: 'ivekit-capacity-marker-audio',
        source: sdk.Track.Source.Microphone,
        stream: 'ivekit-capacity-av',
        dtx: false,
        red: true
      }),
      rooms[0].localParticipant.publishTrack(localVideo, {
        name: 'ivekit-capacity-marker-video',
        source: sdk.Track.Source.Camera,
        stream: 'ivekit-capacity-av',
        ...input.video_publish_options
      })
    ]);
    primaryMediaPublishCompletedAt = performance.timeOrigin + performance.now();
    if (localScreen) {
      await rooms[0].localParticipant.publishTrack(localScreen, {
        name: 'ivekit-capacity-marker-screen',
        source: sdk.Track.Source.ScreenShare,
        stream: 'ivekit-capacity-screen',
        simulcast: false,
        videoEncoding: {
          maxBitrate: input.screen.bitrate_bps,
          maxFramerate: input.screen.fps
        }
      });
    }
    await timeout(remoteTracksReady, 15_000, 'remote track subscription');
    remoteTracksReadyAt = performance.timeOrigin + performance.now();
    if (!remoteVideo || !remoteAudio || (input.publish_screen && !remoteScreen)) {
      throw new Error('LiveKit browser remote tracks are incomplete');
    }
    const remoteMediaTracks = [
      remoteVideo,
      remoteAudio,
      ...(remoteScreen ? [remoteScreen] : [])
    ];
    let receiverJitterBufferTargetAppliedTrackCount = 0;
    function applyReceiverJitterBufferTarget(): void {
      if (input.receiver_jitter_buffer_target_ms <= 0) return;
      for (const track of remoteMediaTracks) {
        const receiver = track.receiver;
        if (!receiver || !('jitterBufferTarget' in receiver)) {
          throw new Error(
            'LiveKit browser receiver jitterBufferTarget is unsupported'
          );
        }
        receiver.jitterBufferTarget = input.receiver_jitter_buffer_target_ms;
        if (Math.abs(
          Number(receiver.jitterBufferTarget) -
            input.receiver_jitter_buffer_target_ms
        ) <= 1) {
          receiverJitterBufferTargetAppliedTrackCount += 1;
        }
      }
      if (receiverJitterBufferTargetAppliedTrackCount !==
          remoteMediaTracks.length) {
        throw new Error(
          'LiveKit browser receiver jitterBufferTarget was not applied to every track'
        );
      }
    }
    async function waitForEndpointStartup(): Promise<void> {
      while (firstVideoMs === undefined || firstAudioMs === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    const subscribedAudio = remoteAudio;

    remoteAudioElement = browserDocument.createElement('audio');
    remoteAudioElement.autoplay = true;
    remoteAudioElement.muted = false;
    remoteAudioElement.volume = 1;
    browserDocument.body.appendChild(remoteAudioElement);
    subscribedAudio.attach(remoteAudioElement);
    await remoteAudioElement.play();
    if (typeof remoteAudioElement.captureStream !== 'function') {
      throw new Error('LiveKit browser audio playout capture is unavailable');
    }
    playoutStream = remoteAudioElement.captureStream();
    if (playoutStream.getAudioTracks().length !== 1) {
      throw new Error('LiveKit browser audio playout track is unavailable');
    }
    receiverAudioContext = new BrowserAudioContext({ sampleRate: 48_000 });
    await receiverAudioContext.resume();
    const playoutSource = receiverAudioContext.createMediaStreamSource(playoutStream);
    const playoutAnalyser = receiverAudioContext.createAnalyser();
    playoutAnalyser.fftSize = 2_048;
    const silentOutput = receiverAudioContext.createGain();
    silentOutput.gain.value = 0;
    playoutSource.connect(playoutAnalyser);
    playoutAnalyser.connect(silentOutput);
    silentOutput.connect(receiverAudioContext.destination);
    const playoutSamples = new Float32Array(playoutAnalyser.fftSize);
    audioSampleTimer = setInterval(() => {
      playoutAnalyser.getFloatTimeDomainData(playoutSamples);
      const playoutRms = Math.sqrt(
        playoutSamples.reduce((total, sample) => total + sample * sample, 0) /
        playoutSamples.length
      );
      recordPlayoutAudioSignal(
        playoutRms,
        audioMarkerSlot(
          playoutSamples,
          Math.max(1, Number(receiverAudioContext.sampleRate || 48_000))
        ),
        performance.timeOrigin + performance.now()
      );
      if (audioSampleInFlight) return;
      audioSampleInFlight = true;
      void subscribedAudio.getReceiverStats()
        .then((stats) => {
          const audioLevel = Math.max(0, Number(stats?.audioLevel || 0));
          const totalAudioEnergy = Math.max(
            0,
            Number(stats?.totalAudioEnergy || 0)
          );
          const audioEnergyDelta = Math.max(
            0,
            totalAudioEnergy - previousTotalAudioEnergy
          );
          previousTotalAudioEnergy = totalAudioEnergy;
          maximumAudioLevel = Math.max(maximumAudioLevel, audioLevel);
          maximumTotalAudioEnergy = Math.max(
            maximumTotalAudioEnergy,
            totalAudioEnergy
          );
          maximumAudioEnergyDelta = Math.max(
            maximumAudioEnergyDelta,
            audioEnergyDelta
          );
        })
        .catch(() => undefined)
        .finally(() => {
          audioSampleInFlight = false;
        });
    }, 20);

    remoteVideoElement = browserDocument.createElement('video');
    remoteVideoElement.autoplay = true;
    remoteVideoElement.muted = true;
    remoteVideoElement.playsInline = true;
    remoteVideoElement.style.width = `${Math.min(input.camera.width, 640)}px`;
    remoteVideoElement.style.height = `${Math.min(input.camera.height, 360)}px`;
    browserDocument.body.appendChild(remoteVideoElement);
    remoteVideo.attach(remoteVideoElement);
    await remoteVideoElement.play();
    if (remoteScreen) {
      remoteScreenElement = browserDocument.createElement('video');
      remoteScreenElement.autoplay = true;
      remoteScreenElement.muted = true;
      remoteScreenElement.playsInline = true;
      remoteScreenElement.style.width = `${Math.min(input.screen.width, 960)}px`;
      remoteScreenElement.style.height = `${Math.min(input.screen.height, 540)}px`;
      browserDocument.body.appendChild(remoteScreenElement);
      remoteScreen.attach(remoteScreenElement);
      await remoteScreenElement.play();
    }

    const decodeCanvas = browserDocument.createElement('canvas');
    decodeCanvas.width = markerBlockSize * markerBlockCount;
    decodeCanvas.height = markerBlockSize;
    const decodeContext = decodeCanvas.getContext('2d', {
      alpha: false,
      willReadFrequently: true
    });
    if (!decodeContext) throw new Error('LiveKit marker decoder canvas is unavailable');
    function onVideoFrame(now: number): void {
      const absoluteNow = performance.timeOrigin + now;
      if (firstVideoMs === undefined) {
        firstVideoFrameAt = absoluteNow;
        firstVideoMs = absoluteNow - connectStartedAt[1];
      }
      const prior = frameTimes.at(-1);
      if (prior !== undefined) {
        const gap = absoluteNow - prior;
        const expectedFrameMs = 1_000 / input.camera.fps;
        if (gap > Math.max(500, expectedFrameMs * 3)) {
          videoFreezeCount += 1;
          videoFreezeDurationMs += Math.max(0, gap - expectedFrameMs);
          videoFreezeIntervals.push({
            start_ms: prior + expectedFrameMs,
            end_ms: absoluteNow
          });
        }
      }
      frameTimes.push(absoluteNow);
      const sourceWidth = remoteVideoElement.videoWidth *
        decodeCanvas.width / cameraOutputWidth;
      const sourceHeight = remoteVideoElement.videoHeight *
        decodeCanvas.height / cameraOutputHeight;
      decodeContext.drawImage(
        remoteVideoElement,
        0,
        0,
        sourceWidth,
        sourceHeight,
        0,
        0,
        decodeCanvas.width,
        decodeCanvas.height,
      );
      const pixels = decodeContext.getImageData(
        0,
        0,
        decodeCanvas.width,
        decodeCanvas.height
      ).data;
      const luminance = Array.from({ length: markerBlockCount }, (_, index) => {
        const x = index * markerBlockSize + Math.floor(markerBlockSize / 2);
        const y = Math.floor(markerBlockSize / 2);
        const offset = (y * decodeCanvas.width + x) * 4;
        return (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
      });
      const marker = decodeMarker(luminance);
      if (marker !== null && marker !== lastDecodedMarker && sentMarkers.has(marker)) {
        lastDecodedMarker = marker;
        videoDetections.set(marker, absoluteNow);
        const sentAt = sentMarkers.get(marker) as number;
        const latency = absoluteNow - sentAt;
        if (latency >= 0 && latency < 5_000) glassToGlassMs.push(latency);
        const reconnectRestoredAt = reconnectControl?.restored_at || 0;
        if (reconnectRestoredAt > 0 && sentAt >= reconnectRestoredAt &&
            postReconnectVideoAt === undefined) {
          postReconnectVideoAt = absoluteNow;
        }
      }
      videoCallbackId = remoteVideoElement?.requestVideoFrameCallback(onVideoFrame);
    }
    videoCallbackId = remoteVideoElement.requestVideoFrameCallback(onVideoFrame);
    if (remoteScreenElement) {
      const screenDecodeCanvas = browserDocument.createElement('canvas');
      screenDecodeCanvas.width = markerBlockSize * markerBlockCount;
      screenDecodeCanvas.height = markerBlockSize;
      const screenDecodeContext = screenDecodeCanvas.getContext('2d', {
        alpha: false,
        willReadFrequently: true
      });
      if (!screenDecodeContext) {
        throw new Error('LiveKit screen marker decoder canvas is unavailable');
      }
      function onScreenFrame(now: number): void {
        const absoluteNow = performance.timeOrigin + now;
        const prior = screenFrameTimes.at(-1);
        if (prior !== undefined) {
          const gap = absoluteNow - prior;
          const expectedFrameMs = 1_000 / input.screen.fps;
          if (gap > Math.max(500, expectedFrameMs * 3)) {
            screenFreezeCount += 1;
            screenFreezeDurationMs += Math.max(0, gap - expectedFrameMs);
            screenFreezeIntervals.push({
              start_ms: prior + expectedFrameMs,
              end_ms: absoluteNow
            });
          }
        }
        screenFrameTimes.push(absoluteNow);
        const sourceWidth = remoteScreenElement.videoWidth *
          screenDecodeCanvas.width / input.screen.width;
        const sourceHeight = remoteScreenElement.videoHeight *
          screenDecodeCanvas.height / input.screen.height;
        screenDecodeContext.drawImage(
          remoteScreenElement,
          0,
          0,
          sourceWidth,
          sourceHeight,
          0,
          0,
          screenDecodeCanvas.width,
          screenDecodeCanvas.height
        );
        const pixels = screenDecodeContext.getImageData(
          0,
          0,
          screenDecodeCanvas.width,
          screenDecodeCanvas.height
        ).data;
        const luminance = Array.from({ length: markerBlockCount }, (_, index) => {
          const x = index * markerBlockSize + Math.floor(markerBlockSize / 2);
          const y = Math.floor(markerBlockSize / 2);
          const offset = (y * screenDecodeCanvas.width + x) * 4;
          return (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3;
        });
        const marker = decodeMarker(luminance);
        if (marker !== null && marker !== lastDecodedScreenMarker && sentMarkers.has(marker)) {
          lastDecodedScreenMarker = marker;
          screenDetections.set(marker, absoluteNow);
          const latency = absoluteNow - (sentMarkers.get(marker) as number);
          if (latency >= 0 && latency < 5_000) screenGlassToGlassMs.push(latency);
          if (firstScreenFrameMs === undefined) {
            firstScreenFrameMs = absoluteNow - connectStartedAt[1];
          }
        }
        screenCallbackId = remoteScreenElement?.requestVideoFrameCallback(onScreenFrame);
      }
      screenCallbackId = remoteScreenElement.requestVideoFrameCallback(onScreenFrame);
    }

    const AudioFrameProcessor = state.MediaStreamTrackProcessor;
    if (AudioFrameProcessor) {
      const processor = new AudioFrameProcessor({
        track: subscribedAudio.mediaStreamTrack
      });
      audioFrameReader = processor.readable.getReader();
      audioFrameLoop = (async () => {
        while (!stopAudioFrameReader) {
          const { done, value } = await audioFrameReader!.read();
          if (done || !value) break;
          const now = performance.timeOrigin + performance.now();
          try {
            const bytes = Number(value.allocationSize({ planeIndex: 0 }));
            if (Number.isInteger(bytes) && bytes > 0) {
              const frameSamples = new Float32Array(bytes / Float32Array.BYTES_PER_ELEMENT);
              value.copyTo(frameSamples, { planeIndex: 0 });
              const rms = Math.sqrt(
                frameSamples.reduce(
                  (total: number, sample: number) => total + sample * sample,
                  0
                ) / frameSamples.length
              );
              recordDecodedAudioSignal(
                rms,
                audioMarkerSlot(
                  frameSamples,
                  Math.max(1, Number(value.sampleRate || 48_000))
                ),
                now
              );
            }
          } finally {
            value.close();
          }
        }
      })();
    }

    function emitPulse(): void {
      currentMarker = currentMarker >= 0xffff ? 1 : currentMarker + 1;
      const now = performance.timeOrigin + performance.now();
      sentMarkers.set(currentMarker, now);
      drawFrame();
      drawScreenFrame();
      const audioNow = publisherAudioContext?.currentTime || 0;
      oscillator.frequency.cancelScheduledValues(audioNow);
      oscillator.frequency.setValueAtTime(
        AUDIO_MARKER_FREQUENCIES_HZ[
          currentMarker % AUDIO_MARKER_FREQUENCIES_HZ.length
        ],
        audioNow
      );
      const pulseDurationSeconds = emittedPulseCount === 0
        ? AUDIO_STARTUP_PULSE_SECONDS
        : AUDIO_MARKER_PULSE_SECONDS;
      emittedPulseCount += 1;
      publisherGain?.gain.cancelScheduledValues(audioNow);
      publisherGain?.gain.setValueAtTime(0.8, audioNow);
      publisherGain?.gain.setValueAtTime(0, audioNow + pulseDurationSeconds);
    }
    emitPulse();
    pulseTimer = setInterval(emitPulse, STARTUP_MARKER_INTERVAL_MS);
    await timeout(waitForEndpointStartup(), 5_000, 'endpoint startup media');
    clearInterval(pulseTimer);
    pulseTimer = undefined;
    if (input.receiver_jitter_buffer_target_ms > 0) {
      applyReceiverJitterBufferTarget();
    }
    pulseTimer = setInterval(emitPulse, 1_000);
    await new Promise((resolve) => setTimeout(resolve, STEADY_STATE_WARMUP_MS));
    clearInterval(pulseTimer);
    pulseTimer = undefined;

    const videoSenderStart = senderStats(await localVideo.getSenderStats());
    const screenSenderStart = localScreen
      ? senderStats(await localScreen.getSenderStats())
      : [];
    const audioSenderStart = senderStats(await localAudio.getSenderStats());
    const remoteVideoStatsStart =
      await remoteVideo.getReceiverStats() as VideoReceiverStats | undefined;
    const remoteVideoInboundStart = await inboundVideoStats(remoteVideo);
    const remoteScreenInboundStart = await inboundVideoStats(remoteScreen);
    sentMarkers.clear();
    videoDetections.clear();
    screenDetections.clear();
    decodedAudioDetections.clear();
    audioDetections.clear();
    glassToGlassMs.length = 0;
    screenGlassToGlassMs.length = 0;
    avSyncAbsoluteMs.length = 0;
    frameTimes.length = 0;
    screenFrameTimes.length = 0;
    videoFreezeIntervals.length = 0;
    screenFreezeIntervals.length = 0;
    eventLoopStallIntervals.length = 0;
    videoFreezeDurationMs = 0;
    screenFreezeDurationMs = 0;
    videoFreezeCount = 0;
    screenFreezeCount = 0;
    lastDecodedMarker = -1;
    lastDecodedScreenMarker = -1;
    const measurementStartedAt = performance.timeOrigin + performance.now();
    eventLoopExpectedAt = measurementStartedAt + EVENT_LOOP_SAMPLE_MS;
    if (reconnectControl) reconnectControl.media_ready = true;
    emitPulse();
    pulseTimer = setInterval(emitPulse, 1_000);
    await new Promise((resolve) => setTimeout(resolve, input.duration_seconds * 1_000));
    const measurementEndedAt = performance.timeOrigin + performance.now();
    const measurementSeconds = Math.max(
      0.001,
      (measurementEndedAt - measurementStartedAt) / 1_000
    );
    let reconnectBlackoutObservedMs = 0;
    const reconnectRecoveryMs: number[] = [];
    if (input.expected_reconnect_participants > 0) {
      const blackoutStartedAt = reconnectControl?.blackout_started_at || 0;
      const reconnectRestoredAt = reconnectControl?.restored_at || 0;
      reconnectBlackoutObservedMs = reconnectRestoredAt - blackoutStartedAt;
      if (blackoutStartedAt <= 0 || reconnectRestoredAt <= blackoutStartedAt ||
          reconnectingRooms.size !== input.expected_reconnect_participants ||
          reconnectedRooms.size !== input.expected_reconnect_participants ||
          postReconnectVideoAt === undefined || postReconnectAudioAt === undefined ||
          lastReconnectedAt < reconnectRestoredAt) {
        throw new Error(
          'LiveKit browser reconnect recovery is incomplete ' +
          `(expected=${input.expected_reconnect_participants}, ` +
          `attempts=${reconnectingRooms.size}, successes=${reconnectedRooms.size}, ` +
          `blackout_ms=${reconnectBlackoutObservedMs.toFixed(1)}, ` +
          `video=${postReconnectVideoAt !== undefined}, ` +
          `audio=${postReconnectAudioAt !== undefined})`
        );
      }
      reconnectRecoveryMs.push(
        Math.max(
          lastReconnectedAt,
          postReconnectVideoAt,
          postReconnectAudioAt
        ) - reconnectRestoredAt
      );
    }

    for (const [marker, videoAt] of videoDetections) {
      const audioAt = audioDetections.get(marker);
      if (audioAt !== undefined) avSyncAbsoluteMs.push(Math.abs(videoAt - audioAt));
    }
    const screenCoverageIncomplete = input.publish_screen &&
      (firstScreenFrameMs === undefined || screenGlassToGlassMs.length < 3);
    if (firstVideoMs === undefined || firstAudioMs === undefined ||
        firstVideoFrameAt === undefined || firstAudioAt === undefined ||
        primaryMediaPublishCompletedAt === undefined ||
        remoteTracksReadyAt === undefined ||
        glassToGlassMs.length < 3 || avSyncAbsoluteMs.length < 3 ||
        screenCoverageIncomplete) {
      throw new Error(
        'LiveKit browser decoded media marker coverage is incomplete ' +
        `(video=${videoDetections.size}, audio=${audioDetections.size}, ` +
        `decoded_audio=${decodedAudioDetections.size}, ` +
        `glass=${glassToGlassMs.length}, av_sync=${avSyncAbsoluteMs.length}, ` +
        `screen=${screenDetections.size}, screen_glass=${screenGlassToGlassMs.length}, ` +
        `first_video=${firstVideoMs !== undefined}, first_audio=${firstAudioMs !== undefined}, ` +
        `first_screen=${firstScreenFrameMs !== undefined}, ` +
        `max_audio_rms=${maximumAudioRms.toFixed(6)}, ` +
        `max_playout_audio_rms=${maximumPlayoutAudioRms.toFixed(6)}, ` +
        `max_audio_level=${maximumAudioLevel.toFixed(6)}, ` +
        `total_audio_energy=${maximumTotalAudioEnergy.toFixed(6)}, ` +
        `max_audio_energy_delta=${maximumAudioEnergyDelta.toFixed(6)})`
      );
    }

    const videoSender = senderStatDeltas(
      videoSenderStart,
      senderStats(await localVideo.getSenderStats())
    );
    const screenSender = localScreen
      ? senderStatDeltas(
        screenSenderStart,
        senderStats(await localScreen.getSenderStats())
      )
      : [];
    const audioSender = senderStatDeltas(
      audioSenderStart,
      senderStats(await localAudio.getSenderStats())
    );
    const remoteVideoStats = await remoteVideo.getReceiverStats() as VideoReceiverStats | undefined;
    const remoteScreenStats = remoteScreen
      ? await remoteScreen.getReceiverStats() as VideoReceiverStats | undefined
      : undefined;
    const remoteAudioStats = await remoteAudio.getReceiverStats();
    const remoteVideoInbound = await inboundVideoStats(remoteVideo);
    const remoteScreenInbound = await inboundVideoStats(remoteScreen);
    function receiverFrameDelta(
      field: 'framesDecoded' | 'framesDropped' | 'framesReceived'
    ): number {
      return Math.max(
        0,
        Number(remoteVideoStats?.[field] || 0) -
          Number(remoteVideoStatsStart?.[field] || 0)
      );
    }
    const expectedVideoTrackCount = 1 + Number(input.publish_screen);
    const standardFreezeStatsTrackCount = [
      [remoteVideoInboundStart, remoteVideoInbound],
      ...(input.publish_screen
        ? [[remoteScreenInboundStart, remoteScreenInbound]]
        : [])
    ].filter(([start, end]) =>
      start.standard_freeze_stats_available &&
      end.standard_freeze_stats_available
    ).length;
    const standardFreezeDurationMs =
      metricDelta(
        remoteVideoInboundStart,
        remoteVideoInbound,
        'total_freeze_duration_ms'
      ) +
      (input.publish_screen
        ? metricDelta(
          remoteScreenInboundStart,
          remoteScreenInbound,
          'total_freeze_duration_ms'
        )
        : 0);
    const standardFreezeCount =
      metricDelta(remoteVideoInboundStart, remoteVideoInbound, 'freeze_count') +
      (input.publish_screen
        ? metricDelta(
          remoteScreenInboundStart,
          remoteScreenInbound,
          'freeze_count'
        )
        : 0);
    const measurementEventLoopStalls = eventLoopStallIntervals
      .map((interval) => ({
        start_ms: Math.max(interval.start_ms, measurementStartedAt),
        end_ms: Math.min(interval.end_ms, measurementEndedAt)
      }))
      .filter((interval) => interval.end_ms > interval.start_ms);
    const renderFreezeIntervals = [
      ...videoFreezeIntervals,
      ...screenFreezeIntervals
    ];
    const renderCallbackStallOverlapDurationMs = renderFreezeIntervals.reduce(
      (total, interval) =>
        total + overlapDuration(interval, measurementEventLoopStalls),
      0
    );
    const renderCallbackFreezeDurationMs =
      videoFreezeDurationMs + screenFreezeDurationMs;
    const fallbackFreezeDurationMs = Math.max(
      0,
      renderCallbackFreezeDurationMs -
        renderCallbackStallOverlapDurationMs
    );
    const fallbackFreezeCount = renderFreezeIntervals.filter(
      (interval) =>
        interval.end_ms - interval.start_ms -
          overlapDuration(interval, measurementEventLoopStalls) > 0
    ).length;
    const standardFreezeEvidenceComplete =
      standardFreezeStatsTrackCount === expectedVideoTrackCount;
    const authoritativeFreezeDurationMs = standardFreezeEvidenceComplete
      ? standardFreezeDurationMs
      : fallbackFreezeDurationMs;
    const authoritativeFreezeCount = standardFreezeEvidenceComplete
      ? standardFreezeCount
      : fallbackFreezeCount;
    const measurementWindowDurationMs = measurementSeconds * 1_000;
    const videoObservationDurationMs =
      measurementWindowDurationMs * expectedVideoTrackCount;
    const eventLoopStallDurations = measurementEventLoopStalls.map(
      (interval) => interval.end_ms - interval.start_ms
    );
    const eventLoopStallDurationMs = eventLoopStallDurations.reduce(
      (total, duration) => total + duration,
      0
    );
    const encodedVideoPackets = [...videoSender, ...screenSender].reduce(
      (total, stats) => total + Math.max(0, Number(stats.packetsSent || 0)),
      0
    );
    const encodedAudioPackets = audioSender.reduce(
      (total, stats) => total + Math.max(0, Number(stats.packetsSent || 0)),
      0
    );
    const primaryVideo = [...videoSender].sort((left, right) => {
      const leftPixels = Number(left.frameWidth || 0) * Number(left.frameHeight || 0);
      const rightPixels = Number(right.frameWidth || 0) * Number(right.frameHeight || 0);
      return rightPixels - leftPixels ||
        Number(right.bytesSent || 0) - Number(left.bytesSent || 0);
    })[0];
    const primaryVideoBytes = Math.max(0, Number(primaryVideo?.bytesSent || 0));
    const totalVideoBytes = videoSender.reduce(
      (total, stats) => total + Math.max(0, Number(stats.bytesSent || 0)),
      0
    );
    const primaryScreen = [...screenSender].sort((left, right) =>
      Number(right.bytesSent || 0) - Number(left.bytesSent || 0)
    )[0];
    const primaryScreenBytes = Math.max(0, Number(primaryScreen?.bytesSent || 0));
    if (encodedVideoPackets <= 0 || encodedAudioPackets <= 0 ||
        Number(remoteVideoStats?.framesDecoded || 0) <= 0 ||
        (input.publish_screen && (
          screenSender.length === 0 ||
          primaryScreenBytes <= 0 ||
          Number(remoteScreenStats?.framesDecoded || 0) <= 0
        ))) {
      throw new Error('LiveKit browser WebRTC stats contain no encoded or decoded media');
    }
    const videoFrameGaps = frameTimes.slice(1).map(
      (frameAt, index) => Math.max(0, frameAt - frameTimes[index])
    );
    let forcedTurnParticipants = 0;
    let forcedTurnConfiguredParticipants = 0;
    let forcedTurnSelectedPairCount = 0;
    let forcedTurnRelayPairCount = 0;
    const forcedTurnTransportProtocols: Array<'udp' | 'tcp' | 'unknown'> = [];
    const forcedTurnCurrentRoundTripMs: number[] = [];
    if (input.expected_forced_turn_participants > 0) {
      const inspectCandidatePairs =
        state.__IVEKIT_INSPECT_SELECTED_ICE_CANDIDATE_PAIRS__;
      if (!inspectCandidatePairs) {
        throw new Error('LiveKit selected ICE candidate-pair inspector is unavailable');
      }
      for (let index = 0; index < input.expected_forced_turn_participants; index += 1) {
        const room = rooms[index];
        if (room.engine.rtcConfig.iceTransportPolicy !== 'relay') {
          throw new Error('LiveKit forced TURN participant is not configured relay-only');
        }
        forcedTurnConfiguredParticipants += 1;
        const manager = room.engine.pcManager;
        const transports = manager
          ? [manager.publisher, manager.subscriber].filter(
            (transport): transport is { getStats(): Promise<LiveKitStatsReportLike> } =>
              Boolean(transport)
          )
          : [];
        const candidateEvidence = inspectCandidatePairs(
          await Promise.all(transports.map((transport) => transport.getStats()))
        );
        if (candidateEvidence.selected_pair_count <= 0 ||
            candidateEvidence.relay_pair_count !== candidateEvidence.selected_pair_count ||
            candidateEvidence.transport_protocols.some(
              (protocol) => protocol === 'unknown'
            ) ||
            candidateEvidence.current_round_trip_ms.length <= 0) {
          throw new Error(
            'LiveKit forced TURN selected candidate-pair proof is incomplete ' +
            `(selected=${candidateEvidence.selected_pair_count}, ` +
            `relay=${candidateEvidence.relay_pair_count}, ` +
            `rtt=${candidateEvidence.current_round_trip_ms.length})`
          );
        }
        forcedTurnParticipants += 1;
        forcedTurnSelectedPairCount += candidateEvidence.selected_pair_count;
        forcedTurnRelayPairCount += candidateEvidence.relay_pair_count;
        forcedTurnTransportProtocols.push(...candidateEvidence.transport_protocols);
        forcedTurnCurrentRoundTripMs.push(...candidateEvidence.current_round_trip_ms);
      }
    }

    return {
      room_ordinal: input.records[0].room_ordinal,
      connected_participants: 2,
      published_camera_tracks: 1,
      published_audio_tracks: 1,
      published_screen_tracks: input.publish_screen ? 1 : 0,
      subscribed_tracks: input.publish_screen ? 3 : 2,
      encoded_video_packet_count: encodedVideoPackets,
      encoded_audio_packet_count: encodedAudioPackets,
      camera_bitrate_bps: [primaryVideoBytes * 8 / measurementSeconds],
      camera_total_bitrate_bps: [totalVideoBytes * 8 / measurementSeconds],
      camera_simulcast_layer_count: videoSender.length,
      camera_primary_target_bitrate_bps:
        Math.max(0, Number(primaryVideo?.targetBitrate || 0)),
      camera_primary_frame_width:
        Math.max(0, Number(primaryVideo?.frameWidth || 0)),
      camera_primary_frame_height:
        Math.max(0, Number(primaryVideo?.frameHeight || 0)),
      camera_primary_frames_per_second:
        Math.max(0, Number(primaryVideo?.framesPerSecond || 0)),
      camera_sender_bandwidth_limited_seconds: Math.max(
        0,
        Number(primaryVideo?.qualityLimitationDurations?.bandwidth || 0)
      ),
      camera_sender_cpu_limited_seconds: Math.max(
        0,
        Number(primaryVideo?.qualityLimitationDurations?.cpu || 0)
      ),
      camera_receiver_frames_decoded: receiverFrameDelta('framesDecoded'),
      camera_receiver_frames_dropped: receiverFrameDelta('framesDropped'),
      camera_receiver_frames_received: receiverFrameDelta('framesReceived'),
      camera_subscriber_video_quality: input.subscriber_video_quality,
      camera_receiver_frame_width:
        Math.max(0, Number(remoteVideoStats?.frameWidth || 0)),
      camera_receiver_frame_height:
        Math.max(0, Number(remoteVideoStats?.frameHeight || 0)),
      video_frame_gap_p95_ms: pagePercentile(videoFrameGaps, 0.95),
      video_frame_gap_p99_ms: pagePercentile(videoFrameGaps, 0.99),
      video_frame_gap_max_ms: pagePercentile(videoFrameGaps, 1),
      steady_state_warmup_ms: STEADY_STATE_WARMUP_MS,
      receiver_jitter_buffer_target_ms:
        input.receiver_jitter_buffer_target_ms,
      receiver_jitter_buffer_target_applied_track_count:
        receiverJitterBufferTargetAppliedTrackCount,
      connection_preparation_mode: input.connection_preparation_mode,
      primary_media_publish_completed_ms:
        primaryMediaPublishCompletedAt - connectStartedAt[1],
      remote_tracks_ready_ms: remoteTracksReadyAt - connectStartedAt[1],
      first_audio_after_remote_tracks_ready_ms:
        firstAudioAt - remoteTracksReadyAt,
      first_video_frame_after_remote_tracks_ready_ms:
        firstVideoFrameAt - remoteTracksReadyAt,
      screen_bitrate_bps: input.publish_screen
        ? [primaryScreenBytes * 8 / measurementSeconds]
        : [],
      forced_turn_participants: forcedTurnParticipants,
      forced_turn_relay_only_configured_participants:
        forcedTurnConfiguredParticipants,
      forced_turn_selected_candidate_pair_count: forcedTurnSelectedPairCount,
      forced_turn_relay_candidate_pair_count: forcedTurnRelayPairCount,
      forced_turn_transport_protocols: forcedTurnTransportProtocols,
      forced_turn_current_round_trip_ms: forcedTurnCurrentRoundTripMs,
      forced_turn_scope: forcedTurnParticipants > 0
        ? 'relay_only_selected_candidate_pair'
        : 'none',
      track_egress_completed: 0,
      room_composite_egress_completed: 0,
      join_ms: joinMs,
      first_audio_ms: [firstAudioMs],
      first_video_ms: [firstVideoMs],
      first_screen_frame_ms: firstScreenFrameMs === undefined
        ? []
        : [firstScreenFrameMs],
      glass_to_glass_ms: glassToGlassMs,
      screen_glass_to_glass_ms: screenGlassToGlassMs,
      endpoint_packet_loss_ratio: [
        lossRatio(remoteVideoStats),
        lossRatio(remoteAudioStats),
        ...(remoteScreenStats ? [lossRatio(remoteScreenStats)] : [])
      ],
      jitter_ms: [
        Math.max(0, Number(remoteVideoStats?.jitter || 0)) * 1_000,
        Math.max(0, Number(remoteAudioStats?.jitter || 0)) * 1_000,
        ...(remoteScreenStats
          ? [Math.max(0, Number(remoteScreenStats.jitter || 0)) * 1_000]
          : [])
      ],
      video_freeze_duration_ms: authoritativeFreezeDurationMs,
      video_observation_duration_ms: videoObservationDurationMs,
      video_freeze_count: authoritativeFreezeCount,
      video_freeze_measurement_scope: standardFreezeEvidenceComplete
        ? 'webrtc_inbound_rtp'
        : 'render_callback_fallback',
      video_webrtc_freeze_stats_track_count: standardFreezeStatsTrackCount,
      video_render_callback_freeze_duration_ms: renderCallbackFreezeDurationMs,
      video_render_callback_freeze_count:
        videoFreezeCount + screenFreezeCount,
      video_render_callback_stall_overlap_duration_ms:
        renderCallbackStallOverlapDurationMs,
      measurement_window_duration_ms: measurementWindowDurationMs,
      browser_event_loop_stall_duration_ms: eventLoopStallDurationMs,
      browser_event_loop_stall_count: measurementEventLoopStalls.length,
      browser_event_loop_stall_max_ms:
        Math.max(0, ...eventLoopStallDurations),
      av_sync_absolute_ms: avSyncAbsoluteMs,
      audio_endpoint_scope: 'playout',
      reconnect_attempt_count: reconnectingRooms.size,
      reconnect_success_count: reconnectedRooms.size,
      reconnect_recovery_ms: reconnectRecoveryMs,
      reconnect_scope: input.expected_reconnect_participants > 0
        ? 'room_correlated_cdp_offline'
        : 'none',
      reconnect_blackout_ms: input.expected_reconnect_participants > 0
        ? input.reconnect_blackout_ms
        : 0,
      reconnect_blackout_observed_ms: reconnectBlackoutObservedMs,
      reconnect_blackout_started_at_ms: input.expected_reconnect_participants > 0
        ? reconnectControl?.blackout_started_at || 0
        : 0,
      reconnect_recovery_endpoint_scope: input.expected_reconnect_participants > 0
        ? 'decoded_audio_video'
        : 'none',
      stale_epoch_action_count: 0
    };
  } finally {
    stopAudioFrameReader = true;
    await audioFrameReader?.cancel().catch(() => undefined);
    await audioFrameLoop?.catch(() => undefined);
    if (renderTimer) clearInterval(renderTimer);
    if (screenRenderTimer) clearInterval(screenRenderTimer);
    if (pulseTimer) clearInterval(pulseTimer);
    if (audioSampleTimer) clearInterval(audioSampleTimer);
    if (eventLoopTimer) clearInterval(eventLoopTimer);
    if (videoCallbackId !== undefined && remoteVideoElement) {
      remoteVideoElement.cancelVideoFrameCallback(videoCallbackId);
    }
    if (screenCallbackId !== undefined && remoteScreenElement) {
      remoteScreenElement.cancelVideoFrameCallback(screenCallbackId);
    }
    remoteVideoElement?.remove();
    remoteScreenElement?.remove();
    remoteAudioElement?.remove();
    localVideo?.stop();
    localScreen?.stop();
    localAudio?.stop();
    canvasStream?.getTracks().forEach((track) => track.stop());
    screenCanvasStream?.getTracks().forEach((track) => track.stop());
    playoutStream?.getTracks().forEach((track: { stop(): void }) => track.stop());
    try {
      oscillator?.stop();
    } catch {
      // The oscillator may already be stopped by AudioContext shutdown.
    }
    await receiverAudioContext?.close().catch(() => undefined);
    await publisherAudioContext?.close().catch(() => undefined);
    await Promise.all(rooms.map((room) => room.disconnect().catch(() => undefined)));
    if (state.__IVEKIT_CAPACITY_RECONNECT_CONTROL__ === reconnectControl) {
      delete state.__IVEKIT_CAPACITY_RECONNECT_CONTROL__;
    }
  }
}

function groupLiveKitBrowserRecords(
  records: readonly LiveKitBrowserTokenRecord[]
): LiveKitBrowserTokenRecord[][] {
  const grouped = new Map<number, LiveKitBrowserTokenRecord[]>();
  for (const record of records) {
    const room = grouped.get(record.room_ordinal) || [];
    room.push(record);
    grouped.set(record.room_ordinal, room);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, room]) => room.sort(
      (left, right) => left.participant_ordinal - right.participant_ordinal
    ));
}

async function loadLiveKitBrowserDependency<T>(packageName: string): Promise<T> {
  const entry = resolveLiveKitBrowserDependency(packageName);
  const imported = await import(pathToFileURL(entry).href) as {
    default?: T;
  } & T;
  return imported.default || imported;
}

function resolveLiveKitBrowserDependency(packageName: string): string {
  const resolver = createRequire(import.meta.url);
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [
    join(
      scriptDirectory,
      '..',
      'services',
      'ivekit-service',
      'acceptance',
      'livekit-storage-isolation'
    ),
    join(scriptDirectory, '..', 'clients', 'ivekit-reference')
  ];
  try {
    return resolver.resolve(packageName);
  } catch {
    return resolver.resolve(packageName, { paths: roots });
  }
}

export async function navigateLiveKitCollectorPage(
  page: Pick<BrowserPageLike, 'goto'>,
  url: string,
  retryDelayMs = 250
): Promise<void> {
  const options = { waitUntil: 'domcontentloaded', timeout: 30_000 };
  try {
    await page.goto(url, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('ERR_NETWORK_CHANGED')) throw error;
    if (retryDelayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
    }
    await page.goto(url, options);
  }
}

function toLiveKitHttpUrl(value: string): string {
  return value.startsWith('wss://')
    ? `https://${value.slice('wss://'.length)}`
    : `http://${value.slice('ws://'.length)}`;
}

function optionalBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseTokenRecord(
  raw: string,
  line: number,
  scope: LiveKitBrowserTokenBundleScope
): LiveKitBrowserTokenRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`LiveKit token bundle line ${line} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`LiveKit token bundle line ${line} is not an object`);
  }
  const candidate = value as Record<string, unknown>;
  const roomOrdinal = boundedInteger(
    candidate.room_ordinal,
    scope.ordinal_start,
    scope.ordinal_end_exclusive - 1,
    `room ordinal at line ${line}`
  );
  const participantOrdinal = boundedInteger(
    candidate.participant_ordinal,
    0,
    scope.participants_per_room - 1,
    `participant ordinal at line ${line}`
  );
  const expectedRoom = `${scope.room_prefix}-${roomOrdinal}`;
  const roomName = safeText(candidate.room_name, 255, `room name at line ${line}`);
  if (roomName !== expectedRoom) {
    throw new Error(`LiveKit token bundle room name does not match its ordinal at line ${line}`);
  }
  const identity = safeText(candidate.identity, 128, `identity at line ${line}`);
  const token = safeText(candidate.token, 16_384, `token at line ${line}`);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(`LiveKit token bundle token is malformed at line ${line}`);
  }
  return {
    room_ordinal: roomOrdinal,
    participant_ordinal: participantOrdinal,
    room_name: roomName,
    identity,
    token
  };
}

function validateTokenBundleScope(scope: LiveKitBrowserTokenBundleScope): void {
  boundedInteger(scope.ordinal_start, 0, 10_000_000, 'room ordinal start');
  boundedInteger(
    scope.ordinal_end_exclusive,
    scope.ordinal_start + 1,
    10_000_001,
    'room ordinal end'
  );
  boundedInteger(scope.participants_per_room, 2, 64, 'participants per room');
  safeText(scope.room_prefix, 128, 'room prefix');
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`LiveKit browser ${label} is invalid`);
  }
  return value;
}

function safeShard(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^[A-Za-z0-9._:/-]{1,255}$/.test(value) ||
      value.includes('..')) {
    throw new Error('LiveKit browser shard ID is invalid');
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\r\n\u0000]/.test(value)) {
    throw new Error(`LiveKit browser ${label} must be an absolute path`);
  }
  return value;
}

function baselineInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`LiveKit browser ${label} is invalid`);
  }
  return Number(value);
}

function validateRoomMeasurement(measurement: LiveKitBrowserRoomMeasurement): void {
  nonNegativeInteger(measurement.room_ordinal, 'room ordinal');
  positiveInteger(measurement.connected_participants, 'connected participants');
  for (const [label, value] of Object.entries({
    'camera tracks': measurement.published_camera_tracks,
    'audio tracks': measurement.published_audio_tracks,
    'screen tracks': measurement.published_screen_tracks,
    'subscribed tracks': measurement.subscribed_tracks,
    'encoded video packets': measurement.encoded_video_packet_count,
    'encoded audio packets': measurement.encoded_audio_packet_count,
    'camera simulcast layers': measurement.camera_simulcast_layer_count,
    'camera receiver frames decoded': measurement.camera_receiver_frames_decoded,
    'camera receiver frames dropped': measurement.camera_receiver_frames_dropped,
    'camera receiver frames received': measurement.camera_receiver_frames_received,
    'steady-state warmup': measurement.steady_state_warmup_ms,
    'receiver jitter-buffer target':
      measurement.receiver_jitter_buffer_target_ms,
    'receiver jitter-buffer applied tracks':
      measurement.receiver_jitter_buffer_target_applied_track_count,
    'forced TURN participants': measurement.forced_turn_participants,
    'relay-only configured participants':
      measurement.forced_turn_relay_only_configured_participants,
    'selected candidate pairs':
      measurement.forced_turn_selected_candidate_pair_count,
    'selected relay candidate pairs':
      measurement.forced_turn_relay_candidate_pair_count,
    'TrackEgress completions': measurement.track_egress_completed,
    'RoomComposite Egress completions': measurement.room_composite_egress_completed,
    'freeze count': measurement.video_freeze_count,
    'WebRTC freeze-stat tracks':
      measurement.video_webrtc_freeze_stats_track_count,
    'render-callback freeze count':
      measurement.video_render_callback_freeze_count,
    'browser event-loop stall count':
      measurement.browser_event_loop_stall_count,
    'reconnect attempts': measurement.reconnect_attempt_count,
    'reconnect successes': measurement.reconnect_success_count,
    'stale epoch actions': measurement.stale_epoch_action_count
  })) {
    nonNegativeInteger(value, label);
  }
  positiveInteger(
    measurement.camera_receiver_frame_width,
    'camera receiver frame width'
  );
  positiveInteger(
    measurement.camera_receiver_frame_height,
    'camera receiver frame height'
  );
  if (!['auto', 'low', 'medium', 'high'].includes(
    measurement.camera_subscriber_video_quality
  )) {
    throw new Error('LiveKit browser subscriber video quality is invalid');
  }
  if (!['cold', 'signal_prewarmed'].includes(
    measurement.connection_preparation_mode
  )) {
    throw new Error('LiveKit browser connection preparation mode is invalid');
  }
  if (measurement.video_freeze_measurement_scope !== 'webrtc_inbound_rtp' &&
      measurement.video_freeze_measurement_scope !==
        'render_callback_fallback') {
    throw new Error('LiveKit browser freeze measurement scope is invalid');
  }
  if (measurement.receiver_jitter_buffer_target_ms === 0) {
    if (measurement.receiver_jitter_buffer_target_applied_track_count !== 0) {
      throw new Error(
        'LiveKit browser default jitter buffer contains applied-track evidence'
      );
    }
  } else if (measurement.receiver_jitter_buffer_target_applied_track_count !==
      measurement.subscribed_tracks) {
    throw new Error(
      'LiveKit browser receiver jitter buffer does not cover every subscribed track'
    );
  }
  if (measurement.reconnect_success_count > measurement.reconnect_attempt_count) {
    throw new Error('LiveKit browser reconnect successes exceed attempts');
  }
  if (measurement.forced_turn_relay_only_configured_participants === 0) {
    if (measurement.forced_turn_participants !== 0 ||
        measurement.forced_turn_selected_candidate_pair_count !== 0 ||
        measurement.forced_turn_relay_candidate_pair_count !== 0 ||
        measurement.forced_turn_transport_protocols.length !== 0 ||
        measurement.forced_turn_current_round_trip_ms.length !== 0 ||
        measurement.forced_turn_scope !== 'none') {
      throw new Error('LiveKit browser non-TURN room contains forced TURN provenance');
    }
  } else {
    if (measurement.forced_turn_scope !== 'relay_only_selected_candidate_pair' ||
        measurement.forced_turn_participants !==
          measurement.forced_turn_relay_only_configured_participants ||
        measurement.forced_turn_selected_candidate_pair_count <= 0 ||
        measurement.forced_turn_relay_candidate_pair_count !==
          measurement.forced_turn_selected_candidate_pair_count) {
      throw new Error('LiveKit browser forced TURN candidate-pair provenance is invalid');
    }
    if (measurement.forced_turn_transport_protocols.length !==
        measurement.forced_turn_selected_candidate_pair_count ||
        measurement.forced_turn_transport_protocols.some(
          (protocol) => protocol !== 'udp' && protocol !== 'tcp'
        )) {
      throw new Error('LiveKit browser forced TURN transport protocol is invalid');
    }
    finiteArray(
      measurement.forced_turn_current_round_trip_ms,
      'forced TURN round-trip samples',
      true
    );
  }
  if (measurement.reconnect_attempt_count === 0) {
    if (measurement.reconnect_scope !== 'none' ||
        measurement.reconnect_blackout_ms !== 0 ||
        measurement.reconnect_blackout_observed_ms !== 0 ||
        measurement.reconnect_blackout_started_at_ms !== 0 ||
        measurement.reconnect_recovery_endpoint_scope !== 'none') {
      throw new Error('LiveKit browser non-reconnect room contains reconnect provenance');
    }
  } else {
    if (measurement.reconnect_scope !== 'room_correlated_cdp_offline' ||
        measurement.reconnect_recovery_endpoint_scope !== 'decoded_audio_video') {
      throw new Error('LiveKit browser reconnect provenance is invalid');
    }
    if (!Number.isSafeInteger(measurement.reconnect_blackout_ms) ||
        measurement.reconnect_blackout_ms < 1_000 ||
        measurement.reconnect_blackout_ms > 30_000) {
      throw new Error('LiveKit browser reconnect blackout is invalid');
    }
    positive(
      measurement.reconnect_blackout_observed_ms,
      'observed reconnect blackout'
    );
    positive(
      measurement.reconnect_blackout_started_at_ms,
      'reconnect blackout start'
    );
  }
  finiteArray(measurement.join_ms, 'join samples', true);
  if (measurement.join_ms.length !== measurement.connected_participants) {
    throw new Error('LiveKit browser join samples do not cover every connected participant');
  }
  finiteArray(measurement.camera_bitrate_bps, 'camera bitrate samples',
    measurement.published_camera_tracks > 0);
  finiteArray(measurement.camera_total_bitrate_bps, 'camera total bitrate samples',
    measurement.published_camera_tracks > 0);
  for (const [label, value] of Object.entries({
    'camera primary target bitrate': measurement.camera_primary_target_bitrate_bps,
    'camera primary frame width': measurement.camera_primary_frame_width,
    'camera primary frame height': measurement.camera_primary_frame_height,
    'camera primary frames per second': measurement.camera_primary_frames_per_second,
    'camera sender bandwidth-limited duration':
      measurement.camera_sender_bandwidth_limited_seconds,
    'camera sender CPU-limited duration':
      measurement.camera_sender_cpu_limited_seconds,
    'render-callback freeze duration':
      measurement.video_render_callback_freeze_duration_ms,
    'render-callback stall overlap duration':
      measurement.video_render_callback_stall_overlap_duration_ms,
    'browser event-loop stall duration':
      measurement.browser_event_loop_stall_duration_ms,
    'browser event-loop stall maximum':
      measurement.browser_event_loop_stall_max_ms,
    'primary media publish completion':
      measurement.primary_media_publish_completed_ms,
    'remote tracks ready':
      measurement.remote_tracks_ready_ms,
    'first audio after remote tracks ready':
      measurement.first_audio_after_remote_tracks_ready_ms,
    'first video frame after remote tracks ready':
      measurement.first_video_frame_after_remote_tracks_ready_ms,
    'video frame-gap P95': measurement.video_frame_gap_p95_ms,
    'video frame-gap P99': measurement.video_frame_gap_p99_ms,
    'video frame-gap maximum': measurement.video_frame_gap_max_ms
  })) {
    nonNegative(value, label);
  }
  if (measurement.video_frame_gap_p95_ms > measurement.video_frame_gap_p99_ms ||
      measurement.video_frame_gap_p99_ms > measurement.video_frame_gap_max_ms) {
    throw new Error('LiveKit browser video frame-gap percentile order is invalid');
  }
  finiteArray(measurement.screen_bitrate_bps, 'screen bitrate samples',
    measurement.published_screen_tracks > 0);
  finiteArray(measurement.first_audio_ms, 'first audio samples',
    measurement.published_audio_tracks > 0);
  finiteArray(measurement.first_video_ms, 'first video samples',
    measurement.published_camera_tracks > 0);
  finiteArray(measurement.first_screen_frame_ms, 'first screen frame samples',
    measurement.published_screen_tracks > 0);
  finiteArray(measurement.glass_to_glass_ms, 'glass-to-glass samples',
    measurement.published_camera_tracks > 0);
  finiteArray(measurement.screen_glass_to_glass_ms, 'screen glass-to-glass samples',
    measurement.published_screen_tracks > 0);
  finiteArray(measurement.endpoint_packet_loss_ratio, 'packet-loss samples', true, true);
  finiteArray(measurement.jitter_ms, 'jitter samples', true);
  finiteArray(measurement.av_sync_absolute_ms, 'A/V sync samples',
    measurement.published_audio_tracks > 0 &&
    measurement.published_camera_tracks > 0);
  if (measurement.audio_endpoint_scope !== 'decoded_frame' &&
      measurement.audio_endpoint_scope !== 'playout') {
    throw new Error('LiveKit browser audio endpoint scope is invalid');
  }
  finiteArray(measurement.reconnect_recovery_ms, 'reconnect recovery samples', false);
  nonNegative(measurement.video_freeze_duration_ms, 'freeze duration');
  positive(measurement.video_observation_duration_ms, 'video observation duration');
  positive(measurement.measurement_window_duration_ms, 'measurement window duration');
  if (measurement.video_render_callback_stall_overlap_duration_ms >
      measurement.video_render_callback_freeze_duration_ms) {
    throw new Error(
      'LiveKit browser render-callback stall overlap exceeds freeze duration'
    );
  }
  if (measurement.video_freeze_duration_ms > measurement.video_observation_duration_ms) {
    throw new Error('LiveKit browser freeze duration exceeds video observation duration');
  }
}

function validateGeneratorObservation(generator: LiveKitBrowserGeneratorObservation): void {
  if (generator.generator_observation_source !== 'external' &&
      generator.generator_observation_source !== 'linux_proc_tree') {
    throw new Error('LiveKit browser generator observation source is invalid');
  }
  positiveInteger(
    generator.generator_observation_sample_count,
    'generator observation sample count'
  );
  linuxNetworkInterface(generator.generator_network_interface);
  positiveInteger(generator.generator_nic_capacity_bps, 'generator NIC capacity');
  ratioValue(generator.generator_cpu_p95_ratio, 'generator CPU P95 ratio');
  ratioValue(generator.host_cpu_p95_ratio, 'host CPU P95 ratio');
  ratioValue(generator.generator_nic_p95_ratio, 'generator NIC P95 ratio');
  nonNegativeInteger(generator.host_packet_drop_count, 'host packet drops');
  const hasHostWitnessSource = generator.host_witness_source !== undefined;
  const hasHostBootHash = generator.host_boot_id_sha256 !== undefined;
  if (hasHostWitnessSource || hasHostBootHash) {
    if (generator.host_witness_source !== 'linux_boot_id_sha256' ||
        typeof generator.host_boot_id_sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(generator.host_boot_id_sha256)) {
      throw new Error('LiveKit browser generator host witness is invalid');
    }
  }
}

function linuxNetworkInterface(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value)) {
    throw new Error('LiveKit browser generator network interface is invalid');
  }
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`LiveKit token bundle ${label} is invalid`);
  }
  return Number(value);
}

function safeText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== 'string' || !value || value.length > maximumLength ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`LiveKit token bundle ${label} is invalid`);
  }
  return value;
}

function finiteArray(
  values: readonly number[],
  label: string,
  required: boolean,
  ratios = false
): void {
  if (!Array.isArray(values) || (required && values.length === 0)) {
    throw new Error(`LiveKit browser ${label} are required`);
  }
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || (ratios && value > 1)) {
      throw new Error(`LiveKit browser ${label} contain an invalid value`);
    }
  }
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) throw new Error('LiveKit browser percentile requires samples');
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function percentileOrZero(values: readonly number[], ratio: number): number {
  return values.length ? percentile(values, ratio) : 0;
}

function peakReconnectAttemptsPerSecond(
  starts: ReadonlyArray<{ started_at_ms: number; attempt_count: number }>
): number {
  if (starts.length === 0) return 0;
  const ordered = [...starts].sort(
    (left, right) => left.started_at_ms - right.started_at_ms
  );
  let peak = 0;
  let current = 0;
  let left = 0;
  for (let right = 0; right < ordered.length; right += 1) {
    current += ordered[right].attempt_count;
    while (ordered[right].started_at_ms - ordered[left].started_at_ms > 1_000) {
      current -= ordered[left].attempt_count;
      left += 1;
    }
    peak = Math.max(peak, current);
  }
  return peak;
}

function mean(values: readonly number[], allowEmpty = false): number {
  if (values.length === 0) {
    if (allowEmpty) return 0;
    throw new Error('LiveKit browser mean requires samples');
  }
  return sum(values) / values.length;
}

function jainFairness(values: readonly number[]): number {
  if (values.length === 0) throw new Error('LiveKit browser fairness requires samples');
  const total = sum(values);
  const squareTotal = sum(values.map((value) => value * value));
  if (squareTotal === 0) return 0;
  return total * total / (values.length * squareTotal);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function positiveInteger(value: number, label: string): void {
  nonNegativeInteger(value, label);
  if (value === 0) throw new Error(`LiveKit browser ${label} must be positive`);
}

function nonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`LiveKit browser ${label} must be a non-negative integer`);
  }
}

function positive(value: number, label: string): void {
  nonNegative(value, label);
  if (value === 0) throw new Error(`LiveKit browser ${label} must be positive`);
}

function nonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`LiveKit browser ${label} must be finite and non-negative`);
  }
}

function ratioValue(value: number, label: string): void {
  nonNegative(value, label);
  if (value > 1) throw new Error(`LiveKit browser ${label} must not exceed one`);
}

function crc8(marker: number): number {
  let crc = 0;
  for (const byte of [(marker >>> 8) & 0xff, marker & 0xff]) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

async function readBoundedStdin(maximumBytes = 4 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error('LiveKit browser input exceeds 4 MiB');
    chunks.push(buffer);
  }
  if (bytes === 0) throw new Error('LiveKit browser input is empty');
  return Buffer.concat(chunks).toString('utf8');
}

function redactLiveKitBrowserError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]')
    .slice(0, 1_000);
}

async function main(): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(await readBoundedStdin());
  } catch (error) {
    throw new Error(`LiveKit browser input is not valid JSON: ${redactLiveKitBrowserError(error)}`);
  }
  validateLiveKitBrowserBaselineInput(input);
  parseLiveKitBrowserCapacityArgs(process.argv.slice(2), input);
  const runtime = await createDefaultLiveKitBrowserCapacityRuntime();
  const result = await runLiveKitBrowserCapacity(input, runtime);
  process.stdout.write(`${JSON.stringify({
    status: 'collected',
    result_path: input.result_path,
    connected_rooms: result.connected_rooms,
    connected_participants: result.connected_participants
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(redactLiveKitBrowserError(error));
    process.exitCode = 1;
  });
}
