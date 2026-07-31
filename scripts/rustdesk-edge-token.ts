import { resolveBrandEnv } from '../src/config/converact-env.js';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRustDeskEdgeCommandToken } from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';

export interface RustDeskEdgeTokenFileConfig {
  secret: string;
  tenantId: string;
  rustdeskId: string;
  edgeInstanceId: string;
  ttlMs: number;
  now: string;
  outputFile: string;
}

export interface RustDeskEdgeTokenFileWriteResult {
  outputFile: string;
  tenantId: string;
  rustdeskId: string;
  edgeInstanceId: string;
  expiresAt: string;
}

export function createRustDeskEdgeTokenFileConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskEdgeTokenFileConfig {
  return {
    secret: required(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_SECRET'), 'CONVERACT_RUSTDESK_EDGE_TOKEN_SECRET is required'),
    tenantId: required(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_TENANT_ID'), 'CONVERACT_RUSTDESK_EDGE_TOKEN_TENANT_ID is required'),
    rustdeskId: required(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_RUSTDESK_ID'), 'CONVERACT_RUSTDESK_EDGE_TOKEN_RUSTDESK_ID is required'),
    edgeInstanceId: required(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_INSTANCE_ID'), 'CONVERACT_RUSTDESK_EDGE_TOKEN_INSTANCE_ID is required'),
    ttlMs: positiveInteger(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_TTL_MS'), 30 * 24 * 60 * 60 * 1_000),
    now: timestamp(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_NOW') || new Date().toISOString()),
    outputFile: required(resolveBrandEnv(env, 'RUSTDESK_EDGE_TOKEN_OUTPUT_FILE'), 'CONVERACT_RUSTDESK_EDGE_TOKEN_OUTPUT_FILE is required')
  };
}

export function writeRustDeskEdgeTokenFile(
  config: RustDeskEdgeTokenFileConfig
): RustDeskEdgeTokenFileWriteResult {
  const expiresAt = new Date(new Date(config.now).getTime() + config.ttlMs).toISOString();
  const token = createRustDeskEdgeCommandToken({
    tenant_id: config.tenantId,
    rustdesk_id: config.rustdeskId,
    edge_instance_id: config.edgeInstanceId,
    issued_at: config.now,
    expires_at: expiresAt
  }, config.secret);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(config.outputFile, 0o600);
  return {
    outputFile: config.outputFile,
    tenantId: config.tenantId,
    rustdeskId: config.rustdeskId,
    edgeInstanceId: config.edgeInstanceId,
    expiresAt
  };
}

function required(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function positiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 60_000 || number > 365 * 24 * 60 * 60 * 1_000) {
    throw new Error('CONVERACT_RUSTDESK_EDGE_TOKEN_TTL_MS must be an integer from 60000 to 31536000000');
  }
  return number;
}

function timestamp(value: unknown): string {
  const normalized = String(value || '').trim();
  const milliseconds = new Date(normalized).getTime();
  if (!normalized || Number.isNaN(milliseconds)) {
    throw new Error('CONVERACT_RUSTDESK_EDGE_TOKEN_NOW must be an ISO timestamp');
  }
  return new Date(milliseconds).toISOString();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(
      writeRustDeskEdgeTokenFile(createRustDeskEdgeTokenFileConfigFromEnv(process.env)),
      null,
      2
    ));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
