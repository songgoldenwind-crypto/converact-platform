import { resolveConveractEnv, resolveFabricEnv } from '../src/config/converact-env.js';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import type { NodeConnectionOptions } from '@nats-io/transport-node';

import { ExternalJsonCapacityShardDriver, readExternalCapacityWorkerSpec } from './capacity/generators/external-worker.js';
import {
  CheckpointedCapacityShardExecutor,
  DurableCapacityShardResultFinalizer,
  DurableLoadRunOrchestrator,
  FencedCapacityCommandHandler,
  JetStreamCapacityCommandConsumer,
  PostgresCapacityLoadRunRepository,
  S3CapacityEvidenceObjectStore
} from './capacity/orchestrator/index.js';
import type { LoadFleet } from './capacity/profile-compiler.js';
import { resolveNatsConnectionOptions } from '../src/infra/nats-connection-options.js';

export interface CapacityWorkerConfig {
  database_url: string;
  nats: NodeConnectionOptions;
  run_id: string;
  phase_id: string;
  fleet_id: LoadFleet;
  worker_id: string;
  release_id: string;
  safe_capacity: number;
  heartbeat_interval_ms: number;
  assignment_interval_ms: number;
  lease_ttl_ms: number;
  ack_wait_ms: number;
  retry_delay_ms: number;
  driver_spec_path: string;
  evidence_prefix: string;
  evidence_s3: {
    bucket: string;
    region: string;
    endpoint?: string;
    force_path_style: boolean;
    access_key_id?: string;
    secret_access_key?: string;
  };
  metadata: Record<string, unknown>;
}

export function capacityWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): CapacityWorkerConfig {
  const databaseUrl = required(env, 'CONVERACT_DATABASE_URL');
  const fleetId = required(env, 'CONVERACT_FABRIC_CAPACITY_FLEET_ID');
  if (!['tinode', 'ivekit_event_ws', 'sip', 'livekit', 'rustdesk'].includes(fleetId)) {
    throw new Error('CONVERACT_FABRIC_CAPACITY_FLEET_ID is invalid');
  }
  const workerId = safeId(
    required(env, 'CONVERACT_FABRIC_CAPACITY_WORKER_ID'),
    'worker ID'
  );
  const nats = resolveNatsConnectionOptions(env, { defaultName: workerId });
  if (!nats) throw new Error('NATS_URL is required');
  const config: CapacityWorkerConfig = {
    database_url: databaseUrl,
    nats,
    run_id: safeId(required(env, 'CONVERACT_FABRIC_CAPACITY_RUN_ID'), 'run ID'),
    phase_id: resolveFabricEnv(env, 'CAPACITY_PHASE_ID')
      ? safeId(resolveFabricEnv(env, 'CAPACITY_PHASE_ID'), 'phase ID')
      : '',
    fleet_id: fleetId as LoadFleet,
    worker_id: workerId,
    release_id: safeId(required(env, 'CONVERACT_FABRIC_CAPACITY_RELEASE_ID'), 'release ID'),
    safe_capacity: integer(resolveFabricEnv(env, 'CAPACITY_SAFE_CAPACITY'), 1, 1_000_000_000),
    heartbeat_interval_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_HEARTBEAT_INTERVAL_MS') || '5000',
      1_000,
      20_000
    ),
    assignment_interval_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_ASSIGNMENT_INTERVAL_MS') || '500',
      100,
      60_000
    ),
    lease_ttl_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_SHARD_LEASE_MS') || '30000',
      1_000,
      300_000
    ),
    ack_wait_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_ACK_WAIT_MS') || '30000',
      1_000,
      300_000
    ),
    retry_delay_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_RETRY_DELAY_MS') || '1000',
      100,
      60_000
    ),
    driver_spec_path: absolutePath(
      required(env, 'CONVERACT_FABRIC_CAPACITY_DRIVER_SPEC_PATH'),
      'driver spec'
    ),
    evidence_prefix: required(env, 'CONVERACT_FABRIC_CAPACITY_EVIDENCE_PREFIX'),
    evidence_s3: {
      bucket: required(env, 'CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET'),
      region: required(env, 'CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION'),
      endpoint: optionalEndpoint(resolveFabricEnv(env, 'CAPACITY_EVIDENCE_S3_ENDPOINT')),
      force_path_style: booleanEnv(
        resolveFabricEnv(env, 'CAPACITY_EVIDENCE_S3_FORCE_PATH_STYLE'),
        false
      ),
      access_key_id: resolveFabricEnv(env, 'CAPACITY_EVIDENCE_S3_ACCESS_KEY_ID') || undefined,
      secret_access_key:
        resolveFabricEnv(env, 'CAPACITY_EVIDENCE_S3_SECRET_ACCESS_KEY') || undefined
    },
    metadata: jsonObject(resolveFabricEnv(env, 'CAPACITY_WORKER_METADATA_JSON') || '{}')
  };
  if (config.heartbeat_interval_ms * 2 >= config.lease_ttl_ms) {
    throw new Error('capacity worker heartbeat interval must be below half the shard lease');
  }
  return config;
}

