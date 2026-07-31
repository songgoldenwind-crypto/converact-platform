import { resolveBrandEnv } from '../../../config/converact-env.js';
import { BillingStore, currentPeriod } from './billing-store.js';
import { handleStripeWebhook } from './stripe-webhook.js';
import { resolveAuthContext } from '../../../middleware/auth.js';
import { getStripePriceId } from '../../../plan-definitions.js';
import Stripe from 'stripe';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeBillingApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new BillingStore(db);

  // Stripe webhook — verified via Stripe signature, NOT regular auth.
  if (path === '/api/webhooks/stripe' && method === 'POST') {
    const sig = typeof headers['stripe-signature'] === 'string'
      ? headers['stripe-signature']
      : Array.isArray(headers['stripe-signature'])
        ? headers['stripe-signature'][0]
        : '';

    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    try {
      const result = await handleStripeWebhook(rawBody, sig || '', {
        billingStore: store,
        webhookSecret
      });
      return { status: 200, data: result };
    } catch (err: unknown) {
      const status = (err as { status?: number }).status || 500;
      const message = err instanceof Error ? err.message : 'webhook processing failed';
      return { status, data: { error: message } };
    }
  }

  // All other billing endpoints require authentication.
  // tenant_id is taken from auth context, NOT from request body/query,
  // to prevent cross-tenant access.

  if (path === '/api/billing/checkout' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { plan_code?: string };
    if (!input?.plan_code) {
      return { status: 400, data: { error: 'plan_code is required' } };
    }

    const checkoutUrl = process.env.STRIPE_SECRET_KEY
      ? await createStripeCheckoutSession(db, ctx.tenantId!, input.plan_code)
      : `https://checkout.stripe.com/mock/${ctx.tenantId}/${input.plan_code}`;

    return { status: 200, data: { url: checkoutUrl } };
  }

  if (path === '/api/billing/subscription' && method === 'GET') {
    const ctx = requireAuth(headers);
    const sub = store.getSubscription(ctx.tenantId!);
    if (!sub) return { status: 404, data: { error: 'no subscription found' } };
    return sub;
  }

  if (path === '/api/billing/usage' && method === 'GET') {
    const ctx = requireAuth(headers);
    const period = url.searchParams.get('period') || currentPeriod();
    const usage = store.getUsage(ctx.tenantId!, period);
    if (!usage) return { ai_minutes_used: 0, tool_calls_used: 0, seats_used: 0, period };
    return usage;
  }

  if (path === '/api/billing/quota' && method === 'GET') {
    const ctx = requireAuth(headers);
    return store.checkQuota(ctx.tenantId!);
  }

  if (path === '/api/billing/portal' && method === 'POST') {
    const ctx = requireAuth(headers);
    const sub = store.getSubscription(ctx.tenantId!);
    if (!sub?.stripe_customer_id) {
      return { status: 404, data: { error: 'no Stripe customer found' } };
    }

    const portalUrl = process.env.STRIPE_SECRET_KEY
      ? await createStripePortalSession(sub.stripe_customer_id)
      : `https://billing.stripe.com/mock/portal/${sub.stripe_customer_id}`;

    return { status: 200, data: { url: portalUrl } };
  }

  return undefined;
}

function getStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;
  return new Stripe(secretKey);
}

function getBaseUrl(): string {
  return resolveBrandEnv(process.env, 'BASE_URL') || 'http://localhost:3000';
}

async function createStripeCheckoutSession(
  db: unknown,
  tenantId: string,
  planCode: string
): Promise<string> {
  const stripe = getStripeClient();
  if (!stripe) {
    return `https://checkout.stripe.com/mock/${tenantId}/${planCode}`;
  }

  const priceId = getStripePriceId(planCode);
  if (!priceId) {
    throw Object.assign(new Error(`no Stripe price configured for plan: ${planCode}`), { status: 400 });
  }

  // Reuse existing Stripe customer if available.
  const store = new BillingStore(db);
  const existingSub = store.getSubscription(tenantId);
  const customerId = existingSub?.stripe_customer_id || undefined;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${getBaseUrl()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${getBaseUrl()}/billing/cancel`,
    client_reference_id: tenantId,
    metadata: { tenant_id: tenantId, plan_code: planCode },
    ...(customerId ? { customer: customerId } : {})
  });

  return session.url || '';
}

async function createStripePortalSession(customerId: string): Promise<string> {
  const stripe = getStripeClient();
  if (!stripe) {
    return `https://billing.stripe.com/mock/portal/${customerId}`;
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getBaseUrl()}/billing/settings`
  });

  return session.url;
}
