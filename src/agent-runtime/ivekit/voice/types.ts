export type VoiceDirection = 'inbound' | 'outbound';
export type VoiceRouteDirection = VoiceDirection | 'both';
export type VoiceAddressKind = 'e164' | 'extension' | 'sip_uri';

export type VoiceCallState =
  | 'planned'
  | 'queued'
  | 'dialing'
  | 'ringing'
  | 'active'
  | 'held'
  | 'transferring'
  | 'completed'
  | 'cancelled'
  | 'missed'
  | 'rejected'
  | 'failed'
  | 'timed_out';

export type VoiceCallTransition =
  | 'queue'
  | 'dial'
  | 'ring'
  | 'answer'
  | 'hold'
  | 'resume'
  | 'transfer'
  | 'complete'
  | 'cancel'
  | 'miss'
  | 'reject'
  | 'fail'
  | 'timeout';

export type VoiceCommandState =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

export type VoiceCommandKind =
  | 'originate'
  | 'answer'
  | 'hangup'
  | 'dtmf'
  | 'hold'
  | 'resume'
  | 'blind_transfer'
  | 'warm_transfer'
  | 'conference'
  | 'park'
  | 'pickup'
  | 'recording_start'
  | 'recording_pause'
  | 'recording_resume'
  | 'recording_stop'
  | 'livekit_bridge_create';

export type VoiceParkingSlotState =
  | 'parking'
  | 'parked'
  | 'retrieving'
  | 'released'
  | 'failed'
  | 'expired';

export interface VoiceParkingSlot {
  id: string;
  tenant_id: string;
  profile_id: string;
  slot: string;
  state: VoiceParkingSlotState;
  parked_call_id: string;
  park_command_id: string;
  pickup_call_id: string | null;
  pickup_command_id: string | null;
  expires_at: string;
  release_reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
  released_at: string | null;
}

export type VoiceConferenceOperation = 'create' | 'add' | 'remove' | 'destroy';

export type VoiceCapabilitySchemaVersion = 1;

export interface VoiceActionCapabilities {
  commands: Readonly<Record<VoiceCommandKind, boolean>>;
  conference_operations: Readonly<Record<VoiceConferenceOperation, boolean>>;
}

export type VoiceConfigurationResourceType =
  | 'deployment_profile'
  | 'sip_trunk'
  | 'did'
  | 'extension'
  | 'route';

export type VoiceConfigurationOperation =
  | 'preflight'
  | 'apply'
  | 'test'
  | 'disable'
  | 'delete';

export type VoiceCapability =
  | 'management_http'
  | 'json_rpc_routing'
  | 'step_ivr'
  | 'rwi'
  | 'webrtc_extension'
  | 'recording'
  | 'sipflow'
  | 'queue'
  | 'postgres_backend';

export type VoiceAdapter =
  | 'rustpbx'
  | 'livekit_sip'
  | 'active_call'
  | 'livekit_agents'
  | 'controlled';

export interface VoiceBusinessRef {
  type: string;
  id: string;
}

export interface VoiceAddressProjection {
  kind: VoiceAddressKind;
  redacted: string;
}

export interface VoiceProtectedAddress extends VoiceAddressProjection {
  ciphertext: string;
  hmac: string;
}

export interface VoiceListInput {
  tenant_id: string;
  cursor?: string;
  limit: number;
}

