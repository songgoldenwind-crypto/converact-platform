import type { ConveractFabricSdkBusinessRef } from './types.js';

export type ConveractFabricVoiceBusinessRef = Pick<ConveractFabricSdkBusinessRef, 'type' | 'id'>;
export type ConveractFabricVoiceDirection = 'inbound' | 'outbound';
export type ConveractFabricVoiceRouteDirection = ConveractFabricVoiceDirection | 'both';
export type ConveractFabricVoiceAddressKind = 'e164' | 'extension' | 'sip_uri';

export type ConveractFabricVoiceCallState =
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

export type ConveractFabricVoiceCommandState =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

export type ConveractFabricVoiceCommandKind =
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

export type ConveractFabricVoiceConferenceOperation = 'create' | 'add' | 'remove' | 'destroy';

export type ConveractFabricVoiceParkingSlotState =
  | 'parking'
  | 'parked'
  | 'retrieving'
  | 'released'
  | 'failed'
  | 'expired';

export interface ConveractFabricVoiceActionCapabilities {
  commands: Readonly<Record<ConveractFabricVoiceCommandKind, boolean>>;
  conference_operations: Readonly<Record<ConveractFabricVoiceConferenceOperation, boolean>>;
}

export interface ConveractFabricVoiceConferenceCreateOptions {
  backend?: 'internal' | 'external';
  max_members?: number;
  record?: boolean;
}

export type ConveractFabricVoiceConfigurationResourceType =
  | 'deployment_profile'
  | 'sip_trunk'
  | 'did'
  | 'extension'
  | 'route';

export type ConveractFabricVoiceConfigurationOperation =
  | 'preflight'
  | 'apply'
  | 'test'
  | 'disable'
  | 'delete';

export type ConveractFabricVoiceCapability =
  | 'management_http'
  | 'json_rpc_routing'
  | 'step_ivr'
  | 'rwi'
  | 'webrtc_extension'
  | 'recording'
  | 'sipflow'
  | 'queue'
  | 'postgres_backend';

export type ConveractFabricVoiceAdapter =
  | 'rustpbx'
  | 'livekit_sip'
  | 'active_call'
  | 'livekit_agents'
  | 'controlled';

export type ConveractFabricRealtimeVoiceAiProvider =
  | 'active_call'
  | 'livekit_agents'
  | 'self_hosted'
  | 'third_party';

export type ConveractFabricRealtimeVoiceAiCapability =
  | 'vad'
  | 'streaming_asr'
  | 'streaming_tts'
  | 'barge_in'
  | 'dtmf'
  | 'tool_calls'
  | 'transcript_events'
  | 'latency_metrics';

export interface ConveractFabricRealtimeVoiceAiProfile {
  id: string;
  tenant_id: string;
  name: string;
  provider: ConveractFabricRealtimeVoiceAiProvider;
  status: 'disabled' | 'enabled' | 'degraded' | 'archived';
  endpoint: string;
  provider_version: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  revision: number;
}

export interface ConveractFabricRealtimeVoiceAiToolRef {
  tool_id: string;
  version: number;
  schema_hash: string;
}

export interface ConveractFabricRealtimeVoiceAiCapabilities {
  profile_id: string;
  provider: ConveractFabricRealtimeVoiceAiProvider;
  provider_version: string;
  capabilities: Readonly<Record<ConveractFabricRealtimeVoiceAiCapability, boolean>>;
  checked_at: string;
}

export interface ConveractFabricStartRealtimeVoiceAiSessionInput {
  tenant_id: string;
  call_id: string;
  profile_id: string;
  language: string;
  tools: ReadonlyArray<ConveractFabricRealtimeVoiceAiToolRef>;
  idempotency_key: string;
}

export interface ConveractFabricRealtimeVoiceAiSessionPlan {
  provider_session_id: string;
  provider: ConveractFabricRealtimeVoiceAiProvider;
  provider_version: string;
  capabilities: Readonly<Record<ConveractFabricRealtimeVoiceAiCapability, boolean>>;
}

export interface ConveractFabricRealtimeVoiceAiSessionCommandInput {
  tenant_id: string;
  call_id: string;
  provider_session_id: string;
  reason: string;
  idempotency_key: string;
}

export interface ConveractFabricRealtimeVoiceAiDtmfInput {
  tenant_id: string;
  call_id: string;
  provider_session_id: string;
  digits: string;
  idempotency_key: string;
}

