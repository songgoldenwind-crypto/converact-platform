import { VoiceError } from './errors.js';

export type RealtimeVoiceAiProvider =
  | 'active_call'
  | 'livekit_agents'
  | 'self_hosted'
  | 'third_party';

export type RealtimeVoiceAiCapability =
  | 'vad'
  | 'streaming_asr'
  | 'streaming_tts'
  | 'barge_in'
  | 'dtmf'
  | 'tool_calls'
  | 'transcript_events'
  | 'latency_metrics';

export const REALTIME_VOICE_AI_CAPABILITIES: readonly RealtimeVoiceAiCapability[] = [
  'vad', 'streaming_asr', 'streaming_tts', 'barge_in', 'dtmf',
  'tool_calls', 'transcript_events', 'latency_metrics'
];

export interface RealtimeVoiceAiProfile {
  id: string;
  tenant_id: string;
  name: string;
  provider: RealtimeVoiceAiProvider;
  status: 'disabled' | 'enabled' | 'degraded' | 'archived';
  endpoint: string;
  provider_version: string;
  config: Record<string, unknown>;
  secret_refs: Record<string, string>;
  revision: number;
}

export interface RealtimeVoiceAiCapabilities {
  profile_id: string;
  provider: RealtimeVoiceAiProvider;
  provider_version: string;
  capabilities: Readonly<Record<RealtimeVoiceAiCapability, boolean>>;
  checked_at: string;
}

export interface RealtimeVoiceAiToolRef {
  tool_id: string;
  version: number;
  schema_hash: string;
}

export interface StartRealtimeVoiceAiSessionInput {
  tenant_id: string;
  call_id: string;
  profile_id: string;
  language: string;
  tools: RealtimeVoiceAiToolRef[];
  idempotency_key: string;
}

export interface RealtimeVoiceAiSessionPlan {
  provider_session_id: string;
  provider: RealtimeVoiceAiProvider;
  provider_version: string;
  capabilities: Readonly<Record<RealtimeVoiceAiCapability, boolean>>;
}

export interface RealtimeVoiceAiSessionCommandInput {
  tenant_id: string;
  call_id: string;
  provider_session_id: string;
  reason: string;
  idempotency_key: string;
}

export interface RealtimeVoiceAiDtmfInput {
  tenant_id: string;
  call_id: string;
  provider_session_id: string;
  digits: string;
  idempotency_key: string;
}

export type RealtimeVoiceAiEventType =
  | 'session.started'
  | 'session.ended'
  | 'vad.started'
  | 'vad.stopped'
  | 'transcript.partial'
  | 'transcript.final'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'interrupted'
  | 'latency.measured';

export interface RealtimeVoiceAiNormalizedEvent {
  external_event_id: string;
  type: RealtimeVoiceAiEventType;
  provider_session_id: string;
  occurred_at: string;
  transcript_text: string;
  language: string;
  tool_ref: string;
  tool_call_id: string;
  latency_ms: Record<string, number>;
  evidence_ref: string;
  safe_metadata: Record<string, unknown>;
}

export interface RealtimeVoiceAiPort {
  preflight(): Promise<RealtimeVoiceAiCapabilities>;
  startSession(input: StartRealtimeVoiceAiSessionInput): Promise<RealtimeVoiceAiSessionPlan>;
  sendDtmf(input: RealtimeVoiceAiDtmfInput): Promise<void>;
  interrupt(input: RealtimeVoiceAiSessionCommandInput): Promise<void>;
  endSession(input: RealtimeVoiceAiSessionCommandInput): Promise<void>;
  normalizeEvent(input: unknown): RealtimeVoiceAiNormalizedEvent;
  close(): Promise<void>;
}

export interface RealtimeVoiceAiFactory {
  create(profile: RealtimeVoiceAiProfile): Promise<RealtimeVoiceAiPort>;
}

type RegistryPurpose = 'preflight' | 'execute' | 'event';

