import { resolveBrandEnv, resolveFabricEnv } from '../src/config/converact-env.js';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import type { NodeConnectionOptions } from '@nats-io/transport-node';

import {
  DurableLoadRunOrchestrator,
  JetStreamCapacityCommandBus,
  PostgresCapacityLoadRunRepository
} from './capacity/orchestrator/index.js';
import { resolveNatsConnectionOptions } from '../src/infra/nats-connection-options.js';

export interface CapacityDispatcherConfig {
  database_url: string;
  nats: NodeConnectionOptions;
  nats_stream_replicas: number;
  dispatcher_id: string;
  interval_ms: number;
  lease_ttl_ms: number;
  batch_size: number;
}

export function capacityDispatcherConfig(
  env: NodeJS.ProcessEnv = process.env
): CapacityDispatcherConfig {
  const databaseUrl = String(resolveBrandEnv(env, 'DATABASE_URL') || env.DATABASE_URL || '');
  const dispatcherId = String(resolveFabricEnv(env, 'CAPACITY_DISPATCHER_ID') || '');
  if (!databaseUrl) throw new Error('CONVERACT_DATABASE_URL is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(dispatcherId)) {
    throw new Error('CONVERACT_FABRIC_CAPACITY_DISPATCHER_ID is invalid');
  }
  const nats = resolveNatsConnectionOptions(env, { defaultName: dispatcherId });
  if (!nats) throw new Error('NATS_URL is required');
  return {
    database_url: databaseUrl,
    nats,
    nats_stream_replicas: replicaEnv(
      resolveFabricEnv(env, 'CAPACITY_NATS_STREAM_REPLICAS')
    ),
    dispatcher_id: dispatcherId,
    interval_ms: integerEnv(resolveFabricEnv(env, 'CAPACITY_DISPATCH_INTERVAL_MS'), 250, 50, 60_000),
    lease_ttl_ms: integerEnv(resolveFabricEnv(env, 'CAPACITY_DISPATCH_LEASE_MS'), 10_000, 1_000, 300_000),
    batch_size: integerEnv(resolveFabricEnv(env, 'CAPACITY_DISPATCH_BATCH_SIZE'), 100, 1, 1_000)
  };
}

export async function runCapacityDispatcher(
  config: CapacityDispatcherConfig,
  signal?: AbortSignal
): Promise<void> {
  const pool = new Pool({
    connectionString: config.database_url,
    max: 4,
    application_name: config.dispatcher_id
  });
  let bus: JetStreamCapacityCommandBus | null = null;
  try {
    await assertCapacityDispatcherSchema(pool);
    bus = await JetStreamCapacityCommandBus.connect({
      connection_options: config.nats,
      stream_replicas: config.nats_stream_replicas
    });
    const orchestrator = new DurableLoadRunOrchestrator({
      repository: new PostgresCapacityLoadRunRepository(pool),
      command_bus: bus
    });
    while (!signal?.aborted) {
      const now = new Date().toISOString();
      const result = await orchestrator.dispatchCommands({
        dispatcher_id: config.dispatcher_id,
        lease_ttl_ms: config.lease_ttl_ms,
        limit: config.batch_size,
        now
      });
      if (result.claimed === 0) await delay(config.interval_ms, signal);
    }
  } finally {
    await bus?.close().catch(() => undefined);
    await pool.end();
  }
}

function replicaEnv(value: string | undefined): number {
  if (!String(value || '').trim()) {
    throw new Error('CONVERACT_FABRIC_CAPACITY_NATS_STREAM_REPLICAS is required');
  }
  const parsed = Number(value);
  if (parsed !== 1 && parsed !== 3 && parsed !== 5) {
    throw new Error('capacity command stream replicas must be 1, 3, or 5');
  }
  return parsed;
}

export async function assertCapacityDispatcherSchema(
  pg: {
    query(text: string): Promise<{
      rows: Array<{ outbox: string | null }>;
    }>;
  }
): Promise<void> {
  const result = await pg.query(
    `SELECT to_regclass('public.ivekit_capacity_command_outbox')::text AS outbox`
  );
  if (!result.rows[0]?.outbox) {
    throw new Error('capacity orchestrator migration 077 is not applied');
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runCapacityDispatcher(capacityDispatcherConfig(), controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function integerEnv(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('invalid capacity dispatcher numeric configuration');
  }
  return parsed;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[ivekit-capacity-dispatcher]', safeError(error));
    process.exitCode = 1;
  });
}

function safeError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  return code && /^[A-Za-z0-9._:-]{1,255}$/.test(code)
    ? code
    : error instanceof Error
      ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1***@').slice(0, 500)
      : 'capacity_dispatcher_failed';
}
