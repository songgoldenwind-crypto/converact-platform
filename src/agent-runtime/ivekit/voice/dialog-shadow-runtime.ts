import path from 'node:path';

import type { NodeConnectionOptions } from '@nats-io/transport-node';

import {
  resolveNatsConnectionOptions
} from '../../../infra/nats-connection-options.js';

export interface DialogShadowAgentConfig {
  production: boolean;
  host: string;
  port: number;
  identity: {
    cell_id: string;
    node_id: string;
    fault_domain: string;
  };
  service_token: string;
  journal: {
    path: string;
    max_records: number;
    max_bytes: number;
    max_record_bytes: number;
    compact_interval_ms: number;
  };
  server: {
    max_body_bytes: number;
    spiffe_trust_domain: string;
    tls: null | {
      key_file: string;
      cert_file: string;
      ca_file: string;
    };
  };
  recovery: {
    database_url: string;
    current_key: {
      key_id: string;
      key: Buffer;
    };
    previous_key: null | {
      key_id: string;
      key: Buffer;
    };
    token_ttl_ms: number;
    node_lease_ttl_ms: number;
    postgres_pool_max: number;
  };
  nats: {
    connection_options: NodeConnectionOptions;
    server_fault_domains: Record<string, string>;
    stream_name: string;
    subject_prefix: string;
    stream_replicas: 3 | 5;
    max_age_ms: number;
    placement_cluster: string;
    placement_tags: string[];
    ack_wait_ms: number;
    max_ack_pending: number;
    quorum_timeout_ms: number;
    required_fault_domains: number;
  };
}

