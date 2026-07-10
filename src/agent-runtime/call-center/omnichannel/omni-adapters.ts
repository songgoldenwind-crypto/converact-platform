import { ChannelAdapterRegistry, registerDefaultChannelAdapters } from '../../channels/channel-adapter-registry.js';
import type { JsonRecord } from '../../integrations/provider-runtime-types.js';
import { createSMSSender } from '../sms-sender.js';
import type { OmniChannel } from './omni-store.js';
import { processInboundOmniMessage } from './omni-service.js';
import type { OmniStore } from './omni-store.js';
import { sendFacebookMessengerReply } from './facebook-adapter.js';
import { FacebookChannelConfigStore } from './facebook-channel-store.js';

export interface OmniAdapterContext {
  db: unknown;
  store: OmniStore;
}

export interface OmniInboundPayload {
  tenant_id: string;
  channel: OmniChannel;
  content: string;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string;
  customer_id?: string;
  external_id?: string;
}

let registrySingleton: ChannelAdapterRegistry | null = null;
let facebookAdapterRegistered = false;

function registerOpcNativeOmniAdapters(registry: ChannelAdapterRegistry): void {
  registry.register(
    {
      channel: 'web_chat',
      provider: 'opc-widget',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R1'
    },
    {
      normalizeInbound(raw) {
        return {
          messageId: String(raw.messageId || raw.message_id || `web_chat:${Date.now()}`),
          tenantId: String(raw.tenantId || raw.tenant_id),
          workspaceId: 'default',
          channel: 'web_chat',
          text: String(raw.text || raw.content || ''),
          receivedAt: new Date().toISOString(),
          signatureVerified: false,
          attachments: []
        };
      },
      async deliverOutbound(message) {
        return { status: 'delivered', channel: 'web_chat', message_id: message.message_id };
      }
    }
  );
  registry.register(
    {
      channel: 'sms',
      provider: 'opc-sms',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R2'
    },
    {
      normalizeInbound(raw) {
        return {
          messageId: String(raw.messageId || raw.message_id || raw.MessageSid || `sms:${Date.now()}`),
          tenantId: String(raw.tenantId || raw.tenant_id),
          workspaceId: 'default',
          channel: 'sms',
          text: String(raw.text || raw.Body || raw.content || ''),
          receivedAt: new Date().toISOString(),
          signatureVerified: Boolean(raw.signatureVerified),
          attachments: []
        };
      },
      async deliverOutbound(message) {
        const sms = createSMSSender();
        const result = await sms.send({
          to: String(message.to || message.target),
          body: String(message.body || message.content),
          tenant_id: String(message.tenantId || message.tenant_id)
        });
        return { status: result.success ? 'sent' : 'failed', message_sid: result.message_sid, error: result.error };
      }
    }
  );
  registry.register(
    {
      channel: 'whatsapp',
      provider: 'opc-whatsapp',
      status: 'planned',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R3'
    },
    {
      normalizeInbound(raw) {
        return {
          messageId: String(raw.messageId || raw.id || `whatsapp:${Date.now()}`),
          tenantId: String(raw.tenantId || raw.tenant_id),
          workspaceId: 'default',
          channel: 'whatsapp',
          text: String(raw.text || raw.content || ''),
          receivedAt: new Date().toISOString(),
          signatureVerified: false,
          attachments: []
        };
      },
      async deliverOutbound(message) {
        return { status: 'queued_for_adapter', channel: 'whatsapp', delivery_id: `wa:${Date.now()}` };
      }
    }
  );
}

function registerFacebookMessengerAdapter(registry: ChannelAdapterRegistry, db: unknown): void {
  if (facebookAdapterRegistered) return;
  facebookAdapterRegistered = true;
  registry.register(
    {
      channel: 'facebook_messenger',
      provider: 'facebook-graph',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R2'
    },
    {
      normalizeInbound(raw) {
        return {
          messageId: String(raw.messageId || raw.message_id || `fb:${Date.now()}`),
          tenantId: String(raw.tenantId || raw.tenant_id),
          workspaceId: 'default',
          channel: 'facebook_messenger',
          text: String(raw.text || raw.content || ''),
          receivedAt: new Date().toISOString(),
          signatureVerified: false,
          attachments: []
        };
      },
      async deliverOutbound(message) {
        const tenantId = String(message.tenant_id || message.tenantId || '');
        const token = new FacebookChannelConfigStore(db).getPageAccessToken(tenantId);
        const result = await sendFacebookMessengerReply({
          pageAccessToken: token,
          recipientId: String(message.to || message.target || ''),
          text: String(message.body || message.content || '')
        });
        return {
          status: result.success ? 'sent' : 'failed',
          message_id: result.message_id,
          error: result.error
        };
      }
    }
  );
}

export function getOmniChannelRegistry(db?: unknown): ChannelAdapterRegistry {
  if (!registrySingleton) {
    registrySingleton = new ChannelAdapterRegistry();
    registerDefaultChannelAdapters(registrySingleton);
    registerOpcNativeOmniAdapters(registrySingleton);
  }
  if (db) registerFacebookMessengerAdapter(registrySingleton, db);
  return registrySingleton;
}

export async function receiveOmniInbound(ctx: OmniAdapterContext, payload: OmniInboundPayload) {
  const registry = getOmniChannelRegistry(ctx.db);
  const normalized = await registry.normalizeInbound(payload.channel, payload as unknown as JsonRecord);
  return processInboundOmniMessage(ctx.db, ctx.store, {
    tenant_id: payload.tenant_id,
    channel: payload.channel,
    content: payload.content || normalized.text || '',
    customer_name: payload.customer_name,
    customer_phone:
      payload.customer_phone || (payload.channel === 'sms' ? String((payload as JsonRecord).from || '') : undefined),
    customer_email: payload.customer_email,
    customer_id: payload.customer_id,
    external_id: payload.external_id || normalized.messageId
  });
}

export async function sendOmniOutbound(
  ctx: OmniAdapterContext,
  input: {
    tenant_id: string;
    channel: OmniChannel;
    conversation_id: string;
    content: string;
    target?: string;
    seat_id?: string;
  }
) {
  const conv = ctx.store.getConversation(input.conversation_id);
  if (!conv || conv.tenant_id !== input.tenant_id) {
    throw Object.assign(new Error('conversation not found'), { status: 404 });
  }

  const msg = ctx.store.appendMessage({
    conversation_id: input.conversation_id,
    tenant_id: input.tenant_id,
    direction: 'outbound',
    sender_type: 'agent',
    content: input.content,
    metadata: input.seat_id ? { seat_id: input.seat_id } : {}
  });

  if (input.channel !== 'web_chat') {
    const registry = getOmniChannelRegistry(ctx.db);
    const target =
      input.target ||
      (input.channel === 'facebook_messenger' ? conv.customer_id : '') ||
      conv.customer_phone ||
      conv.customer_email ||
      '';
    const delivery = await registry.deliverOutbound(input.channel, {
      tenant_id: input.tenant_id,
      to: target,
      body: input.content,
      conversation_id: input.conversation_id
    });
    if (delivery && typeof delivery === 'object' && (delivery as { status?: string }).status === 'failed') {
      console.warn('[omni] outbound delivery failed', input.channel, (delivery as { error?: string }).error);
    }
  }

  return { message: msg, conversation: ctx.store.getConversation(input.conversation_id)! };
}
