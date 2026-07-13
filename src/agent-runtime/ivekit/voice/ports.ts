import type {
  VoiceCall,
  VoiceCallCommand,
  VoiceCommandKind,
  VoiceProviderCapabilities
} from './types.js';

export interface VoiceClock {
  now(): Date;
}

export interface VoiceAddressProtector {
  protect(
    tenantId: string,
    value: string,
    kind: 'e164' | 'extension' | 'sip_uri'
  ): Promise<{ ciphertext: string; hmac: string; redacted: string }>;
  reveal(
    tenantId: string,
    ciphertext: string,
    kind: 'e164' | 'extension' | 'sip_uri'
  ): Promise<string>;
}

export interface VoiceSecretResolver {
  resolve(ref: unknown, purpose: string): Promise<string>;
}

export interface VoiceCallRepository {
  get(
    tenantId: string,
    callId: string,
    options?: { for_update?: boolean }
  ): Promise<VoiceCall | null>;
  insert(call: VoiceCall): Promise<VoiceCall>;
  update(call: VoiceCall, expectedRevision: number): Promise<VoiceCall>;
}

export interface VoiceCommandRepository {
  findByIdempotencyKey(tenantId: string, key: string): Promise<VoiceCallCommand | null>;
  insert(command: VoiceCallCommand): Promise<VoiceCallCommand>;
  claimDue(input: {
    worker_id: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<VoiceCallCommand[]>;
  complete(input: {
    tenant_id: string;
    command_id: string;
    state: VoiceCallCommand['state'];
    result?: Record<string, unknown>;
    error_code?: string;
  }): Promise<VoiceCallCommand>;
}

export interface VoiceProviderPort {
  preflight(): Promise<VoiceProviderCapabilities>;
  execute(input: {
    call: VoiceCall;
    command: VoiceCallCommand;
    clear_address?: string;
  }): Promise<{
    provider_command_id: string;
    provider_call_id?: string;
    accepted: boolean;
  }>;
  reconcile(input: {
    call: VoiceCall;
    command: VoiceCallCommand;
  }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state?: string;
  }>;
}

export interface VoiceCompliancePort {
  authorize(input: {
    tenant_id: string;
    call_id: string;
    command: VoiceCommandKind;
    actor_identity: string;
  }): Promise<{ allowed: boolean; reason: string; evidence_ref: string }>;
}

export interface VoiceMediaBridgePort {
  create(input: {
    tenant_id: string;
    call_id: string;
    business_ref: { type: string; id: string };
    idempotency_key: string;
  }): Promise<{
    media_call_id: string;
    room_name: string;
    sip_participant_id: string;
  }>;
}

export interface VoiceEventPort {
  publish(tenantId: string, type: string, data: unknown): void | Promise<void>;
}
