import { safeVoiceProviderPayload } from '../canonical.js';
import { voiceProfileConfigHash } from '../deployment-profile-service.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceManagementPort,
  VoiceProviderAdapter,
  VoiceProviderFactory,
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
  RustPbxManagementClient,
  type RustPbxManagementPaths
} from './rustpbx-management.js';
import {
  RustPbxRwiClient,
  type RustPbxRwiCommandInput,
  type RustPbxRwiCommandResult,
  type RustPbxRwiPreflightResult
} from './rustpbx-rwi.js';

export interface RustPbxRwiPort {
  connect(): Promise<void>;
  preflight(): Promise<RustPbxRwiPreflightResult>;
  execute(input: RustPbxRwiCommandInput): Promise<RustPbxRwiCommandResult>;
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
    if (this.#rwi) {
      try {
        await this.#rwi.connect();
        const rwi = await this.#rwi.preflight();
        capabilities.rwi = rwi.ready === true;
      } catch {
        capabilities.rwi = false;
      }
    }
    return {
      ...management,
      profile_id: this.#profile.id,
      provider: 'rustpbx',
      capabilities,
      config_hash: voiceProfileConfigHash(this.#profile)
    };
  }

  async execute(input: {
    call: VoiceCall;
    command: VoiceCallCommand;
    clear_address?: string;
  }): Promise<{ provider_command_id: string; provider_call_id?: string; accepted: boolean }> {
    if (!this.#rwi) throw capabilityUnavailable();
    await this.#rwi.connect();
    const result = await this.#rwi.execute({
      command_id: input.command.id,
      kind: input.command.kind,
      call_id: input.call.provider_call_id || input.call.id,
      payload: providerCommandPayload(input.command, input.clear_address)
    });
    if (result.state === 'uncertain') {
      throw new VoiceError({
        code: 'provider_timeout', retryable: true, status: 504,
        details: { provider_command_id: result.action_id }
      });
    }
    if (result.state === 'failed') {
      throw new VoiceError({
        code: 'provider_unavailable', retryable: false, status: 502,
        details: { provider_command_id: result.action_id }
      });
    }
    const safe = safeVoiceProviderPayload(result.result);
    const providerCallId = optionalIdentifier(safe.call_id || safe.provider_call_id);
    return {
      provider_command_id: result.action_id,
      ...(providerCallId ? { provider_call_id: providerCallId } : {}),
      accepted: safe.accepted !== false
    };
  }

  async reconcile(input: { call: VoiceCall; command: VoiceCallCommand }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state?: string;
    provider_call_id?: string;
    provider_dialog_id?: string;
  }> {
    const lookupId = input.call.provider_call_id || input.command.provider_command_id;
    if (!lookupId) return { state: 'unknown' };
    const found = await this.#management.lookupDialog({ provider_call_id: lookupId });
    return {
      state: found.state,
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

const DEFAULT_MANAGEMENT_PATHS: RustPbxManagementPaths = {
  health: '/health',
  version: '/version',
  ami_health: '/ami/v1/health',
  ami_dialog: '/ami/v1/dialogs/{id}',
  ami_sipflow: '/ami/v1/sipflow/{id}',
  trunk_apply: '/management/trunks/{id}',
  trunk_test: '/management/trunks/{id}/test',
  did_apply: '/management/dids/{id}',
  extension_apply: '/management/extensions/{id}',
  route_evaluate: '/management/routes/{id}',
  route_reload: '/management/routes/reload',
  recording_lookup: '/management/recordings/{id}'
};

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
  if (value === undefined || value === null) return { ...DEFAULT_MANAGEMENT_PATHS };
  const input = record(value);
  const output = { ...DEFAULT_MANAGEMENT_PATHS };
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

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
