import type { ChatwootClient } from './chatwoot-client.js';

export interface ChatwootWebhookPayload {
  event: string;
  id?: number;
  content?: string;
  content_type?: string;
  message_type?: 'incoming' | 'outgoing';
  conversation?: {
    id: number;
    inbox_id: number;
    contact_id: number;
    status: string;
    custom_attributes?: Record<string, unknown>;
  };
  sender?: {
    id: number;
    name: string;
    type: string;
  };
  account?: {
    id: number;
  };
}

export interface ChatwootWebhookResult {
  handled: boolean;
  action?: 'auto_reply' | 'assign_agent' | 'label_added' | 'ignored';
  reply?: string;
}

const HIGH_INTENT_KEYWORDS = ['价格', '多少钱', '报价', '购买', '下单', '合同', '签约'];

export function generateAutoReply(message: string, _language: string = 'zh'): string {
  if (message.includes('价格') || message.includes('多少钱'))
    return '感谢您的咨询！我们的产品价格根据需求定制，请问您需要了解哪方面的服务？';
  if (message.includes('预约') || message.includes('约'))
    return '好的，我来为您安排。请问您方便的时间是？';
  return '您好！感谢您的消息，我们会尽快回复您。如有紧急需求，请致电我们的客服热线。';
}

function isHighIntent(content: string): boolean {
  return HIGH_INTENT_KEYWORDS.some((kw) => content.includes(kw));
}

export async function handleChatwootWebhook(
  payload: ChatwootWebhookPayload,
  deps: {
    chatwootClient: ChatwootClient;
    tenantId: string;
    autoReplyEnabled?: boolean;
  }
): Promise<ChatwootWebhookResult> {
  const { chatwootClient } = deps;
  const autoReply = deps.autoReplyEnabled ?? true;

  if (payload.event === 'conversation_created' && payload.conversation) {
    await chatwootClient.addLabel(payload.conversation.id, ['new_lead']);
    return { handled: true, action: 'label_added' };
  }

  if (
    payload.event === 'message_created' &&
    payload.message_type === 'incoming' &&
    payload.sender?.type === 'contact' &&
    payload.conversation
  ) {
    const content = payload.content ?? '';
    const conversationId = payload.conversation.id;

    if (isHighIntent(content)) {
      await chatwootClient.addLabel(conversationId, ['high_intent']);
      return { handled: true, action: 'assign_agent' };
    }

    if (autoReply) {
      const reply = generateAutoReply(content);
      await chatwootClient.sendMessage(conversationId, reply);
      return { handled: true, action: 'auto_reply', reply };
    }

    return { handled: false, action: 'ignored' };
  }

  return { handled: false, action: 'ignored' };
}
