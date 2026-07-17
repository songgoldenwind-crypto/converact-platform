import { canonicalNotificationJson } from '../canonical.js';
import { NotificationError } from '../errors.js';
import type {
  NotificationDeliveryProvider,
  NotificationProviderDeliveryInput,
  NotificationProviderDeliveryResult
} from '../ports.js';
import type { NotificationChannel } from '../types.js';
import {
  notificationRetryAfterMs,
  parseNotificationHttpUrl,
  pinnedNotificationHttpRequest,
  resolveNotificationHttpDestination,
  type NotificationAddressResolver,
  type NotificationHttpRequest
} from './http-destination.js';

export type HttpNotificationProviderKind = 'email_http' | 'sms_http';

export interface HttpNotificationProviderOptions {
  kind: HttpNotificationProviderKind;
  channel: 'email' | 'sms';
  profile_id?: string;
  url: string;
  token: string;
  timeout_ms?: number;
  allow_http?: boolean;
  allow_private_networks?: boolean;
  resolve?: NotificationAddressResolver;
  fetch?: typeof globalThis.fetch;
  request?: NotificationHttpRequest;
  now?: () => Date;
}

export class HttpNotificationProvider implements NotificationDeliveryProvider {
  readonly kind: HttpNotificationProviderKind;
  readonly channel: NotificationChannel;
  readonly profile_id?: string;
  readonly #url: URL;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #allowPrivateNetworks: boolean;
  readonly #resolve?: NotificationAddressResolver;
  readonly #request: NotificationHttpRequest;
  readonly #now: () => Date;

  constructor(options: HttpNotificationProviderOptions) {
    if ((options.kind === 'email_http') !== (options.channel === 'email')) throw validationError();
    this.kind = options.kind;
    this.channel = options.channel;
    this.profile_id = options.profile_id;
    this.#url = parseNotificationHttpUrl(options.url, options.allow_http === true);
    this.#token = options.token;
    if (Buffer.byteLength(this.#token) < 16 || Buffer.byteLength(this.#token) > 4096) {
      throw validationError();
    }
    this.#timeoutMs = boundedInteger(options.timeout_ms, 10_000, 1_000, 60_000);
    this.#allowPrivateNetworks = options.allow_private_networks === true;
    this.#resolve = options.resolve;
    this.#request = options.request || (options.fetch
      ? ((url, init) => options.fetch!(url, init))
      : pinnedNotificationHttpRequest);
    this.#now = options.now || (() => new Date());
  }

  async deliver(input: NotificationProviderDeliveryInput): Promise<NotificationProviderDeliveryResult> {
    let message: Readonly<Record<string, unknown>>;
    try {
      validateRecipient(this.channel, input.recipient);
      message = validateMessage(this.channel, input.payload);
    } catch {
      return { status: 'terminal_failure', error_code: 'invalid_payload' };
    }
    const destination = await resolveNotificationHttpDestination({
      url: this.#url,
      ...(this.#resolve ? { resolve: this.#resolve } : {}),
      allow_private_networks: this.#allowPrivateNetworks
    });
    if (destination.status === 'unsafe') {
      return { status: 'terminal_failure', error_code: 'unsafe_provider_destination' };
    }
    if (destination.status === 'unavailable') {
      return { status: 'retryable_failure', error_code: 'provider_dns_unavailable' };
    }
    const body = canonicalNotificationJson({
      schema_version: 1,
      delivery_id: input.delivery.id,
      idempotency_key: input.delivery.provider_idempotency_key,
      tenant_id: input.notification.tenant_id,
      event_type: input.notification.event_type,
      locale: input.notification.locale,
      recipient: input.recipient,
      message,
      business_ref: {
        type: input.notification.business_ref_type,
        id: input.notification.business_ref_id
      },
      metadata: {
        priority: input.notification.priority,
        force_delivery: input.notification.force_delivery
      }
    });
    let response: Response;
    try {
      response = await this.#request(this.#url, {
        method: 'POST', redirect: 'manual',
        headers: {
          authorization: `Bearer ${this.#token}`,
          'content-type': 'application/json',
          'user-agent': 'ivekit-notifications/1',
          'x-ivekit-delivery': input.delivery.id,
          'x-ivekit-idempotency-key': input.delivery.provider_idempotency_key
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs)
      }, destination.addresses);
    } catch {
      return { status: 'uncertain', error_code: 'provider_result_unknown' };
    }
    const receipt = { http_status: response.status };
    if (response.status >= 300 && response.status < 400) {
      return { status: 'terminal_failure', error_code: 'redirect_forbidden', receipt };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'terminal_failure', error_code: 'provider_auth_failed', receipt };
    }
    if (response.status === 429) {
      return {
        status: 'retryable_failure', error_code: 'rate_limited',
        retry_after_ms: notificationRetryAfterMs(response.headers.get('retry-after'), this.#now()),
        receipt
      };
    }
    if ([408, 425].includes(response.status) || response.status >= 500) {
      return { status: 'retryable_failure', error_code: 'provider_unavailable', receipt };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: 'terminal_failure', error_code: 'provider_rejected', receipt };
    }
    if (response.status === 204) {
      return { status: 'accepted', receipt: { ...receipt, provider_status: 'accepted' } };
    }
    const parsed = await responseProjection(response);
    if (!parsed) return { status: 'uncertain', error_code: 'provider_protocol_mismatch', receipt };
    const providerStatus = parsed.status;
    const projectedReceipt = { ...receipt, provider_status: providerStatus };
    if (providerStatus === 'rejected') {
      return { status: 'terminal_failure', error_code: 'provider_rejected', receipt: projectedReceipt };
    }
    return {
      status: providerStatus,
      ...(parsed.request_id ? { provider_request_id: parsed.request_id } : {}),
      ...(parsed.message_id ? { provider_message_id: parsed.message_id } : {}),
      receipt: projectedReceipt
    };
  }
}

function validateRecipient(channel: NotificationChannel, value: string): void {
  if (channel === 'sms') {
    if (!/^\+[1-9]\d{7,14}$/.test(value)) throw validationError();
    return;
  }
  if (!/^[^\s@<>\r\n]{1,64}@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,63}$/.test(value)) {
    throw validationError();
  }
}

function validateMessage(
  channel: NotificationChannel,
  value: unknown
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  const record = value as Record<string, unknown>;
  if (channel === 'sms') {
    const text = String(record.text || '');
    if (!text.trim() || Buffer.byteLength(text) > 4096) throw validationError();
    return { text };
  }
  const subject = String(record.subject || '');
  const text = String(record.text || '');
  const html = String(record.html || '');
  if (!subject.trim() || /[\r\n]/.test(subject) || Buffer.byteLength(subject) > 998
    || (!text.trim() && !html.trim()) || Buffer.byteLength(text) + Buffer.byteLength(html) > 786_432) {
    throw validationError();
  }
  return { subject, ...(text ? { text } : {}), ...(html ? { html } : {}) };
}

async function responseProjection(response: Response): Promise<{
  status: 'accepted' | 'delivered' | 'rejected';
  request_id: string;
  message_id: string;
} | null> {
  try {
    const text = await response.text();
    if (!text || Buffer.byteLength(text) > 65_536) return null;
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !['accepted', 'delivered', 'rejected'].includes(String(value.status))) return null;
    return {
      status: String(value.status) as 'accepted' | 'delivered' | 'rejected',
      request_id: safeId(value.request_id),
      message_id: safeId(value.message_id)
    };
  } catch {
    return null;
  }
}

function safeId(value: unknown): string {
  const result = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/.test(result) ? result : '';
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw validationError();
  return result;
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
