import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const SCRIPT_PATH = new URL('../scripts/livekit-storage-isolation-acceptance.ts', import.meta.url);

test('storage isolation acceptance is a packaged repeatable command', () => {
  assert.equal(existsSync(SCRIPT_PATH), true);
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { scripts: Record<string, string> };
  assert.equal(
    packageJson.scripts['livekit:storage-isolation-acceptance'],
    'tsx scripts/livekit-storage-isolation-acceptance.ts'
  );
  assert.match(
    readFileSync(new URL('../scripts/ivekit-delivery-bundle.ts', import.meta.url), 'utf8'),
    /livekit-storage-isolation-acceptance\.ts/
  );
});

test('storage isolation acceptance exports config continuity and failure classifiers', async () => {
  const module = await import('../scripts/livekit-storage-isolation-acceptance.js');

  assert.equal(typeof module.createLiveKitStorageIsolationConfigFromEnv, 'function');
  assert.equal(typeof module.assertLiveKitMediaContinuity, 'function');
  assert.equal(typeof module.classifyLiveKitEgressFailure, 'function');
  assert.equal(typeof module.runLiveKitStorageIsolationAcceptance, 'function');
  assert.equal(typeof module.createDefaultLiveKitStorageIsolationRuntime, 'function');
  assert.equal(typeof module.writeLiveKitStorageIsolationResult, 'function');
  assert.equal(typeof module.createLiveKitStorageIsolationComposeArgs, 'function');
});

test('storage isolation config is explicit and rejects unsafe control input', async () => {
  const {
    createLiveKitStorageIsolationComposeArgs,
    createLiveKitStorageIsolationConfigFromEnv
  } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );
  const config = createLiveKitStorageIsolationConfigFromEnv({
    LIVEKIT_URL: 'ws://127.0.0.1:7880',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT: 'ivekit-fresh-audit',
    OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES: '["deploy/livekit/docker-compose.yml","deploy/livekit/docker-compose.storage.yml"]',
    OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_ENV_FILE: 'deploy/livekit/.env',
    OPC_LIVEKIT_STORAGE_ISOLATION_OUTPUT_FILE: '/tmp/ivekit-storage-isolation.json',
    OPC_LIVEKIT_STORAGE_ISOLATION_TIMEOUT_MS: '45000'
  });

  assert.deepEqual(config, {
    livekitUrl: 'ws://127.0.0.1:7880',
    apiKey: 'devkey',
    apiSecret: 'secret',
    composeProject: 'ivekit-fresh-audit',
    composeFiles: [
      'deploy/livekit/docker-compose.yml',
      'deploy/livekit/docker-compose.storage.yml'
    ],
    composeEnvFile: 'deploy/livekit/.env',
    storageService: 'minio',
    storageInitService: 'minio-init',
    outputFile: '/tmp/ivekit-storage-isolation.json',
    timeoutMs: 45000
  });
  assert.deepEqual(createLiveKitStorageIsolationComposeArgs(config, ['stop', 'minio']), [
    'compose',
    '--env-file', 'deploy/livekit/.env',
    '-p', 'ivekit-fresh-audit',
    '-f', 'deploy/livekit/docker-compose.yml',
    '-f', 'deploy/livekit/docker-compose.storage.yml',
    'stop', 'minio'
  ]);

  for (const env of [
    {},
    {
      LIVEKIT_URL: 'ws://user:password@127.0.0.1:7880?secret=value',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT: 'ivekit-fresh-audit'
    },
    {
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'devkey\ninjected',
      LIVEKIT_API_SECRET: 'secret',
      OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT: 'ivekit-fresh-audit'
    },
    {
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT: 'ivekit-fresh-audit',
      OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES: '[]'
    },
    {
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT: 'ivekit-fresh-audit',
      OPC_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES: '["one.yml",42]'
    }
  ]) {
    assert.throws(() => createLiveKitStorageIsolationConfigFromEnv(env), /required|invalid/i);
  }
});

test('storage isolation continuity requires two connected peers and all media publications', async () => {
  const { assertLiveKitMediaContinuity } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );
  const healthy = [
    {
      identity: 'agent-a', state: 'connected', remoteParticipants: 1,
      remotePublications: 2, localPublications: 2
    },
    {
      identity: 'agent-b', state: 'connected', remoteParticipants: 1,
      remotePublications: 2, localPublications: 2
    }
  ];

  assert.doesNotThrow(() => assertLiveKitMediaContinuity(healthy));
  assert.throws(
    () => assertLiveKitMediaContinuity(healthy.map((peer, index) =>
      index === 0 ? { ...peer, state: 'disconnected' } : peer
    )),
    /media continuity/i
  );
  assert.throws(
    () => assertLiveKitMediaContinuity(healthy.map((peer, index) =>
      index === 1 ? { ...peer, remotePublications: 1 } : peer
    )),
    /media continuity/i
  );
});

test('storage isolation report classifies upload failures without preserving raw endpoints', async () => {
  const { classifyLiveKitEgressFailure } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );

  assert.equal(
    classifyLiveKitEgressFailure('S3 upload failed: Put "http://minio:9000/recordings/a.mp4": EOF'),
    'storage_upload_failed'
  );
  assert.equal(classifyLiveKitEgressFailure('pipeline exited unexpectedly'), 'egress_failed');
});

