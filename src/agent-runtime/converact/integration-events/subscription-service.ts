import { createHash, randomUUID } from 'node:crypto';

import type { NotificationEndpointRepository } from '../notifications/ports.js';
import { canonicalNotificationJson } from '../notifications/canonical.js';
import { normalizeConveractFabricEventPatterns } from './catalog.js';
import type {
  CreateConveractFabricEventWebhookSubscriptionInput,
  ConveractFabricEventWebhookSubscription,
  ConveractFabricEventWebhookSubscriptionCreateResult,
  ConveractFabricEventWebhookSubscriptionPage,
  UpdateConveractFabricEventWebhookSubscriptionInput
} from './types.js';

export interface ConveractFabricEventWebhookSubscriptionRepository {
  insert(
    subscription: ConveractFabricEventWebhookSubscription
  ): Promise<ConveractFabricEventWebhookSubscriptionCreateResult>;
  get(tenantId: string, subscriptionId: string): Promise<ConveractFabricEventWebhookSubscription | null>;
  list(input: {
    tenant_id: string;
    status?: ConveractFabricEventWebhookSubscription['status'];
    limit?: number;
    cursor?: string;
  }): Promise<ConveractFabricEventWebhookSubscriptionPage>;
  update(
    subscription: ConveractFabricEventWebhookSubscription,
    expectedRevision: number
  ): Promise<ConveractFabricEventWebhookSubscription>;
}

export class ConveractFabricEventWebhookSubscriptionService {
  readonly #repository: ConveractFabricEventWebhookSubscriptionRepository;
  readonly #endpoints: Pick<NotificationEndpointRepository, 'getEndpoint'>;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(input: {
    repository: ConveractFabricEventWebhookSubscriptionRepository;
    endpoints: Pick<NotificationEndpointRepository, 'getEndpoint'>;
    id?: () => string;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#endpoints = input.endpoints;
    this.#id = input.id || randomUUID;
    this.#now = input.now || (() => new Date());
  }

  async create(
    input: CreateConveractFabricEventWebhookSubscriptionInput
  ): Promise<ConveractFabricEventWebhookSubscriptionCreateResult> {
    const tenantId = required(input.tenant_id, 255, 'tenant_id');
    const actor = required(input.actor, 255, 'actor');
    const endpointId = required(input.endpoint_id, 255, 'endpoint_id');
    const name = required(input.name, 255, 'name');
    const idempotencyKey = required(input.idempotency_key, 128, 'idempotency_key');
    const patterns = normalizeConveractFabricEventPatterns(input.event_patterns);
    await this.#assertEndpoint(tenantId, endpointId, patterns);
    const now = this.#now().toISOString();
    const payloadHash = sha256(canonicalNotificationJson({
      endpoint_id: endpointId,
      name,
      event_patterns: patterns
    }));
    return this.#repository.insert({
      id: this.#id(), tenant_id: tenantId, endpoint_id: endpointId, name,
      event_patterns: patterns, status: 'active', last_event_id: '0',
      next_attempt_at: now, attempt_count: 0, error_code: '', lease_token_hash: '',
      lease_until: null, worker_id: '', revision: 1, idempotency_key: idempotencyKey,
      payload_hash: payloadHash, created_by: actor, updated_by: actor,
      created_at: now, updated_at: now
    });
  }

  get(tenantId: string, subscriptionId: string): Promise<ConveractFabricEventWebhookSubscription | null> {
    return this.#repository.get(
      required(tenantId, 255, 'tenant_id'),
      required(subscriptionId, 255, 'subscription_id')
    );
  }

  list(input: {
    tenant_id: string;
    status?: ConveractFabricEventWebhookSubscription['status'];
    limit?: number;
    cursor?: string;
  }): Promise<ConveractFabricEventWebhookSubscriptionPage> {
    required(input.tenant_id, 255, 'tenant_id');
    return this.#repository.list(input);
  }

  async update(input: UpdateConveractFabricEventWebhookSubscriptionInput): Promise<ConveractFabricEventWebhookSubscription> {
    const tenantId = required(input.tenant_id, 255, 'tenant_id');
    const actor = required(input.actor, 255, 'actor');
    const subscriptionId = required(input.subscription_id, 255, 'subscription_id');
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) {
      throw httpError(422, 'expected_revision is invalid');
    }
    const current = await this.#repository.get(tenantId, subscriptionId);
    if (!current) throw httpError(404, 'event webhook subscription not found');
    if (current.status === 'archived') throw httpError(409, 'archived event webhook subscription is immutable');
    const name = input.patch.name === undefined
      ? current.name : required(input.patch.name, 255, 'name');
    const patterns = input.patch.event_patterns === undefined
      ? current.event_patterns : normalizeConveractFabricEventPatterns(input.patch.event_patterns);
    const status = input.patch.status || current.status;
    await this.#assertEndpoint(tenantId, current.endpoint_id, patterns);
    const updatedAt = this.#now().toISOString();
    return this.#repository.update({
      ...current,
      name,
      event_patterns: patterns,
      status,
      payload_hash: sha256(canonicalNotificationJson({
        endpoint_id: current.endpoint_id,
        name,
        event_patterns: patterns
      })),
      updated_by: actor,
      updated_at: updatedAt
    }, input.expected_revision);
  }

  async archive(input: {
    tenant_id: string;
    actor: string;
    subscription_id: string;
    expected_revision: number;
  }): Promise<ConveractFabricEventWebhookSubscription> {
    const current = await this.get(input.tenant_id, input.subscription_id);
    if (!current) throw httpError(404, 'event webhook subscription not found');
    if (current.status === 'archived') return current;
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) {
      throw httpError(422, 'expected_revision is invalid');
    }
    return this.#repository.update({
      ...current,
      status: 'archived',
      updated_by: required(input.actor, 255, 'actor'),
      updated_at: this.#now().toISOString()
    }, input.expected_revision);
  }

  async #assertEndpoint(tenantId: string, endpointId: string, patterns: readonly string[]): Promise<void> {
    const endpoint = await this.#endpoints.getEndpoint(tenantId, endpointId);
    if (!endpoint) throw httpError(404, 'event webhook endpoint not found');
    if (endpoint.tenant_id !== tenantId || endpoint.channel !== 'webhook'
      || endpoint.provider_kind !== 'webhook' || endpoint.status !== 'active') {
      throw httpError(422, 'event subscription requires an active webhook endpoint');
    }
    if (endpoint.event_allowlist.length && patterns.some((pattern) =>
      pattern.endsWith('.*') || !endpoint.event_allowlist.includes(pattern)
    )) {
      throw httpError(422, 'event subscription exceeds endpoint event allowlist');
    }
  }
}

function required(value: unknown, max: number, field: string): string {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw httpError(422, `${field} is invalid`);
  }
  return text;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
