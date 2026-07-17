import { createHash, randomUUID } from 'node:crypto';

import { canonicalNotificationJson } from './canonical.js';
import { NotificationError } from './errors.js';
import type { NotificationEndpointAdminRepository } from './ports.js';
import type {
  CreateNotificationEndpointInput,
  NotificationEndpoint,
  NotificationEndpointCreateResult,
  NotificationEndpointProviderKind,
  UpdateNotificationEndpointInput
} from './types.js';
import { parseNotificationHttpUrl } from './providers/http-destination.js';

export class NotificationEndpointService {
  readonly #repository: NotificationEndpointAdminRepository;
  readonly #id: () => string;
  readonly #now: () => Date;
  readonly #allowControlled: boolean;

  constructor(input: {
    repository: NotificationEndpointAdminRepository;
    id?: () => string;
    now?: () => Date;
    allow_controlled?: boolean;
  }) {
    this.#repository = input.repository;
    this.#id = input.id || randomUUID;
    this.#now = input.now || (() => new Date());
    this.#allowControlled = input.allow_controlled === true;
  }

  async create(input: CreateNotificationEndpointInput): Promise<NotificationEndpointCreateResult> {
    const now = this.#now().toISOString();
    const normalized = normalizeEndpointInput(input, this.#allowControlled);
    const payloadHash = sha256(canonicalNotificationJson({ ...normalized, actor: input.actor }));
    return this.#repository.insertEndpoint({
      id: this.#id(),
      tenant_id: input.tenant_id,
      ...normalized,
      health_status: 'unknown',
      last_health_at: null,
      revision: 1,
      idempotency_key: input.idempotency_key,
      payload_hash: payloadHash,
      created_by: input.actor,
      updated_by: input.actor,
      created_at: now,
      updated_at: now
    });
  }

  async update(input: UpdateNotificationEndpointInput): Promise<NotificationEndpoint> {
    required(input.tenant_id, 255);
    required(input.endpoint_id, 255);
    required(input.actor, 255);
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) throw validationError();
    const current = await this.#repository.getEndpoint(input.tenant_id, input.endpoint_id);
    if (!current) throw new NotificationError({ code: 'not_found', status: 404 });
    const candidate = { ...current, ...input.patch, updated_by: input.actor };
    const normalized = normalizeEndpointInput({
      tenant_id: candidate.tenant_id,
      actor: candidate.updated_by,
      name: candidate.name,
      channel: candidate.channel,
      provider_kind: candidate.provider_kind,
      status: candidate.status,
      endpoint_url: candidate.endpoint_url,
      secret_ref: candidate.secret_ref,
      signing_secret_ref: candidate.signing_secret_ref,
      event_allowlist: candidate.event_allowlist,
      config: candidate.config,
      failover_group: candidate.failover_group,
      priority: candidate.priority,
      quota_per_minute: candidate.quota_per_minute,
      quota_per_day: candidate.quota_per_day,
      idempotency_key: candidate.idempotency_key
    }, this.#allowControlled);
    const configurationChanged = canonicalNotificationJson({
      endpoint_url: current.endpoint_url,
      secret_ref: current.secret_ref,
      signing_secret_ref: current.signing_secret_ref,
      event_allowlist: current.event_allowlist,
      config: current.config
    }) !== canonicalNotificationJson({
      endpoint_url: normalized.endpoint_url,
      secret_ref: normalized.secret_ref,
      signing_secret_ref: normalized.signing_secret_ref,
      event_allowlist: normalized.event_allowlist,
      config: normalized.config
    });
    return this.#repository.updateEndpoint({
      ...current,
      ...normalized,
      health_status: configurationChanged ? 'unknown' : current.health_status,
      last_health_at: configurationChanged ? null : current.last_health_at,
      updated_by: input.actor,
      updated_at: this.#now().toISOString()
    }, input.expected_revision);
  }
}

