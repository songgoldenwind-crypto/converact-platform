import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isLiveKitBrowserJoinConfigured,
  isLiveKitConfigured,
  readLiveKitConfig,
  requireLiveKitPublicUrl
} from '../src/agent-runtime/livekit/config.js';
import { issueLiveKitToken, issueSupervisorToken } from '../src/agent-runtime/livekit/token-service.js';

test('LiveKit config separates internal and public URLs', () => {
  const config = readLiveKitConfig({
    NODE_ENV: 'production',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret'
  });

  assert.equal(config.url, 'ws://livekit:7880');
  assert.equal(config.publicUrl, 'wss://livekit.example.com');
  assert.equal(isLiveKitConfigured(config), true);
  assert.equal(isLiveKitBrowserJoinConfigured(config, 'production'), true);
});

test('LiveKit config supports OPC-prefixed URL aliases', () => {
  const config = readLiveKitConfig({
    NODE_ENV: 'production',
    OPC_LIVEKIT_URL: 'ws://livekit-internal:7880',
    OPC_LIVEKIT_PUBLIC_URL: 'wss://media.example.com',
    OPC_LIVEKIT_API_KEY: 'key',
    OPC_LIVEKIT_API_SECRET: 'secret'
  });

  assert.equal(config.url, 'ws://livekit-internal:7880');
  assert.equal(config.publicUrl, 'wss://media.example.com');
  assert.equal(isLiveKitBrowserJoinConfigured(config, 'production'), true);
});

test('LiveKit config allows public URL fallback only outside production', () => {
  const development = readLiveKitConfig({
    NODE_ENV: 'development',
    LIVEKIT_URL: 'ws://localhost:7880',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret'
  });
  const production = readLiveKitConfig({
    NODE_ENV: 'production',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret'
  });

  assert.equal(development.publicUrl, 'ws://localhost:7880');
  assert.equal(isLiveKitBrowserJoinConfigured(development, 'development'), true);
  assert.equal(production.publicUrl, null);
  assert.equal(isLiveKitConfigured(production), true);
  assert.equal(isLiveKitBrowserJoinConfigured(production, 'production'), false);
  assert.throws(
    () => requireLiveKitPublicUrl(production, 'production'),
    /LIVEKIT_PUBLIC_URL or OPC_LIVEKIT_PUBLIC_URL is required/
  );
});

test('LiveKit browser joins require WSS in production', () => {
  const config = readLiveKitConfig({
    NODE_ENV: 'production',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_PUBLIC_URL: 'ws://livekit.example.com',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret'
  });

  assert.equal(config.publicUrl, 'ws://livekit.example.com');
  assert.equal(isLiveKitBrowserJoinConfigured(config, 'production'), false);
  assert.throws(
    () => requireLiveKitPublicUrl(config, 'production'),
    /LIVEKIT_PUBLIC_URL must use wss:\/\//
  );
});

test('participant and supervisor tokens return the public URL while configured', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const config = readLiveKitConfig({
    NODE_ENV: 'production',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret'
  });

  try {
    const participant = await issueLiveKitToken({
      room_name: 'room-public-url',
      identity: 'customer-public-url',
      role: 'customer',
      tenant_id: 'tenant-public-url'
    }, config);
    const supervisor = await issueSupervisorToken({
      room_name: 'room-public-url',
      identity: 'supervisor-public-url',
      mode: 'listen',
      tenant_id: 'tenant-public-url'
    }, config);

    assert.equal(participant.configured, true);
    assert.equal(participant.livekit_url, 'wss://livekit.example.com');
    assert.equal(supervisor.configured, true);
    assert.equal(supervisor.livekit_url, 'wss://livekit.example.com');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('configured production token issuance fails closed without a public URL', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const config = readLiveKitConfig({
    NODE_ENV: 'production',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_API_KEY: 'key',
    LIVEKIT_API_SECRET: 'secret'
  });

  try {
    await assert.rejects(
      () => issueLiveKitToken({
        room_name: 'room-missing-public-url',
        identity: 'customer-missing-public-url',
        role: 'customer'
      }, config),
      /LIVEKIT_PUBLIC_URL or OPC_LIVEKIT_PUBLIC_URL is required/
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('production token issuance fails closed when LiveKit server configuration is incomplete', async () => {
  const config = readLiveKitConfig({
    NODE_ENV: 'production',
    LIVEKIT_URL: 'ws://livekit:7880',
    LIVEKIT_PUBLIC_URL: 'wss://livekit.example.com'
  });

  await assert.rejects(
    () => issueLiveKitToken({
      room_name: 'room-incomplete-production-config',
      identity: 'customer-incomplete-production-config',
      role: 'customer'
    }, config),
    /LiveKit server configuration is required in production/
  );
  await assert.rejects(
    () => issueSupervisorToken({
      room_name: 'room-incomplete-production-config',
      identity: 'supervisor-incomplete-production-config',
      mode: 'listen'
    }, config),
    /LiveKit server configuration is required in production/
  );
});
