import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import { verifyConveractFabricWebhook } from '../sdk/converact/src/webhook.js';

test('SDK verifies a signed integration event and delegates replay to shared storage', async () => {
  const body = JSON.stringify(envelope());
  const timestamp = '1784145600';
  const secret = 'a-production-webhook-secret-32b!';
  const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  const claims: any[] = [];
  const replayStore = {
    claim: async (claim: any) => {
      claims.push(claim);
      return claims.length === 1;
    }
  };

  const first = await verifyConveractFabricWebhook({
    rawBody: body, timestamp, signature, secret,
    now: new Date('2026-07-15T20:00:00.000Z'), replayStore
  });
  const duplicate = await verifyConveractFabricWebhook({
    rawBody: body, timestamp, signature, secret,
    now: new Date('2026-07-15T20:00:01.000Z'), replayStore
  });
  assert.equal(first.duplicate, false);
  assert.equal(first.envelope.data.event_id, '44');
  assert.equal(duplicate.duplicate, true);
  assert.equal(claims[0].key, 'ivekit:tenant-1:delivery-1');
  assert.equal(claims[0].expires_at, '2026-07-22T20:00:00.000Z');
  assert.equal(claims[0].body_sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(claims[0].envelope.data.event_id, '44');
});

test('SDK rejects stale signatures tampering and inconsistent envelopes', async () => {
  const body = JSON.stringify(envelope());
  const timestamp = '1784145600';
  const secret = 'a-production-webhook-secret-32b!';
  const signature = `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  const verify = (overrides: Record<string, unknown>) => verifyConveractFabricWebhook({
    rawBody: body, timestamp, signature, secret,
    now: new Date('2026-07-15T20:00:00.000Z'), ...overrides
  } as any);

  await assert.rejects(() => verify({ now: new Date('2026-07-15T20:10:00.000Z') }), /timestamp/i);
  await assert.rejects(() => verify({ rawBody: `${body} ` }), /signature/i);
  await assert.rejects(() => verify({ signature: 'v1=bad' }), /signature/i);
  await assert.rejects(() => verify({
    rawBody: JSON.stringify({ ...envelope(), tenant_id: 'tenant-2' }),
    signature: `v1=${createHmac('sha256', secret)
      .update(`${timestamp}.${JSON.stringify({ ...envelope(), tenant_id: 'tenant-2' })}`).digest('hex')}`
  }), /envelope/i);
});

function envelope() {
  return {
    id: 'delivery-1', event: 'notification.created', tenant_id: 'tenant-1',
    timestamp: '2026-07-15T20:00:00.000Z', business_ref: { type: 'ivekit_event', id: '44' },
    data: {
      schema_version: 1, event_id: '44', event_type: 'notification.created', tenant_id: 'tenant-1',
      occurred_at: '2026-07-15T19:59:59.000Z', business_ref: null,
      visibility: { scope: 'tenant', ref_id: '', audience_user_ids: [] },
      data: { notification_id: 'notification-1' }
    }
  };
}
