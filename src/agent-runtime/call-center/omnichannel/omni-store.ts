import { all, id, json, one, parseJson, run } from '../../../db.js';

export type OmniChannel = 'web_chat' | 'sms' | 'email' | 'wechat' | 'whatsapp' | 'facebook_messenger';
export type OmniConversationStatus = 'open' | 'pending' | 'assigned' | 'resolved' | 'closed';

export interface OmniConversation {
  id: string;
  tenant_id: string;
  channel: OmniChannel;
  customer_id: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string;
  status: OmniConversationStatus;
  assigned_seat_id: string | null;
  intent_score: number | null;
  last_message_preview: string;
  last_message_at: string;
  call_session_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OmniMessage {
  id: string;
  conversation_id: string;
  tenant_id: string;
  direction: 'inbound' | 'outbound' | 'system';
  sender_type: 'customer' | 'agent' | 'bot' | 'system';
  content: string;
  content_type: 'text' | 'html' | 'image' | 'file';
  external_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class OmniStore {
  constructor(private readonly db: unknown) {}

  findOrCreateConversation(input: {
    tenant_id: string;
    channel: OmniChannel;
    customer_id?: string;
    customer_name?: string;
    customer_phone?: string;
    customer_email?: string;
  }): OmniConversation {
    const phone = input.customer_phone?.trim() || '';
    const email = input.customer_email?.trim() || '';
    let existing: OmniConversation | null = null;

    if (phone) {
      const row = one(
        this.db,
        `SELECT * FROM omni_conversations WHERE tenant_id = ? AND channel = ? AND customer_phone = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
        [input.tenant_id, input.channel, phone]
      );
      existing = row ? decodeConversation(row) : null;
    } else if (email) {
      const row = one(
        this.db,
        `SELECT * FROM omni_conversations WHERE tenant_id = ? AND channel = ? AND customer_email = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
        [input.tenant_id, input.channel, email]
      );
      existing = row ? decodeConversation(row) : null;
    } else if (input.customer_id && input.channel === 'facebook_messenger') {
      const row = one(
        this.db,
        `SELECT * FROM omni_conversations WHERE tenant_id = ? AND channel = ? AND customer_id = ? AND status != 'closed' ORDER BY updated_at DESC LIMIT 1`,
        [input.tenant_id, input.channel, input.customer_id]
      );
      existing = row ? decodeConversation(row) : null;
    }

    if (existing) return existing;

    const convId = id('omni');
    const now = new Date().toISOString();
    run(
      this.db,
      `INSERT INTO omni_conversations
        (id, tenant_id, channel, customer_id, customer_name, customer_phone, customer_email, last_message_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        convId,
        input.tenant_id,
        input.channel,
        input.customer_id || '',
        input.customer_name || '',
        phone,
        email,
        now,
        now,
        now
      ]
    );
    return this.getConversation(convId)!;
  }

  getConversation(convId: string): OmniConversation | null {
    const row = one(this.db, 'SELECT * FROM omni_conversations WHERE id = ?', [convId]);
    return row ? decodeConversation(row) : null;
  }

  listInbox(
    tenantId: string,
    opts: { status?: OmniConversationStatus | null; channel?: OmniChannel | null; seat_id?: string | null } = {}
  ): OmniConversation[] {
    const conditions = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    if (opts.channel) {
      conditions.push('channel = ?');
      params.push(opts.channel);
    }
    if (opts.seat_id) {
      conditions.push('assigned_seat_id = ?');
      params.push(opts.seat_id);
    }
    const sql = `SELECT * FROM omni_conversations WHERE ${conditions.join(' AND ')} ORDER BY last_message_at DESC LIMIT 100`;
    return all(this.db, sql, params).map(decodeConversation);
  }

  assignConversation(convId: string, tenantId: string, seatId: string): OmniConversation | null {
    run(
      this.db,
      `UPDATE omni_conversations SET assigned_seat_id = ?, status = 'assigned', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?`,
      [seatId, convId, tenantId]
    );
    return this.getConversation(convId);
  }

  updateConversation(
    convId: string,
    patch: Partial<{
      status: OmniConversationStatus;
      intent_score: number;
      call_session_id: string | null;
      metadata: Record<string, unknown>;
    }>,
    tenantId?: string
  ): OmniConversation | null {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.status !== undefined) {
      fields.push('status = ?');
      params.push(patch.status);
    }
    if (patch.intent_score !== undefined) {
      fields.push('intent_score = ?');
      params.push(patch.intent_score);
    }
    if (patch.call_session_id !== undefined) {
      fields.push('call_session_id = ?');
      params.push(patch.call_session_id);
    }
    if (patch.metadata !== undefined) {
      fields.push('metadata = ?');
      params.push(json(patch.metadata));
    }
    if (!fields.length) return this.getConversation(convId);
    fields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(convId);
    const whereClause = tenantId ? 'WHERE id = ? AND tenant_id = ?' : 'WHERE id = ?';
    if (tenantId) params.push(tenantId);
    run(this.db, `UPDATE omni_conversations SET ${fields.join(', ')} ${whereClause}`, params);
    return this.getConversation(convId);
  }

  appendMessage(input: {
    conversation_id: string;
    tenant_id: string;
    direction: OmniMessage['direction'];
    sender_type: OmniMessage['sender_type'];
    content: string;
    content_type?: OmniMessage['content_type'];
    external_id?: string | null;
    metadata?: Record<string, unknown>;
  }): OmniMessage {
    const msgId = id('omsg');
    const preview = input.content.slice(0, 200);
    const now = new Date().toISOString();
    run(
      this.db,
      `INSERT INTO omni_messages
        (id, conversation_id, tenant_id, direction, sender_type, content, content_type, external_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        msgId,
        input.conversation_id,
        input.tenant_id,
        input.direction,
        input.sender_type,
        input.content,
        input.content_type || 'text',
        input.external_id || null,
        json(input.metadata || {})
      ]
    );
    run(
      this.db,
      `UPDATE omni_conversations SET last_message_preview = ?, last_message_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
      [preview, now, now, input.conversation_id, input.tenant_id]
    );
    return this.getMessage(msgId)!;
  }

  getMessage(msgId: string, tenantId?: string): OmniMessage | null {
    const row = tenantId
      ? one(this.db, 'SELECT * FROM omni_messages WHERE id = ? AND tenant_id = ?', [msgId, tenantId])
      : one(this.db, 'SELECT * FROM omni_messages WHERE id = ?', [msgId]);
    return row ? decodeMessage(row) : null;
  }

  listMessages(conversationId: string, limit = 100, tenantId?: string): OmniMessage[] {
    const sql = tenantId
      ? 'SELECT * FROM omni_messages WHERE conversation_id = ? AND tenant_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT * FROM omni_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?';
    const params = tenantId ? [conversationId, tenantId, limit] : [conversationId, limit];
    return all(
      this.db,
      sql,
      params
    ).map(decodeMessage);
  }
}

function decodeConversation(row: Record<string, unknown>): OmniConversation {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    channel: String(row.channel) as OmniChannel,
    customer_id: String(row.customer_id || ''),
    customer_name: String(row.customer_name || ''),
    customer_phone: String(row.customer_phone || ''),
    customer_email: String(row.customer_email || ''),
    status: String(row.status) as OmniConversationStatus,
    assigned_seat_id: row.assigned_seat_id ? String(row.assigned_seat_id) : null,
    intent_score: row.intent_score != null ? Number(row.intent_score) : null,
    last_message_preview: String(row.last_message_preview || ''),
    last_message_at: String(row.last_message_at),
    call_session_id: row.call_session_id ? String(row.call_session_id) : null,
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at || row.created_at)
  };
}

function decodeMessage(row: Record<string, unknown>): OmniMessage {
  return {
    id: String(row.id),
    conversation_id: String(row.conversation_id),
    tenant_id: String(row.tenant_id),
    direction: String(row.direction) as OmniMessage['direction'],
    sender_type: String(row.sender_type) as OmniMessage['sender_type'],
    content: String(row.content),
    content_type: String(row.content_type || 'text') as OmniMessage['content_type'],
    external_id: row.external_id ? String(row.external_id) : null,
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at)
  };
}