export type ConveractFabricRealtimeVoiceAiEventType =
  | 'session.started'
  | 'session.ended'
  | 'vad.started'
  | 'vad.stopped'
  | 'transcript.partial'
  | 'transcript.final'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'interrupted'
  | 'latency.measured';

export interface ConveractFabricRealtimeVoiceAiProjectedEvent {
  external_event_id: string;
  type: ConveractFabricRealtimeVoiceAiEventType;
  provider_session_id: string;
  occurred_at: string;
  transcript_text: string;
  transcript_persisted: boolean;
  language: string;
  tool_ref: string;
  tool_call_id: string;
  latency_ms: Record<string, number>;
  evidence_ref: string;
  safe_metadata: Record<string, unknown>;
}

export interface ConveractFabricRealtimeVoiceAiProjectionPolicy {
  persist_transcripts: boolean;
  persist_partial_transcripts: boolean;
  allowed_tool_refs: ReadonlyArray<string>;
  max_transcript_chars: number;
}

export interface ConveractFabricVoiceAddressProjection {
  kind: ConveractFabricVoiceAddressKind;
  redacted: string;
}

export interface ConveractFabricVoiceClearAddress {
  kind: ConveractFabricVoiceAddressKind;
  value: string;
}

export interface ConveractFabricVoicePageInput {
  cursor?: string;
  limit?: number;
}

export interface ConveractFabricVoicePage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ConveractFabricVoiceCapabilities {
  api_version: 'v1';
  tenant_id: string;
  capabilities: {
    deployment_profiles: boolean;
    sip_trunks: boolean;
    dids: boolean;
    extensions: boolean;
    extension_sessions: boolean;
    routes: boolean;
    calls: boolean;
    call_control: boolean;
    provider_events: boolean;
    recordings: boolean;
    parking_slots: boolean;
    livekit_sip_bridge: boolean;
    provider_webhooks: boolean;
  };
}

