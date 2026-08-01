export type IdentityKind = 'human' | 'service' | 'workload' | 'edge' | 'provider';

export interface PlatformIdentityClaims {
  tenant_id: string;
  identity_id: string;
  identity_kind: IdentityKind;
  session_id: string;
  token_id: string;
  issuer: string;
  audience: string[];
  key_id: string;
  issued_at: string;
  not_before: string;
  expires_at: string;
  policy_version: number;
  revocation_epoch: number;
  role: string;
  capabilities: string[];
  purpose: string[];
  credential_strength: 'signed_token' | 'mtls';
}

export type PlatformAccessDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'claims_invalid'
        | 'tenant_mismatch'
        | 'audience_mismatch'
        | 'capability_denied'
        | 'purpose_denied'
        | 'not_yet_valid'
        | 'expired'
        | 'stale_policy'
        | 'stale_revocation'
        | 'strong_service_identity_required';
    };

export function evaluatePlatformAccess(input: {
  claims: PlatformIdentityClaims;
  resource_tenant_id: string;
  required_audience: string;
  required_capability: string;
  required_purpose: string;
  current_policy_version: number;
  current_revocation_epoch: number;
  wall_now: Date;
}): PlatformAccessDecision {
  const { claims } = input;
  if (!validClaims(claims) || !boundedText(input.resource_tenant_id)
    || !boundedText(input.required_audience) || !boundedText(input.required_capability)
    || !boundedText(input.required_purpose)
    || !positiveInteger(input.current_policy_version)
    || !nonNegativeInteger(input.current_revocation_epoch)
    || !validDate(input.wall_now)) {
    return deny('claims_invalid');
  }
  if (claims.tenant_id !== input.resource_tenant_id) return deny('tenant_mismatch');
  if (!claims.audience.includes(input.required_audience)) return deny('audience_mismatch');
  if (!claims.capabilities.includes(input.required_capability)) return deny('capability_denied');
  if (!claims.purpose.includes(input.required_purpose)) return deny('purpose_denied');

  const now = input.wall_now.getTime();
  const issuedAt = Date.parse(claims.issued_at);
  const notBefore = Date.parse(claims.not_before);
  const expiresAt = Date.parse(claims.expires_at);
  if (issuedAt > now || notBefore > now) return deny('not_yet_valid');
  if (expiresAt <= now) return deny('expired');
  if (claims.policy_version !== input.current_policy_version) return deny('stale_policy');
  if (claims.revocation_epoch !== input.current_revocation_epoch) return deny('stale_revocation');
  if (claims.identity_kind !== 'human' && claims.credential_strength !== 'mtls') {
    return deny('strong_service_identity_required');
  }
  return { allowed: true };
}

function validClaims(value: PlatformIdentityClaims): boolean {
  if (!value || typeof value !== 'object') return false;
  for (const field of [
    value.tenant_id, value.identity_id, value.session_id, value.token_id,
    value.issuer, value.key_id, value.role
  ]) {
    if (!boundedText(field)) return false;
  }
  if (!['human', 'service', 'workload', 'edge', 'provider'].includes(value.identity_kind)) {
    return false;
  }
  if (!['signed_token', 'mtls'].includes(value.credential_strength)) return false;
  if (!boundedStringSet(value.audience) || !boundedStringSet(value.capabilities)
    || !boundedStringSet(value.purpose)) return false;
  if (!positiveInteger(value.policy_version) || !nonNegativeInteger(value.revocation_epoch)) {
    return false;
  }
  const issuedAt = canonicalTimestamp(value.issued_at);
  const notBefore = canonicalTimestamp(value.not_before);
  const expiresAt = canonicalTimestamp(value.expires_at);
  return issuedAt !== null && notBefore !== null && expiresAt !== null
    && issuedAt <= notBefore && notBefore < expiresAt;
}

function boundedStringSet(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return false;
  if (!value.every(boundedText)) return false;
  return new Set(value).size === value.length;
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function canonicalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function deny(reason: Exclude<PlatformAccessDecision, { allowed: true }>['reason']): PlatformAccessDecision {
  return { allowed: false, reason };
}