export async function runCapacityWorker(
  config: CapacityWorkerConfig,
  externalSignal?: AbortSignal
): Promise<void> {
  const controller = new AbortController();
  const relayAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', relayAbort, { once: true });
  if (externalSignal?.aborted) relayAbort();
  const pool = new Pool({
    connectionString: config.database_url,
    max: 4,
    application_name: config.worker_id
  });
  let consumer: JetStreamCapacityCommandConsumer | null = null;
  let repository: PostgresCapacityLoadRunRepository | null = null;
  try {
    await assertCapacityWorkerSchema(pool);
    repository = new PostgresCapacityLoadRunRepository(pool);
    const orchestrator = new DurableLoadRunOrchestrator({
      repository,
      command_bus: { async publish() {
        throw new Error('capacity worker cannot publish commands');
      } }
    });
    consumer = await JetStreamCapacityCommandConsumer.connect({
      connection_options: config.nats,
      fleet_id: config.fleet_id,
      worker_id: config.worker_id,
      ack_wait_ms: config.ack_wait_ms,
      retry_delay_ms: config.retry_delay_ms,
      max_ack_pending: 1
    });
    const executor = new CheckpointedCapacityShardExecutor({
      driver: new ExternalJsonCapacityShardDriver({
        spec: readExternalCapacityWorkerSpec(config.driver_spec_path)
      }),
      checkpoint_repository: repository,
      finalizer: new DurableCapacityShardResultFinalizer({
        control: orchestrator,
        object_store: new S3CapacityEvidenceObjectStore(config.evidence_s3),
        evidence_prefix: config.evidence_prefix
      })
    });
    const handler = new FencedCapacityCommandHandler({
      worker_id: config.worker_id,
      fleet_id: config.fleet_id,
      lease_ttl_ms: config.lease_ttl_ms,
      coordinator: {
        renew: (input) => orchestrator.renewShardLease(input)
      },
      executor
    });
    const tasks = [
      consumer.run(handler, { signal: controller.signal }),
      runWorkerScheduler(config, repository, orchestrator, controller.signal)
    ];
    try {
      await Promise.all(tasks);
    } finally {
      controller.abort();
      await Promise.allSettled(tasks);
    }
  } finally {
    externalSignal?.removeEventListener('abort', relayAbort);
    if (repository) {
      await repository.heartbeatWorker({
        run_id: config.run_id,
        worker_id: config.worker_id,
        fleet_id: config.fleet_id,
        release_id: config.release_id,
        state: 'offline',
        safe_capacity: config.safe_capacity,
        reported_load: 0,
        observed_at: new Date().toISOString(),
        metadata: config.metadata
      }).catch(() => undefined);
    }
    await consumer?.close().catch(() => undefined);
    await pool.end();
  }
}

async function runWorkerScheduler(
  config: CapacityWorkerConfig,
  repository: PostgresCapacityLoadRunRepository,
  orchestrator: DurableLoadRunOrchestrator,
  signal: AbortSignal
): Promise<void> {
  let nextHeartbeatAt = 0;
  while (!signal.aborted) {
    const now = new Date().toISOString();
    const scheduling = await repository.readRunSchedulingState({
      run_id: config.run_id
    });
    const outstanding = await repository.readWorkerOutstanding({
      run_id: config.run_id,
      worker_id: config.worker_id,
      fleet_id: config.fleet_id,
      now
    });
    if (Date.now() >= nextHeartbeatAt) {
      await orchestrator.heartbeatWorker({
        run_id: config.run_id,
        worker_id: config.worker_id,
        fleet_id: config.fleet_id,
        release_id: config.release_id,
        state: 'online',
        safe_capacity: config.safe_capacity,
        reported_load: outstanding.reported_load,
        observed_at: now,
        metadata: config.metadata
      });
      nextHeartbeatAt = Date.now() + config.heartbeat_interval_ms;
    }
    const phaseId = config.phase_id || scheduling.current_phase_id;
    const phaseMatchesPin = !config.phase_id ||
      config.phase_id === scheduling.current_phase_id;
    if (outstanding.shard_count === 0 && scheduling.state === 'running' &&
        phaseId && phaseMatchesPin) {
      await orchestrator.assignNextShard({
        run_id: config.run_id,
        phase_id: phaseId,
        worker_id: config.worker_id,
        fleet_id: config.fleet_id,
        lease_ttl_ms: config.lease_ttl_ms,
        now
      });
    }
    await delay(config.assignment_interval_ms, signal);
  }
}

export async function assertCapacityWorkerSchema(
  pg: {
    query(text: string): Promise<{
      rows: Array<{
        shards: string | null;
        execution_state: string | null;
      }>;
    }>;
  }
): Promise<void> {
  const result = await pg.query(
    `SELECT
       to_regclass('public.ivekit_capacity_load_shards')::text AS shards,
       (
         SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'ivekit_capacity_load_shards'
           AND column_name = 'execution_state'
       ) AS execution_state`
  );
  if (!result.rows[0]?.shards || !result.rows[0]?.execution_state) {
    throw new Error('capacity worker checkpoint migration 082 is not applied');
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runCapacityWorker(capacityWorkerConfig(), controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(resolveConveractEnv(env, key) || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new Error(`capacity worker ${label} is invalid`);
  }
  return value;
}

function integer(value: string | undefined, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('capacity worker numeric configuration is invalid');
  }
  return parsed;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('capacity worker boolean configuration is invalid');
}

function absolutePath(value: string, label: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value) ||
      value.split('/').includes('..')) {
    throw new Error(`capacity worker ${label} path is invalid`);
  }
  return value;
}

function optionalEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password) {
    throw new Error('capacity worker S3 endpoint is invalid');
  }
  return endpoint.toString();
}

function jsonObject(value: string): Record<string, unknown> {
  if (Buffer.byteLength(value) > 64 * 1024) {
    throw new Error('capacity worker metadata is too large');
  }
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('capacity worker metadata must be an object');
  }
  return parsed as Record<string, unknown>;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[converact-capacity-worker]', safeError(error));
    process.exitCode = 1;
  });
}

function safeError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  return code && /^[A-Za-z0-9._:-]{1,255}$/.test(code)
    ? code
    : error instanceof Error
      ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1***@').slice(0, 500)
      : 'capacity_worker_failed';
}
