import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createConfiguredRealtimeAudioTapRuntime,
  deriveLiveKitAudioTapInstanceSecret
} from '../src/agent-runtime/converact/voice/realtime-audio-tap-runtime.js';
import type { PolicyRealtimeSpeechRouter } from '../src/agent-runtime/converact/voice/realtime-speech-routing.js';
import type { PgQueryable } from '../src/db-pg.js';

const pg = {
  async query() {
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
  }
} as PgQueryable;

test('LiveKit audio tap derives isolated signing keys for each gateway instance', () => {
  const clusterSecret = Buffer.alloc(32, 9);
  const podA = deriveLiveKitAudioTapInstanceSecret(clusterSecret, 'converact-api-0');
  const podAReplay = deriveLiveKitAudioTapInstanceSecret(clusterSecret, 'converact-api-0');
  const podB = deriveLiveKitAudioTapInstanceSecret(clusterSecret, 'converact-api-1');

  assert.deepEqual(podA, podAReplay);
  assert.notDeepEqual(podA, podB);
  assert.equal(podA.length, 32);
  assert.deepEqual(
    deriveLiveKitAudioTapInstanceSecret(clusterSecret, ''),
    clusterSecret
  );
  assert.throws(
    () => deriveLiveKitAudioTapInstanceSecret(clusterSecret, 'INVALID/POD'),
    /livekit_audio_tap_instance_id_invalid/
  );
});

test('configured realtime audio tap runtime stays fail-closed when disabled', () => {
  const runtime = createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '0'
    }
  });

  assert.equal(runtime.enabled, false);
  assert.equal(runtime.gateway, null);
  assert.equal(runtime.livekit_gateway, null);
  assert.equal(runtime.authorizer, null);
  assert.equal(runtime.livekit_authorizer, null);
  assert.ok(runtime.grants);
});

test('configured realtime audio tap runtime requires a valid secret and projection', () => {
  assert.throws(() => createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(16, 1).toString('base64')
    },
    router: fakeRouter()
  }), /audio_tap_secret_invalid/);

  assert.throws(() => createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(32, 1).toString('base64')
    },
    router: fakeRouter()
  }), /audio_tap_projection_required/);
});

test('configured runtime rejects an invalid bounded projection queue', () => {
  assert.throws(() => createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(32, 1).toString('base64'),
      CONVERACT_FABRIC_REALTIME_PROJECTION_QUEUE_MAX_ITEMS: '0'
    },
    router: fakeRouter(),
    projection: fakeProjection()
  }), /audio_tap_projection_queue_invalid/);
});

test('configured runtime owns and removes the local Unix socket', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-tap-runtime-'));
  const socketPath = join(directory, 'nested', 'tap.sock');
  const runtime = createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(32, 2).toString('base64'),
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_SOCKET_PATH: socketPath,
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_MAX_CONNECTIONS: '16',
      CONVERACT_FABRIC_LIVEKIT_AUDIO_TAP_LISTEN_HOST: '127.0.0.1',
      CONVERACT_FABRIC_LIVEKIT_AUDIO_TAP_LISTEN_PORT: '0',
      CONVERACT_REALTIME_SPEECH_RETENTION_DAYS: '7'
    },
    router: fakeRouter(),
    projection: fakeProjection()
  });
  t.after(async () => {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(runtime.enabled, true);
  assert.ok(runtime.gateway);
  assert.ok(runtime.livekit_gateway);
  assert.ok(runtime.authorizer);
  assert.ok(runtime.livekit_authorizer);
  await runtime.start();
  assert.equal((await stat(socketPath)).isSocket(), true);
  assert.equal(runtime.livekit_gateway.address()?.address, '127.0.0.1');
  assert.ok((runtime.livekit_gateway.address()?.port || 0) > 0);
  await runtime.stop();
  assert.equal(runtime.livekit_gateway.address(), null);
  await assert.rejects(() => stat(socketPath), (error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT'
  );
});

test('configured runtime can isolate the RustPBX gateway in a Pod-local sidecar', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-tap-runtime-rustpbx-'));
  const socketPath = join(directory, 'tap.sock');
  const runtime = createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED: '1',
      CONVERACT_FABRIC_LIVEKIT_AUDIO_TAP_GATEWAY_ENABLED: '0',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(32, 4).toString('base64'),
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_SOCKET_PATH: socketPath
    },
    router: fakeRouter(),
    projection: fakeProjection()
  });
  t.after(async () => {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  });

  assert.ok(runtime.gateway);
  assert.equal(runtime.livekit_gateway, null);
  assert.ok(runtime.authorizer);
  assert.ok(runtime.livekit_authorizer);
  await runtime.start();
  assert.equal((await stat(socketPath)).isSocket(), true);
});

test('configured runtime rejects an enabled service with no gateway', () => {
  assert.throws(() => createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED: '0',
      CONVERACT_FABRIC_LIVEKIT_AUDIO_TAP_GATEWAY_ENABLED: '0',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(32, 5).toString('base64')
    },
    router: fakeRouter(),
    projection: fakeProjection()
  }), /audio_tap_gateway_required/);
});

test('configured runtime rolls back the Unix socket when LiveKit gateway startup fails', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'converact-tap-runtime-rollback-'));
  const socketPath = join(directory, 'tap.sock');
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const runtime = createConfiguredRealtimeAudioTapRuntime({
    pg,
    env: {
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_ENABLED: '1',
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_HMAC_SECRET_B64:
        Buffer.alloc(32, 3).toString('base64'),
      CONVERACT_FABRIC_REALTIME_AUDIO_TAP_SOCKET_PATH: socketPath,
      CONVERACT_FABRIC_LIVEKIT_AUDIO_TAP_LISTEN_HOST: '127.0.0.1',
      CONVERACT_FABRIC_LIVEKIT_AUDIO_TAP_LISTEN_PORT: String(address.port)
    },
    router: fakeRouter(),
    projection: fakeProjection()
  });
  t.after(async () => {
    await runtime.stop();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(() => runtime.start(), (error: NodeJS.ErrnoException) =>
    error.code === 'EADDRINUSE'
  );
  await assert.rejects(() => stat(socketPath), (error: NodeJS.ErrnoException) =>
    error.code === 'ENOENT'
  );
});

function fakeRouter(): PolicyRealtimeSpeechRouter {
  return {
    async startSession() {
      throw new Error('not used by runtime configuration test');
    }
  };
}

function fakeProjection(): Pick<import(
  '../src/agent-runtime/converact/voice/realtime-speech-projection.js'
).RealtimeSpeechProjection, 'project'> {
  return {
    async project() {
      return { status: 'ephemeral', projection: null, replayed: false };
    }
  };
}
