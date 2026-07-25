import {
  buildNetworkImpairmentPlan,
  type NetworkImpairmentLease,
  type NetworkImpairmentProfile,
  type NetworkImpairmentReceipt,
  type NetworkImpairmentReleaseReceipt
} from './network-impairment.js';
import type {
  LiveKitCapacityQualityContract,
  LiveKitQualityLimits
} from './livekit.js';
import {
  buildLiveKitNetworkNamespacePlan,
  type LiveKitNetworkNamespaceAttestation
} from './network-namespace.js';

interface LiveKitEvidenceIdentity {
  protocol: 'livekit_webrtc';
  evidence_level: 'controlled';
  capacity_claim: 'none';
  status: 'controlled_pass' | 'controlled_failed' | 'invalid_generator_capacity';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  quality_contract?: LiveKitCapacityQualityContract;
}

export interface LiveKitNetworkAcceptanceContract {
  schema_version: '1.0.0';
  camera_bitrate_minimum_bps: number;
  quality_limits: LiveKitQualityLimits;
}

type LiveKitNetworkProfile = NetworkImpairmentProfile & {
  livekit_acceptance?: LiveKitNetworkAcceptanceContract;
};

export interface LiveKitNetworkImpairmentEvidence {
  schema_version: '1.0.0';
  kind: 'livekit_network_impairment_evidence';
  protocol: 'livekit_webrtc';
  evidence_level: 'controlled';
  capacity_claim: 'none';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  media_status: LiveKitEvidenceIdentity['status'];
  media_evidence_sha256: string;
  network_path_qualification:
    | 'qualified_generator_edge'
    | 'diagnostic_shared_loopback'
    | 'diagnostic_legacy_receipt'
    | 'diagnostic_unattested_generator_edge';
  network_path_attestation_sha256?: string;
  network_path_attestation?: LiveKitNetworkNamespaceAttestation;
  quality_contract_qualification: 'profile_bound' | 'diagnostic_missing';
  measurement_window: {
    started_at: string;
    completed_at: string;
  };
  network_impairment: {
    profile: NetworkImpairmentProfile;
    apply: NetworkImpairmentReceipt;
    release: NetworkImpairmentReleaseReceipt & { released: true };
  };
  media_evidence: Record<string, unknown>;
}

export function bindLiveKitNetworkImpairmentEvidence(input: {
  media_evidence: unknown;
  media_evidence_sha256: string;
  network_path_attestation?: LiveKitNetworkNamespaceAttestation;
  network_path_attestation_sha256?: string;
  apply_receipt: NetworkImpairmentReceipt;
  release_receipt: NetworkImpairmentReleaseReceipt & { released: true };
  measurement_started_at: string;
  measurement_completed_at: string;
}): LiveKitNetworkImpairmentEvidence {
  const media = liveKitEvidence(input.media_evidence);
  sha256(input.media_evidence_sha256);
  const interfaces = receiptInterfaces(input.apply_receipt);
  const plan = buildNetworkImpairmentPlan({
    lease: input.apply_receipt.lease,
    interface_name: interfaces.interface_name,
    ifb_interface_name: interfaces.ifb_interface_name,
    profile: input.apply_receipt.profile
  });
  if (!['1.0.0', '1.1.0'].includes(input.apply_receipt.schema_version) ||
      input.apply_receipt.command_count !== plan.apply.length) {
    throw new Error('network impairment apply receipt is invalid');
  }
  if (input.release_receipt.schema_version !== '1.0.0' ||
      input.release_receipt.released !== true) {
    throw new Error('network impairment release receipt is invalid');
  }
  assertSameLease(media, input.apply_receipt.lease);
  assertSameLease(input.apply_receipt.lease, input.release_receipt.lease);

  const appliedAt = instant(input.apply_receipt.applied_at, 'apply receipt');
  const startedAt = instant(input.measurement_started_at, 'measurement start');
  const completedAt = instant(input.measurement_completed_at, 'measurement completion');
  const releasedAt = instant(input.release_receipt.released_at, 'release receipt');
  if (!(appliedAt <= startedAt && startedAt < completedAt && completedAt <= releasedAt)) {
    throw new Error('measurement window must remain inside the applied network interval');
  }
  const qualityContractQualification = qualifyQualityContract(
    media.quality_contract,
    input.apply_receipt.profile
  );
  const attestation = qualifyNetworkPathAttestation({
    attestation: input.network_path_attestation,
    attestation_sha256: input.network_path_attestation_sha256,
    apply_receipt: input.apply_receipt,
    applied_at: appliedAt
  });

  return {
    schema_version: '1.0.0',
    kind: 'livekit_network_impairment_evidence',
    protocol: 'livekit_webrtc',
    evidence_level: 'controlled',
    capacity_claim: 'none',
    run_id: media.run_id,
    shard_id: media.shard_id,
    worker_id: media.worker_id,
    lease_epoch: media.lease_epoch,
    media_status: media.status,
    media_evidence_sha256: input.media_evidence_sha256,
    network_path_qualification: networkPathQualification(
      input.apply_receipt,
      attestation !== undefined
    ),
    ...(attestation
      ? {
          network_path_attestation_sha256: input.network_path_attestation_sha256,
          network_path_attestation: structuredClone(attestation)
        }
      : {}),
    quality_contract_qualification: qualityContractQualification,
    measurement_window: {
      started_at: input.measurement_started_at,
      completed_at: input.measurement_completed_at
    },
    network_impairment: {
      profile: structuredClone(input.apply_receipt.profile),
      apply: structuredClone(input.apply_receipt),
      release: structuredClone(input.release_receipt)
    },
    media_evidence: structuredClone(input.media_evidence as Record<string, unknown>)
  };
}

