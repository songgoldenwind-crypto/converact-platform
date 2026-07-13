import { IvrError } from './errors.js';
import type { IvrExecutionEvent } from './executor.js';
import type {
  IvrFlowRepository,
  IvrPendingActionRepository,
  IvrSessionRepository,
  IvrSessionStepRepository,
  IvrSessionUnitOfWork
} from './ports.js';
import { IvrSessionService } from './session-service.js';
import type { IvrAction, IvrPendingAction, IvrSession, IvrSessionStep } from './types.js';

type IvrSimulationEvent = Exclude<IvrExecutionEvent, { type: 'enter' }>;

export interface IvrSimulationScriptEntry {
  expected_action_kind?: IvrAction['kind'];
  expected_node_id?: string;
  delay_ms?: number;
  event: IvrSimulationEvent;
}

export interface IvrSimulationInput {
  tenant_id: string;
  flow_id: string;
  flow_version?: number;
  variables?: Record<string, unknown>;
  started_at?: string;
  script?: IvrSimulationScriptEntry[];
  max_actions?: number;
  max_steps?: number;
}

export interface IvrSimulationTraceEntry {
  index: number;
  action_at: string;
  event_at: string;
  action: IvrAction;
  event: IvrSimulationEvent;
  resulting_state: IvrSession['state'];
  resulting_node_id: string;
  resulting_step_count: number;
}

export interface IvrSimulationResult {
  status: 'completed' | 'failed' | 'waiting_for_script';
  session: IvrSession;
  action: IvrAction | null;
  steps: IvrSessionStep[];
  trace: IvrSimulationTraceEntry[];
  elapsed_ms: number;
  remaining_script_entries: number;
}

export interface IvrSimulationServiceOptions {
  flows: IvrFlowRepository;
  default_started_at?: string;
  max_script_bytes?: number;
}

export class IvrSimulationService {
  readonly #flows: IvrFlowRepository;
  readonly #defaultStartedAt: string;
  readonly #maxScriptBytes: number;

  constructor(options: IvrSimulationServiceOptions) {
    this.#flows = options.flows;
    this.#defaultStartedAt = normalizedTimestamp(
      options.default_started_at ?? '2000-01-01T00:00:00.000Z'
    );
    this.#maxScriptBytes = boundedInteger(options.max_script_bytes, 1_048_576, 1_024, 8_388_608);
  }

  async simulate(input: IvrSimulationInput): Promise<IvrSimulationResult> {
    const maxActions = boundedInteger(input.max_actions, 500, 1, 1_000);
    const maxSteps = boundedInteger(input.max_steps, 1_000, 1, 10_000);
    const script = safeScript(input.script ?? [], maxActions, this.#maxScriptBytes);
    const clock = new IvrVirtualClock(input.started_at ?? this.#defaultStartedAt);
    const sessions = new SimulationSessionRepository();
    const steps = new SimulationStepRepository();
    const actions = new SimulationActionRepository();
    const unitOfWork: IvrSessionUnitOfWork = {
      run: async (_tenantId, operation) => operation({
        flows: this.#flows, sessions, steps, actions
      })
    };
    let id = 0;
    const runtime = new IvrSessionService({
      unit_of_work: unitOfWork,
      id: (kind) => `simulation-${kind}-${++id}`,
      now: () => clock.now(),
      max_steps: maxSteps
    });
    const started = await runtime.startSession({
      tenant_id: input.tenant_id,
      call_id: 'simulation-call',
      flow_id: input.flow_id,
      flow_version: optionalVersion(input.flow_version),
      variables: safeVariables(input.variables)
    });
    let result = await runtime.advance({
      tenant_id: input.tenant_id,
      session_id: started.session.id,
      event_sequence: 1,
      action_revision: 1,
      event: { type: 'enter' }
    });
    let sequence = 1;
    let scriptIndex = 0;
    const trace: IvrSimulationTraceEntry[] = [];

    while (result.action && scriptIndex < script.length) {
      if (trace.length >= maxActions) throw simulationLimit();
      const entry = script[scriptIndex]!;
      assertExpectedAction(entry, result.action, scriptIndex);
      const exchangedAction = structuredClone(result.action);
      const actionAt = clock.timestamp();
      clock.advance(entry.delay_ms ?? 0);
      sequence += 1;
      result = await runtime.advance({
        tenant_id: input.tenant_id,
        session_id: started.session.id,
        event_sequence: sequence,
        action_revision: sequence,
        event: structuredClone(entry.event)
      });
      trace.push({
        index: scriptIndex,
        action_at: actionAt,
        event_at: clock.timestamp(),
        action: exchangedAction,
        event: structuredClone(entry.event),
        resulting_state: result.session.state,
        resulting_node_id: result.session.current_node_id,
        resulting_step_count: result.session.step_count
      });
      scriptIndex += 1;
    }

    return {
      status: result.session.state === 'completed' ? 'completed'
        : result.session.state === 'failed' ? 'failed' : 'waiting_for_script',
      session: structuredClone(result.session),
      action: result.action ? structuredClone(result.action) : null,
      steps: await steps.list(input.tenant_id, result.session.id),
      trace,
      elapsed_ms: clock.elapsedMs,
      remaining_script_entries: script.length - scriptIndex
    };
  }
}

export class IvrVirtualClock {
  readonly #startedAtMs: number;
  #currentMs: number;

  constructor(startedAt: string) {
    this.#startedAtMs = Date.parse(normalizedTimestamp(startedAt));
    this.#currentMs = this.#startedAtMs;
  }

  get elapsedMs(): number { return this.#currentMs - this.#startedAtMs; }
  now(): Date { return new Date(this.#currentMs); }
  timestamp(): string { return this.now().toISOString(); }

  advance(delayMs: number): void {
    const value = boundedInteger(delayMs, 0, 0, 86_400_000);
    this.#currentMs += value;
  }
}

class SimulationSessionRepository implements IvrSessionRepository {
  readonly items: IvrSession[] = [];

  async get(tenantId: string, sessionId: string): Promise<IvrSession | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.id === sessionId) ?? null);
  }

  async findByProviderBinding(
    tenantId: string,
    profileId: string,
    providerSessionId: string
  ): Promise<IvrSession | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId
      && item.provider_profile_id === profileId && item.provider_session_id === providerSessionId) ?? null);
  }

  async insert(session: IvrSession): Promise<IvrSession> {
    this.items.push(clone(session));
    return clone(session);
  }

  async update(session: IvrSession, expectedRevision: number): Promise<IvrSession> {
    const index = this.items.findIndex((item) => item.id === session.id && item.revision === expectedRevision);
    if (index < 0) throw new IvrError({ code: 'revision_conflict', status: 409 });
    this.items[index] = clone(session);
    return clone(session);
  }
}

