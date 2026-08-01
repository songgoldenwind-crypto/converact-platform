import type { NodeConnectionOptions } from '@nats-io/transport-node';

export interface ResolveNatsConnectionOptionsDefaults {
  defaultName?: string;
}

export function resolveNatsConnectionOptions(
  env: NodeJS.ProcessEnv = process.env,
  defaults: ResolveNatsConnectionOptionsDefaults = {}
): NodeConnectionOptions | null {
  const rawServers = String(env.NATS_URL || '').trim();
  if (!rawServers) return null;
  const servers = rawServers.split(',').map((server) => server.trim()).filter(Boolean);
  if (servers.length === 0 || servers.length > 16) {
    throw new Error('NATS_URL must contain between 1 and 16 servers');
  }

  let tlsUrlCount = 0;
  for (const server of servers) {
    if (server.length > 512 || /[\r\n\0]/.test(server)) {
      throw new Error('NATS_URL contains an invalid server');
    }
    let parsed: URL;
    try {
      parsed = new URL(server);
    } catch {
      throw new Error('NATS_URL contains an invalid server');
    }
    if (parsed.protocol !== 'nats:' && parsed.protocol !== 'tls:') {
      throw new Error('NATS_URL servers must use nats:// or tls://');
    }
    if (parsed.username || parsed.password) {
      throw new Error('NATS_URL must not contain credentials');
    }
    if (!parsed.hostname || parsed.pathname || parsed.search || parsed.hash) {
      throw new Error('NATS_URL contains an invalid server');
    }
    if (parsed.protocol === 'tls:') tlsUrlCount += 1;
  }
  if (tlsUrlCount !== 0 && tlsUrlCount !== servers.length) {
    throw new Error('NATS_URL must not mix TLS and plaintext server URLs');
  }

  const user = optionalBounded(env.NATS_USER, 'NATS_USER', 256);
  const password = optionalBounded(env.NATS_PASSWORD, 'NATS_PASSWORD', 4096);
  const token = optionalBounded(env.NATS_TOKEN, 'NATS_TOKEN', 4096);
  if (Boolean(user) !== Boolean(password)) {
    throw new Error('NATS_USER and NATS_PASSWORD must be configured together');
  }
  if (token && (user || password)) {
    throw new Error('NATS token and username/password authentication are mutually exclusive');
  }

  const caFile = optionalAbsolutePath(env.NATS_TLS_CA_FILE, 'NATS_TLS_CA_FILE');
  const certFile = optionalAbsolutePath(env.NATS_TLS_CERT_FILE, 'NATS_TLS_CERT_FILE');
  const keyFile = optionalAbsolutePath(env.NATS_TLS_KEY_FILE, 'NATS_TLS_KEY_FILE');
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new Error('NATS TLS certificate and key files must be configured together');
  }
  const hasTlsFiles = Boolean(caFile || certFile || keyFile);
  const tlsMode = String(
    env.NATS_TLS_MODE || (tlsUrlCount > 0 || hasTlsFiles ? 'required' : 'disabled')
  ).trim();
  if (tlsMode !== 'required' && tlsMode !== 'disabled') {
    throw new Error('NATS_TLS_MODE must be required or disabled');
  }
  if (tlsUrlCount > 0 && tlsMode !== 'required') {
    throw new Error('TLS server URL requires NATS_TLS_MODE=required');
  }
  if (hasTlsFiles && tlsMode !== 'required') {
    throw new Error('NATS TLS files require NATS_TLS_MODE=required');
  }

  const defaultName = optionalBounded(
    defaults.defaultName,
    'NATS default connection name',
    256
  );
  return {
    servers,
    name: optionalBounded(env.NATS_CONNECTION_NAME, 'NATS_CONNECTION_NAME', 256) ||
      defaultName || 'converact-events',
    ...(user && password ? { user, pass: password } : {}),
    ...(token ? { token } : {}),
    timeout: boundedInteger(
      env.NATS_CONNECT_TIMEOUT_MS,
      5_000,
      250,
      60_000,
      'NATS_CONNECT_TIMEOUT_MS'
    ),
    maxReconnectAttempts: boundedInteger(
      env.NATS_MAX_RECONNECT_ATTEMPTS,
      -1,
      -1,
      1_000_000,
      'NATS_MAX_RECONNECT_ATTEMPTS'
    ),
    reconnectTimeWait: boundedInteger(
      env.NATS_RECONNECT_WAIT_MS,
      1_000,
      100,
      60_000,
      'NATS_RECONNECT_WAIT_MS'
    ),
    reconnectJitter: 250,
    reconnectJitterTLS: 1_000,
    ...(tlsMode === 'required'
      ? {
          tls: {
            rejectUnauthorized: true,
            ...(caFile ? { caFile } : {}),
            ...(certFile && keyFile ? { certFile, keyFile } : {})
          }
        }
      : { tls: null })
  };
}

function optionalBounded(
  value: string | undefined,
  field: string,
  maxLength: number
): string {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function optionalAbsolutePath(value: string | undefined, field: string): string {
  const normalized = optionalBounded(value, field, 1_024);
  if (normalized && !normalized.startsWith('/')) {
    throw new Error(`${field} must be an absolute path`);
  }
  return normalized;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}
