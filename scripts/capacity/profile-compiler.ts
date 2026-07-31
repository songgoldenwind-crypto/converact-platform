import { canonicalSha256, deepFreeze } from './canonical-json.js';

export type WorkloadDomain = 'interaction' | 'connection';
export type LoadFleet = 'tinode' | 'ivekit_event_ws' | 'sip' | 'livekit' | 'rustdesk';

interface InteractionCategory {
  id: string;
  kind: string;
  count: number;
  disjoint_from: string[];
}

interface ConnectionCategory {
  id: string;
  kind: string;
  count: number;
}

export interface RtcPerformanceContract {
  schema_version: '1.0.0';
  measurement_scope: 'same_region_controlled_endpoint_to_endpoint';
  clock_sync: {
    method: 'monotonic_clock_with_observed_ntp_offset';
    maximum_offset_ms: number;
  };
  required_quantiles: string[];
  latency_ms: Record<string, number>;
  media_quality: Record<string, number>;
  reliability: Record<string, number>;
  recovery_ms: Record<string, number>;
  overload: {
    queue_policy: 'bounded';
    slow_consumer_policy: 'disconnect_or_degrade';
    minimum_jain_fairness_index: number;
    maximum_noisy_neighbor_p99_degradation_ratio: number;
    degradation_order: string[];
  };
  security_performance: {
    authorization_p99_ms: number;
    rate_limit_decision_p99_ms: number;
    overload_rejection_p99_ms: number;
    new_admission_fails_closed: boolean;
    established_media_avoids_remote_authorization: boolean;
  };
  required_resource_metrics: string[];
  impairment_profiles: Array<{
    id: string;
    round_trip_time_ms: number;
    jitter_ms: number;
    packet_loss_ratio: number;
    downstream_kbps: number;
    upstream_kbps: number;
    blackout_ms: number;
  }>;
}

export interface CapacityWorkloadProfile {
  schema_version: string;
  profile_id: string;
  interactions: {
    total: number;
    id_uniqueness: string;
    categories: InteractionCategory[];
  };
  connections: ConnectionCategory[];
  signaling: {
    sip: {
      ownership: {
        dialog_owner: string;
        rtp_owner: string;
        recording_owner: string;
        admission_owner: string;
        livekit_sip: {
          mode: string;
          enabled_in_profile: boolean;
          counts_toward_profile: boolean;
          owns_dialogs: boolean;
          owns_rtp: boolean;
          owns_recording: boolean;
          owns_admission: boolean;
        };
      };
      [key: string]: unknown;
    };
  };
  recording: {
    failure_isolation: {
      established_media: string;
      storage_dependency: string;
      media_hot_path_backpressure: string;
      queue_policy: string;
      overload_action: string;
    };
    [key: string]: unknown;
  };
  durations: {
    ramp_minutes: number;
    steady_minutes: number;
    burst_seconds: number;
    endurance_hours: number;
    endurance_load_ratio: number;
  };
  failure_model: {
    node_failure_repetitions: number;
    zone_failure_repetitions: number;
    quorum_failures: string[];
  };
  slos: {
    sip_setup_success_ratio: number;
    sip_route_p99_ms: number;
    rtp_server_packet_loss_ratio: number;
    im_ack_p99_ms: number;
    durable_loss_count: number;
    livekit_join_p99_ms: number;
    new_admission_recovery_seconds: number;
    four_node_linearity_ratio: number;
    eight_node_linearity_ratio: number;
  };
  performance_contract: RtcPerformanceContract;
  external_dependencies: Array<{
    id: string;
    status: string;
    required_for_production_pass: boolean;
  }>;
  [key: string]: unknown;
}

interface ForkManifest {
  manifest_id: string;
  [key: string]: unknown;
}

export interface GeneratorFleetTopology {
  fleet_id: LoadFleet;
  worker_count: number;
  protocols: readonly string[];
}

export interface LoadShardWorkload {
  workload_domain: WorkloadDomain;
  workload_id: string;
  workload_kind: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  expected_count: number;
}

export interface LoadShard {
  shard_id: string;
  workload_domain: WorkloadDomain;
  workload_id: string;
  workload_kind: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  expected_count: number;
  covered_workloads?: LoadShardWorkload[];
  required_protocols: string[];
  assigned_fleet: LoadFleet;
  initial_lease_epoch: 0;
  seed: string;
}

export interface ProfileEquivalentLoad {
  base_interactions: number;
  target_interactions: number;
  scale_numerator: number;
  scale_denominator: number;
  apportionment: 'largest_remainder_v1';
}

export interface CapacityRunContext {
  scope: 'component' | 'cell' | 'shared_data';
  component_role?: string;
  units: number;
  hardware_class: string;
  hardware_sha256: string;
  configuration_class: string;
  configuration_sha256: string;
  failure_reserve_sha256: string;
}

export interface LoadRunManifest {
  schema_version: '1.0.0';
  run_id: string;
  profile_id: string;
  profile_sha256: string;
  fork_manifest_id: string;
  fork_manifest_sha256: string;
  sut_release_id: string;
  generator_release_id: string;
  seed: string;
  run_epoch: string;
  profile_load?: ProfileEquivalentLoad;
  capacity_context?: CapacityRunContext;
  topology: { fleets: Array<{ fleet_id: LoadFleet; worker_count: number; protocols: string[] }> };
  shards: LoadShard[];
  phases: Array<{ id: string; duration_seconds: number | null }>;
  faults: Array<{ id: string; repetitions: number }>;
  expected_totals: {
    interactions: number;
    connections: number;
    by_workload: Record<string, number>;
  };
  performance_contract: RtcPerformanceContract;
  external_dependencies: CapacityWorkloadProfile['external_dependencies'];
  start_not_before: string;
  evidence_prefix: string;
}

