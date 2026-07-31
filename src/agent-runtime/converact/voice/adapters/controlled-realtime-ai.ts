import { canonicalVoicePayloadHash, safeVoiceProviderPayload } from '../canonical.js';
import { VoiceError } from '../errors.js';
import {
  REALTIME_VOICE_AI_CAPABILITIES,
  type RealtimeVoiceAiCapabilities,
  type RealtimeVoiceAiCapability,
  type RealtimeVoiceAiDtmfInput,
  type RealtimeVoiceAiEventType,
  type RealtimeVoiceAiFactory,
  type RealtimeVoiceAiNormalizedEvent,
  type RealtimeVoiceAiPort,
  type RealtimeVoiceAiProfile,
  type RealtimeVoiceAiSessionCommandInput,
  type RealtimeVoiceAiSessionPlan,
  type StartRealtimeVoiceAiSessionInput
} from '../realtime-ai.js';

export interface ControlledRealtimeVoiceAiSession {
  provider_session_id: string;
  tenant_id: string;
  call_id: string;
  state: 'active' | 'ended';
  dtmf: string[];
  interrupt_count: number;
  ended_reason: string;
}

export class ControlledRealtimeVoiceAiFactory implements RealtimeVoiceAiFactory {
  readonly #sessions = new Map<string, ControlledRealtimeVoiceAiSession>();
  readonly #idempotency = new Map<string, { hash: string; plan?: RealtimeVoiceAiSessionPlan }>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async create(profile: RealtimeVoiceAiProfile): Promise<RealtimeVoiceAiPort> {
    return new ControlledRealtimeVoiceAiAdapter(
      profile, this.#sessions, this.#idempotency, this.#now
    );
  }

  getSession(providerSessionId: string): ControlledRealtimeVoiceAiSession | null {
    const session = this.#sessions.get(providerSessionId);
    return session ? structuredClone(session) : null;
  }
}

class ControlledRealtimeVoiceAiAdapter implements RealtimeVoiceAiPort {
  constructor(
    private readonly profile: RealtimeVoiceAiProfile,
    private readonly sessions: Map<string, ControlledRealtimeVoiceAiSession>,
    private readonly idempotency: Map<string, { hash: string; plan?: RealtimeVoiceAiSessionPlan }>,
    private readonly now: () => Date
  ) {}

  async preflight(): Promise<RealtimeVoiceAiCapabilities> {
    const configured = this.profile.config.controlled_capabilities;
    const capabilities = Object.fromEntries(REALTIME_VOICE_AI_CAPABILITIES.map((capability) => [
      capability,
      configured && typeof configured === 'object' && !Array.isArray(configured)
        ? (configured as Record<string, unknown>)[capability] === true
        : true
    ])) as Record<RealtimeVoiceAiCapability, boolean>;
    return {
      profile_id: this.profile.id,
      provider: this.profile.provider,
      provider_version: this.profile.provider_version || 'controlled-v1',
      capabilities,
      checked_at: this.now().toISOString()
    };
  }

  async startSession(input: StartRealtimeVoiceAiSessionInput): Promise<RealtimeVoiceAiSessionPlan> {
    const key = operationKey(input.tenant_id, 'start', input.idempotency_key);
    const hash = canonicalVoicePayloadHash(input);
    const replay = this.idempotency.get(key);
    if (replay) {
      if (replay.hash !== hash || !replay.plan) throw idempotencyConflict();
      return structuredClone(replay.plan);
    }
    const capabilities = (await this.preflight()).capabilities;
    const providerSessionId = `controlled-ai:${hash.slice(0, 24)}`;
    const plan: RealtimeVoiceAiSessionPlan = {
      provider_session_id: providerSessionId,
      provider: this.profile.provider,
      provider_version: this.profile.provider_version || 'controlled-v1',
      capabilities
    };
    this.sessions.set(providerSessionId, {
      provider_session_id: providerSessionId, tenant_id: input.tenant_id,
      call_id: input.call_id, state: 'active', dtmf: [], interrupt_count: 0,
      ended_reason: ''
    });
    this.idempotency.set(key, { hash, plan: structuredClone(plan) });
    return plan;
  }

