import { resolveBrandEnv } from '../config/converact-env.js';
import { evaluatePlatformAccess, type PlatformIdentityClaims } from '../agent-runtime/converact/platform-foundation/identity.js';
import { createHmac, createVerify, randomUUID, timingSafeEqual } from 'node:crypto';

export type AuthRole = 'owner' | 'admin' | 'operator' | 'viewer' | 'system';

export interface AuthContext {
  tenantId: string;
  userId: string;
  role: AuthRole;
  authenticated: boolean;
  expiresAt?: number;
}

export interface AccessTokenPayload {
  sub: string;
  tid: string;
  tenant_id: string;
  identity_id: string;
  identity_kind: 'human';
  session_id: string;
  token_id: string;
  iss: string;
  issuer: string;
  aud: string[];
  audience: string[];
  key_id: string;
  role: AuthRole;
  iat: number;
  nbf: number;
  exp: number;
  issued_at: string;
  not_before: string;
  expires_at: string;
  policy_version: number;
  revocation_epoch: number;
  capabilities: string[];
  purpose: string[];
  credential_strength: 'signed_token';
}

const VALID_ROLES: Set<string> = new Set(['owner', 'admin', 'operator', 'viewer', 'system']);
const DEFAULT_TOKEN_TTL_SEC = 86_400;
const DEFAULT_AUTH_ISSUER = 'converact://local-identity';
const DEFAULT_AUTH_AUDIENCE = 'converact-core';
const DEFAULT_AUTH_KEY_ID = 'local-hs256-v1';
const PLATFORM_API_CAPABILITY = 'platform.api';
const PRODUCT_OPERATION_PURPOSE = 'product_operation';

/**
 * Resolve authentication context from HTTP headers.
 *
 * Priority:
 * 1. Non-production X-API-Key (development system context)
 * 2. Bearer JWT (CONVERACT_JWT_SECRET HS256, or CONVERACT_AUTH_ISSUER RS256 JWKS)
 * 3. Dev headers in non-production only
 */
export function resolveAuthContext(headers: Record<string, string | string[] | undefined>): AuthContext {
  const authDisabled = resolveBrandEnv(process.env, 'AUTH_DISABLED') === '1';
  const apiKey = header(headers, 'X-API-Key') || header(headers, 'x-api-key');
  const expectedKey = resolveBrandEnv(process.env, 'API_KEY');
  if (process.env.NODE_ENV !== 'production'
    && authDisabled
    && apiKey && expectedKey && apiKey === expectedKey) {
    return {
      tenantId: header(headers, 'X-Tenant-Id') || header(headers, 'x-tenant-id') || 'system',
      userId: 'system',
      role: 'system',
      authenticated: true
    };
  }

  const authorization = header(headers, 'Authorization') || header(headers, 'authorization');
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7);
    const algorithm = jwtAlgorithm(token);
    if (algorithm === 'HS256') {
      const jwtSecret = resolveBrandEnv(process.env, 'JWT_SECRET');
      if (jwtSecret) return resolveHs256Context(token, jwtSecret);
    } else if (algorithm === 'RS256') {
      const issuer = resolveBrandEnv(process.env, 'AUTH_ISSUER');
      if (issuer) return resolveJwtContext(headers, issuer, token);
    }
    throw unauthorizedToken('token algorithm is not configured');
  }

  if (process.env.NODE_ENV !== 'production' && authDisabled) {
    return resolveDevContext(headers);
  }

  throw Object.assign(new Error('missing or invalid Authorization header'), { status: 401 });
}

function header(headers: Record<string, string | string[] | undefined>, key: string): string {
  const v = headers[key] ?? headers[key.toLowerCase()];
  if (Array.isArray(v)) return v[0] || '';
  return v || '';
}

function resolveDevContext(headers: Record<string, string | string[] | undefined>): AuthContext {
  const tenantId = header(headers, 'X-Tenant-Id') || header(headers, 'x-tenant-id');
  const userId = header(headers, 'X-User-Id') || header(headers, 'x-user-id');
  const rawRole = header(headers, 'X-Role') || header(headers, 'x-role');
  if (rawRole && !VALID_ROLES.has(rawRole)) {
    throw Object.assign(new Error('invalid development role'), { status: 401 });
  }
  const role: AuthRole = rawRole ? rawRole as AuthRole : 'operator';

  if (tenantId && userId) {
    return { tenantId, userId, role, authenticated: false };
  }

  if (tenantId) {
    return { tenantId, userId: 'anonymous', role: 'viewer', authenticated: false };
  }

  return { tenantId: '', userId: '', role: 'viewer', authenticated: false };
}

