import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EncryptedVoiceAddressProtector,
  EnvVoiceSecretResolver,
  VoiceError,
  canonicalVoicePayloadHash,
  safeVoiceProviderPayload
} from '../src/agent-runtime/converact/voice/index.js';

const encryptionKey = Buffer.alloc(32, 0x11).toString('base64');
const hmacKey = Buffer.alloc(32, 0x22).toString('base64');

test('Voice address protection round trips normalized addresses without plaintext envelopes', async () => {
  const protector = new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: hmacKey });
  const cases = [
    { kind: 'e164' as const, input: '+86 138-0013-8000', normalized: '+8613800138000' },
    { kind: 'extension' as const, input: ' 1001 ', normalized: '1001' },
    { kind: 'sip_uri' as const, input: 'SIP:alice@EXAMPLE.test', normalized: 'sip:alice@example.test' }
  ];

  for (const item of cases) {
    const protectedAddress = await protector.protect('tenant-a', item.input, item.kind);
    assert.match(protectedAddress.ciphertext, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(protectedAddress.ciphertext.includes(item.normalized), false);
    assert.match(protectedAddress.hmac, /^[a-f0-9]{64}$/);
    assert.equal(
      await protector.reveal('tenant-a', protectedAddress.ciphertext, item.kind),
      item.normalized
    );
  }
});

test('Voice address HMAC is tenant scoped and encryption rejects cross-tenant reveal', async () => {
  const protector = new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: hmacKey });
  const first = await protector.protect('tenant-a', '+8613800138000', 'e164');
  const normalizedReplay = await protector.protect('tenant-a', '+86 138 0013 8000', 'e164');
  const foreign = await protector.protect('tenant-b', '+8613800138000', 'e164');

  assert.equal(first.hmac, normalizedReplay.hmac);
  assert.notEqual(first.ciphertext, normalizedReplay.ciphertext);
  assert.notEqual(first.hmac, foreign.hmac);
  await assert.rejects(
    () => protector.reveal('tenant-b', first.ciphertext, 'e164'),
    (error: unknown) => error instanceof VoiceError
      && error.code === 'address_decryption_failed'
      && !error.message.includes('+8613800138000')
  );
});

test('Voice address projection follows fixed redaction rules and errors disclose no input', async () => {
  const protector = new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: hmacKey });
  assert.equal((await protector.protect('tenant-a', '+8613800138000', 'e164')).redacted, '+86******8000');
  assert.equal((await protector.protect('tenant-a', '1001', 'extension')).redacted, '**01');
  assert.equal(
    (await protector.protect('tenant-a', 'sip:alice@example.test', 'sip_uri')).redacted,
    'sip:a***@example.test'
  );

  const invalid = 'not-a-private-number';
  await assert.rejects(
    () => protector.protect('tenant-a', invalid, 'e164'),
    (error: unknown) => error instanceof VoiceError
      && error.code === 'invalid_address'
      && !error.message.includes(invalid)
  );
});

test('Voice address protector requires canonical base64 32-byte root keys', () => {
  for (const key of ['', 'plain-text-key', Buffer.alloc(31).toString('base64'), `${encryptionKey}\n`]) {
    assert.throws(
      () => new EncryptedVoiceAddressProtector({ encryption_key: key, hmac_key: hmacKey }),
      (error: unknown) => error instanceof VoiceError && error.code === 'validation_failed'
    );
  }
  assert.throws(
    () => new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: 'not-base64' }),
    (error: unknown) => error instanceof VoiceError && error.code === 'validation_failed'
  );
  assert.throws(
    () => new EncryptedVoiceAddressProtector({ encryption_key: encryptionKey, hmac_key: encryptionKey }),
    (error: unknown) => error instanceof VoiceError && error.code === 'validation_failed'
  );
});