export interface CompileLoadRunManifestInput {
  profile: CapacityWorkloadProfile;
  forkManifest: ForkManifest;
  run: {
    runId: string;
    seed: string;
    runEpoch: string;
    sutReleaseId: string;
    generatorReleaseId: string;
    startNotBefore: string;
    evidencePrefix: string;
    targetInteractions?: number;
    capacityContext?: CapacityRunContext;
  };
  topology: { fleets: readonly GeneratorFleetTopology[] };
  shardSizeByWorkloadId?: Readonly<Record<string, number>>;
}

export interface CompiledLoadRunManifest {
  manifest: Readonly<LoadRunManifest>;
  manifest_sha256: string;
}

const INTERACTION_BINDINGS: Record<string, { fleet: LoadFleet; protocols: string[] }> = {
  tinode_im: { fleet: 'tinode', protocols: ['tinode_websocket'] },
  sip_voice: { fleet: 'sip', protocols: ['sip', 'rtp'] },
  livekit_av: { fleet: 'livekit', protocols: ['livekit_webrtc'] },
  livekit_screen: { fleet: 'livekit', protocols: ['livekit_webrtc'] },
  rustdesk_remote: { fleet: 'rustdesk', protocols: ['rustdesk_native'] }
};

const CONNECTION_BINDINGS: Record<string, { fleet: LoadFleet; protocols: string[] }> = {
  tinode_websocket: { fleet: 'tinode', protocols: ['tinode_websocket'] },
  ivekit_event_websocket: { fleet: 'ivekit_event_ws', protocols: ['ivekit_event_websocket'] },
  sip_registration: { fleet: 'sip', protocols: ['sip'] },
  sip_websocket: { fleet: 'sip', protocols: ['sip', 'sip_websocket'] },
  livekit_participant: { fleet: 'livekit', protocols: ['livekit_webrtc'] },
  rustdesk_endpoint: { fleet: 'rustdesk', protocols: ['rustdesk_native'] }
};

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/;

export function compileLoadRunManifest(input: CompileLoadRunManifestInput): CompiledLoadRunManifest {
  validateProfile(input.profile);
  validateCompileInput(input);
  const profileLoad = input.run.targetInteractions == null
    ? undefined
    : profileEquivalentLoad(input.profile, input.run.targetInteractions);
  const effective = effectiveWorkloads(input.profile, profileLoad);

  const topology = {
    fleets: [...input.topology.fleets]
      .map((fleet) => ({
        fleet_id: fleet.fleet_id,
        worker_count: fleet.worker_count,
        protocols: [...fleet.protocols].sort()
      }))
      .sort((left, right) => left.fleet_id.localeCompare(right.fleet_id))
  };
  const availableFleets = new Set(topology.fleets.map((fleet) => fleet.fleet_id));
  const interactionShards = compileDomainShards(
      'interaction',
      effective.interactions.filter((workload) => workload.kind !== 'tinode_im'),
      INTERACTION_BINDINGS,
      input.run.seed,
      input.shardSizeByWorkloadId,
      availableFleets
    );
  const connectionShards = compileDomainShards(
      'connection',
      effective.connections,
      CONNECTION_BINDINGS,
      input.run.seed,
      input.shardSizeByWorkloadId,
      availableFleets
    );
  const shards = [
    ...interactionShards,
    ...attachTinodeInteractionCoverage(
      connectionShards,
      effective.interactions,
      effective.connections
    )
  ];
  const byWorkload = Object.fromEntries([
    ...effective.interactions.map((item) => [item.id, item.count] as const),
    ...effective.connections.map((item) => [item.id, item.count] as const)
  ]);
  const interactionTotal = effective.interactions.reduce((sum, item) => sum + item.count, 0);
  const connectionTotal = effective.connections.reduce((sum, connection) => sum + connection.count, 0);
  const manifest: LoadRunManifest = {
    schema_version: '1.0.0',
    run_id: input.run.runId,
    profile_id: input.profile.profile_id,
    profile_sha256: canonicalSha256(input.profile),
    fork_manifest_id: input.forkManifest.manifest_id,
    fork_manifest_sha256: canonicalSha256(input.forkManifest),
    sut_release_id: input.run.sutReleaseId,
    generator_release_id: input.run.generatorReleaseId,
    seed: input.run.seed,
    run_epoch: normalizeDate(input.run.runEpoch, 'runEpoch'),
    ...(profileLoad ? { profile_load: profileLoad } : {}),
    ...(input.run.capacityContext
      ? { capacity_context: structuredClone(input.run.capacityContext) }
      : {}),
    topology,
    shards,
    phases: compilePhases(input.profile),
    faults: compileFaults(input.profile),
    expected_totals: {
      interactions: interactionTotal,
      connections: connectionTotal,
      by_workload: byWorkload
    },
    performance_contract: structuredClone(input.profile.performance_contract),
    external_dependencies: structuredClone(input.profile.external_dependencies),
    start_not_before: normalizeDate(input.run.startNotBefore, 'startNotBefore'),
    evidence_prefix: input.run.evidencePrefix
  };
  const manifestSha256 = canonicalSha256(manifest);
  validateLoadRunManifest(manifest, manifestSha256, input.profile, input.forkManifest);
  return deepFreeze({ manifest, manifest_sha256: manifestSha256 }) as CompiledLoadRunManifest;
}

