import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DialogRecoveryCapsuleCodec,
  DialogRecoveryCapsuleError,
  nativeCallRecoveryBindingSha256,
  type DialogRecoveryCapsuleBinding,
  type DialogRecoveryCapsulePayload,
  type NativeCallRecoveryBinding
} from '../src/agent-runtime/converact/voice/dialog-recovery-capsule.js';

const KEY_A = Buffer.alloc(32, 0x11);
const KEY_B = Buffer.alloc(32, 0x22);

function binding(
  overrides: Partial<DialogRecoveryCapsuleBinding> = {}
): DialogRecoveryCapsuleBinding {
  return {
    tenant_id: 'tenant-a',
    cell_id: 'cell-a',
    dialog_id: 'dialog-caller',
    owner_epoch: 7,
    sequence: 4,
    ...overrides
  };
}

function payload(
  overrides: Partial<DialogRecoveryCapsulePayload> = {}
): DialogRecoveryCapsulePayload {
  return {
    schema_version: 1,
    call_session_ref: 'call-session-a',
    interaction_id: 'interaction-a',
    dialog_id: 'dialog-caller',
    peer_dialog_id: 'dialog-callee',
    leg: 'caller',
    dialog_role: 'uas',
    raw_call_id: 'caller-call-id@example.invalid',
    local_tag: 'caller-local-tag',
    remote_tag: 'caller-remote-tag',
    from_uri: 'sip:+8613800138000@example.invalid',
    to_uri: 'sip:agent-1001@example.invalid',
    local_contact_uri: 'sip:edge-a@example.internal:5061;transport=tls',
    remote_uri: 'sip:+8613800138000@example.invalid',
    remote_contact_uri: 'sip:+8613800138000@198.51.100.10:5060',
    route_set: [
      'sip:edge-a@example.internal:5061;transport=tls;lr'
    ],
    local_cseq: 21,
    remote_cseq: 17,
    supports_100rel: true,
    media_reservation_id: 'reservation-caller',
    cdr_sequence: 12,
    ...overrides
  };
}

function codec() {
  return new DialogRecoveryCapsuleCodec({
    current: { key_id: 'recovery-2026-07', key: KEY_A },
    previous: { key_id: 'recovery-2026-06', key: KEY_B },
    random_bytes: (size) => Buffer.alloc(size, 0x33)
  });
}

function nativeCallBinding(
  overrides: Partial<NativeCallRecoveryBinding> = {}
): NativeCallRecoveryBinding {
  return {
    schema_id: 'converact.native-call-recovery-binding',
    schema_version: '1.0.0',
    tenant_id: 'tenant-a',
    call_id: 'call_7f906e5acdb6ff58c90d54566ced341f',
    interaction_id: 'interaction_2f76cfe99ecf8daf6972aa0734d860b4',
    provider_call_id: 'call-session-a',
    owner_epoch: '7',
    generation: '11',
    revision: '13',
    ...overrides
  };
}

test('recovery capsule round-trips exact SIP restoration state without plaintext leakage', () => {
  const value = payload();
  const envelope = codec().seal(value, binding());
  const wire = JSON.stringify(envelope);

  assert.equal(envelope.algorithm, 'A256GCM');
  assert.equal(envelope.key_id, 'recovery-2026-07');
  assert.doesNotMatch(wire, /13800138000|caller-call-id|reservation-caller/);
  assert.deepEqual(codec().open(envelope, binding()), value);
});

test('capsule AAD binds tenant, Cell, dialog, owner epoch and sequence', () => {
  const envelope = codec().seal(payload(), binding());
  for (const changed of [
    binding({ tenant_id: 'tenant-b' }),
    binding({ cell_id: 'cell-b' }),
    binding({ dialog_id: 'dialog-callee' }),
    binding({ owner_epoch: 8 }),
    binding({ sequence: 5 })
  ]) {
    assert.throws(
      () => codec().open(envelope, changed),
      (error) => code(error) === 'dialog_recovery_capsule_authentication_failed'
    );
  }
});

test('capsule rejects tampering, unknown keys and noncanonical envelopes', () => {
  const envelope = codec().seal(payload(), binding());
  const tampered = {
    ...envelope,
    ciphertext: `${envelope.ciphertext.slice(0, -1)}A`
  };
  assert.throws(
    () => codec().open(tampered, binding()),
    (error) => code(error) === 'dialog_recovery_capsule_authentication_failed'
  );
  assert.throws(
    () => codec().open({ ...envelope, key_id: 'unknown-key' }, binding()),
    (error) => code(error) === 'dialog_recovery_capsule_key_unknown'
  );
  assert.throws(
    () => codec().open({ ...envelope, nonce: `${envelope.nonce}=` }, binding()),
    (error) => code(error) === 'dialog_recovery_capsule_invalid'
  );
});

