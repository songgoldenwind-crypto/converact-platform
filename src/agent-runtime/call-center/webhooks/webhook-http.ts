import { WebhookStore } from './webhook-store.js';
import { dispatchWebhookWithLogging } from './webhook-emitter.js';
import type { WebhookPayload } from './webhook-dispatcher.js';
import { resolveAuthContext } from '../../../middleware/auth.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeWebhookApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new WebhookStore(db);

  if (path === '/api/webhooks/subscriptions' && method === 'GET') {
    const tenantId = url.searchParams.get('tenant_id');
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    return store.list(tenantId);
  }

  if (path === '/api/webhooks/subscriptions' && method === 'POST') {
    const input = body as { tenant_id?: string; url?: string; events?: string[] } | undefined;
    if (!input?.tenant_id || !input?.url || !input?.events) {
      return { status: 400, data: { error: 'tenant_id, url, and events are required' } };
    }
    return store.create({ tenant_id: input.tenant_id, url: input.url, events: input.events });
  }

  const updateMatch = path.match(/^\/api\/webhooks\/subscriptions\/([^/]+)$/);
  if (updateMatch && method === 'PUT') {
    const ctx = requireAuth(headers);
    const subId = updateMatch[1];
    const input = body as { url?: string; events?: string[]; active?: boolean } | undefined;
    const result = store.update(subId, input || {}, ctx.tenantId!);
    if (!result) return { status: 404, data: { error: 'subscription not found' } };
    return result;
  }

  if (updateMatch && method === 'DELETE') {
    const ctx = requireAuth(headers);
    const subId = updateMatch[1];
    store.delete(subId, ctx.tenantId!);
    return { success: true };
  }

  const testMatch = path.match(/^\/api\/webhooks\/subscriptions\/([^/]+)\/test$/);
  if (testMatch && method === 'POST') {
    const subId = testMatch[1];
    const sub = store.get(subId);
    if (!sub) return { status: 404, data: { error: 'subscription not found' } };

    const payload: WebhookPayload = {
      id: `evt_test_${Date.now()}`,
      event: 'test.ping',
      tenant_id: sub.tenant_id,
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test webhook delivery' }
    };

    void dispatchWebhookWithLogging(db, sub, payload).catch((error) => {
      console.warn('[webhook] test dispatch failed:', error instanceof Error ? error.message : error);
    });
    return { success: true, message: 'Test event dispatched' };
  }

  if (path === '/api/webhooks/deliveries' && method === 'GET') {
    const tenantId = url.searchParams.get('tenant_id');
    if (!tenantId) return { status: 400, data: { error: 'tenant_id is required' } };
    const { WebhookDeliveryStore } = await import('./webhook-delivery-store.js');
    return { data: new WebhookDeliveryStore(db).list(tenantId) };
  }

  if (path === '/api/webhooks/process-retries' && method === 'POST') {
    const { processWebhookRetries } = await import('./webhook-emitter.js');
    const processed = await processWebhookRetries(db);
    return { data: { processed } };
  }

  return undefined;
}
