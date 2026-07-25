import { createHash } from 'node:crypto';

import { hashLinuxCommandArguments } from '../../ivekit-linux-process-observer.js';

export interface LiveKitNativeWorkloadManifest {
  schema_version: '1.0.0';
  protocol: 'livekit_cli_load_test';
  run_id: string;
  topology: 'single_large_room';
  room_count: 1;
  room_name_sha256: string;
  identity_prefix_sha256: string;
  duration_seconds: number;
  video_publishers: number;
  audio_publishers: number;
  subscribers: number;
  participant_count: number;
  expected_subscribed_tracks: number;
  start_rate_per_second: number;
  layout: 'speaker' | '3x3' | '4x4' | '5x5';
  video_resolution: 'high' | 'medium' | 'low';
  video_codec: 'h264' | 'vp8' | 'mixed';
  simulcast: boolean;
  simulate_speakers: boolean;
  executable_sha256: string;
  command_arg_count: number;
  command_args_sha256: string;
}

export function validateLiveKitNativeWorkloadManifest(
  value: unknown
): asserts value is LiveKitNativeWorkloadManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LiveKit native workload manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  const expectedFields: Array<keyof LiveKitNativeWorkloadManifest> = [
    'schema_version',
    'protocol',
    'run_id',
    'topology',
    'room_count',
    'room_name_sha256',
    'identity_prefix_sha256',
    'duration_seconds',
    'video_publishers',
    'audio_publishers',
    'subscribers',
    'participant_count',
    'expected_subscribed_tracks',
    'start_rate_per_second',
    'layout',
    'video_resolution',
    'video_codec',
    'simulcast',
    'simulate_speakers',
    'executable_sha256',
    'command_arg_count',
    'command_args_sha256'
  ];
  const actualFields = Object.keys(manifest).sort();
  const unexpectedFields = actualFields.filter(
    (field) => !expectedFields.includes(field as keyof LiveKitNativeWorkloadManifest)
  );
  const missingFields = expectedFields.filter((field) => !actualFields.includes(field));
  if (unexpectedFields.length > 0) {
    throw new Error(
      `LiveKit native workload manifest has unexpected fields: ${unexpectedFields.join(', ')}`
    );
  }
  if (missingFields.length > 0) {
    throw new Error(
      `LiveKit native workload manifest has missing fields: ${missingFields.join(', ')}`
    );
  }
  if (manifest.schema_version !== '1.0.0' ||
      manifest.protocol !== 'livekit_cli_load_test' ||
      manifest.topology !== 'single_large_room' ||
      manifest.room_count !== 1) {
    throw new Error('LiveKit native workload manifest identity is invalid');
  }
  safeRunId(String(manifest.run_id || ''));
  sha256(String(manifest.room_name_sha256 || ''), 'room name SHA-256');
  sha256(String(manifest.identity_prefix_sha256 || ''), 'identity prefix SHA-256');
  sha256(String(manifest.executable_sha256 || ''), 'executable SHA-256');
  sha256(String(manifest.command_args_sha256 || ''), 'command arguments SHA-256');
  const duration = manifestInteger(manifest.duration_seconds, 1, 86_400, 'duration');
  const videoPublishers = manifestInteger(
    manifest.video_publishers,
    0,
    100_000,
    'video publishers'
  );
  const audioPublishers = manifestInteger(
    manifest.audio_publishers,
    0,
    100_000,
    'audio publishers'
  );
  const subscribers = manifestInteger(manifest.subscribers, 1, 1_000_000, 'subscribers');
  const participants = manifestInteger(
    manifest.participant_count,
    1,
    1_000_000,
    'participant count'
  );
  const expectedTracks = manifestInteger(
    manifest.expected_subscribed_tracks,
    1,
    Number.MAX_SAFE_INTEGER,
    'expected subscribed tracks'
  );
  manifestInteger(manifest.start_rate_per_second, 1, 1_000_000, 'start rate');
  manifestInteger(manifest.command_arg_count, 1, 10_000, 'command argument count');
  if (duration <= 0 || videoPublishers + audioPublishers === 0) {
    throw new Error('LiveKit native workload manifest media shape is invalid');
  }
  if (participants !== videoPublishers + audioPublishers + subscribers) {
    throw new Error('LiveKit native workload manifest participant_count formula is invalid');
  }
  if (expectedTracks !== (videoPublishers + audioPublishers) * subscribers) {
    throw new Error(
      'LiveKit native workload manifest expected_subscribed_tracks formula is invalid'
    );
  }
  enumeration(String(manifest.layout || ''), ['speaker', '3x3', '4x4', '5x5'] as const, 'layout');
  enumeration(
    String(manifest.video_resolution || ''),
    ['high', 'medium', 'low'] as const,
    'video resolution'
  );
  enumeration(String(manifest.video_codec || ''), ['h264', 'vp8', 'mixed'] as const, 'video codec');
  if (typeof manifest.simulcast !== 'boolean' ||
      typeof manifest.simulate_speakers !== 'boolean') {
    throw new Error('LiveKit native workload manifest flags are invalid');
  }
}

