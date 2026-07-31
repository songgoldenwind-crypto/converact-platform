import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCellCapacityObservation,
  cellCapacityProjectorRuntimeConfig,
  createCellCapacityProjector,
  type CellCapacityPublisher
} from '../scripts/ivekit-cell-capacity-projector.js';
import type {
  ComponentCapacityObservation,
  ComponentCapacityProbe
} from '../scripts/capacity/probes/index.js';

test('Cell capacity projector derives stable nodes from the shared pool authority', () => {
  const env = projectorEnv();
  delete env.OPC_IVEKIT_CELL_NODES_JSON;
  env.OPC_IVEKIT_CELL_NODE_POOLS_JSON = JSON.stringify([{
    component: 'rustpbx',
    node_id_prefix: 'rustpbx-a',
    replica_count: 1,
    endpoint_template: 'http://{node_id}.rustpbx-headless:8080',
    control_endpoint_template: 'http://{node_id}.rustpbx-headless:3210',
    state: 'accepting',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls', safe_capacity: 2_500, used: 0, reserved: 0
      }
    }
  }]);

  const config = cellCapacityProjectorRuntimeConfig(env);

  assert.deepEqual(config.nodes, [{
    node_id: 'rustpbx-a-0',
    state: 'accepting',
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls', safe_capacity: 2_500, used: 0, reserved: 0
      }
    }
  }]);
  assert.throws(
    () => cellCapacityProjectorRuntimeConfig({
      ...env,
      OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify(config.nodes)
    }),
    /topology authority/i
  );
});

test('Cell capacity projector preserves qualified limits and aggregates observed usage', () => {
  const projected = buildCellCapacityObservation({
    sequence: 42,
    observed_at: '2026-07-16T08:00:00.000Z',
    expires_at: '2026-07-16T08:00:05.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections',
        safe_capacity: 2_000,
        used: 0,
        reserved: 0
      }
    },
    nodes: [{
      node_id: 'tinode-a',
      state: 'accepting',
      dimensions: {
        'im.websocket_connections': {
          unit: 'connections',
          safe_capacity: 2_000,
          used: 0,
          reserved: 0
        }
      }
    }],
    observations: [componentObservation()]
  });

  assert.equal(projected.sequence, 42);
  assert.equal(projected.cell_lease_epoch, 7);
  assert.equal(projected.dimensions['im.websocket_connections'].safe_capacity, 2_000);
  assert.equal(projected.dimensions['im.websocket_connections'].used, 750);
  assert.equal(projected.nodes[0]?.state, 'accepting');
  assert.equal(projected.nodes[0]?.dimensions['im.websocket_connections'].used, 750);
});

test('Cell capacity projector fails a missing or failed node closed at its safe limit', () => {
  const failed = {
    ...componentObservation(),
    outcome: 'failed' as const,
    state: 'offline' as const,
    dimensions: {},
    reasons: ['metrics unavailable']
  };
  const projected = buildCellCapacityObservation({
    sequence: 43,
    observed_at: '2026-07-16T08:00:01.000Z',
    expires_at: '2026-07-16T08:00:06.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections',
        safe_capacity: 2_000,
        used: 0,
        reserved: 0
      }
    },
    nodes: [{
      node_id: 'tinode-a',
      state: 'accepting',
      dimensions: {
        'im.websocket_connections': {
          unit: 'connections',
          safe_capacity: 2_000,
          used: 0,
          reserved: 0
        }
      }
    }],
    observations: [failed]
  });

  assert.equal(projected.nodes[0]?.state, 'offline');
  assert.equal(projected.nodes[0]?.dimensions['im.websocket_connections'].used, 2_000);
  assert.equal(projected.dimensions['im.websocket_connections'].used, 2_000);
});

test('Cell capacity projector preserves a configured node drain over healthy observations', () => {
  const projected = buildCellCapacityObservation({
    sequence: 44,
    observed_at: '2026-07-16T08:00:01.000Z',
    expires_at: '2026-07-16T08:00:06.000Z',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections', safe_capacity: 2_000, used: 0, reserved: 0
      }
    },
    nodes: [{
      node_id: 'tinode-a',
      state: 'draining',
      dimensions: {
        'im.websocket_connections': {
          unit: 'connections', safe_capacity: 2_000, used: 0, reserved: 0
        }
      }
    }],
    observations: [componentObservation()]
  });

  assert.equal(projected.nodes[0]?.state, 'draining');
  assert.equal(projected.nodes[0]?.dimensions['im.websocket_connections'].used, 750);
});

test('Cell capacity projector discovers the current lease epoch before publishing', async () => {
  const published: any[] = [];
  const states: string[] = [];
  const publisher: CellCapacityPublisher = {
    async state() {
      return {
        capacity_sequence: 100,
        cell_lease_epoch: 9,
        state: 'accepting'
      };
    },
    async publish(observation) {
      published.push(observation);
    },
    async setState(state) {
      states.push(state);
    }
  };
  const probe: ComponentCapacityProbe = {
    async collect() {
      return componentObservation();
    }
  };
  const projector = createCellCapacityProjector({
    publisher,
    probes: [probe],
    observation_ttl_ms: 5_000,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections',
        safe_capacity: 2_000,
        used: 0,
        reserved: 0
      }
    },
    nodes: [{
      node_id: 'tinode-a',
      state: 'accepting',
      dimensions: {
        'im.websocket_connections': {
          unit: 'connections',
          safe_capacity: 2_000,
          used: 0,
          reserved: 0
        }
      }
    }]
  });

  const result = await projector.runOnce(new Date('2026-07-16T08:00:00.000Z'));
  assert.equal(result.sequence, 101);
  assert.equal(result.cell_lease_epoch, 9);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], result);
  assert.deepEqual(states, []);
});

