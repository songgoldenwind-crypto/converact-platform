import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { BillingStore } from '../src/agent-runtime/call-center/billing/billing-store.js';
import { handleStripeWebhook } from '../src/agent-runtime/call-center/billing/stripe-webhook.js';
import { routeBillingApi } from '../src/agent-runtime/call-center/billing/billing-http.js';

const BILLING_API_KEY = 'test-billing-key';

/** Auth headers for the API-key path (requireAuth needs authenticated: true). */
function billingAuth(tenantId: string): Record<string, string> {
  return { 'X-API-Key': BILLING_API_KEY, 'X-Tenant-Id': tenantId };
}

function createBillingDb() {
  const db = createDatabase(':memory:');
  return { db, store: new BillingStore(db) };
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

test('BillingStore creates and retrieves subscription', () => {
  const { store } = createBillingDb();

  const sub = store.createSubscription({
    tenant_id: 'tenant_abc',
    plan_code: 'pro',
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_456'
  });

  assert.ok(sub.id.startsWith('sub_'));
  assert.equal(sub.tenant_id, 'tenant_abc');
  assert.equal(sub.plan_code, 'pro');
  assert.equal(sub.stripe_customer_id, 'cus_123');
  assert.equal(sub.stripe_subscription_id, 'sub_456');
  assert.equal(sub.status, 'active');

  const retrieved = store.getSubscription('tenant_abc');
  assert.deepEqual(retrieved, sub);

  const missing = store.getSubscription('tenant_nonexistent');
  assert.equal(missing, null);
});

test('BillingStore increments usage correctly', () => {
  const { store } = createBillingDb();
  const period = currentPeriod();

  store.incrementUsage('tenant_abc', 'ai_minutes_used', 10);
  let usage = store.getUsage('tenant_abc', period)!;
  assert.equal(usage.ai_minutes_used, 10);
  assert.equal(usage.tool_calls_used, 0);
  assert.equal(usage.seats_used, 0);

  store.incrementUsage('tenant_abc', 'ai_minutes_used', 5);
  usage = store.getUsage('tenant_abc', period)!;
  assert.equal(usage.ai_minutes_used, 15);

  store.incrementUsage('tenant_abc', 'tool_calls_used', 100);
  usage = store.getUsage('tenant_abc', period)!;
  assert.equal(usage.tool_calls_used, 100);
  assert.equal(usage.ai_minutes_used, 15);
});

test('checkQuota returns allowed for free plan within limits', () => {
  const { store } = createBillingDb();

  store.createSubscription({ tenant_id: 'tenant_free', plan_code: 'free' });
  store.incrementUsage('tenant_free', 'ai_minutes_used', 50);
  store.incrementUsage('tenant_free', 'tool_calls_used', 200);

  const result = store.checkQuota('tenant_free');
  assert.equal(result.allowed, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.usage.ai_minutes.used, 50);
  assert.equal(result.usage.ai_minutes.limit, 100);
  assert.equal(result.usage.tool_calls.used, 200);
  assert.equal(result.usage.tool_calls.limit, 500);
});

test('checkQuota returns denied when exceeding free plan limits', () => {
  const { store } = createBillingDb();

  store.createSubscription({ tenant_id: 'tenant_over', plan_code: 'free' });
  store.incrementUsage('tenant_over', 'ai_minutes_used', 150);

  const result = store.checkQuota('tenant_over');
  assert.equal(result.allowed, false);
  assert.ok(result.reason);
  assert.match(result.reason!, /AI minutes quota exceeded/);
  assert.equal(result.usage.ai_minutes.used, 150);
  assert.equal(result.usage.ai_minutes.limit, 100);
});

test('checkQuota always allows enterprise plan', () => {
  const { store } = createBillingDb();

  store.createSubscription({ tenant_id: 'tenant_ent', plan_code: 'enterprise' });
  store.incrementUsage('tenant_ent', 'ai_minutes_used', 999999);
  store.incrementUsage('tenant_ent', 'tool_calls_used', 999999);
  store.incrementUsage('tenant_ent', 'seats_used', 999999);

  const result = store.checkQuota('tenant_ent');
  assert.equal(result.allowed, true);
  assert.equal(result.reason, undefined);
  assert.equal(result.usage.ai_minutes.limit, -1);
  assert.equal(result.usage.tool_calls.limit, -1);
  assert.equal(result.usage.seats.limit, -1);
});

test('handleStripeWebhook processes invoice.paid', async () => {
  const { store } = createBillingDb();

  store.createSubscription({
    tenant_id: 'tenant_paid',
    plan_code: 'pro',
    stripe_customer_id: 'cus_paid'
  });

  const payload = JSON.stringify({
    type: 'invoice.paid',
    data: {
      object: {
        customer: 'cus_paid',
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        metadata: { tenant_id: 'tenant_paid' }
      }
    }
  });

  const result = await handleStripeWebhook(payload, '', {
    billingStore: store,
    webhookSecret: ''
  });

  assert.equal(result.handled, true);
  assert.equal(result.event, 'invoice.paid');

  const sub = store.getSubscription('tenant_paid')!;
  assert.equal(sub.status, 'active');
  assert.ok(sub.current_period_start);
  assert.ok(sub.current_period_end);
});

test('handleStripeWebhook downgrades on subscription.deleted', async () => {
  const { store } = createBillingDb();

  store.createSubscription({
    tenant_id: 'tenant_cancel',
    plan_code: 'pro',
    stripe_customer_id: 'cus_cancel',
    stripe_subscription_id: 'sub_cancel'
  });

  const payload = JSON.stringify({
    type: 'customer.subscription.deleted',
    data: {
      object: {
        customer: 'cus_cancel',
        metadata: { tenant_id: 'tenant_cancel' }
      }
    }
  });

  const result = await handleStripeWebhook(payload, '', {
    billingStore: store,
    webhookSecret: ''
  });

  assert.equal(result.handled, true);
  assert.equal(result.event, 'customer.subscription.deleted');

  const sub = store.getSubscription('tenant_cancel')!;
  assert.equal(sub.plan_code, 'free');
  assert.equal(sub.status, 'active');
  assert.equal(sub.stripe_subscription_id, null);
});

test('billing HTTP routes return subscription info', async () => {
  process.env.OPC_API_KEY = BILLING_API_KEY;
  const db = createDatabase(':memory:');
  const store = new BillingStore(db);

  store.createSubscription({
    tenant_id: 'tenant_http',
    plan_code: 'pro',
    stripe_customer_id: 'cus_http'
  });

  const subResult = await routeBillingApi(
    db, 'GET', '/api/billing/subscription',
    new URL('http://localhost/api/billing/subscription'),
    null, '', billingAuth('tenant_http')
  );

  assert.ok(subResult);
  const sub = subResult as Record<string, unknown>;
  assert.equal(sub.tenant_id, 'tenant_http');
  assert.equal(sub.plan_code, 'pro');

  const quotaResult = await routeBillingApi(
    db, 'GET', '/api/billing/quota',
    new URL('http://localhost/api/billing/quota'),
    null, '', billingAuth('tenant_http')
  ) as Record<string, unknown>;

  assert.ok(quotaResult);
  assert.equal(quotaResult.allowed, true);

  // Authenticated as tenant_http but querying a subscription that doesn't exist
  // for this tenant → 404 (tenant_id now comes from auth context, not query).
  const missingResult = await routeBillingApi(
    db, 'GET', '/api/billing/subscription',
    new URL('http://localhost/api/billing/subscription'),
    null, '', billingAuth('nonexistent_tenant')
  ) as { status: number; data: { error: string } };

  assert.equal(missingResult.status, 404);

  const checkoutResult = await routeBillingApi(
    db, 'POST', '/api/billing/checkout',
    new URL('http://localhost/api/billing/checkout'),
    { plan_code: 'pro' },
    '', billingAuth('tenant_http')
  ) as { status: number; data: { url: string } };

  assert.equal(checkoutResult.status, 200);
  assert.ok(checkoutResult.data.url.includes('mock'));

  const unmatchedResult = await routeBillingApi(
    db, 'GET', '/api/unknown',
    new URL('http://localhost/api/unknown'),
    null, '', billingAuth('tenant_http')
  );
  assert.equal(unmatchedResult, undefined);
});
