import type { JsonRecord } from '../../integrations/provider-runtime-types.js';
import type { ChannelAdapter, InboundMessage } from '../channel-adapter-registry.js';

export interface EmailAdapterOptions {
  createTransport?: (config: JsonRecord) => {
    sendMail: (mail: JsonRecord) => Promise<{ messageId?: string; response?: string }>;
  };
}

export function createEmailAdapter(options: EmailAdapterOptions = {}): ChannelAdapter {
  return {
    normalizeInbound(raw) {
      return normalizeEmailInbound(raw);
    },
    deliverOutbound(message) {
      return deliverEmail(message, options);
    }
  };
}

async function deliverEmail(message: JsonRecord, options: EmailAdapterOptions): Promise<JsonRecord> {
  const to = String(message.to || message.lead_contact || '').trim();
  const subject = String(message.subject || '').trim();
  const text = String(message.text || message.message || '').trim();
  const from = String(message.from || message.sender || '').trim();
  const channelAccountId = String(message.channel_account_id || from).trim();

  if (!to) return { status: 'failed', failure_reason: 'email adapter: missing recipient (to)' };
  if (!subject && !text) return { status: 'failed', failure_reason: 'email adapter: missing subject and body' };

  let createTransport = options.createTransport;
  if (!createTransport) {
    try {
      const nodemailer = await import('nodemailer');
      createTransport = nodemailer.createTransport as unknown as typeof createTransport;
    } catch {
      return {
        status: 'manual_fallback_required',
        failure_reason: 'email adapter: nodemailer not installed',
        channel: 'email',
        to,
        subject
      };
    }
  }
  if (!createTransport) {
    return {
      status: 'manual_fallback_required',
      failure_reason: 'email adapter: nodemailer transport not configured',
      channel: 'email',
      to,
      subject
    };
  }

  const config = record(message.runtime_config || message.config || {});
  const host = String(config.host || config.smtp_host || '').trim();
  const port = Number(config.port || config.smtp_port || 587);
  const user = String(config.user || config.smtp_user || config.username || '').trim();
  const pass = String(config.password || config.pass || config.smtp_pass || '').trim();
  const secure = config.secure === true || port === 465;
  const configFrom = String(config.from || config.sender || '').trim();
  const effectiveFrom = from || configFrom;

  if (!host) return { status: 'manual_fallback_required', failure_reason: 'email adapter: missing SMTP host', channel: 'email', to, subject };
  if (!user) return { status: 'manual_fallback_required', failure_reason: 'email adapter: missing SMTP user', channel: 'email', to, subject };
  if (!pass) return { status: 'manual_fallback_required', failure_reason: 'email adapter: missing SMTP password', channel: 'email', to, subject };
  if (!effectiveFrom) return { status: 'manual_fallback_required', failure_reason: 'email adapter: missing sender address', channel: 'email', to, subject };

  try {
    const transporter = createTransport({ host, port, secure, auth: { user, pass } });
    const info = await transporter.sendMail({
      from: effectiveFrom,
      to,
      subject: subject || '(无主题)',
      text,
      html: message.html || undefined
    });
    return {
      status: 'sent',
      channel: 'email',
      external_message_id: info.messageId || `email:${Date.now()}`,
      raw_receipt_summary: info.response || 'accepted',
      sent_at: new Date().toISOString(),
      to,
      subject,
      channel_account_id: channelAccountId
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      status: 'failed',
      channel: 'email',
      failure_reason: `email adapter send failed: ${err.message}`,
      to,
      subject
    };
  }
}

function normalizeEmailInbound(raw: JsonRecord = {}): InboundMessage {
  return {
    messageId: raw.messageId || raw.message_id || raw.MessageID || `email:${Date.now()}`,
    tenantId: raw.tenantId || raw.tenant_id || '',
    workspaceId: raw.workspaceId || raw.workspace_id || 'default',
    channel: 'email',
    channelAccountId: raw.channelAccountId || raw.channel_account_id || raw.to || '',
    externalUserId: raw.externalUserId || raw.external_user_id || raw.from || '',
    internalUserId: raw.internalUserId || raw.internal_user_id || '',
    threadId: raw.threadId || raw.thread_id || raw.message_id || '',
    businessObjectType: raw.businessObjectType || raw.business_object_type || '',
    businessObjectId: raw.businessObjectId || raw.business_object_id || '',
    text: raw.text || raw.body || raw.html || '',
    attachments: raw.attachments || [],
    receivedAt: raw.receivedAt || raw.received_at || raw.date || new Date().toISOString(),
    signatureVerified: Boolean(raw.signatureVerified || raw.signature_verified)
  };
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