export function validateLoadRunManifest(
  manifest: LoadRunManifest,
  expectedManifestSha256: string,
  profile: CapacityWorkloadProfile,
  forkManifest: ForkManifest
): void {
  validateProfile(profile);
  if (canonicalSha256(manifest) !== expectedManifestSha256) throw new Error('manifest hash mismatch');
  if (manifest.profile_id !== profile.profile_id || manifest.profile_sha256 !== canonicalSha256(profile)) {
    throw new Error('manifest profile binding mismatch');
  }
  if (manifest.fork_manifest_id !== forkManifest.manifest_id ||
      manifest.fork_manifest_sha256 !== canonicalSha256(forkManifest)) {
    throw new Error('manifest fork binding mismatch');
  }
  if (manifest.schema_version !== '1.0.0') throw new Error('unsupported run manifest schema');
  for (const [field, value] of Object.entries({
    run_id: manifest.run_id,
    seed: manifest.seed,
    sut_release_id: manifest.sut_release_id,
    generator_release_id: manifest.generator_release_id
  })) {
    if (!SAFE_ID.test(value)) throw new Error(`invalid manifest ${field}`);
  }
  normalizeDate(manifest.run_epoch, 'run_epoch');
  normalizeDate(manifest.start_not_before, 'start_not_before');
  const effective = effectiveWorkloads(profile, manifest.profile_load);
  if (manifest.capacity_context) validateCapacityContext(manifest.capacity_context);
  if (manifest.capacity_context && !manifest.profile_load) {
    throw new Error('capacity context requires an explicit profile-equivalent load');
  }

  const fleetIds = new Set<string>();
  const fleetProtocols = new Map<string, Set<string>>();
  for (const fleet of manifest.topology.fleets) {
    if (fleetIds.has(fleet.fleet_id)) throw new Error(`duplicate fleet ${fleet.fleet_id}`);
    if (!Number.isInteger(fleet.worker_count) || fleet.worker_count < 1) {
      throw new Error(`invalid worker count for ${fleet.fleet_id}`);
    }
    const protocols = new Set(fleet.protocols);
    if (protocols.size !== fleet.protocols.length || protocols.size === 0) {
      throw new Error(`invalid protocols for fleet ${fleet.fleet_id}`);
    }
    fleetIds.add(fleet.fleet_id);
    fleetProtocols.set(fleet.fleet_id, protocols);
  }

  const expected = [
    ...effective.interactions.map((item) => ({
      domain: 'interaction' as const,
      id: item.id,
      kind: item.kind,
      count: item.count,
      binding: INTERACTION_BINDINGS[item.kind]
    })),
    ...effective.connections.map((item) => ({
      domain: 'connection' as const,
      id: item.id,
      kind: item.kind,
      count: item.count,
      binding: CONNECTION_BINDINGS[item.kind]
    }))
  ];
  const expectedByKey = new Map<string, typeof expected[number]>(
    expected.map((item) => [`${item.domain}:${item.id}`, item] as const)
  );
  const shardIds = new Set<string>();

  for (const shard of manifest.shards) {
    if (shardIds.has(shard.shard_id)) throw new Error(`duplicate shard ${shard.shard_id}`);
    shardIds.add(shard.shard_id);
    const primary = expectedByKey.get(`${shard.workload_domain}:${shard.workload_id}`);
    if (!primary) {
      throw new Error(`unexpected shard workload ${shard.workload_domain}:${shard.workload_id}`);
    }
    if (shard.ordinal_end_exclusive <= shard.ordinal_start ||
        shard.expected_count !== shard.ordinal_end_exclusive - shard.ordinal_start) {
      throw new Error(`invalid shard range for ${shard.shard_id}`);
    }
    const expectedShardId = shardId(
      primary.domain,
      primary.id,
      shard.ordinal_start,
      shard.ordinal_end_exclusive
    );
    if (shard.shard_id !== expectedShardId || shard.workload_kind !== primary.kind ||
        shard.assigned_fleet !== primary.binding.fleet ||
        shard.initial_lease_epoch !== 0 ||
        shard.seed !== canonicalSha256(`${manifest.seed}:${expectedShardId}`)) {
      throw new Error(`invalid shard binding for ${shard.shard_id}`);
    }
    const workloads = loadShardWorkloads(shard);
    const workloadKeys = new Set<string>();
    const requiredProtocols = new Set<string>();
    for (const workload of workloads) {
      const key = `${workload.workload_domain}:${workload.workload_id}`;
      if (workloadKeys.has(key)) {
        throw new Error(`duplicate workload coverage ${key} for ${shard.shard_id}`);
      }
      workloadKeys.add(key);
      const expectedWorkload = expectedByKey.get(key);
      if (!expectedWorkload || expectedWorkload.kind !== workload.workload_kind) {
        throw new Error(`unexpected shard workload ${key}`);
      }
      if (workload.expected_count !==
          workload.ordinal_end_exclusive - workload.ordinal_start ||
          workload.expected_count < 1) {
        throw new Error(`invalid workload coverage ${key} for ${shard.shard_id}`);
      }
      if (expectedWorkload.binding.fleet !== shard.assigned_fleet) {
        throw new Error(`covered workload ${key} belongs to another fleet`);
      }
      for (const protocol of expectedWorkload.binding.protocols) requiredProtocols.add(protocol);
      if (workload !== workloads[0] &&
          !isAllowedCompositeCoverage(shard, workload)) {
        throw new Error(`unsupported composite workload coverage ${key}`);
      }
    }
    const expectedProtocols = [...requiredProtocols].sort();
    if (JSON.stringify([...shard.required_protocols].sort()) !==
        JSON.stringify(expectedProtocols)) {
      throw new Error(`invalid shard protocols for ${shard.shard_id}`);
    }
    if (!fleetIds.has(shard.assigned_fleet)) {
      throw new Error(`shard ${shard.shard_id} references unavailable fleet ${shard.assigned_fleet}`);
    }
    for (const protocol of shard.required_protocols) {
      if (!fleetProtocols.get(shard.assigned_fleet)?.has(protocol)) {
        throw new Error(`fleet ${shard.assigned_fleet} is missing required protocol ${protocol}`);
      }
    }
  }

  for (const workload of expected) {
    if (!workload.binding) throw new Error(`unsupported ${workload.domain} kind ${workload.kind}`);
    const coverages = manifest.shards
      .flatMap((shard) => loadShardWorkloads(shard))
      .filter((item) =>
        item.workload_domain === workload.domain && item.workload_id === workload.id)
      .sort((left, right) => left.ordinal_start - right.ordinal_start);
    if (workload.count === 0) {
      if (coverages.length > 0) {
        throw new Error(`unexpected shard coverage for zero-count workload ${workload.id}`);
      }
      continue;
    }
    if (coverages.length === 0) throw new Error(`missing shard coverage for ${workload.id}`);
    let cursor = 0;
    for (const coverage of coverages) {
      if (coverage.ordinal_start !== cursor) {
        throw new Error(`shard overlap or coverage gap for ${workload.id} at ${cursor}`);
      }
      cursor = coverage.ordinal_end_exclusive;
    }
    if (cursor !== workload.count) throw new Error(`incomplete shard coverage for ${workload.id}`);
  }

  const interactionTotal = effective.interactions.reduce((sum, item) => sum + item.count, 0);
  const connectionTotal = effective.connections.reduce((sum, item) => sum + item.count, 0);
  if (manifest.expected_totals.interactions !== interactionTotal ||
      manifest.expected_totals.connections !== connectionTotal) {
    throw new Error('manifest expected totals do not match profile');
  }
  for (const workload of expected) {
    if (manifest.expected_totals.by_workload[workload.id] !== workload.count) {
      throw new Error(`manifest expected total mismatch for ${workload.id}`);
    }
  }
  if (Object.keys(manifest.expected_totals.by_workload).length !== expected.length) {
    throw new Error('manifest contains unexpected workload totals');
  }
  if (canonicalSha256(manifest.external_dependencies) !== canonicalSha256(profile.external_dependencies)) {
    throw new Error('manifest external dependency contract mismatch');
  }
  if (canonicalSha256(manifest.performance_contract) !==
      canonicalSha256(profile.performance_contract)) {
    throw new Error('manifest RTC performance contract mismatch');
  }
  if (canonicalSha256(manifest.phases) !== canonicalSha256(compilePhases(profile)) ||
      canonicalSha256(manifest.faults) !== canonicalSha256(compileFaults(profile))) {
    throw new Error('manifest phase or fault contract mismatch');
  }
}