function resolveHs256Context(token: string, secret: string): AuthContext {
  const payload = verifyHs256Jwt(token, secret);
  const tenantId = payload.tid;
  if (!tenantId || !payload.sub) {
    throw Object.assign(new Error('invalid token payload'), { status: 401 });
  }
  return {
    tenantId: String(tenantId),
    userId: String(payload.sub),
    role: payload.role,
    authenticated: true,
    expiresAt: payload.exp
  };
}

export function signAccessToken(
  payload: { sub: string; tid: string; role: AuthRole },
  ttlSec: number = DEFAULT_TOKEN_TTL_SEC
): string {
  const secret = resolveBrandEnv(process.env, 'JWT_SECRET');
  if (!secret) {
    throw Object.assign(new Error('CONVERACT_JWT_SECRET is not configured'), { status: 503 });
  }
  if (!payload.sub.trim() || !payload.tid.trim() || !VALID_ROLES.has(payload.role)) {
    throw Object.assign(new Error('invalid access token identity'), { status: 400 });
  }
  if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) {
    throw Object.assign(new Error('access token ttl must be a positive integer'), { status: 400 });
  }
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlSec;
  const issuer = configuredLocalTokenIssuer();
  const audience = configuredAuthAudience();
  const body: AccessTokenPayload = {
    sub: payload.sub,
    tid: payload.tid,
    tenant_id: payload.tid,
    identity_id: payload.sub,
    identity_kind: 'human',
    session_id: randomUUID(),
    token_id: randomUUID(),
    iss: issuer,
    issuer,
    aud: [audience],
    audience: [audience],
    key_id: configuredAuthKeyId(),
    role: payload.role,
    iat: now,
    nbf: now,
    exp: expiresAt,
    issued_at: epochToIso(now),
    not_before: epochToIso(now),
    expires_at: epochToIso(expiresAt),
    policy_version: configuredPolicyVersion(),
    revocation_epoch: configuredRevocationEpoch(),
    capabilities: [PLATFORM_API_CAPABILITY],
    purpose: [PRODUCT_OPERATION_PURPOSE],
    credential_strength: 'signed_token'
  };
  return signHs256Jwt(body, secret);
}

/**
 * Verify Bearer token for WebSocket connections (?token=).
 */
export function verifyAccessToken(token: string | null | undefined): AuthContext | null {
  if (!token) return null;
  const secret = resolveBrandEnv(process.env, 'JWT_SECRET');
  if (!secret) return null;
  try {
    return resolveHs256Context(token, secret);
  } catch {
    return null;
  }
}

function resolveJwtContext(
  headers: Record<string, string | string[] | undefined>,
  issuer: string,
  token?: string
): AuthContext {
  const authorization = header(headers, 'Authorization') || header(headers, 'authorization');
  const bearer = token ?? (authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  if (!bearer) {
    throw Object.assign(new Error('missing or invalid Authorization header'), { status: 401 });
  }

  const payload = verifyJwt(bearer, issuer);

  const tenantId = payload.tenant_id;
  if (!tenantId) {
    throw Object.assign(new Error('signed tenant claim required'), { status: 403 });
  }
  const userId = payload.sub || payload.user_id || '';
  if (!userId) {
    throw Object.assign(new Error('signed user claim required'), { status: 403 });
  }

  return {
    tenantId,
    userId,
    role: payload.role,
    authenticated: true,
    expiresAt: payload.exp
  };
}

// --- JWT verification with native crypto (RS256 + JWKS) ---

type JwtPayload = AccessTokenPayload & { user_id?: string };

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  use?: string;
  alg?: string;
}

