import { all, id, json, run } from '../../../db.js';
import { broadcastOmniMessage } from '../../../call-center-events.js';
import { KnowledgeStore } from '../knowledge/knowledge-store.js';
import { retrieveAndAnswer } from '../knowledge/knowledge-retriever.js';
import { isEnvLlmConfigured } from '../../integrations/llm-env-client.js';
import { createSMSSender } from '../sms-sender.js';
import type { OmniStore } from './omni-store.js';

export interface ChatbotReply {
  content: string;
  intent_score: number;
  should_escalate: boolean;
  sources: string[];
}

const HIGH_INTENT_KEYWORDS = ['购买', '签约', '价格', '报价', '预约', 'buy', 'price', 'demo', '试用'];

export async function generateOmniChatbotReply(
  db: unknown,
  tenantId: string,
  customerMessage: string,
  history: Array<{ role: string; content: string }>
): Promise<ChatbotReply> {
  let intentScore = 0.2;
  for (const kw of HIGH_INTENT_KEYWORDS) {
    if (customerMessage.includes(kw)) intentScore = Math.max(intentScore, 0.75);
  }

  const kb = new KnowledgeStore(db);
  const docs = kb.searchDocuments(tenantId, customerMessage, { limit: 5 });

  if (docs.length && isEnvLlmConfigured()) {
    const result = await retrieveAndAnswer(
      customerMessage,
      docs.map((d) => ({ id: d.id, title: d.title, content: d.content })),
      {}
    );
    intentScore = Math.max(intentScore, result.confidence);
    return {
      content: result.answer,
      intent_score: intentScore,
      should_escalate: intentScore >= 0.7,
      sources: result.sources.map((s) => s.title)
    };
  }

  const fallback =
    history.length < 2
      ? '您好，我是智能客服助手。请问有什么可以帮您？'
      : '我已记录您的问题，稍后会有专员与您联系。';
  return {
    content: fallback,
    intent_score: intentScore,
    should_escalate: intentScore >= 0.7,
    sources: []
  };
}

export function recordJourneyEvent(
  db: unknown,
  input: {
    tenant_id: string;
    customer_key: string;
    event_type: string;
    channel: string;
    summary: string;
    ref_id?: string | null;
    metadata?: Record<string, unknown>;
    occurred_at?: string;
  }
): void {
  run(
    db,
    `INSERT INTO customer_journey_events (id, tenant_id, customer_key, event_type, channel, summary, ref_id, metadata, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id('journey'),
      input.tenant_id,
      input.customer_key,
      input.event_type,
      input.channel,
      input.summary,
      input.ref_id || null,
      json(input.metadata || {}),
      input.occurred_at || new Date().toISOString()
    ]
  );
}

export function getCustomerJourney(db: unknown, tenantId: string, customerKey: string, limit = 50) {
  return all(
    db,
    `SELECT * FROM customer_journey_events WHERE tenant_id = ? AND customer_key = ? ORDER BY occurred_at DESC LIMIT ?`,
    [tenantId, customerKey, limit]
  ).map((row) => ({
    id: String((row as { id: string }).id),
    event_type: String((row as { event_type: string }).event_type),
    channel: String((row as { channel: string }).channel),
    summary: String((row as { summary: string }).summary),
    ref_id: (row as { ref_id: string | null }).ref_id ? String((row as { ref_id: string }).ref_id) : null,
    occurred_at: String((row as { occurred_at: string }).occurred_at)
  }));
}

export function buildCustomerKey(conv: {
  customer_phone?: string;
  phone?: string;
  customer_email?: string;
  email?: string;
  customer_id?: string;
}): string {
  const phone = conv.customer_phone || conv.phone;
  const email = conv.customer_email || conv.email;
  if (phone) return `phone:${phone}`;
  if (email) return `email:${email}`;
  if (conv.customer_id) return `id:${conv.customer_id}`;
  return 'anonymous';
}

export async function processInboundOmniMessage(
  db: unknown,
  store: OmniStore,
  input: {
    tenant_id: string;
    channel: 'web_chat' | 'sms' | 'email' | 'wechat' | 'whatsapp' | 'facebook_messenger';
    content: string;
    customer_name?: string;
    customer_phone?: string;
    customer_email?: string;
    customer_id?: string;
    external_id?: string;
    skip_bot?: boolean;
  }
) {
  const conv = store.findOrCreateConversation({
    tenant_id: input.tenant_id,
    channel: input.channel,
    customer_id: input.customer_id,
    customer_name: input.customer_name,
    customer_phone: input.customer_phone,
    customer_email: input.customer_email
  });

  const inbound = store.appendMessage({
    conversation_id: conv.id,
    tenant_id: input.tenant_id,
    direction: 'inbound',
    sender_type: 'customer',
    content: input.content,
    external_id: input.external_id
  });

  const sentiment = detectSentiment(input.content);
  if (sentiment.label !== 'neutral') {
    store.updateConversation(conv.id, {
      metadata: { ...conv.metadata, last_sentiment: sentiment }
    });
  }

  let outbound = null;
  let botReply: ChatbotReply | null = null;

  if (!input.skip_bot && conv.status !== 'assigned') {
    const history = store.listMessages(conv.id).map((m) => ({
      role: m.sender_type === 'customer' ? 'customer' : 'agent',
      content: m.content
    }));
    botReply = await generateOmniChatbotReply(db, input.tenant_id, input.content, history);
    outbound = store.appendMessage({
      conversation_id: conv.id,
      tenant_id: input.tenant_id,
      direction: 'outbound',
      sender_type: 'bot',
      content: botReply.content,
      metadata: { sources: botReply.sources }
    });

    if (botReply.intent_score >= 0.5) {
      store.updateConversation(conv.id, { intent_score: botReply.intent_score });
    }
    if (botReply.should_escalate) {
      store.updateConversation(conv.id, { status: 'pending' });
      // Broadcast escalation event so agent panel / SSE can pick it up.
      // Previously: set to 'pending' but no one was notified — conversation
      // sat unhandled. Now emits an event for agent dispatch.
      try {
        broadcastOmniMessage(input.tenant_id, {
          conversation_id: conv.id,
          message: { type: 'escalation', conversation_id: conv.id, intent_score: botReply.intent_score } as unknown as Record<string, unknown>
        });
      } catch { /* non-critical — broadcast best-effort */ }
    }
  }

  const customerKey = buildCustomerKey(conv);
  recordJourneyEvent(db, {
    tenant_id: input.tenant_id,
    customer_key: customerKey,
    event_type: 'message_inbound',
    channel: input.channel,
    summary: input.content.slice(0, 120),
    ref_id: conv.id,
    metadata: { sentiment }
  });

  return {
    conversation: store.getConversation(conv.id)!,
    inbound,
    outbound,
    bot_reply: botReply,
    sentiment
  };
}

export function scheduleNotification(
  db: unknown,
  input: {
    tenant_id: string;
    channel: 'sms' | 'email';
    target: string;
    template_key: string;
    payload: Record<string, unknown>;
    scheduled_at: string;
  }
): string {
  const notifyId = id('onotify');
  run(
    db,
    `INSERT INTO omni_notifications (id, tenant_id, channel, target, template_key, payload, scheduled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      notifyId,
      input.tenant_id,
      input.channel,
      input.target,
      input.template_key,
      json(input.payload),
      input.scheduled_at
    ]
  );
  return notifyId;
}

