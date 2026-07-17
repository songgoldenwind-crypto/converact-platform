import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PlacementSnapshotSigner,
  PlacementTokenSigner
} from '../src/agent-runtime/ivekit/placement/snapshot.js';
import type {
  PlacementSnapshotBody,
  PlacementTokenClaims
} from '../src/agent-runtime/ivekit/placement/types.js';

const key = Buffer.alloc(32, 7);

test('placement snapshot signature binds topology, version and capacity state', () => {
  const signer = new PlacementSnapshotSigner({ 'placement-key-1': key });
  const snapshot = signer.sign(snapshotBody(), 'placement-key-1');
  const verified = signer.verify(snapshot, {
    now: new Date('2026-07-16T08:00:10.000Z'),
    last_accepted_version: 0,
    stale_grace_ms: 30_000
  });

  assert.equal(verified.freshness, 'fresh');
  assert.equal(verified.body.snapshot_version, 1);

  const tampered = structuredClone(snapshot);
  tampered.body.regions[0].zones[0].cells[0].routing_weight = 999;
  assert.throws(
    () => signer.verify(tampered, {
      now: new Date('2026-07-16T08:00:10.000Z'),
      last_accepted_version: 0,
      stale_grace_ms: 30_000
    }),
    (error: any) => error?.code === 'invalid_snapshot_signature'
  );
});

test('snapshot verifier distinguishes grace from unusable expiration and rejects version regression', () => {
  const signer = new PlacementSnapshotSigner({ 'placement-key-1': key });
  const snapshot = signer.sign(snapshotBody(), 'placement-key-1');

  assert.equal(signer.verify(snapshot, {
    now: new Date('2026-07-16T08:01:10.000Z'),
    last_accepted_version: 0,
    stale_grace_ms: 30_000
  }).freshness, 'grace');

  assert.throws(() => signer.verify(snapshot, {
    now: new Date('2026-07-16T08:01:31.000Z'),
    last_accepted_version: 0,
    stale_grace_ms: 30_000
  }), (error: any) => error?.code === 'placement_snapshot_expired');

  assert.throws(() => signer.verify(snapshot, {
    now: new Date('2026-07-16T08:00:10.000Z'),
    last_accepted_version: 2,
    stale_grace_ms: 30_000
  }), (error: any) => error?.code === 'snapshot_version_regression');
});

test('snapshot validation rejects future topology, unsafe endpoints and invalid capabilities', () => {
  const signer = new PlacementSnapshotSigner({ 'placement-key-1': key });
  const future = signer.sign(snapshotBody(), 'placement-key-1');
  assert.throws(() => signer.verify(future, {
    now: new Date('2026-07-16T07:59:50.000Z'),
    last_accepted_version: 0,
    stale_grace_ms: 30_000
  }), (error: any) => error?.code === 'placement_snapshot_not_yet_valid');

  const badEndpoint = snapshotBody();
  badEndpoint.regions[0].zones[0].cells[0].admission_endpoint = 'file:///tmp/admission';
  assert.throws(() => signer.sign(badEndpoint, 'placement-key-1'), /endpoint/i);

  const badKind = snapshotBody();
  (badKind.regions[0].zones[0].cells[0].supported_interaction_kinds as any)
    .push('unknown_kind');
  assert.throws(() => signer.sign(badKind, 'placement-key-1'), /capabilit/i);
});

test('snapshot reports overloaded degraded Cells but rejects overloaded accepting Cells', () => {
  const signer = new PlacementSnapshotSigner({ 'placement-key-1': key });
  const degraded = snapshotBody();
  const cell = degraded.regions[0].zones[0].cells[0];
  cell.state = 'degraded';
  cell.capacity_dimensions['voice.weighted_calls'].used = 120;
  cell.dominant_utilization_ratio = 1.2;
  assert.equal(
    signer.sign(degraded, 'placement-key-1')
      .body.regions[0].zones[0].cells[0].dominant_utilization_ratio,
    1.2
  );

  cell.state = 'accepting';
  assert.throws(
    () => signer.sign(degraded, 'placement-key-1'),
    /exceeds safe capacity/i
  );
});

test('placement token is minimal, signed and expiration-fenced', () => {
  const signer = new PlacementTokenSigner({ 'token-key-1': Buffer.alloc(32, 9) });
  const claims: PlacementTokenClaims = {
    key_id: 'token-key-1',
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    interaction_kind: 'sip_voice',
    profile_id: 'cell-10k-v1',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a',
    owner_epoch: '4294967297',
    reservation_id: 'reservation-a',
    issued_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:20.000Z'
  };
  const token = signer.issue(claims);
  assert.deepEqual(
    signer.verify(token, new Date('2026-07-16T08:00:10.000Z')),
    claims
  );
  assert.throws(
    () => signer.verify(`${token}x`, new Date('2026-07-16T08:00:10.000Z')),
    (error: any) => error?.code === 'invalid_placement_token'
  );
  assert.throws(
    () => signer.verify(token, new Date('2026-07-16T08:00:21.000Z')),
    (error: any) => error?.code === 'placement_token_expired'
  );
  assert.equal(token.includes('secret'), false);
});

function snapshotBody(): PlacementSnapshotBody {
  return {
    schema_version: '1.0.0',
    snapshot_version: 1,
    generated_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:01:00.000Z',
    profile_id: 'cell-10k-v1',
    regions: [{
      region_id: 'region-a',
      zones: [{
        zone_id: 'zone-a',
        state: 'accepting',
        cells: [{
          cell_id: 'cell-a',
          state: 'accepting',
          routing_weight: 100,
          supported_interaction_kinds: ['sip_voice'],
          supported_profile_ids: ['cell-10k-v1'],
          capacity_vector_sequence: 10,
          capacity_expires_at: '2026-07-16T08:01:00.000Z',
          dominant_utilization_ratio: 0.4,
          capacity_dimensions: {
            'voice.weighted_calls': {
              unit: 'count',
              safe_capacity: 100,
              used: 40,
              reserved: 0
            }
          },
          cell_lease_epoch: 1,
          admission_endpoint: 'https://cell-a.internal/admission'
        }]
      }]
    }]
  };
}
