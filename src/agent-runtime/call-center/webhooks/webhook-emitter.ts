import { dispatchWebhook, type WebhookPayload } from './webhook-dispatcher.js';
import { WebhookDeliveryStore } from './webhook-delivery-store.js';
import { WebhookStore } from './webhook-store.js';

function nextRetryIso(attemptCount: number): string {
  const delaySec = Math.min(300, Math.pow(2, attemptCount) * 5);
  return new Date(Date.now() + delaySec * 1000).toISOString();
}

export async function dispatchWebhookWithLogging(
  db: unknown,
  subscription: { id: string; tenant_id: string; url: string; events: string[]; secret: string; active: boolean },
  payload: WebhookPayload,
  existingDeliveryId: string | null = null
): Promise<{ success: boolean; delivery_id: string }> {
  const deliveryStore = new WebhookDeliveryStore(db);
  const delivery =
    existingDeliveryId && deliveryStore.get(existingDeliveryId)
      ? deliveryStore.get(existingDeliveryId)!
      : deliveryStore.createDelivery({
          subscription_id: subscription.id,
          tenant_id: subscription.tenant_id,
          event: payload.event,
          payload_id: payload.id
        });

  const result = await dispatchWebhook(subscription, payload);
  if (result.success) {
    deliveryStore.markSuccess(delivery.id, result.status || 200);
    return { success: true, delivery_id: delivery.id };
  }

  const nextAttempt = delivery.attempt_count + 1;
  const canRetry = nextAttempt < delivery.max_attempts;
  deliveryStore.markFailure(
    delivery.id,
    result.status ?? null,
    result.error || `HTTP ${result.status || 'error'}`,
    canRetry ? nextRetryIso(nextAttempt) : null
  );
  return { success: false, delivery_id: delivery.id };
}

export async function emitTenantWebhookEvent(
  db: unknown,
  tenantId: string,
  event: string,
  data: Record<string, unknown>
): Promise<void> {
  if (!tenantId) return;
  const store = new WebhookStore(db);
  const subscribers = store.getSubscribersForEvent(tenantId, event);
  if (!subscribers.length) return;

  const payload: WebhookPayload = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event,
    tenant_id: tenantId,
    timestamp: new Date().toISOString(),
    data
  };

  await Promise.allSettled(
    subscribers.map((sub) => dispatchWebhookWithLogging(db, sub, payload))
  );
}

export async function processWebhookRetries(db: unknown, limit = 50): Promise<number> {
  const deliveryStore = new WebhookDeliveryStore(db);
  const webhookStore = new WebhookStore(db);
  const due = deliveryStore.pickDueRetries(limit);
  let processed = 0;

  for (const delivery of due) {
    const sub = webhookStore.get(delivery.subscription_id);
    if (!sub || !sub.active) {
      deliveryStore.markFailure(delivery.id, null, 'subscription inactive', null);
      continue;
    }
    const payload: WebhookPayload = {
      id: delivery.payload_id,
      event: delivery.event,
      tenant_id: delivery.tenant_id,
      timestamp: new Date().toISOString(),
      data: { retry: true, delivery_id: delivery.id }
    };
    await dispatchWebhookWithLogging(db, sub, payload, delivery.id);
    processed++;
  }
  return processed;
}
