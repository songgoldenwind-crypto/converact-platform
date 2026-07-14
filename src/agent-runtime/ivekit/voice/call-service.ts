import { randomUUID } from 'node:crypto';

import { canonicalVoicePayloadHash, safeVoiceProviderPayload } from './canonical.js';
import { assertVoiceConfigContainsNoSecrets, voiceProfileConfigHash } from './deployment-profile-service.js';
import { VoiceError } from './errors.js';
import { observeVoiceCall, observeVoiceCommand } from './metrics.js';
import type {
  VoiceAddressProtector,
  VoiceCallUnitOfWork,
  VoiceCallUnitOfWorkContext,
  VoiceCallRepository,
  VoiceCompliancePort,
  VoiceConfigurationRepository,
  VoiceEventPort
} from './ports.js';
import { VoiceProviderRegistry } from './provider-registry.js';
import { isVoiceTerminalState, mergeProviderCallState } from './state-machine.js';
import type {
  VoiceAddressKind,
  VoiceBusinessRef,
  VoiceCall,
  VoiceCallCommand,
  VoiceCallState,
  VoiceCapability,
  VoiceCommandKind,
  VoiceListInput,
  VoicePage,
  VoicePolicy,
  VoiceProtectedAddress
} from './types.js';

export interface VoiceCallServiceOptions {
  unit_of_work: VoiceCallUnitOfWork;
  address_protector: VoiceAddressProtector;
  compliance: VoiceCompliancePort;
  event_port: VoiceEventPort;
  id?: (kind: string) => string;
  now?: () => Date;
}

export interface VoiceProviderCallCommandExecutorOptions {
  calls: VoiceCallRepository;
  configuration: VoiceConfigurationRepository;
  address_protector: VoiceAddressProtector;
  provider_registry: VoiceProviderRegistry;
  now?: () => Date;
}

export interface VoiceClearAddressInput {
  kind: VoiceAddressKind;
  value: string;
}

export interface CreateOutboundVoiceCallInput {
  tenant_id: string;
  profile_id: string;
  from: VoiceClearAddressInput;
  to: VoiceClearAddressInput;
  business_ref: VoiceBusinessRef;
  actor: string;
  idempotency_key: string;
  metadata: Record<string, unknown>;
}

export interface CreateInboundVoiceCallInput {
  tenant_id: string;
  profile_id: string;
  provider_call_id: string;
  external_event_id: string;
  from: VoiceClearAddressInput;
  to: VoiceClearAddressInput;
  business_ref: VoiceBusinessRef;
  metadata: Record<string, unknown>;
}

export interface EnqueueVoiceCallActionInput {
  tenant_id: string;
  call_id: string;
  kind: Exclude<VoiceCommandKind, 'originate'>;
  payload: Record<string, unknown>;
  actor: string;
  idempotency_key: string;
}

const REQUEST_HASH_KEY = '_ivekit_request_hash';
const CALL_CONTROL_CAPABILITY: Partial<Record<VoiceCommandKind, VoiceCapability>> = {
  originate: 'rwi',
  answer: 'rwi',
  hangup: 'rwi',
  dtmf: 'rwi',
  hold: 'rwi',
  resume: 'rwi',
  blind_transfer: 'rwi',
  warm_transfer: 'rwi',
  conference: 'rwi',
  park: 'rwi',
  pickup: 'rwi',
  recording_start: 'recording',
  recording_pause: 'recording',
  recording_resume: 'recording',
  recording_stop: 'recording',
  livekit_bridge_create: 'sipflow'
};

export class VoiceCallService {
  readonly #unitOfWork: VoiceCallUnitOfWork;
  readonly #addressProtector: VoiceAddressProtector;
  readonly #compliance: VoiceCompliancePort;
  readonly #eventPort: VoiceEventPort;
  readonly #id: (kind: string) => string;
  readonly #now: () => Date;