test('Cell capacity projector activates only a fresh bootstrap admission state', async () => {
  const states: string[] = [];
  const projector = createCellCapacityProjector({
    publisher: {
      async state() {
        return {
          capacity_sequence: 0,
          cell_lease_epoch: 11,
          state: 'draining'
        };
      },
      async publish() {},
      async setState(state) {
        states.push(state);
      }
    },
    probes: [{ async collect() { return componentObservation(); } }],
    observation_ttl_ms: 5_000,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections', safe_capacity: 2_000, used: 0, reserved: 0
      }
    },
    nodes: [{
      node_id: 'tinode-a',
      state: 'accepting',
      dimensions: {
        'im.websocket_connections': {
          unit: 'connections', safe_capacity: 2_000, used: 0, reserved: 0
        }
      }
    }]
  });

  await projector.runOnce(new Date('2026-07-16T08:00:00.000Z'));
  assert.deepEqual(states, ['accepting']);
});

test('Cell capacity projector does not probe component nodes while admission is standby', async () => {
  let probes = 0;
  const projector = createCellCapacityProjector({
    publisher: {
      async state() {
        throw new Error('cell_admission_standby');
      },
      async publish() {
        throw new Error('unreachable');
      },
      async setState() {
        throw new Error('unreachable');
      }
    },
    probes: [{
      async collect() {
        probes += 1;
        return componentObservation();
      }
    }],
    observation_ttl_ms: 5_000,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections', safe_capacity: 2_000, used: 0, reserved: 0
      }
    },
    nodes: [{
      node_id: 'tinode-a',
      state: 'accepting',
      dimensions: {
        'im.websocket_connections': {
          unit: 'connections', safe_capacity: 2_000, used: 0, reserved: 0
        }
      }
    }]
  });

  await assert.rejects(
    () => projector.runOnce(new Date('2026-07-16T08:00:00.000Z')),
    /cell_admission_standby/
  );
  assert.equal(probes, 0);
});

function componentObservation(): ComponentCapacityObservation {
  return {
    schema_version: '1.0.0',
    outcome: 'observed',
    component: 'tinode',
    instance_id: 'tinode-a',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    release_id: 'tinode@abc123',
    hardware_class: 'app-c16-10gbe',
    configuration_class: 'tinode-v1',
    profile_id: 'cell-10k-v1',
    profile_sha256: 'a'.repeat(64),
    state: 'accepting',
    observed_at: '2026-07-16T08:00:00.000Z',
    dominant_utilization: 0.375,
    dimensions: {
      'im.websocket_connections': {
        unit: 'connections',
        safe_capacity: 2_000,
        used: 750,
        reserved: 0,
        utilization: 0.375
      }
    },
    reasons: [],
    evidence: {
      sha256: 'b'.repeat(64),
      byte_size: 1_024,
      health_status: 200,
      metrics_status: 200,
      captured_at: '2026-07-16T08:00:00.000Z'
    }
  };
}

function projectorEnv(): NodeJS.ProcessEnv {
  return {
    OPC_IVEKIT_CELL_ADMISSION_ENDPOINT: 'http://127.0.0.1:3200',
    OPC_IVEKIT_CELL_ADMISSION_TOKEN: 'cell-admission-secret-1234567890',
    OPC_IVEKIT_CELL_REGION_ID: 'region-a',
    OPC_IVEKIT_CELL_ZONE_ID: 'zone-a',
    OPC_IVEKIT_CELL_ID: 'cell-a',
    OPC_IVEKIT_CELL_CAPACITY_PROFILE_ID: 'cell-10k-v1',
    OPC_IVEKIT_CELL_CAPACITY_PROFILE_SHA256: 'a'.repeat(64),
    OPC_IVEKIT_CELL_DIMENSIONS_JSON: JSON.stringify({
      'voice.weighted_calls': {
        unit: 'calls', safe_capacity: 2_500, used: 0, reserved: 0
      }
    }),
    OPC_IVEKIT_CELL_NODES_JSON: JSON.stringify([{
      node_id: 'rustpbx-a-0',
      state: 'accepting',
      dimensions: {
        'voice.weighted_calls': {
          unit: 'calls', safe_capacity: 2_500, used: 0, reserved: 0
        }
      }
    }]),
    OPC_IVEKIT_CELL_PROBES_JSON: JSON.stringify([{
      component: 'rustpbx',
      instance_id: 'rustpbx-a-0',
      region_id: 'region-a',
      zone_id: 'zone-a',
      cell_id: 'cell-a',
      release_id: 'rustpbx@candidate',
      hardware_class: 'voice-c32',
      configuration_class: 'rustpbx-cell-v1',
      profile_id: 'cell-10k-v1',
      profile_sha256: 'a'.repeat(64),
      dimensions: {
        'voice.weighted_calls': {
          metric: 'rustpbx_weighted_calls',
          aggregation: 'sum',
          unit: 'calls',
          safe_capacity: 2_500
        }
      }
    }])
  };
}