export interface ConveractFabricVoiceDeploymentProfile {
  id: string;
  tenant_id: string;
  name: string;
  adapter: ConveractFabricVoiceAdapter;
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

export interface ConveractFabricVoiceCapabilitySnapshot {
  id: string;
  tenant_id: string;
  profile_id: string;
  provider: string;
  provider_version: string;
  status: 'ready' | 'degraded' | 'not_available' | 'failed';
  capabilities: Readonly<Record<ConveractFabricVoiceCapability, boolean>>;
  capability_schema_version: 1;
  action_capabilities: ConveractFabricVoiceActionCapabilities;
  config_hash: string;
  error_code: string;
  error_message: string;
  checked_at: string;
  created_at: string;
}

export interface ConveractFabricVoiceSipTrunk {
  id: string;
  tenant_id: string;
  profile_id: string;
  name: string;
  provider_ref: string;
  direction: ConveractFabricVoiceRouteDirection;
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

export interface ConveractFabricVoiceDid {
  id: string;
  tenant_id: string;
  trunk_id: string;
  route_id: string | null;
  e164: ConveractFabricVoiceAddressProjection;
  provider_ref: string;
  status: 'active' | 'disabled' | 'porting' | 'released';
  metadata: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricVoiceExtension {
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

export interface ConveractFabricVoiceRoute {
  id: string;
  tenant_id: string;
  profile_id: string;
  name: string;
  direction: ConveractFabricVoiceRouteDirection;
  status: 'draft' | 'active' | 'disabled' | 'archived';
  draft_revision: number;
  draft_rules: Record<string, unknown>;
  current_published_version: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface ConveractFabricVoiceRouteVersion {
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

export interface ConveractFabricVoiceCall {
  id: string;
  tenant_id: string;
  business_ref: ConveractFabricVoiceBusinessRef;
  provider_profile_id: string;
  provider_call_id: string;
  provider_dialog_id: string;
  media_call_id: string | null;
  direction: ConveractFabricVoiceDirection;
  state: ConveractFabricVoiceCallState;
  from: ConveractFabricVoiceAddressProjection;
  to: ConveractFabricVoiceAddressProjection;
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

export interface ConveractFabricVoiceParkingSlot {
  id: string;
  tenant_id: string;
  profile_id: string;
  slot: string;
  state: ConveractFabricVoiceParkingSlotState;
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

export interface ConveractFabricVoiceParticipant {
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

interface ConveractFabricVoicePublicCommand {
  id: string;
  tenant_id: string;
  state: ConveractFabricVoiceCommandState;
  idempotency_key: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  provider_command_id: string;
  result: Record<string, unknown>;
  error_code: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ConveractFabricVoiceCallCommand extends ConveractFabricVoicePublicCommand {
  call_id: string;
  kind: ConveractFabricVoiceCommandKind;
}

export interface ConveractFabricVoiceConfigurationCommand extends ConveractFabricVoicePublicCommand {
  profile_id: string;
  resource_type: ConveractFabricVoiceConfigurationResourceType;
  resource_id: string;
  operation: ConveractFabricVoiceConfigurationOperation;
}

export interface ConveractFabricVoiceProviderEvent {
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

export interface ConveractFabricVoiceLiveKitBridge {
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

export interface ConveractFabricVoiceRecording {
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

export interface ConveractFabricVoiceConsent {
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

export interface ConveractFabricVoicePolicy {
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

export interface ConveractFabricVoiceCreateProfileInput {
  name: string;
  adapter: ConveractFabricVoiceAdapter;
  base_url?: string;
  desired_version?: string;
  config?: Record<string, unknown>;
  secret_refs?: Record<string, string>;
  status?: ConveractFabricVoiceDeploymentProfile['status'];
}

export type ConveractFabricVoiceProfilePatch = Partial<Pick<ConveractFabricVoiceDeploymentProfile,
  'name' | 'adapter' | 'status' | 'base_url' | 'desired_version' | 'config' | 'secret_refs'>>;

export interface ConveractFabricVoiceCreateTrunkInput {
  profile_id: string;
  name: string;
  direction: ConveractFabricVoiceRouteDirection;
  transport: ConveractFabricVoiceSipTrunk['transport'];
  codecs: string[];
  max_channels: number;
  credential_secret_ref: string;
  desired_state?: Record<string, unknown>;
}

export type ConveractFabricVoiceTrunkPatch = Partial<Pick<ConveractFabricVoiceSipTrunk,
  'name' | 'direction' | 'transport' | 'codecs' | 'max_channels' |
  'credential_secret_ref' | 'desired_state' | 'status'>>;

export interface ConveractFabricVoiceCreateDidInput {
  trunk_id: string;
  route_id?: string | null;
  e164: string;
  metadata?: Record<string, unknown>;
  status?: ConveractFabricVoiceDid['status'];
}

export type ConveractFabricVoiceDidPatch = Partial<Pick<ConveractFabricVoiceDid,
  'trunk_id' | 'route_id' | 'provider_ref' | 'status' | 'metadata'>>;

export interface ConveractFabricVoiceCreateExtensionInput {
  profile_id: string;
  identity: string;
  extension: string;
  display_name: string;
  credential_secret_ref: string;
  permissions?: Record<string, unknown>;
  webrtc_enabled: boolean;
  status?: ConveractFabricVoiceExtension['status'];
}

export type ConveractFabricVoiceExtensionPatch = Partial<Pick<ConveractFabricVoiceExtension,
  'identity' | 'extension' | 'display_name' | 'credential_secret_ref' |
  'permissions' | 'webrtc_enabled' | 'status'>>;

export interface ConveractFabricVoiceCreateRouteInput {
  profile_id: string;
  name: string;
  direction: ConveractFabricVoiceRouteDirection;
  draft_rules: Record<string, unknown>;
}

export type ConveractFabricVoiceRoutePatch = Partial<Pick<ConveractFabricVoiceRoute,
  'name' | 'direction' | 'status' | 'draft_rules'>>;

export interface ConveractFabricVoiceCreateOutboundCallInput {
  profile_id: string;
  from: ConveractFabricVoiceClearAddress;
  to: ConveractFabricVoiceClearAddress;
  business_ref: ConveractFabricVoiceBusinessRef;
  metadata?: Record<string, unknown>;
}

export interface ConveractFabricVoiceCallActionInput {
  action: ConveractFabricVoiceCommandKind;
  payload?: Record<string, unknown>;
}

export interface ConveractFabricVoicePolicyWrite {
  require_outbound_consent: boolean;
  recording_mode: ConveractFabricVoicePolicy['recording_mode'];
  recording_retention_days: number;
  require_ai_disclosure: boolean;
  allowed_calling_windows: unknown[];
  masking_policy?: Record<string, unknown>;
  status: ConveractFabricVoicePolicy['status'];
  revision?: number | null;
}

export interface ConveractFabricVoiceCreateConsentInput {
  subject_ref_type: string;
  subject_ref_id: string;
  business_ref_type: string;
  business_ref_id: string;
  consent_type: ConveractFabricVoiceConsent['consent_type'];
  status: ConveractFabricVoiceConsent['status'];
  evidence_ref: string;
  expires_at?: string | null;
}

export interface ConveractFabricVoiceIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface ConveractFabricVoiceExtensionSessionCapabilities {
  incoming: boolean;
  outgoing: boolean;
  dtmf: boolean;
  hold: boolean;
  transfer: boolean;
  audio_input: boolean;
  audio_output: boolean;
}

export interface ConveractFabricVoiceExtensionSessionPlan {
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
  ice_servers: ConveractFabricVoiceIceServer[];
  capabilities: ConveractFabricVoiceExtensionSessionCapabilities;
}

export function parseConveractFabricVoiceExtensionSessionPlan(
  value: unknown,
  options: { now?: () => number } = {}
): ConveractFabricVoiceExtensionSessionPlan {
  const invalid = () => new TypeError('invalid voice extension session plan');
  if (!isSessionRecord(value)) throw invalid();
  const string = (input: unknown, max = 2_048): string => {
    if (typeof input !== 'string' || !input || input.length > max
      || /[\u0000-\u001f\u007f]/.test(input)) throw invalid();
    return input;
  };
  let websocket: URL;
  try {
    websocket = new URL(string(value.websocket_url));
  } catch {
    throw invalid();
  }
  if (value.transport !== 'wss' || websocket.protocol !== 'wss:'
    || websocket.username || websocket.password || websocket.hash) throw invalid();
  const expiresAt = Date.parse(string(value.expires_at));
  const now = options.now?.() ?? Date.now();
  if (!Number.isFinite(expiresAt)) throw invalid();
  if (expiresAt <= now) throw new TypeError('expired voice extension session plan');
  const registerExpires = value.register_expires_seconds;
  const remainingSeconds = Math.floor((expiresAt - now) / 1_000);
  if (!Number.isInteger(registerExpires) || Number(registerExpires) < 30
    || Number(registerExpires) > 3_600 || Number(registerExpires) > remainingSeconds) throw invalid();
  if (!Array.isArray(value.ice_servers) || value.ice_servers.length > 16) throw invalid();
  const iceServers = value.ice_servers.map((candidate) => {
    if (!isSessionRecord(candidate)) throw invalid();
    const urls = Array.isArray(candidate.urls)
      ? candidate.urls.map((url) => validIceUrl(string(url)))
      : validIceUrl(string(candidate.urls));
    if (Array.isArray(urls) && !urls.length) throw invalid();
    return {
      urls,
      ...(candidate.username === undefined ? {} : { username: string(candidate.username, 512) }),
      ...(candidate.credential === undefined ? {} : { credential: string(candidate.credential, 2_048) })
    };
  });
  if (!isSessionRecord(value.capabilities)) throw invalid();
  const capabilities = value.capabilities;
  const boolean = (key: keyof ConveractFabricVoiceExtensionSessionCapabilities): boolean => {
    if (typeof capabilities[key] !== 'boolean') throw invalid();
    return capabilities[key];
  };
  const addressOfRecord = string(value.address_of_record, 1_024);
  if (!/^sips?:[^\s@]+@[^\s@]+$/i.test(addressOfRecord)) throw invalid();
  return {
    session_id: string(value.session_id, 256),
    extension_id: string(value.extension_id, 256),
    transport: 'wss', websocket_url: websocket.toString(),
    address_of_record: addressOfRecord,
    authorization_username: string(value.authorization_username, 512),
    authorization_password: string(value.authorization_password, 4_096),
    ...(value.display_name === undefined ? {} : { display_name: string(value.display_name, 256) }),
    expires_at: new Date(expiresAt).toISOString(),
    register_expires_seconds: Number(registerExpires),
    ice_servers: iceServers,
    capabilities: {
      incoming: boolean('incoming'), outgoing: boolean('outgoing'), dtmf: boolean('dtmf'),
      hold: boolean('hold'), transfer: boolean('transfer'),
      audio_input: boolean('audio_input'), audio_output: boolean('audio_output')
    }
  };
}

function validIceUrl(value: string): string {
  if (!/^(?:stun|stuns|turn|turns):[^\s]+$/i.test(value)) {
    throw new TypeError('invalid voice extension session plan');
  }
  return value;
}

function isSessionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface ConveractFabricVoiceCreateCallResult {
  call: ConveractFabricVoiceCall;
  command: ConveractFabricVoiceCallCommand;
}

export interface ConveractFabricVoicePublishRouteResult {
  route: ConveractFabricVoiceRoute;
  version: ConveractFabricVoiceRouteVersion;
  command: ConveractFabricVoiceConfigurationCommand;
}
