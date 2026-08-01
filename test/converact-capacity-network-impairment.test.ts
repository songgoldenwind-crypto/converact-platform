import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';

import {
  FencedNetworkImpairmentController,
  buildNetworkImpairmentPlan,
  type NetworkImpairmentCommand
} from '../scripts/capacity/generators/network-impairment.js';
import {
  createNetworkImpairmentHttpServer,
  networkImpairmentRuntimeConfig
} from '../scripts/converact-capacity-network-impairment.js';

test('network impairment plan shapes upload and download from one contracted profile', () => {
  const plan = buildNetworkImpairmentPlan({
    lease: lease('7'),
    interface_name: 'eth0',
    ifb_interface_name: 'ifb-ivekit0',
    profile: profile()
  });

  assert.equal(plan.schema_version, '1.0.0');
  assert.equal(plan.one_way_delay_ms, 60);
  assert.equal(plan.one_way_jitter_ms, 20);
  assert.equal(plan.apply.some((command) => command.args.join(' ').includes('rate 1500kbit')), true);
  assert.equal(plan.apply.some((command) => command.args.join(' ').includes('rate 3000kbit')), true);
  assert.equal(plan.apply.filter((command) => command.args.includes('5%')).length, 2);
  assert.equal(plan.blackout.filter((command) => command.args.includes('100%')).length, 2);
  assert.equal(plan.restore.length > 0, true);
});

test('fenced network controller restores base shaping after a bounded blackout', async () => {
  const commands: NetworkImpairmentCommand[] = [];
  const waits: number[] = [];
  const controller = new FencedNetworkImpairmentController({
    execute: async (command) => {
      commands.push(command);
      return { code: 0, stderr: '' };
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
    now: () => '2026-07-22T00:00:00.000Z'
  });
  const plan = buildNetworkImpairmentPlan({
    lease: lease('7'),
    interface_name: 'eth0',
    ifb_interface_name: 'ifb-ivekit0',
    profile: profile()
  });

  const applied = await controller.apply(plan);
  const blackout = await controller.runBlackout(lease('7'));
  const released = await controller.release(lease('7'));

  assert.equal(applied.schema_version, '1.1.0');
  assert.equal(applied.profile.id, 'lossy_jitter');
  assert.equal(applied.interface_name, 'eth0');
  assert.equal(applied.ifb_interface_name, 'ifb-ivekit0');
  assert.equal(blackout.blackout_ms, 2_000);
  assert.deepEqual(waits, [2_000]);
  assert.equal(commands.some((command) => command.args.includes('100%')), true);
  assert.equal(released.schema_version, '1.0.0');
  assert.equal(released.released, true);
  assert.equal(released.released_at, '2026-07-22T00:00:00.000Z');
});

test('fenced network controller rejects stale release and preserves the active lease', async () => {
  const commands: NetworkImpairmentCommand[] = [];
  const controller = new FencedNetworkImpairmentController({
    execute: async (command) => {
      commands.push(command);
      return { code: 0, stderr: '' };
    }
  });
  await controller.apply(buildNetworkImpairmentPlan({
    lease: lease('8'),
    interface_name: 'eth0',
    ifb_interface_name: 'ifb-ivekit0',
    profile: profile()
  }));
  const commandCount = commands.length;

  await assert.rejects(() => controller.release(lease('7')), /stale|lease/i);

  assert.equal(commands.length, commandCount);
  assert.equal(controller.activeLease()?.lease_epoch, '8');
});

test('network controller rolls back partially applied shaping on command failure', async () => {
  const commands: NetworkImpairmentCommand[] = [];
  let calls = 0;
  const controller = new FencedNetworkImpairmentController({
    execute: async (command) => {
      commands.push(command);
      calls += 1;
      return calls === 4
        ? { code: 2, stderr: 'netem rejected' }
        : { code: 0, stderr: '' };
    }
  });
  const plan = buildNetworkImpairmentPlan({
    lease: lease('7'),
    interface_name: 'eth0',
    ifb_interface_name: 'ifb-ivekit0',
    profile: profile()
  });

  await assert.rejects(() => controller.apply(plan), /netem rejected/i);

  assert.equal(commands.some((command) => command.operation === 'restore'), true);
  assert.equal(controller.activeLease(), null);
});

test('network impairment sidecar exposes loopback-only fenced apply, blackout and release', async () => {
  const commands: NetworkImpairmentCommand[] = [];
  const controller = new FencedNetworkImpairmentController({
    execute: async (command) => {
      commands.push(command);
      return { code: 0, stderr: '' };
    },
    wait: async () => undefined,
    now: () => '2026-07-22T00:00:00.000Z'
  });
  const server = createNetworkImpairmentHttpServer({
    config: networkImpairmentRuntimeConfig({
      CONVERACT_FABRIC_NETWORK_IMPAIRMENT_HOST: '127.0.0.1',
      CONVERACT_FABRIC_NETWORK_IMPAIRMENT_PORT: '0',
      CONVERACT_FABRIC_NETWORK_IMPAIRMENT_INTERFACE: 'eth0',
      CONVERACT_FABRIC_NETWORK_IMPAIRMENT_IFB_INTERFACE: 'ifb-ivekit0'
    }),
    controller
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const apply = await post(address.port, '/v1/apply', { lease: lease('7'), profile: profile() });
    const blackout = await post(address.port, '/v1/blackout', { lease: lease('7') });
    const release = await post(address.port, '/v1/release', { lease: lease('7') });

    assert.equal(apply.status, 200);
    assert.equal(apply.body.schema_version, '1.1.0');
    assert.equal(apply.body.profile.id, 'lossy_jitter');
    assert.equal(apply.body.interface_name, 'eth0');
    assert.equal(blackout.status, 200);
    assert.equal(blackout.body.blackout_ms, 2_000);
    assert.equal(release.status, 200);
    assert.equal(release.body.released, true);
    assert.equal(commands.length > 0, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('network impairment runtime refuses non-loopback exposure', () => {
  assert.throws(() => networkImpairmentRuntimeConfig({
    CONVERACT_FABRIC_NETWORK_IMPAIRMENT_HOST: '0.0.0.0',
    CONVERACT_FABRIC_NETWORK_IMPAIRMENT_PORT: '3199',
    CONVERACT_FABRIC_NETWORK_IMPAIRMENT_INTERFACE: 'eth0',
    CONVERACT_FABRIC_NETWORK_IMPAIRMENT_IFB_INTERFACE: 'ifb-ivekit0'
  }), /loopback/i);
});

test('network impairment lease epoch must remain a decimal string across JSON boundaries', () => {
  assert.throws(() => buildNetworkImpairmentPlan({
    lease: { ...lease('7'), lease_epoch: 7 as unknown as string },
    interface_name: 'eth0',
    ifb_interface_name: 'ifb-ivekit0',
    profile: profile()
  }), /lease epoch/i);
});

function lease(leaseEpoch: string) {
  return {
    run_id: 'run-capacity-001',
    shard_id: 'interaction/livekit_av/0-100',
    worker_id: 'livekit-worker-a',
    lease_epoch: leaseEpoch
  };
}

function profile() {
  return {
    id: 'lossy_jitter',
    round_trip_time_ms: 120,
    jitter_ms: 40,
    packet_loss_ratio: 0.05,
    downstream_kbps: 3_000,
    upstream_kbps: 1_500,
    blackout_ms: 2_000
  };
}

async function post(port: number, path: string, body: Record<string, unknown>): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
