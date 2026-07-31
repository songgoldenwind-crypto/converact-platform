import { createHmac } from 'node:crypto';
import type { WebhookSubscription } from './webhook-store.js';
import type { WebhookStore } from './webhook-store.js';

export interface WebhookPayload {
  id: string;
  event: string;
  tenant_id: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export async function dispatchWebhook(
  subscription: WebhookSubscription,
  payload: WebhookPayload
): Promise<{ success: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', subscription.secret).update(body).digest('hex');

  // SSRF protection: only allow http/https URLs, reject internal addresses.
  const parsedUrl = (() => {
    try { return new URL(subscription.url); } catch { return null; }
  })();
  if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
    return { success: false, error: 'invalid webhook URL scheme' };
  }
  // Block common internal/cloud metadata addresses.
  const hostname = parsedUrl.hostname;
  if (hostname === '169.254.169.254' || hostname === 'localhost' || hostname === '127.0.0.1'
      || hostname.startsWith('10.') || hostname.startsWith('192.168.') || hostname.startsWith('172.')) {
    return { success: false, error: 'webhook URL must not point to internal address' };
  }

  try {
    const res = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OPC-Signature': `sha256=${signature}`,
        'X-OPC-Event': payload.event,
        'X-OPC-Delivery': payload.id
      },
      body,
      signal: AbortSignal.timeout(10000)
    });
    return { success: res.ok, status: res.status };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

export async function dispatchToAll(
  store: WebhookStore,
  tenantId: string,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  const subscribers = store.getSubscribersForEvent(tenantId, event);
  const payload: WebhookPayload = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event,
    tenant_id: tenantId,
    timestamp: new Date().toISOString(),
    data
  };

  await Promise.allSettled(
    subscribers.map(sub => dispatchWebhook(sub, payload))
  );
}
