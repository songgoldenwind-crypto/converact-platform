import { resolveBrandEnv } from '../src/config/converact-env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConveractFabricRustDeskHttpClient,
  type ConveractFabricRustDeskHttpClient
} from '../src/agent-runtime/converact/index.js';

export type RustDeskAuditExportClient = Pick<ConveractFabricRustDeskHttpClient, 'listGatewayAuditEvents'>;

export interface RustDeskAuditExportConfig {
  outputFile: string;
  externalId: string;
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  userId?: string;
  since?: string;
}

export interface RustDeskAuditExportResult {
  outputFile: string;
  externalId: string;
  events: number;
  format: 'jsonl';
}

export function createRustDeskAuditExportConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskAuditExportConfig {
  const outputFile = requiredString(resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_FILE'), 'CONVERACT_RUSTDESK_AUDIT_EXPORT_FILE is required');
  const externalId = requiredString(resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID'), 'CONVERACT_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID is required');
  const baseUrl = normalizeBaseUrl(optionalString(
    resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_FABRIC_BASE_URL') ||
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_BASE_URL') ||
    resolveBrandEnv(env, 'BASE_URL') ||
    resolveBrandEnv(env, 'COLLABORATION_BASE_URL')
  ), 'CONVERACT_RUSTDESK_AUDIT_EXPORT_BASE_URL, CONVERACT_RUSTDESK_FABRIC_BASE_URL, CONVERACT_BASE_URL, or CONVERACT_COLLABORATION_BASE_URL is required');
  const apiKey = requiredString(
    resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_API_KEY') ||
    resolveBrandEnv(env, 'RUSTDESK_FABRIC_API_KEY') ||
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_API_KEY') ||
    resolveBrandEnv(env, 'COLLABORATION_API_KEY') ||
    resolveBrandEnv(env, 'API_KEY'),
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_API_KEY, CONVERACT_RUSTDESK_FABRIC_API_KEY, CONVERACT_COLLABORATION_API_KEY, or CONVERACT_API_KEY is required'
  );
  const tenantId = requiredString(
    resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_TENANT_ID') ||
    resolveBrandEnv(env, 'RUSTDESK_FABRIC_TENANT_ID') ||
    resolveBrandEnv(env, 'RUSTDESK_IVEKIT_TENANT_ID') ||
    resolveBrandEnv(env, 'REMOTE_GATEWAY_TENANT_ID') ||
    resolveBrandEnv(env, 'RUSTDESK_EDGE_TENANT_ID') ||
    resolveBrandEnv(env, 'TENANT_ID'),
    'CONVERACT_RUSTDESK_AUDIT_EXPORT_TENANT_ID, CONVERACT_RUSTDESK_FABRIC_TENANT_ID, CONVERACT_REMOTE_GATEWAY_TENANT_ID, CONVERACT_RUSTDESK_EDGE_TENANT_ID, or CONVERACT_TENANT_ID is required'
  );
  const userId = optionalString(resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_USER_ID'));
  const since = optionalString(resolveBrandEnv(env, 'RUSTDESK_AUDIT_EXPORT_SINCE'));
  return {
    outputFile,
    externalId,
    baseUrl,
    apiKey,
    tenantId,
    ...(userId ? { userId } : {}),
    ...(since ? { since } : {})
  };
}

export async function writeRustDeskAuditExport(
  config: RustDeskAuditExportConfig,
  client: RustDeskAuditExportClient = createConveractFabricRustDeskHttpClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    userId: config.userId
  })
): Promise<RustDeskAuditExportResult> {
  const events = await client.listGatewayAuditEvents(config.externalId, config.since ? { since: config.since } : {});
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(
    config.outputFile,
    events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join('\n')}\n` : '',
    'utf8'
  );
  return {
    outputFile: config.outputFile,
    externalId: config.externalId,
    events: events.length,
    format: 'jsonl'
  };
}

function optionalString(value: unknown): string {
  return String(value || '').trim();
}

function requiredString(value: unknown, message: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(message);
  return normalized;
}

function normalizeBaseUrl(value: string, message: string): string {
  const raw = requiredString(value, message);
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CONVERACT_RUSTDESK_AUDIT_EXPORT_BASE_URL must use http(s)');
  }
  return parsed.toString().replace(/\/$/, '');
}

async function main(): Promise<void> {
  const result = await writeRustDeskAuditExport(createRustDeskAuditExportConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
