import {
  createIntelligenceProviderRegistry,
  type SafeIntelligenceProviderProfile
} from '../collaboration/intelligence-provider-registry.js';

export interface IveKitIntelligencePreflightReport {
  ready: boolean;
  issues: string[];
  database: { configured: boolean };
  storage: { configured: boolean };
  profiles: SafeIntelligenceProviderProfile[];
  workers: {
    attachment: WorkerBudget;
    quality_review: WorkerBudget;
    translation: WorkerBudget;
  };
  verification_scope: 'configuration_only';
}

interface WorkerBudget {
  enabled: boolean;
  claim_lease_ms: number | null;
}

export function inspectIveKitIntelligenceEnv(
  env: NodeJS.ProcessEnv = process.env
): IveKitIntelligencePreflightReport {
  const issues: string[] = [];
  const databaseConfigured = hasValue(env.DATABASE_URL) || (
    hasValue(env.PGHOST) && hasValue(env.PGDATABASE) && hasValue(env.PGUSER)
  );
  if (!databaseConfigured) issues.push('PostgreSQL configuration is required');

  let profiles: SafeIntelligenceProviderProfile[] = [];
  let internalProfiles: ReturnType<ReturnType<typeof createIntelligenceProviderRegistry>['list']> = [];
  try {
    const registry = createIntelligenceProviderRegistry(env);
    profiles = registry.listSafe();
    internalProfiles = registry.list();
    if (!profiles.length) issues.push('At least one intelligence provider profile is required');
    for (const profile of profiles) {
      if (!profile.token_configured) issues.push(`Provider profile ${profile.id} credential is not configured`);
    }
  } catch (error) {
    issues.push(safeErrorMessage(error));
  }

  const needsStorage = internalProfiles.some((profile) => profile.capability === 'ocr' || profile.capability === 'asr');
  const storageConfigured = hasValue(env.S3_BUCKET) || hasValue(env.OPC_S3_BUCKET) || hasValue(env.MINIO_BUCKET);
  if (needsStorage && !storageConfigured) {
    issues.push('Object storage bucket is required for OCR/ASR provider profiles');
  }

  const attachment = workerBudget(
    env,
    'OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED',
    internalProfiles.some((profile) => profile.capability === 'ocr' || profile.capability === 'asr'),
    'OPC_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS',
    60_000,
    issues
  );
  const quality = workerBudget(
    env,
    'OPC_QUALITY_REVIEW_WORKER_ENABLED',
    internalProfiles.some((profile) => profile.capability === 'quality_review'),
    'OPC_QUALITY_REVIEW_CLAIM_LEASE_MS',
    120_000,
    issues
  );
  const translation = workerBudget(
    env,
    'OPC_TRANSLATION_WORKER_ENABLED',
    internalProfiles.some((profile) => profile.capability === 'translation'),
    'OPC_TRANSLATION_CLAIM_LEASE_MS',
    120_000,
    issues
  );

  for (const profile of internalProfiles) {
    const worker = profile.capability === 'quality_review'
      ? quality
      : profile.capability === 'translation'
        ? translation
        : attachment;
    if (worker.claim_lease_ms != null && worker.claim_lease_ms < profile.timeout_ms + 5_000) {
      issues.push(`Provider profile ${profile.id} timeout exceeds its worker claim lease safety budget`);
    }
  }

  const report: IveKitIntelligencePreflightReport = {
    ready: issues.length === 0,
    issues: [...new Set(issues)],
    database: { configured: databaseConfigured },
    storage: { configured: storageConfigured },
    profiles,
    workers: { attachment, quality_review: quality, translation },
    verification_scope: 'configuration_only'
  };
  assertSecretSafe(report, secretValues(env, internalProfiles.map((profile) => profile.token_env)));
  return report;
}

function workerBudget(
  env: NodeJS.ProcessEnv,
  enabledField: string,
  configured: boolean,
  leaseField: string,
  fallbackLease: number,
  issues: string[]
): WorkerBudget {
  const rawEnabled = String(env[enabledField] || '').trim();
  if (rawEnabled && rawEnabled !== '0' && rawEnabled !== '1') {
    issues.push(`${enabledField} must be 0 or 1`);
  }
  let claimLease: number | null = null;
  try {
    claimLease = boundedInteger(env[leaseField], fallbackLease, 5_000, 600_000, leaseField);
  } catch (error) {
    issues.push(safeErrorMessage(error));
  }
  return {
    enabled: configured && rawEnabled !== '0',
    claim_lease_ms: claimLease
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!hasValue(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function secretValues(env: NodeJS.ProcessEnv, tokenEnvNames: string[]): string[] {
  const names = [
    'DATABASE_URL',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    ...tokenEnvNames
  ];
  return names.map((name) => String(env[name] || '')).filter((value) => value.length >= 6);
}

function assertSecretSafe(report: IveKitIntelligencePreflightReport, secrets: string[]): void {
  const serialized = JSON.stringify(report);
  if (secrets.some((secret) => serialized.includes(secret))) {
    throw new Error('intelligence preflight report failed secret-safety validation');
  }
}

function safeErrorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 300);
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}
