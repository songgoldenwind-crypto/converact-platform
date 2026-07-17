import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EncryptedNotificationProtector,
  NotificationError
} from '../src/agent-runtime/ivekit/notifications/index.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const hmacKey = Buffer.alloc(32, 9).toString('base64');

test('notification protector encrypts tenant-bound content and preserves canonical hashes', async () => {
  const protector = new EncryptedNotificationProtector({
    encryption_key: encryptionKey,
    hmac_key: hmacKey
  });
  const first = await protector.protectContent('tenant-a', { body: 'hello', subject: 'notice' });
  const second = await protector.protectContent('tenant-a', { subject: 'notice', body: 'hello' });

  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.hash, second.hash);
  assert.deepEqual(await protector.revealContent('tenant-a', first.ciphertext), {
    body: 'hello',
    subject: 'notice'
  });
  await assert.rejects(
    protector.revealContent('tenant-b', first.ciphertext),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'secret_unavailable'
  );
});

test('notification protector normalizes, hashes and redacts channel recipients', async () => {
  const protector = new EncryptedNotificationProtector({
    encryption_key: encryptionKey,
    hmac_key: hmacKey
  });
  const email = await protector.protectRecipient('tenant-a', 'email', ' Alice@Example.COM ');
  const sameEmail = await protector.protectRecipient('tenant-a', 'email', 'Alice@example.com');
  const sms = await protector.protectRecipient('tenant-a', 'sms', '+86 138-0013-8000');

  assert.equal(email.hmac, sameEmail.hmac);
  assert.equal(email.redacted, 'A***@example.com');
  assert.equal(await protector.revealRecipient('tenant-a', 'email', email.ciphertext), 'Alice@example.com');
  assert.equal(sms.redacted, '+86******8000');
  assert.equal(await protector.revealRecipient('tenant-a', 'sms', sms.ciphertext), '+8613800138000');
  assert.notEqual(email.hmac, sms.hmac);
});

test('notification protector rejects malformed recipients and unsafe content', async () => {
  const protector = new EncryptedNotificationProtector({
    encryption_key: encryptionKey,
    hmac_key: hmacKey
  });

  await assert.rejects(
    protector.protectRecipient('tenant-a', 'email', 'not-an-email'),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'validation_failed'
  );
  await assert.rejects(
    protector.protectRecipient('tenant-a', 'sms', '10086'),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'validation_failed'
  );
  await assert.rejects(
    protector.protectContent('tenant-a', { value: undefined }),
    (error: unknown) => error instanceof NotificationError
      && error.code === 'validation_failed'
  );
});