export function formatLoadEntityId(
  manifest: Pick<LoadRunManifest, 'run_id'>,
  domain: WorkloadDomain,
  workloadId: string,
  ordinal: number
): string {
  if (!Number.isInteger(ordinal) || ordinal < 0) throw new Error('entity ordinal must be a non-negative integer');
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(workloadId)) throw new Error('invalid workload ID');
  return `${manifest.run_id}/${domain}/${workloadId}/${ordinal}`;
}

export function loadShardWorkloads(shard: LoadShard): LoadShardWorkload[] {
  if (shard.covered_workloads !== undefined && !Array.isArray(shard.covered_workloads)) {
    throw new Error(`invalid covered workloads for ${shard.shard_id}`);
  }
  return [{
    workload_domain: shard.workload_domain,
    workload_id: shard.workload_id,
    workload_kind: shard.workload_kind,
    ordinal_start: shard.ordinal_start,
    ordinal_end_exclusive: shard.ordinal_end_exclusive,
    expected_count: shard.expected_count
  }, ...structuredClone(shard.covered_workloads || [])];
}

function attachTinodeInteractionCoverage(
  shards: LoadShard[],
  interactions: Array<{ id: string; kind: string; count: number }>,
  connections: Array<{ id: string; kind: string; count: number }>
): LoadShard[] {
  const interaction = uniqueWorkloadByKind(interactions, 'tinode_im');
  if (!interaction || interaction.count === 0) return shards;
  const connection = uniqueWorkloadByKind(connections, 'tinode_websocket');
  if (!connection || connection.count === 0) {
    throw new Error('Tinode IM interactions require Tinode WebSocket connections');
  }
  const targetShards = shards.filter((shard) =>
    shard.workload_domain === 'connection' &&
    shard.workload_id === connection.id &&
    shard.workload_kind === connection.kind);
  if (targetShards.length === 0) {
    throw new Error('Tinode WebSocket shards are missing for composite IM load');
  }
  let interactionCursor = 0;
  let connectionCursor = 0;
  const result = shards.map((shard) => {
    if (!targetShards.includes(shard)) return shard;
    connectionCursor += shard.expected_count;
    const interactionEnd = Math.floor(connectionCursor * interaction.count / connection.count);
    if (interactionEnd === interactionCursor) return shard;
    const covered: LoadShardWorkload = {
      workload_domain: 'interaction',
      workload_id: interaction.id,
      workload_kind: interaction.kind,
      ordinal_start: interactionCursor,
      ordinal_end_exclusive: interactionEnd,
      expected_count: interactionEnd - interactionCursor
    };
    interactionCursor = interactionEnd;
    return { ...shard, covered_workloads: [covered] };
  });
  if (interactionCursor !== interaction.count) {
    throw new Error(`incomplete Tinode interaction coverage for ${interaction.id}`);
  }
  return result;
}

