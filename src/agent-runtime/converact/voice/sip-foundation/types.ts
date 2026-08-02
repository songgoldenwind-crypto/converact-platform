/**
 * The TypeScript seam is a closed conformance/migration model. It does not
 * parse or send production SIP and cannot own native transactions or dialogs.
 */
export const SIP_FOUNDATION_TYPESCRIPT_ROLE =
  'conformance_and_migration_harness_not_live_runtime_authority' as const;

export type SipFoundationBackendId = 'rsipstack' | 'rvoip';

export type SipFoundationCapabilityId =
  | 'protocol_session'
  | 'message_codec'
  | 'transaction_runtime'
  | 'dialog_runtime'
  | 'transport_runtime'
  | 'route_binding'
  | 'prepare_effect'
  | 'exact_wire_replay'
  | 'owner_fence'
  | 'commit_send'
  | 'query_effect'
  | 'reconcile_effect'
  | 'snapshot_restore'
  | 'drain';

export type SipFoundationCapabilitySupport =
  | 'supported'
  | 'unsupported'
  | 'unknown';

export type SipFoundationCapabilityVerification =
  | 'passed'
  | 'failed'
  | 'not_run';

export interface BackendCapabilityInput {
  support: SipFoundationCapabilitySupport;
  verification: SipFoundationCapabilityVerification;
}

export interface BackendCapability {
  readonly support: SipFoundationCapabilitySupport;
  readonly verification: SipFoundationCapabilityVerification;
}

export interface BackendCapabilitySetInput {
  schema_id: 'sip-foundation-backend-capability-set-v1';
  schema_version: '1.0.0';
  backend_id: SipFoundationBackendId;
  source_digest: string;
  binary_digest: string;
  config_digest: string;
  capability_set_digest: string;
  runtime_attestation_verification: 'not_run';
  production_eligible: false;
  capabilities: Record<SipFoundationCapabilityId, BackendCapabilityInput>;
}

export interface BackendCapabilitySet {
  readonly schema_id: 'sip-foundation-backend-capability-set-v1';
  readonly schema_version: '1.0.0';
  readonly backend_id: SipFoundationBackendId;
  readonly source_digest: string;
  readonly binary_digest: string;
  readonly config_digest: string;
  readonly capability_set_digest: string;
  readonly runtime_attestation_verification: 'not_run';
  readonly production_eligible: false;
  readonly capabilities: Readonly<Record<
    SipFoundationCapabilityId,
    BackendCapability
  >>;
}

export interface BackendRuntimeIdentity {
  readonly backend_id: SipFoundationBackendId;
  readonly source_digest: string;
  readonly binary_digest: string;
  readonly config_digest: string;
  readonly capability_set_digest: string;
  readonly runtime_attestation_verification: 'not_run';
  readonly production_eligible: false;
}

export type SipTransportProtocol = 'udp' | 'tcp' | 'tls' | 'ws' | 'wss';

export interface SipEndpoint {
  host: string;
  port: number;
}

export interface SipResolvedEndpoint {
  address: string;
  port: number;
}

export interface SipRouteBinding {
  schema_id: 'sip-foundation-route-binding-v1';
  schema_version: '1.0.0';
  route: {
    id: string;
    revision: number;
  };
  rfc3263_candidate: string;
  route_set: readonly string[];
  transport: {
    id: string;
    protocol: SipTransportProtocol;
    next_hop: SipResolvedEndpoint;
  };
  local_endpoint: {
    address: string;
    port: number;
  };
  advertised_via_sent_by: SipEndpoint;
  tls_sni: string | null;
  authorization_identity: string | null;
  authorization_headers_sha256: readonly string[];
}

export interface SipProtocolSessionBinding {
  schema_id: 'sip-foundation-session-binding-v1';
  schema_version: '1.0.0';
  route: {
    id: string;
    revision: number;
  };
  authorization_identity: string | null;
}

export interface BoundSipProtocolSessionBinding {
  readonly schema_id: 'sip-foundation-session-binding-v1';
  readonly schema_version: '1.0.0';
  readonly route: Readonly<{
    id: string;
    revision: number;
  }>;
  readonly authorization_identity: string | null;
}

export interface BoundSipRouteBinding {
  readonly schema_id: 'sip-foundation-route-binding-v1';
  readonly schema_version: '1.0.0';
  readonly route: Readonly<{
    id: string;
    revision: number;
  }>;
  readonly rfc3263_candidate: string;
  readonly route_set: readonly string[];
  readonly transport: Readonly<{
    id: string;
    protocol: SipTransportProtocol;
    next_hop: Readonly<SipResolvedEndpoint>;
  }>;
  readonly local_endpoint: Readonly<{
    address: string;
    port: number;
  }>;
  readonly advertised_via_sent_by: Readonly<SipEndpoint>;
  readonly tls_sni: string | null;
  readonly authorization_identity: string | null;
  readonly authorization_headers_sha256: readonly string[];
}

export interface SipWireAttemptFacts {
  schema_id: 'sip-foundation-wire-attempt-v1';
  schema_version: '1.0.0';
  attempt_id: string;
  transaction_lineage_id: string;
  semantic_intent_sha256: string;
  parent_attempt_id: string | null;
  lineage_reason: 'transaction_root' | 'derived_attempt';
}

