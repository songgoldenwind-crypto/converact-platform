import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  WebhookNotificationProvider,
  type NotificationProviderDeliveryInput
} from '../src/agent-runtime/converact/notifications/index.js';

test('webhook provider signs a stable payload and treats 2xx as delivered', async () => {
  let request: { url: string; init: RequestInit } | null = null;
  const provider = new WebhookNotificationProvider({
    profile_id: 'endpoint-a',
    url: 'https://events.example.com/converact',
    signing_secret: 's'.repeat(32),
    resolve: async () => ['93.184.216.34'],
    fetch: async (url, init) => {
      request = { url: String(url), init: init || {} };
      return new Response(null, { status: 204, headers: { 'x-request-id': 'receiver-a' } });
    },
    now: () => new Date('2026-07-15T00:00:00.000Z')
  });

  const result = await provider.deliver(deliveryInput());
  assert.equal(result.status, 'delivered');
  assert.equal(result.provider_request_id, 'receiver-a');
  assert.equal(request?.url, 'https://events.example.com/converact');
  assert.equal(request?.init.redirect, 'manual');
  const body = String(request?.init.body);
  const headers = new Headers(request?.init.headers);
  assert.equal(headers.get('x-ivekit-delivery'), 'delivery-a');
  assert.equal(headers.get('x-ivekit-event'), 'example.created');
  assert.equal(headers.get('x-ivekit-timestamp'), '1784073600');
  assert.equal(
    headers.get('x-ivekit-signature'),
    `v1=${createHmac('sha256', 's'.repeat(32)).update(`1784073600.${body}`).digest('hex')}`
  );
  assert.equal(body.includes('recipient_ciphertext'), false);
  assert.equal(body.includes('signing_secret'), false);
});

test('webhook provider exposes the journal event id only for integration envelopes', async () => {
  const headers: Headers[] = [];
  const provider = new WebhookNotificationProvider({
    url: 'https://events.example.com/converact', signing_secret: 's'.repeat(32),
    resolve: async () => ['93.184.216.34'],
    fetch: async (_url, init) => {
      headers.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    }
  });
  await provider.deliver(deliveryInput());
  await provider.deliver({
    ...deliveryInput(),
    payload: { schema_version: 1, event_id: 'event-42', data: { ok: true } }
  });
  assert.equal(headers[0].get('x-ivekit-event-id'), null);
  assert.equal(headers[1].get('x-ivekit-event-id'), 'event-42');
});

test('webhook provider classifies retryable, terminal, redirect and uncertain results', async () => {
  const create = (fetch: typeof globalThis.fetch) => new WebhookNotificationProvider({
    profile_id: 'endpoint-a', url: 'https://events.example.com/converact',
    signing_secret: 's'.repeat(32), resolve: async () => ['93.184.216.34'], fetch,
    now: () => new Date('2026-07-15T00:00:00.000Z')
  });

  const limited = await create(async () => new Response(null, {
    status: 429, headers: { 'retry-after': '7' }
  })).deliver(deliveryInput());
  assert.equal(limited.status, 'retryable_failure');
  assert.equal(limited.retry_after_ms, 7_000);
  assert.equal(limited.error_code, 'rate_limited');

  assert.equal((await create(async () => new Response(null, { status: 503 }))
    .deliver(deliveryInput())).status, 'retryable_failure');
  assert.equal((await create(async () => new Response(null, { status: 400 }))
    .deliver(deliveryInput())).status, 'terminal_failure');
  assert.deepEqual(await create(async () => new Response(null, {
    status: 302, headers: { location: 'https://other.example.com/' }
  })).deliver(deliveryInput()), {
    status: 'terminal_failure',
    error_code: 'redirect_forbidden',
    receipt: { http_status: 302 }
  });
  assert.equal((await create(async () => { throw new Error('socket closed'); })
    .deliver(deliveryInput())).status, 'uncertain');
});

test('webhook provider blocks private DNS answers and URL credentials before fetch', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response(null, { status: 204 });
  };
  const privateProvider = new WebhookNotificationProvider({
    url: 'https://metadata.example.com/hook', signing_secret: 's'.repeat(32),
    resolve: async () => ['169.254.169.254'], fetch
  });
  assert.deepEqual(await privateProvider.deliver({
    ...deliveryInput(), recipient: 'https://metadata.example.com/hook'
  }), {
    status: 'terminal_failure',
    error_code: 'unsafe_webhook_destination'
  });
  assert.equal(calls, 0);

  assert.throws(() => new WebhookNotificationProvider({
    url: 'https://user:password@events.example.com/hook',
    signing_secret: 's'.repeat(32), resolve: async () => ['93.184.216.34'], fetch
  }));
});

function deliveryInput(): NotificationProviderDeliveryInput {
  return {
    recipient: 'https://events.example.com/converact',
    payload: { title: 'Notice', body: 'Webhook body' },
    notification: {
      id: 'notification-a', tenant_id: 'tenant-a', event_type: 'example.created',
      recipient_kind: 'endpoint', recipient_ref: 'endpoint-a', channels: ['webhook'], locale: 'zh-CN',
      template_id: null, template_revision: null, content_ciphertext: 'ciphertext',
      content_projection: { title: 'Notice' }, priority: 'normal', force_delivery: false,
      business_ref_type: 'example', business_ref_id: 'example-a', requested_by: 'system',
      correlation_id: 'request-a', idempotency_key: 'notification-a', payload_hash: 'a'.repeat(64),
      policy: {}, state: 'pending', scheduled_at: '2026-07-15T00:00:00.000Z',
      retention_until: null, created_at: '2026-07-15T00:00:00.000Z',
      updated_at: '2026-07-15T00:00:00.000Z', completed_at: null
    },
    delivery: {
      id: 'delivery-a', tenant_id: 'tenant-a', notification_id: 'notification-a', channel: 'webhook',
      endpoint_id: 'endpoint-a', provider_kind: 'webhook', provider_profile_id: 'endpoint-a',
      recipient_ciphertext: 'ciphertext', recipient_hmac: 'b'.repeat(64),
      recipient_redacted: 'https://events.example.com', payload_ciphertext: 'ciphertext',
      payload_hash: 'c'.repeat(64), provider_idempotency_key: `notify_${'d'.repeat(64)}`,
      state: 'processing', attempt_count: 1, max_attempts: 5, next_attempt_at: null,
      lease_token_hash: 'e'.repeat(64), lease_until: '2026-07-15T00:00:30.000Z',
      worker_id: 'worker-a', provider_request_id: '', provider_message_id: '',
      provider_receipt_projection: {}, error_code: '', error_projection: {},
      created_at: '2026-07-15T00:00:00.000Z', updated_at: '2026-07-15T00:00:00.000Z',
      accepted_at: null, delivered_at: null, completed_at: null
    }
  };
}
