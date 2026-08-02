import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import {
  PLATFORM_DRAIN_AUTHORITIES,
  PlatformDrainCoordinator,
  signPlatformDrainReceipt,
  type PlatformClock,
  type PlatformDrainAuthority,
  type SignedPlatformDrainReceipt
} from '../src/agent-runtime/converact/platform-foundation/index.js';

class MutableClock implements PlatformClock {
  constructor(
    public wall: Date,
    public monotonic: number
  ) {}

  wallNow(): Date {
    return new Date(this.wall);
  }

  monotonicNowMs(): number {
    return this.monotonic;
  }
}

function keyFixture(): {
  privateKeys: Map<PlatformDrainAuthority, ReturnType<typeof generateKeyPairSync>['privateKey']>;
  publicKeys: Record<string, ReturnType<typeof generateKeyPairSync>['publicKey']>;
  authorityKeyIds: Record<PlatformDrainAuthority, string>;
} {
  const privateKeys = new Map();
  const publicKeys: Record<string, ReturnType<typeof generateKeyPairSync>['publicKey']> = {};
  const authorityKeyIds = {} as Record<PlatformDrainAuthority, string>;
  for (const authority of PLATFORM_DRAIN_AUTHORITIES) {
    const pair = generateKeyPairSync('ed25519');
    const keyId = `drain-${authority}-key-v1`;
    privateKeys.set(authority, pair.privateKey);
    publicKeys[keyId] = pair.publicKey;
    authorityKeyIds[authority] = keyId;
  }
  return { privateKeys, publicKeys, authorityKeyIds };
}

function coordinatorFixture(clock: MutableClock) {
  const keys = keyFixture();
  const coordinator = new PlatformDrainCoordinator({
    drain_id: 'drain-a',
    node_id: 'node-a',
    owner_epoch: '4294967297',
    required_authorities: PLATFORM_DRAIN_AUTHORITIES,
    authority_key_ids: keys.authorityKeyIds,
    public_keys: keys.publicKeys,
    clock,
    timeout_ms: 10_000,
    receipt_max_age_ms: 5_000,
    max_clock_skew_ms: 500
  });
  return { coordinator, ...keys };
}

function receipt(
  fixture: ReturnType<typeof coordinatorFixture>,
  authority: PlatformDrainAuthority,
  activeCount: string,
  revision = 1
): SignedPlatformDrainReceipt {
  return signPlatformDrainReceipt({
    key_id: fixture.authorityKeyIds[authority],
    private_key: fixture.privateKeys.get(authority)!,
    body: {
      schema_version: '1.0.0',
      drain_id: 'drain-a',
      node_id: 'node-a',
      owner_epoch: '4294967297',
      authority,
      receipt_revision: revision,
      active_count: activeCount,
      active_id_digest: 'a'.repeat(64),
      observed_at: '2026-08-02T08:00:00.000Z',
      expires_at: '2026-08-02T08:00:05.000Z'
    }
  });
}

test('signed active-zero receipts bind authority drain node epoch count and revision', () => {
  const clock = new MutableClock(new Date('2026-08-02T08:00:01.000Z'), 1_000);
  const fixture = coordinatorFixture(clock);
  fixture.coordinator.startRouteDrain();
  fixture.coordinator.stopWorkerClaims();
  fixture.coordinator.beginAuthorityDrain();

  const signed = receipt(fixture, 'communication_attached_generations', '1');
  assert.equal(fixture.coordinator.observeReceipt(signed).active_count, '1');

  const tampered = structuredClone(signed);
  tampered.body.active_count = '0';
  assert.throws(
    () => fixture.coordinator.observeReceipt(tampered),
    (error: any) => error?.code === 'drain_receipt_signature_invalid'
  );
  assert.throws(
    () => signPlatformDrainReceipt({
      key_id: fixture.authorityKeyIds.communication_attached_generations,
      private_key: fixture.privateKeys.get('communication_attached_generations')!,
      body: { ...signed.body, active_count: '18446744073709551616', receipt_revision: 2 }
    }),
    (error: any) => error?.code === 'drain_receipt_active_count_invalid'
  );
});

