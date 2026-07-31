import { createHash, randomUUID } from 'node:crypto';

import { canonicalNotificationJson } from './canonical.js';
import { NotificationError } from './errors.js';
import type { NotificationContentProtector, NotificationRepository } from './ports.js';
import type {
  CreateNotificationInput,
  NotificationCreateResult,
  NotificationDeliveryRecord,
  NotificationPriority,
  NotificationRecord,
  NotificationTargetInput
} from './types.js';
import { observeNotificationCreated } from './metrics.js';

export interface NotificationServiceInput {
  repository: NotificationRepository;
  protector: NotificationContentProtector;
  id?: () => string;
  now?: () => Date;
  prepare?: (input: CreateNotificationInput) => Promise<CreateNotificationInput>;
}

export class NotificationService {
  readonly #repository: NotificationRepository;
  readonly #protector: NotificationContentProtector;
  readonly #id: () => string;
  readonly #now: () => Date;
  readonly #prepare?: (input: CreateNotificationInput) => Promise<CreateNotificationInput>;

  constructor(input: NotificationServiceInput) {
    this.#repository = input.repository;
    this.#protector = input.protector;
    this.#id = input.id || randomUUID;
    this.#now = input.now || (() => new Date());
    this.#prepare = input.prepare;
  }

  async create(input: CreateNotificationInput): Promise<NotificationCreateResult> {
    const authority = requestAuthority(input);
    input = this.#prepare ? await this.#prepare(input) : input;
    if (canonicalNotificationJson(requestAuthority(input))
      !== canonicalNotificationJson(authority)) throw validationError();
    validateInput(input);
    const createdAt = this.#now().toISOString();
    const notificationId = this.#id();
    const content = await this.#protector.protectContent(input.tenant_id, input.content);
    const projection = safeRecord(input.content_projection || {});
    const protectedTargets = await Promise.all(input.targets.map(async (target) => ({
      target,
      secured: await this.#protector.protectRecipient(
        input.tenant_id,
        target.channel,
        target.recipient
      )
    })));
    ensureUniqueTargets(protectedTargets);
    const channels = [...new Set(input.targets.map((target) => target.channel))].sort();
    const payloadHash = sha256(canonicalNotificationJson({
      event_type: input.event_type,
      recipient: input.recipient,
      targets: protectedTargets.map(({ target, secured }) => ({
        channel: target.channel,
        endpoint_id: target.endpoint_id || '',
        recipient_hmac: secured.hmac
      })).sort((left, right) => canonicalNotificationJson(left).localeCompare(canonicalNotificationJson(right))),
      content_hash: content.hash,
      content_projection: projection,
      priority: input.priority || 'normal',
      force_delivery: input.force_delivery === true,
      locale: input.locale || '',
      template: input.template || null,
      business_ref: input.business_ref,
      policy: safeRecord(input.policy || {}),
      scheduled_at: input.scheduled_at || null,
      retention_until: input.retention_until || null
    }));
    const notification: NotificationRecord = {
      id: notificationId,
      tenant_id: input.tenant_id,
      event_type: input.event_type,
      recipient_kind: input.recipient.kind,
      recipient_ref: input.recipient.ref,
      channels,
      locale: input.locale || '',
      template_id: input.template?.id || null,
      template_revision: input.template?.revision || null,
      content_ciphertext: content.ciphertext,
      content_projection: projection,
      priority: input.priority || 'normal',
      force_delivery: input.force_delivery === true,
      business_ref_type: input.business_ref.type,
      business_ref_id: input.business_ref.id,
      requested_by: input.requested_by,
      correlation_id: input.correlation_id || '',
      idempotency_key: input.idempotency_key,
      payload_hash: payloadHash,
      policy: safeRecord(input.policy || {}),
      state: 'pending',
      scheduled_at: input.scheduled_at || createdAt,
      retention_until: input.retention_until || null,
      created_at: createdAt,
      updated_at: createdAt,
      completed_at: null
    };
    const deliveries: NotificationDeliveryRecord[] = protectedTargets.map(({ target, secured }) => ({
      id: this.#id(),
      tenant_id: input.tenant_id,
      notification_id: notificationId,
      channel: target.channel,
      endpoint_id: target.endpoint_id || null,
      provider_kind: 'unresolved',
      provider_profile_id: '',
      recipient_ciphertext: secured.ciphertext,
      recipient_hmac: secured.hmac,
      recipient_redacted: secured.redacted,
      payload_ciphertext: content.ciphertext,
      payload_hash: content.hash,
      provider_idempotency_key: providerIdempotencyKey({
        tenant_id: input.tenant_id,
        notification_id: notificationId,
        target,
        recipient_hmac: secured.hmac
      }),
      state: 'pending',
      attempt_count: 0,
      max_attempts: input.max_attempts || 5,
      next_attempt_at: input.scheduled_at || createdAt,
      lease_token_hash: '',
      lease_until: null,
      worker_id: '',
      provider_request_id: '',
      provider_message_id: '',
      provider_receipt_projection: {},
      error_code: '',
      error_projection: {},
      created_at: createdAt,
      updated_at: createdAt,
      accepted_at: null,
      delivered_at: null,
      completed_at: null
    }));
    const result = await this.#repository.create({ notification, deliveries });
    if (result.created) observeNotificationCreated(result.notification.channels);
    return result;
  }
}

