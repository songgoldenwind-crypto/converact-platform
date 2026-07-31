import { resolveFabricEnv } from '../../../config/converact-env.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import {
  runNotificationDeliveryBatch,
  type NotificationDeliveryBatchSummary
} from './delivery-worker.js';
import type {
  NotificationContentProtector,
  NotificationProviderResolver,
  NotificationSecretResolver
} from './ports.js';
import { configuredNotificationProtector } from './protector.js';
import { createNotificationProviderResolver } from './provider-resolver.js';
import { configuredNotificationSecretResolver } from './secret-resolver.js';
import { PostgresNotificationStore } from './postgres/store.js';
import { publishNotificationTenantEvent } from './realtime.js';
import { runNotificationReceiptReconciliationBatch } from './receipt-worker.js';
import { setNotificationQueueMetric } from './metrics.js';

export interface NotificationDeliveryWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  batch_size: number;
  tenant_limit: number;
  lease_ms: number;
  retry_delays_ms: number[];
  partition_count: number;
  partition_index: number;
  shard_ids: number[];
}

const NOTIFICATION_LOGICAL_SHARDS = 1024;

export class NotificationDeliveryWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<NotificationDeliveryBatchSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: NotificationDeliveryWorkerConfig;
    runBatch: () => Promise<NotificationDeliveryBatchSummary>;
    onResult?: (result: NotificationDeliveryBatchSummary) => void;
    onError?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<NotificationDeliveryBatchSummary> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(this.input.runBatch);
    const wrapped = running.finally(() => {
      if (this.active === wrapped) this.active = null;
    });
    this.active = wrapped;
    return wrapped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .then((result) => this.input.onResult?.(result))
        .catch((error) => this.input.onError?.(error))
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delayMs);
    this.timer.unref?.();
  }
}

export function notificationDeliveryWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): NotificationDeliveryWorkerConfig {
  const encryptionKey = String(resolveFabricEnv(env, 'NOTIFICATION_ENCRYPTION_KEY') || '');
  const hmacKey = String(resolveFabricEnv(env, 'NOTIFICATION_HMAC_KEY') || '');
  const flag = String(resolveFabricEnv(env, 'NOTIFICATION_WORKER_ENABLED') || '').trim();
  if (flag && flag !== '0' && flag !== '1') {
    throw new Error('CONVERACT_FABRIC_NOTIFICATION_WORKER_ENABLED must be 0 or 1');
  }
  if (Boolean(encryptionKey) !== Boolean(hmacKey)) {
    throw new Error('notification encryption and HMAC keys must be configured together');
  }
  if (flag === '1' && (!encryptionKey || !hmacKey)) {
    throw new Error('enabled notification worker requires encryption and HMAC keys');
  }
  const partitionCount = integer(
    resolveFabricEnv(env, 'NOTIFICATION_PARTITION_COUNT'),
    1,
    1,
    256,
    'CONVERACT_FABRIC_NOTIFICATION_PARTITION_COUNT'
  );
  const rawPartitionIndex = String(
    resolveFabricEnv(env, 'NOTIFICATION_PARTITION_INDEX') || ''
  ).trim();
  if (partitionCount > 1 && !rawPartitionIndex) {
    throw new Error(
      'CONVERACT_FABRIC_NOTIFICATION_PARTITION_INDEX is required when partition count exceeds 1'
    );
  }
  const partitionIndex = integer(
    rawPartitionIndex || '0',
    0,
    0,
    partitionCount - 1,
    'CONVERACT_FABRIC_NOTIFICATION_PARTITION_INDEX'
  );
  return {
    enabled: flag === '1' || (flag !== '0' && Boolean(encryptionKey && hmacKey)),
    interval_ms: integer(resolveFabricEnv(env, 'NOTIFICATION_INTERVAL_MS'), 5_000, 1_000, 300_000,
      'CONVERACT_FABRIC_NOTIFICATION_INTERVAL_MS'),
    batch_size: integer(resolveFabricEnv(env, 'NOTIFICATION_BATCH_SIZE'), 25, 1, 200,
      'CONVERACT_FABRIC_NOTIFICATION_BATCH_SIZE'),
    tenant_limit: integer(resolveFabricEnv(env, 'NOTIFICATION_TENANT_LIMIT'), 100, 1, 1_000,
      'CONVERACT_FABRIC_NOTIFICATION_TENANT_LIMIT'),
    lease_ms: integer(resolveFabricEnv(env, 'NOTIFICATION_LEASE_MS'), 120_000, 65_000, 900_000,
      'CONVERACT_FABRIC_NOTIFICATION_LEASE_MS'),
    retry_delays_ms: delays(resolveFabricEnv(env, 'NOTIFICATION_RETRY_DELAYS_MS')),
    partition_count: partitionCount,
    partition_index: partitionIndex,
    shard_ids: notificationWorkerShardIds(partitionCount, partitionIndex)
  };
}

