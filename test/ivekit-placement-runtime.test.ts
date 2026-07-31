import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FilePlacementRuntime,
  PlacementSnapshotSigner,
  placementRuntimeConfig
} from '../src/agent-runtime/ivekit/placement/index.js';
import type {
  PlacementSnapshotBody,
  SignedPlacementSnapshot
} from '../src/agent-runtime/ivekit/placement/types.js';

test('file placement runtime refreshes signed snapshots and targets the selected Cell admission endpoint', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-placement-runtime-'));
  const snapshotFile = join(directory, 'placement.json');
  const snapshotKey = Buffer.alloc(32, 1);
  const tokenKey = Buffer.alloc(32, 2);
  const signer = new PlacementSnapshotSigner({ snapshot: snapshotKey });
  let now = new Date('2026-07-16T08:00:00.000Z');
  writeSnapshot(snapshotFile, signer.sign(snapshot('cell-a', 1), 'snapshot'));
  const calls: string[] = [];
  const runtime = new FilePlacementRuntime({
    snapshot_file: snapshotFile,
    snapshot_signer: signer,
    token_keys: { placement: tokenKey },
    token_key_id: 'placement',
    admission_service_token: 'placement-admission-token-123456789',
    home_region_id: 'region-a',
    failover_region_ids: [],
    snapshot_refresh_ms: 250,
    admission_timeout_ms: 1_000,
    now: () => now,
    fetch: admissionFetch(calls)
  });

  const readiness = await runtime.probe();
  assert.deepEqual(readiness, {
    snapshot_version: 1,
    generated_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:01:00.000Z'
  });
  assert.deepEqual(calls, []);

  const first = await runtime.place(request('call-a'));
  assert.equal(first.cell_id, 'cell-a');
  assert.equal(first.admission_endpoint, 'https://admission-cell-a.internal');
  assert.deepEqual(calls, ['https://admission-cell-a.internal/v1/reservations']);

  now = new Date('2026-07-16T08:00:01.000Z');
  writeSnapshot(snapshotFile, signer.sign(snapshot('cell-b', 2), 'snapshot'));
  const second = await runtime.place(request('call-b'));
  assert.equal(second.cell_id, 'cell-b');
  assert.equal(runtime.lastAcceptedSnapshotVersion, 2);
  assert.deepEqual(calls, [
    'https://admission-cell-a.internal/v1/reservations',
    'https://admission-cell-b.internal/v1/reservations'
  ]);

  rmSync(directory, { recursive: true, force: true });
});

test('placement runtime config is disabled by default and fail-closed when enabled incompletely', () => {
  assert.equal(placementRuntimeConfig({}).enabled, false);
  assert.throws(
    () => placementRuntimeConfig({ OPC_IVEKIT_PLACEMENT_ENABLED: '1' }),
    /required/
  );
  const snapshotKey = Buffer.alloc(32, 1).toString('base64');
  const tokenKey = Buffer.alloc(32, 2).toString('base64');
  const config = placementRuntimeConfig({
    OPC_IVEKIT_PLACEMENT_ENABLED: '1',
    OPC_IVEKIT_PLACEMENT_SNAPSHOT_FILE: '/run/ivekit/placement.json',
    OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON: JSON.stringify({
      snapshot: snapshotKey
    }),
    OPC_IVEKIT_PLACEMENT_TOKEN_HMAC_KEYS_JSON: JSON.stringify({
      placement: tokenKey
    }),
    OPC_IVEKIT_PLACEMENT_TOKEN_KEY_ID: 'placement',
    OPC_IVEKIT_CELL_ADMISSION_TOKEN: 'placement-admission-token-123456789',
    OPC_IVEKIT_PLACEMENT_HOME_REGION_ID: 'region-a',
    OPC_IVEKIT_PLACEMENT_FAILOVER_REGION_IDS: 'region-b'
  });
  assert.equal(config.enabled, true);
  if (!config.enabled) return;
  assert.equal(config.snapshot_file, '/run/ivekit/placement.json');
  assert.deepEqual(config.failover_region_ids, ['region-b']);
  assert.equal(config.snapshot_refresh_ms, 1_000);
  assert.equal(config.stale_grace_ms, 30_000);
});

