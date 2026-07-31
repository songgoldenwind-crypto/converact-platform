import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  startTinodeSyncWorker,
  TinodeSyncWorker,
  tinodeSyncWorkerConfig,
  type TinodeSyncWorkerRunResult
} from '../src/agent-runtime/collaboration/tinode-sync-worker.js';
import { MemoryPg } from '../src/db-pg.js';

const EMPTY_RESULT: TinodeSyncWorkerRunResult = {
  examined: 0,
  claimed: 0,
  delivered: 0,
  retry_wait: 0,
  failed: 0
};

test('Tinode sync worker config activates only for a configured provider', () => {
  assert.equal(tinodeSyncWorkerConfig({} as NodeJS.ProcessEnv).enabled, false);
  const config = tinodeSyncWorkerConfig({
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    TINODE_API_KEY: 'browser-api-key',
    TINODE_ROOT_API_KEY: 'root-api-key',
    TINODE_AUTH_TOKEN: 'root-auth-token',
    CONVERACT_TINODE_DELIVERY_WORKER_ENABLED: '1',
    CONVERACT_TINODE_DELIVERY_INTERVAL_MS: '7000',
    CONVERACT_TINODE_DELIVERY_BATCH_SIZE: '25',
    CONVERACT_TINODE_DELIVERY_MAX_ATTEMPTS: '4',
    CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS: '40000',
    CONVERACT_TINODE_DELIVERY_RETRY_DELAYS_MS: '3000,12000,30000'
  } as NodeJS.ProcessEnv);

  assert.deepEqual(config, {
    enabled: true,
    intervalMs: 7_000,
    batchSize: 25,
    maxAttempts: 4,
    claimLeaseMs: 40_000,
    retryDelaysMs: [3_000, 12_000, 30_000]
  });
  assert.equal(tinodeSyncWorkerConfig({
    TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
    CONVERACT_TINODE_DELIVERY_WORKER_ENABLED: '1'
  } as NodeJS.ProcessEnv).enabled, false);
  assert.throws(
    () => tinodeSyncWorkerConfig({
      TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
      CONVERACT_TINODE_DELIVERY_INTERVAL_MS: '50'
    } as NodeJS.ProcessEnv),
    /INTERVAL_MS/
  );
  assert.throws(
    () => tinodeSyncWorkerConfig({
      TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
      TINODE_REQUEST_TIMEOUT_MS: '5000',
      CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS: '20000'
    } as NodeJS.ProcessEnv),
    /CLAIM_LEASE_MS.*26000/
  );
});

test('Tinode sync worker does not construct a gateway when disabled', async () => {
  const worker = startTinodeSyncWorker({
    pg: new MemoryPg(),
    env: {
      TINODE_WS_URL: 'wss://tinode.example.com/v0/channels',
      CONVERACT_TINODE_DELIVERY_WORKER_ENABLED: '0'
    } as NodeJS.ProcessEnv
  });

  assert.deepEqual(await worker.runOnce(), EMPTY_RESULT);
  await worker.stop();
});

test('Tinode sync worker coalesces overlapping runs', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new TinodeSyncWorker({
    config: {
      enabled: true,
      intervalMs: 1_000,
      batchSize: 10,
      maxAttempts: 3,
      claimLeaseMs: 30_000,
      retryDelaysMs: [2_000, 10_000]
    },
    runDeliveryBatch: async () => {
      calls += 1;
      await gate;
      return EMPTY_RESULT;
    }
  });

  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(calls, 1);
  release?.();
  assert.deepEqual(await first, EMPTY_RESULT);
  assert.deepEqual(await second, EMPTY_RESULT);
  assert.equal(calls, 1);
  await worker.stop();
});

test('Tinode sync worker is wired into server shutdown and deployment env examples', () => {
  const server = readFileSync('src/server.ts', 'utf8');
  const application = readFileSync('src/agent-runtime/converact/application.ts', 'utf8');
  const rootEnv = readFileSync('.env.example', 'utf8');
  const productionEnv = readFileSync('infra/env.example', 'utf8');
  const compose = readFileSync('docker-compose.callcenter.yml', 'utf8');
  const productionCompose = readFileSync('infra/docker-compose.production.yml', 'utf8');
  const deployment = readFileSync('infra/k8s/templates/opc-deployment.yaml', 'utf8');
  const secrets = readFileSync('infra/k8s/templates/secrets.yaml', 'utf8');
  const values = readFileSync('infra/k8s/values.yaml', 'utf8');

  assert.match(server, /startIveKitApplication/);
  assert.match(server, /iveKitApplication\.stop/);
  assert.match(application, /startTinodeSyncWorker/);
  assert.match(application, /collaboration\.message\.delivery_updated/);
  for (const source of [rootEnv, productionEnv]) {
    assert.match(source, /TINODE_ROOT_API_KEY/);
    assert.match(source, /CONVERACT_TINODE_DELIVERY_WORKER_ENABLED/);
    assert.match(source, /CONVERACT_TINODE_DELIVERY_INTERVAL_MS/);
    assert.match(source, /CONVERACT_TINODE_DELIVERY_MAX_ATTEMPTS/);
    assert.match(source, /TINODE_REQUEST_TIMEOUT_MS/);
  }
  for (const source of [compose, productionCompose, deployment]) {
    assert.match(source, /TINODE_BASE_URL/);
    assert.match(source, /TINODE_API_KEY/);
    assert.match(source, /TINODE_ROOT_API_KEY/);
    assert.match(source, /CONVERACT_TINODE_DELIVERY_WORKER_ENABLED/);
    assert.match(source, /CONVERACT_TINODE_DELIVERY_CLAIM_LEASE_MS/);
  }
  assert.match(secrets, /tinode-api-key/);
  assert.match(secrets, /tinode-root-api-key/);
  assert.match(secrets, /tinode-user-password-secret/);
  assert.match(values, /^tinode:/m);
});
