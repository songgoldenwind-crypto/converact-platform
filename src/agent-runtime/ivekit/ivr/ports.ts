import type { IvrDependencyManifest } from './dependencies.js';
import type { IvrValidationIssue } from './validation.js';
import type {
  IvrAction,
  IvrFlow,
  IvrFlowVersion,
  IvrPendingAction,
  IvrSession,
  IvrSessionStep
} from './types.js';

export interface IvrFlowRepository {
  getFlow(
    tenantId: string,
    flowId: string,
    options?: { for_update?: boolean }
  ): Promise<IvrFlow | null>;
  listFlows(tenantId: string): Promise<IvrFlow[]>;
  insertFlow(flow: IvrFlow): Promise<IvrFlow>;
  updateDraft(flow: IvrFlow, expectedRevision: number): Promise<IvrFlow>;
  updatePublication(flow: IvrFlow, expectedRevision: number): Promise<IvrFlow>;
  listVersions(tenantId: string, flowId: string): Promise<IvrFlowVersion[]>;
  getVersion(tenantId: string, flowId: string, version: number): Promise<IvrFlowVersion | null>;
  getPublished(
    tenantId: string,
    flowId: string,
    version?: number
  ): Promise<IvrFlowVersion | null>;
  findVersionByPublicationKey(tenantId: string, key: string): Promise<IvrFlowVersion | null>;
  insertVersion(version: IvrFlowVersion): Promise<IvrFlowVersion>;
}

export interface IvrFlowUnitOfWorkContext {
  flows: IvrFlowRepository;
}

export interface IvrFlowUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: IvrFlowUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}

export interface IvrDependencyResolver {
  validate(input: {
    tenant_id: string;
    flow_id: string;
    dependencies: IvrDependencyManifest;
  }): Promise<IvrValidationIssue[]>;
}

export interface IvrSessionRepository {
  get(
    tenantId: string,
    sessionId: string,
    options?: { for_update?: boolean }
  ): Promise<IvrSession | null>;
  findByProviderBinding(
    tenantId: string,
    profileId: string,
    providerSessionId: string,
    options?: { for_update?: boolean }
  ): Promise<IvrSession | null>;
  insert(session: IvrSession): Promise<IvrSession>;
  update(session: IvrSession, expectedRevision: number): Promise<IvrSession>;
}

export interface IvrSessionStepRepository {
  append(step: IvrSessionStep): Promise<void>;
  list(tenantId: string, sessionId: string): Promise<IvrSessionStep[]>;
}

export interface IvrPendingActionRepository {
  findOpenForSession(tenantId: string, sessionId: string): Promise<IvrPendingAction | null>;
  insert(action: IvrPendingAction): Promise<IvrPendingAction>;
  settle(input: {
    tenant_id: string;
    action_id: string;
    state: 'succeeded' | 'failed' | 'cancelled';
    result: Record<string, unknown>;
    error_code: string;
    completed_at: string;
  }): Promise<IvrPendingAction>;
}

export interface IvrSessionUnitOfWorkContext {
  flows: IvrFlowRepository;
  sessions: IvrSessionRepository;
  steps: IvrSessionStepRepository;
  actions: IvrPendingActionRepository;
}

export interface IvrSessionUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: IvrSessionUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}

export interface IvrCallControlPort {
  execute(
    tenantId: string,
    callId: string,
    action: IvrAction,
    idempotencyKey: string
  ): Promise<Record<string, unknown>>;
}

export interface IvrQueuePort {
  enqueue(input: {
    tenant_id: string;
    call_id: string;
    queue_id: string;
    priority: number;
    idempotency_key: string;
  }): Promise<{ queue_entry_id: string; position: number | null }>;
}

export interface IvrKnowledgePort {
  query(input: {
    tenant_id: string;
    profile_id: string;
    text: string;
    language: string;
  }): Promise<{ answer: string; citations: unknown[]; confidence: number }>;
}

export interface IvrRealtimeAiPort {
  respond(input: {
    tenant_id: string;
    call_id: string;
    profile_id: string;
    text: string;
    context: Record<string, unknown>;
  }): Promise<{ text: string; intent: string; tool_calls: unknown[] }>;
}

export interface IvrRecordingPort {
  execute(
    tenantId: string,
    callId: string,
    action: IvrAction,
    idempotencyKey: string
  ): Promise<Record<string, unknown>>;
}

export interface IvrMediaPort {
  execute(
    tenantId: string,
    callId: string,
    action: IvrAction,
    idempotencyKey: string
  ): Promise<Record<string, unknown>>;
}

export interface IvrWebhookPort {
  request(input: {
    tenant_id: string;
    url_ref: string;
    method: string;
    body: unknown;
    timeout_ms: number;
    idempotency_key: string;
  }): Promise<{ status: number; body: unknown }>;
}

export interface IvrClock {
  now(): Date;
}