export interface AuthJwksLifecycleScheduler {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AuthJwksLifecycle {
  refreshNow(): Promise<void>;
  stop(): void;
}

const jwksCache = new Map<string, { keys: JwksKey[]; refreshedAtMonotonicMs: number }>();
const jwksRefreshes = new Map<string, Promise<JwksKey[]>>();
const jwksLastRefreshAttempt = new Map<string, number>();
const JWKS_CACHE_TTL_MS = 300_000;
const JWKS_DEFAULT_REFRESH_INTERVAL_MS = 120_000;
const JWKS_MIN_REFRESH_INTERVAL_MS = 1_000;
const JWKS_ON_DEMAND_REFRESH_FLOOR_MS = 5_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const JWKS_MAX_RESPONSE_BYTES = 131_072;
const JWKS_MAX_KEYS = 64;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function decodeCanonicalBase64Url(input: string): Buffer {
  if (!input || !/^[A-Za-z0-9_-]+$/.test(input)) {
    throw Object.assign(new Error('malformed JWT encoding'), { status: 401 });
  }
  const decoded = base64UrlDecode(input);
  if (base64UrlEncode(decoded) !== input) {
    throw Object.assign(new Error('non-canonical JWT encoding'), { status: 401 });
  }
  return decoded;
}

function signHs256Jwt(payload: AccessTokenPayload, secret: string): string {
  const headerJson = { alg: 'HS256', typ: 'JWT', kid: payload.key_id };
  const headerPart = base64UrlEncode(JSON.stringify(headerJson));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function verifyHs256Jwt(token: string, secret: string): AccessTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('malformed JWT'), { status: 401 });
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(signingInput).digest();
  const actual = decodeCanonicalBase64Url(parts[2]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw Object.assign(new Error('JWT signature invalid'), { status: 401 });
  }

  const header = JSON.parse(decodeCanonicalBase64Url(parts[0]).toString('utf8')) as {
    alg?: string;
    typ?: string;
    kid?: string;
  };
  if (header.alg !== 'HS256' || header.typ !== 'JWT') {
    throw Object.assign(new Error(`unsupported JWT algorithm: ${header.alg}`), { status: 401 });
  }

  const payload = JSON.parse(decodeCanonicalBase64Url(parts[1]).toString('utf8')) as unknown;
  return validatePlatformJwtPayload(payload, {
    expectedIssuer: configuredLocalTokenIssuer(),
    expectedKeyId: configuredAuthKeyId(),
    verifiedKeyId: header.kid
  });
}

function decodeJwtParts(token: string): { headerRaw: string; payloadRaw: string; signature: Buffer; signingInput: string } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw Object.assign(new Error('malformed JWT'), { status: 401 });
  }
  return {
    headerRaw: parts[0],
    payloadRaw: parts[1],
    signature: decodeCanonicalBase64Url(parts[2]),
    signingInput: `${parts[0]}.${parts[1]}`
  };
}

function jwtAlgorithm(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorizedToken('malformed JWT');
  try {
    const parsed = JSON.parse(decodeCanonicalBase64Url(parts[0]).toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
    if (parsed.typ !== 'JWT' || typeof parsed.alg !== 'string') {
      throw unauthorizedToken('invalid JWT header');
    }
    return parsed.alg;
  } catch (error) {
    if ((error as { status?: number }).status === 401) throw error;
    throw unauthorizedToken('invalid JWT header');
  }
}

async function fetchJwks(issuer: string, force = false): Promise<JwksKey[]> {
  const cached = jwksCache.get(issuer);
  if (!force && cached && jwksCacheAgeMs(cached) < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const pending = jwksRefreshes.get(issuer);
  if (pending) return pending;

  const refresh = fetchAndValidateJwks(issuer);
  jwksRefreshes.set(issuer, refresh);
  try {
    return await refresh;
  } finally {
    if (jwksRefreshes.get(issuer) === refresh) jwksRefreshes.delete(issuer);
  }
}

async function fetchAndValidateJwks(issuer: string): Promise<JwksKey[]> {
  const wellKnownUrl = jwksUrl(issuer);
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(wellKnownUrl, { signal: controller.signal });
    if (!response.ok) {
      throw Object.assign(new Error(`JWKS fetch failed: ${response.status}`), { status: 401 });
    }

    const text = await readBoundedJwksBody(response);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw unauthorizedToken('JWKS response is invalid');
    }
    const keys = decodeJwks(body);
    jwksCache.set(issuer, { keys, refreshedAtMonotonicMs: performance.now() });
    return keys;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function readBoundedJwksBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null
    && (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) > JWKS_MAX_RESPONSE_BYTES)) {
    throw unauthorizedToken('JWKS response exceeds the bounded size');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > JWKS_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel('jwks_response_budget_exceeded');
        } catch {
          // The bounded rejection below remains authoritative.
        }
        throw unauthorizedToken('JWKS response exceeds the bounded size');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unauthorizedToken('JWKS response is invalid');
  }
}