export function startNotificationDeliveryWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  protector?: NotificationContentProtector;
  secrets?: NotificationSecretResolver;
  resolveProvider?: NotificationProviderResolver;
}): NotificationDeliveryWorker {
  const env = input.env || process.env;
  const config = notificationDeliveryWorkerConfig(env);
  const repository = new PostgresNotificationStore(input.pg, {
    publish_event: publishNotificationTenantEvent
  });
  const protector = input.protector || configuredNotificationProtector(env);
  const secrets = input.secrets || configuredNotificationSecretResolver(env);
  const resolveProvider = input.resolveProvider || createNotificationProviderResolver({
    endpoints: repository,
    inbox: repository,
    secrets,
    governance: repository
  });
  const workerId = `${hostname()}:${process.pid}:notification:${config.partition_index}:${randomUUID()}`;
  const worker = new NotificationDeliveryWorker({
    config,
    runBatch: async () => {
      const result = await runNotificationDeliveryBatch({
        repository,
        protector,
        resolveProvider,
        worker_id: workerId,
        lease_ms: config.lease_ms,
        batch_size: config.batch_size,
        tenant_limit: config.tenant_limit,
        shard_ids: config.shard_ids,
        retry_delays_ms: config.retry_delays_ms
      });
      await runNotificationReceiptReconciliationBatch({
        repository,
        now: new Date(),
        batch_size: config.batch_size,
        tenant_limit: config.tenant_limit
      });
      const queueMetrics = await repository.getQueueMetrics(new Date());
      const byState = new Map(queueMetrics.map((metric) => [metric.state, metric]));
      for (const state of ['pending', 'processing', 'accepted', 'retry_wait', 'uncertain']) {
        const metric = byState.get(state as typeof queueMetrics[number]['state']);
        setNotificationQueueMetric({
          state,
          depth: metric?.depth || 0,
          oldest_age_seconds: metric?.oldest_age_seconds || 0
        });
      }
      return result;
    },
    onResult: (result) => {
      if (result.claimed) console.log('[notification] batch', JSON.stringify(result));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[notification] worker failed:', message.slice(0, 500));
    }
  });
  worker.start();
  return worker;
}

export function notificationWorkerShardIds(
  partitionCount: number,
  partitionIndex: number
): number[] {
  if (!Number.isInteger(partitionCount) ||
      partitionCount < 1 ||
      partitionCount > 256 ||
      !Number.isInteger(partitionIndex) ||
      partitionIndex < 0 ||
      partitionIndex >= partitionCount) {
    throw new Error('invalid notification worker partition');
  }
  const shards: number[] = [];
  for (
    let shard = partitionIndex;
    shard < NOTIFICATION_LOGICAL_SHARDS;
    shard += partitionCount
  ) {
    shards.push(shard);
  }
  return shards;
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function delays(value: string | undefined): number[] {
  if (!String(value || '').trim()) return [5_000, 30_000, 120_000, 600_000];
  const parsed = String(value).split(',').map((item) => Number(item.trim()));
  if (!parsed.length || parsed.length > 20
    || parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 3_600_000)) {
    throw new Error('CONVERACT_FABRIC_NOTIFICATION_RETRY_DELAYS_MS is invalid');
  }
  return parsed;
}