function normalizeEndpointInput(
  input: CreateNotificationEndpointInput,
  allowControlled: boolean
): Pick<NotificationEndpoint,
  'name' | 'channel' | 'provider_kind' | 'status' | 'endpoint_url' | 'secret_ref'
  | 'signing_secret_ref' | 'event_allowlist' | 'config' | 'failover_group' | 'priority'
  | 'quota_per_minute' | 'quota_per_day'> {
  required(input.tenant_id, 255);
  required(input.actor, 255);
  const name = required(input.name, 255);
  required(input.idempotency_key, 128);
  const config = safeConfig(input.config || {});
  const endpointUrl = String(input.endpoint_url || '').trim();
  const secretRef = String(input.secret_ref || '').trim();
  const signingSecretRef = String(input.signing_secret_ref || '').trim();
  const expectedChannels: Record<NotificationEndpointProviderKind, NotificationEndpoint['channel'] | null> = {
    webhook: 'webhook', smtp: 'email', email_http: 'email', sms_http: 'sms', controlled: null
  };
  if (expectedChannels[input.provider_kind] && expectedChannels[input.provider_kind] !== input.channel) {
    throw validationError();
  }
  if (input.provider_kind === 'controlled' && !allowControlled) throw validationError();
  if (input.provider_kind === 'webhook') {
    parseNotificationHttpUrl(endpointUrl, config.allow_http === true);
    validateHealthConfig(config, input.provider_kind);
    secretReference(signingSecretRef);
    if (secretRef) throw validationError();
  } else if (input.provider_kind === 'email_http' || input.provider_kind === 'sms_http') {
    parseNotificationHttpUrl(endpointUrl, config.allow_http === true);
    validateHealthConfig(config, input.provider_kind);
    secretReference(secretRef);
    if (signingSecretRef) throw validationError();
  } else if (input.provider_kind === 'smtp') {
    if (endpointUrl || signingSecretRef) throw validationError();
    secretReference(secretRef);
    validateSmtpConfig(config);
    validateHealthConfig(config, input.provider_kind);
  }
  const eventAllowlist = [...new Set((input.event_allowlist || []).map((item) => required(item, 255)))].sort();
  if (eventAllowlist.length > 256
    || eventAllowlist.some((event) => !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(event))) {
    throw validationError();
  }
  return {
    name,
    channel: input.channel,
    provider_kind: input.provider_kind,
    status: input.status || 'active',
    endpoint_url: endpointUrl,
    secret_ref: secretRef,
    signing_secret_ref: signingSecretRef,
    event_allowlist: eventAllowlist,
    config,
    failover_group: required(input.failover_group || 'default', 128),
    priority: optionalInteger(input.priority, 100, 0, 10_000),
    quota_per_minute: optionalNullableInteger(input.quota_per_minute),
    quota_per_day: optionalNullableInteger(input.quota_per_day)
  };
}

function validateHealthConfig(
  config: Readonly<Record<string, unknown>>,
  providerKind: NotificationEndpointProviderKind
): void {
  if (config.health_url !== undefined) {
    if (providerKind === 'smtp') throw validationError();
    parseNotificationHttpUrl(String(config.health_url), config.allow_http === true);
  }
  if (config.health_method !== undefined
    && !['HEAD', 'GET'].includes(String(config.health_method).toUpperCase())) throw validationError();
  if (config.health_timeout_ms !== undefined) {
    optionalInteger(Number(config.health_timeout_ms), 10_000, 1_000, 60_000);
  }
}

function safeConfig(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    rejectSecretKeys(value);
    const canonical = canonicalNotificationJson(value);
    if (Buffer.byteLength(canonical) > 65_536) throw new Error();
    return JSON.parse(canonical) as Record<string, unknown>;
  } catch {
    throw validationError();
  }
}

function rejectSecretKeys(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretKeys(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/(?:^|_)(?:password|pass|token|secret|authorization|api_key|credential)(?:$|_)/i.test(key)) {
      throw new Error();
    }
    rejectSecretKeys(item);
  }
}

function validateSmtpConfig(config: Readonly<Record<string, unknown>>): void {
  const allowed = new Set([
    'host', 'port', 'user', 'from', 'reply_to', 'secure', 'require_tls', 'timeout_ms',
    'health_timeout_ms'
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key))) throw validationError();
  for (const key of ['host', 'user', 'from']) {
    if (typeof config[key] !== 'string' || !String(config[key]).trim()) throw validationError();
  }
  const port = optionalInteger(Number(config.port), 587, 1, 65_535);
  if (port !== 465 && config.require_tls !== true && config.secure !== true) throw validationError();
  if (!/^[^\s@<>\r\n]{1,64}@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}$/.test(String(config.from))) {
    throw validationError();
  }
}

function secretReference(value: string): void {
  if (!/^(?:env|vault|secret):\/\/[A-Za-z0-9_.:/-]{1,1000}$/.test(value)) throw validationError();
}

function required(value: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function optionalInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw validationError();
  return result;
}

function optionalNullableInteger(value: number | null | undefined): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000_000) throw validationError();
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
