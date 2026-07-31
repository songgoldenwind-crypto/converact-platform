import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface WebAssistJoinTokenInput {
  tenant_id: string;
  remote_session_id: string;
  actor_identity: string;
  role: 'customer' | 'agent' | 'engineer';
  expires_at: string;
}

export interface VerifiedWebAssistJoinToken extends WebAssistJoinTokenInput {
  nonce: string;
}

export function createWebAssistJoinPath(input: WebAssistJoinTokenInput, secret?: string): string {
  const tokenPayload = {
    tenant_id: input.tenant_id,
    remote_session_id: input.remote_session_id,
    actor_identity: input.actor_identity,
    role: input.role,
    expires_at: input.expires_at,
    nonce: randomUUID()
  };
  const payload = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
  const signature = signPayload(payload, secret);
  const params = new URLSearchParams({
    tenant_id: input.tenant_id,
    remote_session_id: input.remote_session_id,
    identity: input.actor_identity,
    role: input.role,
    expires_at: input.expires_at,
    token: `${payload}.${signature}`
  });
  return `/remote-assist/session?${params.toString()}`;
}

export function verifyWebAssistJoinToken(input: {
  token: string;
  tenant_id: string;
  remote_session_id: string;
  secret?: string;
  now?: Date;
}): VerifiedWebAssistJoinToken {
  const [payload, signature] = input.token.split('.');
  if (!payload || !signature) {
    throw invalidToken();
  }
  const expected = signPayload(payload, input.secret);
  if (!safeEqual(signature, expected)) {
    throw invalidToken();
  }

  const tokenPayload = parsePayload(payload);
  if (tokenPayload.tenant_id !== input.tenant_id || tokenPayload.remote_session_id !== input.remote_session_id) {
    throw invalidToken();
  }
  if (new Date(tokenPayload.expires_at).getTime() <= (input.now || new Date()).getTime()) {
    throw Object.assign(new Error('expired Web Assist token'), { status: 401 });
  }
  return tokenPayload;
}

export function webAssistExpiresAt(expiresInMs = 5 * 60 * 1000, now = new Date()): string {
  const clamped = Math.max(30_000, Math.min(expiresInMs, 15 * 60 * 1000));
  return new Date(now.getTime() + clamped).toISOString();
}

function signPayload(payload: string, secret?: string): string {
  return createHmac('sha256', secret || process.env.IVEKIT_WEB_ASSIST_SECRET || 'ivekit-local-web-assist')
    .update(payload)
    .digest('base64url');
}

function parsePayload(payload: string): VerifiedWebAssistJoinToken {
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VerifiedWebAssistJoinToken;
    if (
      !parsed.tenant_id ||
      !parsed.remote_session_id ||
      !parsed.actor_identity ||
      !['customer', 'agent', 'engineer'].includes(parsed.role) ||
      !parsed.expires_at ||
      !parsed.nonce
    ) {
      throw invalidToken();
    }
    return parsed;
  } catch {
    throw invalidToken();
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function invalidToken(): Error & { status: number } {
  return Object.assign(new Error('invalid Web Assist token'), { status: 401 });
}
