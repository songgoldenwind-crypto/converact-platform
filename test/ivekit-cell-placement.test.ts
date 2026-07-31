import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PlacementError,
  PlacementService,
  PlacementSnapshotSigner,
  PlacementTokenSigner
} from '../src/agent-runtime/ivekit/placement/index.js';
import type {
  AdmissionReservation,
  CellAdmissionPort,
  PlacementSnapshotBody
} from '../src/agent-runtime/ivekit/placement/types.js';

test('placement filters snapshot candidates, uses at most two admissions and returns a signed token', async () => {
  const snapshotSigner = new PlacementSnapshotSigner({
    'snapshot-key': Buffer.alloc(32, 1)
  });
  const tokenSigner = new PlacementTokenSigner({
    'token-key': Buffer.alloc(32, 2)
  });
  const calls: string[] = [];
  const admissions = new Map<string, CellAdmissionPort>();
  for (const cellId of ['cell-a', 'cell-b', 'cell-c']) {
    admissions.set(cellId, {
      async reserve(input): Promise<AdmissionReservation> {
        calls.push(cellId);
        if (calls.length === 1) {
          throw new PlacementError({
            code: 'capacity_exhausted',
            status: 503,
            retryable: true
          });
        }
        return {
          reservation_id: `reservation-${cellId}`,
          state: 'reserved',
          region_id: 'region-a',
          zone_id: input.zone_id,
          cell_id: cellId,
          owner_node_id: `${cellId}-node`,
          owner_epoch: '4294967297',
          endpoint: `https://${cellId}.internal`,
          expires_at: '2026-07-16T08:00:20.000Z',
          required_capacity: { ...input.required_capacity }
        };
      }
    });
  }
  const service = new PlacementService({
    snapshot_signer: snapshotSigner,
    token_signer: tokenSigner,
    token_key_id: 'token-key',
    admissions,
    tenant_regions: {
      async resolve() {
        return {
          home_region_id: 'region-a',
          failover_region_ids: []
        };
      }
    },
    now: () => new Date('2026-07-16T08:00:05.000Z')
  });
  const signedSnapshot = snapshotSigner.sign(snapshotBody(), 'snapshot-key');

  const decision = await service.place({
    snapshot: signedSnapshot,
    last_accepted_snapshot_version: 0,
    request: {
      request_id: 'placement-request-a',
      idempotency_key: 'placement-idem-a',
      tenant_id: 'tenant-a',
      routing_partition_id: 'voice-queue-a',
      interaction_id: 'call-a',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 }
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(new Set(calls).size, 2);
  assert.equal(decision.snapshot_version, 1);
  assert.equal(decision.interaction_id, 'call-a');
  const claims = tokenSigner.verify(
    decision.signed_placement_token,
    new Date('2026-07-16T08:00:06.000Z')
  );
  assert.equal(claims.cell_id, decision.cell_id);
  assert.equal(claims.owner_epoch, decision.owner_epoch);
});

test('placement never falls through to a third Cell and fails closed on stale capacity', async () => {
  const snapshotSigner = new PlacementSnapshotSigner({
    'snapshot-key': Buffer.alloc(32, 1)
  });
  const calls: string[] = [];
  const admissions = new Map<string, CellAdmissionPort>();
  for (const cellId of ['cell-a', 'cell-b', 'cell-c']) {
    admissions.set(cellId, {
      async reserve() {
        calls.push(cellId);
        throw new PlacementError({
          code: 'capacity_exhausted',
          status: 503,
          retryable: true
        });
      }
    });
  }
  const service = new PlacementService({
    snapshot_signer: snapshotSigner,
    token_signer: new PlacementTokenSigner({
      'token-key': Buffer.alloc(32, 2)
    }),
    token_key_id: 'token-key',
    admissions,
    tenant_regions: {
      async resolve() {
        return { home_region_id: 'region-a', failover_region_ids: [] };
      }
    },
    now: () => new Date('2026-07-16T08:00:05.000Z')
  });
  const body = snapshotBody();
  body.regions[0].zones[0].cells[2].capacity_expires_at =
    '2026-07-16T07:59:59.000Z';

  await assert.rejects(() => service.place({
    snapshot: snapshotSigner.sign(body, 'snapshot-key'),
    last_accepted_snapshot_version: 0,
    request: {
      request_id: 'placement-request-a',
      idempotency_key: 'placement-idem-a',
      tenant_id: 'tenant-a',
      routing_partition_id: 'voice-queue-a',
      interaction_id: 'call-a',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 }
    }
  }), (error: any) =>
    error?.code === 'placement_capacity_exhausted' &&
    error?.details?.attempted_cells?.length === 2
  );
  assert.equal(calls.length, 2);
  assert.equal(calls.includes('cell-c'), false);
});

test('placement uses request-specific capacity and rejects mismatched admission responses', async () => {
  const snapshotSigner = new PlacementSnapshotSigner({
    'snapshot-key': Buffer.alloc(32, 1)
  });
  const body = snapshotBody();
  body.regions[0].zones[0].cells[0].capacity_dimensions = {
    'voice.weighted_calls': {
      unit: 'count', safe_capacity: 100, used: 10, reserved: 0
    },
    'voice.recording_slots': {
      unit: 'count', safe_capacity: 10, used: 9, reserved: 0
    }
  };
  body.regions[0].zones[0].cells[0].dominant_utilization_ratio = 0.9;
  body.regions[0].zones[0].cells[1].capacity_dimensions = {
    'voice.weighted_calls': {
      unit: 'count', safe_capacity: 100, used: 60, reserved: 0
    },
    'voice.recording_slots': {
      unit: 'count', safe_capacity: 10, used: 1, reserved: 0
    }
  };
  body.regions[0].zones[0].cells[1].dominant_utilization_ratio = 0.6;
  const called: string[] = [];
  const service = new PlacementService({
    snapshot_signer: snapshotSigner,
    token_signer: new PlacementTokenSigner({ 'token-key': Buffer.alloc(32, 2) }),
    token_key_id: 'token-key',
    admissions: new Map([
      ['cell-a', admission('cell-a', called)],
      ['cell-b', admission('cell-b', called, { cell_id: 'wrong-cell' })],
      ['cell-c', admission('cell-c', called)]
    ]),
    tenant_regions: {
      async resolve() {
        return { home_region_id: 'region-a', failover_region_ids: [] };
      }
    },
    now: () => new Date('2026-07-16T08:00:05.000Z')
  });

  await assert.rejects(() => service.place({
    snapshot: snapshotSigner.sign(body, 'snapshot-key'),
    last_accepted_snapshot_version: 0,
    request: {
      request_id: 'placement-request-recording',
      idempotency_key: 'placement-idem-recording',
      tenant_id: 'tenant-a',
      routing_partition_id: 'voice-queue-a',
      interaction_id: 'call-recording',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: {
        'voice.weighted_calls': 1,
        'voice.recording_slots': 1
      }
    }
  }), (error: any) => error?.code === 'admission_response_mismatch');
  assert.equal(called[0], 'cell-b');
});

test('placement snapshot profile must match the requested profile', async () => {
  const snapshotSigner = new PlacementSnapshotSigner({
    'snapshot-key': Buffer.alloc(32, 1)
  });
  const body = snapshotBody();
  body.profile_id = 'other-10k-v1';
  body.regions[0].zones[0].cells.forEach((value) => {
    value.supported_profile_ids.push('other-10k-v1');
  });
  const service = new PlacementService({
    snapshot_signer: snapshotSigner,
    token_signer: new PlacementTokenSigner({ 'token-key': Buffer.alloc(32, 2) }),
    token_key_id: 'token-key',
    admissions: new Map(),
    tenant_regions: {
      async resolve() {
        return { home_region_id: 'region-a', failover_region_ids: [] };
      }
    },
    now: () => new Date('2026-07-16T08:00:05.000Z')
  });
  await assert.rejects(() => service.place({
    snapshot: snapshotSigner.sign(body, 'snapshot-key'),
    last_accepted_snapshot_version: 0,
    request: {
      request_id: 'placement-request-a',
      idempotency_key: 'placement-idem-a',
      tenant_id: 'tenant-a',
      routing_partition_id: 'voice-queue-a',
      interaction_id: 'call-a',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 }
    }
  }), (error: any) => error?.code === 'snapshot_profile_mismatch');
});

