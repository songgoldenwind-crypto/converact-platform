import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellAdmissionTopologySha256,
  compileAdmissionNodePools,
  validateAdmissionNodeCapacity,
  type AdmissionNodePoolConfig
} from '../src/agent-runtime/converact/placement/index.js';

test('component node pools compile stable ordinal identities and exact endpoints', () => {
  const pools: AdmissionNodePoolConfig[] = [
    {
      component: 'rustpbx',
      node_id_prefix: 'rustpbx-a',
      replica_count: 2,
      endpoint_template: 'http://{node_id}.rustpbx-headless:8080',
      control_endpoint_template: 'http://{node_id}.rustpbx-headless:3210',
      state: 'accepting',
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['sip_voice'],
      dimensions: {
        'voice.weighted_calls': {
          unit: 'calls',
          safe_capacity: 1_250,
          used: 0,
          reserved: 0
        }
      }
    },
    {
      component: 'livekit',
      node_id_prefix: 'livekit-a',
      replica_count: 1,
      endpoint_template: 'http://{node_id}.livekit-headless:7880',
      control_endpoint_template: 'http://{node_id}.livekit-headless:3210',
      state: 'degraded',
      profile_ids: ['cell-10k-v1'],
      interaction_kinds: ['livekit_av', 'livekit_screen'],
      dimensions: {
        'video.participants': {
          unit: 'participants',
          safe_capacity: 2_000,
          used: 0,
          reserved: 0
        }
      }
    }
  ];

  const nodes = compileAdmissionNodePools(pools);

  assert.deepEqual(nodes.map((node) => ({
    node_id: node.node_id,
    endpoint: node.endpoint,
    control_endpoint: node.control_endpoint,
    state: node.state
  })), [
    {
      node_id: 'livekit-a-0',
      endpoint: 'http://livekit-a-0.livekit-headless:7880',
      control_endpoint: 'http://livekit-a-0.livekit-headless:3210',
      state: 'degraded'
    },
    {
      node_id: 'rustpbx-a-0',
      endpoint: 'http://rustpbx-a-0.rustpbx-headless:8080',
      control_endpoint: 'http://rustpbx-a-0.rustpbx-headless:3210',
      state: 'accepting'
    },
    {
      node_id: 'rustpbx-a-1',
      endpoint: 'http://rustpbx-a-1.rustpbx-headless:8080',
      control_endpoint: 'http://rustpbx-a-1.rustpbx-headless:3210',
      state: 'accepting'
    }
  ]);
  assert.notEqual(nodes[1]?.dimensions, nodes[2]?.dimensions);
  validateAdmissionNodeCapacity(nodes, {
    'voice.weighted_calls': {
      unit: 'calls',
      safe_capacity: 2_500,
      used: 0,
      reserved: 0
    },
    'video.participants': {
      unit: 'participants',
      safe_capacity: 2_000,
      used: 0,
      reserved: 0
    }
  });
});

test('component node topology rejects unstable identity and capacity drift', () => {
  const pool = rustPbxPool();
  assert.throws(
    () => compileAdmissionNodePools([
      pool,
      { ...pool, replica_count: 1 }
    ]),
    /duplicate component node/i
  );
  assert.throws(
    () => compileAdmissionNodePools([{
      ...pool,
      endpoint_template: 'http://rustpbx.service:8080'
    }]),
    /node_id/i
  );
  assert.throws(
    () => compileAdmissionNodePools([{
      ...pool,
      control_endpoint_template: 'http://user:pass@{node_id}:3210'
    }]),
    /endpoint/i
  );
  assert.throws(
    () => validateAdmissionNodeCapacity(
      compileAdmissionNodePools([pool]),
      {
        'voice.weighted_calls': {
          unit: 'calls',
          safe_capacity: 2_499,
          used: 0,
          reserved: 0
        }
      }
    ),
    /capacity/i
  );
});

test('Cell topology fingerprint is order-independent and covers routing capacity', () => {
  const nodes = compileAdmissionNodePools([rustPbxPool()]);
  const input = {
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'] as const,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 2_500,
        used: 0,
        reserved: 0
      }
    },
    nodes
  };

  const expected = cellAdmissionTopologySha256(input);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(cellAdmissionTopologySha256({
    ...input,
    profile_ids: [...input.profile_ids].reverse(),
    interaction_kinds: [...input.interaction_kinds].reverse(),
    nodes: [...nodes].reverse()
  }), expected);
  assert.notEqual(cellAdmissionTopologySha256({
    ...input,
    nodes: nodes.map((node, index) => index === 0
      ? { ...node, state: 'draining' as const }
      : node)
  }), expected);
  assert.notEqual(cellAdmissionTopologySha256({
    ...input,
    dimensions: {
      'voice.weighted_calls': {
        ...input.dimensions['voice.weighted_calls'],
        safe_capacity: 2_499
      }
    }
  }), expected);
});

function rustPbxPool(): AdmissionNodePoolConfig {
  return {
    component: 'rustpbx',
    node_id_prefix: 'rustpbx-a',
    replica_count: 2,
    endpoint_template: 'http://{node_id}.rustpbx-headless:8080',
    control_endpoint_template: 'http://{node_id}.rustpbx-headless:3210',
    state: 'accepting',
    profile_ids: ['cell-10k-v1'],
    interaction_kinds: ['sip_voice'],
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: 1_250,
        used: 0,
        reserved: 0
      }
    }
  };
}
