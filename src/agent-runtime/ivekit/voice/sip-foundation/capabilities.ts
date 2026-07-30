import { createHash } from 'node:crypto';

import {
  SipFoundationError,
  type BackendCapability,
  type BackendCapabilitySet,
  type BackendRuntimeIdentity,
  type SipFoundationAdapter,
  type SipFoundationAdapterSelection,
  type SipFoundationBackendId,
  type SipFoundationCapabilityId
} from './types.js';
import {
  snapshotClosedArray,
  snapshotClosedRecord
} from './closed-schema.js';

export const SIP_FOUNDATION_CAPABILITY_IDS = Object.freeze([
  'protocol_session',
  'message_codec',
  'transaction_runtime',
  'dialog_runtime',
  'transport_runtime',
  'route_binding',
  'prepare_effect',
  'exact_wire_replay',
  'owner_fence',
  'commit_send',
  'query_effect',
  'reconcile_effect',
  'snapshot_restore',
  'drain'
] as const satisfies readonly SipFoundationCapabilityId[]);

interface CanonicalCapabilityPayload {
  readonly schema_id: 'sip-foundation-backend-capability-set-v1';
  readonly schema_version: '1.0.0';
  readonly backend_id: SipFoundationBackendId;
  readonly runtime_attestation_verification: 'not_run';
  readonly production_eligible: false;
  readonly capabilities: Readonly<Record<
    SipFoundationCapabilityId,
    BackendCapability
  >>;
}