function rsaPublicKeyFromJwk(jwk: JwksKey): string {
  const e = base64UrlDecode(jwk.e);
  const n = base64UrlDecode(jwk.n);

  function encodeLengthDer(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    if (length < 0x100) return Buffer.from([0x81, length]);
    return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
  }

  function encodeUintDer(value: Buffer): Buffer {
    const needsPad = value[0] & 0x80;
    const content = needsPad ? Buffer.concat([Buffer.from([0x00]), value]) : value;
    return Buffer.concat([Buffer.from([0x02]), encodeLengthDer(content.length), content]);
  }

  const nDer = encodeUintDer(n);
  const eDer = encodeUintDer(e);
  const rsaSeq = Buffer.concat([nDer, eDer]);
  const rsaSeqWrapped = Buffer.concat([Buffer.from([0x30]), encodeLengthDer(rsaSeq.length), rsaSeq]);

  // RSA OID: 1.2.840.113549.1.1.1 + NULL
  const rsaOid = Buffer.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);

  const bitString = Buffer.concat([Buffer.from([0x03]), encodeLengthDer(rsaSeqWrapped.length + 1), Buffer.from([0x00]), rsaSeqWrapped]);
  const spki = Buffer.concat([rsaOid, bitString]);
  const spkiWrapped = Buffer.concat([Buffer.from([0x30]), encodeLengthDer(spki.length), spki]);

  const b64 = spkiWrapped.toString('base64');
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

/**
 * Synchronous JWT verification — requires JWKS to already be cached.
 * For production use, call `await warmJwksCache(issuer)` at startup.
 */
function verifyJwt(token: string, issuer: string): JwtPayload {
  const { headerRaw, payloadRaw, signature, signingInput } = decodeJwtParts(token);

  const jwtHeader = JSON.parse(decodeCanonicalBase64Url(headerRaw).toString('utf8')) as {
    alg?: string;
    typ?: string;
    kid?: string;
  };
  if (jwtHeader.alg !== 'RS256' || jwtHeader.typ !== 'JWT' || !jwtHeader.kid) {
    throw Object.assign(new Error(`unsupported JWT algorithm: ${jwtHeader.alg}`), { status: 401 });
  }

  const cached = jwksCache.get(issuer);
  if (!cached || jwksCacheAgeMs(cached) >= JWKS_CACHE_TTL_MS) {
    queueJwksRefresh(issuer);
    throw unauthorizedToken('JWKS cache is unavailable or expired; refresh scheduled');
  }

  const jwk = cached.keys.find((key) => key.kid === jwtHeader.kid
    && key.kty === 'RSA'
    && (key.use === 'sig' || !key.use)
    && (key.alg === 'RS256' || !key.alg));

  if (!jwk) {
    queueJwksRefresh(issuer);
    throw unauthorizedToken('no matching JWKS key found; refresh scheduled');
  }

  const publicKey = rsaPublicKeyFromJwk(jwk);
  const verify = createVerify('RSA-SHA256');
  verify.update(signingInput);
  if (!verify.verify(publicKey, signature)) {
    throw Object.assign(new Error('JWT signature invalid'), { status: 401 });
  }

  const payload = JSON.parse(decodeCanonicalBase64Url(payloadRaw).toString('utf8')) as unknown;
  return validatePlatformJwtPayload(payload, {
    expectedIssuer: issuer,
    verifiedKeyId: jwtHeader.kid
  });
}

