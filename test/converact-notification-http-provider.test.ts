import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import {
  HttpNotificationProvider,
  type NotificationProviderDeliveryInput
} from '../src/agent-runtime/converact/notifications/index.js';
import { pinnedNotificationHttpRequest, resolveNotificationHttpDestination } from
  '../src/agent-runtime/converact/notifications/providers/http-destination.js';

test('pinned notification transport connects to the validated address without resolving again', async (t) => {
  let host = '';
  const server = createServer((request, response) => {
    host = String(request.headers.host || '');
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await pinnedNotificationHttpRequest(
    new URL(`http://must-not-resolve.invalid:${address.port}/health`),
    { method: 'GET' },
    ['127.0.0.1']
  );

  assert.equal(response.status, 204);
  assert.equal(host, `must-not-resolve.invalid:${address.port}`);
});

test('HTTP SMS provider sends the provider-neutral contract without leaking credentials', async () => {
  let request: { init: RequestInit } | null = null;
  const provider = new HttpNotificationProvider({
    kind: 'sms_http', channel: 'sms', profile_id: 'sms-a',
    url: 'https://sms.example.com/v1/deliver', token: 't'.repeat(32),
    resolve: async () => ['93.184.216.34'],
    fetch: async (_url, init) => {
      request = { init: init || {} };
      return Response.json({ status: 'accepted', message_id: 'sms-message-a', request_id: 'sms-request-a' },
        { status: 202 });
    }
  });

  const result = await provider.deliver(deliveryInput('sms', '+8613800138000', { text: 'Code 1234' }));
  assert.deepEqual(result, {
    status: 'accepted', provider_request_id: 'sms-request-a', provider_message_id: 'sms-message-a',
    receipt: { http_status: 202, provider_status: 'accepted' }
  });
  const headers = new Headers(request?.init.headers);
  assert.equal(headers.get('authorization'), `Bearer ${'t'.repeat(32)}`);
  const body = String(request?.init.body);
  assert.equal(body.includes('Code 1234'), true);
  assert.equal(body.includes('t'.repeat(32)), false);
  assert.equal(body.includes('recipient_ciphertext'), false);
});

test('HTTP email provider supports delivered responses and validates channel payloads', async () => {
  const provider = new HttpNotificationProvider({
    kind: 'email_http', channel: 'email', url: 'https://mail.example.com/v1/deliver',
    token: 't'.repeat(32), resolve: async () => ['93.184.216.34'],
    fetch: async () => Response.json({ status: 'delivered', message_id: 'mail-a' })
  });
  assert.equal((await provider.deliver(deliveryInput('email', 'alice@example.com', {
    subject: 'Notice', text: 'Body'
  }))).status, 'delivered');
  const invalid = await provider.deliver(deliveryInput('email', 'alice@example.com', { text: 'Body' }));
  assert.deepEqual(invalid, { status: 'terminal_failure', error_code: 'invalid_payload' });
});

test('HTTP notification provider classifies HTTP failures and malformed success responses', async () => {
  const create = (fetch: typeof globalThis.fetch) => new HttpNotificationProvider({
    kind: 'sms_http', channel: 'sms', url: 'https://sms.example.com/v1/deliver',
    token: 't'.repeat(32), resolve: async () => ['93.184.216.34'], fetch,
    now: () => new Date('2026-07-15T00:00:00.000Z')
  });
  const input = deliveryInput('sms', '+8613800138000', { text: 'Message' });

  assert.equal((await create(async () => new Response(null, { status: 401 })).deliver(input)).error_code,
    'provider_auth_failed');
  const limited = await create(async () => new Response(null, {
    status: 429, headers: { 'retry-after': '5' }
  })).deliver(input);
  assert.equal(limited.status, 'retryable_failure');
  assert.equal(limited.retry_after_ms, 5_000);
  assert.equal((await create(async () => new Response(null, { status: 503 })).deliver(input)).status,
    'retryable_failure');
  assert.equal((await create(async () => new Response('not-json', { status: 200 })).deliver(input)).status,
    'uncertain');
  assert.equal((await create(async () => { throw new Error('connection closed'); }).deliver(input)).status,
    'uncertain');
});

test('HTTP notification provider blocks private networks unless explicitly enabled for self-hosted gateways', async () => {
  let calls = 0;
  const options = {
    kind: 'sms_http' as const, channel: 'sms' as const,
    url: 'https://sms.internal.example/v1/deliver', token: 't'.repeat(32),
    resolve: async () => ['10.0.0.8'],
    fetch: async () => {
      calls += 1;
      return Response.json({ status: 'accepted', message_id: 'sms-a' }, { status: 202 });
    }
  };
  const input = deliveryInput('sms', '+8613800138000', { text: 'Message' });
  assert.equal((await new HttpNotificationProvider(options).deliver(input)).error_code,
    'unsafe_provider_destination');
  assert.equal(calls, 0);
  assert.equal((await new HttpNotificationProvider({ ...options, allow_private_networks: true })
    .deliver(input)).status, 'accepted');
  assert.equal(calls, 1);
});

test('HTTP notification destination rejects non-global IPv6 ranges', async () => {
  const url = new URL('https://notify.example.test/deliver');
  for (const address of [
    'fec0::1',
    '100::1',
    '64:ff9b:1::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '3fff::1'
  ]) {
    assert.equal((await resolveNotificationHttpDestination({
      url,
      resolve: async () => [address]
    })).status, 'unsafe', address);
  }
  assert.equal((await resolveNotificationHttpDestination({
    url,
    resolve: async () => ['2606:4700:4700::1111']
  })).status, 'safe');
});

function deliveryInput(
  channel: 'email' | 'sms',
  recipient: string,
  payload: Record<string, unknown>
): NotificationProviderDeliveryInput {
  return {
    recipient, payload,
    notification: {
      id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
      recipient_kind: 'external', recipient_ref: 'contact-a', channels: [channel], locale: 'zh-CN',
      template_id: null, template_revision: null, content_ciphertext: 'ciphertext',
      content_projection: { title: 'Notice' }, priority: 'normal', force_delivery: false,
      business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'system',
      correlation_id: 'request-a', idempotency_key: 'notification-a', payload_hash: 'a'.repeat(64),
      policy: {}, state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z', retention_until: null,
      created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z', completed_at: null
    },
    delivery: {
      id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel,
      endpoint_id: `${channel}-a`, provider_kind: `${channel}_http`, provider_profile_id: `${channel}-a`,
      recipient_ciphertext: 'ciphertext', recipient_hmac: 'b'.repeat(64), recipient_redacted: 'redacted',
      payload_ciphertext: 'ciphertext', payload_hash: 'c'.repeat(64),
      provider_idempotency_key: `notify_${'d'.repeat(64)}`, state: 'processing', attempt_count: 1,
      max_attempts: 5, next_attempt_at: null, lease_token_hash: 'e'.repeat(64),
      lease_until: '2026-07-15T00:00:30.000Z', worker_id: 'worker-a', provider_request_id: '',
      provider_message_id: '', provider_receipt_projection: {}, error_code: '', error_projection: {},
      created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
      accepted_at: null, delivered_at: null, completed_at: null
    }
  };
}