export function loadDialogShadowAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => Buffer
): DialogShadowAgentConfig {
  const production = booleanEnv(
    env,
    'IVEKIT_DIALOG_SHADOW_PRODUCTION',
    true
  );
  const tokenFile = optionalAbsolutePath(
    env.IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN_FILE,
    'IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN_FILE'
  );
  const inlineToken = optionalString(
    env.IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN,
    'IVEKIT_DIALOG_SHADOW_SERVICE_TOKEN',
    512
  );
  if (production && inlineToken) {
    throw new Error('dialog shadow production inline service token is forbidden');
  }
  if (inlineToken && tokenFile) {
    throw new Error('dialog shadow service token sources are mutually exclusive');
  }
  const serviceToken = secret(
    inlineToken || (tokenFile ? readFile(tokenFile).toString('utf8').trim() : ''),
    'dialog shadow service token'
  );

  const tlsKeyFile = optionalAbsolutePath(
    env.IVEKIT_DIALOG_SHADOW_TLS_KEY_FILE,
    'IVEKIT_DIALOG_SHADOW_TLS_KEY_FILE'
  );
  const tlsCertFile = optionalAbsolutePath(
    env.IVEKIT_DIALOG_SHADOW_TLS_CERT_FILE,
    'IVEKIT_DIALOG_SHADOW_TLS_CERT_FILE'
  );
  const tlsCaFile = optionalAbsolutePath(
    env.IVEKIT_DIALOG_SHADOW_TLS_CA_FILE,
    'IVEKIT_DIALOG_SHADOW_TLS_CA_FILE'
  );
  const tlsCount = [tlsKeyFile, tlsCertFile, tlsCaFile].filter(Boolean).length;
  if (tlsCount !== 0 && tlsCount !== 3) {
    throw new Error('dialog shadow TLS key, certificate, and CA are required together');
  }
  if (production && tlsCount !== 3) {
    throw new Error('dialog shadow production mTLS is required');
  }

  const connectionOptions = resolveNatsConnectionOptions(env, {
    defaultName: `dialog-shadow-${requiredIdentifier(
      env.IVEKIT_DIALOG_SHADOW_NODE_ID,
      'IVEKIT_DIALOG_SHADOW_NODE_ID'
    )}`
  });
  if (!connectionOptions) throw new Error('dialog shadow NATS is required');
  if (production && connectionOptions.tls === null) {
    throw new Error('dialog shadow production NATS TLS is required');
  }

  const recoveryDatabaseUrl = secretFileOrInline({
    env,
    readFile,
    file_name: 'IVEKIT_DIALOG_RECOVERY_DATABASE_URL_FILE',
    inline_name: 'IVEKIT_DIALOG_RECOVERY_DATABASE_URL',
    production,
    production_inline_error:
      'dialog shadow production inline recovery database URL is forbidden',
    maximum: 4_096
  });
  const currentRecoveryKey = recoveryKey({
    env,
    readFile,
    id_name: 'IVEKIT_DIALOG_RECOVERY_CURRENT_KEY_ID',
    file_name: 'IVEKIT_DIALOG_RECOVERY_CURRENT_KEY_FILE',
    inline_name: 'IVEKIT_DIALOG_RECOVERY_CURRENT_KEY',
    production,
    required: true
  });
  const previousRecoveryKey = recoveryKey({
    env,
    readFile,
    id_name: 'IVEKIT_DIALOG_RECOVERY_PREVIOUS_KEY_ID',
    file_name: 'IVEKIT_DIALOG_RECOVERY_PREVIOUS_KEY_FILE',
    inline_name: 'IVEKIT_DIALOG_RECOVERY_PREVIOUS_KEY',
    production,
    required: false
  });
  if (previousRecoveryKey?.key_id === currentRecoveryKey!.key_id) {
    throw new Error('dialog recovery key ids must be distinct');
  }

  const faultDomainFile = optionalAbsolutePath(
    env.IVEKIT_DIALOG_SHADOW_NATS_SERVER_FAULT_DOMAINS_FILE,
    'IVEKIT_DIALOG_SHADOW_NATS_SERVER_FAULT_DOMAINS_FILE'
  );
  const inlineFaultDomains = optionalString(
    env.IVEKIT_DIALOG_SHADOW_NATS_SERVER_FAULT_DOMAINS,
    'IVEKIT_DIALOG_SHADOW_NATS_SERVER_FAULT_DOMAINS',
    16 * 1024
  );
  if (production && inlineFaultDomains) {
    throw new Error('dialog shadow production inline fault domains are forbidden');
  }
  if (faultDomainFile && inlineFaultDomains) {
    throw new Error('dialog shadow fault domain sources are mutually exclusive');
  }
  const faultDomainsSource = faultDomainFile
    ? readFile(faultDomainFile).toString('utf8')
    : inlineFaultDomains;
  const serverFaultDomains = parseFaultDomains(faultDomainsSource);
  const streamReplicas = integerEnv(
    env,
    'IVEKIT_DIALOG_SHADOW_NATS_STREAM_REPLICAS',
    3,
    3,
    5
  );
  if (streamReplicas !== 3 && streamReplicas !== 5) {
    throw new Error('IVEKIT_DIALOG_SHADOW_NATS_STREAM_REPLICAS must be 3 or 5');
  }

  return {
    production,
    host: host(env.IVEKIT_DIALOG_SHADOW_HOST || '127.0.0.1'),
    port: integerEnv(
      env,
      'IVEKIT_DIALOG_SHADOW_PORT',
      3_212,
      1,
      65_535
    ),
    identity: {
      cell_id: requiredIdentifier(
        env.IVEKIT_DIALOG_SHADOW_CELL_ID,
        'IVEKIT_DIALOG_SHADOW_CELL_ID'
      ),
      node_id: requiredIdentifier(
        env.IVEKIT_DIALOG_SHADOW_NODE_ID,
        'IVEKIT_DIALOG_SHADOW_NODE_ID'
      ),
      fault_domain: requiredIdentifier(
        env.IVEKIT_DIALOG_SHADOW_FAULT_DOMAIN,
        'IVEKIT_DIALOG_SHADOW_FAULT_DOMAIN'
      )
    },
    service_token: serviceToken,
    journal: {
      path: requiredAbsolutePath(
        env.IVEKIT_DIALOG_SHADOW_JOURNAL_PATH,
        'IVEKIT_DIALOG_SHADOW_JOURNAL_PATH'
      ),
      max_records: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_JOURNAL_MAX_RECORDS',
        1_000_000,
        1,
        10_000_000
      ),
      max_bytes: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_JOURNAL_MAX_BYTES',
        256 * 1024 * 1024,
        512,
        16 * 1024 * 1024 * 1024
      ),
      max_record_bytes: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_JOURNAL_MAX_RECORD_BYTES',
        32 * 1024,
        256,
        1024 * 1024
      ),
      compact_interval_ms: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_COMPACT_INTERVAL_MS',
        60_000,
        1_000,
        86_400_000
      )
    },
    server: {
      max_body_bytes: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_MAX_BODY_BYTES',
        128 * 1024,
        1024,
        1024 * 1024
      ),
      spiffe_trust_domain: trustDomain(
        env.IVEKIT_DIALOG_SHADOW_SPIFFE_TRUST_DOMAIN
      ),
      tls: tlsCount === 3 ? {
        key_file: tlsKeyFile!,
        cert_file: tlsCertFile!,
        ca_file: tlsCaFile!
      } : null
    },
    recovery: {
      database_url: postgresUrl(recoveryDatabaseUrl),
      current_key: currentRecoveryKey!,
      previous_key: previousRecoveryKey,
      token_ttl_ms: integerEnv(
        env,
        'IVEKIT_DIALOG_RECOVERY_TOKEN_TTL_MS',
        5_000,
        500,
        30_000
      ),
      node_lease_ttl_ms: integerEnv(
        env,
        'IVEKIT_DIALOG_RECOVERY_NODE_LEASE_TTL_MS',
        3_000,
        1_000,
        30_000
      ),
      postgres_pool_max: integerEnv(
        env,
        'IVEKIT_DIALOG_RECOVERY_POSTGRES_POOL_MAX',
        8,
        1,
        64
      )
    },
    nats: {
      connection_options: connectionOptions,
      server_fault_domains: serverFaultDomains,
      stream_name: streamName(
        env.IVEKIT_DIALOG_SHADOW_NATS_STREAM || 'IVEKIT_DIALOG_SHADOW'
      ),
      subject_prefix: subjectPrefix(
        env.IVEKIT_DIALOG_SHADOW_NATS_SUBJECT_PREFIX ||
          'ivekit.dialog_shadow'
      ),
      stream_replicas: streamReplicas,
      max_age_ms: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_NATS_MAX_AGE_MS',
        15 * 60 * 1000,
        60_000,
        86_400_000
      ),
      placement_cluster: requiredIdentifier(
        env.IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_CLUSTER,
        'IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_CLUSTER'
      ),
      placement_tags: list(
        env.IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_TAGS,
        'IVEKIT_DIALOG_SHADOW_NATS_PLACEMENT_TAGS'
      ),
      ack_wait_ms: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_NATS_ACK_WAIT_MS',
        2_000,
        250,
        60_000
      ),
      max_ack_pending: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_NATS_MAX_ACK_PENDING',
        256,
        1,
        10_000
      ),
      quorum_timeout_ms: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_QUORUM_TIMEOUT_MS',
        500,
        50,
        10_000
      ),
      required_fault_domains: integerEnv(
        env,
        'IVEKIT_DIALOG_SHADOW_REQUIRED_FAULT_DOMAINS',
        2,
        2,
        5
      )
    }
  };
}