  async sendDtmf(input: RealtimeVoiceAiDtmfInput): Promise<void> {
    this.once(input.tenant_id, 'dtmf', input.idempotency_key, input, () => {
      this.activeSession(input).dtmf.push(input.digits);
    });
  }

  async interrupt(input: RealtimeVoiceAiSessionCommandInput): Promise<void> {
    this.once(input.tenant_id, 'interrupt', input.idempotency_key, input, () => {
      this.activeSession(input).interrupt_count += 1;
    });
  }

  async endSession(input: RealtimeVoiceAiSessionCommandInput): Promise<void> {
    this.once(input.tenant_id, 'end', input.idempotency_key, input, () => {
      const session = this.session(input);
      session.state = 'ended';
      session.ended_reason = input.reason;
    });
  }

  normalizeEvent(input: unknown): RealtimeVoiceAiNormalizedEvent {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw protocolMismatch();
    const event = input as Record<string, unknown>;
    const type = eventType(event.type);
    const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? safeVoiceProviderPayload(event.metadata)
      : {};
    return {
      external_event_id: identifier(event.event_id),
      type,
      provider_session_id: identifier(event.provider_session_id),
      occurred_at: timestamp(event.occurred_at),
      transcript_text: optionalText(event.transcript, 65_536),
      language: optionalText(event.language, 32),
      tool_ref: optionalIdentifier(event.tool_ref),
      tool_call_id: optionalIdentifier(event.tool_call_id),
      latency_ms: numberRecord(event.latency_ms),
      evidence_ref: optionalIdentifier(event.evidence_ref),
      safe_metadata: metadata
    };
  }

  async close(): Promise<void> {}

  private once(
    tenantId: string,
    operation: string,
    idempotencyKey: string,
    input: unknown,
    effect: () => void
  ): void {
    const key = operationKey(tenantId, operation, idempotencyKey);
    const hash = canonicalVoicePayloadHash(input);
    const replay = this.idempotency.get(key);
    if (replay) {
      if (replay.hash !== hash) throw idempotencyConflict();
      return;
    }
    effect();
    this.idempotency.set(key, { hash });
  }

  private activeSession(input: { tenant_id: string; call_id: string; provider_session_id: string }) {
    const session = this.session(input);
    if (session.state === 'ended') throw new VoiceError({ code: 'terminal_call_state', status: 409 });
    return session;
  }

  private session(input: { tenant_id: string; call_id: string; provider_session_id: string }) {
    const session = this.sessions.get(input.provider_session_id);
    if (!session || session.tenant_id !== input.tenant_id || session.call_id !== input.call_id) {
      throw new VoiceError({ code: 'not_found', status: 404 });
    }
    return session;
  }
}

const EVENT_TYPES = new Set<RealtimeVoiceAiEventType>([
  'session.started', 'session.ended', 'vad.started', 'vad.stopped',
  'transcript.partial', 'transcript.final', 'tool.started', 'tool.completed',
  'tool.failed', 'interrupted', 'latency.measured'
]);

function eventType(value: unknown): RealtimeVoiceAiEventType {
  if (typeof value !== 'string' || !EVENT_TYPES.has(value as RealtimeVoiceAiEventType)) throw protocolMismatch();
  return value as RealtimeVoiceAiEventType;
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw protocolMismatch();
  return new Date(value).toISOString();
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) throw protocolMismatch();
  return value;
}

function optionalIdentifier(value: unknown): string {
  return value === undefined || value === '' ? '' : identifier(value);
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw protocolMismatch();
  }
  return value;
}

function numberRecord(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolMismatch();
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)
      || typeof item !== 'number' || !Number.isFinite(item)) throw protocolMismatch();
    output[key] = item;
  }
  return output;
}

function operationKey(tenantId: string, operation: string, key: string): string {
  return `${tenantId}:${operation}:${key}`;
}

function idempotencyConflict(): VoiceError {
  return new VoiceError({ code: 'idempotency_conflict', status: 409 });
}

function protocolMismatch(): VoiceError {
  return new VoiceError({ code: 'protocol_mismatch', status: 422 });
}
