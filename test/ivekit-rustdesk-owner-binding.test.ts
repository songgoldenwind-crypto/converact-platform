import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpRustDeskOwnerBindingPrepareClient,
  RustDeskOwnerBindingError,
  RustDeskOwnerBindingRegistry
} from '../src/agent-runtime/ivekit/placement/rustdesk-owner-binding.js';

const now = new Date('2026-07-17T00:00:00.000Z');

test('RustDesk owner binding claims one pending target and survives checkpoint restore', () => {
  const registry = new RustDeskOwnerBindingRegistry({
    node_id: 'rustdesk-cell-0',
    claimed_ttl_ms: 120_000
  });
  registry.prepare({
    target_id: '123456789',
    interaction_id: 'remote-a',
    reservation_id: 'reservation-a',
    owner_node_id: 'rustdesk-cell-0',
    owner_epoch: '12884901889',
    expires_at: '2026-07-17T00:02:00.000Z'
  }, now);
  const claimed = registry.claim({
    target_id: '123456789',
    relay_uuid: 'relay-a'
  }, now);

  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.relay_uuid, 'relay-a');
  assert.equal(registry.resolve('relay-a', now).reservation_id, 'reservation-a');

  const restored = new RustDeskOwnerBindingRegistry({
    node_id: 'rustdesk-cell-0',
    checkpoint: registry.checkpoint(now),
    now: () => now
  });
  assert.equal(restored.resolve('relay-a', now).owner_epoch, '12884901889');
  assert.equal(restored.close('relay-a', now), true);
  assert.equal(restored.close('relay-a', now), false);
});

test('RustDesk owner binding restore ignores valid expired entries', () => {
  const restored = new RustDeskOwnerBindingRegistry({
    node_id: 'rustdesk-cell-0',
    now: () => now,
    checkpoint: {
      schema_version: 1,
      node_id: 'rustdesk-cell-0',
      bindings: [{
        target_id: '123456789',
        interaction_id: 'remote-expired',
        reservation_id: 'reservation-expired',
        owner_node_id: 'rustdesk-cell-0',
        owner_epoch: '12884901888',
        status: 'claimed',
        relay_uuid: 'relay-expired',
        expires_at: '2026-07-16T23:59:59.000Z'
      }]
    }
  });

  assert.equal(restored.snapshot(now).total, 0);
});

test('RustDesk owner binding rejects ambiguous pending sessions for one target', () => {
  const registry = new RustDeskOwnerBindingRegistry({ node_id: 'rustdesk-cell-0' });
  registry.prepare({
    target_id: '123456789',
    interaction_id: 'remote-a',
    reservation_id: 'reservation-a',
    owner_node_id: 'rustdesk-cell-0',
    owner_epoch: '12884901889',
    expires_at: '2026-07-17T00:02:00.000Z'
  }, now);

  assert.throws(
    () => registry.prepare({
      target_id: '123456789',
      interaction_id: 'remote-b',
      reservation_id: 'reservation-b',
      owner_node_id: 'rustdesk-cell-0',
      owner_epoch: '12884901890',
      expires_at: '2026-07-17T00:02:00.000Z'
    }, now),
    (error) => error instanceof RustDeskOwnerBindingError &&
      error.code === 'rustdesk_target_binding_pending'
  );
});

test('RustDesk owner binding expiry releases the target for a later reservation', () => {
  const registry = new RustDeskOwnerBindingRegistry({ node_id: 'rustdesk-cell-0' });
  registry.prepare({
    target_id: '123456789',
    interaction_id: 'remote-a',
    reservation_id: 'reservation-a',
    owner_node_id: 'rustdesk-cell-0',
    owner_epoch: '12884901889',
    expires_at: '2026-07-17T00:00:30.000Z'
  }, now);

  const later = new Date('2026-07-17T00:00:31.000Z');
  const replacement = registry.prepare({
    target_id: '123456789',
    interaction_id: 'remote-b',
    reservation_id: 'reservation-b',
    owner_node_id: 'rustdesk-cell-0',
    owner_epoch: '12884901890',
    expires_at: '2026-07-17T00:02:00.000Z'
  }, later);
  assert.equal(replacement.reservation_id, 'reservation-b');
});

test('RustDesk owner prepare client sends exact placement identity to the selected node', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new HttpRustDeskOwnerBindingPrepareClient({
    nodes: {
      'rustdesk-cell-0': {
        endpoint: 'http://rustdesk-cell-0.internal:3211',
        token: 'rustdesk-owner-token-123456'
      }
    },
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({
        data: {
          target_id: '123456789',
          interaction_id: 'remote-a',
          reservation_id: 'reservation-a',
          owner_node_id: 'rustdesk-cell-0',
          owner_epoch: '12884901889',
          status: 'pending',
          expires_at: '2099-01-01T00:00:00.000Z'
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.prepare({
    target_id: '123456789',
    interaction_id: 'remote-a',
    owner: {
      owner_node_id: 'rustdesk-cell-0',
      owner_epoch: '12884901889',
      reservation_id: 'reservation-a'
    }
  });

  assert.equal(calls[0].url, 'http://rustdesk-cell-0.internal:3211/v1/bindings/prepare');
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).authorization,
    'Bearer rustdesk-owner-token-123456'
  );
  const body = JSON.parse(String(calls[0].init?.body));
  assert.deepEqual(
    {
      ...body,
      expires_at: '<timestamp>'
    },
    {
      target_id: '123456789',
      interaction_id: 'remote-a',
      reservation_id: 'reservation-a',
      owner_node_id: 'rustdesk-cell-0',
      owner_epoch: '12884901889',
      expires_at: '<timestamp>'
    }
  );
  assert.equal(Number.isFinite(new Date(body.expires_at).getTime()), true);
});