function uniqueWorkloadByKind<T extends { kind: string }>(
  workloads: T[],
  kind: string
): T | undefined {
  const matches = workloads.filter((workload) => workload.kind === kind);
  if (matches.length > 1) throw new Error(`multiple workloads use kind ${kind}`);
  return matches[0];
}

function isAllowedCompositeCoverage(
  shard: LoadShard,
  workload: LoadShardWorkload
): boolean {
  return shard.workload_domain === 'connection' &&
    shard.workload_kind === 'tinode_websocket' &&
    workload.workload_domain === 'interaction' &&
    workload.workload_kind === 'tinode_im';
}

function compileDomainShards(
  domain: WorkloadDomain,
  workloads: Array<{ id: string; kind: string; count: number }>,
  bindings: Record<string, { fleet: LoadFleet; protocols: string[] }>,
  runSeed: string,
  shardSizes: Readonly<Record<string, number>> | undefined,
  availableFleets: Set<LoadFleet>
): LoadShard[] {
  const result: LoadShard[] = [];
  for (const workload of workloads) {
    const binding = bindings[workload.kind];
    if (!binding) throw new Error(`unsupported ${domain} kind ${workload.kind}`);
    if (!availableFleets.has(binding.fleet)) {
      throw new Error(`topology is missing required fleet ${binding.fleet} for ${workload.id}`);
    }
    if (workload.count === 0) continue;
    const size = shardSizes?.[workload.id] ?? workload.count;
    if (!Number.isInteger(size) || size < 1) throw new Error(`invalid shard size for ${workload.id}`);
    for (let start = 0; start < workload.count; start += size) {
      const end = Math.min(start + size, workload.count);
      const id = shardId(domain, workload.id, start, end);
      result.push({
        shard_id: id,
        workload_domain: domain,
        workload_id: workload.id,
        workload_kind: workload.kind,
        ordinal_start: start,
        ordinal_end_exclusive: end,
        expected_count: end - start,
        required_protocols: [...binding.protocols],
        assigned_fleet: binding.fleet,
        initial_lease_epoch: 0,
        seed: canonicalSha256(`${runSeed}:${id}`)
      });
    }
  }
  return result;
}

function shardId(domain: WorkloadDomain, workloadId: string, start: number, end: number): string {
  return `${domain}/${workloadId}/${start}-${end}`;
}

function validateProfile(profile: CapacityWorkloadProfile): void {
  if (profile.schema_version !== '1.3.0') throw new Error('unsupported workload profile schema');
  if (!/^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/.test(profile.profile_id)) {
    throw new Error('invalid profile ID');
  }
  if (profile.interactions.id_uniqueness !== 'globally_unique_and_cross_category_disjoint') {
    throw new Error('profile must require globally unique disjoint interactions');
  }
  validateUniqueWorkloads(profile.interactions.categories, 'interaction');
  validateUniqueWorkloads(profile.connections, 'connection');
  const interactionTotal = profile.interactions.categories.reduce((sum, item) => sum + item.count, 0);
  if (interactionTotal !== profile.interactions.total) {
    throw new Error(`interaction total ${profile.interactions.total} does not match category sum ${interactionTotal}`);
  }
  const categoryIds = profile.interactions.categories.map((item) => item.id);
  for (const category of profile.interactions.categories) {
    const expected = categoryIds.filter((id) => id !== category.id).sort();
    const declared = [...category.disjoint_from].sort();
    if (JSON.stringify(expected) !== JSON.stringify(declared)) {
      throw new Error(`interaction category ${category.id} has an incomplete disjoint_from contract`);
    }
    if (!INTERACTION_BINDINGS[category.kind]) throw new Error(`unsupported interaction kind ${category.kind}`);
  }
  for (const connection of profile.connections) {
    if (!CONNECTION_BINDINGS[connection.kind]) throw new Error(`unsupported connection kind ${connection.kind}`);
  }
  validateVoiceOwnership(profile);
  validateRecordingStorageIsolation(profile);
  validatePerformanceContract(profile.performance_contract, profile.slos);
  if (!Array.isArray(profile.external_dependencies)) throw new Error('profile external dependencies are required');
}

