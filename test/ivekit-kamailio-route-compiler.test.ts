import assert from 'node:assert/strict';
import test from 'node:test';

import type { ComponentNodeStateSnapshot } from '../src/agent-runtime/ivekit/placement/component-node-admission.js';
import {
  compileKamailioRouteSnapshotBody,
  renderKamailioDispatcherList,
  type KamailioRoutePoolSource
} from '../src/agent-runtime/ivekit/voice/kamailio-route-compiler.js';

test('Kamailio route compiler normalizes headroom and lowers degraded node weight', () => {
  const body = compileKamailioRouteSnapshotBody(compileInput([
    target('rustpbx-a-0', state('rustpbx-a-0', {
      safe_capacity: 2_500,
      used: 800,
      reserved: 100
    })),
    target('rustpbx-a-1', state('rustpbx-a-1', {
      safe_capacity: 2_500,
      used: 1_600,
      reserved: 100
    }, { state: 'degraded' })),
    target('rustpbx-a-2', state('rustpbx-a-2', {
      safe_capacity: 2_500,
      used: 500,
      reserved: 0
    }, { state: 'draining' })),
    target('rustpbx-a-3', null)
  ]));

  assert.deepEqual(body.pools[0]!.nodes.map((node) => ({
    node: node.node_id,
    state: node.state,
    weight: node.routing_weight
  })), [
    { node: 'rustpbx-a-0', state: 'accepting', weight: 100 },
    { node: 'rustpbx-a-1', state: 'degraded', weight: 25 },
    { node: 'rustpbx-a-2', state: 'draining', weight: 100 },
    { node: 'rustpbx-a-3', state: 'offline', weight: 1 }
  ]);

  const rendered = renderKamailioDispatcherList(body);
  assert.match(
    rendered,
    /^100 sip:rustpbx-a-0\.internal:5060;transport=udp 9 10 .*rweight=100;.*ivekit_retain_state=1/m
  );
  assert.match(
    rendered,
    /^100 sip:rustpbx-a-1\.internal:5060;transport=udp 9 10 .*rweight=25;.*ivekit_retain_state=1/m
  );
  assert.doesNotMatch(rendered, /^100 sip:rustpbx-a-2\./m);
  assert.doesNotMatch(rendered, /^100 sip:rustpbx-a-3\./m);
  assert.match(rendered, /^10002 sip:rustpbx-a-2\.internal:5060;transport=udp 8 10 .*pinset=10002/m);
  assert.match(rendered, /^10003 sip:rustpbx-a-3\.internal:5060;transport=udp 9 10 .*pinset=10003/m);
});

test('exhausted accepting nodes leave the new-call pool but retain their pin set', () => {
  const body = compileKamailioRouteSnapshotBody(compileInput([
    target('rustpbx-a-0', state('rustpbx-a-0', {
      safe_capacity: 2_500,
      used: 2_400,
      reserved: 100
    }))
  ]));
  const rendered = renderKamailioDispatcherList(body);

  assert.equal(body.pools[0]!.nodes[0]!.state, 'accepting');
  assert.equal(body.pools[0]!.nodes[0]!.routing_weight, 1);
  assert.doesNotMatch(rendered, /^100 /m);
  assert.match(rendered, /^10000 .* 8 10 /m);
});

test('dispatcher rendering is deterministic and stable pin sets do not depend on node order', () => {
  const first = compileKamailioRouteSnapshotBody(compileInput([
    target('rustpbx-a-1', state('rustpbx-a-1')),
    target('rustpbx-a-0', state('rustpbx-a-0'))
  ]));
  const second = compileKamailioRouteSnapshotBody(compileInput([
    target('rustpbx-a-0', state('rustpbx-a-0')),
    target('rustpbx-a-1', state('rustpbx-a-1'))
  ]));

  assert.deepEqual(first, second);
  assert.equal(renderKamailioDispatcherList(first), renderKamailioDispatcherList(second));
  assert.deepEqual(first.pools[0]!.nodes.map((node) => node.pin_set_id), [10_000, 10_001]);
});

test('compiler rejects topology mismatch, pin collisions and dispatcher injection', () => {
  const wrongZone = state('rustpbx-a-0', {}, { zone_id: 'zone-b' });
  assert.throws(
    () => compileKamailioRouteSnapshotBody(compileInput([target('rustpbx-a-0', wrongZone)])),
    /topology/i
  );

  const collision = compileInput([
    { ...target('rustpbx-a-0', state('rustpbx-a-0')), pin_set_id: 100 }
  ]);
  assert.throws(() => compileKamailioRouteSnapshotBody(collision), /collision/i);

  const injection = compileInput([
    {
      ...target('rustpbx-a-0', state('rustpbx-a-0')),
      sip_uri: 'sip:rustpbx-a-0.internal:5060;transport=udp\r\n999 sip:attacker'
    }
  ]);
  assert.throws(() => compileKamailioRouteSnapshotBody(injection), /SIP URI/i);
});

function compileInput(nodes: KamailioRoutePoolSource['nodes']) {
  return {
    sequence: 17,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    generated_at: '2026-07-21T08:00:00.000Z',
    ttl_ms: 10_000,
    edge_replica_count: 2,
    degraded_weight_factor: 0.5,
    pools: [{
      pool_id: 100,
      profile_id: 'cell-10k-v1',
      capacity_dimension: 'voice.weighted_calls',
      nodes
    }]
  };
}

function target(
  nodeId: string,
  componentState: ComponentNodeStateSnapshot | null
): KamailioRoutePoolSource['nodes'][number] {
  const ordinal = Number(nodeId.slice(nodeId.lastIndexOf('-') + 1));
  return {
    node_id: nodeId,
    sip_uri: `sip:${nodeId}.internal:5060;transport=udp`,
    pin_set_id: 10_000 + ordinal,
    priority: 10,
    safe_capacity_fallback: 2_500,
    state: componentState
  };
}

function state(
  nodeId: string,
  capacity: Partial<{ safe_capacity: number; used: number; reserved: number }> = {},
  overrides: Partial<ComponentNodeStateSnapshot> = {}
): ComponentNodeStateSnapshot {
  return {
    component: 'rustpbx',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    node_id: nodeId,
    state: 'accepting',
    state_sequence: 12,
    drain_started_at: '',
    cell_lease_epoch: 7,
    lease_observed_at: '2026-07-21T07:59:59.000Z',
    lease_expires_at: '2026-07-21T08:00:10.000Z',
    lease_fresh: true,
    recovery_pending: false,
    dimensions: {
      'voice.weighted_calls': {
        unit: 'calls',
        safe_capacity: capacity.safe_capacity ?? 2_500,
        used: capacity.used ?? 800,
        reserved: capacity.reserved ?? 100
      }
    },
    reservations: { reserved: 100, active: 800, expired: 0, closed: 0 },
    ...overrides
  };
}
