import { safeVoiceProviderPayload } from '../canonical.js';
import {
  normalizeVoiceActionCapabilities,
  VOICE_CAPABILITY_SCHEMA_VERSION
} from '../capabilities.js';
import { voiceProfileConfigHash } from '../deployment-profile-service.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceManagementPort,
  VoiceProviderAdapter,
  VoiceProviderFactory,
  VoiceProviderOwnerContracts,
  VoiceProviderParkingContext,
  VoiceSecretResolver
} from '../ports.js';
import type {
  VoiceCall,
  VoiceCallCommand,
  VoiceDeploymentProfile,
  VoiceNormalizedProviderEvent,
  VoiceProviderCapabilities
} from '../types.js';
import { RustPbxEventsAdapter } from './rustpbx-events.js';
import {
  DEFAULT_RUSTPBX_MANAGEMENT_PATHS,
  RustPbxManagementClient,
  type RustPbxManagementPaths
} from './rustpbx-management.js';
import {
  RustPbxRwiClient,
  type RustPbxRwiBridgeInput,
  type RustPbxRwiCommandInput,
  type RustPbxRwiCommandResult,
  type RustPbxRwiPreflightResult
} from './rustpbx-rwi.js';

export interface RustPbxRwiPort {
  connect(): Promise<void>;
  preflight(): Promise<RustPbxRwiPreflightResult>;
  execute(input: RustPbxRwiCommandInput): Promise<RustPbxRwiCommandResult>;
  executeBridge(input: RustPbxRwiBridgeInput): Promise<RustPbxRwiCommandResult>;
  close(): Promise<void>;
}

export class RustPbxVoiceProviderAdapter implements VoiceProviderAdapter {
  readonly #profile: VoiceDeploymentProfile;
  readonly #management: VoiceManagementPort;
  readonly #rwi: RustPbxRwiPort | null;
  readonly #events: RustPbxEventsAdapter;

  constructor(input: {
    profile: VoiceDeploymentProfile;
    management: VoiceManagementPort;
    rwi: RustPbxRwiPort | null;
    events?: RustPbxEventsAdapter;
  }) {
    if (input.profile.adapter !== 'rustpbx') throw validationError();
    this.#profile = input.profile;
    this.#management = input.management;
    this.#rwi = input.rwi;
    this.#events = input.events ?? new RustPbxEventsAdapter();
  }

  get management(): VoiceManagementPort {
    return this.#management;
  }

  async preflight(): Promise<VoiceProviderCapabilities> {
    const management = await this.#management.preflight();
    const capabilities = { ...management.capabilities, rwi: false };
    let actionCapabilities = normalizeVoiceActionCapabilities({
      commands: { livekit_bridge_create: management.capabilities.sipflow }
    });
    if (this.#rwi) {
      try {
        await this.#rwi.connect();
        const rwi = await this.#rwi.preflight();
        capabilities.rwi = rwi.ready === true;
        if (rwi.ready) {
          actionCapabilities = rustPbxActionCapabilities(
            rwi, management.capabilities.sipflow
          );
        }
      } catch {
        capabilities.rwi = false;
      }
    }
    return {
      ...management,
      profile_id: this.#profile.id,
      provider: 'rustpbx',
      capabilities,
      capability_schema_version: VOICE_CAPABILITY_SCHEMA_VERSION,
      action_capabilities: actionCapabilities,
      config_hash: voiceProfileConfigHash(this.#profile)
    };
  }

  async execute(input: {
    call: VoiceCall;
    command: VoiceCallCommand;
    clear_address?: string;
    parking?: VoiceProviderParkingContext;
    owner_contracts?: VoiceProviderOwnerContracts;
  }): Promise<{ provider_command_id: string; provider_call_id?: string; accepted: boolean }> {
    if (!this.#rwi) throw capabilityUnavailable();
    await this.#rwi.connect();
    if (input.command.kind === 'park') return this.#park(input);
    if (input.command.kind === 'pickup') return this.#pickup(input);
    const result = await this.#rwi.execute({
      command_id: input.command.id,
      kind: input.command.kind,
      call_id: input.call.provider_call_id || input.call.id,
      payload: providerCommandPayload(input.command, input.clear_address),
      ...(input.owner_contracts
        ? { ivekit_owners: input.owner_contracts }
        : {})
    });
    assertRwiSucceeded(result);
    const safe = safeVoiceProviderPayload(result.result);
    const providerCallId = optionalIdentifier(safe.call_id || safe.provider_call_id);
    return {
      provider_command_id: result.action_id,
      ...(providerCallId ? { provider_call_id: providerCallId } : {}),
      accepted: safe.accepted !== false
    };
  }