function validateVoiceOwnership(profile: CapacityWorkloadProfile): void {
  const ownership = profile.signaling?.sip?.ownership;
  if (!ownership || [
    ownership.dialog_owner,
    ownership.rtp_owner,
    ownership.recording_owner,
    ownership.admission_owner
  ].some((owner) => owner !== 'rustpbx')) {
    throw new Error('profile voice ownership must bind dialogs, RTP, recording and admission to RustPBX');
  }
  const bridge = ownership.livekit_sip;
  if (!bridge || bridge.mode !== 'optional_bridge_excluded' || [
    bridge.enabled_in_profile,
    bridge.counts_toward_profile,
    bridge.owns_dialogs,
    bridge.owns_rtp,
    bridge.owns_recording,
    bridge.owns_admission
  ].some((value) => value !== false)) {
    throw new Error('LiveKit SIP must remain an optional bridge excluded from this capacity profile');
  }
}

function validateRecordingStorageIsolation(profile: CapacityWorkloadProfile): void {
  const isolation = profile.recording?.failure_isolation;
  if (!isolation ||
      isolation.established_media !== 'continue_fail_open' ||
      isolation.storage_dependency !== 'downstream_only' ||
      isolation.media_hot_path_backpressure !== 'forbidden' ||
      isolation.queue_policy !== 'bounded_non_blocking' ||
      isolation.overload_action !== 'drop_or_fail_recording_only') {
    throw new Error('recording storage must remain downstream and must not terminate or backpressure established media');
  }
}

const REQUIRED_QUANTILES = ['p50', 'p95', 'p99'];
const DEGRADATION_ORDER = [
  'preserve_audio',
  'reduce_video_layers',
  'reduce_video_frame_rate',
  'drop_auxiliary_realtime_copies',
  'reject_new_admission'
];
const IMPAIRMENT_PROFILE_IDS = [
  'baseline',
  'constrained_bandwidth',
  'lossy_jitter',
  'network_handoff',
  'cross_region'
];
const REQUIRED_RESOURCE_METRICS = [
  'server_cpu_p95_ratio',
  'server_memory_per_1000_connections_bytes',
  'server_egress_bits_per_second',
  'client_cpu_p95_ratio',
  'client_memory_p95_bytes',
  'generator_cpu_p95_ratio',
  'generator_nic_p95_ratio',
  'cost_per_1000_active_interactions'
];

function validatePerformanceContract(
  contract: RtcPerformanceContract,
  summary: CapacityWorkloadProfile['slos']
): void {
  if (!contract || contract.schema_version !== '1.0.0' ||
      contract.measurement_scope !== 'same_region_controlled_endpoint_to_endpoint') {
    throw new Error('RTC performance contract must use endpoint-to-endpoint schema 1.0.0');
  }
  if (contract.clock_sync?.method !== 'monotonic_clock_with_observed_ntp_offset' ||
      !isPositive(contract.clock_sync.maximum_offset_ms)) {
    throw new Error('RTC performance clock synchronization contract is invalid');
  }
  if (!sameArray(contract.required_quantiles, REQUIRED_QUANTILES)) {
    throw new Error('RTC performance quantiles must include P50, P95 and P99');
  }
  finiteNonNegativeRecord(contract.latency_ms, 'RTC latency');
  finiteNonNegativeRecord(contract.media_quality, 'RTC media quality');
  finiteNonNegativeRecord(contract.reliability, 'RTC reliability');
  finiteNonNegativeRecord(contract.recovery_ms, 'RTC recovery');
  for (const [p95, p99] of [
    ['im_send_to_ack_p95', 'im_send_to_ack_p99'],
    ['sip_post_dial_p95', 'sip_post_dial_p99'],
    ['voice_mouth_to_ear_p95', 'voice_mouth_to_ear_p99'],
    ['livekit_join_p95', 'livekit_join_p99'],
    ['livekit_glass_to_glass_p95', 'livekit_glass_to_glass_p99'],
    ['rustdesk_input_to_photon_p95', 'rustdesk_input_to_photon_p99']
  ]) {
    if (contract.latency_ms[p95] > contract.latency_ms[p99]) {
      throw new Error(`RTC latency ${p95} cannot exceed ${p99}`);
    }
  }
  for (const value of [
    contract.media_quality.server_packet_loss_ratio,
    contract.media_quality.endpoint_packet_loss_p95_ratio,
    contract.media_quality.video_freeze_ratio,
    contract.reliability.connection_success_ratio,
    contract.reliability.sip_setup_success_ratio,
    contract.reliability.reconnect_success_ratio,
    contract.overload?.minimum_jain_fairness_index,
    contract.overload?.maximum_noisy_neighbor_p99_degradation_ratio
  ]) ratioValue(value, 'RTC performance ratio');
  const mos = contract.media_quality.minimum_voice_mos_p50;
  if (!Number.isFinite(mos) || mos < 1 || mos > 5) {
    throw new Error('RTC minimum voice MOS must be between 1 and 5');
  }
  for (const key of [
    'durable_loss_count',
    'duplicate_delivery_count',
    'out_of_order_delivery_count'
  ]) {
    if (!Number.isInteger(contract.reliability[key]) || contract.reliability[key] < 0) {
      throw new Error(`RTC reliability ${key} must be a non-negative integer`);
    }
  }
  if (contract.overload?.queue_policy !== 'bounded' ||
      contract.overload.slow_consumer_policy !== 'disconnect_or_degrade' ||
      !sameArray(contract.overload.degradation_order, DEGRADATION_ORDER)) {
    throw new Error('RTC overload degradation must preserve audio before degrading video');
  }
  const security = contract.security_performance;
  if (!security || !isNonNegative(security.authorization_p99_ms) ||
      !isNonNegative(security.rate_limit_decision_p99_ms) ||
      !isNonNegative(security.overload_rejection_p99_ms) ||
      security.new_admission_fails_closed !== true ||
      security.established_media_avoids_remote_authorization !== true) {
    throw new Error('RTC security performance contract is invalid');
  }
  if (!sameArray(contract.required_resource_metrics, REQUIRED_RESOURCE_METRICS)) {
    throw new Error('RTC performance contract is missing required resource or cost metrics');
  }
  if (!Array.isArray(contract.impairment_profiles) ||
      !sameArray(contract.impairment_profiles.map((item) => item.id), IMPAIRMENT_PROFILE_IDS)) {
    throw new Error('RTC impairment profiles must include baseline, constrained bandwidth, lossy jitter, network_handoff and cross_region');
  }
  for (const impairment of contract.impairment_profiles) {
    for (const value of [
      impairment.round_trip_time_ms,
      impairment.jitter_ms,
      impairment.blackout_ms
    ]) {
      if (!isNonNegative(value)) throw new Error(`RTC impairment ${impairment.id} is invalid`);
    }
    if (!isPositive(impairment.downstream_kbps) || !isPositive(impairment.upstream_kbps)) {
      throw new Error(`RTC impairment ${impairment.id} bandwidth is invalid`);
    }
    ratioValue(impairment.packet_loss_ratio, `RTC impairment ${impairment.id} packet loss`);
  }
  const handoff = contract.impairment_profiles.find((item) => item.id === 'network_handoff');
  if (!handoff || handoff.blackout_ms <= 0) {
    throw new Error('RTC network_handoff impairment must include a blackout');
  }
  if (contract.latency_ms.sip_route_p99 !== summary.sip_route_p99_ms ||
      contract.latency_ms.im_send_to_ack_p99 !== summary.im_ack_p99_ms ||
      contract.latency_ms.livekit_join_p99 !== summary.livekit_join_p99_ms ||
      contract.media_quality.server_packet_loss_ratio !== summary.rtp_server_packet_loss_ratio ||
      contract.reliability.sip_setup_success_ratio !== summary.sip_setup_success_ratio ||
      contract.reliability.durable_loss_count !== summary.durable_loss_count ||
      contract.recovery_ms.new_admission_after_node_failure_p99 !==
        summary.new_admission_recovery_seconds * 1_000) {
    throw new Error('RTC performance contract and legacy SLO summary must not drift');
  }
}