test('drain reaches stopped only after every required authority reports a fresh signed zero', () => {
  const clock = new MutableClock(new Date('2026-08-02T08:00:01.000Z'), 1_000);
  const fixture = coordinatorFixture(clock);
  const phases = [fixture.coordinator.snapshot().phase];
  phases.push(fixture.coordinator.startRouteDrain().phase);
  phases.push(fixture.coordinator.stopWorkerClaims().phase);
  phases.push(fixture.coordinator.beginAuthorityDrain().phase);

  for (const authority of PLATFORM_DRAIN_AUTHORITIES) {
    fixture.coordinator.observeReceipt(receipt(
      fixture,
      authority,
      authority === 'communication_attached_generations' ? '1' : '0'
    ));
  }
  clock.wall = new Date('2026-08-02T08:00:05.000Z');
  assert.throws(
    () => fixture.coordinator.verifyActiveZero(),
    (error: any) => error?.code === 'drain_receipt_stale'
  );
  clock.wall = new Date('2026-08-02T08:00:01.000Z');
  assert.deepEqual(fixture.coordinator.verifyActiveZero(), {
    verified: false,
    missing_authorities: [],
    nonzero_authorities: ['communication_attached_generations']
  });
  assert.throws(
    () => fixture.coordinator.stop(),
    (error: any) => error?.code === 'drain_transition_invalid'
  );

  fixture.coordinator.observeReceipt(receipt(
    fixture,
    'communication_attached_generations',
    '0',
    2
  ));
  assert.deepEqual(fixture.coordinator.verifyActiveZero(), {
    verified: true,
    missing_authorities: [],
    nonzero_authorities: []
  });
  phases.push(fixture.coordinator.snapshot().phase);
  phases.push(fixture.coordinator.quiesce().phase);
  phases.push(fixture.coordinator.stop().phase);

  assert.deepEqual(phases, [
    'accepting',
    'route_draining',
    'worker_draining',
    'authority_draining',
    'active_zero_verified',
    'quiesced',
    'stopped'
  ]);
  assert.equal(fixture.coordinator.snapshot().receipt_count, PLATFORM_DRAIN_AUTHORITIES.length);
});

test('drain rejects stale receipt revisions and fails closed on monotonic timeout or restart', () => {
  const clock = new MutableClock(new Date('2026-08-02T08:00:01.000Z'), 1_000);
  const fixture = coordinatorFixture(clock);
  fixture.coordinator.startRouteDrain();
  fixture.coordinator.stopWorkerClaims();
  fixture.coordinator.beginAuthorityDrain();
  fixture.coordinator.observeReceipt(receipt(fixture, 'platform_worker_leases', '1', 2));
  assert.throws(
    () => fixture.coordinator.observeReceipt(receipt(fixture, 'platform_worker_leases', '0', 1)),
    (error: any) => error?.code === 'drain_receipt_revision_stale'
  );

  clock.monotonic = 11_001;
  assert.equal(fixture.coordinator.pollDeadline(['interaction-a', 'effect-a']).phase, 'drain_failed');
  assert.match(fixture.coordinator.snapshot().active_id_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(fixture.coordinator.snapshot()).includes('interaction-a'), false);

  const restartClock = new MutableClock(new Date('2026-08-02T08:00:01.000Z'), 5_000);
  const restarted = coordinatorFixture(restartClock).coordinator;
  restarted.startRouteDrain();
  restartClock.monotonic = 4_999;
  assert.equal(restarted.pollDeadline([]).phase, 'drain_failed');
  assert.equal(restarted.snapshot().failure_code, 'drain_restart_reauthorization_required');

  const invalidClock = new MutableClock(new Date('invalid'), 8_000);
  const invalid = coordinatorFixture(invalidClock).coordinator;
  assert.throws(
    () => invalid.startRouteDrain(),
    (error: any) => error?.code === 'drain_clock_invalid'
  );
  assert.equal(invalid.snapshot().phase, 'drain_failed');
});
