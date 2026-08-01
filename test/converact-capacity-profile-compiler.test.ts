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
    seed: 'converact-capacity-seed-001',
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
  assert.equal(first.manifest.shards.length, 28);
  assert.doesNotThrow(() => validateLoadRunManifest(first.manifest, first.manifest_sha256, profile, forkManifest));

  const interactionCount = first.manifest.shards
    .flatMap((shard) => [
      {
        workload_domain: shard.workload_domain,
        expected_count: shard.expected_count
      },
      ...(shard.covered_workloads || [])
    ])
    .filter((workload) => workload.workload_domain === 'interaction')
    .reduce((sum, workload) => sum + workload.expected_count, 0);
  assert.equal(interactionCount, 10_000);

  const tinodeRanges = first.manifest.shards
    .flatMap((shard) => shard.covered_workloads || [])
    .filter((workload) => workload.workload_id === 'tinode_im')
    .map((workload) => [workload.ordinal_start, workload.ordinal_end_exclusive]);
  assert.deepEqual(tinodeRanges, [[0, 2000], [2000, 4000], [4000, 6000]]);
  const tinodeConnectionShards = first.manifest.shards
    .filter((shard) => shard.workload_id === 'tinode_websocket');
  assert.deepEqual(
    tinodeConnectionShards.map((shard) => [
      shard.ordinal_start,
      shard.ordinal_end_exclusive,
      shard.covered_workloads?.[0]?.expected_count
    ]),
    [[0, 3000, 2000], [3000, 6000, 2000], [6000, 9000, 2000]]
  );
  assert.equal(
    first.manifest.shards.some((shard) =>
      shard.workload_domain === 'interaction' && shard.workload_id === 'tinode_im'),
    false
  );

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
  assert.deepEqual(
    scaled.manifest.shards
      .find((shard) => shard.workload_id === 'tinode_websocket')
      ?.covered_workloads,
    [{
      workload_domain: 'interaction',
      workload_id: 'tinode_im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 200,
      expected_count: 200
    }]
  );
  assert.equal(scaled.manifest.capacity_context?.units, 4);
  assert.equal(scaled.manifest.profile_sha256, compileLoadRunManifest(input).manifest.profile_sha256);
  assert.doesNotThrow(() => validateLoadRunManifest(
    scaled.manifest,
    scaled.manifest_sha256,
    profile,
    forkManifest
  ));
});