export class RealtimeVoiceAiRegistry {
  readonly #factories = new Map<RealtimeVoiceAiProvider, RealtimeVoiceAiFactory>();

  constructor(factories: Partial<Record<RealtimeVoiceAiProvider, RealtimeVoiceAiFactory>> = {}) {
    for (const [provider, factory] of Object.entries(factories)) {
      if (factory) this.register(provider as RealtimeVoiceAiProvider, factory);
    }
  }

  register(provider: RealtimeVoiceAiProvider, factory: RealtimeVoiceAiFactory): void {
    if (!isProvider(provider) || !factory || this.#factories.has(provider)) throw validationError();
    this.#factories.set(provider, factory);
  }

  async create(
    profile: RealtimeVoiceAiProfile,
    options: { purpose?: RegistryPurpose } = {}
  ): Promise<RealtimeVoiceAiPort> {
    validateProfile(profile);
    const purpose = options.purpose ?? 'execute';
    if (profile.status === 'archived' || (purpose === 'execute' && profile.status === 'disabled')) {
      throw new VoiceError({ code: 'capability_unavailable', status: 409 });
    }
    const factory = this.#factories.get(profile.provider);
    if (!factory) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    return factory.create(profile);
  }
}

export class RealtimeVoiceAiService {
  constructor(private readonly options: { registry: RealtimeVoiceAiRegistry }) {}

  capabilities(profile: RealtimeVoiceAiProfile): Promise<RealtimeVoiceAiCapabilities> {
    return this.#withAdapter(profile, 'preflight', (adapter) => adapter.preflight());
  }

  async startSession(
    profile: RealtimeVoiceAiProfile,
    input: StartRealtimeVoiceAiSessionInput
  ): Promise<RealtimeVoiceAiSessionPlan> {
    const normalized = normalizeStartInput(profile, input);
    return await this.#withAdapter(profile, 'execute', (adapter) => adapter.startSession(normalized));
  }

  async sendDtmf(profile: RealtimeVoiceAiProfile, input: RealtimeVoiceAiDtmfInput): Promise<void> {
    const normalized = normalizeDtmfInput(profile, input);
    await this.#withAdapter(profile, 'execute', (adapter) => adapter.sendDtmf(normalized));
  }

  async interrupt(profile: RealtimeVoiceAiProfile, input: RealtimeVoiceAiSessionCommandInput): Promise<void> {
    const normalized = normalizeSessionCommand(profile, input);
    await this.#withAdapter(profile, 'execute', (adapter) => adapter.interrupt(normalized));
  }

  async endSession(profile: RealtimeVoiceAiProfile, input: RealtimeVoiceAiSessionCommandInput): Promise<void> {
    const normalized = normalizeSessionCommand(profile, input);
    await this.#withAdapter(profile, 'execute', (adapter) => adapter.endSession(normalized));
  }

  normalizeEvent(
    profile: RealtimeVoiceAiProfile,
    input: unknown
  ): Promise<RealtimeVoiceAiNormalizedEvent> {
    return this.#withAdapter(profile, 'event', (adapter) => adapter.normalizeEvent(input));
  }

