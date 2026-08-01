import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildLiveKitNativeWorkloadManifest,
  validateLiveKitNativeWorkloadManifest
} from '../scripts/capacity/generators/livekit-native-workload.js';

const EXECUTABLE_SHA256 = 'a'.repeat(64);
const COMMAND_ARGS = [
  '--url', 'ws://127.0.0.1:7880',
  '--api-key', 'test-key',
  '--api-secret', 'must-not-appear',
  'load-test',
  '--room', 'private-room-label',
  '--duration', '1m',
  '--video-publishers', '3',
  '--audio-publishers', '3',
  '--subscribers', '15',
  '--identity-prefix', 'large-room-peer',
  '--video-resolution', 'high',
  '--num-per-second', '20',
  '--layout', '3x3',
  '--simulate-speakers'
];

test('LiveKit native workload binds a large-room shape without retaining command secrets', () => {
  const manifest = buildLiveKitNativeWorkloadManifest({
    run_id: 'livekit-large-room-001',
    executable_sha256: EXECUTABLE_SHA256,
    args: COMMAND_ARGS
  });

  assert.equal(manifest.schema_version, '1.0.0');
  assert.equal(manifest.protocol, 'livekit_cli_load_test');
  assert.equal(manifest.topology, 'single_large_room');
  assert.equal(manifest.room_count, 1);
  assert.equal(manifest.duration_seconds, 60);
  assert.equal(manifest.video_publishers, 3);
  assert.equal(manifest.audio_publishers, 3);
  assert.equal(manifest.subscribers, 15);
  assert.equal(manifest.participant_count, 21);
  assert.equal(manifest.expected_subscribed_tracks, 90);
  assert.equal(manifest.start_rate_per_second, 20);
  assert.equal(manifest.layout, '3x3');
  assert.equal(manifest.video_resolution, 'high');
  assert.equal(manifest.video_codec, 'mixed');
  assert.equal(manifest.simulcast, true);
  assert.equal(manifest.simulate_speakers, true);
  assert.match(manifest.room_name_sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.identity_prefix_sha256, /^[0-9a-f]{64}$/);
  assert.match(manifest.command_args_sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.executable_sha256, EXECUTABLE_SHA256);
  assert.equal(JSON.stringify(manifest).includes('must-not-appear'), false);
  assert.equal(JSON.stringify(manifest).includes('private-room-label'), false);
  assert.equal(JSON.stringify(manifest).includes('large-room-peer'), false);
  assert.equal(JSON.stringify(manifest).includes('ws://'), false);
});

test('LiveKit native workload changes its command witness when a hidden argument changes', () => {
  const first = buildLiveKitNativeWorkloadManifest({
    run_id: 'livekit-large-room-001',
    executable_sha256: EXECUTABLE_SHA256,
    args: COMMAND_ARGS
  });
  const second = buildLiveKitNativeWorkloadManifest({
    run_id: 'livekit-large-room-001',
    executable_sha256: EXECUTABLE_SHA256,
    args: COMMAND_ARGS.map((value) => value === 'must-not-appear' ? 'rotated-secret' : value)
  });

  assert.notEqual(first.command_args_sha256, second.command_args_sha256);
  assert.deepEqual(
    { ...first, command_args_sha256: '' },
    { ...second, command_args_sha256: '' }
  );
});

test('LiveKit native workload rejects implicit or ambiguous load shapes', () => {
  assert.throws(
    () => buildLiveKitNativeWorkloadManifest({
      run_id: 'livekit-large-room-001',
      executable_sha256: EXECUTABLE_SHA256,
      args: COMMAND_ARGS.filter((value, index) =>
        value !== '--duration' && COMMAND_ARGS[index - 1] !== '--duration')
    }),
    /duration.*required/i
  );
  assert.throws(
    () => buildLiveKitNativeWorkloadManifest({
      run_id: 'livekit-large-room-001',
      executable_sha256: EXECUTABLE_SHA256,
      args: [...COMMAND_ARGS, '--unknown-load-option']
    }),
    /unknown.*option/i
  );
});

test('LiveKit native workload validation rejects tampered formulas and secret fields', () => {
  const manifest = buildLiveKitNativeWorkloadManifest({
    run_id: 'livekit-large-room-001',
    executable_sha256: EXECUTABLE_SHA256,
    args: COMMAND_ARGS
  });

  assert.throws(
    () => validateLiveKitNativeWorkloadManifest({
      ...manifest,
      participant_count: manifest.participant_count + 1
    }),
    /participant_count/i
  );
  assert.throws(
    () => validateLiveKitNativeWorkloadManifest({
      ...manifest,
      api_secret: 'must-not-be-accepted'
    }),
    /unexpected.*api_secret/i
  );
});

test('LiveKit native workload CLI is packaged for repeatable campaigns', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['converact:capacity:livekit-native-workload'],
    'tsx scripts/converact-livekit-native-workload.ts'
  );
});

test('LiveKit native workload CLI writes private non-overwriting manifests', async () => {
  const module = await import('../scripts/converact-livekit-native-workload.js');
  const directory = mkdtempSync(join(tmpdir(), 'converact-livekit-native-workload-'));
  const resultPath = join(directory, 'workload.json');
  const parsed = module.parseLiveKitNativeWorkloadArgs([
    '--run-id', 'livekit-large-room-001',
    '--executable', process.execPath,
    '--result', resultPath,
    '--',
    ...COMMAND_ARGS
  ]);
  try {
    const manifest = await module.runLiveKitNativeWorkload(parsed);
    assert.equal(manifest.expected_subscribed_tracks, 90);
    assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(readFileSync(resultPath, 'utf8')).command_args_sha256,
      manifest.command_args_sha256
    );
    await assert.rejects(
      module.runLiveKitNativeWorkload(parsed),
      /already exists/i
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