const CAPABILITY_IDS = new Set<string>(SIP_FOUNDATION_CAPABILITY_IDS);
const CAPABILITY_PAYLOAD_KEYS = [
  'schema_id',
  'schema_version',
  'backend_id',
  'runtime_attestation_verification',
  'production_eligible',
  'capabilities'
] as const;
const CAPABILITY_SET_KEYS = [
  ...CAPABILITY_PAYLOAD_KEYS,
  'source_digest',
  'binary_digest',
  'config_digest',
  'capability_set_digest'
] as const;
const CAPABILITY_KEYS = ['support', 'verification'] as const;
const SELECTION_KEYS = [
  'backend_id',
  'source_digest',
  'binary_digest',
  'config_digest',
  'capability_set_digest',
  'require_production_eligible',
  'required_capabilities'
] as const;
const RUNTIME_IDENTITY_KEYS = [
  'backend_id',
  'source_digest',
  'binary_digest',
  'config_digest',
  'capability_set_digest',
  'runtime_attestation_verification',
  'production_eligible'
] as const;
const BACKEND_IDS = new Set<SipFoundationBackendId>(['rsipstack', 'rvoip']);
const SUPPORT_VALUES = new Set(['supported', 'unsupported', 'unknown']);
const VERIFICATION_VALUES = new Set(['passed', 'failed', 'not_run']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ADAPTERS = 8;

export function computeBackendCapabilitySetDigest(input: unknown): string {
  return digestCanonicalPayload(canonicalCapabilityPayload(input));
}

export function createBackendCapabilitySet(input: unknown): BackendCapabilitySet {
  const value = exactRecord(input, CAPABILITY_SET_KEYS, capabilitySetInvalid);
  const payload = canonicalCapabilityPayload({
    schema_id: value.schema_id,
    schema_version: value.schema_version,
    backend_id: value.backend_id,
    runtime_attestation_verification:
      value.runtime_attestation_verification,
    production_eligible: value.production_eligible,
    capabilities: value.capabilities
  });
  if (!digest(value.source_digest) ||
      !digest(value.binary_digest) ||
      !digest(value.config_digest) ||
      !digest(value.capability_set_digest)) {
    throw capabilitySetInvalid();
  }
  const computedDigest = digestCanonicalPayload(payload);
  if (value.capability_set_digest !== computedDigest) {
    throw new SipFoundationError('sip_foundation_capability_set_digest_invalid');
  }

  return Object.freeze({
    ...payload,
    source_digest: String(value.source_digest),
    binary_digest: String(value.binary_digest),
    config_digest: String(value.config_digest),
    capability_set_digest: computedDigest,
    runtime_attestation_verification: 'not_run',
    production_eligible: false
  });
}

export function backendRuntimeIdentityFromCapabilitySet(
  input: unknown
): BackendRuntimeIdentity {
  const capabilitySet = createBackendCapabilitySet(input);
  return Object.freeze({
    backend_id: capabilitySet.backend_id,
    source_digest: capabilitySet.source_digest,
    binary_digest: capabilitySet.binary_digest,
    config_digest: capabilitySet.config_digest,
    capability_set_digest: capabilitySet.capability_set_digest,
    runtime_attestation_verification:
      capabilitySet.runtime_attestation_verification,
    production_eligible: capabilitySet.production_eligible
  });
}

export function validateBackendRuntimeIdentity(
  input: unknown
): BackendRuntimeIdentity {
  const value = exactRecord(input, RUNTIME_IDENTITY_KEYS, inputInvalid);
  if (!BACKEND_IDS.has(value.backend_id as SipFoundationBackendId) ||
      !digest(value.source_digest) ||
      !digest(value.binary_digest) ||
      !digest(value.config_digest) ||
      !digest(value.capability_set_digest) ||
      value.runtime_attestation_verification !== 'not_run' ||
      value.production_eligible !== false) {
    throw inputInvalid();
  }
  return Object.freeze({
    backend_id: value.backend_id as SipFoundationBackendId,
    source_digest: String(value.source_digest),
    binary_digest: String(value.binary_digest),
    config_digest: String(value.config_digest),
    capability_set_digest: String(value.capability_set_digest),
    runtime_attestation_verification: 'not_run',
    production_eligible: false
  });
}

export function selectSipFoundationAdapter(
  selection: SipFoundationAdapterSelection,
  adapters: readonly SipFoundationAdapter[]
): SipFoundationAdapter {
  const checkedSelection = checkedAdapterSelection(selection);
  const checkedAdapters = snapshotClosedArray(
    adapters,
    MAX_ADAPTERS,
    inputInvalid
  );
  const candidates: SipFoundationAdapter[] = [];
  for (let index = 0; index < checkedAdapters.length; index += 1) {
    const adapter = checkedAdapters[index] as SipFoundationAdapter | null;
    if (adapter?.backend_id === checkedSelection.backend_id) {
      candidates.push(adapter);
    }
  }
  if (candidates.length === 0) {
    throw new SipFoundationError('sip_foundation_adapter_not_found');
  }
  if (candidates.length !== 1) {
    throw new SipFoundationError('sip_foundation_adapter_ambiguous');
  }

  const adapter = candidates[0];
  const capabilitySet = createBackendCapabilitySet(adapter.capability_set);
  const runtimeIdentity = validateBackendRuntimeIdentity(adapter.runtime_identity);
  if (capabilitySet.backend_id !== adapter.backend_id) {
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  if (!sameRuntimeIdentity(
    runtimeIdentity,
    backendRuntimeIdentityFromCapabilitySet(capabilitySet)
  )) {
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  assertBackendCapabilities(capabilitySet, checkedSelection);
  return adapter;
}

export function sameRuntimeIdentity(
  left: BackendRuntimeIdentity,
  right: BackendRuntimeIdentity
): boolean {
  return left.backend_id === right.backend_id &&
    left.source_digest === right.source_digest &&
    left.binary_digest === right.binary_digest &&
    left.config_digest === right.config_digest &&
    left.capability_set_digest === right.capability_set_digest &&
    left.runtime_attestation_verification ===
      right.runtime_attestation_verification &&
    left.production_eligible === right.production_eligible;
}

export function assertBackendCapabilities(
  capabilitySet: BackendCapabilitySet,
  selection: SipFoundationAdapterSelection
): void {
  const checkedSet = createBackendCapabilitySet(capabilitySet);
  const checkedSelection = checkedAdapterSelection(selection);
  if (checkedSet.backend_id !== checkedSelection.backend_id) {
    throw new SipFoundationError('sip_foundation_adapter_identity_mismatch');
  }
  if (checkedSet.source_digest !== checkedSelection.source_digest) {
    throw new SipFoundationError('sip_foundation_source_identity_mismatch');
  }
  if (checkedSet.binary_digest !== checkedSelection.binary_digest) {
    throw new SipFoundationError('sip_foundation_runtime_identity_mismatch');
  }
  if (checkedSet.config_digest !== checkedSelection.config_digest) {
    throw new SipFoundationError('sip_foundation_config_identity_mismatch');
  }
  if (checkedSet.capability_set_digest !== checkedSelection.capability_set_digest) {
    throw new SipFoundationError('sip_foundation_capability_set_identity_mismatch');
  }
  if (checkedSelection.require_production_eligible) {
    throw new SipFoundationError(
      'sip_foundation_runtime_attestation_unverified'
    );
  }
  for (const id of checkedSelection.required_capabilities) {
    const capability = checkedSet.capabilities[id];
    if (!capability || capability.support === 'unknown') {
      throw new SipFoundationError('sip_foundation_capability_unknown', {
        capability: id
      });
    }
    if (capability.support !== 'supported') {
      throw new SipFoundationError('sip_foundation_capability_unsupported', {
        capability: id
      });
    }
    if (capability.verification !== 'passed') {
      throw new SipFoundationError('sip_foundation_capability_unverified', {
        capability: id
      });
    }
  }
}

function canonicalCapabilityPayload(input: unknown): CanonicalCapabilityPayload {
  const value = exactRecord(input, CAPABILITY_PAYLOAD_KEYS, capabilitySetInvalid);
  if (value.schema_id !== 'sip-foundation-backend-capability-set-v1' ||
      value.schema_version !== '1.0.0' ||
      !BACKEND_IDS.has(value.backend_id as SipFoundationBackendId) ||
      value.runtime_attestation_verification !== 'not_run' ||
      value.production_eligible !== false) {
    throw capabilitySetInvalid();
  }

  const inputCapabilities = exactRecord(
    value.capabilities,
    SIP_FOUNDATION_CAPABILITY_IDS,
    capabilitySetInvalid
  );
  const capabilities = Object.fromEntries(SIP_FOUNDATION_CAPABILITY_IDS.map((id) => {
    const capability = exactRecord(
      inputCapabilities[id],
      CAPABILITY_KEYS,
      capabilitySetInvalid
    );
    if (typeof capability.support !== 'string' ||
        typeof capability.verification !== 'string' ||
        !SUPPORT_VALUES.has(capability.support) ||
        !VERIFICATION_VALUES.has(capability.verification)) {
      throw capabilitySetInvalid();
    }
    return [id, Object.freeze({
      support: capability.support,
      verification: capability.verification
    })];
  })) as Record<SipFoundationCapabilityId, BackendCapability>;

  return Object.freeze({
    schema_id: 'sip-foundation-backend-capability-set-v1',
    schema_version: '1.0.0',
    backend_id: value.backend_id as SipFoundationBackendId,
    runtime_attestation_verification: 'not_run',
    production_eligible: false,
    capabilities: Object.freeze(capabilities)
  });
}

function checkedAdapterSelection(
  input: SipFoundationAdapterSelection
): SipFoundationAdapterSelection {
  const value = exactRecord(input, SELECTION_KEYS, inputInvalid);
  if (!BACKEND_IDS.has(value.backend_id as SipFoundationBackendId) ||
      !digest(value.source_digest) ||
      !digest(value.binary_digest) ||
      !digest(value.config_digest) ||
      !digest(value.capability_set_digest) ||
      typeof value.require_production_eligible !== 'boolean') {
    throw inputInvalid();
  }
  const required = snapshotClosedArray(
    value.required_capabilities,
    SIP_FOUNDATION_CAPABILITY_IDS.length,
    inputInvalid
  );
  if (new Set(required).size !== required.length) {
    throw inputInvalid();
  }
  for (const id of required) {
    if (typeof id !== 'string' || !CAPABILITY_IDS.has(id)) {
      throw new SipFoundationError('sip_foundation_capability_unknown', {
        capability: typeof id === 'string'
          ? id.slice(0, 128)
          : 'non_string_capability'
      });
    }
  }
  return Object.freeze({
    backend_id: value.backend_id as SipFoundationBackendId,
    source_digest: String(value.source_digest),
    binary_digest: String(value.binary_digest),
    config_digest: String(value.config_digest),
    capability_set_digest: String(value.capability_set_digest),
    require_production_eligible: value.require_production_eligible,
    required_capabilities: required as readonly SipFoundationCapabilityId[]
  });
}

function digestCanonicalPayload(payload: CanonicalCapabilityPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
  error: () => SipFoundationError
): Record<string, unknown> {
  return snapshotClosedRecord(value, expected, error);
}

function capabilitySetInvalid(): SipFoundationError {
  return new SipFoundationError('sip_foundation_capability_set_invalid');
}

function inputInvalid(): SipFoundationError {
  return new SipFoundationError('sip_foundation_input_invalid');
}