export function assertLiveKitNetworkQualityContract(
  profile: NetworkImpairmentProfile,
  contract: LiveKitCapacityQualityContract
): void {
  if (qualifyQualityContract(contract, profile) !== 'profile_bound') {
    throw new Error('LiveKit network profile acceptance contract is required');
  }
}

function qualifyNetworkPathAttestation(input: {
  attestation: LiveKitNetworkNamespaceAttestation | undefined;
  attestation_sha256: string | undefined;
  apply_receipt: NetworkImpairmentReceipt;
  applied_at: number;
}): LiveKitNetworkNamespaceAttestation | undefined {
  if (!input.attestation && !input.attestation_sha256) return undefined;
  if (!input.attestation || !input.attestation_sha256) {
    throw new Error('LiveKit network path attestation and SHA-256 must be provided together');
  }
  sha256(input.attestation_sha256);
  const attestation = input.attestation;
  if (attestation.schema_version !== '1.0.0') {
    throw new Error('LiveKit network path attestation schema is invalid');
  }
  assertSameLease(attestation.lease, input.apply_receipt.lease);
  const observedAt = instant(attestation.observed_at, 'network path attestation');
  if (observedAt > input.applied_at || input.applied_at - observedAt > 60_000) {
    throw new Error('LiveKit network path attestation is outside the setup interval');
  }
  const plan = buildLiveKitNetworkNamespacePlan({
    ordinal: attestation.namespace_ordinal,
    livekit_port: attestation.livekit_port
  });
  const expected = {
    namespace_name: plan.namespace_name,
    host_interface_name: plan.host_interface_name,
    generator_interface_name: plan.generator_interface_name,
    ifb_interface_name: plan.ifb_interface_name,
    host_address: `${plan.host_address}/${plan.prefix_length}`,
    generator_address: `${plan.generator_address}/${plan.prefix_length}`,
    default_route_via: plan.host_address
  };
  for (const [field, value] of Object.entries(expected)) {
    if (attestation[field as keyof typeof expected] !== value) {
      throw new Error(`LiveKit network path attestation ${field} does not match its namespace plan`);
    }
  }
  if (input.apply_receipt.schema_version !== '1.1.0' ||
      input.apply_receipt.interface_name !== attestation.generator_interface_name ||
      input.apply_receipt.ifb_interface_name !== attestation.ifb_interface_name) {
    throw new Error('LiveKit network path attestation does not match the impairment receipt');
  }
  return attestation;
}

