import { randomUUID } from 'node:crypto';

import { canonicalIvrPayloadHash } from './canonical.js';
import { IvrError } from './errors.js';
import {
  executeIvrNode,
  type IvrExecutionContext,
  type IvrExecutionEvent,
  type IvrExecutionOutcome
} from './executor.js';
import type { IvrSessionUnitOfWork, IvrSessionUnitOfWorkContext } from './ports.js';
import type {
  IvrAction,
  IvrPendingAction,
  IvrSession,
  IvrSessionStep
} from './types.js';
import type { IvrFlowGraph, IvrNodeBase } from './graph-types.js';

export interface IvrSessionServiceOptions {
  unit_of_work: IvrSessionUnitOfWork;
  id?: (kind: string) => string;
  now?: () => Date;
  max_steps?: number;
  max_subflow_depth?: number;
}

export interface StartIvrSessionInput {
  tenant_id: string;
  call_id: string;
  flow_id: string;
  flow_version?: number;
  provider_profile_id?: string;
  provider_session_id?: string;
  trace_id?: string;
  variables?: Record<string, unknown>;
}

export interface AdvanceIvrSessionInput {
  tenant_id: string;
  session_id: string;
  event_sequence: number;
  action_revision: number;
  event: IvrExecutionEvent;
}

export interface CompleteIvrWorkerActionInput {
  tenant_id: string;
  action_id: string;
  worker_id: string;
  result: Record<string, unknown>;
}

export interface IvrSessionResult {
  session: IvrSession;
  action: IvrAction | null;
  replayed: boolean;
  steps_appended: number;
}

const PROVIDER_EXCHANGE_ACTIONS = new Set<IvrAction['kind']>([
  'play', 'collect', 'queue', 'transfer', 'record', 'hangup', 'wait'
]);

export class IvrSessionService {
  readonly #unitOfWork: IvrSessionUnitOfWork;
  readonly #id: (kind: string) => string;
  readonly #now: () => Date;
  readonly #maxSteps: number;
  readonly #maxSubflowDepth: number;

  constructor(options: IvrSessionServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#maxSteps = boundedInteger(options.max_steps, 500, 1, 10_000);
    this.#maxSubflowDepth = boundedInteger(options.max_subflow_depth, 5, 1, 32);
  }

