import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  CapacityRunEvidenceFinalizer,
  DurableLoadRunOrchestrator,
  PostgresCapacityLoadRunRepository,
  S3CapacityEvidenceObjectStore,
  type CapacityRunEvidenceControl,
  type CapacityRunEvidenceSubmission
} from './capacity/orchestrator/index.js';
import {
  readCapacityControllerManifest
} from './ivekit-capacity-controller.js';
import type { CapacityEvidenceResult } from './capacity/evidence-validator.js';

export interface CapacityFinalizerConfig {
  database_url: string;
  finalizer_id: string;
  manifest_path: string;
  submission_path: string;
  lease_ttl_ms: number;
  evidence_prefix: string;
  evidence_s3: {
    bucket: string;
    region: string;
    endpoint?: string;
    force_path_style: boolean;
    access_key_id?: string;
    secret_access_key?: string;
  };
}

export function capacityFinalizerConfig(
  env: NodeJS.ProcessEnv = process.env
): CapacityFinalizerConfig {
  return {
    database_url: required(env, 'OPC_DATABASE_URL'),
    finalizer_id: safeId(
      required(env, 'OPC_IVEKIT_CAPACITY_FINALIZER_ID'),
      'finalizer ID'
    ),
    manifest_path: absolutePath(
      required(env, 'OPC_IVEKIT_CAPACITY_MANIFEST_PATH')
    ),
    submission_path: absolutePath(
      required(env, 'OPC_IVEKIT_CAPACITY_EVIDENCE_SUBMISSION_PATH')
    ),
    lease_ttl_ms: integer(
      env.OPC_IVEKIT_CAPACITY_FINALIZER_LEASE_MS || '15000',
      1_000,
      300_000
    ),
    evidence_prefix: required(env, 'OPC_IVEKIT_CAPACITY_EVIDENCE_PREFIX'),
    evidence_s3: {
      bucket: required(env, 'OPC_IVEKIT_CAPACITY_EVIDENCE_S3_BUCKET'),
      region: required(env, 'OPC_IVEKIT_CAPACITY_EVIDENCE_S3_REGION'),
      endpoint: optionalEndpoint(env.OPC_IVEKIT_CAPACITY_EVIDENCE_S3_ENDPOINT),
      force_path_style: booleanEnv(
        env.OPC_IVEKIT_CAPACITY_EVIDENCE_S3_FORCE_PATH_STYLE,
        false
      ),
      access_key_id: env.OPC_IVEKIT_CAPACITY_EVIDENCE_S3_ACCESS_KEY_ID || undefined,
      secret_access_key:
        env.OPC_IVEKIT_CAPACITY_EVIDENCE_S3_SECRET_ACCESS_KEY || undefined
    }
  };
}

export function readCapacityEvidenceSubmission(
  path: string
): CapacityRunEvidenceSubmission {
  const size = statSync(path).size;
  if (size <= 0 || size > 16 * 1024 * 1024) {
    throw new Error('capacity evidence submission size is invalid');
  }
  const submission = JSON.parse(
    readFileSync(path, 'utf8')
  ) as CapacityRunEvidenceSubmission;
  if (!submission || typeof submission !== 'object' ||
      submission.schema_version !== '1.0.0') {
    throw new Error('capacity evidence submission is malformed');
  }
  return structuredClone(submission);
}

export async function runCapacityFinalizer(
  config: CapacityFinalizerConfig,
  signal?: AbortSignal
): Promise<CapacityEvidenceResult> {
  const pool = new Pool({
    connectionString: config.database_url,
    max: 4,
    application_name: config.finalizer_id
  });
  try {
    const repository = new PostgresCapacityLoadRunRepository(pool);
    const orchestrator = new DurableLoadRunOrchestrator({
      repository,
      command_bus: {
        async publish() {
          throw new Error('capacity finalizer cannot publish commands');
        }
      }
    });
    const control: CapacityRunEvidenceControl = {
      readRunControlState: (input) => repository.readRunControlState(input),
      claimController: (input) => orchestrator.claimController(input),
      registerEvidence: (input) => orchestrator.registerEvidence(input),
      startEvidenceUpload: (input) => orchestrator.startEvidenceUpload(input),
      completeEvidenceUpload: (input) =>
        orchestrator.completeEvidenceUpload(input),
      verifyEvidence: (input) => orchestrator.verifyEvidence(input),
      finalizeRun: (input) => orchestrator.finalizeRun(input)
    };
    const bundle = readCapacityControllerManifest(config.manifest_path);
    return await new CapacityRunEvidenceFinalizer({
      control,
      object_store: new S3CapacityEvidenceObjectStore(config.evidence_s3),
      controller_id: config.finalizer_id,
      lease_ttl_ms: config.lease_ttl_ms,
      evidence_prefix: config.evidence_prefix
    }).finalize({
      manifest: bundle.manifest,
      submission: readCapacityEvidenceSubmission(config.submission_path)
    }, signal);
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
    const result = await runCapacityFinalizer(
      capacityFinalizerConfig(),
      controller.signal
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || '').trim();
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
    throw new Error('capacity evidence path must be absolute');
  }
  return value;
}

function integer(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('capacity finalizer numeric configuration is invalid');
  }
  return parsed;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('capacity finalizer boolean configuration is invalid');
}

function optionalEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password) {
    throw new Error('capacity finalizer S3 endpoint is invalid');
  }
  return endpoint.toString();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[ivekit-capacity-finalizer]', safeError(error));
    process.exitCode = 1;
  });
}

function safeError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  return code && /^[A-Za-z0-9._:-]{1,255}$/.test(code)
    ? code
    : error instanceof Error
      ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1***@').slice(0, 500)
      : 'capacity_finalizer_failed';
}
