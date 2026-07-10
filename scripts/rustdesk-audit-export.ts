import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createIveKitRustDeskHttpClient,
  type IveKitRustDeskHttpClient
} from '../src/agent-runtime/ivekit/index.js';

export type RustDeskAuditExportClient = Pick<IveKitRustDeskHttpClient, 'listGatewayAuditEvents'>;

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
  const outputFile = requiredString(env.OPC_RUSTDESK_AUDIT_EXPORT_FILE, 'OPC_RUSTDESK_AUDIT_EXPORT_FILE is required');
  const externalId = requiredString(env.OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID, 'OPC_RUSTDESK_AUDIT_EXPORT_EXTERNAL_ID is required');
  const baseUrl = normalizeBaseUrl(optionalString(
    env.OPC_RUSTDESK_AUDIT_EXPORT_BASE_URL ||
    env.OPC_RUSTDESK_IVEKIT_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_COLLABORATION_BASE_URL
  ), 'OPC_RUSTDESK_AUDIT_EXPORT_BASE_URL, OPC_RUSTDESK_IVEKIT_BASE_URL, OPC_BASE_URL, or OPC_COLLABORATION_BASE_URL is required');
  const apiKey = requiredString(
    env.OPC_RUSTDESK_AUDIT_EXPORT_API_KEY ||
    env.OPC_RUSTDESK_IVEKIT_API_KEY ||
    env.OPC_COLLABORATION_API_KEY ||
    env.OPC_API_KEY,
    'OPC_RUSTDESK_AUDIT_EXPORT_API_KEY, OPC_RUSTDESK_IVEKIT_API_KEY, OPC_COLLABORATION_API_KEY, or OPC_API_KEY is required'
  );
  const tenantId = requiredString(
    env.OPC_RUSTDESK_AUDIT_EXPORT_TENANT_ID ||
    env.OPC_RUSTDESK_IVEKIT_TENANT_ID ||
    env.OPC_REMOTE_GATEWAY_TENANT_ID ||
    env.OPC_RUSTDESK_EDGE_TENANT_ID ||
    env.OPC_TENANT_ID,
    'OPC_RUSTDESK_AUDIT_EXPORT_TENANT_ID, OPC_RUSTDESK_IVEKIT_TENANT_ID, OPC_REMOTE_GATEWAY_TENANT_ID, OPC_RUSTDESK_EDGE_TENANT_ID, or OPC_TENANT_ID is required'
  );
  const userId = optionalString(env.OPC_RUSTDESK_AUDIT_EXPORT_USER_ID);
  const since = optionalString(env.OPC_RUSTDESK_AUDIT_EXPORT_SINCE);
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
  client: RustDeskAuditExportClient = createIveKitRustDeskHttpClient({
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
    throw new Error('OPC_RUSTDESK_AUDIT_EXPORT_BASE_URL must use http(s)');
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