  async startSession(input: StartIvrSessionInput): Promise<IvrSessionResult> {
    const tenantId = identifier(input.tenant_id);
    const flowId = identifier(input.flow_id);
    const callId = identifier(input.call_id);
    const binding = providerBinding(input.provider_profile_id, input.provider_session_id);
    return this.#unitOfWork.run(tenantId, async ({ flows, sessions }) => {
      if (binding) {
        const replay = await sessions.findByProviderBinding(
          tenantId, binding.profile_id, binding.session_id, { for_update: true }
        );
        if (replay) {
          if (replay.call_id !== callId || replay.flow_id !== flowId
            || (input.flow_version !== undefined && replay.flow_version !== input.flow_version)) {
            throw new IvrError({ code: 'idempotency_conflict', status: 409 });
          }
          return { session: replay, action: actionFromRecord(replay.last_action), replayed: true, steps_appended: 0 };
        }
      }
      const version = required(await flows.getPublished(tenantId, flowId, input.flow_version));
      const now = this.#timestamp();
      const session: IvrSession = {
        id: this.#newId('ivr-session'), tenant_id: tenantId, call_id: callId,
        flow_id: flowId, flow_version: version.version, state: 'running',
        current_node_id: version.graph.entryNodeId,
        context: initialContext(input.variables, flowId, version.version) as unknown as Record<string, unknown>,
        step_count: 0, revision: 1,
        waiting_reason: '', termination_reason: '', created_at: now, updated_at: now,
        completed_at: null, provider_profile_id: binding?.profile_id ?? null,
        provider_session_id: binding?.session_id ?? null, last_event_sequence: 0,
        last_event_payload_hash: '', last_action_revision: 0, last_action: {},
        provider_metadata: {}, trace_id: optionalIdentifier(input.trace_id)
      };
      return { session: await sessions.insert(session), action: null, replayed: false, steps_appended: 0 };
    });
  }

  async advance(input: AdvanceIvrSessionInput): Promise<IvrSessionResult> {
    const tenantId = identifier(input.tenant_id);
    const sessionId = identifier(input.session_id);
    const eventSequence = nonNegativeInteger(input.event_sequence);
    const actionRevision = nonNegativeInteger(input.action_revision);
    const eventHash = canonicalIvrPayloadHash(input.event);
    return this.#unitOfWork.run(tenantId, async (context) => {
      const current = required(await context.sessions.get(tenantId, sessionId, { for_update: true }));
      if (eventSequence === current.last_event_sequence && actionRevision === current.last_action_revision) {
        if (eventHash !== current.last_event_payload_hash) throw sequenceConflict(current);
        return { session: current, action: actionFromRecord(current.last_action), replayed: true, steps_appended: 0 };
      }
      if (isTerminal(current.state)) throw new IvrError({ code: 'invalid_session_state', status: 409 });
      if (eventSequence !== current.last_event_sequence + 1 || actionRevision !== current.last_action_revision + 1) {
        throw sequenceConflict(current);
      }
      return this.#drive(context, current, input.event, {
        eventSequence, actionRevision, eventHash
      });
    });
  }

  async completeWorkerAction(input: CompleteIvrWorkerActionInput): Promise<IvrSessionResult> {
    const tenantId = identifier(input.tenant_id);
    const actionId = identifier(input.action_id);
    const workerId = identifier(input.worker_id);
    return this.#unitOfWork.run(tenantId, async (context) => {
      const action = required(await context.actions.get(tenantId, actionId, { for_update: true }));
      if (action.dispatch_mode !== 'worker' || action.state !== 'processing' || action.worker_id !== workerId) {
        throw new IvrError({ code: 'lease_lost', status: 409 });
      }
      const session = required(await context.sessions.get(tenantId, action.session_id, { for_update: true }));
      if (session.state !== 'waiting' || session.current_node_id !== action.node_id) {
        throw new IvrError({ code: 'invalid_session_state', status: 409 });
      }
      return this.#drive(
        context,
        session,
        { type: 'action_succeeded', result: safeResult(input.result) },
        {
          eventSequence: session.last_event_sequence,
          actionRevision: session.last_action_revision,
          eventHash: session.last_event_payload_hash
        },
        workerId
      );
    });
  }

  async #drive(
    stores: IvrSessionUnitOfWorkContext,
    current: IvrSession,
    initialEvent: IvrExecutionEvent,
    sequence: { eventSequence: number; actionRevision: number; eventHash: string },
    settlementWorkerId?: string
  ): Promise<IvrSessionResult> {
    let session = { ...current, context: structuredClone(current.context) };
    let event = initialEvent;
    let previousAction: IvrPendingAction | null = null;
    let stepsAppended = 0;
    const now = this.#timestamp();
    let execution = executionContext(session.context, session);
    let activeVersion = required(await stores.flows.getPublished(
      session.tenant_id, execution.active_flow.flow_id, execution.active_flow.flow_version
    ));
    let graph = activeVersion.graph;

    if (session.state === 'waiting') {
      previousAction = required(await stores.actions.findOpenForSession(session.tenant_id, session.id));
      const settlement = actionSettlement(event);
      await stores.actions.settle({
        tenant_id: session.tenant_id,
        action_id: previousAction.id,
        ...(settlementWorkerId ? { worker_id: settlementWorkerId } : {}),
        state: settlement.state,
        result: settlement.result,
        error_code: settlement.error_code,
        completed_at: now
      });
      session.state = 'running';
      session.waiting_reason = '';
    } else if (event.type !== 'enter') {
      throw new IvrError({ code: 'invalid_session_state', status: 409 });
    }

    for (let loop = 0; loop <= this.#maxSteps; loop += 1) {
      if (session.step_count >= this.#maxSteps) throw new IvrError({ code: 'step_limit_exceeded', status: 422 });
      const nodeId = session.current_node_id;
      const node = graph.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new IvrError({ code: 'invalid_session_state', status: 409 });

      if (node.type === 'disconnect' && execution.subflow_stack.length > 0) {
        const returned = returnFromSubflow(execution, node);
        const outcome = syntheticAdvance(returned.context, returned.branch, returned.next_node_id);
        await stores.steps.append(this.#step(session, nodeId, auditAction(nodeId, event), outcome, now));
        stepsAppended += 1;
        session.step_count += 1;
        execution = returned.context;
        session.context = execution as unknown as Record<string, unknown>;
        session.current_node_id = returned.next_node_id;
        activeVersion = required(await stores.flows.getPublished(
          session.tenant_id, execution.active_flow.flow_id, execution.active_flow.flow_version
        ));
        graph = activeVersion.graph;
        event = { type: 'enter' };
        continue;
      }

      const outcome = executeIvrNode({
        graph, node_id: nodeId, context: execution, event
      });
      if (outcome.state === 'waiting') {
        const planned = required(outcome.action);
        const pending = this.#pendingAction(session, planned, now);
        await stores.actions.insert(pending);
        session = {
          ...session, state: 'waiting',
          context: outcome.context as unknown as Record<string, unknown>, waiting_reason: planned.kind,
          last_event_sequence: sequence.eventSequence,
          last_event_payload_hash: sequence.eventHash,
          last_action_revision: sequence.actionRevision,
          last_action: structuredClone(planned) as unknown as Record<string, unknown>,
          updated_at: now,
          revision: current.revision + 1
        };
        const updated = await stores.sessions.update(session, current.revision);
        return { session: updated, action: planned, replayed: false, steps_appended: stepsAppended };
      }

      if (outcome.state === 'delegated') {
        const delegation = required(outcome.delegation);
        const failureCode = execution.subflow_stack.length >= this.#maxSubflowDepth
          ? 'subflow_depth_exceeded'
          : '';
        const child = failureCode ? null : await stores.flows.getPublished(
          session.tenant_id, delegation.flow_id, delegation.flow_version ?? undefined
        );
        const errorCode = failureCode || (child ? '' : 'subflow_not_found');
        const outTarget = branchTarget(graph, nodeId, 'out');
        const errorTarget = branchTarget(graph, nodeId, 'error');

        if (errorCode) {
          const failedDelegation = syntheticAdvance(outcome.context, 'error', errorTarget, errorCode);
          await stores.steps.append(this.#step(
            session, nodeId, auditAction(nodeId, event), failedDelegation, now
          ));
          stepsAppended += 1;
          session.step_count += 1;
          session.context = failedDelegation.context as unknown as Record<string, unknown>;
          execution = failedDelegation.context;
          session.current_node_id = errorTarget;
          event = { type: 'enter' };
          continue;
        }

        const childVersion = required(child);
        const entered = structuredClone(outcome.context);
        entered.subflow_stack.push({
          flow_id: entered.active_flow.flow_id,
          flow_version: entered.active_flow.flow_version,
          subflow_node_id: nodeId,
          return_node_id: outTarget,
          error_return_node_id: errorTarget
        });
        entered.active_flow = { flow_id: childVersion.flow_id, flow_version: childVersion.version };
        const enteredOutcome = syntheticAdvance(entered, 'subflow', childVersion.graph.entryNodeId);
        await stores.steps.append(this.#step(
          session, nodeId, auditAction(nodeId, event), enteredOutcome, now
        ));
        stepsAppended += 1;
        session.step_count += 1;
        session.context = entered as unknown as Record<string, unknown>;
        execution = entered;
        session.current_node_id = childVersion.graph.entryNodeId;
        graph = childVersion.graph;
        event = { type: 'enter' };
        continue;
      }

      const stepAction = previousAction ? pendingToAction(previousAction) : auditAction(nodeId, event);
      const step = this.#step(session, nodeId, stepAction, outcome, now);
      await stores.steps.append(step);
      stepsAppended += 1;
      previousAction = null;
      session.step_count += 1;
      session.context = outcome.context as unknown as Record<string, unknown>;
      execution = outcome.context;

      if (outcome.state === 'advanced') {
        session.current_node_id = required(outcome.next_node_id);
        event = { type: 'enter' };
        continue;
      }
      if (execution.subflow_stack.length > 0) {
        const returned = popSubflow(
          execution,
          outcome.state === 'completed' ? 'out' : 'error'
        );
        execution = returned.context;
        session.context = execution as unknown as Record<string, unknown>;
        session.current_node_id = returned.next_node_id;
        activeVersion = required(await stores.flows.getPublished(
          session.tenant_id, execution.active_flow.flow_id, execution.active_flow.flow_version
        ));
        graph = activeVersion.graph;
        event = { type: 'enter' };
        continue;
      }
      session = {
        ...session,
        state: outcome.state === 'completed' ? 'completed' : 'failed',
        termination_reason: outcome.error_code,
        completed_at: now,
        last_event_sequence: sequence.eventSequence,
        last_event_payload_hash: sequence.eventHash,
        last_action_revision: sequence.actionRevision,
        last_action: {},
        updated_at: now,
        revision: current.revision + 1
      };
      const updated = await stores.sessions.update(session, current.revision);
      return { session: updated, action: null, replayed: false, steps_appended: stepsAppended };
    }
    throw new IvrError({ code: 'step_limit_exceeded', status: 422 });
  }

  #pendingAction(session: IvrSession, action: IvrAction, now: string): IvrPendingAction {
    const providerExchange = PROVIDER_EXCHANGE_ACTIONS.has(action.kind);
    return {
      id: this.#newId('ivr-action'), tenant_id: session.tenant_id, session_id: session.id,
      step_index: session.step_count, node_id: action.node_id, action_kind: action.kind,
      state: providerExchange ? 'processing' : 'pending',
      dispatch_mode: providerExchange ? 'provider_exchange' : 'worker',
      idempotency_key: `ivr:${session.id}:${session.step_count}`,
      payload_hash: canonicalIvrPayloadHash(action.payload), payload: structuredClone(action.payload), result: {},
      attempt_count: providerExchange ? 1 : 0, max_attempts: 3, next_attempt_at: null,
      lease_until: null, worker_id: providerExchange ? 'provider-exchange' : '',
      provider_profile_id: session.provider_profile_id ?? '', provider_action_id: '',
      error_code: '', error_message: '', trace_id: session.trace_id, reconciliation_count: 0,
      created_at: now, updated_at: now, completed_at: null
    };
  }

  #step(
    session: IvrSession,
    nodeId: string,
    action: IvrAction,
    outcome: IvrExecutionOutcome,
    now: string
  ): IvrSessionStep {
    const activeFlow = executionContext(session.context, session).active_flow;
    return {
      id: this.#newId('ivr-step'), tenant_id: session.tenant_id, session_id: session.id,
      step_index: session.step_count, flow_id: activeFlow.flow_id,
      flow_version: activeFlow.flow_version, node_id: nodeId, action,
      branch_taken: outcome.branch ?? '', duration_ms: 0,
      error_code: outcome.error_code, created_at: now
    };
  }

  #newId(kind: string): string { return identifier(this.#id(kind)); }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new IvrError({ code: 'internal_error', status: 500 });
    return value.toISOString();
  }
}