test('profile compiler rejects multiple Tinode IM workloads for one connection pool', () => {
  const split = structuredClone(profile);
  const original = split.interactions.categories
    .find((category: any) => category.id === 'tinode_im');
  original.id = 'tinode_im_retail';
  original.count = 3000;
  original.disjoint_from.push('tinode_im_enterprise');
  split.interactions.categories.push({
    ...structuredClone(original),
    id: 'tinode_im_enterprise',
    disjoint_from: [
      'tinode_im_retail',
      ...original.disjoint_from.filter((id: string) => id !== 'tinode_im_enterprise')
    ]
  });
  for (const category of split.interactions.categories) {
    if (category.kind === 'tinode_im') continue;
    category.disjoint_from = category.disjoint_from.flatMap((id: string) =>
      id === 'tinode_im' ? ['tinode_im_retail', 'tinode_im_enterprise'] : [id]);
  }

  assert.throws(
    () => compileLoadRunManifest({
      ...input,
      profile: split,
      shardSizeByWorkloadId: {
        ...input.shardSizeByWorkloadId,
        tinode_im_retail: 1000,
        tinode_im_enterprise: 1000
      }
    }),
    /multiple workloads use kind tinode_im/
  );
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
    run: { ...input.run, seed: 'converact-capacity-seed-002' }
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

test('capacity profiles bind all primary voice ownership to RustPBX and exclude LiveKit SIP', () => {
  assert.equal(profile.schema_version, '1.3.0');
  assert.equal(profile.revision, 3);
  assert.deepEqual(profile.signaling.sip.ownership, {
    dialog_owner: 'rustpbx',
    rtp_owner: 'rustpbx',
    recording_owner: 'rustpbx',
    admission_owner: 'rustpbx',
    livekit_sip: {
      mode: 'optional_bridge_excluded',
      enabled_in_profile: false,
      counts_toward_profile: false,
      owns_dialogs: false,
      owns_rtp: false,
      owns_recording: false,
      owns_admission: false
    }
  });
});

test('capacity profile forbids recording storage from backpressuring established media', () => {
  assert.deepEqual(profile.recording.failure_isolation, {
    established_media: 'continue_fail_open',
    storage_dependency: 'downstream_only',
    media_hot_path_backpressure: 'forbidden',
    queue_policy: 'bounded_non_blocking',
    overload_action: 'drop_or_fail_recording_only'
  });
});

test('capacity profile binds endpoint QoE, weak-network and resource evidence to every run', () => {
  assert.equal(profile.schema_version, '1.3.0');
  assert.equal(profile.performance_contract.schema_version, '1.0.0');
  assert.equal(
    profile.performance_contract.measurement_scope,
    'same_region_controlled_endpoint_to_endpoint'
  );
  assert.deepEqual(profile.performance_contract.required_quantiles, ['p50', 'p95', 'p99']);
  assert.equal(profile.performance_contract.latency_ms.voice_mouth_to_ear_p95, 150);
  assert.equal(profile.performance_contract.latency_ms.livekit_glass_to_glass_p95, 250);
  assert.equal(profile.performance_contract.latency_ms.rustdesk_input_to_photon_p95, 200);
  assert.equal(profile.performance_contract.media_quality.jitter_p99_ms, 30);
  assert.equal(profile.performance_contract.media_quality.server_packet_loss_ratio, 0.001);
  assert.deepEqual(profile.performance_contract.overload.degradation_order, [
    'preserve_audio',
    'reduce_video_layers',
    'reduce_video_frame_rate',
    'drop_auxiliary_realtime_copies',
    'reject_new_admission'
  ]);
  assert.deepEqual(
    profile.performance_contract.impairment_profiles.map((item: any) => item.id),
    ['baseline', 'constrained_bandwidth', 'lossy_jitter', 'network_handoff', 'cross_region']
  );

  const compiled = compileLoadRunManifest(input);
  assert.deepEqual(compiled.manifest.performance_contract, profile.performance_contract);
});

test('profile compiler rejects average-only, incomplete or unsafe RTC performance contracts', () => {
  const averageOnly = structuredClone(profile);
  assert.ok(averageOnly.performance_contract, 'performance contract is missing');
  averageOnly.performance_contract.required_quantiles = ['p50'];
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: averageOnly }),
    /P50.*P95.*P99|quantiles/i
  );

  const missingWeakNetwork = structuredClone(profile);
  missingWeakNetwork.performance_contract.impairment_profiles =
    missingWeakNetwork.performance_contract.impairment_profiles
      .filter((item: any) => item.id !== 'network_handoff');
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: missingWeakNetwork }),
    /network_handoff|impairment/i
  );

  const videoFirst = structuredClone(profile);
  videoFirst.performance_contract.overload.degradation_order = [
    'reduce_video_layers',
    'preserve_audio',
    'reduce_video_frame_rate',
    'drop_auxiliary_realtime_copies',
    'reject_new_admission'
  ];
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: videoFirst }),
    /audio.*degradation|degradation.*audio/i
  );
});

test('profile compiler rejects a recording policy that can terminate or backpressure media', () => {
  const blockingStorage = structuredClone(profile);
  blockingStorage.recording.failure_isolation.media_hot_path_backpressure = 'allowed';
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: blockingStorage }),
    /recording storage.*media/i
  );

  const failClosedMedia = structuredClone(profile);
  failClosedMedia.recording.failure_isolation.established_media = 'terminate_fail_closed';
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: failClosedMedia }),
    /recording storage.*media/i
  );
});

test('profile compiler rejects duplicate RustPBX and LiveKit SIP voice ownership', () => {
  const duplicateDialogOwner = structuredClone(profile);
  duplicateDialogOwner.signaling.sip.ownership.dialog_owner = 'livekit-sip';
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: duplicateDialogOwner }),
    /voice ownership.*RustPBX/i
  );

  const enabledBridge = structuredClone(profile);
  enabledBridge.signaling.sip.ownership.livekit_sip.enabled_in_profile = true;
  assert.throws(
    () => compileLoadRunManifest({ ...input, profile: enabledBridge }),
    /LiveKit SIP.*excluded/i
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
