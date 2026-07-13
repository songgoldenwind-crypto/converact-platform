import { safeVoiceProviderPayload } from '../canonical.js';
import { VOICE_CAPABILITIES, voiceProfileConfigHash } from '../deployment-profile-service.js';
import { VoiceError } from '../errors.js';
import type {
  VoiceManagementApplyInput,
  VoiceManagementApplyResult,
  VoiceManagementPort,
  VoiceProviderAdapter,
  VoiceProviderFactory
} from '../ports.js';
import type {
  VoiceCall,
  VoiceCallCommand,
  VoiceCapability,
  VoiceDeploymentProfile,
  VoiceNormalizedProviderEvent,
  VoiceProviderCapabilities
} from '../types.js';

export interface ControlledVoiceProviderFactoryOptions {
  now?: () => Date;
}

export class ControlledVoiceProviderFactory implements VoiceProviderFactory {
  readonly #now: () => Date;

  constructor(options: ControlledVoiceProviderFactoryOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async create(profile: VoiceDeploymentProfile): Promise<VoiceProviderAdapter> {
    return new ControlledVoiceProviderAdapter(profile, this.#now);
  }
}

class ControlledVoiceProviderAdapter implements VoiceProviderAdapter {
  readonly management: VoiceManagementPort;
  readonly #outcomes = new Map<string, { provider_command_id: string; provider_call_id: string; accepted: boolean }>();

  constructor(
    private readonly profile: VoiceDeploymentProfile,
    private readonly now: () => Date
  ) {
    this.management = new ControlledVoiceManagement(profile, now, this.#outcomes);
  }

  async preflight(): Promise<VoiceProviderCapabilities> {
    controlledFailure(this.profile.config.controlled_failure);
    const configured = this.profile.config.controlled_capabilities;
    const capabilities = configured && typeof configured === 'object' && !Array.isArray(configured)
      ? Object.fromEntries(VOICE_CAPABILITIES.map((capability) => [
        capability,
        (configured as Record<string, unknown>)[capability] === true
      ])) as Record<VoiceCapability, boolean>
      : Object.fromEntries(VOICE_CAPABILITIES.map((capability) => [capability, true])) as Record<VoiceCapability, boolean>;
    return {
      profile_id: this.profile.id,
      provider: 'controlled',
      provider_version: 'controlled-v1',
      capabilities,
      checked_at: this.now().toISOString(),
      config_hash: voiceProfileConfigHash(this.profile)
    };
  }

  async execute(input: { call: VoiceCall; command: VoiceCallCommand }): Promise<{
    provider_command_id: string;
    provider_call_id?: string;
    accepted: boolean;
  }> {
    const key = `${input.command.tenant_id}:${input.command.idempotency_key}`;
    let outcome = this.#outcomes.get(key);
    if (!outcome) {
      outcome = {
        provider_command_id: `controlled-command:${input.command.id}`,
        provider_call_id: `controlled-call:${input.call.id}`,
        accepted: true
      };
      this.#outcomes.set(key, outcome);
    }
    const mode = String(this.profile.config.controlled_command_mode ?? 'success');
    if (mode === 'timeout_then_succeed') {
      throw new VoiceError({ code: 'provider_timeout', retryable: true, status: 504 });
    }
    if (mode === 'retryable_failure') {
      throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
    }
    if (mode === 'reject') return { ...outcome, accepted: false };
    return outcome;
  }

  async reconcile(input: { call: VoiceCall; command: VoiceCallCommand }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state?: string;
    provider_call_id?: string;
    provider_dialog_id?: string;
  }> {
    const found = this.#outcomes.get(`${input.command.tenant_id}:${input.command.idempotency_key}`);
    if (found) return {
      state: found.accepted ? 'succeeded' : 'failed',
      provider_state: found.accepted ? 'dialing' : 'rejected',
      provider_call_id: found.provider_call_id
    };
    return { state: 'unknown', provider_state: 'not_found' };
  }

  normalizeEvent(input: unknown): VoiceNormalizedProviderEvent {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
    }
    const value = input as Record<string, unknown>;
    const eventType = String(value.type ?? '').trim();
    const providerState = String(value.state ?? '').trim();
    if (!eventType || !providerState) throw new VoiceError({ code: 'protocol_mismatch', status: 422 });
    return {
      external_event_id: String(value.event_id ?? ''),
      event_type: eventType,
      provider_state: providerState,
      occurred_at: typeof value.occurred_at === 'string' ? value.occurred_at : null,
      safe_payload: safeVoiceProviderPayload(value)
    };
  }

  async close(): Promise<void> {}
}

class ControlledVoiceManagement implements VoiceManagementPort {
  constructor(
    private readonly profile: VoiceDeploymentProfile,
    private readonly now: () => Date,
    private readonly outcomes: Map<string, { provider_command_id: string; provider_call_id: string; accepted: boolean }>
  ) {}

  preflight(): Promise<VoiceProviderCapabilities> {
    return new ControlledVoiceProviderAdapter(this.profile, this.now).preflight();
  }

  async applyTrunk(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return applied(input.resource_id);
  }

  async testTrunk(input: { resource_id: string }): Promise<{ ready: boolean; error_code: string; safe_diagnostics: Record<string, unknown> }> {
    return { ready: Boolean(input.resource_id), error_code: '', safe_diagnostics: { mode: 'controlled' } };
  }

  async applyExtension(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return applied(input.resource_id);
  }

  async applyRoute(input: VoiceManagementApplyInput): Promise<VoiceManagementApplyResult> {
    return applied(input.resource_id);
  }

  async lookupDialog(input: { provider_call_id: string }): Promise<{
    state: 'pending' | 'succeeded' | 'failed' | 'unknown';
    provider_state: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    const found = [...this.outcomes.values()].some((outcome) => outcome.provider_call_id === input.provider_call_id);
    return {
      state: found ? 'succeeded' : 'unknown',
      provider_state: found ? 'accepted' : 'not_found',
      safe_diagnostics: { mode: 'controlled' }
    };
  }

  async lookupRecording(input: { provider_recording_id: string }): Promise<{
    state: 'processing' | 'available' | 'failed' | 'unknown';
    object_ref: string;
    safe_diagnostics: Record<string, unknown>;
  }> {
    return {
      state: input.provider_recording_id ? 'available' : 'unknown',
      object_ref: input.provider_recording_id ? `controlled://${input.provider_recording_id}` : '',
      safe_diagnostics: { mode: 'controlled' }
    };
  }
}

function applied(resourceId: string): VoiceManagementApplyResult {
  if (!resourceId) throw new VoiceError({ code: 'validation_failed', status: 422 });
  return {
    provider_ref: `controlled:${resourceId}`,
    provider_revision: 'controlled-v1',
    safe_diagnostics: { mode: 'controlled' }
  };
}

function controlledFailure(value: unknown): void {
  const code = String(value ?? '');
  if (!code) return;
  if (code === 'provider_auth_failed') throw new VoiceError({ code, status: 401 });
  if (code === 'provider_unavailable') throw new VoiceError({ code, retryable: true, status: 503 });
  if (code === 'protocol_mismatch') throw new VoiceError({ code, status: 502 });
  if (code === 'capability_unavailable') throw new VoiceError({ code, status: 501 });
  throw new VoiceError({ code: 'validation_failed', status: 422 });
}