function actionSettlement(event: IvrExecutionEvent): {
  state: 'succeeded' | 'failed'; result: Record<string, unknown>; error_code: string;
} {
  if (event.type === 'action_failed') {
    return { state: 'failed', result: {}, error_code: boundedErrorCode(event.error_code) };
  }
  if (event.type === 'timeout') return { state: 'failed', result: {}, error_code: 'timeout' };
  if (event.type === 'action_succeeded') return { state: 'succeeded', result: event.result, error_code: '' };
  if (event.type === 'dtmf') return { state: 'succeeded', result: { digit: event.digit }, error_code: '' };
  if (event.type === 'selection') return { state: 'succeeded', result: { value: event.value }, error_code: '' };
  throw new IvrError({ code: 'invalid_session_state', status: 409 });
}

function initialContext(
  variables: Record<string, unknown> = {},
  flowId: string,
  flowVersion: number
): IvrExecutionContext {
  const serialized = JSON.stringify(variables);
  if (Buffer.byteLength(serialized, 'utf8') > 65_536) throw new IvrError({ code: 'validation_failed', status: 422 });
  return {
    variables: structuredClone(variables), interaction_attempts: {},
    active_flow: { flow_id: flowId, flow_version: flowVersion }, subflow_stack: []
  };
}

function executionContext(value: Record<string, unknown>, session: IvrSession): IvrExecutionContext {
  if (!value.variables || !value.interaction_attempts || !Array.isArray(value.subflow_stack)) {
    throw new IvrError({ code: 'invalid_session_state', status: 409 });
  }
  const cloned = structuredClone(value) as unknown as IvrExecutionContext;
  cloned.active_flow ??= { flow_id: session.flow_id, flow_version: session.flow_version };
  return cloned;
}