function finiteNonNegativeRecord(value: Record<string, number>, label: string): void {
  if (!value || typeof value !== 'object' || Object.keys(value).length === 0) {
    throw new Error(`${label} metrics are required`);
  }
  for (const [key, metric] of Object.entries(value)) {
    if (!isNonNegative(metric)) throw new Error(`${label} ${key} is invalid`);
  }
}

function ratioValue(value: unknown, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
}

function sameArray(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validateUniqueWorkloads(
  workloads: Array<{ id: string; count: number }>,
  domain: WorkloadDomain
): void {
  const ids = new Set<string>();
  for (const workload of workloads) {
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(workload.id)) throw new Error(`invalid ${domain} ID ${workload.id}`);
    if (ids.has(workload.id)) throw new Error(`duplicate ${domain} ID ${workload.id}`);
    if (!Number.isInteger(workload.count) || workload.count < 1) {
      throw new Error(`invalid ${domain} count for ${workload.id}`);
    }
    ids.add(workload.id);
  }
}

function validateCompileInput(input: CompileLoadRunManifestInput): void {
  for (const [name, value] of Object.entries({
    runId: input.run.runId,
    seed: input.run.seed,
    sutReleaseId: input.run.sutReleaseId,
    generatorReleaseId: input.run.generatorReleaseId
  })) {
    if (!SAFE_ID.test(value)) throw new Error(`invalid ${name}`);
  }
  normalizeDate(input.run.runEpoch, 'runEpoch');
  normalizeDate(input.run.startNotBefore, 'startNotBefore');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{2,255}$/.test(input.run.evidencePrefix) ||
      input.run.evidencePrefix.includes('..')) {
    throw new Error('invalid evidencePrefix');
  }
  if (!input.forkManifest?.manifest_id) throw new Error('fork manifest ID is required');
  if (input.run.targetInteractions != null) {
    if (!Number.isSafeInteger(input.run.targetInteractions) || input.run.targetInteractions < 1) {
      throw new Error('targetInteractions must be a positive safe integer');
    }
    if (!input.run.capacityContext) {
      throw new Error('targetInteractions requires capacityContext');
    }
  }
  if (input.run.capacityContext) validateCapacityContext(input.run.capacityContext);
  const fleetIds = new Set<string>();
  for (const fleet of input.topology.fleets) {
    if (fleetIds.has(fleet.fleet_id)) throw new Error(`duplicate fleet ${fleet.fleet_id}`);
    if (!Number.isInteger(fleet.worker_count) || fleet.worker_count < 1) {
      throw new Error(`invalid worker count for ${fleet.fleet_id}`);
    }
    if (fleet.protocols.length === 0 || new Set(fleet.protocols).size !== fleet.protocols.length) {
      throw new Error(`fleet ${fleet.fleet_id} has invalid protocols`);
    }
    fleetIds.add(fleet.fleet_id);
  }
}

