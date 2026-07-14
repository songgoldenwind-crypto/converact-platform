import type { IveKitSdkBusinessRef } from './types.js';

export type IveKitVoiceBusinessRef = Pick<IveKitSdkBusinessRef, 'type' | 'id'>;
export type IveKitVoiceDirection = 'inbound' | 'outbound';
export type IveKitVoiceRouteDirection = IveKitVoiceDirection | 'both';
export type IveKitVoiceAddressKind = 'e164' | 'extension' | 'sip_uri';

export type IveKitVoiceCallState =
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

export type IveKitVoiceCommandState =
  | 'pending'
  | 'processing'
  | 'retry_wait'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'uncertain';

export type IveKitVoiceCommandKind =
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

export type IveKitVoiceConfigurationResourceType =
  | 'deployment_profile'
  | 'sip_trunk'
  | 'did'
  | 'extension'
  | 'route';

export type IveKitVoiceConfigurationOperation =
  | 'preflight'
  | 'apply'
  | 'test'
  | 'disable'
  | 'delete';

export type IveKitVoiceCapability =
  | 'management_http'
  | 'json_rpc_routing'
  | 'step_ivr'
  | 'rwi'
  | 'webrtc_extension'
  | 'recording'
  | 'sipflow'
  | 'queue'
  | 'postgres_backend';

export type IveKitVoiceAdapter =
  | 'rustpbx'
  | 'livekit_sip'
  | 'active_call'
  | 'livekit_agents'
  | 'controlled';

export interface IveKitVoiceAddressProjection {
  kind: IveKitVoiceAddressKind;
  redacted: string;
}

export interface IveKitVoiceClearAddress {
  kind: IveKitVoiceAddressKind;
  value: string;
}

export interface IveKitVoicePageInput {
  cursor?: string;
  limit?: number;
}

export interface IveKitVoicePage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface IveKitVoiceCapabilities {
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
    livekit_sip_bridge: boolean;
    provider_webhooks: boolean;
  };
}

