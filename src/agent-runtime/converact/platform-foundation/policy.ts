import { createHash } from 'node:crypto';

import {
  createPlatformDeadline,
  platformDeadlineState,
  type PlatformClock,
  type PlatformDeadline
} from './clock.js';

export type ConsentScope =
  | 'phone_audio'
  | 'video'
  | 'recording'
  | 'transcription'
  | 'translation'
  | 'ai_processing'
  | 'tool_action'
  | 'remote_control';

export interface ConsentEvidence {
  consent_id: string;
  tenant_id: string;
  subject_id: string;
  scope: ConsentScope;
  purpose: string;
  status: 'granted' | 'pending' | 'denied' | 'revoked';
  policy_version: number;
  revocation_epoch: number;
  allowed_regions: string[];
  retention_policy: string;
  legal_hold_policy: string;
  evidence_ref: string;
  actor_id: string;
  occurred_at: string;
  expires_at: string | null;
  revision: number;
}

export interface ConsentLeaseRequest {
  lease_id: string;
  tenant_id: string;
  subject_id: string;
  scope: ConsentScope;
  purpose: string;
  region: string;
  ttl_ms: number;
  policy_version: number;
  revocation_epoch: number;
  issuer_key_id: string;
}

export interface ConsentLease {
  lease_id: string;
  tenant_id: string;
  subject_id: string;
  scope: ConsentScope;
  purpose: string;
  region: string;
  generation: number;
  policy_version: number;
  revocation_epoch: number;
  issued_at: string;
  expires_at: string;
  monotonic_duration_ms: number;
  issuer_key_id: string;
  evidence_digest: string;
}

export type ConsentLeaseState =
  | 'active'
  | 'expired'
  | 'revoked'
  | 'stale_policy'
  | 'restart_reauthorization_required';

const CONSENT_SCOPES: ReadonlySet<string> = new Set([
  'phone_audio',
  'video',
  'recording',
  'transcription',
  'translation',
  'ai_processing',
  'tool_action',
  'remote_control'
]);

// Deliberately process-local: serializing a lease must not persist a monotonic
// instant across a process or host restart. A restored lease is reauthorized.
const runtimeDeadlines = new WeakMap<ConsentLease, PlatformDeadline>();

export function issueConsentLease(input: {
  evidence: ConsentEvidence;
  request: ConsentLeaseRequest;
  clock: PlatformClock;
  max_ttl_ms: number;
}): ConsentLease {
  const { evidence, request, clock } = input;
  if (!validEvidence(evidence)) throw consentError('consent_evidence_invalid');
  if (!validRequest(request)) throw consentError('consent_request_invalid');
  if (evidence.status !== 'granted') throw consentError('consent_not_granted');
  if (evidence.tenant_id !== request.tenant_id) throw consentError('consent_tenant_mismatch');
  if (evidence.subject_id !== request.subject_id) throw consentError('consent_subject_mismatch');
  if (evidence.scope !== request.scope) throw consentError('consent_scope_mismatch');
  if (evidence.purpose !== request.purpose) throw consentError('consent_purpose_mismatch');
  if (!evidence.allowed_regions.includes(request.region)) throw consentError('consent_region_denied');
  if (evidence.policy_version !== request.policy_version) throw consentError('consent_policy_mismatch');
  if (evidence.revocation_epoch !== request.revocation_epoch) {
    throw consentError('consent_revocation_mismatch');
  }
  if (!positiveInteger(input.max_ttl_ms) || !positiveInteger(request.ttl_ms)
    || request.ttl_ms > input.max_ttl_ms) {
    throw consentError('consent_ttl_invalid');
  }

  let deadline: PlatformDeadline;
  try {
    deadline = createPlatformDeadline(clock, request.ttl_ms, input.max_ttl_ms);
  } catch {
    throw consentError('consent_clock_invalid');
  }
  const issuedAtMs = Date.parse(deadline.started_wall_at);
  const evidenceExpiresAt = evidence.expires_at === null ? null : Date.parse(evidence.expires_at);
  if (evidenceExpiresAt !== null && evidenceExpiresAt <= issuedAtMs) {
    throw consentError('consent_expired');
  }
  if (evidenceExpiresAt !== null && evidenceExpiresAt < issuedAtMs + request.ttl_ms) {
    throw consentError('consent_expires_before_lease');
  }
  const lease: ConsentLease = Object.freeze({
    lease_id: request.lease_id,
    tenant_id: request.tenant_id,
    subject_id: request.subject_id,
    scope: request.scope,
    purpose: request.purpose,
    region: request.region,
    generation: evidence.revision,
    policy_version: request.policy_version,
    revocation_epoch: request.revocation_epoch,
    issued_at: deadline.started_wall_at,
    expires_at: deadline.expires_wall_at,
    monotonic_duration_ms: deadline.duration_ms,
    issuer_key_id: request.issuer_key_id,
    evidence_digest: digestEvidence(evidence)
  });
  runtimeDeadlines.set(lease, deadline);
  return lease;
}

