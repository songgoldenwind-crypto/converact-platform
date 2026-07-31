import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PendingSendStore } from './pending-send-store.js';

test('pending send store preserves the original attachment payload and idempotency key for retry', () => {
  const store = new PendingSendStore();
  const input = {
    body: 'proof',
    attachments: [{
      kind: 'image' as const,
      storage_url: 'ivekit://object/proof',
      filename: 'proof.png',
      content_type: 'image/png',
      size_bytes: 10,
      checksum: 'sha256:test',
      processing_status: 'pending' as const,
      metadata: {}
    }]
  };
  store.remember('local-1', 'stable-key', input);
  assert.deepEqual(store.get('local-1'), { idempotencyKey: 'stable-key', input });
  store.resolve('local-1');
  assert.equal(store.get('local-1'), undefined);
});
