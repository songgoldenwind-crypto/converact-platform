import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import { canonicalVoicePayloadHash } from './canonical.js';
import { VoiceError } from './errors.js';
import type { VoiceExtensionSessionPort } from './http.js';
import type { VoiceExtension, VoiceExtensionSessionPlan } from './types.js';

export interface WebPhoneExtensionSessionConfig {
  websocket_url: string;
  sip_realm: string;
  jwt_secret: string;
  jwt_issuer: string;
  jwt_audience: string;
  ttl_seconds: number;
  register_expires_seconds: number;
  ice_servers: VoiceExtensionSessionPlan['ice_servers'];
}

interface WebPhoneSessionRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  actor: string;
  idempotency_key: string;
  request_hash: string;
  issued_at: string | Date;
  expires_at: string | Date;
}

interface WebPhoneSessionDependencies {
  now?: () => Date;
  id?: () => string;
}

export interface WebPhoneSessionCleanupConfig {
  enabled: boolean;
  interval_ms: number;
  tenant_limit: number;
  batch_size: number;
}

export interface WebPhoneSessionCleanupHandle {
  stop(): Promise<void>;
}

const MIN_SECRET_BYTES = 32;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 300;

export class PostgresWebPhoneExtensionSessionService implements VoiceExtensionSessionPort {
  readonly #config: WebPhoneExtensionSessionConfig;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(
    private readonly pg: PgQueryable,
    config: WebPhoneExtensionSessionConfig,
    dependencies: WebPhoneSessionDependencies = {}
  ) {
    this.#config = validateConfig(config);
    this.#now = dependencies.now ?? (() => new Date());
    this.#id = dependencies.id ?? randomUUID;
  }

  async create(input: {
    tenant_id: string;
    extension: VoiceExtension;
    actor: string;
    idempotency_key: string;
  }): Promise<VoiceExtensionSessionPlan> {
    const tenantId = boundedIdentifier(input.tenant_id, 'tenant_id');
    const actor = boundedIdentifier(input.actor, 'actor');
    const idempotencyKey = boundedIdentifier(input.idempotency_key, 'idempotency_key');
    assertExtension(input.extension, tenantId);

    const requestHash = canonicalVoicePayloadHash({
      tenant_id: tenantId,
      actor,
      extension: {
        id: input.extension.id,
        profile_id: input.extension.profile_id,
        identity: input.extension.identity,
        extension: input.extension.extension,
        display_name: input.extension.display_name,
        permissions: input.extension.permissions,
        webrtc_enabled: input.extension.webrtc_enabled,
        status: input.extension.status,
        revision: input.extension.revision
      },
      runtime: {
        websocket_url: this.#config.websocket_url,
        sip_realm: this.#config.sip_realm,
        jwt_issuer: this.#config.jwt_issuer,
        jwt_audience: this.#config.jwt_audience,
        ttl_seconds: this.#config.ttl_seconds,
        register_expires_seconds: this.#config.register_expires_seconds,
        ice_servers: this.#config.ice_servers,
        jwt_secret_fingerprint: createHash('sha256').update(this.#config.jwt_secret).digest('hex')
      }
    });
    const issuedAt = validNow(this.#now());
    const expiresAt = new Date(issuedAt.getTime() + this.#config.ttl_seconds * 1_000);
    const candidate: WebPhoneSessionRow = {
      id: boundedIdentifier(this.#id(), 'session_id'),
      tenant_id: tenantId,
      extension_id: input.extension.id,
      actor,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString()
    };

    const row = await withPgTenant(this.pg, tenantId, async (pg) => {
      const inserted = await pg.query<WebPhoneSessionRow>(
        `INSERT INTO ivekit_voice_extension_sessions
          (id, tenant_id, extension_id, actor, idempotency_key, request_hash, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id, tenant_id, extension_id, actor, idempotency_key,
                   request_hash, issued_at, expires_at`,
        [
          candidate.id, candidate.tenant_id, candidate.extension_id, candidate.actor,
          candidate.idempotency_key, candidate.request_hash, candidate.issued_at,
          candidate.expires_at
        ]
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const replay = await pg.query<WebPhoneSessionRow>(
        `SELECT id, tenant_id, extension_id, actor, idempotency_key,
                request_hash, issued_at, expires_at
         FROM ivekit_voice_extension_sessions
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, idempotencyKey]
      );
      if (!replay.rows[0]) throw conflict();
      return replay.rows[0];
    });

    const persistedExpiry = timestamp(row.expires_at);
    if (row.request_hash !== requestHash || row.extension_id !== input.extension.id
      || row.actor !== actor || persistedExpiry.getTime() <= issuedAt.getTime()) {
      throw conflict();
    }
    return createPlan(row, input.extension, this.#config);
  }
}

export function createConfiguredWebPhoneExtensionSessionService(
  pg: PgQueryable,
  env: NodeJS.ProcessEnv = process.env
): PostgresWebPhoneExtensionSessionService | undefined {
  if (!enabled(env.OPC_IVEKIT_WEBPHONE_ENABLED)) return undefined;
  return new PostgresWebPhoneExtensionSessionService(pg, {
    websocket_url: required(env, 'OPC_IVEKIT_WEBPHONE_WSS_URL'),
    sip_realm: required(env, 'OPC_IVEKIT_WEBPHONE_SIP_REALM'),
    jwt_secret: required(env, 'OPC_IVEKIT_WEBPHONE_JWT_SECRET'),
    jwt_issuer: required(env, 'OPC_IVEKIT_WEBPHONE_JWT_ISSUER'),
    jwt_audience: required(env, 'OPC_IVEKIT_WEBPHONE_JWT_AUDIENCE'),
    ttl_seconds: integer(env.OPC_IVEKIT_WEBPHONE_TTL_SECONDS, 300),
    register_expires_seconds: integer(env.OPC_IVEKIT_WEBPHONE_REGISTER_EXPIRES_SECONDS, 240),
    ice_servers: iceServers(env.OPC_IVEKIT_WEBPHONE_ICE_SERVERS_JSON || '[]')
  });
}

export function webPhoneSessionCleanupConfig(
  env: NodeJS.ProcessEnv = process.env
): WebPhoneSessionCleanupConfig {
  const webphoneEnabled = enabled(env.OPC_IVEKIT_WEBPHONE_ENABLED);
  const cleanupEnabled = env.OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_ENABLED === undefined
    ? webphoneEnabled
    : booleanFlag(
      env.OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_ENABLED,
      'OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_ENABLED'
    );
  if (cleanupEnabled && !webphoneEnabled) {
    throw new Error('WebPhone session cleanup cannot be enabled while WebPhone is disabled');
  }
  return {
    enabled: cleanupEnabled,
    interval_ms: boundedInteger(
      integer(env.OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_INTERVAL_MS, 60_000),
      'OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_INTERVAL_MS',
      1_000,
      3_600_000
    ),
    tenant_limit: boundedInteger(
      integer(env.OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_TENANT_LIMIT, 100),
      'OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_TENANT_LIMIT',
      1,
      1_000
    ),
    batch_size: boundedInteger(
      integer(env.OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_BATCH_SIZE, 500),
      'OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_BATCH_SIZE',
      1,
      5_000
    )
  };
}

export async function runWebPhoneSessionCleanupOnce(
  pg: PgQueryable,
  input: { tenant_limit: number; batch_size: number; now?: Date }
): Promise<{ tenants: number; deleted: number }> {
  const tenantLimit = boundedInteger(
    input.tenant_limit,
    'OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_TENANT_LIMIT',
    1,
    1_000
  );
  const batchSize = boundedInteger(
    input.batch_size,
    'OPC_IVEKIT_WEBPHONE_SESSION_CLEANUP_BATCH_SIZE',
    1,
    5_000
  );
  const now = validNow(input.now ?? new Date()).toISOString();
  const tenants = await pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_ivekit_webphone_session_tenant_ids($1, $2)',
    [now, tenantLimit]
  );
  let deleted = 0;
  for (const row of tenants.rows) {
    const tenantId = boundedIdentifier(row.tenant_id, 'tenant_id');
    deleted += await withPgTenant(pg, tenantId, async (tenantPg) => {
      const result = await tenantPg.query<{ id: string }>(
        `WITH expired AS (
           SELECT id
           FROM ivekit_voice_extension_sessions
           WHERE tenant_id = $1 AND expires_at <= $2
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $3
         )
         DELETE FROM ivekit_voice_extension_sessions AS session
         USING expired
         WHERE session.tenant_id = $1 AND session.id = expired.id
         RETURNING session.id`,
        [tenantId, now, batchSize]
      );
      return result.rowCount ?? result.rows.length;
    });
  }
  return { tenants: tenants.rows.length, deleted };
}

export function startWebPhoneSessionCleanupWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
}): WebPhoneSessionCleanupHandle {
  const config = webPhoneSessionCleanupConfig(input.env);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<unknown> | null = null;
  let stopped = !config.enabled;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      active = runWebPhoneSessionCleanupOnce(input.pg, {
        tenant_limit: config.tenant_limit,
        batch_size: config.batch_size
      }).catch((error) => {
        console.error(
          '[webphone-session-cleanup] worker failed:',
          error instanceof Error ? error.message.slice(0, 500) : 'unknown error'
        );
      }).finally(() => {
        active = null;
        schedule(config.interval_ms);
      });
    }, delay);
    timer.unref?.();
  };
  schedule(0);
  let stopPromise: Promise<void> | null = null;
  return {
    stop() {
      if (!stopPromise) {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        stopPromise = Promise.resolve(active).then(() => undefined);
      }
      return stopPromise;
    }
  };
}

function createPlan(
  row: WebPhoneSessionRow,
  extension: VoiceExtension,
  config: WebPhoneExtensionSessionConfig
): VoiceExtensionSessionPlan {
  const issuedAt = timestamp(row.issued_at);
  const expiresAt = timestamp(row.expires_at);
  const token = signJwt({
    aud: config.jwt_audience,
    exp: Math.floor(expiresAt.getTime() / 1_000),
    extension_id: extension.id,
    iat: Math.floor(issuedAt.getTime() / 1_000),
    iss: config.jwt_issuer,
    jti: row.id,
    profile_id: extension.profile_id,
    scope: 'sip:webphone',
    sub: extension.extension,
    tenant_id: row.tenant_id
  }, config.jwt_secret);
  const websocket = new URL(config.websocket_url);
  websocket.searchParams.set('token', token);
  return {
    session_id: row.id,
    extension_id: extension.id,
    transport: 'wss',
    websocket_url: websocket.toString(),
    address_of_record: `sip:${extension.extension}@${config.sip_realm}`,
    authorization_username: extension.extension,
    authorization_password: createHmac('sha256', config.jwt_secret)
      .update(`sip-password\u0000${row.tenant_id}\u0000${extension.id}\u0000${row.id}`)
      .digest('base64url'),
    ...(extension.display_name ? { display_name: extension.display_name } : {}),
    expires_at: expiresAt.toISOString(),
    register_expires_seconds: config.register_expires_seconds,
    ice_servers: structuredClone(config.ice_servers),
    capabilities: capabilities(extension.permissions)
  };
}

function signJwt(claims: Record<string, unknown>, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const body = `${header}.${payload}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

function validateConfig(input: WebPhoneExtensionSessionConfig): WebPhoneExtensionSessionConfig {
  const websocket = secureWebsocketUrl(input.websocket_url);
  const realm = sipRealm(input.sip_realm);
  const secret = String(input.jwt_secret || '');
  if (Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES || secret.length > 4_096
    || /[\r\n]/.test(secret)) {
    throw new Error(`OPC_IVEKIT_WEBPHONE_JWT_SECRET must be ${MIN_SECRET_BYTES}-4096 bytes`);
  }
  const ttl = boundedInteger(input.ttl_seconds, 'OPC_IVEKIT_WEBPHONE_TTL_SECONDS', MIN_TTL_SECONDS, MAX_TTL_SECONDS);
  const register = boundedInteger(
    input.register_expires_seconds,
    'OPC_IVEKIT_WEBPHONE_REGISTER_EXPIRES_SECONDS',
    MIN_TTL_SECONDS,
    ttl - 5
  );
  return {
    websocket_url: websocket,
    sip_realm: realm,
    jwt_secret: secret,
    jwt_issuer: boundedText(input.jwt_issuer, 'OPC_IVEKIT_WEBPHONE_JWT_ISSUER', 200),
    jwt_audience: boundedText(input.jwt_audience, 'OPC_IVEKIT_WEBPHONE_JWT_AUDIENCE', 200),
    ttl_seconds: ttl,
    register_expires_seconds: register,
    ice_servers: validateIceServers(input.ice_servers)
  };
}

function secureWebsocketUrl(value: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error('OPC_IVEKIT_WEBPHONE_WSS_URL must be a valid WSS URL');
  }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash
    || parsed.search || !parsed.hostname || parsed.toString().length > 2_048) {
    throw new Error('OPC_IVEKIT_WEBPHONE_WSS_URL must be a credential-free WSS URL without query or hash');
  }
  return parsed.toString();
}

function sipRealm(value: unknown): string {
  const realm = String(value || '').trim().toLowerCase();
  if (realm.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(realm)
    || realm.includes('..')) {
    throw new Error('OPC_IVEKIT_WEBPHONE_SIP_REALM must be a valid SIP hostname');
  }
  return realm;
}

function iceServers(value: string): VoiceExtensionSessionPlan['ice_servers'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OPC_IVEKIT_WEBPHONE_ICE_SERVERS_JSON must be valid ICE JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('OPC_IVEKIT_WEBPHONE_ICE_SERVERS_JSON must be an ICE array');
  return validateIceServers(parsed as VoiceExtensionSessionPlan['ice_servers']);
}

function validateIceServers(
  input: VoiceExtensionSessionPlan['ice_servers']
): VoiceExtensionSessionPlan['ice_servers'] {
  if (!Array.isArray(input) || input.length > 8) throw new Error('WebPhone ICE servers must contain at most 8 entries');
  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('WebPhone ICE server is invalid');
    const urls = Array.isArray(entry.urls)
      ? entry.urls.map(iceUrl)
      : iceUrl(entry.urls);
    if (Array.isArray(urls) && (urls.length < 1 || urls.length > 8)) {
      throw new Error('WebPhone ICE URL list must contain 1-8 entries');
    }
    return {
      urls,
      ...(entry.username === undefined ? {} : {
        username: boundedText(entry.username, 'WebPhone ICE username', 256)
      }),
      ...(entry.credential === undefined ? {} : {
        credential: boundedText(entry.credential, 'WebPhone ICE credential', 512)
      })
    };
  });
}

function iceUrl(value: unknown): string {
  const url = String(value || '').trim();
  if (url.length > 1_024 || /\s|@/.test(url)
    || !/^(?:stun|stuns|turn|turns):[^?#]+(?:\?transport=(?:udp|tcp))?$/i.test(url)) {
    throw new Error('WebPhone ICE URL must use STUN or TURN');
  }
  return url;
}

function capabilities(permissions: Record<string, unknown>): VoiceExtensionSessionPlan['capabilities'] {
  return {
    incoming: permission(permissions, 'incoming', true),
    outgoing: permission(permissions, 'outgoing', permission(permissions, 'outbound', false)),
    dtmf: permission(permissions, 'dtmf', true),
    hold: permission(permissions, 'hold', true),
    transfer: permission(permissions, 'transfer', false),
    audio_input: permission(permissions, 'audio_input', true),
    audio_output: permission(permissions, 'audio_output', true)
  };
}

function permission(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  if (input[key] === undefined) return fallback;
  if (typeof input[key] !== 'boolean') throw validationError(`${key} permission must be boolean`);
  return input[key];
}

function assertExtension(extension: VoiceExtension, tenantId: string): void {
  if (!extension || extension.tenant_id !== tenantId || extension.status !== 'active'
    || !extension.webrtc_enabled || !/^\d{1,20}$/.test(extension.extension)
    || !extension.id || !extension.profile_id) {
    throw validationError('extension is not eligible for WebPhone');
  }
}

function boundedIdentifier(value: unknown, field: string): string {
  return boundedText(value, field, 200);
}

function boundedText(value: unknown, field: string, max: number): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000\r\n]/.test(text)) throw validationError(`${field} is invalid`);
  return text;
}

function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function integer(value: unknown, fallback: number): number {
  return value === undefined || value === '' ? fallback : Number(value);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function enabled(value: unknown): boolean {
  if (value === undefined || value === '') return false;
  return booleanFlag(value, 'OPC_IVEKIT_WEBPHONE_ENABLED');
}

function booleanFlag(value: unknown, field: string): boolean {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '0' || normalized === 'false') return false;
  if (normalized === '1' || normalized === 'true') return true;
  throw new Error(`${field} must be 0 or 1`);
}

function validNow(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('WebPhone session clock is invalid');
  }
  return value;
}

function timestamp(value: string | Date): Date {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new VoiceError({ code: 'protocol_mismatch', status: 500 });
  return parsed;
}

function conflict(): VoiceError {
  return new VoiceError({ code: 'idempotency_conflict', status: 409 });
}

function validationError(message: string): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 400, message });
}