export interface BoundSipWireAttemptFacts {
  readonly schema_id: 'sip-foundation-wire-attempt-v1';
  readonly schema_version: '1.0.0';
  readonly attempt_id: string;
  readonly transaction_lineage_id: string;
  readonly semantic_intent_sha256: string;
  readonly parent_attempt_id: string | null;
  readonly lineage_reason: 'transaction_root' | 'derived_attempt';
  readonly via_branch: string;
}

export interface OpenProtocolSessionInput {
  protocol_session_id: string;
  session_binding: SipProtocolSessionBinding;
}

export interface PrepareProtocolEffectInput {
  effect_id: string;
  command_id: string;
  owner_epoch: string;
  command_sequence: string;
  route_binding: SipRouteBinding;
  wire_attempt_facts: SipWireAttemptFacts;
  /**
   * Output of the Converact-owned canonical outbound SIP serializer. The adapter
   * owns the Via branch placeholder and validates all visible route/auth
   * bindings before it freezes the final wire image.
   */
  canonical_wire_template: Uint8Array;
}

export interface PreparedWireIdentity {
  readonly protocol_session_id: string;
  readonly protocol_session_generation: string;
  readonly effect_id: string;
  readonly command_id: string;
  readonly owner_epoch: string;
  readonly command_sequence: string;
  readonly wire_sha256: string;
  readonly route_binding_sha256: string;
  readonly wire_attempt_facts_sha256: string;
  readonly wire_freeze_sha256: string;
  readonly wire_length_bytes: number;
}

export interface PreparedProtocolEffect {
  readonly adapter_identity: BackendRuntimeIdentity;
  readonly wire_identity: PreparedWireIdentity;
  readonly route_binding: BoundSipRouteBinding;
  readonly wire_attempt_facts: BoundSipWireAttemptFacts;
  readonly wire_bytes_base64: string;
}

export interface SipProtocolSession {
  readonly protocol_session_id: string;
  readonly protocol_session_generation: string;
  readonly backend_id: SipFoundationBackendId;
  readonly adapter_identity: BackendRuntimeIdentity;
  readonly session_binding: BoundSipProtocolSessionBinding;
  prepareEffect(input: PrepareProtocolEffectInput): PreparedProtocolEffect;
}

export interface SipFoundationBackendSession {
  prepareEffect(input: PrepareProtocolEffectInput): PreparedProtocolEffect;
  verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array;
}

export interface PreparedProtocolEffectAuthority {
  verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array;
}

export interface SipProtocolSessionLease {
  readonly generation: string;
  assertActive(): void;
  reserveAttempt(): void;
}

export type SipFoundationDrainState =
  | 'accepting'
  | 'draining'
  | 'active_zero';

export interface SipFoundationDrainStatus {
  readonly state: SipFoundationDrainState;
  readonly active_session_count: number;
  readonly active_attempt_count: number;
}

export interface SipFoundationAdapter {
  readonly backend_id: SipFoundationBackendId;
  readonly runtime_identity: BackendRuntimeIdentity;
  readonly capability_set: BackendCapabilitySet;
  createProtocolSession(
    input: OpenProtocolSessionInput,
    lease: SipProtocolSessionLease
  ): SipFoundationBackendSession;
}

export interface SipFoundationAdapterSelection {
  backend_id: SipFoundationBackendId;
  source_digest: string;
  binary_digest: string;
  config_digest: string;
  capability_set_digest: string;
  require_production_eligible: boolean;
  required_capabilities: readonly SipFoundationCapabilityId[];
}

export type SipFoundationErrorCode =
  | 'sip_foundation_input_invalid'
  | 'sip_foundation_capability_set_invalid'
  | 'sip_foundation_capability_set_digest_invalid'
  | 'sip_foundation_adapter_identity_mismatch'
  | 'sip_foundation_adapter_not_found'
  | 'sip_foundation_adapter_ambiguous'
  | 'sip_foundation_capability_unsupported'
  | 'sip_foundation_capability_unknown'
  | 'sip_foundation_capability_unverified'
  | 'sip_foundation_source_identity_mismatch'
  | 'sip_foundation_runtime_identity_mismatch'
  | 'sip_foundation_config_identity_mismatch'
  | 'sip_foundation_capability_set_identity_mismatch'
  | 'sip_foundation_runtime_attestation_unverified'
  | 'sip_foundation_session_identity_conflict'
  | 'sip_foundation_session_binding_conflict'
  | 'sip_foundation_session_capacity_exhausted'
  | 'sip_foundation_session_open_in_progress'
  | 'sip_foundation_session_not_found'
  | 'sip_foundation_session_closed'
  | 'sip_foundation_draining'
  | 'sip_foundation_route_binding_invalid'
  | 'sip_foundation_wire_attempt_invalid'
  | 'sip_foundation_fence_invalid'
  | 'sip_foundation_wire_invalid';

export class SipFoundationError extends Error {
  readonly code: SipFoundationErrorCode;
  readonly details: Readonly<Record<string, string | number>>;

  constructor(
    code: SipFoundationErrorCode,
    details: Readonly<Record<string, string | number>> = {}
  ) {
    super(code);
    this.name = 'SipFoundationError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
