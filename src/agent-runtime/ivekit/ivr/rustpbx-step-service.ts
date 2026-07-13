import {
  RustPbxStepIvrAdapter,
  type RustPbxStepIvrActionNode,
  type RustPbxStepIvrEvent
} from './adapters/rustpbx-step-ivr.js';
import { IvrError } from './errors.js';
import type { IvrExecutionEvent } from './executor.js';
import {
  isIvrWorkerAction,
  providerReplayAction,
  providerReplayOperation,
  type AcknowledgeIvrProviderPollInput,
  type AdvanceIvrSessionInput,
  type CancelIvrSessionInput,
  type IvrSessionResult,
  type StartIvrSessionInput
} from './session-service.js';
import type { IvrSession } from './types.js';

export interface RustPbxStepIvrBinding {
  call_id: string;
  flow_id: string;
  flow_version?: number;
  variables?: Record<string, unknown>;
  trace_id?: string;
}

export interface RustPbxStepIvrBindingResolver {
  resolve(input: {
    tenant_id: string;
    profile_id: string;
    provider_session_id: string;
    safe_metadata: Record<string, unknown>;
  }): Promise<RustPbxStepIvrBinding | null>;
}

export interface RustPbxStepIvrSessionPort {
  startSession(input: StartIvrSessionInput): Promise<IvrSessionResult>;
  advance(input: AdvanceIvrSessionInput): Promise<IvrSessionResult>;
  acknowledgeProviderPoll(input: AcknowledgeIvrProviderPollInput): Promise<IvrSessionResult>;
  cancelSession(input: CancelIvrSessionInput): Promise<IvrSessionResult>;
  findProviderSession(input: {
    tenant_id: string;
    profile_id: string;
    provider_session_id: string;
  }): Promise<IvrSession | null>;
}

export interface RustPbxStepIvrServiceOptions {
  sessions: RustPbxStepIvrSessionPort;
  bindings: RustPbxStepIvrBindingResolver;
  worker_poll_interval_ms?: number;
}

export interface RustPbxStepIvrHandleInput {
  tenant_id: string;
  profile_id: string;
  request: unknown;
}

export interface RustPbxStepIvrHandleResult {
  action_node: RustPbxStepIvrActionNode;
  session_id: string;
  session_state: IvrSession['state'];
  replayed: boolean;
  event_sequence: number;
  action_revision: number;
}

export class RustPbxStepIvrService {
  readonly #sessions: RustPbxStepIvrSessionPort;
  readonly #bindings: RustPbxStepIvrBindingResolver;
  readonly #workerPollIntervalMs: number;