function returnFromSubflow(
  context: IvrExecutionContext,
  node: IvrNodeBase
): { context: IvrExecutionContext; branch: 'out' | 'error'; next_node_id: string } {
  const value = String(node.data.return_code ?? node.data.returnCode ?? 'ok').toLowerCase();
  return popSubflow(context, ['ok', 'out', 'success'].includes(value) ? 'out' : 'error');
}

function popSubflow(
  context: IvrExecutionContext,
  branch: 'out' | 'error'
): { context: IvrExecutionContext; branch: 'out' | 'error'; next_node_id: string } {
  const next = structuredClone(context);
  const frame = next.subflow_stack.pop();
  if (!frame) throw new IvrError({ code: 'invalid_session_state', status: 409 });
  next.active_flow = { flow_id: frame.flow_id, flow_version: frame.flow_version };
  return {
    context: next,
    branch,
    next_node_id: branch === 'out' ? frame.return_node_id : frame.error_return_node_id
  };
}

function branchTarget(graph: IvrFlowGraph, nodeId: string, branch: string): string {
  const edge = graph.edges.find((candidate) => candidate.source === nodeId
    && (candidate.sourceHandle || 'out') === branch);
  if (!edge) throw new IvrError({ code: 'invalid_session_state', status: 409 });
  return edge.target;
}

