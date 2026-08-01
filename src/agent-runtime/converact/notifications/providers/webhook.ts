import { createHmac } from 'node:crypto';

import { canonicalNotificationJson } from '../canonical.js';
import { NotificationError } from '../errors.js';
import type {
  NotificationDeliveryProvider,
  NotificationProviderDeliveryInput,
  NotificationProviderDeliveryResult
} from '../ports.js';
import {
  notificationRetryAfterMs,
  parseNotificationHttpUrl,
  pinnedNotificationHttpRequest,
  resolveNotificationAddresses,
  resolveNotificationHttpDestination,
  type NotificationHttpRequest
} from './http-destination.js';

export interface WebhookNotificationProviderOptions {
  profile_id?: string;
  url: string;
  signing_secret: string;
  timeout_ms?: number;
  allow_http?: boolean;
  allowed_ports?: readonly number[];
  resolve?: (hostname: string) => Promise<readonly string[]>;
  fetch?: typeof globalThis.fetch;
  request?: NotificationHttpRequest;
  now?: () => Date;
}

export class WebhookNotificationProvider implements NotificationDeliveryProvider {
  readonly kind = 'webhook';
  readonly channel = 'webhook' as const;
  readonly profile_id?: string;
  readonly #url: URL;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #allowedPorts: ReadonlySet<number>;
  readonly #resolve: (hostname: string) => Promise<readonly string[]>;
  readonly #request: NotificationHttpRequest;
  readonly #now: () => Date;

  constructor(options: WebhookNotificationProviderOptions) {
    this.profile_id = options.profile_id;
    this.#url = parseNotificationHttpUrl(options.url, options.allow_http === true);
    this.#secret = options.signing_secret;
    if (Buffer.byteLength(this.#secret) < 32 || Buffer.byteLength(this.#secret) > 4096) {
      throw validationError();
    }
    this.#timeoutMs = boundedInteger(options.timeout_ms, 10_000, 1_000, 60_000);
    const defaultPort = this.#url.protocol === 'https:' ? 443 : 80;
    this.#allowedPorts = new Set(options.allowed_ports || [defaultPort]);
    const effectivePort = Number(this.#url.port || defaultPort);
    if (!this.#allowedPorts.has(effectivePort)) throw validationError();
    this.#resolve = options.resolve || resolveNotificationAddresses;
    this.#request = options.request || (options.fetch
      ? ((url, init) => options.fetch!(url, init))
      : pinnedNotificationHttpRequest);
    this.#now = options.now || (() => new Date());
  }

  async deliver(input: NotificationProviderDeliveryInput): Promise<NotificationProviderDeliveryResult> {
    let recipientUrl: URL;
    try {
      recipientUrl = parseNotificationHttpUrl(input.recipient, this.#url.protocol === 'http:');
    } catch {
      return { status: 'terminal_failure', error_code: 'unsafe_webhook_destination' };
    }
    if (recipientUrl.toString() !== this.#url.toString()) {
      return { status: 'terminal_failure', error_code: 'recipient_mismatch' };
    }
    const destination = await resolveNotificationHttpDestination({
      url: this.#url,
      resolve: this.#resolve
    });
    if (destination.status === 'unavailable') {
      return { status: 'retryable_failure', error_code: 'webhook_dns_unavailable' };
    }
    if (destination.status === 'unsafe') {
      return { status: 'terminal_failure', error_code: 'unsafe_webhook_destination' };
    }

    const now = this.#now();
    const timestamp = String(Math.floor(now.getTime() / 1000));
    let body: string;
    try {
      body = canonicalNotificationJson({
        id: input.delivery.id,
        event: input.notification.event_type,
        tenant_id: input.notification.tenant_id,
        timestamp: input.notification.created_at,
        business_ref: {
          type: input.notification.business_ref_type,
          id: input.notification.business_ref_id
        },
        data: input.payload
      });
      if (Buffer.byteLength(body) > 1_048_576) throw new Error();
    } catch {
      return { status: 'terminal_failure', error_code: 'invalid_payload' };
    }
    const signature = createHmac('sha256', this.#secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    const integrationEventId = integrationEventHeader(input.payload);
    let response: Response;
    try {
      response = await this.#request(this.#url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'converact-notifications/1',
          'x-ivekit-delivery': input.delivery.id,
          'x-ivekit-event': input.notification.event_type,
          ...(integrationEventId ? { 'x-ivekit-event-id': integrationEventId } : {}),
          'x-ivekit-idempotency-key': input.delivery.provider_idempotency_key,
          'x-ivekit-timestamp': timestamp,
          'x-ivekit-signature': `v1=${signature}`
        },
        body,
        signal: AbortSignal.timeout(this.#timeoutMs)
      }, destination.addresses);
    } catch {
      return { status: 'uncertain', error_code: 'provider_result_unknown' };
    }
    const receipt = { http_status: response.status };
    const requestId = safeHeader(response.headers.get('x-request-id'));
    if (response.status >= 200 && response.status < 300) {
      return {
        status: 'delivered',
        ...(requestId ? { provider_request_id: requestId } : {}),
        provider_message_id: input.delivery.id,
        receipt
      };
    }
    if (response.status >= 300 && response.status < 400) {
      return { status: 'terminal_failure', error_code: 'redirect_forbidden', receipt };
    }
    if (response.status === 429) {
      return {
        status: 'retryable_failure',
        error_code: 'rate_limited',
        retry_after_ms: notificationRetryAfterMs(response.headers.get('retry-after'), now),
        receipt
      };
    }
    if ([408, 425].includes(response.status) || response.status >= 500) {
      return { status: 'retryable_failure', error_code: 'provider_unavailable', receipt };
    }
    return { status: 'terminal_failure', error_code: 'provider_rejected', receipt };
  }
}

function safeHeader(value: string | null): string {
  const trimmed = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/.test(trimmed) ? trimmed : '';
}

function integrationEventHeader(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const candidate = payload as Record<string, unknown>;
  if (candidate.schema_version !== 1 || typeof candidate.event_id !== 'string') return '';
  return safeHeader(candidate.event_id);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw validationError();
  return result;
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}