  constructor(options: RustPbxStepIvrServiceOptions) {
    this.#sessions = options.sessions;
    this.#bindings = options.bindings;
    this.#workerPollIntervalMs = boundedInteger(
      options.worker_poll_interval_ms, 500, 50, 30_000
    );
  }

  async handle(input: RustPbxStepIvrHandleInput): Promise<RustPbxStepIvrHandleResult> {
    const adapter = new RustPbxStepIvrAdapter({ profile_id: input.profile_id });
    const identity = adapter.readIdentity(input.request);
    let session = await this.#sessions.findProviderSession({
      tenant_id: input.tenant_id,
      profile_id: identity.profile_id,
      provider_session_id: identity.provider_session_id
    });
    const normalized = adapter.normalizeRequest(input.request, {
      last_event_sequence: session?.last_event_sequence ?? 0,
      last_action_revision: session?.last_action_revision ?? 0
    });

    if (!session) {
      if (normalized.disposition !== 'advance' || normalized.event.type !== 'session_start') {
        throw new IvrError({ code: 'invalid_session_state', status: 409 });
      }
      const binding = await this.#bindings.resolve({
        tenant_id: input.tenant_id,
        profile_id: normalized.profile_id,
        provider_session_id: normalized.provider_session_id,
        safe_metadata: normalized.safe_metadata
      });
      if (!binding) throw new IvrError({ code: 'not_found', status: 404 });
      const started = await this.#sessions.startSession({
        tenant_id: input.tenant_id,
        call_id: binding.call_id,
        flow_id: binding.flow_id,
        flow_version: binding.flow_version,
        provider_profile_id: normalized.profile_id,
        provider_session_id: normalized.provider_session_id,
        variables: binding.variables,
        trace_id: binding.trace_id
      });
      session = started.session;
    }

    const result = await this.#exchange(session, normalized);
    return {
      action_node: stepAction(adapter, result.action, this.#workerPollIntervalMs),
      session_id: result.session.id,
      session_state: result.session.state,
      replayed: result.replayed,
      event_sequence: normalized.event_sequence,
      action_revision: normalized.action_revision
    };
  }

  async #exchange(
    session: IvrSession,
    request: ReturnType<RustPbxStepIvrAdapter['normalizeRequest']>
  ): Promise<IvrSessionResult> {
    const common = {
      tenant_id: session.tenant_id,
      session_id: session.id,
      event_sequence: request.event_sequence,
      action_revision: request.action_revision
    };
    if (request.disposition === 'replay') {
      const operation = providerReplayOperation(session);
      if (operation === 'poll') {
        return this.#sessions.acknowledgeProviderPoll({
          ...common, event: providerPollEvent(request.event)
        });
      }
      if (operation === 'cancel') {
        return this.#sessions.cancelSession({
          ...common, reason: cancellationReason(request.event)
        });
      }
      return this.#sessions.advance({ ...common, event: executionEvent(request.event) });
    }

    if (request.event.type === 'session_start') {
      if (session.last_event_sequence !== 0) {
        throw new IvrError({ code: 'invalid_session_state', status: 409 });
      }
      return this.#sessions.advance({ ...common, event: { type: 'enter' } });
    }

    const previousResponse = providerReplayAction(session);
    if (request.event.type === 'hangup' && previousResponse?.kind !== 'hangup') {
      return this.#sessions.cancelSession({
        ...common, reason: cancellationReason(request.event)
      });
    }
    if (previousResponse && isIvrWorkerAction(previousResponse)) {
      if (request.event.type !== 'audio_complete') {
        throw new IvrError({ code: 'invalid_session_state', status: 409 });
      }
      return this.#sessions.acknowledgeProviderPoll({
        ...common, event: providerPollEvent(request.event)
      });
    }
    return this.#sessions.advance({ ...common, event: executionEvent(request.event) });
  }
}

function stepAction(
  adapter: RustPbxStepIvrAdapter,
  action: IvrSessionResult['action'],
  workerPollIntervalMs: number
): RustPbxStepIvrActionNode {
  if (!action) return { type: 'hangup' };
  if (isIvrWorkerAction(action)) {
    return { type: 'wait', duration_ms: workerPollIntervalMs, reason: 'ivekit_worker' };
  }
  return adapter.mapAction(action);
}

function executionEvent(event: RustPbxStepIvrEvent): IvrExecutionEvent {
  switch (event.type) {
    case 'session_start': return { type: 'enter' };
    case 'dtmf': return { type: 'dtmf', digit: event.digit! };
    case 'dtmf_menu_invalid': return { type: 'dtmf', digit: event.digit ?? '' };
    case 'dtmf_timeout':
    case 'dtmf_menu_timeout': return { type: 'timeout' };
    case 'error': return { type: 'action_failed', error_code: providerErrorCode(event.reason) };
    case 'queue_update':
      return { type: 'action_succeeded', result: { status: event.reason ?? 'ok' } };
    case 'audio_complete':
    case 'recording_complete':
    case 'transfer_complete':
    case 'hangup': return { type: 'action_succeeded', result: {} };
    default: throw new IvrError({ code: 'validation_failed', status: 422 });
  }
}

function providerPollEvent(event: RustPbxStepIvrEvent): Record<string, unknown> {
  return { type: 'provider_wait_complete', provider_event_type: event.type };
}

function cancellationReason(event: RustPbxStepIvrEvent): string {
  return providerErrorCode(event.reason ?? 'caller_hangup');
}

function providerErrorCode(value: unknown): string {
  if (typeof value !== 'string') return 'provider_error';
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 128);
  return normalized || 'provider_error';
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const output = value === undefined ? fallback : value;
  if (!Number.isInteger(output) || output < min || output > max) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return output;
}
