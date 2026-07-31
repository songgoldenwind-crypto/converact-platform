import {
  assertBackendCapabilities,
  backendRuntimeIdentityFromCapabilitySet,
  sameRuntimeIdentity,
  validateBackendRuntimeIdentity
} from './capabilities.js';
import {
  snapshotClosedArray,
  snapshotClosedRecord
} from './closed-schema.js';
import type {
  BackendCapabilitySet,
  BackendRuntimeIdentity
} from './types.js';

const MAX_DEADLINE_POLICIES = 16;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_COUNTER = 1_000_000;
const MAX_NTP_OFFSET_MS = 24 * 60 * 60 * 1_000;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

const SNAPSHOT_KEYS = Object.freeze([
  'adapter_identity',
  'captured_wall_at',
  'command_sequence',
  'deadline_policies',
  'dialog_state',
  'owner_epoch',
  'protocol_session_id',
  'protocol_session_generation',
  'quiescence',
  'schema_version'
]);
const RECOVERY_INPUT_KEYS = Object.freeze([
  'accepted_schema_version',
  'downtime_elapsed_evidence_ms',
  'ntp_offset_evidence_ms',
  'snapshot',
  'target_capability_set'
]);
const QUIESCENCE_KEYS = Object.freeze([
  'active_invite_transactions',
  'active_non_invite_transactions',
  'active_timers',
  'connection_state',
  'pending_2xx_ack',
  'pending_candidate_attempts',
  'pending_connect_attempts',
  'pending_dns_lookups',
  'pending_prack',
  'unknown_effects'
]);
const DEADLINE_POLICY_KEYS = Object.freeze([
  'duration_ms',
  'elapsed_ms_at_capture',
  'policy_id'
]);

export interface SipFoundationRecoveryDeadlinePolicy {
  policy_id: string;
  duration_ms: number;
  elapsed_ms_at_capture: number;
}

export interface SipFoundationRecoverySnapshot {
  schema_version: '1.0.0';
  protocol_session_id: string;
  protocol_session_generation: string;
  adapter_identity: BackendRuntimeIdentity;
  owner_epoch: string;
  command_sequence: string;
  dialog_state: 'early' | 'confirmed' | 'terminated' | 'unknown';
  quiescence: {
    active_invite_transactions: number;
    active_non_invite_transactions: number;
    pending_2xx_ack: boolean;
    pending_prack: boolean;
    pending_dns_lookups: number;
    pending_candidate_attempts: number;
    pending_connect_attempts: number;
    active_timers: number;
    unknown_effects: number;
    connection_state: 'connected' | 'not_applicable' | 'dead';
  };
  captured_wall_at: string;
  deadline_policies: SipFoundationRecoveryDeadlinePolicy[];
}

export interface SipFoundationRecoveryEligibilityInput {
  snapshot: SipFoundationRecoverySnapshot;
  target_capability_set: BackendCapabilitySet;
  accepted_schema_version: '1.0.0';
  downtime_elapsed_evidence_ms: number;
  ntp_offset_evidence_ms: number;
}

export interface SipFoundationRecoveryEligibilityResult {
  readonly schema_version: '1.0.0';
  readonly protocol_session_id: string;
  readonly protocol_session_generation: string;
  readonly backend_id: BackendRuntimeIdentity['backend_id'];
  readonly owner_epoch: string;
  readonly command_sequence: string;
  readonly eligibility_state: 'confirmed_quiescent';
  readonly required_authority: 'durable_session_generation_cas';
  readonly production_eligible: false;
  readonly deadlines: readonly Readonly<{
    policy_id: string;
    deadline_after_ms: number;
  }>[];
  readonly ntp_offset_evidence_ms: number;
}

export type SipFoundationRecoveryErrorCode =
  | 'sip_recovery_snapshot_invalid'
  | 'sip_recovery_schema_incompatible'
  | 'sip_recovery_cross_adapter_forbidden'
  | 'sip_recovery_adapter_identity_mismatch'
  | 'sip_recovery_capability_unavailable'
  | 'sip_recovery_early_dialog'
  | 'sip_recovery_dialog_not_confirmed'
  | 'sip_recovery_active_transaction'
  | 'sip_recovery_pending_ack'
  | 'sip_recovery_pending_prack'
  | 'sip_recovery_pending_dns'
  | 'sip_recovery_pending_candidate'
  | 'sip_recovery_pending_connect'
  | 'sip_recovery_active_timers'
  | 'sip_recovery_unknown_effect'
  | 'sip_recovery_connection_unrestorable'
  | 'sip_recovery_dead_connection';

