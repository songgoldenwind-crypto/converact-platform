import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createPlacementSnapshotProjector,
  placementSnapshotProjectorConfig
} from '../src/ivekit-placement-snapshot-projector.js';
import { PlacementSnapshotSigner } from '../src/agent-runtime/ivekit/placement/index.js';
import type { SignedPlacementSnapshot } from '../src/agent-runtime/ivekit/placement/types.js';

test('placement snapshot projector aggregates authenticated Cell state into an atomic signed snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ivekit-placement-projector-'));
  const output = join(directory, 'placement.json');
  const key = Buffer.alloc(32, 7);
  let now = new Date('2026-07-16T08:00:00.000Z');
  const projector = createPlacementSnapshotProjector({
    output_file: output,
    profile_id: 'cell-10k-v1',
    signing_key_id: 'snapshot',
    signing_keys: { snapshot: key },
    service_token: 'placement-projector-token-123456789',
    snapshot_ttl_ms: 10_000,
    request_timeout_ms: 1_000,
    topology: topology(),
    now: () => now,
    fetch: stateFetch()
  });

  const first = await projector.runOnce();
  assert.equal(first.body.snapshot_version, Date.parse('2026-07-16T08:00:00.000Z'));
  assert.equal(first.body.regions[0]?.zones[0]?.cells[0]?.cell_id, 'cell-a');
  assert.equal(
    first.body.regions[0]?.zones[0]?.cells[0]?.dominant_utilization_ratio,
    0.25
  );
  assert.equal(
    first.body.regions[0]?.zones[0]?.cells[0]?.capacity_dimensions[
      'video.participants'
    ]?.reserved,
    10
  );
  assert.deepEqual(
    JSON.parse(readFileSync(output, 'utf8')),
    first
  );
  new PlacementSnapshotSigner({ snapshot: key }).verify(first, {
    now,
    last_accepted_version: 0,
    stale_grace_ms: 0
  });

  now = new Date('2026-07-16T08:00:00.001Z');
  const second = await projector.runOnce();
  assert.equal(second.body.snapshot_version, first.body.snapshot_version + 1);
  const outputStat = await (await import('node:fs/promises')).stat(output);
  assert.equal(outputStat.mode & 0o777, 0o600);

  rmSync(directory, { recursive: true, force: true });
});

test('placement snapshot projector config requires explicit topology and canonical signing key', () => {
  assert.throws(
    () => placementSnapshotProjectorConfig({}),
    /required/
  );
  const key = Buffer.alloc(32, 7).toString('base64');
  const config = placementSnapshotProjectorConfig({
    OPC_IVEKIT_PLACEMENT_SNAPSHOT_FILE: '/run/ivekit/placement.json',
    OPC_IVEKIT_PLACEMENT_SNAPSHOT_HMAC_KEYS_JSON: JSON.stringify({
      snapshot: key
    }),
    OPC_IVEKIT_PLACEMENT_SNAPSHOT_KEY_ID: 'snapshot',
    OPC_IVEKIT_CELL_ADMISSION_TOKEN: 'placement-projector-token-123456789',
    OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON: JSON.stringify(topology()),
    OPC_IVEKIT_PLACEMENT_PROFILE_ID: 'cell-10k-v1'
  });
  assert.equal(config.interval_ms, 2_000);
  assert.equal(config.snapshot_ttl_ms, 10_000);
  assert.equal(config.topology.regions[0]?.zones[0]?.cells[0]?.cell_id, 'cell-a');
});

function topology() {
  return {
    regions: [{
      region_id: 'region-a',
      zones: [{
        zone_id: 'zone-a',
        state: 'accepting' as const,
        cells: [{
          cell_id: 'cell-a',
          routing_weight: 1,
          supported_interaction_kinds: ['livekit_av' as const],
          supported_profile_ids: ['cell-10k-v1'],
          admission_endpoint: 'https://admission-cell-a.internal'
        }]
      }]
    }]
  };
}

function stateFetch(): typeof fetch {
  return async () => new Response(JSON.stringify({
    data: {
      state: 'accepting',
      cell_lease_epoch: 3,
      capacity_sequence: 9,
      capacity_expires_at: '2026-07-16T08:00:05.000Z',
      dimensions: {
        'video.participants': {
          unit: 'participants',
          safe_capacity: 2_000,
          used: 490,
          reserved: 10
        }
      },
      nodes: []
    }
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
