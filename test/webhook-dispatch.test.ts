import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createHmac } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { WebhookStore } from '../src/agent-runtime/call-center/webhooks/webhook-store.js';
import { dispatchWebhook } from '../src/agent-runtime/call-center/webhooks/webhook-dispatcher.js';
import { WhiteLabelStore } from '../src/agent-runtime/call-center/white-label/white-label-store.js';

function createTestDb() {
  const db = createDatabase(':memory:');
  return db;
}

test('WebhookStore creates and lists subscriptions', () => {
  const db = createTestDb();
  const store = new WebhookStore(db);

  const sub = store.create({
    tenant_id: 'tenant_1',
    url: 'https://example.com/hook',
    events: ['call.completed', 'call.started']
  });

  assert.ok(sub.id.startsWith('whk_'));
  assert.equal(sub.tenant_id, 'tenant_1');
  assert.equal(sub.url, 'https://example.com/hook');
  assert.deepEqual(sub.events, ['call.completed', 'call.started']);
  assert.ok(sub.secret.length > 0);
  assert.equal(sub.active, true);

  const list = store.list('tenant_1');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], sub);

  const empty = store.list('tenant_nonexistent');
  assert.equal(empty.length, 0);
});

test('getSubscribersForEvent filters by event type', () => {
  const db = createTestDb();
  const store = new WebhookStore(db);

  store.create({ tenant_id: 'tenant_1', url: 'https://a.com/hook', events: ['call.completed'] });
  store.create({ tenant_id: 'tenant_1', url: 'https://b.com/hook', events: ['call.started'] });
  store.create({ tenant_id: 'tenant_1', url: 'https://c.com/hook', events: ['*'] });

  const completedSubs = store.getSubscribersForEvent('tenant_1', 'call.completed');
  assert.equal(completedSubs.length, 2);
  const urls = completedSubs.map(s => s.url).sort();
  assert.deepEqual(urls, ['https://a.com/hook', 'https://c.com/hook']);

  const startedSubs = store.getSubscribersForEvent('tenant_1', 'call.started');
  assert.equal(startedSubs.length, 2);

  const unknownSubs = store.getSubscribersForEvent('tenant_1', 'unknown.event');
  assert.equal(unknownSubs.length, 1);
  assert.equal(unknownSubs[0].url, 'https://c.com/hook');
});

test('dispatchWebhook sends correct headers and signature', async () => {
  const sub = {
    id: 'whk_test',
    tenant_id: 'tenant_1',
    url: 'https://example.com/hook',
    events: ['call.completed'],
    secret: 'test-secret-123',
    active: true
  };

  const payload = {
    id: 'evt_test_1',
    event: 'call.completed',
    tenant_id: 'tenant_1',
    timestamp: '2026-06-21T00:00:00.000Z',
    data: { call_id: 'call_123' }
  };

  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;

  const mockFetch = mock.fn(async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const result = await dispatchWebhook(sub, payload);

    assert.equal(result.success, true);
    assert.equal(result.status, 200);
    assert.equal(capturedUrl, 'https://example.com/hook');
    assert.equal(capturedInit?.method, 'POST');

    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['X-OPC-Event'], 'call.completed');
    assert.equal(headers['X-OPC-Delivery'], 'evt_test_1');

    const body = capturedInit?.body as string;
    const expectedSig = createHmac('sha256', 'test-secret-123').update(body).digest('hex');
    assert.equal(headers['X-OPC-Signature'], `sha256=${expectedSig}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('dispatchWebhook handles timeout gracefully', async () => {
  const sub = {
    id: 'whk_test',
    tenant_id: 'tenant_1',
    url: 'https://example.com/hook',
    events: ['call.completed'],
    secret: 'test-secret',
    active: true
  };

  const payload = {
    id: 'evt_test_2',
    event: 'call.completed',
    tenant_id: 'tenant_1',
    timestamp: '2026-06-21T00:00:00.000Z',
    data: {}
  };

  const mockFetch = mock.fn(async () => {
    throw new Error('TimeoutError: The operation was aborted due to timeout');
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  try {
    const result = await dispatchWebhook(sub, payload);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('timeout'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('WhiteLabelStore upserts and retrieves config', () => {
  const db = createTestDb();
  const store = new WhiteLabelStore(db);

  const missing = store.getConfig('tenant_1');
  assert.equal(missing, null);

  const config = store.upsertConfig('tenant_1', {
    brand_name: 'Acme Corp',
    logo_url: 'https://acme.com/logo.png',
    primary_color: '#ff0000'
  });

  assert.ok(config.id.startsWith('wl_'));
  assert.equal(config.tenant_id, 'tenant_1');
  assert.equal(config.brand_name, 'Acme Corp');
  assert.equal(config.logo_url, 'https://acme.com/logo.png');
  assert.equal(config.primary_color, '#ff0000');
  assert.equal(config.custom_domain, null);
  assert.equal(config.email_from_name, '');
  assert.equal(config.email_from_address, '');

  const updated = store.upsertConfig('tenant_1', {
    brand_name: 'Acme Inc',
    custom_domain: 'support.acme.com'
  });

  assert.equal(updated.id, config.id);
  assert.equal(updated.brand_name, 'Acme Inc');
  assert.equal(updated.logo_url, 'https://acme.com/logo.png');
  assert.equal(updated.custom_domain, 'support.acme.com');
});
