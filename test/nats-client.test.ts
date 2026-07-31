import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  NatsPublisher,
  resolveNatsConnectionOptions
} from '../src/infra/nats-client.js';

test('NATS runtime uses the modular Node transport and no removed nats package', () => {
  const source = readFileSync('src/infra/nats-client.ts', 'utf8');

  assert.match(source, /from '@nats-io\/transport-node'/);
  assert.match(source, /from '@nats-io\/nats-core'/);
  assert.doesNotMatch(source, /(?:from|import\()\s*['"]nats['"]/);
});

test('NATS connection options parse multiple servers, bounded reconnect, auth, and TLS files', () => {
  const options = resolveNatsConnectionOptions({
    NATS_URL: 'tls://nats-0.internal:4222, tls://nats-1.internal:4222',
    NATS_CONNECTION_NAME: 'opc-events-a',
    NATS_USER: 'opc-events',
    NATS_PASSWORD: 'secret-ref-value',
    NATS_TLS_MODE: 'required',
    NATS_TLS_CA_FILE: '/run/secrets/nats/ca.crt',
    NATS_TLS_CERT_FILE: '/run/secrets/nats/tls.crt',
    NATS_TLS_KEY_FILE: '/run/secrets/nats/tls.key',
    NATS_CONNECT_TIMEOUT_MS: '3500',
    NATS_RECONNECT_WAIT_MS: '750',
    NATS_MAX_RECONNECT_ATTEMPTS: '-1'
  });

  assert.deepEqual(options, {
    servers: ['tls://nats-0.internal:4222', 'tls://nats-1.internal:4222'],
    name: 'opc-events-a',
    user: 'opc-events',
    pass: 'secret-ref-value',
    timeout: 3500,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 750,
    reconnectJitter: 250,
    reconnectJitterTLS: 1000,
    tls: {
      rejectUnauthorized: true,
      caFile: '/run/secrets/nats/ca.crt',
      certFile: '/run/secrets/nats/tls.crt',
      keyFile: '/run/secrets/nats/tls.key'
    }
  });
});

test('NATS connection options reject secret-bearing URLs and contradictory auth or TLS', () => {
  assert.throws(
    () => resolveNatsConnectionOptions({ NATS_URL: 'nats://user:password@nats:4222' }),
    /must not contain credentials/
  );
  assert.throws(
    () => resolveNatsConnectionOptions({
      NATS_URL: 'nats://nats:4222',
      NATS_USER: 'opc',
      NATS_PASSWORD: 'password',
      NATS_TOKEN: 'token'
    }),
    /mutually exclusive/
  );
  assert.throws(
    () => resolveNatsConnectionOptions({
      NATS_URL: 'nats://nats:4222',
      NATS_USER: 'opc'
    }),
    /must be configured together/
  );
  assert.throws(
    () => resolveNatsConnectionOptions({
      NATS_URL: 'tls://nats:4222',
      NATS_TLS_MODE: 'disabled'
    }),
    /TLS server URL requires NATS_TLS_MODE=required/
  );
  assert.throws(
    () => resolveNatsConnectionOptions({
      NATS_URL: 'nats://nats:4222',
      NATS_TLS_CERT_FILE: '/run/secrets/nats/tls.crt'
    }),
    /certificate and key files must be configured together/
  );
});

test('NATS publisher coalesces connects, publishes without flush-per-message, and drains', async () => {
  const calls: string[] = [];
  let publishedTraceparent = '';
  const connection = {
    publish(
      subject: string,
      data: Uint8Array,
      options?: { headers?: { get(name: string): string } }
    ) {
      calls.push(`publish:${subject}:${new TextDecoder().decode(data)}`);
      publishedTraceparent = options?.headers?.get('traceparent') || '';
    },
    async drain() {
      calls.push('drain');
    },
    async closed() {
      return undefined;
    },
    isClosed() {
      return false;
    }
  };
  let connectCount = 0;
  const publisher = new NatsPublisher({
    env: { NATS_URL: 'nats://nats-a:4222,nats://nats-b:4222' },
    connect: async () => {
      connectCount += 1;
      return connection;
    },
    traceHeaders: () => ({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    }),
    logger: { info() {}, warn() {} }
  });

  assert.deepEqual(await Promise.all([publisher.connect(), publisher.connect()]), [true, true]);
  assert.equal(connectCount, 1);
  assert.equal(await publisher.publish({ subject: 'opc.callcenter.started', payload: { id: 'call-1' } }), true);
  assert.deepEqual(calls, ['publish:opc.callcenter.started:{"id":"call-1"}']);
  assert.equal(
    publishedTraceparent,
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
  );
  await publisher.close();
  assert.deepEqual(calls, ['publish:opc.callcenter.started:{"id":"call-1"}', 'drain']);
});

test('NATS publisher failure is bounded and logs no URL or credential', async () => {
  const warnings: string[] = [];
  const publisher = new NatsPublisher({
    env: {
      NATS_URL: 'nats://nats-a.internal:4222',
      NATS_USER: 'opc',
      NATS_PASSWORD: 'do-not-log'
    },
    connect: async () => {
      throw new Error('dial failed at nats-a.internal with do-not-log');
    },
    logger: { info() {}, warn(message) { warnings.push(message); } }
  });

  assert.equal(await publisher.connect(), false);
  assert.deepEqual(warnings, ['[nats] connection failed']);
  assert.doesNotMatch(warnings.join('\n'), /nats-a|do-not-log/);
});
