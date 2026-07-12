export interface IveKitSdkBusinessRef {
  tenant_id?: string;
  type: string;
  id: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
}

export type RemoteConsentScope =
  | 'view_screen'
  | 'control_mouse_keyboard'
  | 'record_screen'
  | 'transfer_file'
  | 'clipboard';

export type RustDeskAccessPolicyMode = 'attended_only' | 'unattended_allowed';
export type RustDeskAccessPolicyEventType = 'configured' | 'revoked';
export type RustDeskAccessPolicyEventState = 'active' | 'expired' | 'revoked' | 'superseded';

export interface RustDeskAccessPolicyEvent {
  id: string;
  tenant_id: string;
  device_id: string;
  event_type: RustDeskAccessPolicyEventType;
  mode: RustDeskAccessPolicyMode;
  allowed_scopes: RemoteConsentScope[];
  business_ref: Pick<IveKitSdkBusinessRef, 'type' | 'id'>;
  approved_by: string;
  reason: string;
  expires_at: string | null;
  version: number;
  state: RustDeskAccessPolicyEventState;
  created_at: string;
}

export interface RustDeskAccessPolicyCurrent {
  device_id: string;
  state: 'not_configured' | 'active' | 'expired' | 'revoked';
  policy: RustDeskAccessPolicyEvent | null;
}

export interface RustDeskAccessPolicyHistory {
  device_id: string;
  events: RustDeskAccessPolicyEvent[];
}

export interface RustDeskAccessPolicyMutationResult {
  policy: RustDeskAccessPolicyEvent;
  replayed: boolean;
}

export type RustDeskTerminalPlatform = 'windows' | 'macos' | 'linux';
export type RustDeskTerminalArchitecture = 'x86_64' | 'aarch64' | 'x86' | 'armv7';

export interface RustDeskClientVersion {
  product: 'rustdesk';
  version: string;
  channel: 'stable';
  source: 'terminal_heartbeat' | 'operator_report' | 'unknown';
  reported_at: string | null;
}

export interface RustDeskConfiguredFields {
  id_server_configured: boolean;
  relay_server_configured: boolean;
  api_server_configured: boolean;
  public_key_configured: boolean;
  server_key_fingerprint: string;
}

export type RustDeskCapabilityAvailability = 'unknown' | 'available' | 'unavailable';

export interface RustDeskRuntimeCapabilities {
  source: 'terminal_heartbeat' | 'native_observer' | 'operator_report' | 'unknown';
  reported_at: string | null;
  view_screen: RustDeskCapabilityAvailability;
  control_mouse_keyboard: RustDeskCapabilityAvailability;
  multi_display: RustDeskCapabilityAvailability;
  transfer_file: RustDeskCapabilityAvailability;
  clipboard: RustDeskCapabilityAvailability;
  record_screen: RustDeskCapabilityAvailability;
  session_disconnect: RustDeskCapabilityAvailability;
}

export interface RustDeskPermissionScopes {
  requested: RemoteConsentScope[];
  consented: RemoteConsentScope[];
  granted: RemoteConsentScope[];
}

export type RustDeskControlOwnershipStatus =
  | 'unowned'
  | 'owned'
  | 'transferring'
  | 'released'
  | 'expired';

export interface RustDeskControlOwnership {
  status: RustDeskControlOwnershipStatus;
  owner_identity: string | null;
  lease_expires_at: string | null;
  version: number;
  updated_at: string;
}

export type RustDeskConfirmedOperation =
  | 'control_mouse_keyboard'
  | 'transfer_file'
  | 'clipboard'
  | 'unattended_launch'
  | 'control_transfer';

