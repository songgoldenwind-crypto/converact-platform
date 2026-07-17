import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

import { canonicalNotificationJson } from '../../notifications/canonical.js';
import { IveKitOperationsError } from './errors.js';
import type { IveKitAuditRepository } from './ports.js';
import type {
  IveKitAuditAppendResult,
  IveKitAuditListInput,
  IveKitAuditPage,
  IveKitAuditRequest
} from './types.js';

export class IveKitAuditService {
  readonly #repository: IveKitAuditRepository;
  readonly #ipHmacKey: Buffer;
  readonly #now: () => Date;

  constructor(input: {
    repository: IveKitAuditRepository;
    ip_hmac_key: string;
    now?: () => Date;
  }) {
    this.#repository = input.repository;
    this.#ipHmacKey = decodeKey(input.ip_hmac_key);
    this.#now = input.now || (() => new Date());
  }

  async append(input: IveKitAuditRequest): Promise<IveKitAuditAppendResult> {
    const occurredAt = input.occurred_at
      ? timestamp(input.occurred_at)
      : this.#now().toISOString();
    const sourceIp = normalizeIp(input.source_ip);
    return this.#repository.append({
      tenant_id: requiredText(input.tenant_id, 255),
      actor_id: requiredText(input.actor_id, 255),
      actor_role: enumValue(input.actor_role, ['owner', 'admin', 'operator', 'viewer', 'system', 'provider']),
      action: requiredText(input.action, 255),
      resource_type: requiredText(input.resource_type, 100),
      resource_id: requiredText(input.resource_id, 255),
      business_ref_type: requiredText(input.business_ref?.type, 100),
      business_ref_id: requiredText(input.business_ref?.id, 255),
      request_id: requiredText(input.request_id, 255),
      idempotency_key: requiredText(input.idempotency_key, 255),
      result: enumValue(input.result, ['succeeded', 'failed', 'denied', 'accepted']),
      policy_decision: enumValue(input.policy_decision, ['allow', 'deny', 'not_applicable']),
      source_ip_hmac: sourceIp
        ? createHmac('sha256', this.#ipHmacKey).update(sourceIp).digest('hex')
        : '',
      metadata: safeMetadata(input.metadata || {}),
      occurred_at: occurredAt,
      retention_until: input.retention_until == null ? null : timestamp(input.retention_until),
      legal_hold: input.legal_hold === true
    });
  }

  list(input: IveKitAuditListInput): Promise<IveKitAuditPage> {
    return this.#repository.list({
      tenant_id: requiredText(input.tenant_id, 255),
      limit: input.limit,
      cursor: input.cursor,
      action: optionalText(input.action, 255),
      resource_type: optionalText(input.resource_type, 100),
      resource_id: optionalText(input.resource_id, 255)
    });
  }

  async exportJsonl(input: IveKitAuditListInput & { max_events?: number }): Promise<string> {
    const max = boundedInteger(input.max_events, 10_000, 1, 100_000);
    const lines: string[] = [];
    let cursor = input.cursor;
    while (lines.length < max) {
      const page = await this.list({ ...input, cursor, limit: Math.min(500, max - lines.length) });
      for (const event of page.items) lines.push(canonicalNotificationJson(event));
      if (!page.next_cursor || !page.items.length) break;
      cursor = page.next_cursor;
    }
    return lines.length ? `${lines.join('\n')}\n` : '';
  }
}

const FORBIDDEN_KEYS = /(?:secret|token|password|authorization|cookie|phone|mobile|email|address|body|content|absolute_path|file_path)/i;
const EMAIL_VALUE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_VALUE = /(?:^|\D)\+?\d[\d\s()-]{8,}\d(?:$|\D)/;

function safeMetadata(value: unknown, depth = 0): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || depth > 5) throw validationError();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key) || FORBIDDEN_KEYS.test(key)) throw validationError();
    if (item && typeof item === 'object') {
      if (Array.isArray(item)) {
        if (item.length > 100) throw validationError();
        for (const nested of item) validateMetadataValue(nested, depth + 1);
      } else safeMetadata(item, depth + 1);
    } else validateMetadataValue(item, depth);
  }
  const canonical = canonicalNotificationJson(value);
  if (Buffer.byteLength(canonical) > 32_768) throw validationError();
  return JSON.parse(canonical) as Record<string, unknown>;
}

function validateMetadataValue(value: unknown, depth: number): void {
  if (typeof value === 'string') {
    if (value.length > 2_048 || EMAIL_VALUE.test(value) || PHONE_VALUE.test(value)) throw validationError();
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    safeMetadata(value, depth + 1);
    return;
  }
  throw validationError();
}

function normalizeIp(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw validationError();
  const ip = value.split(',')[0].trim();
  if (!isIP(ip)) throw validationError();
  return ip.toLowerCase();
}

function decodeKey(value: string): Buffer {
  const key = Buffer.from(String(value || ''), 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '')
    !== String(value || '').replace(/=+$/, '')) throw validationError();
  return key;
}

function requiredText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw validationError();
  return value.trim();
}

function optionalText(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, max);
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw validationError();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw validationError();
  return date.toISOString();
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw validationError();
  return value as T;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw validationError();
  return value;
}

function validationError(): IveKitOperationsError {
  return new IveKitOperationsError('validation_failed', 422);
}
