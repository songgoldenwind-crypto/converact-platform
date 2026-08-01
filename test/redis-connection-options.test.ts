import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIoRedisConstructorArgs,
  resolveRedisConnectionOptions
} from '../src/infra/redis-connection-options.js';

test('Redis direct topology accepts one credential-free endpoint and bounded reconnect settings', () => {
  assert.deepEqual(
    resolveRedisConnectionOptions({
      REDIS_TOPOLOGY: 'direct',
      REDIS_URL: 'redis://valkey-primary.internal:6379',
      REDIS_USERNAME: 'converact',
      REDIS_PASSWORD: 'secret-ref-value',
      REDIS_CONNECT_TIMEOUT_MS: '3500',
      REDIS_RECONNECT_WAIT_MS: '750',
      REDIS_MAX_RECONNECT_ATTEMPTS: '-1'
    }),
    {
      topology: 'direct',
      url: 'redis://valkey-primary.internal:6379',
      username: 'converact',
      password: 'secret-ref-value',
      connectTimeoutMs: 3500,
      reconnectWaitMs: 750,
      maxReconnectAttempts: -1,
      tls: null
    }
  );
});

test('Redis Sentinel topology accepts three voters and independent data and Sentinel ACLs', () => {
  assert.deepEqual(
    resolveRedisConnectionOptions({
      REDIS_TOPOLOGY: 'sentinel',
      REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
      REDIS_SENTINEL_ADDRESSES:
        'valkey-0.internal:26379,valkey-1.internal:26379,valkey-2.internal:26379',
      REDIS_USERNAME: 'converact-data',
      REDIS_PASSWORD: 'data-secret',
      REDIS_SENTINEL_USERNAME: 'converact-sentinel',
      REDIS_SENTINEL_PASSWORD: 'sentinel-secret'
    }),
    {
      topology: 'sentinel',
      masterName: 'converact-coordination',
      sentinels: [
        { host: 'valkey-0.internal', port: 26379 },
        { host: 'valkey-1.internal', port: 26379 },
        { host: 'valkey-2.internal', port: 26379 }
      ],
      username: 'converact-data',
      password: 'data-secret',
      sentinelUsername: 'converact-sentinel',
      sentinelPassword: 'sentinel-secret',
      connectTimeoutMs: 5000,
      reconnectWaitMs: 1000,
      maxReconnectAttempts: -1,
      tls: null
    }
  );
});

test('Redis TLS requires verification and preserves only file references in resolved config', () => {
  assert.deepEqual(
    resolveRedisConnectionOptions({
      REDIS_TOPOLOGY: 'sentinel',
      REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
      REDIS_SENTINEL_ADDRESSES:
        'valkey-0.internal:26379,valkey-1.internal:26379,valkey-2.internal:26379',
      REDIS_TLS_MODE: 'required',
      REDIS_TLS_SERVER_NAME: 'valkey.internal',
      REDIS_TLS_CA_FILE: '/run/secrets/valkey/ca.crt',
      REDIS_TLS_CERT_FILE: '/run/secrets/valkey/tls.crt',
      REDIS_TLS_KEY_FILE: '/run/secrets/valkey/tls.key'
    }).tls,
    {
      rejectUnauthorized: true,
      serverName: 'valkey.internal',
      caFile: '/run/secrets/valkey/ca.crt',
      certFile: '/run/secrets/valkey/tls.crt',
      keyFile: '/run/secrets/valkey/tls.key'
    }
  );
});

test('Redis connection contract rejects credentials embedded in direct URLs', () => {
  assert.throws(
    () => resolveRedisConnectionOptions({ REDIS_URL: 'redis://user:password@valkey:6379' }),
    /must not contain credentials/
  );
});

test('Redis connection contract rejects mixed direct and Sentinel topology', () => {
  assert.throws(
    () =>
      resolveRedisConnectionOptions({
        REDIS_TOPOLOGY: 'sentinel',
        REDIS_URL: 'redis://valkey:6379',
        REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
        REDIS_SENTINEL_ADDRESSES:
          'valkey-0:26379,valkey-1:26379,valkey-2:26379'
      }),
    /REDIS_URL must be empty in sentinel topology/
  );
});

test('Redis Sentinel topology requires exactly three unique bounded addresses', () => {
  for (const addresses of [
    'valkey-0:26379,valkey-1:26379',
    'valkey-0:26379,valkey-0:26379,valkey-2:26379',
    'valkey-0:0,valkey-1:26379,valkey-2:26379',
    'redis://valkey-0:26379,valkey-1:26379,valkey-2:26379'
  ]) {
    assert.throws(
      () =>
        resolveRedisConnectionOptions({
          REDIS_TOPOLOGY: 'sentinel',
          REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
          REDIS_SENTINEL_ADDRESSES: addresses
        }),
      /three unique host:port entries/
    );
  }
});

test('Redis ACL and TLS pairs fail closed when incomplete or contradictory', () => {
  assert.throws(
    () => resolveRedisConnectionOptions({ REDIS_USERNAME: 'converact' }),
    /REDIS_USERNAME and REDIS_PASSWORD must be configured together/
  );
  assert.throws(
    () =>
      resolveRedisConnectionOptions({
        REDIS_TOPOLOGY: 'sentinel',
        REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
        REDIS_SENTINEL_ADDRESSES:
          'valkey-0:26379,valkey-1:26379,valkey-2:26379',
        REDIS_SENTINEL_USERNAME: 'sentinel'
      }),
    /REDIS_SENTINEL_USERNAME and REDIS_SENTINEL_PASSWORD must be configured together/
  );
  assert.throws(
    () =>
      resolveRedisConnectionOptions({
        REDIS_TLS_MODE: 'required',
        REDIS_TLS_CERT_FILE: '/run/secrets/valkey/tls.crt'
      }),
    /certificate and key files must be configured together/
  );
  assert.throws(
    () =>
      resolveRedisConnectionOptions({
        REDIS_TLS_MODE: 'disabled',
        REDIS_TLS_CA_FILE: '/run/secrets/valkey/ca.crt'
      }),
    /TLS files require REDIS_TLS_MODE=required/
  );
});