test('placement stays in the first available Region and falls back only when it has no candidates', async () => {
  const snapshotSigner = new PlacementSnapshotSigner({
    'snapshot-key': Buffer.alloc(32, 1)
  });
  const body = snapshotBody();
  body.regions.push({
    region_id: 'region-b',
    zones: [{
      zone_id: 'zone-b',
      state: 'accepting',
      cells: [cell('cell-region-b', 10_000, 0.01)]
    }]
  });
  const calls: string[] = [];
  const service = new PlacementService({
    snapshot_signer: snapshotSigner,
    token_signer: new PlacementTokenSigner({ 'token-key': Buffer.alloc(32, 2) }),
    token_key_id: 'token-key',
    admissions: new Map([
      ['cell-a', admission('cell-a', calls)],
      ['cell-b', admission('cell-b', calls)],
      ['cell-c', admission('cell-c', calls)],
      ['cell-region-b', admission('cell-region-b', calls)]
    ]),
    tenant_regions: {
      async resolve() {
        return {
          home_region_id: 'region-a',
          failover_region_ids: ['region-b']
        };
      }
    },
    now: () => new Date('2026-07-16T08:00:05.000Z')
  });
  await service.place({
    snapshot: snapshotSigner.sign(body, 'snapshot-key'),
    last_accepted_snapshot_version: 0,
    request: {
      request_id: 'placement-request-region',
      idempotency_key: 'placement-idem-region',
      tenant_id: 'tenant-a',
      routing_partition_id: 'voice-queue-a',
      interaction_id: 'call-region',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 }
    }
  });
  assert.equal(calls.includes('cell-region-b'), false);

  body.regions[0].zones[0].state = 'offline';
  calls.length = 0;
  await service.place({
    snapshot: snapshotSigner.sign({ ...body, snapshot_version: 2 }, 'snapshot-key'),
    last_accepted_snapshot_version: 1,
    request: {
      request_id: 'placement-request-failover',
      idempotency_key: 'placement-idem-failover',
      tenant_id: 'tenant-a',
      routing_partition_id: 'voice-queue-a',
      interaction_id: 'call-failover',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 }
    }
  });
  assert.deepEqual(calls, ['cell-region-b']);
});

