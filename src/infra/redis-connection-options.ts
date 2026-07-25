import { readFileSync } from 'node:fs';

export interface RedisTlsFileOptions {
  rejectUnauthorized: true;
  serverName?: string;
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}

interface RedisConnectionBase {
  username?: string;
  password?: string;
  connectTimeoutMs: number;
  reconnectWaitMs: number;
  maxReconnectAttempts: number;
  tls: RedisTlsFileOptions | null;
}

export interface DirectRedisConnectionOptions extends RedisConnectionBase {
  topology: 'direct';
  url: string;
}

export interface SentinelRedisConnectionOptions extends RedisConnectionBase {
  topology: 'sentinel';
  masterName: string;
  sentinels: Array<{ host: string; port: number }>;
  sentinelUsername?: string;
  sentinelPassword?: string;
}

export type ResolvedRedisConnectionOptions =
  | DirectRedisConnectionOptions
  | SentinelRedisConnectionOptions;

interface IoRedisTlsOptions {
  rejectUnauthorized: true;
  servername?: string;
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
}

export interface IoRedisConnectionOptions {
  lazyConnect: true;
  maxRetriesPerRequest: number;
  connectTimeout: number;
  username?: string;
  password?: string;
  retryStrategy: (attempt: number) => number | null;
  tls?: IoRedisTlsOptions;
  sentinels?: Array<{ host: string; port: number }>;
  name?: string;
  sentinelUsername?: string;
  sentinelPassword?: string;
  sentinelRetryStrategy?: (attempt: number) => number | null;
  sentinelTLS?: IoRedisTlsOptions;
  role?: 'master';
  enableReadyCheck?: true;
}

export type IoRedisConstructorArgs =
  | [url: string, options: IoRedisConnectionOptions]
  | [options: IoRedisConnectionOptions];

export function buildIoRedisConstructorArgs(
  config: ResolvedRedisConnectionOptions,
  dependencies: { readFile(path: string): string | Buffer } = {
    readFile: (path) => readFileSync(path)
  }
): IoRedisConstructorArgs {
  const retryStrategy = createRetryStrategy(
    config.reconnectWaitMs,
    config.maxReconnectAttempts
  );
  const tls = config.tls
    ? {
        rejectUnauthorized: true as const,
        ...(config.tls.serverName ? { servername: config.tls.serverName } : {}),
        ...(config.tls.caFile ? { ca: dependencies.readFile(config.tls.caFile) } : {}),
        ...(config.tls.certFile ? { cert: dependencies.readFile(config.tls.certFile) } : {}),
        ...(config.tls.keyFile ? { key: dependencies.readFile(config.tls.keyFile) } : {})
      }
    : undefined;
  const common: IoRedisConnectionOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: config.connectTimeoutMs,
    ...(config.username && config.password
      ? { username: config.username, password: config.password }
      : {}),
    retryStrategy,
    ...(tls ? { tls } : {})
  };

  if (config.topology === 'direct') return [config.url, common];
  return [
    {
      ...common,
      sentinels: config.sentinels,
      name: config.masterName,
      ...(config.sentinelUsername && config.sentinelPassword
        ? {
            sentinelUsername: config.sentinelUsername,
            sentinelPassword: config.sentinelPassword
          }
        : {}),
      sentinelRetryStrategy: retryStrategy,
      ...(tls ? { sentinelTLS: tls } : {}),
      role: 'master',
      enableReadyCheck: true
    }
  ];
}

export function resolveRedisConnectionOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): ResolvedRedisConnectionOptions {
  const topology = String(env.REDIS_TOPOLOGY || 'direct').trim();
  if (topology !== 'direct' && topology !== 'sentinel') {
    throw new Error('REDIS_TOPOLOGY must be direct or sentinel');
  }

  const username = optionalBounded(env.REDIS_USERNAME, 'REDIS_USERNAME', 256);
  const password = optionalBounded(env.REDIS_PASSWORD, 'REDIS_PASSWORD', 4096);
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('REDIS_USERNAME and REDIS_PASSWORD must be configured together');
  }

  const sentinelUsername = optionalBounded(
    env.REDIS_SENTINEL_USERNAME,
    'REDIS_SENTINEL_USERNAME',
    256
  );
  const sentinelPassword = optionalBounded(
    env.REDIS_SENTINEL_PASSWORD,
    'REDIS_SENTINEL_PASSWORD',
    4096
  );
  if (Boolean(sentinelUsername) !== Boolean(sentinelPassword)) {
    throw new Error(
      'REDIS_SENTINEL_USERNAME and REDIS_SENTINEL_PASSWORD must be configured together'
    );
  }

  const rawUrl = String(env.REDIS_URL || '').trim();
  const tls = resolveTlsOptions(env, rawUrl);
  const base = {
    ...(username && password ? { username, password } : {}),
    connectTimeoutMs: boundedInteger(
      env.REDIS_CONNECT_TIMEOUT_MS,
      5_000,
      250,
      60_000,
      'REDIS_CONNECT_TIMEOUT_MS'
    ),
    reconnectWaitMs: boundedInteger(
      env.REDIS_RECONNECT_WAIT_MS,
      1_000,
      100,
      60_000,
      'REDIS_RECONNECT_WAIT_MS'
    ),
    maxReconnectAttempts: boundedInteger(
      env.REDIS_MAX_RECONNECT_ATTEMPTS,
      -1,
      -1,
      1_000_000,
      'REDIS_MAX_RECONNECT_ATTEMPTS'
    ),
    tls
  };

  if (topology === 'direct') {
    rejectSentinelFields(env);
    const url = validateDirectUrl(rawUrl || 'redis://localhost:6379');
    if (url.startsWith('rediss://') && !tls) {
      throw new Error('rediss:// requires REDIS_TLS_MODE=required');
    }
    return { topology, url, ...base };
  }

  if (rawUrl) throw new Error('REDIS_URL must be empty in sentinel topology');
  const masterName = requiredMasterName(env.REDIS_SENTINEL_MASTER_NAME);
  const sentinels = parseSentinels(env.REDIS_SENTINEL_ADDRESSES);
  return {
    topology,
    masterName,
    sentinels,
    ...(sentinelUsername && sentinelPassword
      ? { sentinelUsername, sentinelPassword }
      : {}),
    ...base
  };
}