test('file placement runtime proves owner recovery from signed topology and admission state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-placement-inspection-'));
  const snapshotFile = join(directory, 'placement.json');
  const signer = new PlacementSnapshotSigner({ snapshot: Buffer.alloc(32, 3) });
  writeSnapshot(snapshotFile, signer.sign(snapshot('cell-a', 1), 'snapshot'));
  let nodeState: 'accepting' | 'draining' | 'offline' = 'accepting';
  let recoverySafeAfter = '';
  const runtime = new FilePlacementRuntime({
    snapshot_file: snapshotFile,
    snapshot_signer: signer,
    token_keys: { placement: Buffer.alloc(32, 4) },
    token_key_id: 'placement',
    admission_service_token: 'placement-admission-token-123456789',
    home_region_id: 'region-a',
    failover_region_ids: [],
    snapshot_refresh_ms: 250,
    admission_timeout_ms: 1_000,
    now: () => new Date('2026-07-16T08:00:00.000Z'),
    fetch: async (input) => {
      assert.equal(String(input), 'https://admission-cell-a.internal/v1/state');
      return Response.json({
        data: {
          state: 'accepting',
          cell_lease_epoch: 3,
          nodes: [{
            node_id: 'livekit-cell-a',
            state: nodeState,
            recovery_safe_after: recoverySafeAfter
          }],
          reservations: [{
            reservation_id: 'reservation-call-a',
            state: 'active',
            owner_node_id: 'livekit-cell-a',
            owner_epoch: '12884901889'
          }]
        }
      });
    }
  });
  const owner = {
    profile_id: 'cell-10k-v1',
    interaction_kind: 'livekit_av' as const,
    cell_id: 'cell-a',
    owner_node_id: 'livekit-cell-a',
    owner_epoch: '12884901889',
    cell_lease_epoch: 3,
    reservation_id: 'reservation-call-a',
    admission_endpoint: 'https://admission-cell-a.internal'
  };

  assert.deepEqual(await runtime.inspectOwner(owner), {
    status: 'eligible',
    reason: 'owner_node_accepting'
  });
  nodeState = 'draining';
  assert.deepEqual(await runtime.inspectOwner(owner), {
    status: 'eligible',
    reason: 'owner_node_draining'
  });
  nodeState = 'offline';
  assert.deepEqual(await runtime.inspectOwner(owner), {
    status: 'unknown',
    reason: 'owner_fence_pending'
  });
  recoverySafeAfter = '2026-07-16T07:59:59.000Z';
  assert.deepEqual(await runtime.inspectOwner(owner), {
    status: 'recoverable',
    reason: 'owner_node_fenced'
  });

  rmSync(directory, { recursive: true, force: true });
});

function request(interactionId: string) {
  return {
    request_id: `request-${interactionId}`,
    idempotency_key: `idem-${interactionId}`,
    tenant_id: 'tenant-a',
    routing_partition_id: 'service-order-a',
    interaction_id: interactionId,
    interaction_kind: 'livekit_av' as const,
    profile_id: 'cell-10k-v1',
    required_capacity: { 'video.participants': 2 }
  };
}

function snapshot(cellId: string, version: number): PlacementSnapshotBody {
  return {
    schema_version: '1.0.0',
    snapshot_version: version,
    generated_at: `2026-07-16T08:00:0${version - 1}.000Z`,
    expires_at: '2026-07-16T08:01:00.000Z',
    profile_id: 'cell-10k-v1',
    regions: [{
      region_id: 'region-a',
      zones: [{
        zone_id: 'zone-a',
        state: 'accepting',
        cells: [{
          cell_id: cellId,
          state: 'accepting',
          routing_weight: 1,
          supported_interaction_kinds: ['livekit_av'],
          supported_profile_ids: ['cell-10k-v1'],
          capacity_vector_sequence: version,
          capacity_expires_at: '2026-07-16T08:01:00.000Z',
          dominant_utilization_ratio: 0,
          capacity_dimensions: {
            'video.participants': {
              unit: 'participants',
              safe_capacity: 2_000,
              used: 0,
              reserved: 0
            }
          },
          cell_lease_epoch: 3,
          admission_endpoint: `https://admission-${cellId}.internal`
        }]
      }]
    }]
  };
}

function writeSnapshot(path: string, snapshot: SignedPlacementSnapshot): void {
  const temporary = `${path}.next`;
  writeFileSync(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  renameSync(temporary, path);
}

function admissionFetch(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    const body = JSON.parse(String(init?.body || '{}'));
    const cellId = new URL(url).hostname.replace('admission-', '').replace('.internal', '');
    return new Response(JSON.stringify({
      data: {
        reservation_id: `reservation-${body.interaction_id}`,
        state: 'reserved',
        region_id: body.region_id,
        zone_id: body.zone_id,
        cell_id: body.cell_id,
        owner_node_id: `livekit-${cellId}`,
        owner_epoch: '12884901889',
        endpoint: `https://livekit-${cellId}.internal`,
        expires_at: '2026-07-16T08:00:10.000Z',
        required_capacity: body.required_capacity
      }
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' }
    });
  };
}