  constructor(options: VoiceCallServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#addressProtector = options.address_protector;
    this.#compliance = options.compliance;
    this.#eventPort = options.event_port;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async createOutbound(input: CreateOutboundVoiceCallInput): Promise<{ call: VoiceCall; command: VoiceCallCommand }> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const actor = boundedIdentifier(input.actor);
    const callId = this.#newId('call');
    const from = await this.#protectAddress(tenantId, input.from);
    const to = await this.#protectAddress(tenantId, input.to);
    const requestHash = callRequestHash(input, from, to);
    const compliance = await this.#compliance.authorize({
      tenant_id: tenantId,
      call_id: callId,
      command: 'originate',
      actor_identity: actor,
      business_ref: businessRef(input.business_ref)
    });
    if (!compliance.allowed || !compliance.evidence_ref) throw complianceDenied();
    const now = this.#timestamp();
    const idempotencyKey = boundedIdempotencyKey(input.idempotency_key);
    const result = await this.#unitOfWork.run(tenantId, async (context) => {
      const replay = await context.calls.findByIdempotencyKey(tenantId, idempotencyKey);
      if (replay) {
        assertReplayHash(replay, requestHash);
        const command = await context.commands.findCallByIdempotencyKey(tenantId, originateCommandKey(idempotencyKey));
        if (!command || command.payload_hash !== requestHash) throw idempotencyConflict();
        return { call: replay, command, created: false };
      }
      const policy = await this.#authorizeRuntime(context, tenantId, input.profile_id, 'originate');
      if (policy.require_outbound_consent && !compliance.evidence_ref) throw complianceDenied();
      const call: VoiceCall = {
        id: callId,
        tenant_id: tenantId,
        business_ref: businessRef(input.business_ref),
        provider_profile_id: boundedIdentifier(input.profile_id),
        provider_call_id: '',
        provider_dialog_id: '',
        media_call_id: null,
        direction: 'outbound',
        state: 'planned',
        from: projection(from),
        to: projection(to),
        idempotency_key: idempotencyKey,
        initiated_by: actor,
        metadata: { ...safeMetadata(input.metadata), [REQUEST_HASH_KEY]: requestHash },
        ringing_at: null,
        answered_at: null,
        ended_at: null,
        termination_reason: '',
        revision: 1,
        created_at: now,
        updated_at: now
      };
      const insertedCall = await context.calls.insert(call, from, to);
      const command = await context.commands.insertCall(this.#newCommand({
        tenant_id: tenantId,
        call_id: insertedCall.id,
        kind: 'originate',
        idempotency_key: originateCommandKey(idempotencyKey),
        payload_hash: requestHash,
        payload: { compliance_evidence_ref: boundedText(compliance.evidence_ref, 2_048) }
      }));
      return { call: insertedCall, command, created: true };
    });
    if (result.created) {
      await this.#eventPort.publish(tenantId, 'voice.call.created', {
        call_id: result.call.id,
        direction: result.call.direction,
        business_ref: result.call.business_ref,
        actor
      });
    }
    return { call: publicCall(result.call), command: result.command };
  }

  async createInbound(input: CreateInboundVoiceCallInput): Promise<VoiceCall> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const profileId = boundedIdentifier(input.profile_id);
    const providerCallId = boundedIdentifier(input.provider_call_id);
    const externalEventId = boundedIdentifier(input.external_event_id);
    const from = await this.#protectAddress(tenantId, input.from);
    const to = await this.#protectAddress(tenantId, input.to);
    const requestHash = canonicalVoicePayloadHash({ profile_id: profileId, provider_call_id: providerCallId,
      external_event_id: externalEventId, from_hmac: from.hmac, to_hmac: to.hmac });
    const idempotencyKey = `inbound:${profileId}:${externalEventId}`;
    const now = this.#timestamp();
    const call = await this.#unitOfWork.run(tenantId, async (context) => {
      const replay = await context.calls.findByIdempotencyKey(tenantId, idempotencyKey);
      if (replay) {
        assertReplayHash(replay, requestHash);
        return { call: replay, created: false };
      }
      await this.#authorizeRuntime(context, tenantId, profileId, null);
      const inserted = await context.calls.insert({
        id: this.#newId('call'), tenant_id: tenantId, business_ref: businessRef(input.business_ref),
        provider_profile_id: profileId, provider_call_id: providerCallId, provider_dialog_id: '',
        media_call_id: null, direction: 'inbound', state: 'ringing', from: projection(from), to: projection(to),
        idempotency_key: idempotencyKey, initiated_by: `provider:${profileId}`,
        metadata: { ...safeInboundMetadata(input.metadata), [REQUEST_HASH_KEY]: requestHash },
        ringing_at: now, answered_at: null, ended_at: null, termination_reason: '',
        revision: 1, created_at: now, updated_at: now
      }, from, to);
      return { call: inserted, created: true };
    });
    if (call.created) {
      await this.#eventPort.publish(tenantId, 'voice.call.created', {
        call_id: call.call.id, direction: 'inbound', business_ref: call.call.business_ref
      });
    }
    return publicCall(call.call);
  }

  async enqueueAction(input: EnqueueVoiceCallActionInput): Promise<VoiceCallCommand> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const callId = boundedIdentifier(input.call_id);
    const actor = boundedIdentifier(input.actor);
    const kind = actionKind(input.kind);
    let payload: Record<string, unknown>;
    if (kind === 'blind_transfer' || kind === 'warm_transfer') {
      const target = clearAddressFromTarget(input.payload.target);
      const { target: _target, ...remaining } = plainRecord(input.payload);
      payload = safeActionPayload(remaining);
      const protectedTarget = await this.#protectAddress(tenantId, target);
      payload = { ...payload, target_address: protectedTarget };
    } else if (kind === 'dtmf') {
      payload = { digits: dtmfDigits(input.payload.digits) };
    } else if (kind === 'conference') {
      payload = conferenceActionPayload(input.payload);
    } else if (kind === 'livekit_bridge_create') {
      payload = { sip_trunk_id: boundedIdentifier(input.payload.sip_trunk_id) };
    } else {
      payload = safeActionPayload(input.payload);
    }
    const key = boundedIdempotencyKey(input.idempotency_key);
    const payloadHash = canonicalVoicePayloadHash({ call_id: callId, kind, payload });
    const recordingAction = kind.startsWith('recording_');
    if (recordingAction) {
      const authorized = await this.#compliance.authorize({
        tenant_id: tenantId, call_id: callId, command: kind, actor_identity: actor
      });
      if (!authorized.allowed || !authorized.evidence_ref) throw complianceDenied();
      payload.compliance_evidence_ref = boundedText(authorized.evidence_ref, 2_048);
    }
    const result = await this.#unitOfWork.run(tenantId, async (context) => {
      const existing = await context.commands.findCallByIdempotencyKey(tenantId, key);
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw idempotencyConflict();
        return { command: existing, created: false };
      }
      const call = required(await context.calls.get(tenantId, callId, { for_update: true }));
      validateActionState(call.state, kind);
      const policy = await this.#authorizeRuntime(context, tenantId, call.provider_profile_id, kind);
      if (recordingAction && policy.recording_mode === 'disabled') throw complianceDenied();
      const command = await context.commands.insertCall(this.#newCommand({
        tenant_id: tenantId, call_id: call.id, kind, idempotency_key: key,
        payload_hash: payloadHash, payload
      }));
      return { command, created: true };
    });
    if (result.created) {
      await this.#eventPort.publish(tenantId, 'voice.call.command_created', {
        call_id: callId, command_id: result.command.id, kind, actor
      });
    }
    return result.command;
  }

  async getCall(tenantIdInput: string, callIdInput: string): Promise<VoiceCall> {
    const tenantId = boundedIdentifier(tenantIdInput);
    const call = await this.#unitOfWork.run(tenantId, ({ calls }) => calls.get(tenantId, boundedIdentifier(callIdInput)));
    return publicCall(required(call));
  }

  async listCalls(input: VoiceListInput & {
    state?: VoiceCallState;
    business_ref?: VoiceBusinessRef;
  }): Promise<VoicePage<VoiceCall>> {
    const tenantId = boundedIdentifier(input.tenant_id);
    const page = await this.#unitOfWork.run(tenantId, ({ calls }) => calls.list(input));
    return { ...page, items: page.items.map(publicCall) };
  }

  async #authorizeRuntime(
    context: VoiceCallUnitOfWorkContext,
    tenantId: string,
    profileIdInput: string,
    command: VoiceCommandKind | null
  ): Promise<VoicePolicy> {
    const profileId = boundedIdentifier(profileIdInput);
    const profile = required(await context.configuration.getProfile(tenantId, profileId));
    if (profile.status !== 'enabled' && profile.status !== 'degraded') throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    if (command) {
      const capability = CALL_CONTROL_CAPABILITY[command];
      const snapshot = await context.configuration.getLatestCapabilitySnapshot(tenantId, profileId);
      if (!capability || !snapshot || snapshot.status !== 'ready'
        || snapshot.config_hash !== voiceProfileConfigHash(profile)
        || snapshot.capabilities[capability] !== true) {
        throw new VoiceError({ code: 'capability_unavailable', status: 501, details: { capability } });
      }
    }
    const policy = required(await context.configuration.getPolicy(tenantId));
    if (policy.status !== 'active') throw complianceDenied();
    return policy;
  }

  async #protectAddress(tenantId: string, input: VoiceClearAddressInput): Promise<VoiceProtectedAddress> {
    const kind = addressKind(input.kind);
    const value = normalizedAddress(kind, input.value);
    const protectedAddress = await this.#addressProtector.protect(tenantId, value, kind);
    return { kind, ...protectedAddress };
  }

  #newCommand(input: Pick<VoiceCallCommand,
    'tenant_id' | 'call_id' | 'kind' | 'idempotency_key' | 'payload_hash' | 'payload'>): VoiceCallCommand {
    const now = this.#timestamp();
    return {
      id: this.#newId('call-command'), ...input, state: 'pending', attempt_count: 0, max_attempts: 5,
      next_attempt_at: null, lease_until: null, worker_id: '', provider_command_id: '',
      result: {}, error_code: '', error_message: '', created_at: now, updated_at: now, completed_at: null
    };
  }

  #newId(kind: string): string {
    return boundedIdentifier(this.#id(kind));
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export class VoiceProviderCallCommandExecutor {
  readonly #calls: VoiceCallRepository;
  readonly #configuration: VoiceConfigurationRepository;
  readonly #addressProtector: VoiceAddressProtector;
  readonly #registry: VoiceProviderRegistry;
  readonly #now: () => Date;

  constructor(options: VoiceProviderCallCommandExecutorOptions) {
    this.#calls = options.calls;
    this.#configuration = options.configuration;
    this.#addressProtector = options.address_protector;
    this.#registry = options.provider_registry;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(command: VoiceCallCommand): Promise<{
    provider_command_id: string;
    result: Record<string, unknown>;
  }> {
    const call = required(await this.#calls.get(command.tenant_id, command.call_id));
    if (command.kind === 'originate' && call.provider_call_id) {
      return {
        provider_command_id: command.provider_command_id || call.provider_call_id,
        result: safeVoiceProviderPayload({
          provider_call_id: call.provider_call_id,
          accepted: true,
          replayed: true
        })
      };
    }
    const profile = required(await this.#configuration.getProfile(command.tenant_id, call.provider_profile_id));
    const capability = requiredCapabilityForVoiceCommand(command.kind);
    const snapshot = await this.#configuration.getLatestCapabilitySnapshot(command.tenant_id, profile.id);
    if (!snapshot || snapshot.status !== 'ready' || snapshot.config_hash !== voiceProfileConfigHash(profile)
      || snapshot.capabilities[capability] !== true) {
      throw new VoiceError({ code: 'capability_unavailable', status: 501, details: { capability } });
    }
    let clearAddress: string | undefined;
    if (command.kind === 'originate') {
      const address = required(await this.#calls.getProtectedAddress(command.tenant_id, call.id, 'to'));
      clearAddress = await this.#addressProtector.reveal(command.tenant_id, address.ciphertext, address.kind);
    } else if (command.kind === 'blind_transfer' || command.kind === 'warm_transfer') {
      const address = protectedAddressFromPayload(command.payload.target_address);
      clearAddress = await this.#addressProtector.reveal(command.tenant_id, address.ciphertext, address.kind);
    }
    let adapter: Awaited<ReturnType<VoiceProviderRegistry['create']>> | null = null;
    const startedAt = performance.now();
    try {
      adapter = await this.#registry.create(profile, { purpose: 'execute' });
      const executed = await adapter.execute({ call, command, clear_address: clearAddress });
      if (command.kind === 'originate') {
        if (!executed.provider_call_id) {
          throw providerExecutionUnknown(executed.provider_command_id);
        }
        try {
          await this.#convergeOriginate(call, executed.provider_call_id);
        } catch (error) {
          if (error instanceof VoiceError && error.code === 'protocol_mismatch') throw error;
          throw providerExecutionUnknown(executed.provider_command_id);
        }
      }
      observeVoiceCommand({
        adapter: profile.adapter,
        kind: command.kind,
        result: 'succeeded',
        duration_seconds: (performance.now() - startedAt) / 1_000
      });
      if (command.kind === 'originate') {
        observeVoiceCall({ adapter: profile.adapter, direction: call.direction, state: call.state });
      }
      return {
        provider_command_id: executed.provider_command_id,
        result: safeVoiceProviderPayload({
          provider_call_id: executed.provider_call_id,
          accepted: executed.accepted
        })
      };
    } catch (error) {
      observeVoiceCommand({
        adapter: profile.adapter,
        kind: command.kind,
        result: error instanceof VoiceError && error.code === 'provider_timeout'
          ? 'uncertain'
          : 'failed',
        error_code: error instanceof VoiceError ? error.code : 'provider_unavailable',
        duration_seconds: (performance.now() - startedAt) / 1_000
      });
      throw error;
    } finally {
      clearAddress = undefined;
      await adapter?.close().catch(() => undefined);
    }
  }

  async #convergeOriginate(initial: VoiceCall, providerCallId: string): Promise<void> {
    let current = initial;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (current.provider_call_id && current.provider_call_id !== providerCallId) {
        throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
      }
      const transition = mergeProviderCallState(current.state, 'dialing', {
        ringing_at: current.ringing_at,
        answered_at: current.answered_at,
        ended_at: current.ended_at,
        occurred_at: this.#now().toISOString()
      });
      if (current.provider_call_id === providerCallId && !transition.changed) return;
      try {
        await this.#calls.update({
          ...current,
          provider_call_id: providerCallId,
          state: transition.state,
          ringing_at: transition.ringing_at,
          answered_at: transition.answered_at,
          ended_at: transition.ended_at,
          revision: current.revision + 1,
          updated_at: this.#now().toISOString()
        }, current.revision);
        return;
      } catch (error) {
        if (!(error instanceof VoiceError) || error.code !== 'revision_conflict') throw error;
        current = required(await this.#calls.get(current.tenant_id, current.id));
      }
    }
    throw new VoiceError({ code: 'revision_conflict', retryable: true, status: 409 });
  }
}

function providerExecutionUnknown(providerCommandId: string): VoiceError {
  return new VoiceError({
    code: 'provider_timeout',
    retryable: true,
    status: 504,
    details: providerCommandId ? { provider_command_id: providerCommandId } : {}
  });
}

function callRequestHash(
  input: CreateOutboundVoiceCallInput,
  from: VoiceProtectedAddress,
  to: VoiceProtectedAddress
): string {
  return canonicalVoicePayloadHash({
    profile_id: boundedIdentifier(input.profile_id), business_ref: businessRef(input.business_ref),
    actor: boundedIdentifier(input.actor), from_kind: from.kind, from_hmac: from.hmac,
    to_kind: to.kind, to_hmac: to.hmac, metadata: safeMetadata(input.metadata)
  });
}

function projection(address: VoiceProtectedAddress): VoiceCall['from'] {
  return { kind: address.kind, redacted: address.redacted };
}

function publicCall(call: VoiceCall): VoiceCall {
  const metadata = Object.fromEntries(Object.entries(call.metadata).filter(([key]) => !key.startsWith('_ivekit_')));
  return { ...call, metadata };
}

function assertReplayHash(call: VoiceCall, expected: string): void {
  if (call.metadata[REQUEST_HASH_KEY] !== expected) throw idempotencyConflict();
}

function safeMetadata(value: unknown): Record<string, unknown> {
  const record = plainRecord(value);
  assertVoiceConfigContainsNoSecrets(record);
  canonicalVoicePayloadHash(record);
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > 64 * 1024) throw validationError();
  if (containsAddress(record)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  return { ...record };
}

function safeInboundMetadata(value: unknown): Record<string, unknown> {
  const result = safeMetadata(value);
  for (const key of ['tenant_id', 'tenantId', 'profile_id', 'profileId']) delete result[key];
  return result;
}

function safeActionPayload(value: unknown): Record<string, unknown> {
  return safeMetadata(value);
}

function containsAddress(value: unknown): boolean {
  if (typeof value === 'string') return /^sips?:[^\s@]+@[^\s@]+$/i.test(value.trim())
    || /^\+?[\d\s().-]{7,}$/.test(value.trim());
  if (Array.isArray(value)) return value.some(containsAddress);
  if (isRecord(value)) return Object.values(value).some(containsAddress);
  return false;
}

function clearAddressFromTarget(value: unknown): VoiceClearAddressInput {
  const target = boundedText(value, 1_024);
  if (/^sips?:/i.test(target)) return { kind: 'sip_uri', value: target };
  if (/^\+/.test(target)) return { kind: 'e164', value: target };
  return { kind: 'extension', value: target };
}

function normalizedAddress(kind: VoiceAddressKind, value: unknown): string {
  const input = boundedText(value, 1_024);
  if (kind === 'e164') {
    const normalized = input.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new VoiceError({ code: 'invalid_address', status: 422 });
    return normalized;
  }
  if (kind === 'extension') {
    if (!/^\d{1,20}$/.test(input)) throw new VoiceError({ code: 'invalid_address', status: 422 });
    return input;
  }
  if (!/^sips?:[^\s@]+@[^\s@]+$/i.test(input)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  return input;
}

function addressKind(value: unknown): VoiceAddressKind {
  if (value !== 'e164' && value !== 'extension' && value !== 'sip_uri') throw new VoiceError({ code: 'invalid_address', status: 422 });
  return value;
}

function actionKind(value: unknown): Exclude<VoiceCommandKind, 'originate'> {
  const allowed: Exclude<VoiceCommandKind, 'originate'>[] = [
    'answer', 'hangup', 'dtmf', 'hold', 'resume', 'blind_transfer', 'warm_transfer',
    'conference', 'park', 'pickup', 'recording_start', 'recording_pause',
    'recording_resume', 'recording_stop', 'livekit_bridge_create'
  ];
  if (!allowed.includes(value as Exclude<VoiceCommandKind, 'originate'>)) throw validationError();
  return value as Exclude<VoiceCommandKind, 'originate'>;
}

export function requiredCapabilityForVoiceCommand(command: VoiceCommandKind): VoiceCapability {
  const capability = CALL_CONTROL_CAPABILITY[command];
  if (!capability) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
  return capability;
}

function protectedAddressFromPayload(value: unknown): VoiceProtectedAddress {
  if (!isRecord(value)) throw new VoiceError({ code: 'invalid_address', status: 422 });
  const kind = addressKind(value.kind);
  const ciphertext = boundedText(value.ciphertext, 4_096);
  const hmac = boundedText(value.hmac, 256);
  const redacted = boundedText(value.redacted, 256);
  return { kind, ciphertext, hmac, redacted };
}

function validateActionState(state: VoiceCallState, kind: VoiceCommandKind): void {
  if (isVoiceTerminalState(state)) throw new VoiceError({ code: 'terminal_call_state', status: 409 });
  const allowed: Partial<Record<VoiceCommandKind, VoiceCallState[]>> = {
    answer: ['dialing', 'ringing'],
    hangup: ['planned', 'queued', 'dialing', 'ringing', 'active', 'held', 'transferring'],
    dtmf: ['active'], hold: ['active'], resume: ['held'],
    blind_transfer: ['active', 'held'], warm_transfer: ['active', 'held'],
    conference: ['active', 'held'], park: ['active', 'held'], pickup: ['active', 'held'],
    recording_start: ['active', 'held'], recording_pause: ['active', 'held'],
    recording_resume: ['active', 'held'], recording_stop: ['active', 'held'],
    livekit_bridge_create: ['active', 'held']
  };
  if (!allowed[kind]?.includes(state)) throw new VoiceError({ code: 'invalid_call_transition', status: 409 });
}

function dtmfDigits(value: unknown): string {
  const digits = boundedText(value, 32);
  if (!/^[0-9A-D*#]+$/i.test(digits)) throw validationError();
  return digits.toUpperCase();
}

function conferenceActionPayload(value: unknown): Record<string, unknown> {
  const input = plainRecord(value);
  const operation = input.operation ?? 'add';
  if (typeof operation !== 'string' || !['create', 'add', 'remove', 'destroy'].includes(operation)) {
    throw validationError();
  }
  const conferenceId = boundedIdentifier(input.conference_id);
  const allowed = operation === 'create'
    ? new Set(['operation', 'conference_id', 'backend', 'max_members', 'record'])
    : new Set(['operation', 'conference_id']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw validationError();
  const payload: Record<string, unknown> = { operation, conference_id: conferenceId };
  if (operation !== 'create') return payload;
  if (input.backend !== undefined) {
    if (input.backend !== 'internal' && input.backend !== 'external') throw validationError();
    payload.backend = input.backend;
  }
  if (input.max_members !== undefined) {
    if (!Number.isInteger(input.max_members) || Number(input.max_members) < 2 || Number(input.max_members) > 1_000) {
      throw validationError();
    }
    payload.max_members = input.max_members;
  }
  if (input.record !== undefined) {
    if (typeof input.record !== 'boolean') throw validationError();
    payload.record = input.record;
  }
  return payload;
}

function businessRef(value: unknown): VoiceBusinessRef {
  if (!isRecord(value)) throw validationError();
  return { type: boundedIdentifier(value.type), id: boundedIdentifier(value.id) };
}

function originateCommandKey(callKey: string): string {
  return `call:${callKey}:originate`;
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new VoiceError({ code: 'not_found', status: 404 });
  return value;
}

function boundedIdempotencyKey(value: unknown): string {
  return boundedText(value, 256);
}

function boundedIdentifier(value: unknown): string {
  return boundedText(value, 256);
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') throw validationError();
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw validationError();
  return result;
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw validationError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function idempotencyConflict(): VoiceError {
  return new VoiceError({ code: 'idempotency_conflict', status: 409 });
}

function complianceDenied(): VoiceError {
  return new VoiceError({ code: 'compliance_denied', status: 403 });
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