export function buildLiveKitNativeWorkloadManifest(input: {
  run_id: string;
  executable_sha256: string;
  args: readonly string[];
}): LiveKitNativeWorkloadManifest {
  safeRunId(input.run_id);
  sha256(input.executable_sha256, 'executable SHA-256');
  const parsed = parseLoadTestArgs(input.args);
  const videoPublishers = nonNegativeInteger(
    required(parsed.values, 'video_publishers'),
    'video publishers'
  );
  const audioPublishers = nonNegativeInteger(
    required(parsed.values, 'audio_publishers'),
    'audio publishers'
  );
  const subscribers = positiveInteger(
    required(parsed.values, 'subscribers'),
    'subscribers'
  );
  if (videoPublishers + audioPublishers === 0) {
    throw new Error('LiveKit load-test requires at least one publisher');
  }
  const expectedTracks = (videoPublishers + audioPublishers) * subscribers;
  if (!Number.isSafeInteger(expectedTracks) || expectedTracks <= 0) {
    throw new Error('LiveKit load-test expected tracks are invalid');
  }
  const room = required(parsed.values, 'room');
  const identityPrefix = required(parsed.values, 'identity_prefix');
  const layout = enumeration(
    required(parsed.values, 'layout'),
    ['speaker', '3x3', '4x4', '5x5'] as const,
    'layout'
  );
  const resolution = enumeration(
    required(parsed.values, 'video_resolution'),
    ['high', 'medium', 'low'] as const,
    'video resolution'
  );
  const codec = parsed.values.get('video_codec')
    ? enumeration(
      parsed.values.get('video_codec') as string,
      ['h264', 'vp8'] as const,
      'video codec'
    )
    : 'mixed';
  return {
    schema_version: '1.0.0',
    protocol: 'livekit_cli_load_test',
    run_id: input.run_id,
    topology: 'single_large_room',
    room_count: 1,
    room_name_sha256: hashText(room),
    identity_prefix_sha256: hashText(identityPrefix),
    duration_seconds: durationSeconds(required(parsed.values, 'duration')),
    video_publishers: videoPublishers,
    audio_publishers: audioPublishers,
    subscribers,
    participant_count: videoPublishers + audioPublishers + subscribers,
    expected_subscribed_tracks: expectedTracks,
    start_rate_per_second: positiveInteger(
      required(parsed.values, 'start_rate'),
      'start rate'
    ),
    layout,
    video_resolution: resolution,
    video_codec: codec,
    simulcast: !parsed.flags.has('no_simulcast'),
    simulate_speakers: parsed.flags.has('simulate_speakers'),
    executable_sha256: input.executable_sha256,
    command_arg_count: input.args.length,
    command_args_sha256: hashLinuxCommandArguments(input.args)
  };
}

