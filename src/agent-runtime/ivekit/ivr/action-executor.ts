import { IvrError } from './errors.js';
import type {
  IvrCallControlPort,
  IvrKnowledgePort,
  IvrMediaPort,
  IvrPendingActionExecutor,
  IvrQueuePort,
  IvrRealtimeAiPort,
  IvrRecordingPort,
  IvrWebhookPort
} from './ports.js';
import type { IvrAction, IvrPendingAction } from './types.js';

export interface IvrPortActionExecutorOptions {
  resolve_call_id?: (tenantId: string, sessionId: string) => Promise<string>;
  call_control?: IvrCallControlPort;
  queue?: IvrQueuePort;
  knowledge?: IvrKnowledgePort;
  realtime_ai?: IvrRealtimeAiPort;
  recording?: IvrRecordingPort;
  media?: IvrMediaPort;
  webhook?: IvrWebhookPort;
}

export class IvrPortActionExecutor implements IvrPendingActionExecutor {
  constructor(private readonly ports: IvrPortActionExecutorOptions) {}

  async execute(pending: IvrPendingAction): Promise<Record<string, unknown>> {
    if (pending.dispatch_mode !== 'worker') throw unavailable(pending.action_kind);
    const action: IvrAction = {
      kind: pending.action_kind,
      node_id: pending.node_id,
      payload: structuredClone(pending.payload)
    };
    switch (pending.action_kind) {
      case 'play':
      case 'flush':
      case 'transfer':
      case 'hangup':
      case 'wait':
        return required(this.ports.call_control, pending.action_kind).execute(
          pending.tenant_id, await this.#callId(pending), action, pending.idempotency_key
        );
      case 'queue': {
        const queue = required(this.ports.queue, 'queue');
        return queue.enqueue({
          tenant_id: pending.tenant_id,
          call_id: await this.#callId(pending),
          queue_id: reference(pending.payload.queue_id ?? pending.payload.queueId),
          priority: boundedInteger(pending.payload.priority, 0, -100, 100),
          idempotency_key: pending.idempotency_key
        });
      }
      case 'knowledge': {
        const knowledge = required(this.ports.knowledge, 'knowledge');
        return knowledge.query({
          tenant_id: pending.tenant_id,
          profile_id: reference(pending.payload.knowledge_profile_id ?? pending.payload.knowledgeProfileId),
          text: boundedText(pending.payload.text ?? pending.payload.question, 16_384),
          language: optionalText(pending.payload.language, 'zh-CN', 32)
        });
      }
      case 'ai': {
        const ai = required(this.ports.realtime_ai, 'ai');
        return ai.respond({
          tenant_id: pending.tenant_id,
          call_id: await this.#callId(pending),
          profile_id: reference(pending.payload.ai_profile_id ?? pending.payload.aiProfileId),
          text: boundedText(pending.payload.text ?? pending.payload.prompt, 16_384),
          context: record(pending.payload.context)
        });
      }
      case 'record':
        return required(this.ports.recording, 'record').execute(
          pending.tenant_id, await this.#callId(pending), action, pending.idempotency_key
        );
      case 'media':
        return required(this.ports.media, 'media').execute(
          pending.tenant_id, await this.#callId(pending), action, pending.idempotency_key
        );
      case 'webhook': {
        const webhook = required(this.ports.webhook, 'webhook');
        return webhook.request({
          tenant_id: pending.tenant_id,
          url_ref: reference(pending.payload.webhook_ref ?? pending.payload.webhookRef
            ?? pending.payload.url_ref ?? pending.payload.urlRef),
          method: httpMethod(pending.payload.method),
          body: safeBody(pending.payload.body),
          timeout_ms: boundedInteger(pending.payload.timeout_ms ?? pending.payload.timeoutMs, 10_000, 100, 300_000),
          idempotency_key: pending.idempotency_key
        });
      }
      case 'collect':
        throw unavailable('collect');
      default:
        throw unavailable(pending.action_kind);
    }
  }

  async #callId(action: IvrPendingAction): Promise<string> {
    const resolver = required(this.ports.resolve_call_id, action.action_kind);
    return reference(await resolver(action.tenant_id, action.session_id));
  }
}

function required<T>(value: T | undefined, capability: string): T {
  if (!value) throw unavailable(capability);
  return value;
}

function unavailable(capability: string): IvrError {
  return new IvrError({ code: 'capability_unavailable', status: 501, details: { capability } });
}

function reference(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value;
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value;
}

function optionalText(value: unknown, fallback: string, maxLength: number): string {
  return value === undefined ? fallback : boundedText(value, maxLength);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const output = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(output) || output < min || output > max) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return output;
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return safeBody(value) as Record<string, unknown>;
}

function safeBody(value: unknown): unknown {
  const output = value === undefined ? {} : value;
  const serialized = JSON.stringify(output);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 65_536
    || /authorization|password|private_key|access_token/i.test(serialized)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return JSON.parse(serialized) as unknown;
}

function httpMethod(value: unknown): string {
  const output = String(value ?? 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(output)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return output;
}