function secretFileOrInline(input: {
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => Buffer;
  file_name: string;
  inline_name: string;
  production: boolean;
  production_inline_error: string;
  maximum: number;
}): string {
  const file = optionalAbsolutePath(input.env[input.file_name], input.file_name);
  const inline = optionalString(
    input.env[input.inline_name],
    input.inline_name,
    input.maximum
  );
  if (input.production && inline) {
    throw new Error(input.production_inline_error);
  }
  if (file && inline) {
    throw new Error(`${input.file_name} and ${input.inline_name} are mutually exclusive`);
  }
  const value = file
    ? input.readFile(file).toString('utf8').trim()
    : inline;
  if (!value || value.length > input.maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${input.inline_name} secret is invalid`);
  }
  return value;
}

function recoveryKey(input: {
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => Buffer;
  id_name: string;
  file_name: string;
  inline_name: string;
  production: boolean;
  required: boolean;
}): { key_id: string; key: Buffer } | null {
  const keyIdText = String(input.env[input.id_name] || '').trim();
  const file = optionalAbsolutePath(input.env[input.file_name], input.file_name);
  const inline = optionalString(
    input.env[input.inline_name],
    input.inline_name,
    128
  );
  if (input.production && inline) {
    throw new Error('dialog shadow production inline recovery key is forbidden');
  }
  if (file && inline) {
    throw new Error(`${input.file_name} and ${input.inline_name} are mutually exclusive`);
  }
  if (!keyIdText && !file && !inline && !input.required) return null;
  const keyId = requiredIdentifier(keyIdText, input.id_name);
  const encoded = file
    ? input.readFile(file).toString('utf8').trim()
    : inline;
  const key = Buffer.from(encoded, 'base64');
  if (!encoded ||
      key.byteLength !== 32 ||
      key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error(`${input.inline_name} must be a canonical 32-byte base64 key`);
  }
  return { key_id: keyId, key };
}

function postgresUrl(value: string): string {
  const result = new URL(value);
  if ((result.protocol !== 'postgresql:' && result.protocol !== 'postgres:') ||
      !result.hostname ||
      result.hash) {
    throw new Error('dialog recovery database URL is invalid');
  }
  return result.toString();
}

function parseFaultDomains(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('dialog shadow NATS fault domains are invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('dialog shadow NATS fault domains are invalid');
  }
  const entries = Object.entries(parsed);
  if (entries.length < 3 || entries.length > 64) {
    throw new Error('dialog shadow NATS fault domains require 3 to 64 servers');
  }
  const result: Record<string, string> = {};
  for (const [server, domain] of entries) {
    result[requiredIdentifier(server, 'NATS server')] =
      requiredIdentifier(domain, 'NATS fault domain');
  }
  if (new Set(Object.values(result)).size < 2) {
    throw new Error('dialog shadow NATS requires at least two fault domains');
  }
  return result;
}

function requiredIdentifier(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function requiredAbsolutePath(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!path.isAbsolute(result) || result.includes('\0')) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.normalize(result);
}

function optionalAbsolutePath(value: unknown, name: string): string {
  const result = String(value || '').trim();
  return result ? requiredAbsolutePath(result, name) : '';
}

function optionalString(
  value: unknown,
  name: string,
  maximum: number
): string {
  const result = String(value || '').trim();
  if (result.length > maximum || /[\0\r\n]/.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function secret(value: string, name: string): string {
  if (value.length < 24 || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function integerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = String(env[name] || '').trim();
  const result = raw ? Number(raw) : fallback;
  if (!Number.isSafeInteger(result) ||
      result < minimum ||
      result > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function booleanEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean
): boolean {
  const value = String(env[name] || '').trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

function host(value: string): string {
  const result = value.trim();
  if (!/^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|::1)$/.test(result)) {
    throw new Error('IVEKIT_DIALOG_SHADOW_HOST is invalid');
  }
  return result;
}

function trustDomain(value: unknown): string {
  const result = String(value || '').trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(result) ||
      result.includes('..')) {
    throw new Error('IVEKIT_DIALOG_SHADOW_SPIFFE_TRUST_DOMAIN is invalid');
  }
  return result;
}

function streamName(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) {
    throw new Error('IVEKIT_DIALOG_SHADOW_NATS_STREAM is invalid');
  }
  return value;
}

function subjectPrefix(value: string): string {
  if (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/.test(value)) {
    throw new Error('IVEKIT_DIALOG_SHADOW_NATS_SUBJECT_PREFIX is invalid');
  }
  return value;
}

function list(value: unknown, name: string): string[] {
  const result = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (result.length < 1 || result.length > 16 ||
      result.some((item) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item)) ||
      new Set(result).size !== result.length) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}
