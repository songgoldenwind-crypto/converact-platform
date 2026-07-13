export type VoiceDirection = 'inbound' | 'outbound';

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

export interface VoiceBusinessRef {
  type: string;
  id: string;
}

export interface VoiceAddressProjection {
  kind: 'e164' | 'extension' | 'sip_uri';
  redacted: string;
  hmac: string;
}

export interface VoiceCall {
  id: string;
  tenant_id: string;
  business_ref: VoiceBusinessRef;
  provider_profile_id: string;
  provider_call_id: string;
  provider_dialog_id: string;
  media_call_id: string;
  direction: VoiceDirection;
  state: VoiceCallState;
  from: VoiceAddressProjection;
  to: VoiceAddressProjection;
  ringing_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  termination_reason: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface VoiceProviderCapabilities {
  profile_id: string;
  provider: string;
  provider_version: string;
  capabilities: Readonly<Record<VoiceCapability, boolean>>;
  checked_at: string;
  config_hash: string;
}

export interface VoiceCallCommand {
  id: string;
  tenant_id: string;
  call_id: string;
  kind: VoiceCommandKind;
  state: VoiceCommandState;
  idempotency_key: string;
  payload_hash: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  provider_command_id: string;
  result: Record<string, unknown>;
  error_code: string;
  created_at: string;
  updated_at: string;
}
