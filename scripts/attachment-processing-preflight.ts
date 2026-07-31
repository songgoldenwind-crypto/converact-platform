import { fileURLToPath } from 'node:url';

import { attachmentProcessingWorkerConfig } from '../src/agent-runtime/collaboration/attachment-processing-worker.js';
import { configuredAsrProvider } from '../src/agent-runtime/collaboration/asr-provider.js';
import { configuredOcrProvider } from '../src/agent-runtime/collaboration/ocr-provider.js';

export interface AttachmentProcessingPreflightReport {
  ready: boolean;
  issues: string[];
  database: { configured: boolean; url: string };
  storage: {
    configured: boolean;
    endpoint: string;
    bucket: string;
    access_key: string;
    secret_key: string;
  };
  providers: {
    ocr: ProviderSummary;
    asr: ProviderSummary;
  };
  worker: ReturnType<typeof attachmentProcessingWorkerConfig> | null;
  attachment_max_bytes: number | null;
}

interface ProviderSummary {
  configured: boolean;
  mode: string;
  base_url: string;
  endpoint: string;
  token: string;
  timeout_ms: number | null;
}

export function inspectAttachmentProcessingEnv(
  env: NodeJS.ProcessEnv = process.env
): AttachmentProcessingPreflightReport {
  const issues: string[] = [];
  const databaseConfigured = Boolean(String(env.DATABASE_URL || '').trim());
  if (!databaseConfigured) issues.push('DATABASE_URL is required; production attachment processing uses PostgreSQL/RLS');

  const bucket = String(env.S3_BUCKET || env.OPC_S3_BUCKET || env.MINIO_BUCKET || '').trim();
  const endpoint = String(env.S3_ENDPOINT || env.MINIO_ENDPOINT || '').trim();
  if (!bucket) issues.push('S3_BUCKET, OPC_S3_BUCKET, or MINIO_BUCKET is required for durable attachments');

  let ocrConfigured = false;
  let asrConfigured = false;
  try {
    ocrConfigured = Boolean(configuredOcrProvider(env));
  } catch (error) {
    issues.push(errorMessage(error));
  }
  try {
    asrConfigured = Boolean(configuredAsrProvider(env));
  } catch (error) {
    issues.push(errorMessage(error));
  }
  if (!ocrConfigured && !asrConfigured) {
    issues.push('At least one OCR or ASR provider base URL is required');
  }

  let worker: ReturnType<typeof attachmentProcessingWorkerConfig> | null = null;
  try {
    worker = attachmentProcessingWorkerConfig(env);
  } catch (error) {
    issues.push(errorMessage(error));
  }

  let attachmentMaxBytes: number | null = null;
  try {
    attachmentMaxBytes = boundedInteger(
      env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES,
      26_214_400,
      1,
      1_073_741_824,
      'OPC_COLLABORATION_ATTACHMENT_MAX_BYTES'
    );
  } catch (error) {
    issues.push(errorMessage(error));
  }

  return {
    ready: issues.length === 0,
    issues,
    database: {
      configured: databaseConfigured,
      url: databaseConfigured ? '[configured]' : ''
    },
    storage: {
      configured: Boolean(bucket),
      endpoint,
      bucket,
      access_key: secretMarker(env.AWS_ACCESS_KEY_ID || env.S3_ACCESS_KEY_ID || env.MINIO_ACCESS_KEY),
      secret_key: secretMarker(env.AWS_SECRET_ACCESS_KEY || env.S3_SECRET_ACCESS_KEY || env.MINIO_SECRET_KEY)
    },
    providers: {
      ocr: providerSummary(env, 'OCR', ocrConfigured),
      asr: providerSummary(env, 'ASR', asrConfigured)
    },
    worker,
    attachment_max_bytes: attachmentMaxBytes
  };
}

function providerSummary(env: NodeJS.ProcessEnv, prefix: 'OCR' | 'ASR', configured: boolean): ProviderSummary {
  const mode = String(env[`OPC_${prefix}_PROVIDER_MODE`] || 'self_hosted').trim();
  const baseUrl = String(env[`OPC_${prefix}_BASE_URL`] || '').trim();
  const endpoint = String(env[`OPC_${prefix}_ENDPOINT`] || `/v1/${prefix.toLowerCase()}`).trim();
  const timeout = String(env[`OPC_${prefix}_TIMEOUT_MS`] || '').trim();
  return {
    configured,
    mode,
    base_url: baseUrl,
    endpoint,
    token: secretMarker(env[`OPC_${prefix}_TOKEN`]),
    timeout_ms: timeout ? Number(timeout) : 30_000
  };
}

function secretMarker(value: string | undefined): string {
  return String(value || '').trim() ? '[configured]' : '';
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (value == null || !String(value).trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const report = inspectAttachmentProcessingEnv(process.env);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