  async #park(input: {
    call: VoiceCall;
    command: VoiceCallCommand;
    parking?: { parked_call: VoiceCall };
    owner_contracts?: VoiceProviderOwnerContracts;
  }): Promise<{ provider_command_id: string; accepted: boolean }> {
    const actionId = `${input.command.id}:hold`;
    const result = await this.#rwi!.execute({
      command_id: actionId,
      kind: 'hold',
      call_id: providerCallId(input.parking?.parked_call ?? input.call),
      payload: {},
      ...(input.owner_contracts
        ? { ivekit_owners: input.owner_contracts }
        : {})
    });
    assertRwiSucceeded(result);
    return { provider_command_id: result.action_id, accepted: true };
  }

  async #pickup(input: {
    call: VoiceCall;
    command: VoiceCallCommand;
    parking?: { parked_call: VoiceCall; pickup_call: VoiceCall | null };
    owner_contracts?: VoiceProviderOwnerContracts;
  }): Promise<{ provider_command_id: string; accepted: boolean }> {
    const parkedCall = input.parking?.parked_call;
    const pickupCall = input.parking?.pickup_call ?? input.call;
    if (!parkedCall || !pickupCall) throw validationError();
    const parkedProviderCallId = providerCallId(parkedCall);
    const pickupProviderCallId = providerCallId(pickupCall);
    const unholdId = `${input.command.id}:unhold`;
    const unhold = await this.#rwi!.execute({
      command_id: unholdId,
      kind: 'resume',
      call_id: parkedProviderCallId,
      payload: {},
      ...(input.owner_contracts
        ? { ivekit_owners: input.owner_contracts }
        : {})
    });
    assertRwiSucceeded(unhold);
    const bridgeId = `${input.command.id}:bridge`;
    let bridge: RustPbxRwiCommandResult;
    try {
      bridge = await this.#rwi!.executeBridge({
        command_id: bridgeId,
        leg_a: parkedProviderCallId,
        leg_b: pickupProviderCallId,
        ...(input.owner_contracts
          ? { ivekit_owners: input.owner_contracts }
          : {})
      });
    } catch {
      throw rwiUncertain(bridgeId);
    }
    if (bridge.state === 'succeeded') {
      return { provider_command_id: bridge.action_id, accepted: true };
    }
    if (bridge.state === 'uncertain') assertRwiSucceeded(bridge);
    const rollbackId = `${input.command.id}:rollback-hold`;
    let rollback: RustPbxRwiCommandResult;
    try {
      rollback = await this.#rwi!.execute({
        command_id: rollbackId,
        kind: 'hold',
        call_id: parkedProviderCallId,
        payload: {},
        ...(input.owner_contracts
          ? { ivekit_owners: input.owner_contracts }
          : {})
      });
    } catch {
      throw rwiUncertain(rollbackId);
    }
    if (rollback.state !== 'succeeded') throw rwiUncertain(rollback.action_id);
    throw rwiFailure(bridge.error_code, bridge.action_id);
  }

  async reconcile(input: { call: VoiceCall; command: VoiceCallCommand }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state?: string;
    provider_call_id?: string;
    provider_dialog_id?: string;
  }> {
    // An active dialog proves originate took effect, but cannot prove a timed-out
    // hold, transfer, recording, or hangup command reached its intended state.
    if (input.command.kind !== 'originate') return { state: 'unknown' };
    const lookupId = input.call.provider_call_id || input.call.id;
    if (!lookupId) return { state: 'unknown' };
    const found = await this.#management.lookupDialog({ provider_call_id: lookupId });
    return {
      state: found.state === 'pending' ? 'succeeded' : found.state,
      provider_state: found.provider_state,
      ...(input.call.provider_call_id || found.provider_call_id
        ? { provider_call_id: input.call.provider_call_id || found.provider_call_id }
        : {})
    };
  }

  normalizeEvent(input: unknown): VoiceNormalizedProviderEvent {
    return this.#events.normalize('rwi', input);
  }

  async close(): Promise<void> {
    await this.#rwi?.close();
  }
}