function validatePlatformJwtPayload(
  value: unknown,
  options: { expectedIssuer: string; expectedKeyId?: string; verifiedKeyId?: string }
): AccessTokenPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unauthorizedToken('platform identity claims are required');
  }
  const payload = value as Partial<AccessTokenPayload>;
  if (!VALID_ROLES.has(String(payload.role || ''))) {
    throw unauthorizedToken('platform identity role is invalid');
  }
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.nbf)
    || !Number.isSafeInteger(payload.exp)) {
    throw unauthorizedToken('platform identity expiry claims are required');
  }
  if (payload.iss !== options.expectedIssuer || payload.issuer !== options.expectedIssuer) {
    throw unauthorizedToken('platform identity issuer mismatch');
  }
  if (!options.verifiedKeyId || payload.key_id !== options.verifiedKeyId
    || (options.expectedKeyId && payload.key_id !== options.expectedKeyId)) {
    throw unauthorizedToken('platform identity key claim mismatch');
  }
  const tenantId = payload.tenant_id || payload.tid;
  if (payload.sub !== payload.identity_id || !tenantId
    || (payload.tid !== undefined && payload.tid !== tenantId)
    || (payload.tenant_id !== undefined && payload.tenant_id !== tenantId)) {
    throw unauthorizedToken('platform identity subject or tenant claims mismatch');
  }
  payload.tid = tenantId;
  payload.tenant_id = tenantId;
  if (!sameStringSet(payload.aud, payload.audience)) {
    throw unauthorizedToken('platform identity audience claims mismatch');
  }
  if (payload.issued_at !== epochToIso(payload.iat)
    || payload.not_before !== epochToIso(payload.nbf)
    || payload.expires_at !== epochToIso(payload.exp)) {
    throw unauthorizedToken('platform identity clock claims mismatch');
  }

  const claims: PlatformIdentityClaims = {
    tenant_id: String(payload.tenant_id || ''),
    identity_id: String(payload.identity_id || ''),
    identity_kind: payload.identity_kind as PlatformIdentityClaims['identity_kind'],
    session_id: String(payload.session_id || ''),
    token_id: String(payload.token_id || ''),
    issuer: String(payload.issuer || ''),
    audience: Array.isArray(payload.audience) ? payload.audience : [],
    key_id: String(payload.key_id || ''),
    issued_at: String(payload.issued_at || ''),
    not_before: String(payload.not_before || ''),
    expires_at: String(payload.expires_at || ''),
    policy_version: Number(payload.policy_version),
    revocation_epoch: Number(payload.revocation_epoch),
    role: String(payload.role || ''),
    capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
    purpose: Array.isArray(payload.purpose) ? payload.purpose : [],
    credential_strength: payload.credential_strength as PlatformIdentityClaims['credential_strength']
  };
  const decision = evaluatePlatformAccess({
    claims,
    resource_tenant_id: claims.tenant_id,
    required_audience: configuredAuthAudience(),
    required_capability: PLATFORM_API_CAPABILITY,
    required_purpose: PRODUCT_OPERATION_PURPOSE,
    current_policy_version: configuredPolicyVersion(),
    current_revocation_epoch: configuredRevocationEpoch(),
    wall_now: new Date()
  });
  if (decision.allowed === false) {
    throw unauthorizedToken(`platform identity rejected: ${decision.reason}`);
  }
  return payload as AccessTokenPayload;
}

function sameStringSet(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  if (!left.every((item) => typeof item === 'string') || !right.every((item) => typeof item === 'string')) {
    return false;
  }
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((item, index) => item === rightSorted[index]);
}

function configuredLocalTokenIssuer(): string {
  return boundedConfigText('AUTH_TOKEN_ISSUER', DEFAULT_AUTH_ISSUER);
}

function configuredAuthAudience(): string {
  return boundedConfigText('AUTH_AUDIENCE', DEFAULT_AUTH_AUDIENCE);
}

function configuredAuthKeyId(): string {
  return boundedConfigText('AUTH_KEY_ID', DEFAULT_AUTH_KEY_ID);
}

function configuredPolicyVersion(): number {
  return configuredInteger('AUTH_POLICY_VERSION', 1, 1);
}

function configuredRevocationEpoch(): number {
  return configuredInteger('AUTH_REVOCATION_EPOCH', 0, 0);
}

function configuredInteger(suffix: string, fallback: number, minimum: number): number {
  const raw = resolveBrandEnv(process.env, suffix);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw Object.assign(new Error(`CONVERACT_${suffix} must be an integer >= ${minimum}`), { status: 503 });
  }
  return value;
}

function boundedConfigText(suffix: string, fallback: string): string {
  const value = String(resolveBrandEnv(process.env, suffix) || fallback).trim();
  if (!value || value.length > 256) {
    throw Object.assign(new Error(`CONVERACT_${suffix} must be 1..256 characters`), { status: 503 });
  }
  return value;
}

function epochToIso(epochSeconds: number): string {
  if (!Number.isSafeInteger(epochSeconds)) return '';
  return new Date(epochSeconds * 1000).toISOString();
}

function unauthorizedToken(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 401 });
}

/** Pre-fetch JWKS keys at server startup. */
export async function warmJwksCache(issuer: string): Promise<void> {
  await fetchJwks(issuer, true);
}

export async function startConfiguredAuthJwksLifecycle(): Promise<AuthJwksLifecycle | null> {
  return startAuthJwksLifecycle();
}