export class SipFoundationRecoveryError extends Error {
  constructor(readonly code: SipFoundationRecoveryErrorCode) {
    super(code);
    this.name = 'SipFoundationRecoveryError';
  }
}

export function evaluateSipFoundationRecoveryEligibility(
  input: SipFoundationRecoveryEligibilityInput
): SipFoundationRecoveryEligibilityResult {
  const value = snapshotClosedRecord(
    input,
    RECOVERY_INPUT_KEYS,
    recoveryInvalid
  );
  if (value.accepted_schema_version !== '1.0.0') {
    fail('sip_recovery_schema_incompatible');
  }
  const snapshot = checkedSnapshot(value.snapshot);

  let targetIdentity: BackendRuntimeIdentity;
  try {
    targetIdentity = backendRuntimeIdentityFromCapabilitySet(
      value.target_capability_set
    );
    assertBackendCapabilities(value.target_capability_set as BackendCapabilitySet, {
      backend_id: targetIdentity.backend_id,
      source_digest: targetIdentity.source_digest,
      binary_digest: targetIdentity.binary_digest,
      config_digest: targetIdentity.config_digest,
      capability_set_digest: targetIdentity.capability_set_digest,
      require_production_eligible: false,
      required_capabilities: ['snapshot_restore']
    });
  } catch {
    fail('sip_recovery_capability_unavailable');
  }
  if (snapshot.adapter_identity.backend_id !== targetIdentity.backend_id) {
    fail('sip_recovery_cross_adapter_forbidden');
  }
  if (!sameRuntimeIdentity(snapshot.adapter_identity, targetIdentity)) {
    fail('sip_recovery_adapter_identity_mismatch');
  }

  assertQuiescent(snapshot);
  const downtimeMs = boundedInteger(
    value.downtime_elapsed_evidence_ms,
    0,
    MAX_DURATION_MS
  );
  const ntpOffsetMs = boundedInteger(
    value.ntp_offset_evidence_ms,
    -MAX_NTP_OFFSET_MS,
    MAX_NTP_OFFSET_MS
  );
  const deadlines = Object.freeze(snapshot.deadline_policies.map((policy) =>
    Object.freeze({
      policy_id: policy.policy_id,
      deadline_after_ms: Math.max(
        0,
        policy.duration_ms - policy.elapsed_ms_at_capture - downtimeMs
      )
    })
  ));

  return Object.freeze({
    schema_version: '1.0.0',
    protocol_session_id: snapshot.protocol_session_id,
    protocol_session_generation: snapshot.protocol_session_generation,
    backend_id: snapshot.adapter_identity.backend_id,
    owner_epoch: snapshot.owner_epoch,
    command_sequence: snapshot.command_sequence,
    eligibility_state: 'confirmed_quiescent',
    required_authority: 'durable_session_generation_cas',
    production_eligible: false,
    deadlines,
    ntp_offset_evidence_ms: ntpOffsetMs
  });
}

function checkedSnapshot(value: unknown): SipFoundationRecoverySnapshot {
  const record = snapshotClosedRecord(value, SNAPSHOT_KEYS, recoveryInvalid);
  if (record.schema_version !== '1.0.0') {
    fail('sip_recovery_schema_incompatible');
  }
  const protocolSessionId = identifier(record.protocol_session_id);
  const protocolSessionGeneration = identifier(
    record.protocol_session_generation
  );
  const adapterIdentity = checkedAdapterIdentity(record.adapter_identity);
  const ownerEpoch = uint64Decimal(record.owner_epoch);
  const commandSequence = uint64Decimal(record.command_sequence);
  const dialogState = record.dialog_state;
  if (dialogState !== 'early' && dialogState !== 'confirmed' &&
      dialogState !== 'terminated' && dialogState !== 'unknown') invalid();
  const quiescence = checkedQuiescence(record.quiescence);
  const capturedWallAt = canonicalTimestamp(record.captured_wall_at);
  const deadlinePolicies = checkedDeadlinePolicies(record.deadline_policies);
  return {
    schema_version: '1.0.0',
    protocol_session_id: protocolSessionId,
    protocol_session_generation: protocolSessionGeneration,
    adapter_identity: adapterIdentity,
    owner_epoch: ownerEpoch,
    command_sequence: commandSequence,
    dialog_state: dialogState,
    quiescence,
    captured_wall_at: capturedWallAt,
    deadline_policies: deadlinePolicies
  };
}