test('Voice secret resolver permits only purpose-bound env refs', async () => {
  const resolver = new EnvVoiceSecretResolver({
    env: {
      RUSTPBX_RWI_TOKEN: 'rwi-secret-value',
      RUSTPBX_WEBHOOK_KEY: 'webhook-secret-value',
      UNRELATED_SECRET: 'must-not-resolve'
    },
    allowlist: {
      rwi: ['RUSTPBX_RWI_TOKEN'],
      webhook: ['RUSTPBX_WEBHOOK_KEY']
    }
  });

  assert.equal(await resolver.resolve('env://RUSTPBX_RWI_TOKEN', 'rwi'), 'rwi-secret-value');
  await assert.rejects(() => resolver.resolve('rwi-secret-value', 'rwi'), hasVoiceCode('secret_ref_invalid'));
  await assert.rejects(() => resolver.resolve({ ref: 'env://RUSTPBX_RWI_TOKEN' }, 'rwi'), hasVoiceCode('secret_ref_invalid'));
  await assert.rejects(() => resolver.resolve('env://rustpbx_rwi_token', 'rwi'), hasVoiceCode('secret_ref_invalid'));
  await assert.rejects(() => resolver.resolve('env://RUSTPBX_WEBHOOK_KEY', 'rwi'), hasVoiceCode('secret_ref_invalid'));
  await assert.rejects(() => resolver.resolve('env://UNRELATED_SECRET', 'rwi'), hasVoiceCode('secret_ref_invalid'));

  const missing = new EnvVoiceSecretResolver({
    env: {},
    allowlist: { rwi: ['RUSTPBX_RWI_TOKEN'] }
  });
  await assert.rejects(
    () => missing.resolve('env://RUSTPBX_RWI_TOKEN', 'rwi'),
    (error: unknown) => error instanceof VoiceError
      && error.code === 'secret_unavailable'
      && !error.message.includes('rwi-secret-value')
  );
});

test('Canonical Voice payload hash is key-order stable and rejects non-JSON input', () => {
  const first = canonicalVoicePayloadHash({ z: 1, a: { y: true, x: ['one', null] } });
  const reordered = canonicalVoicePayloadHash({ a: { x: ['one', null], y: true }, z: 1 });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, canonicalVoicePayloadHash({ a: { x: [null, 'one'], y: true }, z: 1 }));
  assert.throws(
    () => canonicalVoicePayloadHash({ invalid: Number.NaN }),
    (error: unknown) => error instanceof VoiceError && error.code === 'provider_payload_invalid'
  );
});

test('Safe Voice provider payload recursively removes secrets and bounds untrusted data', () => {
  const circular: Record<string, unknown> = { event_id: 'event-1' };
  circular.self = circular;
  const safe = safeVoiceProviderPayload({
    event_id: 'event-1',
    state: 'ringing',
    authorization: 'Bearer provider-secret',
    headers: {
      cookie: 'session=private-cookie',
      'x-api-key': 'private-api-key'
    },
    body: 'private raw body',
    sdp: 'v=0 private SDP',
    from_number: '+8613800138000',
    nested: {
      password: 'private-password',
      value: 'x'.repeat(400),
      list: Array.from({ length: 40 }, (_, index) => index)
    },
    circular,
    untrusted: JSON.parse('{"__proto__":{"polluted":true},"constructor":{"secret":"value"}}')
  }, {
    max_depth: 4,
    max_string_length: 32,
    max_array_length: 5,
    max_object_entries: 20
  });
  const serialized = JSON.stringify(safe);

  assert.equal(safe.event_id, 'event-1');
  assert.equal(safe.state, 'ringing');
  for (const forbidden of [
    'provider-secret',
    'private-cookie',
    'private-api-key',
    'private raw body',
    'private SDP',
    '+8613800138000',
    'private-password'
  ]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.equal(serialized.includes('[redacted]'), true);
  assert.equal(serialized.includes('[circular]'), true);
  assert.equal((safe.nested as { value: string }).value.length <= 32, true);
  assert.deepEqual((safe.nested as { list: unknown[] }).list, [0, 1, 2, 3, 4]);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

function hasVoiceCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof VoiceError && error.code === code;
}
