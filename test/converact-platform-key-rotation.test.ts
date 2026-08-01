import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSafeSecretSink,
  decideKeyTransition,
  evaluateCertificateBinding,
  evaluateNativeSourceGate,
  resolveKeyUsage,
  type CertificateBindingInput,
  type KeyTransitionCommand,
  type KeyVersion,
  type NativeSourceGateInput
} from '../src/agent-runtime/converact/platform-foundation/key-lifecycle.js';

function key(overrides: Partial<KeyVersion> = {}): KeyVersion {
  return {
    key_ring_id: 'internal-mtls',
    key_id: 'internal-mtls-v4',
    key_version: 4,
    purpose: 'mtls',
    state: 'generated',
    material_ref: 'pki://converact/internal-mtls/v4',
    revision: 1,
    writer_id: 'key-controller-a',
    writer_epoch: 6,
    not_before: '2026-08-01T12:00:00.000Z',
    expires_at: '2026-08-02T12:00:00.000Z',
    state_changed_at: '2026-08-01T12:00:00.000Z',
    overlap_until: null,
    last_command_id: null,
    last_command_digest: null,
    ...overrides
  };
}

function command(overrides: Partial<KeyTransitionCommand> = {}): KeyTransitionCommand {
  return {
    command_id: 'key-command-a',
    command_digest: 'a'.repeat(64),
    expected_revision: 1,
    target_state: 'staged',
    writer_id: 'key-controller-a',
    writer_epoch: 6,
    effective_at: '2026-08-01T12:01:00.000Z',
    overlap_until: null,
    kms_available: true,
    pki_available: true,
    plaintext_fallback_requested: false,
    ...overrides
  };
}

test('key lifecycle permits only the frozen forward and terminal graph', () => {
  assert.equal(decideKeyTransition(key(), command()), 'apply');
  assert.equal(decideKeyTransition(key(), command({ target_state: 'active' })), 'invalid_transition');
  assert.equal(decideKeyTransition(key({ state: 'staged' }), command({ target_state: 'active' })), 'apply');
  assert.equal(decideKeyTransition(key({ state: 'active' }), command({
    target_state: 'retiring', overlap_until: '2026-08-01T13:00:00.000Z'
  })), 'apply');
  assert.equal(decideKeyTransition(key({
    state: 'retiring', overlap_until: '2026-08-01T13:00:00.000Z'
  }), command({
    target_state: 'expired', effective_at: '2026-08-02T12:00:00.000Z'
  })), 'apply');
  assert.equal(decideKeyTransition(key({ state: 'active' }), command({ target_state: 'revoked' })), 'apply');
  assert.equal(decideKeyTransition(key({ state: 'revoked' }), command({ target_state: 'destroyed' })), 'apply');
  assert.equal(decideKeyTransition(key({ state: 'destroyed' }), command({ target_state: 'active' })), 'invalid_transition');
});

test('command replay is deterministic and stale or conflicting writers are fenced', () => {
  const current = key({
    state: 'staged', revision: 2, last_command_id: 'key-command-a', last_command_digest: 'a'.repeat(64)
  });
  assert.equal(decideKeyTransition(current, command({ expected_revision: 1 })), 'replay');
  assert.equal(decideKeyTransition(current, command({
    expected_revision: 1, command_digest: 'b'.repeat(64)
  })), 'conflict');
  assert.equal(decideKeyTransition(current, command({
    command_id: 'key-command-b', command_digest: 'b'.repeat(64), expected_revision: 2, writer_epoch: 5,
    target_state: 'active'
  })), 'conflict');
  assert.equal(decideKeyTransition(current, command({
    command_id: 'key-command-b', command_digest: 'b'.repeat(64), expected_revision: 1,
    target_state: 'active'
  })), 'conflict');
});

test('KMS and PKI failure never downgrade to plaintext', () => {
  assert.equal(decideKeyTransition(key(), command({ kms_available: false })), 'invalid_transition');
  assert.equal(decideKeyTransition(key(), command({ pki_available: false })), 'invalid_transition');
  assert.equal(decideKeyTransition(key(), command({ plaintext_fallback_requested: true })), 'invalid_transition');
  assert.equal(decideKeyTransition(key({ state: 'active' }), command({
    target_state: 'revoked', kms_available: false, pki_available: false
  })), 'apply');
});

