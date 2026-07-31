import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IveKitRateLimitError,
  IveKitRateLimiter,
  type IveKitRateLimitReservationInput,
  type IveKitRateLimitRepository
} from '../src/agent-runtime/converact/operations/rate-limit/index.js';

test('rate limiter HMACs all sensitive dimensions before repository reservation', async () => {
  let captured: IveKitRateLimitReservationInput | null = null;
  const repository: IveKitRateLimitRepository = {
    async reserve(input) {
      captured = input;
      return { allowed: true, retry_after_seconds: 0, denied_scope: null };
    }
  };
  await new IveKitRateLimiter({
    repository,
    hmac_key: Buffer.alloc(32, 7).toString('base64')
  }).check({
    tenant_id: 'tenant-a', route_group: 'notification.create',
    dimensions: [
      { scope_type: 'actor', key: 'admin@example.com', limit: 60, window_seconds: 60 },
      { scope_type: 'recipient', key: '+8613800138000', limit: 10, window_seconds: 60 }
    ]
  });
  assert.equal(captured?.dimensions.length, 2);
  assert.match(captured?.dimensions[0]?.scope_key_hmac || '', /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(captured).includes('admin@example.com'), false);
  assert.equal(JSON.stringify(captured).includes('+8613800138000'), false);
});

test('rate limiter returns a structured retryable 429 decision', async () => {
  const repository: IveKitRateLimitRepository = {
    async reserve() {
      return { allowed: false, retry_after_seconds: 17, denied_scope: 'recipient' };
    }
  };
  await assert.rejects(
    () => new IveKitRateLimiter({
      repository,
      hmac_key: Buffer.alloc(32, 8).toString('base64')
    }).check({
      tenant_id: 'tenant-a', route_group: 'notification.create',
      dimensions: [{ scope_type: 'recipient', key: 'recipient-a', limit: 10, window_seconds: 60 }]
    }),
    (error: unknown) => error instanceof IveKitRateLimitError
      && error.status === 429 && error.retry_after_seconds === 17
  );
});