function parseLoadTestArgs(args: readonly string[]): {
  values: Map<string, string>;
  flags: Set<string>;
} {
  if (!Array.isArray(args) || args.filter((value) => value === 'load-test').length !== 1) {
    throw new Error('LiveKit load-test command is required exactly once');
  }
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Map<string, string>([
    ['--room', 'room'],
    ['--duration', 'duration'],
    ['--video-publishers', 'video_publishers'],
    ['--publishers', 'video_publishers'],
    ['--audio-publishers', 'audio_publishers'],
    ['--subscribers', 'subscribers'],
    ['--identity-prefix', 'identity_prefix'],
    ['--video-resolution', 'video_resolution'],
    ['--video-codec', 'video_codec'],
    ['--num-per-second', 'start_rate'],
    ['--layout', 'layout'],
    ['--url', 'ignored_url'],
    ['--api-key', 'ignored_api_key'],
    ['--api-secret', 'ignored_api_secret'],
    ['--project', 'ignored_project'],
    ['--subdomain', 'ignored_subdomain'],
    ['--config', 'ignored_config']
  ]);
  const flagOptions = new Map<string, string>([
    ['--no-simulcast', 'no_simulcast'],
    ['--simulate-speakers', 'simulate_speakers'],
    ['--dev', 'ignored_dev'],
    ['--curl', 'ignored_curl'],
    ['--verbose', 'ignored_verbose'],
    ['--yes', 'ignored_yes'],
    ['-y', 'ignored_yes'],
    ['--quiet', 'ignored_quiet'],
    ['-q', 'ignored_quiet'],
    ['--silent', 'ignored_quiet']
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === 'load-test') continue;
    const valueName = valueOptions.get(option);
    if (valueName) {
      const value = args[index + 1];
      if (!value || value.startsWith('--') || value.includes('\u0000')) {
        throw new Error(`LiveKit load-test option ${option} is invalid`);
      }
      if (!valueName.startsWith('ignored_') && values.has(valueName)) {
        throw new Error(`LiveKit load-test option ${option} is duplicated`);
      }
      if (!valueName.startsWith('ignored_')) values.set(valueName, value);
      index += 1;
      continue;
    }
    const flagName = flagOptions.get(option);
    if (flagName) {
      if (!flagName.startsWith('ignored_') && flags.has(flagName)) {
        throw new Error(`LiveKit load-test option ${option} is duplicated`);
      }
      if (!flagName.startsWith('ignored_')) flags.add(flagName);
      continue;
    }
    throw new Error(`LiveKit load-test unknown option: ${option}`);
  }
  return { values, flags };
}

function durationSeconds(value: string): number {
  const pattern = /([0-9]+(?:\.[0-9]+)?)(h|m|s)/g;
  let seconds = 0;
  let consumed = '';
  for (const match of value.matchAll(pattern)) {
    consumed += match[0];
    const amount = Number(match[1]);
    seconds += amount * (match[2] === 'h' ? 3_600 : match[2] === 'm' ? 60 : 1);
  }
  if (consumed !== value || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400) {
    throw new Error('LiveKit load-test duration is invalid');
  }
  return seconds;
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`LiveKit load-test ${name.replaceAll('_', ' ')} is required`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`LiveKit load-test ${label} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`LiveKit load-test ${label} is invalid`);
  }
  return parsed;
}

function manifestInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`LiveKit native workload manifest ${label} is invalid`);
  }
  return Number(value);
}

function enumeration<const T extends readonly string[]>(
  value: string,
  allowed: T,
  label: string
): T[number] {
  if (!allowed.includes(value)) throw new Error(`LiveKit load-test ${label} is invalid`);
  return value as T[number];
}

function hashText(value: string): string {
  if (!value || value.length > 255 || /[\r\n\u0000]/.test(value)) {
    throw new Error('LiveKit load-test private label is invalid');
  }
  return createHash('sha256').update(value).digest('hex');
}

function safeRunId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) {
    throw new Error('invalid LiveKit native workload run ID');
  }
}

function sha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid LiveKit ${label}`);
}