export async function startAuthJwksLifecycle(input: {
  issuer?: string;
  refreshIntervalMs?: number;
  scheduler?: AuthJwksLifecycleScheduler;
} = {}): Promise<AuthJwksLifecycle | null> {
  const issuer = String(input.issuer ?? resolveBrandEnv(process.env, 'AUTH_ISSUER') ?? '').trim();
  if (!issuer) return null;
  const refreshIntervalMs = boundedJwksRefreshInterval(
    input.refreshIntervalMs ?? JWKS_DEFAULT_REFRESH_INTERVAL_MS
  );
  const scheduler = input.scheduler ?? defaultJwksLifecycleScheduler();
  if (!scheduler || typeof scheduler.setInterval !== 'function'
    || typeof scheduler.clearInterval !== 'function') {
    throw Object.assign(new Error('JWKS lifecycle scheduler is invalid'), { status: 503 });
  }
  await fetchJwks(issuer, true);
  let stopped = false;
  const refreshNow = async (): Promise<void> => {
    if (stopped) return;
    await fetchJwks(issuer, true);
  };
  const handle = scheduler.setInterval(() => {
    void refreshNow().catch(() => undefined);
  }, refreshIntervalMs);
  return Object.freeze({
    refreshNow,
    stop(): void {
      if (stopped) return;
      stopped = true;
      scheduler.clearInterval(handle);
    }
  });
}

/** Exposed for testing: inject JWKS keys directly. */
export function _injectJwksForTest(issuer: string, keys: JwksKey[]): void {
  jwksCache.set(issuer, { keys, refreshedAtMonotonicMs: performance.now() });
}

/** Exposed for testing: clear JWKS cache. */
export function _clearJwksCache(): void {
  jwksCache.clear();
  jwksLastRefreshAttempt.clear();
}

function queueJwksRefresh(issuer: string): void {
  const now = performance.now();
  const lastAttempt = jwksLastRefreshAttempt.get(issuer) ?? Number.NEGATIVE_INFINITY;
  if (now - lastAttempt < JWKS_ON_DEMAND_REFRESH_FLOOR_MS || jwksRefreshes.has(issuer)) return;
  jwksLastRefreshAttempt.set(issuer, now);
  void fetchJwks(issuer, true).catch(() => undefined);
}

function jwksCacheAgeMs(cache: { refreshedAtMonotonicMs: number }): number {
  return Math.max(0, performance.now() - cache.refreshedAtMonotonicMs);
}

function jwksUrl(issuer: string): string {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw unauthorizedToken('JWKS issuer URL is invalid');
  }
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw unauthorizedToken('JWKS issuer must use HTTPS');
  }
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, '')}/.well-known/jwks.json`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function decodeJwks(value: unknown): JwksKey[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unauthorizedToken('JWKS response is invalid');
  }
  const keys = (value as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > JWKS_MAX_KEYS) {
    throw unauthorizedToken('JWKS key count is invalid');
  }
  const seen = new Set<string>();
  return keys.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw unauthorizedToken('JWKS key is invalid');
    }
    const key = candidate as Partial<JwksKey>;
    if (key.kty !== 'RSA' || typeof key.kid !== 'string'
      || !/^[A-Za-z0-9._:/-]{1,256}$/u.test(key.kid) || seen.has(key.kid)
      || typeof key.n !== 'string' || !/^[A-Za-z0-9_-]{64,1024}$/u.test(key.n)
      || typeof key.e !== 'string' || !/^[A-Za-z0-9_-]{1,16}$/u.test(key.e)
      || (key.use !== undefined && key.use !== 'sig')
      || (key.alg !== undefined && key.alg !== 'RS256')) {
      throw unauthorizedToken('JWKS key is invalid');
    }
    seen.add(key.kid);
    return {
      kty: key.kty,
      kid: key.kid,
      n: key.n,
      e: key.e,
      ...(key.use === undefined ? {} : { use: key.use }),
      ...(key.alg === undefined ? {} : { alg: key.alg })
    };
  });
}

function boundedJwksRefreshInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < JWKS_MIN_REFRESH_INTERVAL_MS
    || value >= JWKS_CACHE_TTL_MS) {
    throw Object.assign(new Error('JWKS refresh interval is invalid'), { status: 503 });
  }
  return value;
}

function defaultJwksLifecycleScheduler(): AuthJwksLifecycleScheduler {
  return {
    setInterval(callback, delayMs) {
      const handle = globalThis.setInterval(callback, delayMs);
      handle.unref?.();
      return handle;
    },
    clearInterval(handle) {
      globalThis.clearInterval(handle as ReturnType<typeof setInterval>);
    }
  };
}