test('Redis connection contract rejects unknown topology and out-of-range retry settings', () => {
  assert.throws(
    () => resolveRedisConnectionOptions({ REDIS_TOPOLOGY: 'cluster' }),
    /REDIS_TOPOLOGY must be direct or sentinel/
  );
  assert.throws(
    () => resolveRedisConnectionOptions({ REDIS_CONNECT_TIMEOUT_MS: '0' }),
    /REDIS_CONNECT_TIMEOUT_MS must be an integer between 250 and 60000/
  );
  assert.throws(
    () => resolveRedisConnectionOptions({ REDIS_MAX_RECONNECT_ATTEMPTS: '-2' }),
    /REDIS_MAX_RECONNECT_ATTEMPTS must be an integer between -1 and 1000000/
  );
});

test('Redis direct config maps to URL plus bounded ioredis options', () => {
  const args = buildIoRedisConstructorArgs(
    resolveRedisConnectionOptions({
      REDIS_URL: 'redis://valkey.internal:6379',
      REDIS_USERNAME: 'converact',
      REDIS_PASSWORD: 'data-secret',
      REDIS_RECONNECT_WAIT_MS: '750',
      REDIS_MAX_RECONNECT_ATTEMPTS: '2'
    })
  );

  assert.equal(args.length, 2);
  if (args.length !== 2) assert.fail('expected direct ioredis constructor arguments');
  assert.equal(args[0], 'redis://valkey.internal:6379');
  const options = args[1];
  assert.equal(options.lazyConnect, true);
  assert.equal(options.maxRetriesPerRequest, 1);
  assert.equal(options.connectTimeout, 5000);
  assert.equal(options.username, 'converact');
  assert.equal(options.password, 'data-secret');
  assert.equal(options.retryStrategy?.(1), 750);
  assert.equal(options.retryStrategy?.(2), 750);
  assert.equal(options.retryStrategy?.(3), null);
});

test('Redis Sentinel config maps to one ioredis options object with independent discovery ACL', () => {
  const args = buildIoRedisConstructorArgs(
    resolveRedisConnectionOptions({
      REDIS_TOPOLOGY: 'sentinel',
      REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
      REDIS_SENTINEL_ADDRESSES:
        'valkey-0.internal:26379,valkey-1.internal:26379,valkey-2.internal:26379',
      REDIS_USERNAME: 'converact-data',
      REDIS_PASSWORD: 'data-secret',
      REDIS_SENTINEL_USERNAME: 'converact-sentinel',
      REDIS_SENTINEL_PASSWORD: 'sentinel-secret'
    })
  );

  assert.equal(args.length, 1);
  if (args.length !== 1) assert.fail('expected Sentinel ioredis constructor arguments');
  const options = args[0];
  assert.deepEqual(options.sentinels, [
    { host: 'valkey-0.internal', port: 26379 },
    { host: 'valkey-1.internal', port: 26379 },
    { host: 'valkey-2.internal', port: 26379 }
  ]);
  assert.equal(options.name, 'converact-coordination');
  assert.equal(options.username, 'converact-data');
  assert.equal(options.password, 'data-secret');
  assert.equal(options.sentinelUsername, 'converact-sentinel');
  assert.equal(options.sentinelPassword, 'sentinel-secret');
  assert.equal(options.role, 'master');
  assert.equal(options.enableReadyCheck, true);
  assert.equal(options.sentinelRetryStrategy?.(1), 1000);
});

test('Redis ioredis mapping reads TLS material only through the injected file boundary', () => {
  const reads: string[] = [];
  const args = buildIoRedisConstructorArgs(
    resolveRedisConnectionOptions({
      REDIS_TOPOLOGY: 'sentinel',
      REDIS_SENTINEL_MASTER_NAME: 'converact-coordination',
      REDIS_SENTINEL_ADDRESSES:
        'valkey-0.internal:26379,valkey-1.internal:26379,valkey-2.internal:26379',
      REDIS_TLS_MODE: 'required',
      REDIS_TLS_SERVER_NAME: 'valkey.internal',
      REDIS_TLS_CA_FILE: '/run/secrets/valkey/ca.crt',
      REDIS_TLS_CERT_FILE: '/run/secrets/valkey/tls.crt',
      REDIS_TLS_KEY_FILE: '/run/secrets/valkey/tls.key'
    }),
    {
      readFile(path) {
        reads.push(path);
        return `contents:${path}`;
      }
    }
  );
  assert.equal(args.length, 1);
  if (args.length !== 1) assert.fail('expected Sentinel ioredis constructor arguments');
  const options = args[0];

  assert.deepEqual(reads, [
    '/run/secrets/valkey/ca.crt',
    '/run/secrets/valkey/tls.crt',
    '/run/secrets/valkey/tls.key'
  ]);
  assert.deepEqual(options.tls, {
    rejectUnauthorized: true,
    servername: 'valkey.internal',
    ca: 'contents:/run/secrets/valkey/ca.crt',
    cert: 'contents:/run/secrets/valkey/tls.crt',
    key: 'contents:/run/secrets/valkey/tls.key'
  });
  assert.deepEqual(options.sentinelTLS, options.tls);
});