function checkedAdapterIdentity(value: unknown): BackendRuntimeIdentity {
  try {
    return validateBackendRuntimeIdentity(value);
  } catch {
    invalid();
  }
}

function checkedQuiescence(
  value: unknown
): SipFoundationRecoverySnapshot['quiescence'] {
  const record = snapshotClosedRecord(
    value,
    QUIESCENCE_KEYS,
    recoveryInvalid
  );
  if (typeof record.pending_2xx_ack !== 'boolean' ||
      typeof record.pending_prack !== 'boolean') invalid();
  const connectionState = record.connection_state;
  if (connectionState !== 'connected' && connectionState !== 'not_applicable' &&
      connectionState !== 'dead') invalid();
  return {
    active_invite_transactions: boundedInteger(
      record.active_invite_transactions,
      0,
      MAX_COUNTER
    ),
    active_non_invite_transactions: boundedInteger(
      record.active_non_invite_transactions,
      0,
      MAX_COUNTER
    ),
    pending_2xx_ack: record.pending_2xx_ack,
    pending_prack: record.pending_prack,
    pending_dns_lookups: boundedInteger(
      record.pending_dns_lookups,
      0,
      MAX_COUNTER
    ),
    pending_candidate_attempts: boundedInteger(
      record.pending_candidate_attempts,
      0,
      MAX_COUNTER
    ),
    pending_connect_attempts: boundedInteger(
      record.pending_connect_attempts,
      0,
      MAX_COUNTER
    ),
    active_timers: boundedInteger(record.active_timers, 0, MAX_COUNTER),
    unknown_effects: boundedInteger(record.unknown_effects, 0, MAX_COUNTER),
    connection_state: connectionState
  };
}

function checkedDeadlinePolicies(
  value: unknown
): SipFoundationRecoveryDeadlinePolicy[] {
  const values = snapshotClosedArray(
    value,
    MAX_DEADLINE_POLICIES,
    recoveryInvalid
  );
  const seen = new Set<string>();
  return values.map((raw) => {
    const record = snapshotClosedRecord(
      raw,
      DEADLINE_POLICY_KEYS,
      recoveryInvalid
    );
    const policyId = identifier(record.policy_id);
    if (seen.has(policyId)) invalid();
    seen.add(policyId);
    return {
      policy_id: policyId,
      duration_ms: boundedInteger(record.duration_ms, 0, MAX_DURATION_MS),
      elapsed_ms_at_capture: boundedInteger(
        record.elapsed_ms_at_capture,
        0,
        MAX_DURATION_MS
      )
    };
  });
}

function assertQuiescent(snapshot: SipFoundationRecoverySnapshot): void {
  if (snapshot.dialog_state === 'early') fail('sip_recovery_early_dialog');
  if (snapshot.dialog_state !== 'confirmed') {
    fail('sip_recovery_dialog_not_confirmed');
  }
  const state = snapshot.quiescence;
  if (state.active_invite_transactions > 0 ||
      state.active_non_invite_transactions > 0) {
    fail('sip_recovery_active_transaction');
  }
  if (state.pending_2xx_ack) fail('sip_recovery_pending_ack');
  if (state.pending_prack) fail('sip_recovery_pending_prack');
  if (state.pending_dns_lookups > 0) fail('sip_recovery_pending_dns');
  if (state.pending_candidate_attempts > 0) {
    fail('sip_recovery_pending_candidate');
  }
  if (state.pending_connect_attempts > 0) fail('sip_recovery_pending_connect');
  if (state.active_timers > 0) fail('sip_recovery_active_timers');
  if (state.unknown_effects > 0) fail('sip_recovery_unknown_effect');
  if (state.connection_state === 'dead') fail('sip_recovery_dead_connection');
  if (state.connection_state !== 'not_applicable') {
    fail('sip_recovery_connection_unrestorable');
  }
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    invalid();
  }
  return value;
}

function uint64Decimal(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    invalid();
  }
  const parsed = BigInt(value);
  if (parsed === 0n || parsed > MAX_U64) invalid();
  return value;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value)) invalid();
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) ||
      Number(value) < minimum ||
      Number(value) > maximum) invalid();
  return Number(value);
}

function recoveryInvalid(): SipFoundationRecoveryError {
  return new SipFoundationRecoveryError('sip_recovery_snapshot_invalid');
}

function invalid(): never {
  fail('sip_recovery_snapshot_invalid');
}

function fail(code: SipFoundationRecoveryErrorCode): never {
  throw new SipFoundationRecoveryError(code);
}
