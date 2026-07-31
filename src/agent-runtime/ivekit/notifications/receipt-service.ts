import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { canonicalNotificationJson } from './canonical.js';
import { NotificationError } from './errors.js';
import type { NotificationReceiptRepository, NotificationSecretResolver } from './ports.js';
import type {
  NotificationReceipt,
  NotificationReceiptPayload,
  NotificationReceiptResult,
  ReceiveNotificationReceiptInput
} from './types.js';

export class NotificationReceiptService {
  readonly #repository: NotificationReceiptRepository;
  readonly #secrets: NotificationSecretResolver;
  readonly #now: () => Date;
  readonly #maxSkewSeconds: number;

  constructor(input: {
    repository: NotificationReceiptRepository;
    secrets: NotificationSecretResolver;
    now?: () => Date;
    max_skew_seconds?: number;
  }) {
    this.#repository = input.repository;
    this.#secrets = input.secrets;
    this.#now = input.now || (() => new Date());
    this.#maxSkewSeconds = input.max_skew_seconds ?? 300;
  }

  async receive(input: ReceiveNotificationReceiptInput): Promise<NotificationReceiptResult> {
    const tenantId = boundedText(input.tenant_id, 255);
    const endpointId = boundedText(input.endpoint_id, 255);
    const body = receiptPayload(input.body);
    const now = this.#now();
    const timestamp = signedTimestamp(input.timestamp, now, this.#maxSkewSeconds);
    const endpoint = await this.#repository.getEndpoint(tenantId, endpointId);
    if (!endpoint || !['active', 'degraded'].includes(endpoint.status)
      || !endpoint.signing_secret_ref) throw authError();
    const secret = await this.#secrets.resolve(endpoint.signing_secret_ref, 'webhook_signing');
    const canonicalBody = canonicalNotificationJson(body);
    verifySignature(input.signature, secret, `${timestamp}.${canonicalBody}`);

    const delivery = await this.#repository.getDelivery(tenantId, body.delivery_id);
    if (!delivery || delivery.endpoint_id !== endpoint.id || delivery.channel !== endpoint.channel) {
      throw new NotificationError({ code: 'not_found', status: 404 });
    }
    const receipt: NotificationReceipt = {
      id: randomUUID(), tenant_id: tenantId, delivery_id: delivery.id,
      provider_kind: endpoint.provider_kind, provider_event_id: body.provider_event_id,
      receipt_status: body.status,
      canonical_hash: createHash('sha256').update(canonicalBody).digest('hex'),
      projection: body.projection || {}, occurred_at: body.occurred_at || null,
      received_at: now.toISOString()
    };
    const inserted = await this.#repository.insertReceipt(receipt);
    if (!inserted) throw new NotificationError({ code: 'idempotency_conflict', status: 409 });
    return {
      ...inserted,
      reconciliation: await this.#repository.reconcileReceipt(inserted.receipt)
    };
  }
}

function receiptPayload(input: NotificationReceiptPayload): NotificationReceiptPayload {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw validationError();
  const status = String(input.status || '');
  if (!['accepted', 'delivered', 'failed', 'unknown'].includes(status)) throw validationError();
  const projection = input.projection === undefined ? undefined : plainRecord(input.projection);
  const occurredAt = input.occurred_at === undefined
    ? undefined
    : validTimestamp(input.occurred_at);
  return {
    provider_event_id: boundedText(input.provider_event_id, 255),
    delivery_id: boundedText(input.delivery_id, 255),
    status: status as NotificationReceiptPayload['status'],
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    ...(projection ? { projection } : {})
  };
}

function signedTimestamp(value: string, now: Date, maxSkewSeconds: number): string {
  if (!/^\d{10}$/.test(value) || !Number.isInteger(maxSkewSeconds)
    || maxSkewSeconds < 1 || maxSkewSeconds > 3600) throw authError();
  const seconds = Number(value);
  if (Math.abs(Math.floor(now.getTime() / 1000) - seconds) > maxSkewSeconds) throw authError();
  return value;
}

function verifySignature(signature: string, secret: string, payload: string): void {
  const match = String(signature || '').match(/^sha256=([a-f0-9]{64})$/);
  if (!match || !secret) throw authError();
  const actual = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', secret).update(payload).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw authError();
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw validationError();
  const canonical = canonicalNotificationJson(value);
  if (Buffer.byteLength(canonical) > 65_536) throw validationError();
  return value as Readonly<Record<string, unknown>>;
}

function validTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw validationError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw validationError();
  return date.toISOString();
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function authError(): NotificationError {
  return new NotificationError({ code: 'provider_auth_failed', status: 401 });
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