class SimulationStepRepository implements IvrSessionStepRepository {
  readonly items: IvrSessionStep[] = [];

  async append(step: IvrSessionStep): Promise<void> { this.items.push(clone(step)); }

  async list(tenantId: string, sessionId: string): Promise<IvrSessionStep[]> {
    return clone(this.items.filter((item) => item.tenant_id === tenantId && item.session_id === sessionId));
  }
}

class SimulationActionRepository implements IvrPendingActionRepository {
  readonly items: IvrPendingAction[] = [];

  async claimDue(): Promise<IvrPendingAction[]> { return []; }
  async claimUncertain(): Promise<IvrPendingAction[]> { return []; }

  async get(tenantId: string, actionId: string): Promise<IvrPendingAction | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.id === actionId) ?? null);
  }

  async findOpenForSession(tenantId: string, sessionId: string): Promise<IvrPendingAction | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.session_id === sessionId
      && ['pending', 'processing', 'retry_wait', 'uncertain'].includes(item.state)) ?? null);
  }

  async insert(action: IvrPendingAction): Promise<IvrPendingAction> {
    this.items.push(clone(action));
    return clone(action);
  }

  async settle(input: {
    tenant_id: string;
    action_id: string;
    worker_id?: string;
    state: 'succeeded' | 'failed' | 'cancelled';
    result: Record<string, unknown>;
    error_code: string;
    completed_at: string;
  }): Promise<IvrPendingAction> {
    const item = this.items.find((candidate) => candidate.tenant_id === input.tenant_id
      && candidate.id === input.action_id);
    if (!item) throw new IvrError({ code: 'not_found', status: 404 });
    Object.assign(item, input, { updated_at: input.completed_at, worker_id: '' });
    return clone(item);
  }

  async release(): Promise<IvrPendingAction> {
    throw new IvrError({ code: 'invalid_session_state', status: 409 });
  }
}

function assertExpectedAction(entry: IvrSimulationScriptEntry, action: IvrAction, index: number): void {
  if ((entry.expected_action_kind && entry.expected_action_kind !== action.kind)
    || (entry.expected_node_id && entry.expected_node_id !== action.node_id)) {
    throw new IvrError({
      code: 'simulation_script_mismatch', status: 422,
      details: { index, actual_action_kind: action.kind, actual_node_id: action.node_id }
    });
  }
}

function safeScript(
  value: IvrSimulationScriptEntry[],
  maxActions: number,
  maxBytes: number
): IvrSimulationScriptEntry[] {
  if (!Array.isArray(value) || value.length > maxActions) throw simulationLimit();
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw validationError(); }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw simulationLimit();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !validSimulationEvent(entry.event)) {
      throw validationError();
    }
    boundedInteger(entry.delay_ms, 0, 0, 86_400_000);
  }
  return clone(value);
}

function validSimulationEvent(value: unknown): value is IvrSimulationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.type === 'timeout') return true;
  if (event.type === 'dtmf') return typeof event.digit === 'string' && event.digit.length <= 64;
  if (event.type === 'selection') return typeof event.value === 'string' && event.value.length <= 256;
  if (event.type === 'action_failed') {
    return typeof event.error_code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(event.error_code);
  }
  return event.type === 'action_succeeded' && Boolean(event.result)
    && typeof event.result === 'object' && !Array.isArray(event.result);
}

function safeVariables(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  return clone(value);
}

function optionalVersion(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, 1, 1, Number.MAX_SAFE_INTEGER);
}

function normalizedTimestamp(value: string): string {
  if (typeof value !== 'string') throw validationError();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw validationError();
  return new Date(timestamp).toISOString();
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const output = value === undefined ? fallback : value;
  if (!Number.isInteger(output) || output < min || output > max) throw validationError();
  return output;
}

function validationError(): IvrError {
  return new IvrError({ code: 'validation_failed', status: 422 });
}

function simulationLimit(): IvrError {
  return new IvrError({ code: 'simulation_limit_exceeded', status: 422 });
}

function clone<T>(value: T): T { return structuredClone(value); }