test('storage isolation runtime proves media continuity and restores storage', async () => {
  const { runLiveKitStorageIsolationAcceptance } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );
  const events: string[] = [];
  let storageStopped = false;
  const result = await runLiveKitStorageIsolationAcceptance(storageIsolationConfig(), {
    async createRoom(roomName) { events.push(`create:${roomName}`); },
    async deleteRoom(roomName) { events.push(`delete:${roomName}`); },
    async openPeers() { events.push('open_peers'); },
    async closePeers() { events.push('close_peers'); },
    async snapshotPeers() { return healthyPeerSnapshots(); },
    async startRecording() { events.push('start_recording'); return { egressId: 'EG_storage_1' }; },
    async getRecording() {
      return storageStopped
        ? { status: 'failed', error: 'S3 PutObject http://minio:9000/recordings failed' }
        : { status: 'active', error: '' };
    },
    async stopRecording() { events.push('stop_recording'); },
    async stopStorage() { storageStopped = true; events.push('stop_storage'); },
    async restoreStorage() { storageStopped = false; events.push('restore_storage'); },
    async wait() {}
  });

  assert.equal(result.status, 'passed_controlled_local');
  assert.equal(result.egress_id, 'EG_storage_1');
  assert.equal(result.recording_terminal_status, 'failed');
  assert.equal(result.recording_failure_code, 'storage_upload_failed');
  assert.equal(result.storage_recovered, true);
  assert.doesNotMatch(JSON.stringify(result), /minio:9000|PutObject|S3 /i);
  assert.ok(events.indexOf('stop_storage') < events.indexOf('restore_storage'));
  assert.ok(events.indexOf('restore_storage') < events.indexOf('close_peers'));
  assert.match(events.at(-1) || '', /^delete:/);
});

test('storage isolation runtime restores storage after a media continuity failure', async () => {
  const { runLiveKitStorageIsolationAcceptance } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );
  const events: string[] = [];
  let snapshots = 0;

  await assert.rejects(
    runLiveKitStorageIsolationAcceptance(storageIsolationConfig(), {
      async createRoom() {},
      async deleteRoom() { events.push('delete_room'); },
      async openPeers() {},
      async closePeers() { events.push('close_peers'); },
      async snapshotPeers() {
        snapshots += 1;
        return snapshots === 1
          ? healthyPeerSnapshots()
          : healthyPeerSnapshots().map((peer, index) =>
              index === 0 ? { ...peer, state: 'disconnected' } : peer
            );
      },
      async startRecording() { return { egressId: 'EG_storage_2' }; },
      async getRecording() { return { status: 'active', error: '' }; },
      async stopRecording() {},
      async stopStorage() { events.push('stop_storage'); },
      async restoreStorage() { events.push('restore_storage'); },
      async wait() {}
    }),
    /media continuity/i
  );

  assert.deepEqual(events, ['stop_storage', 'restore_storage', 'close_peers', 'delete_room']);
});

test('storage isolation runtime closes partially opened peers', async () => {
  const { runLiveKitStorageIsolationAcceptance } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );
  const events: string[] = [];

  await assert.rejects(
    runLiveKitStorageIsolationAcceptance(storageIsolationConfig(), {
      async createRoom() { events.push('create_room'); },
      async deleteRoom() { events.push('delete_room'); },
      async openPeers() { events.push('open_peers'); throw new Error('second peer failed'); },
      async closePeers() { events.push('close_peers'); },
      async snapshotPeers() { return []; },
      async startRecording() { throw new Error('unexpected recording'); },
      async getRecording() { throw new Error('unexpected recording'); },
      async stopRecording() {},
      async stopStorage() {},
      async restoreStorage() {},
      async wait() {}
    }),
    /second peer failed/
  );

  assert.deepEqual(events, ['create_room', 'open_peers', 'close_peers', 'delete_room']);
});

test('storage isolation report always tightens an existing output file to mode 0600', async (t) => {
  const { writeLiveKitStorageIsolationResult } = await import(
    '../scripts/livekit-storage-isolation-acceptance.js'
  );
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-storage-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outputFile = join(directory, 'evidence.json');
  writeFileSync(outputFile, '{}\n', { mode: 0o644 });

  writeLiveKitStorageIsolationResult(outputFile, {
    schema_version: 1,
    status: 'passed_controlled_local',
    room_name: 'room-safe',
    egress_id: 'EG_safe',
    media_before: healthyPeerSnapshots(),
    media_during_storage_outage: healthyPeerSnapshots(),
    media_after_recording_failure: healthyPeerSnapshots(),
    recording_terminal_status: 'failed',
    recording_failure_code: 'storage_upload_failed',
    storage_recovered: true
  });

  assert.equal(statSync(outputFile).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(outputFile, 'utf8'), /secret|minio:9000/i);
});

function storageIsolationConfig() {
  return {
    livekitUrl: 'ws://127.0.0.1:7880',
    apiKey: 'devkey',
    apiSecret: 'secret',
    composeProject: 'ivekit-fresh-audit',
    composeFiles: ['docker-compose.callcenter.yml'],
    composeEnvFile: '',
    storageService: 'minio',
    storageInitService: 'minio-init',
    outputFile: '',
    timeoutMs: 45000
  };
}

function healthyPeerSnapshots() {
  return [
    {
      identity: 'agent-a', state: 'connected', remoteParticipants: 1,
      remotePublications: 2, localPublications: 2
    },
    {
      identity: 'agent-b', state: 'connected', remoteParticipants: 1,
      remotePublications: 2, localPublications: 2
    }
  ];
}
