import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  compileLoadRunManifest,
  formatLoadEntityId,
  validateLoadRunManifest
} from '../scripts/capacity/profile-compiler.js';

const profile = JSON.parse(readFileSync('docs/capacity/profiles/cell-10k-v1.json', 'utf8'));
const forkManifest = JSON.parse(readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8'));

const input = {
  profile,
  forkManifest,
  run: {
    runId: 'cell-10k-controlled-20260716-001',
    seed: 'ivekit-capacity-seed-001',
    runEpoch: '2026-07-16T06:00:00.000Z',
    sutReleaseId: 'ivekit@0123456789abcdef0123456789abcdef01234567',
    generatorReleaseId: 'ivekit-loadgen@fedcba9876543210fedcba9876543210fedcba98',
    startNotBefore: '2026-07-16T06:30:00.000Z',
    evidencePrefix: 'capacity/cell-10k-controlled-20260716-001'
  },
  topology: {
    fleets: [
      { fleet_id: 'tinode', worker_count: 5, protocols: ['tinode_websocket'] },
      { fleet_id: 'ivekit_event_ws', worker_count: 5, protocols: ['ivekit_event_websocket'] },
      { fleet_id: 'sip', worker_count: 5, protocols: ['sip', 'rtp', 'sip_websocket'] },
      { fleet_id: 'livekit', worker_count: 5, protocols: ['livekit_webrtc'] },
      { fleet_id: 'rustdesk', worker_count: 5, protocols: ['rustdesk_native'] }
    ]
  },
  shardSizeByWorkloadId: {
    tinode_im: 2000,
    sip_voice: 1000,
    livekit_av: 500,
    livekit_screen: 100,
    rustdesk_remote: 100,
    tinode_websocket: 3000,
    ivekit_event_websocket: 1000,
    sip_registration: 1000,
    sip_websocket: 500,
    livekit_participant: 1000,
    rustdesk_endpoint: 200
  }
} as const;

test('profile compiler creates deterministic, immutable and complete shards', () => {
  const first = compileLoadRunManifest(input);
  const second = compileLoadRunManifest(input);

  assert.deepEqual(first, second);
  assert.equal(first.manifest.profile_id, 'cell-10k-v1');
  assert.equal(first.manifest.expected_totals.interactions, 10_000);
  assert.equal(first.manifest.expected_totals.connections, 20_500);
  assert.equal(first.manifest.shards.length, 31);
  assert.doesNotThrow(() => validateLoadRunManifest(first.manifest, first.manifest_sha256, profile, forkManifest));

  const interactionCount = first.manifest.shards
    .filter((shard) => shard.workload_domain === 'interaction')
    .reduce((sum, shard) => sum + shard.expected_count, 0);
  assert.equal(interactionCount, 10_000);

  const tinodeRanges = first.manifest.shards
    .filter((shard) => shard.workload_id === 'tinode_im')
    .map((shard) => [shard.ordinal_start, shard.ordinal_end_exclusive]);
  assert.deepEqual(tinodeRanges, [[0, 2000], [2000, 4000], [4000, 6000]]);

  assert.equal(
    formatLoadEntityId(first.manifest, 'interaction', 'tinode_im', 42),
    'cell-10k-controlled-20260716-001/interaction/tinode_im/42'
  );
  assert.throws(() => {
    (first.manifest.shards as unknown as Array<unknown>).push({});
  }, TypeError);
});

test('profile compiler scales the full workload ratio and binds exact curve identity', () => {
  const scaled = compileLoadRunManifest({
    ...input,
    run: {
      ...input.run,
      runId: 'cell-frontier-333-u4-001',
      targetInteractions: 333,
      capacityContext: {
        scope: 'component',
        component_role: 'tinode_im',
        units: 4,
        hardware_class: 'c32-64g-25gbe',
        hardware_sha256: '1'.repeat(64),
        configuration_class: 'tinode-v1',
        configuration_sha256: '2'.repeat(64),
        failure_reserve_sha256: '3'.repeat(64)
      }
    }
  });

  assert.deepEqual(scaled.manifest.profile_load, {
    base_interactions: 10_000,
    target_interactions: 333,
    scale_numerator: 333,
    scale_denominator: 10_000,
    apportionment: 'largest_remainder_v1'
  });
  assert.deepEqual(scaled.manifest.expected_totals.by_workload, {
    tinode_im: 200,
    sip_voice: 83,
    livekit_av: 33,
    livekit_screen: 10,
    rustdesk_remote: 7,
    tinode_websocket: 300,
    ivekit_event_websocket: 167,
    sip_registration: 83,
    sip_websocket: 33,
    livekit_participant: 87,
    rustdesk_endpoint: 13
  });
  assert.equal(scaled.manifest.expected_totals.interactions, 333);
  assert.equal(scaled.manifest.expected_totals.connections, 683);
  assert.equal(scaled.manifest.capacity_context?.units, 4);
  assert.equal(scaled.manifest.profile_sha256, compileLoadRunManifest(input).manifest.profile_sha256);
  assert.doesNotThrow(() => validateLoadRunManifest(
    scaled.manifest,
    scaled.manifest_sha256,
    profile,
    forkManifest
  ));
});

test('manifest hash binds profile, releases and seed', () => {
  const baseline = compileLoadRunManifest(input);
  const changedProfile = structuredClone(profile);
  changedProfile.messaging.business_messages_per_second += 1;

  const profileResult = compileLoadRunManifest({ ...input, profile: changedProfile });
  const releaseResult = compileLoadRunManifest({
    ...input,
    run: { ...input.run, generatorReleaseId: 'ivekit-loadgen@1111111111111111111111111111111111111111' }
  });
  const seedResult = compileLoadRunManifest({
    ...input,
    run: { ...input.run, seed: 'ivekit-capacity-seed-002' }
  });

  assert.notEqual(profileResult.manifest_sha256, baseline.manifest_sha256);
  assert.notEqual(releaseResult.manifest_sha256, baseline.manifest_sha256);
  assert.notEqual(seedResult.manifest_sha256, baseline.manifest_sha256);
});

test('profile compiler fails closed on inconsistent interaction totals', () => {
  const invalid = structuredClone(profile);
  invalid.interactions.total += 1;

  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: invalid }),
    /interaction total/i
  );
});

test('profile compiler rejects fleets that omit a shard-required protocol', () => {
  const topology = structuredClone(input.topology) as any;
  topology.fleets.find((fleet: any) => fleet.fleet_id === 'sip').protocols = ['sip'];

  assert.throws(
    () => compileLoadRunManifest({ ...input, topology }),
    /protocol.*rtp|rtp.*protocol/i
  );
});

test('manifest validation rejects overlap and tampering', () => {
  const compiled = compileLoadRunManifest(input);
  const tampered = structuredClone(compiled.manifest);
  tampered.shards[1].ordinal_start = tampered.shards[0].ordinal_start;

  assert.throws(
    () => validateLoadRunManifest(tampered, compiled.manifest_sha256, profile, forkManifest),
    /hash|overlap|coverage/i
  );
});