export function evaluateConsentLease(input: {
  lease: ConsentLease;
  clock: PlatformClock;
  current_policy_version: number;
  current_revocation_epoch: number;
}): ConsentLeaseState {
  if (!validLease(input.lease) || !positiveInteger(input.current_policy_version)
    || !nonNegativeInteger(input.current_revocation_epoch)) {
    return 'restart_reauthorization_required';
  }
  if (input.lease.policy_version !== input.current_policy_version) return 'stale_policy';
  if (input.lease.revocation_epoch !== input.current_revocation_epoch) return 'revoked';
  const deadline = runtimeDeadlines.get(input.lease);
  if (!deadline) return 'restart_reauthorization_required';
  const state = platformDeadlineState(input.clock, deadline);
  return state === 'clock_invalid' ? 'restart_reauthorization_required' : state;
}

function validEvidence(value: ConsentEvidence): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!boundedText(value.consent_id) || !boundedText(value.tenant_id)
    || !boundedText(value.subject_id) || !CONSENT_SCOPES.has(value.scope)
    || !boundedText(value.purpose) || !boundedText(value.retention_policy)
    || !boundedText(value.legal_hold_policy) || !boundedText(value.evidence_ref)
    || !boundedText(value.actor_id) || !positiveInteger(value.policy_version)
    || !nonNegativeInteger(value.revocation_epoch) || !positiveInteger(value.revision)) {
    return false;
  }
  if (!['granted', 'pending', 'denied', 'revoked'].includes(value.status)) return false;
  if (!boundedStringSet(value.allowed_regions)) return false;
  if (canonicalTimestamp(value.occurred_at) === null) return false;
  return value.expires_at === null || canonicalTimestamp(value.expires_at) !== null;
}

function validRequest(value: ConsentLeaseRequest): boolean {
  return Boolean(value && typeof value === 'object'
    && boundedText(value.lease_id) && boundedText(value.tenant_id)
    && boundedText(value.subject_id) && CONSENT_SCOPES.has(value.scope)
    && boundedText(value.purpose) && boundedText(value.region)
    && boundedText(value.issuer_key_id) && positiveInteger(value.policy_version)
    && nonNegativeInteger(value.revocation_epoch));
}

function validLease(value: ConsentLease): boolean {
  return Boolean(value && typeof value === 'object'
    && boundedText(value.lease_id) && boundedText(value.tenant_id)
    && boundedText(value.subject_id) && CONSENT_SCOPES.has(value.scope)
    && boundedText(value.purpose) && boundedText(value.region)
    && positiveInteger(value.generation) && positiveInteger(value.policy_version)
    && nonNegativeInteger(value.revocation_epoch)
    && canonicalTimestamp(value.issued_at) !== null
    && canonicalTimestamp(value.expires_at) !== null
    && positiveInteger(value.monotonic_duration_ms)
    && boundedText(value.issuer_key_id) && /^[a-f0-9]{64}$/u.test(value.evidence_digest));
}

function digestEvidence(evidence: ConsentEvidence): string {
  const canonical = JSON.stringify({
    consent_id: evidence.consent_id,
    tenant_id: evidence.tenant_id,
    subject_id: evidence.subject_id,
    scope: evidence.scope,
    purpose: evidence.purpose,
    status: evidence.status,
    policy_version: evidence.policy_version,
    revocation_epoch: evidence.revocation_epoch,
    allowed_regions: [...evidence.allowed_regions].sort(),
    retention_policy: evidence.retention_policy,
    legal_hold_policy: evidence.legal_hold_policy,
    evidence_ref: evidence.evidence_ref,
    actor_id: evidence.actor_id,
    occurred_at: evidence.occurred_at,
    expires_at: evidence.expires_at,
    revision: evidence.revision
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function boundedStringSet(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64
    && value.every(boundedText) && new Set(value).size === value.length;
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

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function consentError(code: string): Error {
  return new Error(code);
}