function rustPbxActionCapabilities(
  rwi: RustPbxRwiPreflightResult,
  liveKitBridgeAvailable: boolean
) {
  const commands = new Set(rwi.commands);
  const effective = rwi.effective_capabilities;
  const has = (action: string) => commands.has(action);
  const conference_operations = {
    create: effective.conference.create && has('conference.create'),
    add: effective.conference.add && has('conference.add'),
    remove: effective.conference.remove && has('conference.remove'),
    destroy: effective.conference.destroy && has('conference.destroy')
  };
  return normalizeVoiceActionCapabilities({
    commands: {
      originate: has('call.originate'),
      answer: has('call.answer'),
      hangup: has('call.hangup'),
      dtmf: effective.dtmf_send && has('call.send_dtmf'),
      hold: has('call.hold'),
      resume: has('call.unhold'),
      blind_transfer: has('call.transfer'),
      warm_transfer: has('call.transfer.attended'),
      conference: Object.values(conference_operations).some(Boolean),
      park: has('call.hold'),
      pickup: has('call.unhold') && has('call.bridge'),
      recording_start: has('record.start'),
      recording_pause: has('record.pause'),
      recording_resume: has('record.resume'),
      recording_stop: has('record.stop'),
      livekit_bridge_create: liveKitBridgeAvailable
    },
    conference_operations
  });
}

function assertRwiSucceeded(result: RustPbxRwiCommandResult): asserts result is Extract<
  RustPbxRwiCommandResult, { state: 'succeeded' }
> {
  if (result.state === 'uncertain') throw rwiUncertain(result.action_id);
  if (result.state === 'failed') throw rwiFailure(result.error_code, result.action_id);
}

function rwiUncertain(providerCommandId: string): VoiceError {
  return new VoiceError({
    code: 'provider_timeout', retryable: true, status: 504,
    details: { provider_command_id: providerCommandId }
  });
}

function providerCallId(call: VoiceCall): string {
  return optionalIdentifier(call.provider_call_id) || optionalIdentifier(call.id) || (() => {
    throw validationError();
  })();
}

export class RustPbxVoiceProviderFactory implements VoiceProviderFactory {
  constructor(private readonly options: {
    secret_resolver: VoiceSecretResolver;
    production?: boolean;
    management_factory?: (profile: VoiceDeploymentProfile) => VoiceManagementPort;
    rwi_factory?: (profile: VoiceDeploymentProfile) => RustPbxRwiPort | null;
  }) {}

  async create(profile: VoiceDeploymentProfile): Promise<VoiceProviderAdapter> {
    if (profile.adapter !== 'rustpbx') throw validationError();
    return new RustPbxVoiceProviderAdapter({
      profile,
      management: this.options.management_factory?.(profile) ?? this.#management(profile),
      rwi: this.options.rwi_factory?.(profile) ?? this.#rwi(profile)
    });
  }