function profileEquivalentLoad(
  profile: CapacityWorkloadProfile,
  targetInteractions: number
): ProfileEquivalentLoad {
  return {
    base_interactions: profile.interactions.total,
    target_interactions: targetInteractions,
    scale_numerator: targetInteractions,
    scale_denominator: profile.interactions.total,
    apportionment: 'largest_remainder_v1'
  };
}

function effectiveWorkloads(
  profile: CapacityWorkloadProfile,
  load?: ProfileEquivalentLoad
): {
  interactions: Array<{ id: string; kind: string; count: number }>;
  connections: Array<{ id: string; kind: string; count: number }>;
} {
  if (!load) {
    return {
      interactions: profile.interactions.categories.map(({ id, kind, count }) => ({ id, kind, count })),
      connections: profile.connections.map(({ id, kind, count }) => ({ id, kind, count }))
    };
  }
  validateProfileLoad(load, profile.interactions.total);
  const connectionBase = profile.connections.reduce((sum, item) => sum + item.count, 0);
  const connectionTarget = roundedRatio(
    connectionBase,
    load.scale_numerator,
    load.scale_denominator
  );
  return {
    interactions: apportionWorkloads(
      profile.interactions.categories,
      load.target_interactions,
      load.scale_numerator,
      load.scale_denominator
    ),
    connections: apportionWorkloads(
      profile.connections,
      connectionTarget,
      load.scale_numerator,
      load.scale_denominator
    )
  };
}

function apportionWorkloads<T extends { id: string; kind: string; count: number }>(
  workloads: T[],
  targetTotal: number,
  numerator: number,
  denominator: number
): Array<{ id: string; kind: string; count: number }> {
  const denominatorBig = BigInt(denominator);
  const rows = workloads.map((workload) => {
    const scaled = BigInt(workload.count) * BigInt(numerator);
    return {
      id: workload.id,
      kind: workload.kind,
      count: Number(scaled / denominatorBig),
      remainder: scaled % denominatorBig
    };
  });
  let remaining = targetTotal - rows.reduce((sum, row) => sum + row.count, 0);
  if (remaining < 0 || remaining > rows.length) {
    throw new Error('profile load apportionment is invalid');
  }
  const byRemainder = [...rows].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  for (let index = 0; index < remaining; index += 1) byRemainder[index].count += 1;
  return rows.map(({ id, kind, count }) => ({ id, kind, count }));
}

function roundedRatio(value: number, numerator: number, denominator: number): number {
  const scaled = BigInt(value) * BigInt(numerator);
  return Number((scaled * 2n + BigInt(denominator)) / (BigInt(denominator) * 2n));
}

function validateProfileLoad(load: ProfileEquivalentLoad, baseInteractions: number): void {
  if (load.apportionment !== 'largest_remainder_v1' ||
      !Number.isSafeInteger(load.base_interactions) ||
      !Number.isSafeInteger(load.target_interactions) ||
      !Number.isSafeInteger(load.scale_numerator) ||
      !Number.isSafeInteger(load.scale_denominator) ||
      load.base_interactions !== baseInteractions ||
      load.target_interactions < 1 ||
      load.scale_numerator !== load.target_interactions ||
      load.scale_denominator !== baseInteractions) {
    throw new Error('manifest profile-equivalent load is invalid');
  }
}

function validateCapacityContext(context: CapacityRunContext): void {
  if (!['component', 'cell', 'shared_data'].includes(context.scope) ||
      !Number.isInteger(context.units) || context.units < 1 ||
      !SAFE_ID.test(context.hardware_class) ||
      !SAFE_ID.test(context.configuration_class)) {
    throw new Error('capacity context identity is invalid');
  }
  if (context.scope === 'component') {
    if (!context.component_role || !SAFE_ID.test(context.component_role)) {
      throw new Error('component capacity context requires a component role');
    }
  } else if (context.component_role != null) {
    throw new Error('non-component capacity context cannot declare a component role');
  }
  for (const hash of [
    context.hardware_sha256,
    context.configuration_sha256,
    context.failure_reserve_sha256
  ]) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('capacity context SHA-256 is invalid');
  }
}

function normalizeDate(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO date-time`);
  return new Date(timestamp).toISOString();
}

function compilePhases(profile: CapacityWorkloadProfile): LoadRunManifest['phases'] {
  const totalRampSeconds = profile.durations.ramp_minutes * 60;
  const connectionRampSeconds = Math.floor(totalRampSeconds / 2);
  return [
    { id: 'preflight', duration_seconds: null },
    { id: 'connection_ramp', duration_seconds: connectionRampSeconds },
    { id: 'interaction_ramp', duration_seconds: totalRampSeconds - connectionRampSeconds },
    { id: 'steady', duration_seconds: profile.durations.steady_minutes * 60 },
    { id: 'burst', duration_seconds: profile.durations.burst_seconds },
    { id: 'recovery', duration_seconds: null },
    { id: 'faults', duration_seconds: null },
    { id: 'graceful_close', duration_seconds: null },
    { id: 'evidence_reconciliation', duration_seconds: null }
  ];
}

function compileFaults(profile: CapacityWorkloadProfile): LoadRunManifest['faults'] {
  return [
    { id: 'node_failure', repetitions: profile.failure_model.node_failure_repetitions },
    { id: 'zone_failure', repetitions: profile.failure_model.zone_failure_repetitions },
    ...profile.failure_model.quorum_failures.map((id) => ({ id, repetitions: 1 }))
  ];
}