function requestAuthority(input: CreateNotificationInput): Record<string, unknown> {
  return {
    tenant_id: input.tenant_id,
    event_type: input.event_type,
    recipient: input.recipient,
    business_ref: input.business_ref,
    requested_by: input.requested_by,
    idempotency_key: input.idempotency_key,
    force_delivery: input.force_delivery === true,
    template: input.template || null
  };
}

function validateInput(input: CreateNotificationInput): void {
  required(input.tenant_id, 255);
  required(input.event_type, 255);
  required(input.recipient.ref, 255);
  required(input.business_ref.type, 100);
  required(input.business_ref.id, 255);
  required(input.requested_by, 255);
  required(input.idempotency_key, 128);
  if (!input.targets.length || input.targets.length > 16) throw validationError();
  if (input.recipient.kind !== 'user' && input.targets.some((target) => target.channel === 'in_app')) {
    throw validationError();
  }
  if (input.recipient.kind === 'endpoint' && input.targets.some((target) => target.channel !== 'webhook')) {
    throw validationError();
  }
  if (input.template && (!required(input.template.id, 255) || !Number.isInteger(input.template.revision)
    || input.template.revision < 1)) throw validationError();
  if (input.max_attempts !== undefined && (!Number.isInteger(input.max_attempts)
    || input.max_attempts < 1 || input.max_attempts > 20)) throw validationError();
  for (const target of input.targets) {
    required(target.recipient, 2048);
    if (target.endpoint_id !== undefined) required(target.endpoint_id, 255);
    if (target.channel === 'in_app' && target.recipient !== input.recipient.ref) throw validationError();
  }
  for (const value of [input.scheduled_at, input.retention_until]) {
    if (value != null && !validTimestamp(value)) throw validationError();
  }
  if (input.scheduled_at && input.retention_until
    && Date.parse(input.retention_until) <= Date.parse(input.scheduled_at)) throw validationError();
  validatePriority(input.priority);
}

function ensureUniqueTargets(
  targets: ReadonlyArray<{
    target: NotificationTargetInput;
    secured: { hmac: string };
  }>
): void {
  const keys = targets.map(({ target, secured }) =>
    `${target.channel}\0${secured.hmac}\0${target.endpoint_id || ''}`
  );
  if (new Set(keys).size !== keys.length) throw validationError();
}

function safeRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  try {
    const canonical = canonicalNotificationJson(value);
    if (Buffer.byteLength(canonical) > 65_536) throw new Error();
    return JSON.parse(canonical) as Record<string, unknown>;
  } catch {
    throw validationError();
  }
}

function providerIdempotencyKey(input: {
  tenant_id: string;
  notification_id: string;
  target: NotificationTargetInput;
  recipient_hmac: string;
}): string {
  return `notify_${sha256(canonicalNotificationJson({
    tenant_id: input.tenant_id,
    notification_id: input.notification_id,
    channel: input.target.channel,
    endpoint_id: input.target.endpoint_id || '',
    recipient_hmac: input.recipient_hmac
  }))}`;
}

function required(value: string, max: number): true {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return true;
}

function validTimestamp(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validatePriority(value: NotificationPriority | undefined): void {
  if (value !== undefined && !['low', 'normal', 'high', 'urgent'].includes(value)) {
    throw validationError();
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
