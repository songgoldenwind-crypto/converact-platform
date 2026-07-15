import type {
  RustPbxRwiCommandResult,
  RustPbxRwiPreflightResult,
  RustPbxRwiSupervisorActionInput
} from '../voice/adapters/rustpbx-rwi.js';
import { VoiceError } from '../voice/errors.js';
import { ContactCenterError } from './errors.js';
import type { ContactCenterSupervisorControlPort } from './ports.js';
import type { ContactCenterSupervisorMode } from './types.js';

export interface RustPbxSupervisorCallBinding {
  supervisor_call_id: string;
  target_call_id: string;
  agent_leg?: string;
}

export interface RustPbxSupervisorCallBindingResolver {
  resolve(input: {
    tenant_id: string;
    call_id: string;
    target_agent_id: string;
    supervisor_identity: string;
    mode: ContactCenterSupervisorMode;
  }): Promise<RustPbxSupervisorCallBinding>;
}

export interface RustPbxSupervisorRwiPort {
  executeSupervisor(input: RustPbxRwiSupervisorActionInput): Promise<RustPbxRwiCommandResult>;
}

export interface RustPbxRwiSupervisorControlOptions {
  preflight: RustPbxRwiPreflightResult;
  bindings: RustPbxSupervisorCallBindingResolver;
  rwi: RustPbxSupervisorRwiPort;
}

export class RustPbxRwiSupervisorControl implements ContactCenterSupervisorControlPort {
  readonly #preflight: RustPbxRwiPreflightResult;
  readonly #bindings: RustPbxSupervisorCallBindingResolver;
  readonly #rwi: RustPbxSupervisorRwiPort;

  constructor(options: RustPbxRwiSupervisorControlOptions) {
    this.#preflight = options.preflight;
    this.#bindings = options.bindings;
    this.#rwi = options.rwi;
  }

  supports(mode: ContactCenterSupervisorMode): boolean {
    if (!this.#preflight.ready || !this.#preflight.commands.includes('supervisor.stop')) return false;
    const action = providerMode(mode);
    return this.#preflight.commands.includes(`supervisor.${action}`)
      && this.#preflight.effective_capabilities.supervisor[action] === true;
  }

  async start(input: {
    session_id: string;
    tenant_id: string;
    call_id: string;
    target_agent_id: string;
    supervisor_identity: string;
    mode: ContactCenterSupervisorMode;
    authorization_ref: string;
  }): Promise<{ provider_session_id: string }> {
    if (!this.supports(input.mode)) throw unavailable(input.mode);
    const binding = await this.#resolve(input);
    const mode = providerMode(input.mode);
    const result = await this.#rwi.executeSupervisor({
      action_id: identifier(input.session_id),
      mode,
      supervisor_call_id: binding.supervisor_call_id,
      target_call_id: binding.target_call_id,
      ...((mode === 'whisper' || mode === 'barge') && binding.agent_leg
        ? { agent_leg: binding.agent_leg }
        : {})
    });
    return { provider_session_id: completedActionId(result) };
  }

  async end(input: {
    tenant_id: string;
    session_id: string;
    call_id: string;
    target_agent_id: string;
    supervisor_identity: string;
    mode: ContactCenterSupervisorMode;
    provider_session_id: string;
    idempotency_key: string;
  }): Promise<void> {
    if (!this.supports(input.mode)) throw unavailable(input.mode);
    if (identifier(input.provider_session_id) !== identifier(input.session_id)) {
      throw new VoiceError({ code: 'protocol_mismatch', status: 502 });
    }
    const binding = await this.#resolve(input);
    const result = await this.#rwi.executeSupervisor({
      action_id: identifier(input.idempotency_key),
      mode: 'stop',
      supervisor_call_id: binding.supervisor_call_id,
      target_call_id: binding.target_call_id
    });
    completedActionId(result);
  }

  async #resolve(input: {
    tenant_id: string;
    call_id: string;
    target_agent_id: string;
    supervisor_identity: string;
    mode: ContactCenterSupervisorMode;
  }): Promise<RustPbxSupervisorCallBinding> {
    const binding = await this.#bindings.resolve({
      tenant_id: identifier(input.tenant_id),
      call_id: identifier(input.call_id),
      target_agent_id: identifier(input.target_agent_id),
      supervisor_identity: identifier(input.supervisor_identity),
      mode: input.mode
    });
    return {
      supervisor_call_id: identifier(binding.supervisor_call_id),
      target_call_id: identifier(binding.target_call_id),
      ...(binding.agent_leg ? { agent_leg: identifier(binding.agent_leg) } : {})
    };
  }
}

function providerMode(mode: ContactCenterSupervisorMode): 'listen' | 'whisper' | 'barge' {
  if (mode === 'monitor') return 'listen';
  if (mode === 'whisper' || mode === 'barge') return mode;
  throw unavailable(mode);
}

function completedActionId(result: RustPbxRwiCommandResult): string {
  if (result.state === 'succeeded') return identifier(result.action_id);
  if (result.state === 'uncertain') {
    throw new VoiceError({
      code: result.error_code === 'provider_timeout' ? 'provider_timeout' : 'provider_unavailable',
      status: result.error_code === 'provider_timeout' ? 504 : 503,
      retryable: true
    });
  }
  switch (result.error_code) {
    case 'capability_unavailable':
      throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    case 'provider_auth_failed':
      throw new VoiceError({ code: 'provider_auth_failed', status: 401 });
    case 'provider_timeout':
      throw new VoiceError({ code: 'provider_timeout', status: 504, retryable: true });
    case 'provider_call_not_found':
      throw new VoiceError({ code: 'not_found', status: 404 });
    case 'invalid_call_transition':
    case 'call_control_conflict':
      throw new VoiceError({ code: 'invalid_call_transition', status: 409 });
    default:
      throw new VoiceError({ code: 'provider_unavailable', status: 502 });
  }
}

function unavailable(mode: string): ContactCenterError {
  return new ContactCenterError({
    code: 'capability_unavailable', status: 501,
    details: { capability: `contact_center.supervisor.${mode}` }
  });
}

function identifier(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return output;
}
