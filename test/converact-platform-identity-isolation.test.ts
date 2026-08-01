import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluatePlatformAccess,
  type PlatformIdentityClaims
} from '../src/agent-runtime/converact/platform-foundation/identity.js';

const wallNow = new Date('2026-08-01T12:00:00.000Z');

function validClaims(
  overrides: Partial<PlatformIdentityClaims> = {}
): PlatformIdentityClaims {
  return {
    tenant_id: 'tenant-a',
    identity_id: 'user-a',
    identity_kind: 'human',
    session_id: 'session-a',
    token_id: 'token-a',
    issuer: 'https://identity.converact.internal',
    audience: ['converact-core'],
    key_id: 'key-v7',
    issued_at: '2026-08-01T11:59:00.000Z',
    not_before: '2026-08-01T11:59:00.000Z',
    expires_at: '2026-08-01T12:05:00.000Z',
    policy_version: 12,
    revocation_epoch: 4,
    role: 'operator',
    capabilities: ['recording.start'],
    purpose: ['support_evidence'],
    credential_strength: 'signed_token',
    ...overrides
  };
}

function evaluate(claims: PlatformIdentityClaims) {
  return evaluatePlatformAccess({
    claims,
    resource_tenant_id: 'tenant-a',
    required_audience: 'converact-core',
    required_capability: 'recording.start',
    required_purpose: 'support_evidence',
    current_policy_version: 12,
    current_revocation_epoch: 4,
    wall_now: wallNow
  });
}

test('valid human identity is allowed for its exact tenant capability and purpose', () => {
  assert.deepEqual(evaluate(validClaims()), { allowed: true });
});

test('cross-tenant access fails closed before a store call', () => {
  assert.deepEqual(
    evaluatePlatformAccess({
      claims: validClaims(),
      resource_tenant_id: 'tenant-b',
      required_audience: 'converact-core',
      required_capability: 'recording.start',
      required_purpose: 'support_evidence',
      current_policy_version: 12,
      current_revocation_epoch: 4,
      wall_now: wallNow
    }),
    { allowed: false, reason: 'tenant_mismatch' }
  );
});

test('blank or malformed required identity claims fail closed', () => {
  for (const field of [
    'tenant_id', 'identity_id', 'session_id', 'token_id', 'issuer', 'key_id', 'role'
  ] as const) {
    assert.deepEqual(
      evaluate(validClaims({ [field]: '' })),
      { allowed: false, reason: 'claims_invalid' },
      field
    );
  }
  assert.deepEqual(
    evaluate(validClaims({ identity_kind: 'root' as PlatformIdentityClaims['identity_kind'] })),
    { allowed: false, reason: 'claims_invalid' }
  );
});

test('audience capability and purpose are independently required', () => {
  assert.deepEqual(
    evaluate(validClaims({ audience: ['other-service'] })),
    { allowed: false, reason: 'audience_mismatch' }
  );
  assert.deepEqual(
    evaluate(validClaims({ capabilities: ['recording.read'] })),
    { allowed: false, reason: 'capability_denied' }
  );
  assert.deepEqual(
    evaluate(validClaims({ purpose: ['quality_training'] })),
    { allowed: false, reason: 'purpose_denied' }
  );
});

test('not-before and expiry windows fail closed', () => {
  assert.deepEqual(
    evaluate(validClaims({ not_before: '2026-08-01T12:00:00.001Z' })),
    { allowed: false, reason: 'not_yet_valid' }
  );
  assert.deepEqual(
    evaluate(validClaims({ expires_at: '2026-08-01T12:00:00.000Z' })),
    { allowed: false, reason: 'expired' }
  );
});

test('stale policy and revocation epochs fail closed', () => {
  assert.deepEqual(
    evaluate(validClaims({ policy_version: 11 })),
    { allowed: false, reason: 'stale_policy' }
  );
  assert.deepEqual(
    evaluate(validClaims({ revocation_epoch: 3 })),
    { allowed: false, reason: 'stale_revocation' }
  );
});

test('service workload edge and provider identities require mTLS-equivalent strength', () => {
  for (const identityKind of ['service', 'workload', 'edge', 'provider'] as const) {
    assert.deepEqual(
      evaluate(validClaims({ identity_kind: identityKind })),
      { allowed: false, reason: 'strong_service_identity_required' },
      identityKind
    );
    assert.deepEqual(
      evaluate(validClaims({ identity_kind: identityKind, credential_strength: 'mtls' })),
      { allowed: true },
      identityKind
    );
  }
});

test('claim arrays are bounded and duplicate-free', () => {
  assert.deepEqual(
    evaluate(validClaims({ capabilities: Array.from({ length: 65 }, (_, index) => `cap-${index}`) })),
    { allowed: false, reason: 'claims_invalid' }
  );
  assert.deepEqual(
    evaluate(validClaims({ purpose: ['support_evidence', 'support_evidence'] })),
    { allowed: false, reason: 'claims_invalid' }
  );
});
