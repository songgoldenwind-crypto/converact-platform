import Stripe from 'stripe';
import type { BillingStore } from './billing-store.js';

export interface StripeWebhookDeps {
  billingStore: BillingStore;
  webhookSecret: string;
}

// Track processed event IDs for idempotency (Stripe retries webhooks).
const processedEventIds = new Set<string>();

export async function handleStripeWebhook(
  rawBody: string,
  signature: string,
  deps: StripeWebhookDeps
): Promise<{ handled: boolean; event?: string }> {
  let event: Stripe.Event;

  if (deps.webhookSecret) {
    // Use official Stripe SDK for signature verification.
    // This includes replay protection (timestamp freshness) and proper
    // constant-time comparison — replacing the hand-written verifyStripeSignature.
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, deps.webhookSecret);
    } catch {
      throw Object.assign(new Error('invalid stripe signature'), { status: 401 });
    }
  } else {
    // No webhook secret configured — skip verification (dev/test only).
    event = JSON.parse(rawBody) as Stripe.Event;
  }

  // Idempotency: skip already-processed events (Stripe retries on non-2xx).
  if (event.id && processedEventIds.has(event.id)) {
    return { handled: false, event: `${event.type} (duplicate ${event.id})` };
  }
  if (event.id) {
    processedEventIds.add(event.id);
    // Prevent unbounded growth — keep last 1000 event IDs.
    if (processedEventIds.size > 1000) {
      const first = processedEventIds.values().next().value;
      if (first) processedEventIds.delete(first);
    }
  }

  const data = event.data.object as unknown as Record<string, unknown>;
  if (!data) return { handled: false };

  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(deps.billingStore, data);
    case 'invoice.paid':
      return handleInvoicePaid(deps.billingStore, data);
    case 'invoice.payment_failed':
      return handlePaymentFailed(deps.billingStore, data);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(deps.billingStore, data);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(deps.billingStore, data);
    default:
      return { handled: false, event: event.type };
  }
}

function handleCheckoutCompleted(
  store: BillingStore,
  data: Record<string, unknown>
): { handled: boolean; event: string } {
  const metadata = (data.metadata as Record<string, unknown>) || {};
  const tenantId = String(data.client_reference_id || metadata.tenant_id || '');
  const customerId = String(data.customer || '');
  const subscriptionId = String(data.subscription || '');
  const planCode = String(metadata.plan_code || 'pro');

  if (!tenantId) return { handled: false, event: 'checkout.session.completed' };

  const existing = store.getSubscription(tenantId);
  if (existing) {
    store.updateSubscription(tenantId, {
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan_code: planCode,
      status: 'active'
    });
  } else {
    store.createSubscription({
      tenant_id: tenantId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      plan_code: planCode
    });
  }

  return { handled: true, event: 'checkout.session.completed' };
}

function handleInvoicePaid(
  store: BillingStore,
  data: Record<string, unknown>
): { handled: boolean; event: string } {
  const customerId = String(data.customer || '');
  const periodStart = data.period_start
    ? new Date(Number(data.period_start) * 1000).toISOString()
    : null;
  const periodEnd = data.period_end
    ? new Date(Number(data.period_end) * 1000).toISOString()
    : null;

  const tenantId = findTenantByCustomer(store, customerId, data);
  if (!tenantId) return { handled: false, event: 'invoice.paid' };

  store.updateSubscription(tenantId, {
    status: 'active',
    current_period_start: periodStart,
    current_period_end: periodEnd
  });

  return { handled: true, event: 'invoice.paid' };
}

function handlePaymentFailed(
  store: BillingStore,
  data: Record<string, unknown>
): { handled: boolean; event: string } {
  const customerId = String(data.customer || '');
  const tenantId = findTenantByCustomer(store, customerId, data);
  if (!tenantId) return { handled: false, event: 'invoice.payment_failed' };

  store.updateSubscription(tenantId, { status: 'past_due' });
  return { handled: true, event: 'invoice.payment_failed' };
}

function handleSubscriptionDeleted(
  store: BillingStore,
  data: Record<string, unknown>
): { handled: boolean; event: string } {
  const customerId = String(data.customer || '');
  const tenantId = findTenantByCustomer(store, customerId, data);
  if (!tenantId) return { handled: false, event: 'customer.subscription.deleted' };

  store.updateSubscription(tenantId, {
    plan_code: 'free',
    // Subscription is downgraded to the free tier, which remains active —
    // the tenant keeps platform access on the free plan. 'canceled' would
    // imply no active subscription at all. (stripe_subscription_id is
    // cleared below so the paid Stripe sub is no longer referenced.)
    status: 'active',
    stripe_subscription_id: null
  });

  return { handled: true, event: 'customer.subscription.deleted' };
}

function handleSubscriptionUpdated(
  store: BillingStore,
  data: Record<string, unknown>
): { handled: boolean; event: string } {
  const customerId = String(data.customer || '');
  const tenantId = findTenantByCustomer(store, customerId, data);
  if (!tenantId) return { handled: false, event: 'customer.subscription.updated' };

  const status = String(data.status || 'active');
  const planCode = (data.items as { data?: Array<{ price: { nickname?: string } }> })?.data?.[0]?.price?.nickname;
  store.updateSubscription(tenantId, {
    status: status === 'active' ? 'active' : status,
    ...(planCode ? { plan_code: planCode } : {})
  });

  return { handled: true, event: 'customer.subscription.updated' };
}

/**
 * Find tenant_id by stripe_customer_id.
 * First checks event metadata, then falls back to DB reverse lookup
 * (fixes the bug where most invoice/subscription events were dropped
 * because they lack metadata).
 */
function findTenantByCustomer(
  store: BillingStore,
  customerId: string,
  data: Record<string, unknown>
): string | null {
  const metaTenantId = (data.metadata as Record<string, unknown> | undefined)?.tenant_id;
  if (metaTenantId) {
    const sub = store.getSubscription(String(metaTenantId));
    if (sub) return sub.tenant_id;
  }
  if (!customerId) return null;
  // DB reverse lookup by stripe_customer_id.
  return store.findTenantByCustomerId(customerId);
}
