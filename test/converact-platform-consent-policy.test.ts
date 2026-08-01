import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlatformClock } from '../src/agent-runtime/converact/platform-foundation/clock.js';
import {
  evaluateConsentLease,
  issueConsentLease,
  type ConsentEvidence,
  type ConsentLeaseRequest
} from '../src/agent-runtime/converact/platform-foundation/policy.js';

class MutableClock implements PlatformClock {
  constructor(public wall: Date, public monotonic: number) {}
  wallNow(): Date { return new Date(this.wall); }
  monotonicNowMs(): number { return this.monotonic; }
}

function evidence(overrides: Partial<ConsentEvidence> = {}): ConsentEvidence {
  return {
    consent_id: 'consent-a',
    tenant_id: 'tenant-a',
    subject_id: 'customer-a',
    scope: 'recording',
    purpose: 'support_evidence',
    status: 'granted',
    policy_version: 7,
    revocation_epoch: 3,
    allowed_regions: ['us-east'],
    retention_policy: 'support-30d',
    legal_hold_policy: 'tenant-resource-scoped',
    evidence_ref: 'evidence-a',
    actor_id: 'customer-a',
    occurred_at: '2026-08-01T11:59:00.000Z',
    expires_at: '2026-08-01T12:10:00.000Z',
    revision: 2,
    ...overrides
  };
}

function request(overrides: Partial<ConsentLeaseRequest> = {}): ConsentLeaseRequest {
  return {
    lease_id: 'lease-a',
    tenant_id: 'tenant-a',
    subject_id: 'customer-a',
    scope: 'recording',
    purpose: 'support_evidence',
    region: 'us-east',
    ttl_ms: 60_000,
    policy_version: 7,
    revocation_epoch: 3,
    issuer_key_id: 'consent-key-v4',
    ...overrides
  };
}

function clock(): MutableClock {
  return new MutableClock(new Date('2026-08-01T12:00:00.000Z'), 5_000);
}

test('exact granted consent issues a bounded active lease', () => {
  const now = clock();
  const lease = issueConsentLease({ evidence: evidence(), request: request(), clock: now, max_ttl_ms: 300_000 });

  assert.equal(lease.scope, 'recording');
  assert.equal(lease.generation, 2);
  assert.equal(lease.expires_at, '2026-08-01T12:01:00.000Z');
  assert.match(lease.evidence_digest, /^[a-f0-9]{64}$/);
  assert.equal(evaluateConsentLease({
    lease,
    clock: now,
    current_policy_version: 7,
    current_revocation_epoch: 3
  }), 'active');
});

test('pending denied revoked and expired consent cannot issue a lease', () => {
  for (const status of ['pending', 'denied', 'revoked'] as const) {
    assert.throws(
      () => issueConsentLease({
        evidence: evidence({ status }), request: request(), clock: clock(), max_ttl_ms: 300_000
      }),
      /consent_not_granted/,
      status
    );
  }
  assert.throws(
    () => issueConsentLease({
      evidence: evidence({ expires_at: '2026-08-01T12:00:00.000Z' }),
      request: request(),
      clock: clock(),
      max_ttl_ms: 300_000
    }),
    /consent_expired/
  );
});

test('tenant subject scope purpose and region must match independently', () => {
  for (const [field, value, code] of [
    ['tenant_id', 'tenant-b', 'consent_tenant_mismatch'],
    ['subject_id', 'customer-b', 'consent_subject_mismatch'],
    ['scope', 'translation', 'consent_scope_mismatch'],
    ['purpose', 'quality_training', 'consent_purpose_mismatch'],
    ['region', 'eu-west', 'consent_region_denied']
  ] as const) {
    assert.throws(
      () => issueConsentLease({
        evidence: evidence(),
        request: request({ [field]: value }),
        clock: clock(),
        max_ttl_ms: 300_000
      }),
      new RegExp(code),
      field
    );
  }
});

test('recording consent cannot authorize another processing capability', () => {
  assert.throws(
    () => issueConsentLease({
      evidence: evidence(),
      request: request({ scope: 'translation' }),
      clock: clock(),
      max_ttl_ms: 300_000
    }),
    /consent_scope_mismatch/
  );
});

test('lease TTL is bounded by platform policy and evidence expiry', () => {
  assert.throws(
    () => issueConsentLease({
      evidence: evidence(), request: request({ ttl_ms: 300_001 }), clock: clock(), max_ttl_ms: 300_000
    }),
    /consent_ttl_invalid/
  );
  assert.throws(
    () => issueConsentLease({
      evidence: evidence({ expires_at: '2026-08-01T12:00:30.000Z' }),
      request: request({ ttl_ms: 60_000 }),
      clock: clock(),
      max_ttl_ms: 300_000
    }),
    /consent_expires_before_lease/
  );
});

test('policy and revocation changes detach only the governed capability', () => {
  const now = clock();
  const lease = issueConsentLease({ evidence: evidence(), request: request(), clock: now, max_ttl_ms: 300_000 });
  assert.equal(evaluateConsentLease({
    lease, clock: now, current_policy_version: 8, current_revocation_epoch: 3
  }), 'stale_policy');
  assert.equal(evaluateConsentLease({
    lease, clock: now, current_policy_version: 7, current_revocation_epoch: 4
  }), 'revoked');
});

test('stale policy and revocation snapshots cannot issue a lease', () => {
  assert.throws(
    () => issueConsentLease({
      evidence: evidence(), request: request({ policy_version: 8 }), clock: clock(), max_ttl_ms: 300_000
    }),
    /consent_policy_mismatch/
  );
  assert.throws(
    () => issueConsentLease({
      evidence: evidence(), request: request({ revocation_epoch: 4 }), clock: clock(), max_ttl_ms: 300_000
    }),
    /consent_revocation_mismatch/
  );
});

test('a serialized lease cannot carry a monotonic instant across restart', () => {
  const now = clock();
  const lease = issueConsentLease({ evidence: evidence(), request: request(), clock: now, max_ttl_ms: 300_000 });
  const restored = JSON.parse(JSON.stringify(lease));
  assert.equal(evaluateConsentLease({
    lease: restored,
    clock: now,
    current_policy_version: 7,
    current_revocation_epoch: 3
  }), 'restart_reauthorization_required');
});

test('wall jumps do not extend a lease and monotonic reversal requires reauthorization', () => {
  const now = clock();
  const lease = issueConsentLease({ evidence: evidence(), request: request(), clock: now, max_ttl_ms: 300_000 });
  now.wall = new Date('2036-08-01T12:00:00.000Z');
  now.monotonic = 64_999;
  assert.equal(evaluateConsentLease({
    lease, clock: now, current_policy_version: 7, current_revocation_epoch: 3
  }), 'active');
  now.wall = new Date('2016-08-01T12:00:00.000Z');
  now.monotonic = 65_000;
  assert.equal(evaluateConsentLease({
    lease, clock: now, current_policy_version: 7, current_revocation_epoch: 3
  }), 'expired');
  now.monotonic = 4_999;
  assert.equal(evaluateConsentLease({
    lease, clock: now, current_policy_version: 7, current_revocation_epoch: 3
  }), 'restart_reauthorization_required');
});
