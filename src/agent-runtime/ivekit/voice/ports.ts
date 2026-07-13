import type {
  VoiceCall,
  VoiceCallCommand,
  VoiceCapabilitySnapshot,
  VoiceCommandKind,
  VoiceCommandState,
  VoiceConfigurationCommand,
  VoiceConsent,
  VoiceDeploymentProfile,
  VoiceDid,
  VoiceExtension,
  VoiceListInput,
  VoiceLiveKitBridge,
  VoicePage,
  VoiceParticipant,
  VoicePolicy,
  VoiceProtectedAddress,
  VoiceProviderCapabilities,
  VoiceProviderEvent,
  VoiceNormalizedProviderEvent,
  VoiceRecording,
  VoiceRoute,
  VoiceRouteVersion,
  VoiceSipTrunk
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

export interface VoiceConfigurationRepository {
  getProfile(tenantId: string, id: string, options?: { for_update?: boolean }): Promise<VoiceDeploymentProfile | null>;
  listProfiles(input: VoiceListInput): Promise<VoicePage<VoiceDeploymentProfile>>;
  insertProfile(input: VoiceDeploymentProfile): Promise<VoiceDeploymentProfile>;
  updateProfile(input: VoiceDeploymentProfile, expectedRevision: number): Promise<VoiceDeploymentProfile>;
  insertCapabilitySnapshot(input: VoiceCapabilitySnapshot): Promise<VoiceCapabilitySnapshot>;
  getLatestCapabilitySnapshot(tenantId: string, profileId: string): Promise<VoiceCapabilitySnapshot | null>;
  getTrunk(tenantId: string, id: string, options?: { for_update?: boolean }): Promise<VoiceSipTrunk | null>;
  listTrunks(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceSipTrunk>>;
  insertTrunk(input: VoiceSipTrunk): Promise<VoiceSipTrunk>;
  updateTrunk(input: VoiceSipTrunk, expectedRevision: number): Promise<VoiceSipTrunk>;
  getDid(tenantId: string, id: string, options?: { for_update?: boolean }): Promise<VoiceDid | null>;
  findDidByAddressHmac?(tenantId: string, hmac: string): Promise<VoiceDid | null>;
  listDids(input: VoiceListInput & { trunk_id?: string }): Promise<VoicePage<VoiceDid>>;
  insertDid(input: VoiceDid, address: VoiceProtectedAddress): Promise<VoiceDid>;
  updateDid(input: VoiceDid, expectedRevision: number): Promise<VoiceDid>;
  getExtension(tenantId: string, id: string, options?: { for_update?: boolean }): Promise<VoiceExtension | null>;
  listExtensions(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceExtension>>;
  insertExtension(input: VoiceExtension): Promise<VoiceExtension>;
  updateExtension(input: VoiceExtension, expectedRevision: number): Promise<VoiceExtension>;
  getRoute(tenantId: string, id: string, options?: { for_update?: boolean }): Promise<VoiceRoute | null>;
  listRoutes(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceRoute>>;
  insertRoute(input: VoiceRoute): Promise<VoiceRoute>;
  updateRoute(input: VoiceRoute, expectedRevision: number): Promise<VoiceRoute>;
  insertRouteVersion(input: VoiceRouteVersion): Promise<VoiceRouteVersion>;
  listRouteVersions(tenantId: string, routeId: string): Promise<VoiceRouteVersion[]>;
  getPolicy(tenantId: string): Promise<VoicePolicy | null>;
  upsertPolicy(input: VoicePolicy, expectedRevision: number | null): Promise<VoicePolicy>;
  insertConsent(input: VoiceConsent): Promise<VoiceConsent>;
  listConsents(input: VoiceListInput & { subject_ref_type?: string; subject_ref_id?: string }): Promise<VoicePage<VoiceConsent>>;
}

export interface VoiceCallRepository {
  get(tenantId: string, callId: string, options?: { for_update?: boolean }): Promise<VoiceCall | null>;
  findByIdempotencyKey(tenantId: string, key: string): Promise<VoiceCall | null>;
  findByProviderCallId(
    tenantId: string,
    profileId: string,
    providerCallId: string,
    options?: { for_update?: boolean }
  ): Promise<VoiceCall | null>;
  getProtectedAddress(
    tenantId: string,
    callId: string,
    side: 'from' | 'to'
  ): Promise<VoiceProtectedAddress | null>;
  list(input: VoiceListInput & { state?: VoiceCall['state']; business_ref?: { type: string; id: string } }): Promise<VoicePage<VoiceCall>>;
  insert(call: VoiceCall, from: VoiceProtectedAddress, to: VoiceProtectedAddress): Promise<VoiceCall>;
  update(call: VoiceCall, expectedRevision: number): Promise<VoiceCall>;
  insertParticipant(input: VoiceParticipant): Promise<VoiceParticipant>;
  updateParticipant(input: VoiceParticipant): Promise<VoiceParticipant>;
  listParticipants(tenantId: string, callId: string): Promise<VoiceParticipant[]>;
}

export interface VoiceQueueClaimInput {
  tenant_id: string;
  worker_id: string;
  now: Date;
  lease_ms: number;
  limit: number;
}

export interface VoiceCommandRepository {
  findCallByIdempotencyKey(tenantId: string, key: string): Promise<VoiceCallCommand | null>;
  insertCall(command: VoiceCallCommand): Promise<VoiceCallCommand>;
  claimCallDue(input: VoiceQueueClaimInput): Promise<VoiceCallCommand[]>;
  claimCallUncertain(input: VoiceQueueClaimInput): Promise<VoiceCallCommand[]>;
  completeCall(input: VoiceCommandCompletionInput): Promise<VoiceCallCommand>;
  releaseCall(input: VoiceCommandReleaseInput): Promise<VoiceCallCommand>;
  findConfigurationByIdempotencyKey(tenantId: string, key: string): Promise<VoiceConfigurationCommand | null>;
  insertConfiguration(command: VoiceConfigurationCommand): Promise<VoiceConfigurationCommand>;
  claimConfigurationDue(input: VoiceQueueClaimInput): Promise<VoiceConfigurationCommand[]>;
  claimConfigurationUncertain(input: VoiceQueueClaimInput): Promise<VoiceConfigurationCommand[]>;
  completeConfiguration(input: VoiceCommandCompletionInput): Promise<VoiceConfigurationCommand>;
  releaseConfiguration(input: VoiceCommandReleaseInput): Promise<VoiceConfigurationCommand>;
}

export interface VoiceCommandCompletionInput {
  tenant_id: string;
  command_id: string;
  worker_id: string;
  state: 'succeeded' | 'failed' | 'cancelled';
  provider_command_id?: string;
  result?: Record<string, unknown>;
  error_code?: string;
  error_message?: string;
}

export interface VoiceCommandReleaseInput {
  tenant_id: string;
  command_id: string;
  worker_id: string;
  state: Extract<VoiceCommandState, 'retry_wait' | 'uncertain' | 'failed'>;
  next_attempt_at?: Date | null;
  provider_command_id?: string;
  error_code: string;
  error_message?: string;
}

export interface VoiceProviderEventRepository {
  insert(event: VoiceProviderEvent): Promise<{ event: VoiceProviderEvent; replayed: boolean }>;
  claimDue(input: VoiceQueueClaimInput): Promise<VoiceProviderEvent[]>;
  complete(input: { tenant_id: string; event_id: string; worker_id: string }): Promise<VoiceProviderEvent>;
  release(input: {
    tenant_id: string;
    event_id: string;
    worker_id: string;
    state: 'retry_wait' | 'failed';
    next_attempt_at?: Date | null;
    error_code: string;
  }): Promise<VoiceProviderEvent>;
  listForCall(input: VoiceListInput & { call_id: string }): Promise<VoicePage<VoiceProviderEvent>>;
}

export interface VoiceRecordingRepository {
  getRecording(tenantId: string, id: string): Promise<VoiceRecording | null>;
  insertRecording(input: VoiceRecording): Promise<VoiceRecording>;
  updateRecording(input: VoiceRecording): Promise<VoiceRecording>;
  listRecordings(input: VoiceListInput & { call_id?: string; status?: VoiceRecording['status'] }): Promise<VoicePage<VoiceRecording>>;
  getBridge(tenantId: string, id: string): Promise<VoiceLiveKitBridge | null>;
  findBridgeByIdempotencyKey(tenantId: string, key: string): Promise<VoiceLiveKitBridge | null>;
  insertBridge(input: VoiceLiveKitBridge): Promise<VoiceLiveKitBridge>;
  updateBridge(input: VoiceLiveKitBridge): Promise<VoiceLiveKitBridge>;
  listBridgesForCall(tenantId: string, callId: string): Promise<VoiceLiveKitBridge[]>;
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
    provider_call_id?: string;
    provider_dialog_id?: string;
  }>;
}

export interface VoiceManagementApplyInput {
  resource_id: string;
  desired_state: Record<string, unknown>;
}

export interface VoiceManagementApplyResult {
  provider_ref: string;
  provider_revision: string;
  safe_diagnostics: Record<string, unknown>;
}

export interface VoiceManagementPort {
  preflight(): Promise<VoiceProviderCapabilities>;
  applyTrunk(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult>;
  testTrunk(input: { resource_id: string }): Promise<{
    ready: boolean;
    error_code: string;
    safe_diagnostics: Record<string, unknown>;
  }>;
  applyExtension(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult>;
  applyRoute(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult>;
  lookupDialog(input: { provider_call_id: string }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state: string;
    safe_diagnostics: Record<string, unknown>;
  }>;
  lookupRecording(input: { provider_recording_id: string }): Promise<{
    state: 'processing' | 'available' | 'failed' | 'unknown';
    object_ref: string;
    safe_diagnostics: Record<string, unknown>;
  }>;
}

export interface VoiceProviderAdapter extends VoiceProviderPort {
  management: VoiceManagementPort;
  normalizeEvent(input: unknown): VoiceNormalizedProviderEvent;
  close(): Promise<void>;
}

export interface VoiceProviderFactory {
  create(profile: VoiceDeploymentProfile): Promise<VoiceProviderAdapter>;
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

export interface VoiceConfigurationUnitOfWorkContext {
  configuration: VoiceConfigurationRepository;
  commands: VoiceCommandRepository;
}

export interface VoiceConfigurationUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: VoiceConfigurationUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}

export interface VoiceCallUnitOfWorkContext {
  calls: VoiceCallRepository;
  commands: VoiceCommandRepository;
  configuration: VoiceConfigurationRepository;
}

export interface VoiceCallUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: VoiceCallUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}

export interface VoiceProviderEventUnitOfWorkContext {
  calls: VoiceCallRepository;
  events: VoiceProviderEventRepository;
  configuration: VoiceConfigurationRepository;
  recordings: VoiceRecordingRepository;
}

export interface VoiceProviderEventUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: VoiceProviderEventUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}
