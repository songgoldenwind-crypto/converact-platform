import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveKitNetworkNamespaceAttestation,
  buildLiveKitNetworkNamespacePlan
} from '../scripts/capacity/generators/network-namespace.js';

test('builds a dedicated generator namespace with bounded veth and firewall commands', () => {
  const plan = buildLiveKitNetworkNamespacePlan({
    ordinal: 0,
    livekit_port: 7880
  });

  assert.equal(plan.schema_version, '1.0.0');
  assert.equal(plan.namespace_name, 'ivkgen0');
  assert.equal(plan.host_interface_name, 'ivkh0');
  assert.equal(plan.generator_interface_name, 'ivkn0');
  assert.equal(plan.ifb_interface_name, 'ivkifb0');
  assert.equal(plan.host_address, '10.203.24.1');
  assert.equal(plan.generator_address, '10.203.24.2');
  assert.equal(plan.livekit_url, 'ws://10.203.24.1:7880');
  assert.deepEqual(plan.setup[0], {
    executable: '/sbin/ip',
    args: ['netns', 'add', 'ivkgen0']
  });
  assert.equal(
    plan.setup.some((command) =>
      command.executable === '/usr/sbin/iptables' &&
      command.args.join(' ').includes(
        '-I INPUT 1 -i ivkh0 -p tcp --dport 7880'
      )),
    true
  );
  assert.equal(
    plan.setup.some((command) =>
      command.args.join(' ') ===
      'netns exec ivkgen0 /sbin/ip route add default via 10.203.24.1'),
    true
  );
  assert.equal(plan.restore.every((command) => command.ignore_failure), true);
  assert.deepEqual(plan.restore.at(-1), {
    executable: '/sbin/ip',
    args: ['link', 'del', 'ivkh0'],
    ignore_failure: true
  });
});

test('assigns collision-free bounded names and subnets per namespace ordinal', () => {
  const first = buildLiveKitNetworkNamespacePlan({ ordinal: 1, livekit_port: 7880 });
  const last = buildLiveKitNetworkNamespacePlan({ ordinal: 199, livekit_port: 8443 });

  assert.equal(first.host_address, '10.203.25.1');
  assert.equal(last.host_address, '10.203.223.1');
  assert.equal(last.namespace_name, 'ivkgen199');
  assert.equal(last.livekit_url, 'ws://10.203.223.1:8443');
  assert.equal(last.host_interface_name.length <= 15, true);
  assert.equal(last.generator_interface_name.length <= 15, true);
  assert.equal(last.ifb_interface_name.length <= 15, true);
});

test('rejects namespace ordinals and LiveKit ports outside the contracted range', () => {
  assert.throws(
    () => buildLiveKitNetworkNamespacePlan({ ordinal: -1, livekit_port: 7880 }),
    /ordinal/i
  );
  assert.throws(
    () => buildLiveKitNetworkNamespacePlan({ ordinal: 200, livekit_port: 7880 }),
    /ordinal/i
  );
  assert.throws(
    () => buildLiveKitNetworkNamespacePlan({ ordinal: 0, livekit_port: 0 }),
    /port/i
  );
});

test('attests the observed veth addresses and generator default route', () => {
  const plan = buildLiveKitNetworkNamespacePlan({ ordinal: 0, livekit_port: 7_880 });
  const attestation = buildLiveKitNetworkNamespaceAttestation({
    plan,
    lease: {
      run_id: 'run-livekit-netns-001',
      shard_id: 'interaction/livekit-av/0-1',
      worker_id: 'livekit-worker-a',
      lease_epoch: '7'
    },
    observed_at: '2026-07-24T00:00:00.000Z',
    host_interfaces: [{
      ifname: 'ivkh0',
      addr_info: [{ family: 'inet', local: '10.203.24.1', prefixlen: 30 }]
    }],
    generator_interfaces: [{
      ifname: 'ivkn0',
      addr_info: [{ family: 'inet', local: '10.203.24.2', prefixlen: 30 }]
    }],
    generator_routes: [{
      dst: 'default',
      gateway: '10.203.24.1',
      dev: 'ivkn0'
    }]
  });

  assert.equal(attestation.namespace_name, 'ivkgen0');
  assert.equal(attestation.host_address, '10.203.24.1/30');
  assert.equal(attestation.generator_address, '10.203.24.2/30');
  assert.equal(attestation.default_route_via, '10.203.24.1');
});

test('rejects a namespace observation with an unexpected default route', () => {
  const plan = buildLiveKitNetworkNamespacePlan({ ordinal: 0, livekit_port: 7_880 });

  assert.throws(() => buildLiveKitNetworkNamespaceAttestation({
    plan,
    lease: {
      run_id: 'run-livekit-netns-001',
      shard_id: 'interaction/livekit-av/0-1',
      worker_id: 'livekit-worker-a',
      lease_epoch: '7'
    },
    observed_at: '2026-07-24T00:00:00.000Z',
    host_interfaces: [{
      ifname: 'ivkh0',
      addr_info: [{ family: 'inet', local: '10.203.24.1', prefixlen: 30 }]
    }],
    generator_interfaces: [{
      ifname: 'ivkn0',
      addr_info: [{ family: 'inet', local: '10.203.24.2', prefixlen: 30 }]
    }],
    generator_routes: [{
      dst: 'default',
      gateway: '10.203.24.9',
      dev: 'ivkn0'
    }]
  }), /default route/i);
});