export interface VoicePage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface VoiceDeploymentProfile {
  id: string;
  tenant_id: string;
  name: string;
  adapter: VoiceAdapter;
  status: 'disabled' | 'enabled' | 'degraded' | 'archived';
  base_url: string;
  desired_version: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceCapabilitySnapshot {
  id: string;
  tenant_id: string;
  profile_id: string;
  provider: string;
  provider_version: string;
  status: 'ready' | 'degraded' | 'not_available' | 'failed';
  capabilities: Readonly<Record<VoiceCapability, boolean>>;
  capability_schema_version: VoiceCapabilitySchemaVersion;
  action_capabilities: VoiceActionCapabilities;
  config_hash: string;
  error_code: string;
  error_message: string;
  checked_at: string;
  created_at: string;
}

export interface VoiceProviderCapabilities {
  profile_id: string;
  provider: string;
  provider_version: string;
  capabilities: Readonly<Record<VoiceCapability, boolean>>;
  capability_schema_version: VoiceCapabilitySchemaVersion;
  action_capabilities: VoiceActionCapabilities;
  checked_at: string;
  config_hash: string;
}

export interface VoiceSipTrunk {
  id: string;
  tenant_id: string;
  profile_id: string;
  name: string;
  provider_ref: string;
  direction: VoiceRouteDirection;
  transport: 'udp' | 'tcp' | 'tls';
  codecs: string[];
  max_channels: number;
  credential_secret_ref: string;
  desired_state: Record<string, unknown>;
  status: 'draft' | 'applying' | 'active' | 'degraded' | 'disabled' | 'archived';
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceDid {
  id: string;
  tenant_id: string;
  trunk_id: string;
  route_id: string | null;
  e164: VoiceAddressProjection;
  provider_ref: string;
  status: 'active' | 'disabled' | 'porting' | 'released';
  metadata: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceExtension {
  id: string;
  tenant_id: string;
  profile_id: string;
  identity: string;
  extension: string;
  display_name: string;
  credential_secret_ref: string;
  permissions: Record<string, unknown>;
  webrtc_enabled: boolean;
  status: 'active' | 'disabled' | 'archived';
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceExtensionSessionPlan {
  session_id: string;
  extension_id: string;
  transport: 'wss';
  websocket_url: string;
  address_of_record: string;
  authorization_username: string;
  authorization_password: string;
  display_name?: string;
  expires_at: string;
  register_expires_seconds: number;
  ice_servers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  capabilities: {
    incoming: boolean;
    outgoing: boolean;
    dtmf: boolean;
    hold: boolean;
    transfer: boolean;
    audio_input: boolean;
    audio_output: boolean;
  };
}

export interface VoiceRoute {
  id: string;
  tenant_id: string;
  profile_id: string;
  name: string;
  direction: VoiceRouteDirection;
  status: 'draft' | 'active' | 'disabled' | 'archived';
  draft_revision: number;
  draft_rules: Record<string, unknown>;
  current_published_version: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceRouteVersion {
  id: string;
  tenant_id: string;
  route_id: string;
  version: number;
  rules: Record<string, unknown>;
  payload_hash: string;
  deployment_state: 'pending' | 'applying' | 'applied' | 'failed';
  provider_revision: string;
  published_by: string;
  published_at: string;
}

export interface VoiceCall {
  id: string;
  tenant_id: string;
  business_ref: VoiceBusinessRef;
  provider_profile_id: string;
  provider_call_id: string;
  provider_dialog_id: string;
  media_call_id: string | null;
  direction: VoiceDirection;
  state: VoiceCallState;
  from: VoiceAddressProjection;
  to: VoiceAddressProjection;
  idempotency_key: string;
  initiated_by: string;
  metadata: Record<string, unknown>;
  ringing_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  termination_reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceParticipant {
  id: string;
  tenant_id: string;
  call_id: string;
  identity: string;
  participant_kind: 'pstn' | 'sip' | 'webrtc' | 'livekit' | 'agent' | 'ai';
  role: 'caller' | 'callee' | 'agent' | 'supervisor' | 'observer' | 'ai';
  state: 'invited' | 'ringing' | 'joined' | 'held' | 'left' | 'failed';
  provider_participant_id: string;
  metadata: Record<string, unknown>;
  joined_at: string | null;
  left_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceCallCommand {
  id: string;
  tenant_id: string;
  call_id: string;
  kind: VoiceCommandKind;
  state: VoiceCommandState;
  idempotency_key: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_command_id: string;
  result: Record<string, unknown>;
  error_code: string;
  error_message: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface VoiceConfigurationCommand {
  id: string;
  tenant_id: string;
  profile_id: string;
  resource_type: VoiceConfigurationResourceType;
  resource_id: string;
  operation: VoiceConfigurationOperation;
  state: VoiceCommandState;
  idempotency_key: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  provider_command_id: string;
  result: Record<string, unknown>;
  error_code: string;
  error_message: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface VoiceProviderEvent {
  id: string;
  tenant_id: string;
  profile_id: string;
  call_id: string | null;
  external_event_id: string;
  canonical_hash: string;
  event_type: string;
  provider_state: string;
  safe_payload: Record<string, unknown>;
  processing_state: 'pending' | 'processing' | 'processed' | 'retry_wait' | 'failed';
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string;
  error_code: string;
  occurred_at: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface VoiceNormalizedProviderEvent {
  external_event_id: string;
  event_type: string;
  provider_state: string;
  provider_call_id?: string;
  occurred_at: string | null;
  safe_payload: Record<string, unknown>;
}

export interface VoiceLiveKitBridge {
  id: string;
  tenant_id: string;
  call_id: string;
  media_call_id: string;
  sip_participant_id: string;
  room_name: string;
  provider_bridge_id: string;
  status: 'pending' | 'creating' | 'active' | 'completed' | 'failed' | 'cancelled';
  idempotency_key: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface VoiceRecording {
  id: string;
  tenant_id: string;
  call_id: string;
  profile_id: string;
  provider_recording_id: string;
  status: 'processing' | 'available' | 'archived' | 'deleted' | 'expired' | 'failed';
  recording_mode: 'consent_required' | 'always';
  consent_id: string | null;
  object_ref: string;
  evidence_ref: string;
  checksum: string;
  duration_ms: number | null;
  retention_until: string | null;
  captured_at: string | null;
  deleted_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface VoiceConsent {
  id: string;
  tenant_id: string;
  subject_ref_type: string;
  subject_ref_id: string;
  business_ref_type: string;
  business_ref_id: string;
  consent_type: 'outbound_call' | 'recording' | 'ai_disclosure';
  status: 'granted' | 'revoked' | 'expired';
  evidence_ref: string;
  granted_by: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VoicePolicy {
  id: string;
  tenant_id: string;
  require_outbound_consent: boolean;
  recording_mode: 'disabled' | 'consent_required' | 'always';
  recording_retention_days: number;
  require_ai_disclosure: boolean;
  allowed_calling_windows: unknown[];
  masking_policy: Record<string, unknown>;
  status: 'active' | 'disabled' | 'archived';
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}