function qualifyQualityContract(
  contract: LiveKitCapacityQualityContract | undefined,
  profile: NetworkImpairmentProfile
): LiveKitNetworkImpairmentEvidence['quality_contract_qualification'] {
  if (!contract) return 'diagnostic_missing';
  const acceptance = (profile as LiveKitNetworkProfile).livekit_acceptance;
  if (!acceptance) return 'diagnostic_missing';
  if (acceptance.schema_version !== '1.0.0' ||
      !Number.isSafeInteger(acceptance.camera_bitrate_minimum_bps)) {
    throw new Error('LiveKit network profile acceptance contract is invalid');
  }
  if (!sameQualityLimits(contract.quality_limits, acceptance.quality_limits)) {
    throw new Error('LiveKit media quality limits do not match the profile acceptance contract');
  }
  const lossLimit = contract.endpoint_packet_loss_p95_ratio;
  if (lossLimit !== contract.quality_limits.endpoint_packet_loss_p95_ratio ||
      !Number.isFinite(lossLimit) || lossLimit < profile.packet_loss_ratio ||
      lossLimit > Math.min(
        1,
        profile.packet_loss_ratio + Math.max(0.01, profile.packet_loss_ratio * 0.5)
      )) {
    throw new Error('LiveKit quality contract packet loss limit does not match the impairment profile');
  }

  const camera = contract.camera_bitrate;
  if (!camera || !Number.isSafeInteger(camera.target_bps) || camera.target_bps < 100_000) {
    throw new Error('LiveKit quality contract camera target is invalid');
  }
  if (camera.mode === 'target_tolerance') {
    if (camera.tolerance_ratio !== 0.1 ||
        acceptance.camera_bitrate_minimum_bps !== Math.floor(camera.target_bps * 0.9)) {
      throw new Error('LiveKit quality contract camera target tolerance is invalid');
    }
  } else if (camera.mode === 'adaptive_minimum') {
    const availableUpstreamBps = profile.upstream_kbps * 1_000;
    const minimumUsefulBps = Math.floor(
      Math.min(camera.target_bps * 0.25, availableUpstreamBps * 0.5)
    );
    const maximumFeasibleBps = Math.floor(
      Math.min(camera.target_bps, availableUpstreamBps * 0.9)
    );
    if (!Number.isSafeInteger(camera.minimum_bps) ||
        camera.minimum_bps < minimumUsefulBps ||
        camera.minimum_bps > maximumFeasibleBps ||
        camera.minimum_bps !== acceptance.camera_bitrate_minimum_bps) {
      throw new Error(
        'LiveKit quality contract camera adaptive minimum does not match the impairment profile'
      );
    }
  } else {
    throw new Error('LiveKit quality contract camera mode is invalid');
  }
  return 'profile_bound';
}

function sameQualityLimits(
  left: LiveKitQualityLimits | undefined,
  right: LiveKitQualityLimits | undefined
): boolean {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([field, value], index) => {
      const expected = rightEntries[index];
      return expected?.[0] === field &&
        Number.isFinite(value) &&
        value === expected[1];
    });
}

function receiptInterfaces(receipt: NetworkImpairmentReceipt): {
  interface_name: string;
  ifb_interface_name: string;
} {
  if (receipt.schema_version === '1.0.0') {
    return { interface_name: 'lo', ifb_interface_name: 'ifbiv0' };
  }
  if (!receipt.interface_name || !receipt.ifb_interface_name) {
    throw new Error('network impairment apply receipt interface binding is invalid');
  }
  return {
    interface_name: receipt.interface_name,
    ifb_interface_name: receipt.ifb_interface_name
  };
}

function networkPathQualification(
  receipt: NetworkImpairmentReceipt,
  attested: boolean
): LiveKitNetworkImpairmentEvidence['network_path_qualification'] {
  if (receipt.schema_version === '1.0.0') return 'diagnostic_legacy_receipt';
  if (receipt.interface_name === 'lo') return 'diagnostic_shared_loopback';
  return attested
    ? 'qualified_generator_edge'
    : 'diagnostic_unattested_generator_edge';
}

function liveKitEvidence(value: unknown): LiveKitEvidenceIdentity & Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LiveKit media evidence is invalid');
  }
  const evidence = value as Record<string, unknown>;
  if (evidence.protocol !== 'livekit_webrtc' ||
      evidence.evidence_level !== 'controlled' ||
      evidence.capacity_claim !== 'none' ||
      !['controlled_pass', 'controlled_failed', 'invalid_generator_capacity']
        .includes(String(evidence.status))) {
    throw new Error('LiveKit media evidence contract is invalid');
  }
  for (const field of ['run_id', 'shard_id', 'worker_id', 'lease_epoch'] as const) {
    if (typeof evidence[field] !== 'string' || evidence[field].length === 0) {
      throw new Error(`LiveKit media evidence ${field} is invalid`);
    }
  }
  return evidence as LiveKitEvidenceIdentity & Record<string, unknown>;
}

function assertSameLease(
  left: Pick<LiveKitEvidenceIdentity, 'run_id' | 'shard_id' | 'worker_id' | 'lease_epoch'>,
  right: NetworkImpairmentLease
): void {
  if (left.run_id !== right.run_id || left.shard_id !== right.shard_id ||
      left.worker_id !== right.worker_id || left.lease_epoch !== right.lease_epoch) {
    throw new Error('network impairment lease must match the LiveKit evidence assignment');
  }
}

function sha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('media evidence SHA-256 is invalid');
}

function instant(value: string, label: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${label} timestamp is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} timestamp is invalid`);
  }
  return parsed;
}
