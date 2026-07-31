import { resolveConveractEnv, resolveFabricEnv } from '../src/config/converact-env.js';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  CapacityRunController,
  DurableLoadRunOrchestrator,
  PostgresCapacityLoadRunRepository,
  assertCapacityManifestHash,
  type CapacityRunControllerControl
} from './capacity/orchestrator/index.js';
import type { LoadRunManifest } from './capacity/profile-compiler.js';

export interface CapacityControllerConfig {
  database_url: string;
  controller_id: string;
  manifest_path: string;
  lease_ttl_ms: number;
  poll_interval_ms: number;
}

export function capacityControllerConfig(
  env: NodeJS.ProcessEnv = process.env
): CapacityControllerConfig {
  const leaseTtlMs = integer(
    resolveFabricEnv(env, 'CAPACITY_CONTROLLER_LEASE_MS') || '15000',
    1_000,
    300_000
  );
  return {
    database_url: required(env, 'CONVERACT_DATABASE_URL'),
    controller_id: safeId(
      required(env, 'CONVERACT_FABRIC_CAPACITY_CONTROLLER_ID'),
      'controller ID'
    ),
    manifest_path: absolutePath(
      required(env, 'CONVERACT_FABRIC_CAPACITY_MANIFEST_PATH')
    ),
    lease_ttl_ms: leaseTtlMs,
    poll_interval_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_CONTROLLER_POLL_INTERVAL_MS') || '500',
      100,
      Math.floor(leaseTtlMs / 3)
    )
  };
}

export function readCapacityControllerManifest(path: string): {
  manifest: LoadRunManifest;
  manifest_sha256: string;
} {
  const size = statSync(path).size;
  if (size <= 0 || size > 16 * 1024 * 1024) {
    throw new Error('capacity manifest bundle size is invalid');
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    manifest?: LoadRunManifest;
    manifest_sha256?: string;
  };
  if (!raw.manifest || typeof raw.manifest !== 'object' ||
      !/^[a-f0-9]{64}$/.test(String(raw.manifest_sha256 || ''))) {
    throw new Error('capacity manifest bundle is malformed');
  }
  assertCapacityManifestHash(raw.manifest, raw.manifest_sha256!);
  return {
    manifest: structuredClone(raw.manifest),
    manifest_sha256: raw.manifest_sha256!
  };
}

export async function runCapacityController(
  config: CapacityControllerConfig,
  signal?: AbortSignal
): Promise<{
  run_id: string;
  state: string;
  outcome: string;
}> {
  const pool = new Pool({
    connectionString: config.database_url,
    max: 4,
    application_name: config.controller_id
  });
  try {
    const repository = new PostgresCapacityLoadRunRepository(pool);
    const orchestrator = new DurableLoadRunOrchestrator({
      repository,
      command_bus: {
        async publish() {
          throw new Error('capacity controller cannot publish commands directly');
        }
      }
    });
    const control: CapacityRunControllerControl = {
      createRun: (input) => orchestrator.createRun(input),
      readRunControlState: (input) => repository.readRunControlState(input),
      claimController: (input) => orchestrator.claimController(input),
      readPhaseProgress: (input) => repository.readPhaseProgress(input),
      startPhase: (input) => orchestrator.startPhase(input),
      completePhase: (input) => orchestrator.completePhase(input),
      skipPendingPhases: (input) => repository.skipPendingPhases(input),
      beginRunFinalization: (input) => repository.beginRunFinalization(input),
      finalizeRun: (input) => orchestrator.finalizeRun(input)
    };
    return await new CapacityRunController({
      control,
      controller_id: config.controller_id,
      lease_ttl_ms: config.lease_ttl_ms,
      poll_interval_ms: config.poll_interval_ms
    }).run(readCapacityControllerManifest(config.manifest_path), signal);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runCapacityController(
      capacityControllerConfig(),
      controller.signal
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
    throw new Error(`capacity ${label} is invalid`);
  }
  return value;
}

function absolutePath(value: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value) ||
      value.split('/').includes('..')) {
    throw new Error('capacity manifest path must be absolute');
  }
  return value;
}

function integer(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('capacity controller numeric configuration is invalid');
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[ivekit-capacity-controller]', safeError(error));
    process.exitCode = 1;
  });
}

function safeError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  return code && /^[A-Za-z0-9._:-]{1,255}$/.test(code)
    ? code
    : error instanceof Error
      ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1***@').slice(0, 500)
      : 'capacity_controller_failed';
}
