import { NotificationError } from '../errors.js';
import type {
  NotificationDeliveryProvider,
  NotificationProviderDeliveryInput,
  NotificationProviderDeliveryResult
} from '../ports.js';

export interface NotificationSmtpTransportResult {
  accepted?: unknown[];
  rejected?: unknown[];
  messageId?: string;
  response?: string;
}

export interface NotificationSmtpTransport {
  sendMail(input: Record<string, unknown>): Promise<NotificationSmtpTransportResult>;
}

export interface SmtpNotificationProviderOptions {
  profile_id?: string;
  from: string;
  reply_to?: string;
  transport: NotificationSmtpTransport;
}

export class SmtpNotificationProvider implements NotificationDeliveryProvider {
  readonly kind = 'smtp';
  readonly channel = 'email' as const;
  readonly profile_id?: string;
  readonly #from: string;
  readonly #replyTo: string;
  readonly #transport: NotificationSmtpTransport;

  constructor(options: SmtpNotificationProviderOptions) {
    this.profile_id = options.profile_id;
    this.#from = normalizeEmail(options.from);
    this.#replyTo = options.reply_to ? normalizeEmail(options.reply_to) : '';
    this.#transport = options.transport;
  }

  async deliver(input: NotificationProviderDeliveryInput): Promise<NotificationProviderDeliveryResult> {
    let recipient: string;
    let content: { subject: string; text: string; html: string };
    try {
      recipient = normalizeEmail(input.recipient);
      content = emailContent(input.payload);
    } catch {
      return { status: 'terminal_failure', error_code: 'invalid_payload' };
    }
    const messageId = stableMessageId(input.delivery.id, input.delivery.provider_idempotency_key, this.#from);
    let result: NotificationSmtpTransportResult;
    try {
      result = await this.#transport.sendMail({
        from: this.#from,
        to: recipient,
        ...(this.#replyTo ? { replyTo: this.#replyTo } : {}),
        subject: content.subject,
        ...(content.text ? { text: content.text } : {}),
        ...(content.html ? { html: content.html } : {}),
        messageId,
        headers: {
          'X-IveKit-Delivery': input.delivery.id,
          'X-IveKit-Event': input.notification.event_type,
          'X-IveKit-Idempotency-Key': input.delivery.provider_idempotency_key
        }
      });
    } catch (error) {
      return classifySmtpError(error);
    }
    const acceptedCount = Array.isArray(result.accepted) ? result.accepted.length : 0;
    const rejectedCount = Array.isArray(result.rejected) ? result.rejected.length : 0;
    const receipt = {
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      smtp_status: smtpStatus(result.response)
    };
    if (acceptedCount < 1) {
      return { status: 'terminal_failure', error_code: 'invalid_recipient', receipt };
    }
    return {
      status: 'accepted',
      provider_message_id: safeMessageId(result.messageId) || messageId,
      receipt
    };
  }
}

function emailContent(value: unknown): { subject: string; text: string; html: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError();
  const record = value as Record<string, unknown>;
  const subject = String(record.subject || '');
  const text = String(record.text || '');
  const html = String(record.html || '');
  if (!subject.trim() || /[\r\n]/.test(subject) || Buffer.byteLength(subject) > 998) {
    throw validationError();
  }
  if (!text.trim() && !html.trim()) throw validationError();
  if (Buffer.byteLength(text) > 524_288 || Buffer.byteLength(html) > 524_288
    || Buffer.byteLength(text) + Buffer.byteLength(html) > 786_432) {
    throw validationError();
  }
  return { subject, text, html };
}

function normalizeEmail(value: string): string {
  if (typeof value !== 'string') throw validationError();
  const trimmed = value.trim();
  const match = trimmed.match(/^([^\s@<>\r\n]{1,64})@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/);
  if (!match || !match[2].includes('.')) throw validationError();
  return `${match[1]}@${match[2].toLowerCase()}`;
}

function stableMessageId(deliveryId: string, idempotencyKey: string, from: string): string {
  const domain = from.split('@')[1];
  const suffix = idempotencyKey.replace(/^notify_/, '').slice(0, 16);
  if (!/^[A-Za-z0-9_.-]{1,255}$/.test(deliveryId) || !/^[a-f0-9]{16}$/.test(suffix)) {
    throw validationError();
  }
  return `<${deliveryId}.${suffix}@${domain}>`;
}

function classifySmtpError(error: unknown): NotificationProviderDeliveryResult {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const responseCode = Number(value.responseCode || 0);
  if ([530, 534, 535, 538].includes(responseCode)) {
    return { status: 'terminal_failure', error_code: 'provider_auth_failed' };
  }
  if (responseCode >= 400 && responseCode < 500) {
    return { status: 'retryable_failure', error_code: 'provider_unavailable' };
  }
  if (responseCode >= 500) {
    return { status: 'terminal_failure', error_code: 'provider_rejected' };
  }
  return { status: 'uncertain', error_code: 'provider_result_unknown' };
}

function smtpStatus(response: string | undefined): number {
  const match = String(response || '').match(/\b([245]\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function safeMessageId(value: string | undefined): string {
  const result = String(value || '').trim();
  return result.length <= 255 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(result) ? result : '';
}

function validationError(): NotificationError {
  return new NotificationError({ code: 'validation_failed', status: 422 });
}