test('placement honors a trusted preferred Cell for an already accepted inbound SIP leg', async () => {
  const snapshotSigner = new PlacementSnapshotSigner({
    'snapshot-key': Buffer.alloc(32, 1)
  });
  const calls: string[] = [];
  const service = new PlacementService({
    snapshot_signer: snapshotSigner,
    token_signer: new PlacementTokenSigner({
      'token-key': Buffer.alloc(32, 2)
    }),
    token_key_id: 'token-key',
    admissions: new Map([
      ['cell-a', admission('cell-a', calls)],
      ['cell-b', admission('cell-b', calls)],
      ['cell-c', admission('cell-c', calls)]
    ]),
    tenant_regions: {
      async resolve() {
        return {
          home_region_id: 'region-a',
          failover_region_ids: []
        };
      }
    },
    now: () => new Date('2026-07-16T08:00:05.000Z')
  });

  const decision = await service.place({
    snapshot: snapshotSigner.sign(snapshotBody(), 'snapshot-key'),
    last_accepted_snapshot_version: 0,
    request: {
      request_id: 'placement-request-inbound-cell',
      idempotency_key: 'placement-idem-inbound-cell',
      tenant_id: 'tenant-a',
      routing_partition_id: 'inbound-sip-a',
      interaction_id: 'call-inbound-cell',
      interaction_kind: 'sip_voice',
      profile_id: 'cell-10k-v1',
      required_capacity: { 'voice.weighted_calls': 1 },
      preferred_cell_id: 'cell-b',
      preferred_owner_node_id: 'cell-b-node'
    }
  });

  assert.deepEqual(calls, ['cell-b']);
  assert.equal(decision.cell_id, 'cell-b');
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
        cells: [
          cell('cell-a', 100, 0.40),
          cell('cell-b', 100, 0.45),
          cell('cell-c', 1, 0.10)
        ]
      }]
    }]
  };
}

function cell(cellId: string, routingWeight: number, utilization: number) {
  return {
    cell_id: cellId,
    state: 'accepting' as const,
    routing_weight: routingWeight,
    supported_interaction_kinds: ['sip_voice' as const],
    supported_profile_ids: ['cell-10k-v1'],
    capacity_vector_sequence: 1,
    capacity_expires_at: '2026-07-16T08:01:00.000Z',
    dominant_utilization_ratio: utilization,
    capacity_dimensions: {
      'voice.weighted_calls': {
        unit: 'count',
        safe_capacity: 100,
        used: utilization * 100,
        reserved: 0
      }
    },
    cell_lease_epoch: 1,
    admission_endpoint: `https://${cellId}.internal/admission`
  };
}

function admission(
  cellId: string,
  calls: string[],
  overrides: Partial<AdmissionReservation> = {}
): CellAdmissionPort {
  return {
    async reserve(input): Promise<AdmissionReservation> {
      calls.push(cellId);
      return {
        reservation_id: `reservation-${cellId}`,
        state: 'reserved',
        region_id: input.region_id,
        zone_id: input.zone_id,
        cell_id: input.cell_id,
        owner_node_id: `${cellId}-node`,
        owner_epoch: '4294967297',
        endpoint: `https://${cellId}.internal`,
        expires_at: '2026-07-16T08:00:20.000Z',
        required_capacity: { ...input.required_capacity },
        ...overrides
      };
    }
  };
}
