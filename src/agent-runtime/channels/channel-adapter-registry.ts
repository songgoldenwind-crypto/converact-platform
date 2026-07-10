import { createEmailAdapter } from './adapters/email-adapter.js';
import { createWeComAdapter } from './adapters/wecom-adapter.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export interface ChannelAdapterDefinition {
  channel: string;
  provider: string;
  status: string;
  supports_inbound: boolean;
  supports_outbound: boolean;
  risk_level: string;
}

export interface InboundMessage extends JsonRecord {
  messageId: string;
  tenantId: string;
  workspaceId: string;
  channel: string;
  receivedAt: string;
  attachments: unknown[];
  signatureVerified: boolean;
}

export interface ChannelAdapter {
  normalizeInbound: (rawMessage: JsonRecord) => Promise<InboundMessage> | InboundMessage;
  deliverOutbound: (message: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

export interface ChannelAdapterEntry {
  definition: ChannelAdapterDefinition;
  adapter: ChannelAdapter;
}

export class ChannelAdapterRegistry {
  adapters: Map<string, ChannelAdapterEntry>;

  constructor() {
    this.adapters = new Map();
  }

  register(definition: Partial<ChannelAdapterDefinition> & { channel: string; provider: string }, adapter: ChannelAdapter): void {
    if (!definition?.channel) throw new Error('channel is required');
    if (this.adapters.has(definition.channel)) throw new Error(`duplicate channel adapter: ${definition.channel}`);
    if (typeof adapter.normalizeInbound !== 'function') throw new Error(`normalizeInbound is required for ${definition.channel}`);
    if (typeof adapter.deliverOutbound !== 'function') throw new Error(`deliverOutbound is required for ${definition.channel}`);
    this.adapters.set(definition.channel, {
      definition: Object.freeze({
        status: 'planned',
        supports_inbound: true,
        supports_outbound: true,
        risk_level: 'R2',
        ...definition
      }),
      adapter
    });
  }

  get(channel: string): ChannelAdapterEntry {
    const entry = this.adapters.get(channel);
    if (!entry) throw new Error(`channel adapter not registered: ${channel}`);
    return entry;
  }

  list(): ChannelAdapterDefinition[] {
    return [...this.adapters.values()].map((entry) => entry.definition);
  }

  async normalizeInbound(channel: string, rawMessage: JsonRecord): Promise<InboundMessage> {
    const { definition, adapter } = this.get(channel);
    const normalized = await adapter.normalizeInbound(rawMessage);
    assertInboundMessage(definition, normalized);
    return {
      channel: definition.channel,
      signatureVerified: false,
      attachments: [],
      ...normalized
    };
  }

  async deliverOutbound(channel: string, message: JsonRecord): Promise<JsonRecord> {
    const { definition, adapter } = this.get(channel);
    if (!definition.supports_outbound) throw new Error(`channel does not support outbound delivery: ${channel}`);
    return adapter.deliverOutbound(message);
  }
}

export interface RegisterDefaultChannelAdaptersOptions {
  emailTransportFactory?: (config: JsonRecord) => {
    sendMail: (mail: JsonRecord) => Promise<{ messageId?: string; response?: string }>;
  };
  wechatFetchFactory?: typeof fetch;
}

export function registerDefaultChannelAdapters(registry: ChannelAdapterRegistry, options: RegisterDefaultChannelAdaptersOptions = {}): void {
  registry.register(
    {
      channel: 'web_app',
      provider: 'opc-native',
      status: 'native',
      supports_inbound: true,
      supports_outbound: false,
      risk_level: 'R1'
    },
    createNativeAdapter('web_app')
  );
  registry.register(
    {
      channel: 'api',
      provider: 'opc-native',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R2'
    },
    createNativeAdapter('api')
  );
  registry.register(
    {
      channel: 'chatwoot',
      provider: 'chatwoot',
      status: 'planned',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R3'
    },
    createQueuedOutboundAdapter('chatwoot')
  );
  registry.register(
    {
      channel: 'telegram',
      provider: 'telegram',
      status: 'planned',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R3'
    },
    createQueuedOutboundAdapter('telegram')
  );
  registry.register(
    {
      channel: 'voice_rustpbx',
      provider: 'rustpbx',
      status: 'planned',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R3'
    },
    createQueuedOutboundAdapter('voice_rustpbx')
  );
  registry.register(
    {
      channel: 'voice_webrtc',
      provider: 'opc-native-webrtc',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R2'
    },
    createQueuedOutboundAdapter('voice_webrtc')
  );
  registry.register(
    {
      channel: 'email',
      provider: 'opc-native-smtp',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R3'
    },
    createEmailAdapter({ createTransport: options.emailTransportFactory })
  );
  registry.register(
    {
      channel: 'wechat',
      provider: 'opc-native-wecom',
      status: 'native',
      supports_inbound: true,
      supports_outbound: true,
      risk_level: 'R3'
    },
    createWeComAdapter({ fetch: options.wechatFetchFactory })
  );
}

function createNativeAdapter(channel: string): ChannelAdapter {
  return {
    async normalizeInbound(raw) {
      return normalizeCommonInbound(channel, raw);
    },
    async deliverOutbound() {
      throw new Error(`channel does not support outbound delivery: ${channel}`);
    }
  };
}

function createQueuedOutboundAdapter(channel: string): ChannelAdapter {
  return {
    async normalizeInbound(raw) {
      return normalizeCommonInbound(channel, raw);
    },
    async deliverOutbound(message) {
      return {
        status: 'queued_for_adapter',
        channel,
        delivery_id: `${channel}:${message.tenantId || message.tenant_id}:${message.threadId || message.thread_id || 'default'}`
      };
    }
  };
}

function normalizeCommonInbound(channel: string, raw: JsonRecord = {}): InboundMessage {
  return {
    messageId: raw.messageId || raw.message_id || `${channel}:${raw.externalMessageId || raw.id || Date.now()}`,
    tenantId: raw.tenantId || raw.tenant_id,
    workspaceId: raw.workspaceId || raw.workspace_id || 'default',
    channel,
    channelAccountId: raw.channelAccountId || raw.channel_account_id || '',
    externalUserId: raw.externalUserId || raw.external_user_id || raw.from || '',
    internalUserId: raw.internalUserId || raw.internal_user_id || '',
    threadId: raw.threadId || raw.thread_id || raw.conversation_id || '',
    businessObjectType: raw.businessObjectType || raw.business_object_type || raw.object_type || '',
    businessObjectId: raw.businessObjectId || raw.business_object_id || raw.object_id || '',
    text: raw.text || raw.message || raw.body || '',
    attachments: raw.attachments || [],
    receivedAt: raw.receivedAt || raw.received_at || new Date().toISOString(),
    signatureVerified: Boolean(raw.signatureVerified || raw.signature_verified)
  };
}

function assertInboundMessage(definition: ChannelAdapterDefinition, message: InboundMessage): void {
  for (const field of ['messageId', 'tenantId', 'workspaceId', 'channel', 'receivedAt']) {
    if (!message[field]) throw new Error(`inbound ${definition.channel} message missing ${field}`);
  }
  if (message.channel !== definition.channel) throw new Error(`inbound message channel mismatch: ${message.channel}`);
}
