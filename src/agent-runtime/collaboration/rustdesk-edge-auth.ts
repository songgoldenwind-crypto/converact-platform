import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface RustDeskEdgeCommandIdentity {
  tenant_id: string;
  rustdesk_id: string;
  edge_instance_id: string;
  issued_at: string;
  expires_at: string;
}

export interface CreateRustDeskEdgeCommandTokenInput {
  tenant_id: string;
  rustdesk_id: string;
  edge_instance_id: string;
  issued_at?: string;
  expires_at: string;
}

interface RustDeskEdgeCommandTokenPayload extends RustDeskEdgeCommandIdentity {
  version: 1;
  nonce: string;
}

export function createRustDeskEdgeCommandToken(
  input: CreateRustDeskEdgeCommandTokenInput,
  secretValue: string
): string {
  const secret = edgeTokenSecret(secretValue);
  const issuedAt = edgeTokenTimestamp(input.issued_at || new Date().toISOString(), 'issued_at');
  const expiresAt = edgeTokenTimestamp(input.expires_at, 'expires_at');
  if (new Date(expiresAt).getTime() <= new Date(issuedAt).getTime()) {
    throw Object.assign(new Error('expires_at must be later than issued_at'), { status: 400 });
  }
  const payload: RustDeskEdgeCommandTokenPayload = {
    version: 1,
    tenant_id: edgeTokenClaim(input.tenant_id, 'tenant_id'),
    rustdesk_id: edgeTokenClaim(input.rustdesk_id, 'rustdesk_id'),
    edge_instance_id: edgeTokenClaim(input.edge_instance_id, 'edge_instance_id'),
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce: randomBytes(16).toString('base64url')
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${edgeTokenSignature(encodedPayload, secret)}`;
}

export function verifyRustDeskEdgeCommandToken(
  tokenValue: string,
  secretValue: string,
  nowValue = new Date().toISOString()
): RustDeskEdgeCommandIdentity {
  const secret = edgeTokenSecret(secretValue);
  const token = String(tokenValue || '').trim();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidEdgeToken();
  const expected = Buffer.from(edgeTokenSignature(parts[0], secret));
  const actual = Buffer.from(parts[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalidEdgeToken();

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidEdgeToken();
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalidEdgeToken();
  const claims = payload as Record<string, unknown>;
  if (claims.version !== 1) throw invalidEdgeToken();
  let identity: RustDeskEdgeCommandIdentity;
  try {
    identity = {
      tenant_id: edgeTokenClaim(claims.tenant_id, 'tenant_id'),
      rustdesk_id: edgeTokenClaim(claims.rustdesk_id, 'rustdesk_id'),
      edge_instance_id: edgeTokenClaim(claims.edge_instance_id, 'edge_instance_id'),
      issued_at: edgeTokenTimestamp(claims.issued_at, 'issued_at'),
      expires_at: edgeTokenTimestamp(claims.expires_at, 'expires_at')
    };
  } catch {
    throw invalidEdgeToken();
  }
  const now = new Date(edgeTokenTimestamp(nowValue, 'now')).getTime();
  if (new Date(identity.expires_at).getTime() <= now) {
    throw Object.assign(new Error('RustDesk edge command token is expired'), { status: 401 });
  }
  return identity;
}

function edgeTokenSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function edgeTokenSecret(value: unknown): string {
  const secret = String(value || '');
  if (secret.length < 32) {
    throw Object.assign(
      new Error('RustDesk edge token secret must contain at least 32 characters'),
      { status: 503 }
    );
  }
  return secret;
}

function edgeTokenClaim(value: unknown, field: string): string {
  const claim = String(value || '').trim();
  if (!claim) throw Object.assign(new Error(`${field} is required`), { status: 400 });
  if (claim.length > 200) {
    throw Object.assign(new Error(`${field} must contain at most 200 characters`), { status: 400 });
  }
  return claim;
}

function edgeTokenTimestamp(value: unknown, field: string): string {
  const timestamp = String(value || '').trim();
  const milliseconds = new Date(timestamp).getTime();
  if (!timestamp || Number.isNaN(milliseconds)) {
    throw Object.assign(new Error(`${field} must be an ISO timestamp`), { status: 400 });
  }
  return new Date(milliseconds).toISOString();
}

function invalidEdgeToken(): Error {
  return Object.assign(new Error('invalid RustDesk edge command token'), { status: 401 });
}
