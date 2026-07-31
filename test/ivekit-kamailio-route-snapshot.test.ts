import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  KamailioRouteSnapshotCodec,
  type KamailioRouteSnapshotBody
} from '../src/agent-runtime/ivekit/voice/kamailio-route-snapshot.js';

const CURRENT_KEY = Buffer.alloc(32, 7);
const PREVIOUS_KEY = Buffer.alloc(32, 6);
const VERIFY_AT = new Date('2026-07-21T08:00:05.000Z');

test('Kamailio route snapshot is canonical, signed and immutable', () => {
  const codec = routeCodec();
  const wire = codec.encode(snapshotBody());

  assert.match(wire, /^ivekit-kamailio-route-v1\.route-key-2\.[A-Za-z0-9_-]{43}\n\{/);
  const verified = codec.verify(wire, verificationInput());

  assert.equal(verified.key_id, 'route-key-2');
  assert.equal(verified.body.sequence, 17);
  assert.equal(verified.body.pools[0]?.nodes[0]?.node_id, 'rustpbx-a-0');
  assert.equal(Object.isFrozen(verified.body), true);
  assert.equal(Object.isFrozen(verified.body.pools[0]?.nodes[0]), true);
  assert.throws(() => {
    (verified.body.pools[0]!.nodes[0] as { state: string }).state = 'offline';
  }, TypeError);

  const encodedAgain = codec.encode(structuredClone(snapshotBody()));
  assert.equal(encodedAgain, wire);
});

test('Kamailio route snapshot accepts previous key but writer always uses current key', () => {
  const oldCodec = new KamailioRouteSnapshotCodec({
    current: { key_id: 'route-key-1', key: PREVIOUS_KEY }
  });
  const rotatedCodec = routeCodec();

  const oldVerified = rotatedCodec.verify(
    oldCodec.encode(snapshotBody()),
    verificationInput()
  );
  assert.equal(oldVerified.key_id, 'route-key-1');
  assert.match(rotatedCodec.encode(snapshotBody()), /^ivekit-kamailio-route-v1\.route-key-2\./);

  const withoutPrevious = new KamailioRouteSnapshotCodec({
    current: { key_id: 'route-key-2', key: CURRENT_KEY }
  });
  assert.throws(
    () => withoutPrevious.verify(oldCodec.encode(snapshotBody()), verificationInput()),
    hasCode('unknown_route_snapshot_key')
  );
});

test('Kamailio route snapshot rejects tampering and non-canonical or unknown fields', () => {
  const codec = routeCodec();
  const wire = codec.encode(snapshotBody());
  const tampered = wire.replace('"used":800', '"used":801');
  assert.throws(
    () => codec.verify(tampered, verificationInput()),
    hasCode('invalid_route_snapshot_signature')
  );

  const bodyWithUnknown = {
    ...snapshotBody(),
    remote_control_url: 'https://control.example.invalid'
  };
  assert.throws(
    () => codec.verify(signRaw(bodyWithUnknown, 'route-key-2', CURRENT_KEY), verificationInput()),
    hasCode('invalid_route_snapshot')
  );

  const canonical = canonicalJson(snapshotBody());
  const nonCanonical = ` {${canonical.slice(1)}`;
  const signature = createHmac('sha256', CURRENT_KEY).update(nonCanonical).digest('base64url');
  assert.throws(
    () => codec.verify(
      `ivekit-kamailio-route-v1.route-key-2.${signature}\n${nonCanonical}`,
      verificationInput()
    ),
    hasCode('invalid_route_snapshot')
  );
});

test('Kamailio route snapshot fences topology, lease epoch and sequence', () => {
  const codec = routeCodec();
  const wire = codec.encode(snapshotBody());

  assert.throws(
    () => codec.verify(wire, { ...verificationInput(), expected_cell_id: 'cell-b' }),
    hasCode('route_snapshot_identity_mismatch')
  );
  assert.throws(
    () => codec.verify(wire, { ...verificationInput(), expected_cell_lease_epoch: 8 }),
    hasCode('route_snapshot_epoch_mismatch')
  );
  assert.throws(
    () => codec.verify(wire, { ...verificationInput(), last_accepted_sequence: 17 }),
    hasCode('route_snapshot_sequence_regression')
  );
  assert.equal(codec.verify(wire, {
    ...verificationInput(),
    last_accepted_sequence: 16
  }).body.sequence, 17);
});

test('Kamailio route snapshot enforces validity window and five minute TTL', () => {
  const codec = routeCodec();
  const wire = codec.encode(snapshotBody());

  assert.throws(
    () => codec.verify(wire, {
      ...verificationInput(),
      now: new Date('2026-07-21T07:59:59.999Z')
    }),
    hasCode('route_snapshot_not_yet_valid')
  );
  assert.throws(
    () => codec.verify(wire, {
      ...verificationInput(),
      now: new Date('2026-07-21T08:00:10.000Z')
    }),
    hasCode('route_snapshot_expired')
  );

  const tooLong = snapshotBody();
  tooLong.expires_at = '2026-07-21T08:05:00.001Z';
  assert.throws(() => codec.encode(tooLong), hasCode('invalid_route_snapshot'));

  const tooShort = snapshotBody();
  tooShort.expires_at = '2026-07-21T08:00:00.999Z';
  assert.throws(() => codec.encode(tooShort), hasCode('invalid_route_snapshot'));
});

test('Kamailio route snapshot validates pool, node and capacity invariants', () => {
  const codec = routeCodec();

  const duplicateNode = snapshotBody();
  duplicateNode.pools[0]!.nodes.push(structuredClone(duplicateNode.pools[0]!.nodes[0]!));
  assert.throws(() => codec.encode(duplicateNode), hasCode('invalid_route_snapshot'));

  const duplicatePinSet = snapshotBody();
  const secondNode = structuredClone(duplicatePinSet.pools[0]!.nodes[0]!);
  secondNode.node_id = 'rustpbx-a-1';
  secondNode.sip_uri = 'sip:rustpbx-a-1.rustpbx-headless:5060;transport=udp';
  duplicatePinSet.pools[0]!.nodes.push(secondNode);
  assert.throws(() => codec.encode(duplicatePinSet), hasCode('invalid_route_snapshot'));

  const exhaustedAccepting = snapshotBody();
  exhaustedAccepting.pools[0]!.nodes[0]!.reserved = 1_700;
  assert.match(codec.encode(exhaustedAccepting), /"reserved":1700/);

  const invalidUri = snapshotBody();
  invalidUri.pools[0]!.nodes[0]!.sip_uri = 'sip:alice:password@rustpbx-a-0:5060';
  assert.throws(() => codec.encode(invalidUri), hasCode('invalid_route_snapshot'));

  const pinSetCollidesWithPool = snapshotBody();
  pinSetCollidesWithPool.pools[0]!.nodes[0]!.pin_set_id = 100;
  assert.throws(() => codec.encode(pinSetCollidesWithPool), hasCode('invalid_route_snapshot'));
});

test('Kamailio route snapshot bounds node count and wire size before parsing', () => {
  const codec = routeCodec();
  const oversized = snapshotBody();
  oversized.pools[0]!.nodes = Array.from({ length: 1_025 }, (_, index) => ({
    ...structuredClone(oversized.pools[0]!.nodes[0]!),
    node_id: `rustpbx-a-${index}`,
    sip_uri: `sip:rustpbx-a-${index}.rustpbx-headless:5060;transport=udp`,
    pin_set_id: 10_000 + index
  }));
  assert.throws(() => codec.encode(oversized), hasCode('invalid_route_snapshot'));

  const hugeWire = `ivekit-kamailio-route-v1.route-key-2.${'a'.repeat(43)}\n${'x'.repeat(4 * 1024 * 1024)}`;
  assert.throws(
    () => codec.verify(hugeWire, verificationInput()),
    hasCode('route_snapshot_too_large')
  );
});

test('Kamailio route snapshot rejects weak, malformed or ambiguous rotation keys', () => {
  assert.throws(
    () => new KamailioRouteSnapshotCodec({
      current: { key_id: 'route-key-2', key: Buffer.alloc(31, 1) }
    }),
    /too short/i
  );
  assert.throws(
    () => new KamailioRouteSnapshotCodec({
      current: { key_id: 'route-key-2', key: CURRENT_KEY },
      previous: { key_id: 'route-key-2', key: PREVIOUS_KEY }
    }),
    /different key ids/i
  );
});

function routeCodec(): KamailioRouteSnapshotCodec {
  return new KamailioRouteSnapshotCodec({
    current: { key_id: 'route-key-2', key: CURRENT_KEY },
    previous: { key_id: 'route-key-1', key: PREVIOUS_KEY }
  });
}

function verificationInput() {
  return {
    now: VERIFY_AT,
    expected_region_id: 'region-a',
    expected_zone_id: 'zone-a',
    expected_cell_id: 'cell-a',
    expected_cell_lease_epoch: 7,
    last_accepted_sequence: 0
  };
}

function snapshotBody(): KamailioRouteSnapshotBody {
  return {
    schema_version: '1.0.0',
    sequence: 17,
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    cell_lease_epoch: 7,
    generated_at: '2026-07-21T08:00:00.000Z',
    expires_at: '2026-07-21T08:00:10.000Z',
    edge_replica_count: 2,
    pools: [{
      pool_id: 100,
      profile_id: 'cell-10k-v1',
      nodes: [{
        node_id: 'rustpbx-a-0',
        sip_uri: 'sip:rustpbx-a-0.rustpbx-headless:5060;transport=udp',
        pin_set_id: 10_000,
        state: 'accepting',
        safe_capacity: 2_500,
        used: 800,
        reserved: 50,
        routing_weight: 100,
        priority: 10
      }]
    }]
  };
}

function signRaw(body: unknown, keyId: string, key: Buffer): string {
  const raw = canonicalJson(body);
  const signature = createHmac('sha256', key).update(raw).digest('base64url');
  return `ivekit-kamailio-route-v1.${keyId}.${signature}\n${raw}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  ).join(',')}}`;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => Boolean(
    error && typeof error === 'object' && (error as { code?: string }).code === code
  );
}
