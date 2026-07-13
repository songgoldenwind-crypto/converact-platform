import type { IvrAction, IvrFlowVersion, IvrSession } from './types.js';

export interface IvrFlowRepository {
  getPublished(
    tenantId: string,
    flowId: string,
    version?: number
  ): Promise<IvrFlowVersion | null>;
}

export interface IvrSessionRepository {
  get(
    tenantId: string,
    sessionId: string,
    options?: { for_update?: boolean }
  ): Promise<IvrSession | null>;
  insert(session: IvrSession): Promise<IvrSession>;
  update(session: IvrSession, expectedRevision: number): Promise<IvrSession>;
  appendStep(input: {
    tenant_id: string;
    session_id: string;
    step_index: number;
    node_id: string;
    action: IvrAction;
    branch_taken: string;
    duration_ms: number;
    error_code: string;
  }): Promise<void>;
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