function syntheticAdvance(
  context: IvrExecutionContext,
  branch: string,
  nextNodeId: string,
  errorCode = ''
): IvrExecutionOutcome {
  return {
    state: 'advanced', context, branch, next_node_id: nextNodeId,
    action: null, delegation: null, error_code: errorCode
  };
}

function pendingToAction(action: IvrPendingAction): IvrAction {
  return { kind: action.action_kind, node_id: action.node_id, payload: structuredClone(action.payload) };
}

function auditAction(nodeId: string, event: IvrExecutionEvent): IvrAction {
  return { kind: 'wait', node_id: nodeId, payload: { operation: 'synchronous', event_type: event.type } };
}

function actionFromRecord(value: Record<string, unknown>): IvrAction | null {
  if (typeof value.kind !== 'string' || typeof value.node_id !== 'string'
    || !value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) return null;
  return structuredClone(value) as unknown as IvrAction;
}

function providerBinding(profileId: unknown, sessionId: unknown): { profile_id: string; session_id: string } | null {
  if (profileId === undefined && sessionId === undefined) return null;
  if (profileId === undefined || sessionId === undefined) throw new IvrError({ code: 'validation_failed', status: 422 });
  return { profile_id: identifier(profileId), session_id: identifier(sessionId) };
}

function required<T>(value: T | null): T {
  if (value === null) throw new IvrError({ code: 'not_found', status: 404 });
  return value;
}

function sequenceConflict(session: IvrSession): IvrError {
  return new IvrError({
    code: 'event_sequence_conflict', status: 409,
    details: {
      expected_event_sequence: session.last_event_sequence + 1,
      expected_action_revision: session.last_action_revision + 1
    }
  });
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.trim())) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value.trim();
}

function optionalIdentifier(value: unknown): string {
  return value === undefined || value === '' ? '' : identifier(value);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return Number(value);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

function boundedErrorCode(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'action_failed';
}

function isTerminal(state: IvrSession['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function safeResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 65_536) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return structuredClone(value) as Record<string, unknown>;
}