  async #withAdapter<T>(
    profile: RealtimeVoiceAiProfile,
    purpose: RegistryPurpose,
    operation: (adapter: RealtimeVoiceAiPort) => T | Promise<T>
  ): Promise<T> {
    const adapter = await this.options.registry.create(profile, { purpose });
    try {
      return await operation(adapter);
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }
}

function normalizeStartInput(
  profile: RealtimeVoiceAiProfile,
  input: StartRealtimeVoiceAiSessionInput
): StartRealtimeVoiceAiSessionInput {
  assertProfileScope(profile, input.tenant_id, input.profile_id);
  if (!Array.isArray(input.tools) || input.tools.length > 32) throw validationError();
  return {
    tenant_id: identifier(input.tenant_id), call_id: identifier(input.call_id),
    profile_id: identifier(input.profile_id), language: language(input.language),
    tools: input.tools.map((tool) => ({
      tool_id: identifier(tool.tool_id),
      version: positiveInteger(tool.version),
      schema_hash: sha256(tool.schema_hash)
    })),
    idempotency_key: idempotencyKey(input.idempotency_key)
  };
}

function normalizeDtmfInput(
  profile: RealtimeVoiceAiProfile,
  input: RealtimeVoiceAiDtmfInput
): RealtimeVoiceAiDtmfInput {
  assertProfileScope(profile, input.tenant_id);
  if (typeof input.digits !== 'string' || !/^[0-9*#]{1,32}$/.test(input.digits)) throw validationError();
  return {
    tenant_id: identifier(input.tenant_id), call_id: identifier(input.call_id),
    provider_session_id: identifier(input.provider_session_id), digits: input.digits,
    idempotency_key: idempotencyKey(input.idempotency_key)
  };
}

function normalizeSessionCommand(
  profile: RealtimeVoiceAiProfile,
  input: RealtimeVoiceAiSessionCommandInput
): RealtimeVoiceAiSessionCommandInput {
  assertProfileScope(profile, input.tenant_id);
  return {
    tenant_id: identifier(input.tenant_id), call_id: identifier(input.call_id),
    provider_session_id: identifier(input.provider_session_id),
    reason: reason(input.reason), idempotency_key: idempotencyKey(input.idempotency_key)
  };
}

function assertProfileScope(profile: RealtimeVoiceAiProfile, tenantId: string, profileId?: string): void {
  if (identifier(tenantId) !== profile.tenant_id || (profileId && identifier(profileId) !== profile.id)) {
    throw new VoiceError({ code: 'not_found', status: 404 });
  }
}

function validateProfile(profile: RealtimeVoiceAiProfile): void {
  if (!isPlainRecord(profile)) throw validationError();
  identifier(profile.id);
  identifier(profile.tenant_id);
  boundedText(profile.name, 128);
  boundedText(profile.provider_version, 64);
  if (!isProvider(profile.provider) || !['disabled', 'enabled', 'degraded', 'archived'].includes(profile.status)) {
    throw validationError();
  }
  if (!Number.isInteger(profile.revision) || profile.revision < 1) throw validationError();
  let endpoint: URL;
  try { endpoint = new URL(profile.endpoint); } catch { throw validationError(); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol)
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw validationError();
  if (!isPlainRecord(profile.config) || !isPlainRecord(profile.secret_refs)) throw validationError();
  for (const [key, ref] of Object.entries(profile.secret_refs)) {
    identifier(key);
    if (!/^env:\/\/[A-Z][A-Z0-9_]*$/.test(ref)) {
      throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
    }
  }
  assertSecretFreeConfig(profile.config, new Set());
}

function assertSecretFreeConfig(value: unknown, ancestors: Set<object>): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return;
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw validationError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertSecretFreeConfig(item, ancestors);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/password|secret|token|authorization|credential|apikey/i.test(key.replace(/[^a-z0-9]/gi, ''))) {
        throw new VoiceError({ code: 'secret_ref_invalid', status: 422 });
      }
      assertSecretFreeConfig(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isProvider(value: unknown): value is RealtimeVoiceAiProvider {
  return value === 'active_call' || value === 'livekit_agents'
    || value === 'self_hosted' || value === 'third_party';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) {
    throw validationError();
  }
  return value;
}

function idempotencyKey(value: unknown): string {
  const key = boundedText(value, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/.test(key)) throw validationError();
  return key;
}

function reason(value: unknown): string {
  const output = boundedText(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(output)) throw validationError();
  return output;
}

function language(value: unknown): string {
  const output = boundedText(value, 32);
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(output)) throw validationError();
  return output;
}

function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)) throw validationError();
  return value.trim();
}

function positiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) throw validationError();
  return Number(value);
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw validationError();
  return value;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