function validateDirectUrl(value: string): string {
  if (value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error('REDIS_URL contains an invalid endpoint');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('REDIS_URL contains an invalid endpoint');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  if (parsed.username || parsed.password) {
    throw new Error('REDIS_URL must not contain credentials');
  }
  if (!parsed.hostname || parsed.pathname || parsed.search || parsed.hash) {
    throw new Error('REDIS_URL contains an invalid endpoint');
  }
  return value;
}

function rejectSentinelFields(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
  for (const field of [
    'REDIS_SENTINEL_MASTER_NAME',
    'REDIS_SENTINEL_ADDRESSES',
    'REDIS_SENTINEL_USERNAME',
    'REDIS_SENTINEL_PASSWORD'
  ]) {
    if (String(env[field] || '').trim()) {
      throw new Error(`${field} requires REDIS_TOPOLOGY=sentinel`);
    }
  }
}

function requiredMasterName(value: string | undefined): string {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) {
    throw new Error(
      'REDIS_SENTINEL_MASTER_NAME must contain 1-128 letters, digits, dot, underscore or dash characters'
    );
  }
  return name;
}

function parseSentinels(value: string | undefined): Array<{ host: string; port: number }> {
  const entries = String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const parsed: Array<{ host: string; port: number }> = [];
  const unique = new Set<string>();
  try {
    for (const entry of entries) {
      if (entry.length > 512 || /[\r\n\0/?#@]/.test(entry)) throw new Error('invalid');
      const endpoint = new URL(`redis://${entry}`);
      if (
        endpoint.protocol !== 'redis:' ||
        endpoint.username ||
        endpoint.password ||
        !endpoint.hostname ||
        !endpoint.port ||
        endpoint.pathname ||
        endpoint.search ||
        endpoint.hash
      ) {
        throw new Error('invalid');
      }
      const port = Number(endpoint.port);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid');
      const key = `${endpoint.hostname.toLowerCase()}:${port}`;
      if (unique.has(key)) throw new Error('duplicate');
      unique.add(key);
      parsed.push({ host: endpoint.hostname, port });
    }
  } catch {
    throw new Error('REDIS_SENTINEL_ADDRESSES must contain exactly three unique host:port entries');
  }
  if (parsed.length !== 3) {
    throw new Error('REDIS_SENTINEL_ADDRESSES must contain exactly three unique host:port entries');
  }
  return parsed;
}

function resolveTlsOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  rawUrl: string
): RedisTlsFileOptions | null {
  const caFile = optionalAbsolutePath(env.REDIS_TLS_CA_FILE, 'REDIS_TLS_CA_FILE');
  const certFile = optionalAbsolutePath(env.REDIS_TLS_CERT_FILE, 'REDIS_TLS_CERT_FILE');
  const keyFile = optionalAbsolutePath(env.REDIS_TLS_KEY_FILE, 'REDIS_TLS_KEY_FILE');
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('Redis TLS certificate and key files must be configured together');
  }
  const serverName = optionalBounded(env.REDIS_TLS_SERVER_NAME, 'REDIS_TLS_SERVER_NAME', 253);
  const hasTlsInput = Boolean(caFile || certFile || keyFile || serverName || rawUrl.startsWith('rediss://'));
  const mode = String(env.REDIS_TLS_MODE || (hasTlsInput ? 'required' : 'disabled')).trim();
  if (mode !== 'required' && mode !== 'disabled') {
    throw new Error('REDIS_TLS_MODE must be required or disabled');
  }
  if (mode === 'disabled' && (caFile || certFile || keyFile || serverName)) {
    throw new Error('Redis TLS files require REDIS_TLS_MODE=required');
  }
  if (mode === 'disabled') return null;
  return {
    rejectUnauthorized: true,
    ...(serverName ? { serverName } : {}),
    ...(caFile ? { caFile } : {}),
    ...(certFile && keyFile ? { certFile, keyFile } : {})
  };
}

function optionalBounded(
  value: string | undefined,
  field: string,
  maxLength: number
): string | undefined {
  const normalized = String(value || '').trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function optionalAbsolutePath(
  value: string | undefined,
  field: string
): string | undefined {
  const normalized = optionalBounded(value, field, 4096);
  if (!normalized) return undefined;
  if (!normalized.startsWith('/') || normalized.includes('/../') || normalized.endsWith('/..')) {
    throw new Error(`${field} must be an absolute path without parent traversal`);
  }
  return normalized;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  const normalized = String(value ?? '').trim();
  if (!normalized) return fallback;
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function createRetryStrategy(
  waitMs: number,
  maxReconnectAttempts: number
): (attempt: number) => number | null {
  return (attempt) => {
    if (maxReconnectAttempts >= 0 && attempt > maxReconnectAttempts) return null;
    return waitMs;
  };
}
