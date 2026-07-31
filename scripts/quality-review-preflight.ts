import { resolveBrandEnv } from '../src/config/converact-env.js';
import { fileURLToPath } from 'node:url';

import {
  configuredQualityReviewProvider
} from '../src/agent-runtime/collaboration/quality-review.js';
import {
  qualityReviewWorkerConfig
} from '../src/agent-runtime/collaboration/quality-review-worker.js';

export interface QualityReviewPreflightReport {
  ready: boolean;
  issues: string[];
  database: { configured: boolean; url: string };
  provider: {
    configured: boolean;
    mode: string;
    name: string;
    base_url: string;
    endpoint: string;
    token: string;
    timeout_ms: number | null;
  };
  auto_enqueue: boolean | null;
  worker: ReturnType<typeof qualityReviewWorkerConfig> | null;
  verification_scope: 'configuration_only';
}

export function inspectQualityReviewEnv(
  env: NodeJS.ProcessEnv = process.env
): QualityReviewPreflightReport {
  const issues: string[] = [];
  const databaseConfigured = hasValue(env.DATABASE_URL);
  if (!databaseConfigured) {
    issues.push('DATABASE_URL is required; production quality review uses PostgreSQL/RLS');
  }

  let providerConfigured = false;
  try {
    providerConfigured = Boolean(configuredQualityReviewProvider(env));
  } catch (error) {
    issues.push(errorMessage(error));
  }
  if (!providerConfigured) issues.push('Quality review provider base URL is required');

  let autoEnqueue: boolean | null = null;
  const autoEnqueueFlag = String(resolveBrandEnv(env, 'QUALITY_REVIEW_AUTO_ENQUEUE') || '').trim();
  if (autoEnqueueFlag && autoEnqueueFlag !== '0' && autoEnqueueFlag !== '1') {
    issues.push('CONVERACT_QUALITY_REVIEW_AUTO_ENQUEUE must be 0 or 1');
  } else {
    autoEnqueue = autoEnqueueFlag === '1' || (autoEnqueueFlag !== '0' && providerConfigured);
  }

  let worker: ReturnType<typeof qualityReviewWorkerConfig> | null = null;
  try {
    worker = qualityReviewWorkerConfig(env);
  } catch (error) {
    issues.push(errorMessage(error));
  }

  const timeout = String(resolveBrandEnv(env, 'QUALITY_REVIEW_TIMEOUT_MS') || '').trim();
  return {
    ready: issues.length === 0,
    issues: [...new Set(issues)],
    database: {
      configured: databaseConfigured,
      url: databaseConfigured ? '[configured]' : ''
    },
    provider: {
      configured: providerConfigured,
      mode: String(resolveBrandEnv(env, 'QUALITY_REVIEW_PROVIDER_MODE') || 'self_hosted').trim(),
      name: String(resolveBrandEnv(env, 'QUALITY_REVIEW_PROVIDER_NAME') || '').trim(),
      base_url: sanitizedUrl(resolveBrandEnv(env, 'QUALITY_REVIEW_BASE_URL')),
      endpoint: String(resolveBrandEnv(env, 'QUALITY_REVIEW_ENDPOINT') || '/v1/quality-review').trim(),
      token: secretMarker(resolveBrandEnv(env, 'QUALITY_REVIEW_TOKEN')),
      timeout_ms: timeout ? Number(timeout) : 30_000
    },
    auto_enqueue: autoEnqueue,
    worker,
    verification_scope: 'configuration_only'
  };
}

function sanitizedUrl(value: string | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|signature)/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    return url.toString().replace(/%5Bredacted%5D/gi, '[redacted]');
  } catch {
    return '[invalid-url]';
  }
}

function secretMarker(value: string | undefined): string {
  return hasValue(value) ? '[configured]' : '';
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const report = inspectQualityReviewEnv(process.env);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
