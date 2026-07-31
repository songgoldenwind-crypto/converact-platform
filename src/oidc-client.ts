import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri?: string;
  issuer: string;
}

export interface OidcTokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in?: number;
}

export interface OidcIdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
}

const discoveryCache = new Map<string, { doc: OidcDiscovery; expiresAt: number }>();

export async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
  const normalized = issuerUrl.replace(/\/$/, '');
  const cached = discoveryCache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;

  const discoveryUrl = `${normalized}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw Object.assign(new Error(`OIDC discovery failed: ${response.status}`), { status: 502 });
  }
  const doc = (await response.json()) as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw Object.assign(new Error('invalid OIDC discovery document'), { status: 502 });
  }
  discoveryCache.set(normalized, { doc, expiresAt: Date.now() + 3_600_000 });
  return doc;
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  nonce: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', input.scopes);
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  return url.toString();
}

export async function exchangeAuthorizationCode(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    client_secret: input.clientSecret
  });
  const response = await fetch(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`OIDC token exchange failed: ${response.status} ${text}`), { status: 502 });
  }
  return (await response.json()) as OidcTokenResponse;
}

export function parseIdTokenClaims(idToken: string): OidcIdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length < 2) {
    throw Object.assign(new Error('invalid id_token'), { status: 401 });
  }
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as OidcIdTokenClaims;
  if (!payload.sub) {
    throw Object.assign(new Error('id_token missing sub'), { status: 401 });
  }
  if (payload.exp && payload.exp * 1000 < Date.now()) {
    throw Object.assign(new Error('id_token expired'), { status: 401 });
  }
  return payload;
}

export function createSsoState(tenantId: string, secret: string): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString('hex');
  const payload = JSON.stringify({ tenantId, nonce, exp: Date.now() + 600_000 });
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return { state: Buffer.from(`${payload}.${sig}`).toString('base64url'), nonce };
}

export function verifySsoState(state: string, tenantId: string, secret: string): { nonce: string } {
  const decoded = Buffer.from(state, 'base64url').toString('utf8');
  const dot = decoded.lastIndexOf('.');
  if (dot < 0) throw Object.assign(new Error('invalid state'), { status: 400 });
  const payload = decoded.slice(0, dot);
  const sig = decoded.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error('invalid state signature'), { status: 400 });
  }
  const parsed = JSON.parse(payload) as { tenantId: string; nonce: string; exp: number };
  if (parsed.tenantId !== tenantId) {
    throw Object.assign(new Error('state tenant mismatch'), { status: 400 });
  }
  if (parsed.exp < Date.now()) {
    throw Object.assign(new Error('state expired'), { status: 400 });
  }
  return { nonce: parsed.nonce };
}

/** For tests */
export function _clearOidcDiscoveryCache(): void {
  discoveryCache.clear();
}