  #management(profile: VoiceDeploymentProfile): VoiceManagementPort {
    const config = record(profile.config);
    return new RustPbxManagementClient({
      base_url: profile.base_url,
      profile_id: profile.id,
      config_hash: voiceProfileConfigHash(profile),
      service_token_ref: secretRef(profile.secret_refs.management_service_token),
      secret_resolver: this.options.secret_resolver,
      paths: managementPaths(config.management_paths),
      internal_service: optionalBoolean(config.internal_service, false),
      production: this.options.production === true,
      timeout_ms: optionalInteger(config.management_timeout_ms),
      max_response_bytes: optionalInteger(config.management_max_response_bytes)
    });
  }

  #rwi(profile: VoiceDeploymentProfile): RustPbxRwiPort | null {
    const config = record(profile.config);
    const url = optionalString(config.rwi_url, 2_048);
    if (!url) return null;
    return new RustPbxRwiClient({
      url,
      token_ref: secretRef(profile.secret_refs.rwi_token),
      secret_resolver: this.options.secret_resolver,
      contexts: optionalStringArray(config.rwi_contexts),
      production: this.options.production === true,
      internal_service: optionalBoolean(config.internal_service, false),
      connect_timeout_ms: optionalInteger(config.rwi_connect_timeout_ms),
      command_timeout_ms: optionalInteger(config.rwi_command_timeout_ms),
      heartbeat_timeout_ms: optionalInteger(config.rwi_heartbeat_timeout_ms),
      max_message_bytes: optionalInteger(config.rwi_max_message_bytes)
    });
  }
}

function providerCommandPayload(command: VoiceCallCommand, clearAddress: string | undefined): Record<string, unknown> {
  const payload = Object.fromEntries(Object.entries(command.payload).filter(([key]) =>
    key !== 'target_address' && key !== 'compliance_evidence_ref'
  ));
  if (command.kind === 'originate') {
    payload.destination = requiredClearAddress(clearAddress);
  } else if (command.kind === 'blind_transfer' || command.kind === 'warm_transfer') {
    payload.target = requiredClearAddress(clearAddress);
  }
  return payload;
}

function managementPaths(value: unknown): RustPbxManagementPaths {
  if (value === undefined || value === null) return { ...DEFAULT_RUSTPBX_MANAGEMENT_PATHS };
  const input = record(value);
  const output = { ...DEFAULT_RUSTPBX_MANAGEMENT_PATHS };
  for (const key of Object.keys(output) as Array<keyof RustPbxManagementPaths>) {
    if (input[key] !== undefined) output[key] = requiredString(input[key], 2_048);
  }
  if (Object.keys(input).some((key) => !(key in output))) throw validationError();
  return output;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  return value as Record<string, unknown>;
}

function secretRef(value: unknown): string {
  return requiredString(value, 512);
}

function requiredClearAddress(value: unknown): string {
  return requiredString(value, 1_024);
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string') throw validationError();
  const output = value.trim();
  if (!output || output.length > max || /[\u0000-\u001f\u007f]/.test(output)) throw validationError();
  return output;
}

function optionalString(value: unknown, max: number): string {
  return value === undefined || value === null || value === '' ? '' : requiredString(value, max);
}

function optionalIdentifier(value: unknown): string {
  return optionalString(value, 256);
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) throw validationError();
  return Number(value);
}

function optionalStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 32) throw validationError();
  return value.map((item) => requiredString(item, 128));
}

function capabilityUnavailable(): VoiceError {
  return new VoiceError({ code: 'capability_unavailable', status: 501 });
}

function rwiFailure(errorCode: string, actionId: string): VoiceError {
  const details = { provider_command_id: actionId };
  if (errorCode === 'provider_call_not_found') {
    return new VoiceError({ code: 'not_found', status: 404, details });
  }
  if (errorCode === 'invalid_call_transition') {
    return new VoiceError({ code: 'invalid_call_transition', status: 409, details });
  }
  if (errorCode === 'capability_unavailable') {
    return new VoiceError({ code: 'capability_unavailable', status: 501, details });
  }
  if (errorCode === 'provider_auth_failed') {
    return new VoiceError({ code: 'provider_auth_failed', status: 403, details });
  }
  if (errorCode === 'call_control_conflict') {
    return new VoiceError({ code: 'revision_conflict', status: 409, details });
  }
  if (errorCode === 'provider_timeout') {
    return new VoiceError({ code: 'provider_timeout', retryable: true, status: 504, details });
  }
  return new VoiceError({ code: 'provider_unavailable', status: 502, details });
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
