import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';

import { getRedisClient, setRedisClientForTests } from '../src/redis-client.js';
import { getRedisPubSub, resetRedisPubSubForTests } from '../src/redis-pubsub.js';

const MANAGED_ENV = [
  'OPC_USE_MEMORY_REDIS',
  'REDIS_TOPOLOGY',
  'REDIS_URL',
  'REDIS_SENTINEL_MASTER_NAME',
  'REDIS_SENTINEL_ADDRESSES'
] as const;

const saved = new Map<string, string | undefined>();

before(() => {
  for (const key of MANAGED_ENV) saved.set(key, process.env[key]);
  delete process.env.OPC_USE_MEMORY_REDIS;
});

after(() => {
  for (const key of MANAGED_ENV) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setRedisClientForTests(null);
  resetRedisPubSubForTests(null);
});

test('Redis data client rejects invalid topology instead of falling back to process memory', async () => {
  setRedisClientForTests(null);
  process.env.REDIS_TOPOLOGY = 'cluster';
  delete process.env.REDIS_URL;

  await assert.rejects(getRedisClient(), /REDIS_TOPOLOGY must be direct or sentinel/);
});

test('Redis Pub/Sub rejects incomplete Sentinel config instead of creating local-only fanout', async () => {
  resetRedisPubSubForTests(null);
  process.env.REDIS_TOPOLOGY = 'sentinel';
  process.env.REDIS_SENTINEL_MASTER_NAME = 'ivekit-coordination';
  process.env.REDIS_SENTINEL_ADDRESSES = 'valkey-0:26379,valkey-1:26379';

  await assert.rejects(
    getRedisPubSub(),
    /REDIS_SENTINEL_ADDRESSES must contain exactly three unique host:port entries/
  );
});

test('Redis deployment examples expose the complete topology contract', async () => {
  const paths = ['.env.example', 'infra/env.example', 'services/converact-service/env.example'];
  for (const path of paths) {
    const env = await readFile(path, 'utf8');
    for (const variable of [
      'REDIS_TOPOLOGY',
      'REDIS_URL',
      'REDIS_USERNAME',
      'REDIS_PASSWORD',
      'REDIS_SENTINEL_MASTER_NAME',
      'REDIS_SENTINEL_ADDRESSES',
      'REDIS_SENTINEL_USERNAME',
      'REDIS_SENTINEL_PASSWORD',
      'REDIS_TLS_MODE',
      'REDIS_TLS_SERVER_NAME',
      'REDIS_TLS_CA_FILE',
      'REDIS_TLS_CERT_FILE',
      'REDIS_TLS_KEY_FILE',
      'REDIS_CONNECT_TIMEOUT_MS',
      'REDIS_RECONNECT_WAIT_MS',
      'REDIS_MAX_RECONNECT_ATTEMPTS'
    ]) {
      assert.match(env, new RegExp(`^${variable}=`, 'm'), `${path}: ${variable}`);
    }
  }

  const compose = await readFile('services/converact-service/docker-compose.yml', 'utf8');
  for (const variable of [
    'REDIS_TOPOLOGY',
    'REDIS_URL',
    'REDIS_USERNAME',
    'REDIS_PASSWORD',
    'REDIS_SENTINEL_MASTER_NAME',
    'REDIS_SENTINEL_ADDRESSES',
    'REDIS_SENTINEL_USERNAME',
    'REDIS_SENTINEL_PASSWORD',
    'REDIS_TLS_MODE',
    'REDIS_CONNECT_TIMEOUT_MS',
    'REDIS_RECONNECT_WAIT_MS',
    'REDIS_MAX_RECONNECT_ATTEMPTS'
  ]) {
    assert.match(compose, new RegExp(`^      ${variable}:`,'m'), variable);
  }
});