export interface IveKitVoiceDeploymentProfile {
  id: string;
  tenant_id: string;
  name: string;
  adapter: IveKitVoiceAdapter;
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

export interface IveKitVoiceCapabilitySnapshot {
  id: string;
  tenant_id: string;
  profile_id: string;
  provider: string;
  provider_version: string;
  status: 'ready' | 'degraded' | 'not_available' | 'failed';
  capabilities: Readonly<Record<IveKitVoiceCapability, boolean>>;
  config_hash: string;
  error_code: string;
  error_message: string;
  checked_at: string;
  created_at: string;
}

export interface IveKitVoiceSipTrunk {
  id: string;
  tenant_id: string;
  profile_id: string;
  name: string;
  provider_ref: string;
  direction: IveKitVoiceRouteDirection;
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

export interface IveKitVoiceDid {
  id: string;
  tenant_id: string;
  trunk_id: string;
  route_id: string | null;
  e164: IveKitVoiceAddressProjection;
  provider_ref: string;
  status: 'active' | 'disabled' | 'porting' | 'released';
  metadata: Record<string, unknown>;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface IveKitVoiceExtension {
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

export interface IveKitVoiceRoute {
  id: string;
  tenant_id: string;
  profile_id: string;
  name: string;
  direction: IveKitVoiceRouteDirection;
  status: 'draft' | 'active' | 'disabled' | 'archived';
  draft_revision: number;
  draft_rules: Record<string, unknown>;
  current_published_version: number | null;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IveKitVoiceRouteVersion {
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

export interface IveKitVoiceCall {
  id: string;
  tenant_id: string;
  business_ref: IveKitVoiceBusinessRef;
  provider_profile_id: string;
  provider_call_id: string;
  provider_dialog_id: string;
  media_call_id: string | null;
  direction: IveKitVoiceDirection;
  state: IveKitVoiceCallState;
  from: IveKitVoiceAddressProjection;
  to: IveKitVoiceAddressProjection;
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

export interface IveKitVoiceParticipant {
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

interface IveKitVoicePublicCommand {
  id: string;
  tenant_id: string;
  state: IveKitVoiceCommandState;
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

export interface IveKitVoiceCallCommand extends IveKitVoicePublicCommand {
  call_id: string;
  kind: IveKitVoiceCommandKind;
}

export interface IveKitVoiceConfigurationCommand extends IveKitVoicePublicCommand {
  profile_id: string;
  resource_type: IveKitVoiceConfigurationResourceType;
  resource_id: string;
  operation: IveKitVoiceConfigurationOperation;
}

export interface IveKitVoiceProviderEvent {
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

export interface IveKitVoiceLiveKitBridge {
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

export interface IveKitVoiceRecording {
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

export interface IveKitVoiceConsent {
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

export interface IveKitVoicePolicy {
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

export interface IveKitVoiceCreateProfileInput {
  name: string;
  adapter: IveKitVoiceAdapter;
  base_url?: string;
  desired_version?: string;
  config?: Record<string, unknown>;
  secret_refs?: Record<string, string>;
  status?: IveKitVoiceDeploymentProfile['status'];
}

export type IveKitVoiceProfilePatch = Partial<Pick<IveKitVoiceDeploymentProfile,
  'name' | 'adapter' | 'status' | 'base_url' | 'desired_version' | 'config' | 'secret_refs'>>;

export interface IveKitVoiceCreateTrunkInput {
  profile_id: string;
  name: string;
  direction: IveKitVoiceRouteDirection;
  transport: IveKitVoiceSipTrunk['transport'];
  codecs: string[];
  max_channels: number;
  credential_secret_ref: string;
  desired_state?: Record<string, unknown>;
}

export type IveKitVoiceTrunkPatch = Partial<Pick<IveKitVoiceSipTrunk,
  'name' | 'direction' | 'transport' | 'codecs' | 'max_channels' |
  'credential_secret_ref' | 'desired_state' | 'status'>>;

export interface IveKitVoiceCreateDidInput {
  trunk_id: string;
  route_id?: string | null;
  e164: string;
  metadata?: Record<string, unknown>;
  status?: IveKitVoiceDid['status'];
}

export type IveKitVoiceDidPatch = Partial<Pick<IveKitVoiceDid,
  'trunk_id' | 'route_id' | 'provider_ref' | 'status' | 'metadata'>>;

export interface IveKitVoiceCreateExtensionInput {
  profile_id: string;
  identity: string;
  extension: string;
  display_name: string;
  credential_secret_ref: string;
  permissions?: Record<string, unknown>;
  webrtc_enabled: boolean;
  status?: IveKitVoiceExtension['status'];
}

export type IveKitVoiceExtensionPatch = Partial<Pick<IveKitVoiceExtension,
  'identity' | 'extension' | 'display_name' | 'credential_secret_ref' |
  'permissions' | 'webrtc_enabled' | 'status'>>;

export interface IveKitVoiceCreateRouteInput {
  profile_id: string;
  name: string;
  direction: IveKitVoiceRouteDirection;
  draft_rules: Record<string, unknown>;
}

export type IveKitVoiceRoutePatch = Partial<Pick<IveKitVoiceRoute,
  'name' | 'direction' | 'status' | 'draft_rules'>>;

export interface IveKitVoiceCreateOutboundCallInput {
  profile_id: string;
  from: IveKitVoiceClearAddress;
  to: IveKitVoiceClearAddress;
  business_ref: IveKitVoiceBusinessRef;
  metadata?: Record<string, unknown>;
}

export interface IveKitVoiceCallActionInput {
  action: IveKitVoiceCommandKind;
  payload?: Record<string, unknown>;
}

export interface IveKitVoicePolicyWrite {
  require_outbound_consent: boolean;
  recording_mode: IveKitVoicePolicy['recording_mode'];
  recording_retention_days: number;
  require_ai_disclosure: boolean;
  allowed_calling_windows: unknown[];
  masking_policy?: Record<string, unknown>;
  status: IveKitVoicePolicy['status'];
  revision?: number | null;
}

export interface IveKitVoiceCreateConsentInput {
  subject_ref_type: string;
  subject_ref_id: string;
  business_ref_type: string;
  business_ref_id: string;
  consent_type: IveKitVoiceConsent['consent_type'];
  status: IveKitVoiceConsent['status'];
  evidence_ref: string;
  expires_at?: string | null;
}

export interface IveKitVoiceIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IveKitVoiceExtensionSessionCapabilities {
  incoming: boolean;
  outgoing: boolean;
  dtmf: boolean;
  hold: boolean;
  transfer: boolean;
  audio_input: boolean;
  audio_output: boolean;
}

export interface IveKitVoiceExtensionSessionPlan {
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
  ice_servers: IveKitVoiceIceServer[];
  capabilities: IveKitVoiceExtensionSessionCapabilities;
}

export function parseIveKitVoiceExtensionSessionPlan(
  value: unknown,
  options: { now?: () => number } = {}
): IveKitVoiceExtensionSessionPlan {
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
  const boolean = (key: keyof IveKitVoiceExtensionSessionCapabilities): boolean => {
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

export interface IveKitVoiceCreateCallResult {
  call: IveKitVoiceCall;
  command: IveKitVoiceCallCommand;
}

export interface IveKitVoicePublishRouteResult {
  route: IveKitVoiceRoute;
  version: IveKitVoiceRouteVersion;
  command: IveKitVoiceConfigurationCommand;
}