export function pickDueNotifications(db: unknown, limit = 20) {
  return all(
    db,
    `SELECT * FROM omni_notifications WHERE status = 'pending' AND datetime(scheduled_at) <= datetime('now') ORDER BY scheduled_at ASC LIMIT ?`,
    [limit]
  );
}

export function markNotificationSent(db: unknown, notifyId: string, error: string | null = null): void {
  run(
    db,
    `UPDATE omni_notifications SET status = ?, sent_at = CURRENT_TIMESTAMP, error = ? WHERE id = ?`,
    [error ? 'failed' : 'sent', error, notifyId]
  );
}

const ANGER_KEYWORDS = ['投诉', '愤怒', '太差', '垃圾', '骗子', 'refund', 'angry', 'terrible', 'scam'];

export function detectSentiment(text: string): { label: 'neutral' | 'negative' | 'angry'; score: number } {
  const lower = text.toLowerCase();
  let angryHits = 0;
  for (const kw of ANGER_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) angryHits++;
  }
  if (angryHits >= 2) return { label: 'angry', score: 0.9 };
  if (angryHits === 1) return { label: 'negative', score: 0.7 };
  if (/[!！]{2,}/.test(text)) return { label: 'negative', score: 0.55 };
  return { label: 'neutral', score: 0.1 };
}

const NOTIFICATION_TEMPLATES: Record<string, (payload: Record<string, unknown>) => string> = {
  appointment_reminder: (p) =>
    `【预约提醒】您预约的${String(p.time || '服务')}将于${String(p.when || '稍后')}开始，请准时参加。`,
  verification_code: (p) => `【验证码】${String(p.code || '000000')}，5分钟内有效。`
};

export async function processDueNotifications(db: unknown, limit = 20): Promise<number> {
  const due = pickDueNotifications(db, limit);
  const sms = createSMSSender();
  let sent = 0;

  for (const row of due) {
    const notifyId = String((row as { id: string }).id);
    const channel = String((row as { channel: string }).channel);
    const target = String((row as { target: string }).target);
    const templateKey = String((row as { template_key: string }).template_key);
    const tenantId = String((row as { tenant_id: string }).tenant_id);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(String((row as { payload: string }).payload || '{}')) as Record<string, unknown>;
    } catch {
      console.warn('[omni-service] invalid JSON payload for notification, skipping:', (row as { id?: string }).id);
      markNotificationSent(db, String((row as { id: string }).id));
      continue;
    }

    try {
      if (channel === 'sms') {
        const builder = NOTIFICATION_TEMPLATES[templateKey];
        const body = builder ? builder(payload) : String(payload.body || '');
        const result = await sms.send({ to: target, body, tenant_id: tenantId });
        if (!result.success) throw new Error(result.error || 'sms send failed');
      }
      markNotificationSent(db, notifyId);
      sent++;
    } catch (err) {
      markNotificationSent(db, notifyId, err instanceof Error ? err.message : String(err));
    }
  }
  return sent;
}