test('rotation is dual-read single-write with a bounded overlap', () => {
  const oldKey = key({
    key_id: 'internal-mtls-v3', key_version: 3, state: 'retiring',
    state_changed_at: '2026-08-01T12:00:00.000Z', overlap_until: '2026-08-01T12:10:00.000Z'
  });
  const activeKey = key({
    state: 'active', state_changed_at: '2026-08-01T12:00:00.000Z'
  });
  assert.deepEqual(resolveKeyUsage({
    keys: [oldKey, activeKey], wall_now: new Date('2026-08-01T12:05:00.000Z'), max_overlap_ms: 3_600_000
  }), {
    write_key_id: 'internal-mtls-v4',
    read_key_ids: ['internal-mtls-v4', 'internal-mtls-v3']
  });
  assert.deepEqual(resolveKeyUsage({
    keys: [oldKey, activeKey], wall_now: new Date('2026-08-01T12:11:00.000Z'), max_overlap_ms: 3_600_000
  }), {
    write_key_id: 'internal-mtls-v4',
    read_key_ids: ['internal-mtls-v4']
  });
  assert.throws(() => resolveKeyUsage({
    keys: [{ ...oldKey, overlap_until: '2026-08-02T12:01:00.000Z' }, activeKey],
    wall_now: new Date('2026-08-01T12:05:00.000Z'), max_overlap_ms: 3_600_000
  }), /key_overlap_invalid/);
  assert.throws(() => resolveKeyUsage({
    keys: [
      oldKey,
      key({
        key_id: 'internal-mtls-v2', key_version: 2, state: 'retiring',
        state_changed_at: '2026-08-01T12:00:00.000Z',
        overlap_until: '2026-08-01T12:10:00.000Z'
      }),
      activeKey
    ],
    wall_now: new Date('2026-08-01T12:05:00.000Z'), max_overlap_ms: 3_600_000
  }), /key_read_authority_invalid/);
});

function certificate(overrides: Partial<CertificateBindingInput> = {}): CertificateBindingInput {
  return {
    ca_trusted: true,
    san_service_id: 'spiffe://converact/service/voice-edge',
    expected_san_service_id: 'spiffe://converact/service/voice-edge',
    service_identity: 'voice-edge',
    expected_service_identity: 'voice-edge',
    audience: ['platform-core'],
    required_audience: 'platform-core',
    key_version: 4,
    minimum_key_version: 4,
    not_before: '2026-08-01T11:00:00.000Z',
    expires_at: '2026-08-01T13:00:00.000Z',
    revoked: false,
    wall_now: new Date('2026-08-01T12:00:00.000Z'),
    ...overrides
  };
}

test('certificate binding needs SAN service audience version validity and revocation checks', () => {
  assert.deepEqual(evaluateCertificateBinding(certificate()), { allowed: true });
  for (const [overrides, reason] of [
    [{ ca_trusted: false }, 'ca_untrusted'],
    [{ san_service_id: 'spiffe://converact/service/other' }, 'san_mismatch'],
    [{ service_identity: 'other' }, 'service_mismatch'],
    [{ audience: ['other'] }, 'audience_mismatch'],
    [{ key_version: 3 }, 'key_version_stale'],
    [{ expires_at: '2026-08-01T12:00:00.000Z' }, 'certificate_expired'],
    [{ revoked: true }, 'certificate_revoked']
  ] as const) {
    assert.deepEqual(evaluateCertificateBinding(certificate(overrides)), { allowed: false, reason });
  }
});

test('raw key material is limited to KMS or locked memory sinks', () => {
  assert.doesNotThrow(() => assertSafeSecretSink({ sink: 'kms', contains_raw_material: true }));
  assert.doesNotThrow(() => assertSafeSecretSink({ sink: 'locked_memory', contains_raw_material: true }));
  for (const sink of ['database', 'event', 'log', 'metric', 'prompt', 'evidence', 'core_dump'] as const) {
    assert.throws(() => assertSafeSecretSink({ sink, contains_raw_material: true }), /raw_secret_sink_forbidden/);
    assert.doesNotThrow(() => assertSafeSecretSink({ sink, contains_raw_material: false }));
  }
});

function nativeGate(overrides: Partial<NativeSourceGateInput> = {}): NativeSourceGateInput {
  return {
    source_sha256: 'a'.repeat(64),
    expected_source_sha256: 'a'.repeat(64),
    abi_reviewed: true,
    bounded_memory: true,
    zeroize: true,
    core_dump_disabled: true,
    fuzz_or_sanitizer_evidence: true,
    independent_fault_isolation: true,
    ...overrides
  };
}

test('native or unsafe slices require every supply-chain and isolation gate', () => {
  assert.deepEqual(evaluateNativeSourceGate(nativeGate()), { enabled: true });
  assert.deepEqual(evaluateNativeSourceGate(nativeGate({ source_sha256: 'b'.repeat(64) })), {
    enabled: false, reason: 'source_mismatch'
  });
  for (const field of [
    'abi_reviewed', 'bounded_memory', 'zeroize', 'core_dump_disabled',
    'fuzz_or_sanitizer_evidence', 'independent_fault_isolation'
  ] as const) {
    const result = evaluateNativeSourceGate(nativeGate({ [field]: false }));
    assert.equal(result.enabled, false, field);
  }
});
