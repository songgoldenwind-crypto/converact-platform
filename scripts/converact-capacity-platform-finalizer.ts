import { resolveConveractEnv, resolveFabricEnv } from '../src/config/converact-env.js';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { S3CapacityEvidenceObjectStore } from './capacity/orchestrator/s3-evidence.js';
import {
  CapacityPlatformCampaignEvidenceFinalizer,
  PostgresCapacityPlatformCampaignRepository,
  PostgresVerifiedCapacityScalingCampaignSource
} from './capacity/platform-campaign-runtime.js';
import type { CapacityPlatformCampaignSubmission } from './capacity/platform-campaign.js';
import {
  PostgresVerifiedCapacityRunEvidenceSource
} from './capacity/scaling-campaign-runtime.js';
import type { ScalingEfficiencyContract } from './capacity/scaling-campaign.js';

export interface CapacityPlatformFinalizerConfig {
  database_url: string;
  finalizer_id: string;
  contract_path: string;
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

export function capacityPlatformFinalizerConfig(
  env: NodeJS.ProcessEnv = process.env
): CapacityPlatformFinalizerConfig {
  return {
    database_url: required(env, 'CONVERACT_DATABASE_URL'),
    finalizer_id: safeId(required(env, 'CONVERACT_FABRIC_CAPACITY_PLATFORM_FINALIZER_ID')),
    contract_path: absolutePath(required(env, 'CONVERACT_FABRIC_CAPACITY_PLATFORM_CONTRACT_PATH')),
    submission_path: absolutePath(required(env, 'CONVERACT_FABRIC_CAPACITY_PLATFORM_SUBMISSION_PATH')),
    lease_ttl_ms: integer(
      resolveFabricEnv(env, 'CAPACITY_PLATFORM_FINALIZER_LEASE_MS') || '15000',
      1_000,
      300_000
    ),
    evidence_prefix: required(env, 'CONVERACT_FABRIC_CAPACITY_PLATFORM_EVIDENCE_PREFIX'),
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
    }
  };
}

export function readCapacityPlatformCampaignInput(
  contractPath: string,
  submissionPath: string
): {
  contract: ScalingEfficiencyContract;
  submission: CapacityPlatformCampaignSubmission;
} {
  const contract = readJson<ScalingEfficiencyContract>(contractPath, 'platform contract');
  const submission = readJson<CapacityPlatformCampaignSubmission>(
    submissionPath,
    'platform submission'
  );
  if (contract.schema_version !== '1.0.0' || !contract.contract_id ||
      submission.schema_version !== '1.0.0' || !submission.platform_campaign_id) {
    throw new Error('capacity platform input schema is invalid');
  }
  return { contract, submission };
}

export async function runCapacityPlatformFinalizer(
  config: CapacityPlatformFinalizerConfig,
  signal?: AbortSignal
): Promise<{
  platform_campaign_id: string;
  outcome: string;
  capacity_claim: string;
  scaling_campaign_count: number;
  endpoint_interactions: number;
  reasons: string[];
}> {
  const pool = new Pool({
    connectionString: config.database_url,
    max: 4,
    application_name: config.finalizer_id
  });
  try {
    await assertCapacityPlatformSchema(pool);
    const objectStore = new S3CapacityEvidenceObjectStore(config.evidence_s3);
    const input = readCapacityPlatformCampaignInput(
      config.contract_path,
      config.submission_path
    );
    const result = await new CapacityPlatformCampaignEvidenceFinalizer({
      control: new PostgresCapacityPlatformCampaignRepository(pool),
      scaling_source: new PostgresVerifiedCapacityScalingCampaignSource(pool, objectStore),
      endpoint_source: new PostgresVerifiedCapacityRunEvidenceSource(pool, objectStore),
      object_store: objectStore,
      controller_id: config.finalizer_id,
      lease_ttl_ms: config.lease_ttl_ms,
      evidence_prefix: config.evidence_prefix
    }).finalize(input, signal);
    return {
      platform_campaign_id: result.platform_campaign_id,
      outcome: result.outcome,
      capacity_claim: result.capacity_claim,
      scaling_campaign_count: result.scaling_campaign_count,
      endpoint_interactions: result.endpoint_interactions,
      reasons: [...result.reasons]
    };
  } finally {
    await pool.end();
  }
}

export async function assertCapacityPlatformSchema(pg: {
  query(text: string): Promise<{ rows: Array<{ platform: string | null; refs: string | null }> }>;
}): Promise<void> {
  const result = await pg.query(
    `SELECT
       to_regclass('public.ivekit_capacity_platform_campaigns')::text AS platform,
       to_regclass('public.ivekit_capacity_platform_scaling_refs')::text AS refs`
  );
  if (!result.rows[0]?.platform || !result.rows[0]?.refs) {
    throw new Error('capacity platform migration 092 is not applied');
  }
}

function readJson<T>(path: string, label: string): T {
  const size = statSync(path).size;
  if (size <= 0 || size > 16 * 1024 * 1024) throw new Error(`${label} size is invalid`);
  const value = JSON.parse(readFileSync(path, 'utf8')) as T;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return structuredClone(value);
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(resolveConveractEnv(env, key) || '').trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new Error('capacity platform finalizer ID is invalid');
  }
  return value;
}

function absolutePath(value: string): string {
  if (!value.startsWith('/') || /[\r\n\0]/.test(value) || value.split('/').includes('..')) {
    throw new Error('capacity platform path must be absolute');
  }
  return value;
}

function integer(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('capacity platform numeric configuration is invalid');
  }
  return parsed;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('capacity platform boolean configuration is invalid');
}

function optionalEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username || endpoint.password) {
    throw new Error('capacity platform S3 endpoint is invalid');
  }
  return endpoint.toString();
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runCapacityPlatformFinalizer(
      capacityPlatformFinalizerConfig(),
      controller.signal
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[converact-capacity-platform-finalizer]', safeError(error));
    process.exitCode = 1;
  });
}

function safeError(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  return code && /^[A-Za-z0-9._:-]{1,255}$/.test(code)
    ? code
    : error instanceof Error
      ? error.message.replace(/(?:postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1***@').slice(0, 500)
      : 'capacity_platform_finalizer_failed';
}
