import { resolveBrandEnv } from '../config/converact-env.js';
import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';

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
  role: AuthRole;
  iat: number;
  exp: number;
}

const VALID_ROLES: Set<string> = new Set(['owner', 'admin', 'operator', 'viewer', 'system']);
const DEFAULT_TOKEN_TTL_SEC = 86_400;

/**
 * Resolve authentication context from HTTP headers.
 *
 * Priority:
 * 1. X-API-Key (system)
 * 2. Bearer JWT (CONVERACT_JWT_SECRET HS256, or CONVERACT_AUTH_ISSUER RS256 JWKS)
 * 3. Dev headers (CONVERACT_AUTH_DISABLED=1 or no issuer/secret)
 */
export function resolveAuthContext(headers: Record<string, string | string[] | undefined>): AuthContext {
  const apiKey = header(headers, 'X-API-Key') || header(headers, 'x-api-key');
  const expectedKey = resolveBrandEnv(process.env, 'API_KEY');
  if (apiKey && expectedKey && apiKey === expectedKey) {
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
    const jwtSecret = resolveBrandEnv(process.env, 'JWT_SECRET');
    if (jwtSecret) {
      return resolveHs256Context(token, jwtSecret);
    }
    const issuer = resolveBrandEnv(process.env, 'AUTH_ISSUER');
    if (issuer) {
      return resolveJwtContext(headers, issuer, token);
    }
  }

  const authDisabled = resolveBrandEnv(process.env, 'AUTH_DISABLED') === '1';
  const issuer = resolveBrandEnv(process.env, 'AUTH_ISSUER');
  if (authDisabled || (!issuer && !resolveBrandEnv(process.env, 'JWT_SECRET'))) {
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
  const role: AuthRole = VALID_ROLES.has(rawRole) ? (rawRole as AuthRole) : 'operator';

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
  const role: AuthRole = VALID_ROLES.has(String(payload.role)) ? (payload.role as AuthRole) : 'operator';
  return {
    tenantId: String(tenantId),
    userId: String(payload.sub),
    role,
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
  const now = Math.floor(Date.now() / 1000);
  const body: AccessTokenPayload = {
    sub: payload.sub,
    tid: payload.tid,
    role: payload.role,
    iat: now,
    exp: now + ttlSec
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

  const role: AuthRole = VALID_ROLES.has(payload.role) ? (payload.role as AuthRole) : 'operator';

  return {
    tenantId,
    userId,
    role,
    authenticated: true,
    expiresAt: payload.exp
  };
}

// --- JWT verification with native crypto (RS256 + JWKS) ---

interface JwtPayload {
  sub?: string;
  user_id?: string;
  tenant_id?: string;
  role?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  [key: string]: unknown;
}

interface JwksKey {
  kty: string;
  kid: string;
  n: string;
  e: string;
  use?: string;
  alg?: string;
}

const jwksCache = new Map<string, { keys: JwksKey[]; fetchedAt: number }>();
const JWKS_CACHE_TTL_MS = 300_000;

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
  const headerJson = { alg: 'HS256', typ: 'JWT' };
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

  const header = JSON.parse(decodeCanonicalBase64Url(parts[0]).toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') {
    throw Object.assign(new Error(`unsupported JWT algorithm: ${header.alg}`), { status: 401 });
  }

  const payload = JSON.parse(decodeCanonicalBase64Url(parts[1]).toString('utf8')) as AccessTokenPayload;
  if (payload.exp && payload.exp <= Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error('JWT expired'), { status: 401 });
  }
  return payload;
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

async function fetchJwks(issuer: string): Promise<JwksKey[]> {
  const cached = jwksCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }

  const wellKnownUrl = `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
  const response = await fetch(wellKnownUrl);
  if (!response.ok) {
    throw Object.assign(new Error(`JWKS fetch failed: ${response.status}`), { status: 401 });
  }

  const body = (await response.json()) as { keys: JwksKey[] };
  jwksCache.set(issuer, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
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

  const jwtHeader = JSON.parse(base64UrlDecode(headerRaw).toString('utf8'));
  if (jwtHeader.alg !== 'RS256') {
    throw Object.assign(new Error(`unsupported JWT algorithm: ${jwtHeader.alg}`), { status: 401 });
  }

  const cached = jwksCache.get(issuer);
  if (!cached) {
    throw Object.assign(new Error('JWKS not cached — call warmJwksCache at startup'), { status: 401 });
  }

  const jwk = jwtHeader.kid
    ? cached.keys.find((k) => k.kid === jwtHeader.kid)
    : cached.keys.find((k) => k.kty === 'RSA' && (k.use === 'sig' || !k.use));

  if (!jwk) {
    throw Object.assign(new Error('no matching JWKS key found'), { status: 401 });
  }

  const publicKey = rsaPublicKeyFromJwk(jwk);
  const verify = createVerify('RSA-SHA256');
  verify.update(signingInput);
  if (!verify.verify(publicKey, signature)) {
    throw Object.assign(new Error('JWT signature invalid'), { status: 401 });
  }

  const payload: JwtPayload = JSON.parse(base64UrlDecode(payloadRaw).toString('utf8'));

  if (payload.exp && payload.exp <= Math.floor(Date.now() / 1000)) {
    throw Object.assign(new Error('JWT expired'), { status: 401 });
  }

  if (payload.iss && payload.iss !== issuer) {
    throw Object.assign(new Error('JWT issuer mismatch'), { status: 401 });
  }

  return payload;
}

/** Pre-fetch JWKS keys at server startup. */
export async function warmJwksCache(issuer: string): Promise<void> {
  await fetchJwks(issuer);
}

/** Exposed for testing: inject JWKS keys directly. */
export function _injectJwksForTest(issuer: string, keys: JwksKey[]): void {
  jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
}

/** Exposed for testing: clear JWKS cache. */
export function _clearJwksCache(): void {
  jwksCache.clear();
}