test('capsule validates bounded SIP state and rotates keys without accepting bad key sizes', () => {
  const oldCodec = new DialogRecoveryCapsuleCodec({
    current: { key_id: 'recovery-2026-06', key: KEY_B },
    random_bytes: (size) => Buffer.alloc(size, 0x44)
  });
  const oldEnvelope = oldCodec.seal(payload(), binding());
  assert.deepEqual(codec().open(oldEnvelope, binding()), payload());

  assert.throws(
    () => codec().seal(payload({ raw_call_id: `call-${'x'.repeat(1_024)}` }), binding()),
    (error) => code(error) === 'dialog_recovery_capsule_invalid'
  );
  assert.throws(
    () => new DialogRecoveryCapsuleCodec({
      current: { key_id: 'short-key', key: Buffer.alloc(31) }
    }),
    (error) => code(error) === 'dialog_recovery_capsule_key_invalid'
  );
});

test('capsule preserves the executable per-leg media reservation identity', () => {
  const value = payload();
  value.media_reservation_id = 'reservation-a/callee';
  const capsuleBinding = binding();
  const envelope = codec().seal(value, capsuleBinding);

  assert.equal(
    codec().open(envelope, capsuleBinding).media_reservation_id,
    'reservation-a/callee'
  );
});

test('capsule accepts Rust timing and route revision fields without changing legacy payloads', () => {
  const rustPayload = payload({
    started_at: '2026-07-27T01:00:00.000Z',
    answered_at: '2026-07-27T01:00:02.000Z',
    route_snapshot_revision: 42
  });
  const rustEnvelope = codec().seal(rustPayload, binding());
  assert.deepEqual(codec().open(rustEnvelope, binding()), rustPayload);

  const legacyPayload = payload();
  const legacyEnvelope = codec().seal(legacyPayload, binding());
  assert.deepEqual(codec().open(legacyEnvelope, binding()), legacyPayload);
  assert.equal('started_at' in codec().open(legacyEnvelope, binding()), false);
  assert.equal('route_snapshot_revision' in codec().open(legacyEnvelope, binding()), false);
});

test('capsule rejects invalid Rust timing and route revision fields', () => {
  for (const value of [
    payload({
      started_at: null,
      answered_at: '2026-07-27T01:00:02.000Z',
      route_snapshot_revision: 42
    }),
    payload({
      started_at: '2026-07-27T01:00:03.000Z',
      answered_at: '2026-07-27T01:00:02.000Z',
      route_snapshot_revision: 42
    }),
    payload({
      started_at: 'not-a-timestamp',
      answered_at: null,
      route_snapshot_revision: 42
    }),
    payload({
      started_at: null,
      answered_at: null,
      route_snapshot_revision: 0
    })
  ]) {
    assert.throws(
      () => codec().seal(value, binding()),
      (error) => code(error) === 'dialog_recovery_capsule_invalid'
    );
  }
});

test('capsule v2 freezes the canonical Native Call recovery binding', () => {
  const value = payload({
    schema_version: 2,
    native_call_binding: nativeCallBinding()
  });
  const envelope = codec().seal(value, binding());
  assert.deepEqual(codec().open(envelope, binding()), value);

  for (const invalid of [
    payload({ schema_version: 2 }),
    payload({ native_call_binding: nativeCallBinding() }),
    payload({
      schema_version: 2,
      native_call_binding: nativeCallBinding({ provider_call_id: 'other-call' })
    }),
    payload({
      schema_version: 2,
      native_call_binding: nativeCallBinding({ owner_epoch: '07' })
    }),
    payload({
      schema_version: 2,
      native_call_binding: nativeCallBinding({
        generation: 11 as unknown as string
      })
    }),
    payload({
      schema_version: 2,
      native_call_binding: nativeCallBinding({
        revision: 13 as unknown as string
      })
    }),
    payload({
      schema_version: 2,
      native_call_binding: {
        ...nativeCallBinding(),
        unexpected: true
      } as NativeCallRecoveryBinding
    })
  ]) {
    assert.throws(
      () => codec().seal(invalid, binding()),
      (error) => code(error) === 'dialog_recovery_capsule_invalid'
    );
  }

  for (const mismatchedAuthority of [
    binding({ tenant_id: 'tenant-b' }),
    binding({ owner_epoch: 8 })
  ]) {
    assert.throws(
      () => codec().seal(value, mismatchedAuthority),
      (error) => code(error) === 'dialog_recovery_capsule_invalid'
    );
  }
});

test('Native Call recovery binding hash matches the Rust golden vector', () => {
  assert.equal(
    nativeCallRecoveryBindingSha256(nativeCallBinding()),
    'aa731eba74f64cc5b2eb67d10ea8da044e87cb87b30e5b0550b8a7dfaf759871'
  );
  assert.throws(
    () => nativeCallRecoveryBindingSha256(
      null as unknown as NativeCallRecoveryBinding
    ),
    /invalid recovery capsule/
  );
});

function code(error: unknown): string {
  return error instanceof DialogRecoveryCapsuleError ? error.code : '';
}