export interface RustDeskSecondaryConfirmation {
  id: string;
  external_id: string;
  actor_identity: string;
  operation: RustDeskConfirmedOperation;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface RustDeskOperationAuthorization {
  id: string;
  external_id: string;
  actor_identity: string;
  operation: RustDeskConfirmedOperation;
  control_version: number;
  expires_at: string;
  authorized_at: string;
}

export type RustDeskObservedOperation =
  | RemoteConsentScope
  | 'multi_display'
  | 'session_disconnect';

export interface RustDeskOperationEvidenceReference {
  type: string;
  ref: string;
  sha256: string;
}

export type RustDeskOperationDirection =
  | 'upload'
  | 'download'
  | 'agent_to_device'
  | 'device_to_agent';

export interface RustDeskOperationEvidenceMetadata {
  external_id?: string;
  provider_operation_id?: string;
  provider_session_id?: string;
  target_id?: string;
  direction?: RustDeskOperationDirection;
  display_id?: string;
  byte_count?: number;
  checksum_sha256?: string;
  duration_ms?: number;
  reason?: string;
  status_detail?: string;
}

export type RustDeskOperationObserver =
  | 'native_client'
  | 'edge_adapter'
  | 'operator'
  | 'qa';

interface RustDeskOperationEvidenceBase {
  operation_id: string;
  operation: RustDeskObservedOperation;
  metadata: RustDeskOperationEvidenceMetadata;
}

export interface RustDeskOperationNotObservedEvidence extends RustDeskOperationEvidenceBase {
  status: 'not_observed';
  observer: 'none';
  observed_at: null;
  evidence_refs: [];
}

export interface RustDeskOperationObservedEvidence extends RustDeskOperationEvidenceBase {
  status: 'observed_succeeded' | 'observed_failed';
  observer: RustDeskOperationObserver;
  observed_at: string;
  evidence_refs: [RustDeskOperationEvidenceReference, ...RustDeskOperationEvidenceReference[]];
}

export type RustDeskOperationEvidence =
  | RustDeskOperationNotObservedEvidence
  | RustDeskOperationObservedEvidence;

export interface RustDeskTerminalProfile {
  device_id: string;
  rustdesk_id: string;
  platform: RustDeskTerminalPlatform;
  architecture: RustDeskTerminalArchitecture;
  client_version: RustDeskClientVersion;
  configured: RustDeskConfiguredFields;
  available: RustDeskRuntimeCapabilities;
  granted: RustDeskPermissionScopes;
  observed: RustDeskOperationEvidence[];
  updated_at: string;
}

export interface RemoteGatewayAuditEvent {
  external_id: string;
  event_type: string;
  actor_identity: string;
  target: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export type RustDeskPublicKeySource = 'env' | 'file' | 'none';

export interface RustDeskClientConfig {
  provider: 'rustdesk';
  id_server: string;
  relay_server: string;
  api_server: string;
  api_server_error?: string;
  public_key: string;
  public_key_source: RustDeskPublicKeySource;
  public_key_file: string;
  public_key_configured: boolean;
  public_key_error?: string;
  server_key_fingerprint: string;
  manual_fields: {
    id_server: string;
    relay_server: string;
    api_server?: string;
    key: string;
  };
  configured?: RustDeskConfiguredFields;
}

export type RustDeskClientDistributionPlatform = 'windows' | 'macos' | 'linux';
export type RustDeskClientDistributionArchitecture = 'x86_64' | 'aarch64';

export type RustDeskClientInstallSource =
  | { state: 'not_configured' }
  | {
      state: 'configured';
      url: string;
      filename: string;
      sha256: string;
    };

export interface RustDeskClientDistributionProfile {
  platform: RustDeskClientDistributionPlatform;
  architecture: RustDeskClientDistributionArchitecture;
  client_version: {
    exact: '1.4.7';
    allowed: ['1.4.7'];
  };
  server_version: '1.1.15';
  issued_at: string;
  expires_at: string;
  manual_fields: {
    id_server: string;
    relay_server: string;
    api_server: string;
    key: string;
  };
  server_key_fingerprint: string;
  protocol_handler: {
    supported: true;
    user_initiated_only: true;
  };
  install_source: RustDeskClientInstallSource;
  unattended_policy: {
    mode: 'attended_only';
    state: 'not_configured';
  };
}

export interface RustDeskDevice {
  id: string;
  tenant_id: string;
  business_ref_type: string;
  business_ref_id: string;
  rustdesk_id: string;
  display_name: string;
  status: 'active' | 'inactive';
  runtime_status: 'unknown' | 'online' | 'offline';
  last_seen_at: string | null;
  last_seen_actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deactivated_at: string | null;
  terminal_profile?: RustDeskTerminalProfile;
}

export type RustDeskDeviceCommandStatus = 'pending' | 'claimed' | 'succeeded' | 'failed';
export type RustDeskDisconnectReason =
  | 'consent_revoked'
  | 'remote_session_ended'
  | 'tool_ended'
  | 'gateway_ended';

export interface RustDeskDeviceCommand {
  id: string;
  tenant_id: string;
  device_id: string;
  external_id: string;
  command_type: 'disconnect_session';
  status: RustDeskDeviceCommandStatus;
  requested_by: string;
  requested_reason: RustDeskDisconnectReason;
  attempt_count: number;
  max_attempts: number;
  claimed_by: string;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  execution_method: 'session_adapter' | 'service_restart' | null;
  exit_code: number | null;
  duration_ms: number | null;
  stdout_bytes: number | null;
  stderr_bytes: number | null;
  stdout_sha256: string;
  stderr_sha256: string;
  result_metadata: Record<string, unknown>;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

type RustDeskDisconnectCommandState = {
  [Status in RustDeskDeviceCommandStatus]: {
    required: true;
    status: Status;
    command: RustDeskDeviceCommand & { status: Status };
  }
}[RustDeskDeviceCommandStatus];

type RustDeskDisconnectAvailabilityState =
  | {
      required: true;
      status: 'unavailable';
      command: null;
    }
  | RustDeskDisconnectCommandState;

type RustDeskDisconnectObservationState =
  | {
      observation_status?: 'not_observed';
      observed?: RustDeskOperationNotObservedEvidence & { operation: 'session_disconnect' };
    }
  | {
      observation_status: 'observed_disconnected';
      observed: RustDeskOperationObservedEvidence & {
        operation: 'session_disconnect';
        status: 'observed_succeeded';
      };
    }
  | {
      observation_status: 'observed_connected';
      observed: RustDeskOperationObservedEvidence & {
        operation: 'session_disconnect';
        status: 'observed_failed';
      };
    };

export type RustDeskDisconnectState = RustDeskDisconnectAvailabilityState &
  RustDeskDisconnectObservationState;

export interface RustDeskPhysicalDisconnectSummary {
  required: true;
  status: RustDeskDeviceCommandStatus | 'unavailable';
  command_id?: string;
}

export interface RemoteGatewayTarget {
  type: 'device' | 'connection' | 'browser' | string;
  id: string;
  display_name?: string;
}

export interface RemoteToolSession {
  id: string;
  tenant_id: string;
  remote_session_id: string;
  provider: string;
  external_id: string;
  launch_url: string;
  status: 'active' | 'ended';
  started_by: string;
  started_at: string;
  ended_at: string | null;
  metadata: Record<string, unknown>;
  physical_disconnect?: RustDeskPhysicalDisconnectSummary;
  permission_scopes?: RustDeskPermissionScopes;
  control_ownership?: RustDeskControlOwnership;
  disconnect_state?: RustDeskDisconnectState;
  operation_evidence?: RustDeskOperationEvidence[];
}

export interface RustDeskGatewayLaunchPlan {
  external_id: string;
  status: 'active' | 'ended';
  launch_url: string;
  target: RemoteGatewayTarget;
  permissions: RemoteConsentScope[];
  runtime: {
    rustdesk_id: string;
    id_server: string;
    relay_server: string;
    api_server: string;
    server_key_fingerprint: string;
    public_key_configured: string;
    public_key_source: string;
  };
  client_config: {
    public_key_configured: boolean;
    public_key_source: string;
    manual_fields: {
      id_server: string;
      relay_server: string;
      api_server?: string;
      key: string;
    };
  };
  actions: {
    can_launch: boolean;
    open_url: string;
    protocol_url: string;
  };
  metadata: Record<string, unknown>;
  created_at: string;
  ended_at: string | null;
  permission_scopes?: RustDeskPermissionScopes;
  control_ownership?: RustDeskControlOwnership;
  operation_evidence?: RustDeskOperationEvidence[];
}
