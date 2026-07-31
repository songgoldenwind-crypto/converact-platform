import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SmtpNotificationProvider,
  type NotificationProviderDeliveryInput
} from '../src/agent-runtime/ivekit/notifications/index.js';

test('SMTP provider sends a stable message and keeps provider acceptance distinct from delivery', async () => {
  let mail: Record<string, unknown> | null = null;
  const provider = new SmtpNotificationProvider({
    profile_id: 'smtp-a',
    from: 'notice@example.com',
    reply_to: 'support@example.com',
    transport: {
      async sendMail(input) {
        mail = input;
        return {
          accepted: ['alice@example.com'], rejected: [],
          messageId: '<provider-message@example.com>', response: '250 queued'
        };
      }
    }
  });

  const result = await provider.deliver(deliveryInput());
  assert.deepEqual(result, {
    status: 'accepted',
    provider_message_id: '<provider-message@example.com>',
    receipt: { accepted_count: 1, rejected_count: 0, smtp_status: 250 }
  });
  assert.equal(mail?.to, 'alice@example.com');
  assert.equal(mail?.from, 'notice@example.com');
  assert.equal(mail?.replyTo, 'support@example.com');
  assert.equal(mail?.subject, 'Account notice');
  assert.equal(mail?.messageId, `<delivery-a.${'d'.repeat(16)}@example.com>`);
  assert.deepEqual(mail?.headers, {
    'X-IveKit-Delivery': 'delivery-a',
    'X-IveKit-Event': 'example.created',
    'X-IveKit-Idempotency-Key': `notify_${'d'.repeat(64)}`
  });
});

test('SMTP provider classifies rejected recipients and known SMTP failures', async () => {
  const create = (sendMail: (input: Record<string, unknown>) => Promise<any>) =>
    new SmtpNotificationProvider({ from: 'notice@example.com', transport: { sendMail } });

  const rejected = await create(async () => ({
    accepted: [], rejected: ['alice@example.com'], response: '550 invalid'
  })).deliver(deliveryInput());
  assert.equal(rejected.status, 'terminal_failure');
  assert.equal(rejected.error_code, 'invalid_recipient');

  const temporary = await create(async () => {
    throw Object.assign(new Error('temporary'), { responseCode: 451 });
  }).deliver(deliveryInput());
  assert.equal(temporary.status, 'retryable_failure');
  assert.equal(temporary.error_code, 'provider_unavailable');

  const auth = await create(async () => {
    throw Object.assign(new Error('auth'), { responseCode: 535 });
  }).deliver(deliveryInput());
  assert.equal(auth.status, 'terminal_failure');
  assert.equal(auth.error_code, 'provider_auth_failed');

  const network = await create(async () => {
    throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  }).deliver(deliveryInput());
  assert.equal(network.status, 'uncertain');
});

test('SMTP provider rejects header injection and oversized or empty bodies before transport', async () => {
  let calls = 0;
  const provider = new SmtpNotificationProvider({
    from: 'notice@example.com',
    transport: { async sendMail() { calls += 1; return { accepted: [] }; } }
  });
  assert.equal((await provider.deliver(deliveryInput({ subject: 'Bad\r\nBcc: x@example.com', text: 'x' }))).error_code,
    'invalid_payload');
  assert.equal((await provider.deliver(deliveryInput({ subject: '', text: '', html: '' }))).error_code,
    'invalid_payload');
  assert.equal(calls, 0);
});

function deliveryInput(payload: Record<string, unknown> = {
  subject: 'Account notice', text: 'Plain body', html: '<p>HTML body</p>'
}): NotificationProviderDeliveryInput {
  return {
    recipient: 'alice@example.com', payload,
    notification: {
      id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
      recipient_kind: 'external', recipient_ref: 'contact-a', channels: ['email'], locale: 'en',
      template_id: null, template_revision: null, content_ciphertext: 'ciphertext',
      content_projection: { title: 'Notice' }, priority: 'normal', force_delivery: false,
      business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'system',
      correlation_id: '', idempotency_key: 'notification-a', payload_hash: 'a'.repeat(64), policy: {},
      state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z', retention_until: null,
      created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
      completed_at: null
    },
    delivery: {
      id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'email',
      endpoint_id: 'smtp-a', provider_kind: 'smtp', provider_profile_id: 'smtp-a',
      recipient_ciphertext: 'ciphertext', recipient_hmac: 'b'.repeat(64),
      recipient_redacted: 'a***@example.com', payload_ciphertext: 'ciphertext',
      payload_hash: 'c'.repeat(64), provider_idempotency_key: `notify_${'d'.repeat(64)}`,
      state: 'processing', attempt_count: 1, max_attempts: 5, next_attempt_at: null,
      lease_token_hash: 'e'.repeat(64), lease_until: '2026-07-15T00:00:30.000Z', worker_id: 'worker-a',
      provider_request_id: '', provider_message_id: '', provider_receipt_projection: {},
      error_code: '', error_projection: {}, created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z', accepted_at: null, delivered_at: null, completed_at: null
    }
  };
}
