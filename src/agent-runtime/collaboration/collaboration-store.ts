import type { PgQueryable } from '../../db-pg.js';
import { pgId, withPgTransaction } from '../../db-pg.js';
import { scanTextPolicy } from './policy-scan.js';
import { PolicyFindingStore } from './policy-finding-store.js';
import type {
  BusinessRef,
  CollaborationChatBinding,
  CollaborationChatSnapshot,
  CollaborationCursorPage,
  CollaborationMessage,
  CollaborationMessageAttachment,
  CollaborationMessageAttachmentKind,
  CollaborationMessageAttachmentStatus,
  CollaborationMessagePin,
  CollaborationMessageReaction,
  CollaborationMessageTranslation,
  CollaborationParticipant,
  CollaborationParticipantRole,
  CollaborationPolicyEvent,
  CollaborationPolicyFinding,
  CollaborationSession,
  CollaborationTimelineItem,
  PolicyScanResult
} from './types.js';
import type { PolicyEvidenceRef, PolicyFindingSource } from './types.js';

export interface CollaborationMessageAttachmentInput {
  kind: CollaborationMessageAttachmentKind;
  storage_url: string;
  filename?: string;
  content_type?: string;
  size_bytes?: number;
  checksum?: string;
  processing_status?: CollaborationMessageAttachmentStatus;
  metadata?: Record<string, unknown>;
}

export interface CollaborationOutgoingMessageInput {
  tenant_id: string;
  session_id: string;
  sender_identity: string;
  message_type: CollaborationMessage['message_type'];
  body: string;
  original_language?: string;
  metadata?: Record<string, unknown>;
  attachments?: CollaborationMessageAttachmentInput[];
  idempotency_key?: string;
  idempotency_payload_hash?: string;
  provider: string;
  provider_topic_id: string;
  provider_payload: string;
  provider_metadata?: Record<string, unknown>;
  provider_delivery_status: CollaborationMessage['provider_delivery']['status'];
  reply_to_message_id?: string;
  forwarded_from_message_id?: string;
  mentions?: string[];
}

export interface CollaborationOutgoingMessageResult {
  message: CollaborationMessage;
  created: boolean;
}

export class CollaborationStore {
  constructor(private readonly pg: PgQueryable) {}

  async openSession(input: {
    tenant_id: string;
    business_ref: BusinessRef;
    title?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CollaborationSession> {
    assertTenantRef(input.tenant_id, input.business_ref);
    const sessionId = pgId('collab');
    const metadata = {
      ...(input.metadata || {}),
      business_ref_display_name: input.business_ref.display_name || '',
      business_ref_metadata: input.business_ref.metadata || {}
    };
    await this.pg.query(
      `INSERT INTO collaboration_sessions
        (id, tenant_id, business_ref_type, business_ref_id, title, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        sessionId,
        input.tenant_id,
        input.business_ref.type,
        input.business_ref.id,
        input.title || '',
        toJson(metadata)
      ]
    );
    return (await this.getSession(sessionId))!;
  }

  async getSession(sessionId: string): Promise<CollaborationSession | null> {
    const result = await this.pg.query('SELECT * FROM collaboration_sessions WHERE id = $1', [sessionId]);
    return result.rows[0] ? decodeSession(result.rows[0]) : null;
  }

  async requireTenantSession(tenantId: string, sessionId: string): Promise<CollaborationSession> {
    const session = await this.getSession(sessionId);
    if (!session || session.tenant_id !== tenantId) {
      throw Object.assign(new Error('collaboration session not found'), { status: 404 });
    }
    return session;
  }

  async listByBusinessRef(input: {
    tenant_id: string;
    business_ref: BusinessRef;
    identity?: string;
    limit?: number;
  }): Promise<CollaborationSession[]> {
    assertTenantRef(input.tenant_id, input.business_ref);
    const result = await this.pg.query(
      `SELECT * FROM collaboration_sessions
       WHERE tenant_id = $1 AND business_ref_type = $2 AND business_ref_id = $3
         AND ($4 = '' OR EXISTS (
           SELECT 1 FROM collaboration_participants AS visible_participant
           WHERE visible_participant.tenant_id = collaboration_sessions.tenant_id
             AND visible_participant.session_id = collaboration_sessions.id
             AND visible_participant.identity = $4
             AND visible_participant.left_at IS NULL
         ))
       ORDER BY created_at DESC
       LIMIT $5`,
      [input.tenant_id, input.business_ref.type, input.business_ref.id, String(input.identity || '').trim(), input.limit || 50]
    );
    return result.rows.map(decodeSession);
  }

  async listSessions(input: {
    tenant_id: string;
    status?: CollaborationSession['status'];
    business_ref_type?: string;
    business_ref_id?: string;
    query?: string;
    identity?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CollaborationCursorPage<CollaborationSession>> {
    const status = String(input.status || '').trim();
    if (status && status !== 'open' && status !== 'closed') {
      throw badRequest('status must be open or closed');
    }
    const limit = pageLimit(input.limit, 50);
    const cursor = decodePageCursor(input.cursor, 'sessions', 'before');
    const result = await this.pg.query(
      `SELECT * FROM collaboration_sessions
       WHERE tenant_id = $1
         AND ($2 = '' OR status = $2)
         AND ($3 = '' OR business_ref_type = $3)
         AND ($4 = '' OR business_ref_id = $4)
         AND ($5 = '' OR POSITION($5 IN LOWER(
           COALESCE(title, '') || ' ' || business_ref_type || ' ' || business_ref_id
         )) > 0)
         AND ($6 = '' OR EXISTS (
           SELECT 1 FROM collaboration_participants AS visible_participant
           WHERE visible_participant.tenant_id = collaboration_sessions.tenant_id
             AND visible_participant.session_id = collaboration_sessions.id
             AND visible_participant.identity = $6
             AND visible_participant.left_at IS NULL
         ))
         AND ($7::timestamptz IS NULL OR (created_at, id) < ($7::timestamptz, $8))
       ORDER BY created_at DESC, id DESC
       LIMIT $9`,
      [
        input.tenant_id,
        status,
        String(input.business_ref_type || '').trim(),
        String(input.business_ref_id || '').trim(),
        normalizedSearch(input.query),
        String(input.identity || '').trim(),
        cursor?.created_at || null,
        cursor?.id || '',
        limit + 1
      ]
    );
    const hasMore = result.rows.length > limit;
    const selected = result.rows.slice(0, limit).map(decodeSession);
    const tail = selected.at(-1);
    return {
      items: selected,
      next_cursor: hasMore && tail
        ? encodePageCursor('sessions', 'before', tail.created_at, tail.id)
        : null,
      has_more: hasMore
    };
  }

  async listSessionSummaries(input: {
    tenant_id: string;
    session_ids: string[];
    identity: string;
  }): Promise<Map<string, NonNullable<CollaborationSession['summary']>>> {
    if (!input.session_ids.length) return new Map();
    const result = await this.pg.query(
      `SELECT session.id AS session_id,
              latest.id AS last_message_id,
              latest.sender_identity AS last_message_sender_identity,
              latest.message_type AS last_message_type,
              CASE WHEN latest.deleted_at IS NOT NULL THEN ''
                   ELSE COALESCE(NULLIF(latest.current_body, ''), latest.body, '') END AS last_message_body,
              latest.created_at AS last_message_created_at,
              (latest.deleted_at IS NOT NULL) AS last_message_deleted,
              COALESCE((
                SELECT COUNT(*) FROM collaboration_messages AS unread
                WHERE $3 <> '' AND unread.tenant_id = session.tenant_id
                  AND unread.session_id = session.id AND unread.sender_identity <> $3
                  AND unread.deleted_at IS NULL AND NOT EXISTS (
                    SELECT 1 FROM collaboration_message_receipts AS receipt
                    WHERE receipt.tenant_id = unread.tenant_id AND receipt.message_id = unread.id
                      AND receipt.identity = $3 AND receipt.read_at IS NOT NULL
                  )
              ), 0) AS unread_count,
              COALESCE((
                SELECT COUNT(*) FROM collaboration_participant_realtime_state AS realtime
                JOIN collaboration_participants AS participant
                  ON participant.tenant_id = realtime.tenant_id
                 AND participant.session_id = realtime.session_id
                 AND participant.identity = realtime.identity
                WHERE realtime.tenant_id = session.tenant_id AND realtime.session_id = session.id
                  AND participant.left_at IS NULL AND realtime.presence_status = 'online'
                  AND realtime.presence_expires_at > CURRENT_TIMESTAMP
              ), 0) AS online_participant_count
       FROM collaboration_sessions AS session
       LEFT JOIN LATERAL (
         SELECT id, sender_identity, message_type, body, current_body, created_at, deleted_at
         FROM collaboration_messages
         WHERE tenant_id = session.tenant_id AND session_id = session.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) AS latest ON TRUE
       WHERE session.tenant_id = $1 AND session.id = ANY($2::text[])
         AND EXISTS (
           SELECT 1 FROM collaboration_participants AS viewer
           WHERE viewer.tenant_id = session.tenant_id AND viewer.session_id = session.id
             AND viewer.identity = $3 AND viewer.left_at IS NULL
         )`,
      [input.tenant_id, input.session_ids, String(input.identity || '').trim()]
    );
    return new Map(result.rows.map((row) => [String(row.session_id), decodeSessionSummary(row)]));
  }

  async closeSession(sessionId: string): Promise<CollaborationSession | null> {
    await this.pg.query(
      `UPDATE collaboration_sessions
       SET status = 'closed', updated_at = CURRENT_TIMESTAMP, closed_at = COALESCE(closed_at, CURRENT_TIMESTAMP)
       WHERE id = $1`,
      [sessionId]
    );
    return this.getSession(sessionId);
  }

  async addParticipant(input: {
    tenant_id: string;
    session_id: string;
    identity: string;
    role: CollaborationParticipantRole;
    display_name?: string;
    user_ref?: BusinessRef;
  }): Promise<CollaborationParticipant> {
    const participantId = pgId('cpart');
    await this.pg.query(
      `INSERT INTO collaboration_participants
        (id, tenant_id, session_id, identity, role, display_name, user_ref_type, user_ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        participantId,
        input.tenant_id,
        input.session_id,
        input.identity,
        input.role,
        input.display_name || '',
        input.user_ref?.type || '',
        input.user_ref?.id || ''
      ]
    );
    const result = await this.pg.query('SELECT * FROM collaboration_participants WHERE id = $1', [participantId]);
    return decodeParticipant(result.rows[0]);
  }

  async listParticipants(input: { tenant_id: string; session_id: string }): Promise<CollaborationParticipant[]> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const result = await this.pg.query(
      'SELECT * FROM collaboration_participants WHERE session_id = $1 ORDER BY joined_at ASC',
      [input.session_id]
    );
    return result.rows.map(decodeParticipant);
  }

  async leaveParticipant(input: {
    tenant_id: string;
    session_id: string;
    identity: string;
  }): Promise<CollaborationParticipant | null> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    await this.pg.query(
      `UPDATE collaboration_participants
       SET left_at = COALESCE(left_at, CURRENT_TIMESTAMP)
       WHERE tenant_id = $1 AND session_id = $2 AND identity = $3`,
      [input.tenant_id, input.session_id, input.identity]
    );
    const result = await this.pg.query(
      `SELECT * FROM collaboration_participants
       WHERE tenant_id = $1 AND session_id = $2 AND identity = $3
       ORDER BY joined_at DESC
       LIMIT 1`,
      [input.tenant_id, input.session_id, input.identity]
    );
    return result.rows[0] ? decodeParticipant(result.rows[0]) : null;
  }

  async ensureChatBinding(input: {
    tenant_id: string;
    session_id: string;
    provider: string;
    provider_topic_id: string;
    provider_status?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CollaborationChatBinding> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const existing = await this.pg.query(
      `SELECT * FROM collaboration_chat_bindings
       WHERE tenant_id = $1 AND session_id = $2 AND provider = $3`,
      [input.tenant_id, input.session_id, input.provider]
    );
    if (existing.rows[0]) return decodeChatBinding(existing.rows[0]);

    const bindingId = pgId('cbind');
    await this.pg.query(
      `INSERT INTO collaboration_chat_bindings
        (id, tenant_id, session_id, provider, provider_topic_id, provider_status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, session_id, provider) DO NOTHING`,
      [
        bindingId,
        input.tenant_id,
        input.session_id,
        input.provider,
        input.provider_topic_id,
        input.provider_status || 'bound',
        toJson(input.metadata || {})
      ]
    );
    const result = await this.pg.query(
      `SELECT * FROM collaboration_chat_bindings
       WHERE tenant_id = $1 AND session_id = $2 AND provider = $3`,
      [input.tenant_id, input.session_id, input.provider]
    );
    if (!result.rows[0]) throw new Error('chat binding was not persisted');
    return decodeChatBinding(result.rows[0]);
  }

  async getChatBinding(input: {
    tenant_id: string;
    session_id: string;
    provider?: string;
  }): Promise<CollaborationChatBinding | null> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const result = input.provider
      ? await this.pg.query(
        `SELECT * FROM collaboration_chat_bindings
         WHERE tenant_id = $1 AND session_id = $2 AND provider = $3`,
        [input.tenant_id, input.session_id, input.provider]
      )
      : await this.pg.query(
        `SELECT * FROM collaboration_chat_bindings
         WHERE tenant_id = $1 AND session_id = $2
         ORDER BY created_at ASC
         LIMIT 1`,
        [input.tenant_id, input.session_id]
      );
    return result.rows[0] ? decodeChatBinding(result.rows[0]) : null;
  }

  async postMessage(input: {
    tenant_id: string;
    session_id: string;
    sender_identity: string;
    message_type: CollaborationMessage['message_type'];
    body: string;
    original_language?: string;
    metadata?: Record<string, unknown>;
    attachments?: CollaborationMessageAttachmentInput[];
    reply_to_message_id?: string;
    forwarded_from_message_id?: string;
    mentions?: string[];
  }): Promise<CollaborationMessage> {
    const result = await this.postOutgoingMessage({
      ...input,
      provider: 'local',
      provider_topic_id: '',
      provider_payload: '',
      provider_metadata: { mode: 'local_mirror' },
      provider_delivery_status: 'not_required'
    });
    return result.message;
  }

  async postOutgoingMessage(input: CollaborationOutgoingMessageInput): Promise<CollaborationOutgoingMessageResult> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const idempotencyKey = normalizedIdempotencyKey(input.idempotency_key);
    const payloadHash = String(input.idempotency_payload_hash || '').trim();
    if (idempotencyKey && !payloadHash) {
      throw Object.assign(new Error('idempotency payload hash is required'), { status: 400 });
    }
    return withPgTransaction(this.pg, async (pg) => {
      if (idempotencyKey) {
        const existing = await messageRowByIdempotencyKey(pg, input.tenant_id, input.session_id, idempotencyKey);
        if (existing) {
          assertIdempotencyPayload(existing, payloadHash);
          return {
            message: await messageWithAttachments(pg, decodeMessage(existing)),
            created: false
          };
        }
      }

      const relations = await this.validateMessageRelations(input);

      const messageId = pgId('cmsg');
      const result = await pg.query(
        `INSERT INTO collaboration_messages
          (id, tenant_id, session_id, sender_identity, message_type, body, original_language, metadata,
           idempotency_key, idempotency_payload_hash, provider, provider_topic_id, provider_payload,
           provider_delivery_metadata, provider_delivery_status, current_body,
           reply_to_message_id, forwarded_from_message_id, mentions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $6, $16, $17, $18)
         ON CONFLICT (tenant_id, session_id, idempotency_key) WHERE idempotency_key <> '' DO NOTHING`,
        [
          messageId,
          input.tenant_id,
          input.session_id,
          input.sender_identity,
          input.message_type,
          input.body || '',
          input.original_language || '',
          toJson(input.metadata || {}),
          idempotencyKey,
          payloadHash,
          input.provider,
          input.provider_topic_id,
          input.provider_payload,
          toJson(input.provider_metadata || {}),
          input.provider_delivery_status,
          relations.reply_to_message_id,
          relations.forwarded_from_message_id,
          toJson(relations.mentions)
        ]
      );
      const created = result.rowCount !== 0;
      if (!created) {
        const existing = await messageRowByIdempotencyKey(pg, input.tenant_id, input.session_id, idempotencyKey);
        if (!existing) throw new Error('idempotent collaboration message insert did not return a row');
        assertIdempotencyPayload(existing, payloadHash);
        return {
          message: await messageWithAttachments(pg, decodeMessage(existing)),
          created: false
        };
      }
      for (const attachment of input.attachments || []) {
        await this.insertMessageAttachment({
          ...attachment,
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          message_id: messageId
        }, pg);
      }
      const inserted = await pg.query('SELECT * FROM collaboration_messages WHERE id = $1', [messageId]);
      return {
        message: await messageWithAttachments(pg, decodeMessage(inserted.rows[0])),
        created: true
      };
    });
  }

  async getMessage(input: { tenant_id: string; message_id: string }): Promise<CollaborationMessage | null> {
    const result = await this.pg.query(
      'SELECT * FROM collaboration_messages WHERE id = $1 AND tenant_id = $2',
      [input.message_id, input.tenant_id]
    );
    if (!result.rows[0]) return null;
    return messageWithAttachments(this.pg, decodeMessage(result.rows[0]));
  }

  async listMessageAttachments(input: {
    tenant_id: string;
    message_id: string;
  }): Promise<CollaborationMessageAttachment[]> {
    const result = await this.pg.query(
      `SELECT * FROM collaboration_message_attachments
       WHERE tenant_id = $1 AND message_id = $2
       ORDER BY created_at ASC`,
      [input.tenant_id, input.message_id]
    );
    return result.rows.map(decodeAttachment);
  }

  async addTranslation(input: {
    tenant_id: string;
    message_id: string;
    target_language: string;
    translated_body: string;
    provider?: string;
    confidence?: number | null;
  }): Promise<CollaborationMessageTranslation> {
    const translationId = pgId('ctrans');
    await this.pg.query(
      `INSERT INTO collaboration_message_translations
        (id, tenant_id, message_id, target_language, translated_body, provider, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        translationId,
        input.tenant_id,
        input.message_id,
        input.target_language,
        input.translated_body,
        input.provider || '',
        input.confidence ?? null
      ]
    );
    const result = await this.pg.query('SELECT * FROM collaboration_message_translations WHERE id = $1', [translationId]);
    return decodeTranslation(result.rows[0]);
  }

  async listMessages(input: { tenant_id: string; session_id: string; limit?: number }): Promise<CollaborationMessage[]> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const result = await this.pg.query(
      `SELECT * FROM collaboration_messages
       WHERE session_id = $1
       ORDER BY created_at ASC, id ASC
       LIMIT $2`,
      [input.session_id, input.limit || 100]
    );
    const messages: CollaborationMessage[] = [];
    for (const row of result.rows) {
      const message = decodeMessage(row);
      messages.push({
        ...message,
        attachments: await this.listMessageAttachments({
          tenant_id: input.tenant_id,
          message_id: message.id
        })
      });
    }
    return messages;
  }

  async listMessagesPage(input: {
    tenant_id: string;
    session_id: string;
    direction?: 'before' | 'after';
    query?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CollaborationCursorPage<CollaborationMessage>> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const direction = input.direction || 'before';
    if (direction !== 'before' && direction !== 'after') {
      throw badRequest('direction must be before or after');
    }
    const limit = pageLimit(input.limit, 50);
    const scope = `messages:${input.session_id}`;
    const cursor = decodePageCursor(input.cursor, scope, direction);
    const comparator = direction === 'before' ? '<' : '>';
    const order = direction === 'before' ? 'DESC' : 'ASC';
    const result = await this.pg.query(
      `SELECT * FROM collaboration_messages AS message
       WHERE tenant_id = $1 AND session_id = $2
         AND ($3 = '' OR (
           deleted_at IS NULL AND POSITION($3 IN LOWER(COALESCE(current_body, body, ''))) > 0
         ))
         AND ($4::timestamptz IS NULL OR (created_at, id) ${comparator} ($4::timestamptz, $5))
       ORDER BY created_at ${order}, id ${order}
       LIMIT $6`,
      [
        input.tenant_id,
        input.session_id,
        normalizedSearch(input.query),
        cursor?.created_at || null,
        cursor?.id || '',
        limit + 1
      ]
    );
    const hasMore = result.rows.length > limit;
    const selectedRows = result.rows.slice(0, limit);
    const cursorRow = selectedRows.at(-1);
    const displayRows = direction === 'before' ? [...selectedRows].reverse() : selectedRows;
    const messages: CollaborationMessage[] = [];
    for (const row of displayRows) {
      messages.push(await messageWithAttachments(this.pg, decodeMessage(row)));
    }
    return {
      items: messages,
      next_cursor: (hasMore || direction === 'after') && cursorRow
        ? encodePageCursor(scope, direction, timestamp(cursorRow.created_at), String(cursorRow.id))
        : null,
      has_more: hasMore
    };
  }

  async listReactions(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
  }): Promise<CollaborationMessageReaction[]> {
    await this.requireMessageTarget(input);
    const result = await this.pg.query(
      `SELECT * FROM collaboration_message_reactions
       WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3
       ORDER BY created_at ASC, id ASC`,
      [input.tenant_id, input.session_id, input.message_id]
    );
    return result.rows.map(decodeReaction);
  }

  async addReaction(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    identity: string;
    emoji: string;
  }): Promise<CollaborationMessageReaction[]> {
    const identity = await this.requireActiveIdentity(input.tenant_id, input.session_id, input.identity);
    await this.requireMessageTarget(input, true);
    const emoji = normalizedEmoji(input.emoji);
    await this.pg.query(
      `INSERT INTO collaboration_message_reactions
        (id, tenant_id, session_id, message_id, identity, emoji)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, message_id, identity, emoji) DO NOTHING`,
      [pgId('cmreact'), input.tenant_id, input.session_id, input.message_id, identity, emoji]
    );
    return this.listReactions(input);
  }

  async removeReaction(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    identity: string;
    emoji: string;
  }): Promise<CollaborationMessageReaction[]> {
    const identity = await this.requireActiveIdentity(input.tenant_id, input.session_id, input.identity);
    await this.requireMessageTarget(input);
    await this.pg.query(
      `DELETE FROM collaboration_message_reactions
       WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3
         AND identity = $4 AND emoji = $5`,
      [input.tenant_id, input.session_id, input.message_id, identity, normalizedEmoji(input.emoji)]
    );
    return this.listReactions(input);
  }

  async listPins(input: {
    tenant_id: string;
    session_id: string;
  }): Promise<CollaborationMessagePin[]> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const result = await this.pg.query(
      `SELECT * FROM collaboration_message_pins
       WHERE tenant_id = $1 AND session_id = $2
       ORDER BY created_at DESC, id DESC`,
      [input.tenant_id, input.session_id]
    );
    return result.rows.map(decodePin);
  }

  async pinMessage(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    identity: string;
  }): Promise<CollaborationMessagePin[]> {
    const identity = await this.requireActiveIdentity(input.tenant_id, input.session_id, input.identity);
    await this.requireMessageTarget(input, true);
    await this.pg.query(
      `INSERT INTO collaboration_message_pins
        (id, tenant_id, session_id, message_id, pinned_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, session_id, message_id) DO NOTHING`,
      [pgId('cmpin'), input.tenant_id, input.session_id, input.message_id, identity]
    );
    return this.listPins(input);
  }

  async unpinMessage(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    identity: string;
  }): Promise<CollaborationMessagePin[]> {
    await this.requireActiveIdentity(input.tenant_id, input.session_id, input.identity);
    await this.requireMessageTarget(input);
    await this.pg.query(
      `DELETE FROM collaboration_message_pins
       WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3`,
      [input.tenant_id, input.session_id, input.message_id]
    );
    return this.listPins(input);
  }

  async scanPolicy(input: {
    tenant_id: string;
    session_id: string;
    message_id?: string;
    source?: PolicyFindingSource;
    source_ref_id?: string;
    evidence_refs?: PolicyEvidenceRef[];
    text: string;
  }): Promise<PolicyScanResult> {
    const matches = scanTextPolicy(input.text);
    const events: CollaborationPolicyEvent[] = [];
    const findings: CollaborationPolicyFinding[] = [];
    const source = input.source || 'text';
    const sourceRefId = input.source_ref_id || input.message_id || '';
    const findingStore = new PolicyFindingStore(this.pg);
    for (const match of matches) {
      const finding = await findingStore.recordFinding({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        message_id: input.message_id,
        source,
        source_ref_id: sourceRefId,
        policy_type: match.policy_type,
        severity: match.severity,
        matched_text_hash: match.matched_text_hash,
        action: match.action,
        evidence_refs: input.evidence_refs || []
      });
      findings.push(finding);
      const eventId = pgId('cpol');
      await this.pg.query(
        `INSERT INTO collaboration_policy_events
          (id, tenant_id, session_id, message_id, policy_type, severity, matched_text_hash, action,
           source, source_ref_id, attachment_id, finding_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          eventId,
          input.tenant_id,
          input.session_id,
          input.message_id || '',
          match.policy_type,
          match.severity,
          match.matched_text_hash,
          match.action,
          source,
          sourceRefId,
          source === 'ocr' || source === 'asr' ? sourceRefId : '',
          finding.id
        ]
      );
      const result = await this.pg.query('SELECT * FROM collaboration_policy_events WHERE id = $1', [eventId]);
      events.push(decodePolicyEvent(result.rows[0]));
    }
    return { matched: findings.length > 0, events, findings };
  }

  async listPolicyEvents(input: {
    tenant_id: string;
    session_id: string;
    message_id?: string;
    limit?: number;
  }): Promise<CollaborationPolicyEvent[]> {
    await this.requireTenantSession(input.tenant_id, input.session_id);
    const result = input.message_id
      ? await this.pg.query(
        `SELECT * FROM collaboration_policy_events
         WHERE session_id = $1 AND message_id = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [input.session_id, input.message_id, input.limit || 100]
      )
      : await this.pg.query(
        `SELECT * FROM collaboration_policy_events
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [input.session_id, input.limit || 100]
      );
    return result.rows.map(decodePolicyEvent);
  }

  async getChatSnapshot(input: {
    tenant_id: string;
    session_id: string;
    limit?: number;
  }): Promise<CollaborationChatSnapshot> {
    const session = await this.requireTenantSession(input.tenant_id, input.session_id);
    const [binding, participants, messages, policyEvents, policyFindings] = await Promise.all([
      this.getChatBinding({ tenant_id: input.tenant_id, session_id: input.session_id }),
      this.listParticipants({ tenant_id: input.tenant_id, session_id: input.session_id }),
      this.listMessages({ tenant_id: input.tenant_id, session_id: input.session_id, limit: input.limit }),
      this.listPolicyEvents({ tenant_id: input.tenant_id, session_id: input.session_id, limit: input.limit }),
      new PolicyFindingStore(this.pg).listFindings({
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        limit: input.limit
      })
    ]);
    return {
      session,
      binding,
      participants,
      messages,
      policy_events: policyEvents,
      policy_findings: policyFindings
    };
  }

  async listTimeline(sessionId: string): Promise<CollaborationTimelineItem[]> {
    const participantRows = await this.pg.query(
      'SELECT * FROM collaboration_participants WHERE session_id = $1 ORDER BY joined_at ASC',
      [sessionId]
    );
    const messageRows = await this.pg.query(
      'SELECT * FROM collaboration_messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId]
    );
    const participants = participantRows.rows.map((row) => ({ type: 'participant' as const, item: decodeParticipant(row) }));
    const messages = messageRows.rows.map((row) => ({ type: 'message' as const, item: decodeMessage(row) }));
    return [...participants, ...messages];
  }

  private async insertMessageAttachment(input: CollaborationMessageAttachmentInput & {
    tenant_id: string;
    session_id: string;
    message_id: string;
  }, pg: PgQueryable = this.pg): Promise<CollaborationMessageAttachment> {
    const attachmentId = pgId('catt');
    await pg.query(
      `INSERT INTO collaboration_message_attachments
        (id, tenant_id, session_id, message_id, kind, storage_url, filename, content_type, size_bytes, checksum, processing_status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        attachmentId,
        input.tenant_id,
        input.session_id,
        input.message_id,
        input.kind,
        input.storage_url,
        input.filename || '',
        input.content_type || '',
        Math.max(0, Number(input.size_bytes || 0)),
        input.checksum || '',
        input.processing_status || 'ready',
        toJson(input.metadata || {})
      ]
    );
    const result = await pg.query('SELECT * FROM collaboration_message_attachments WHERE id = $1', [attachmentId]);
    return decodeAttachment(result.rows[0]);
  }

  private async validateMessageRelations(input: {
    tenant_id: string;
    session_id: string;
    reply_to_message_id?: string;
    forwarded_from_message_id?: string;
    mentions?: string[];
  }): Promise<{
    reply_to_message_id: string | null;
    forwarded_from_message_id: string | null;
    mentions: string[];
  }> {
    const replyId = optionalId(input.reply_to_message_id);
    const forwardId = optionalId(input.forwarded_from_message_id);
    for (const [field, messageId] of [['reply_to_message_id', replyId], ['forwarded_from_message_id', forwardId]] as const) {
      if (!messageId) continue;
      const message = await this.getMessage({ tenant_id: input.tenant_id, message_id: messageId });
      if (!message || message.session_id !== input.session_id || message.deleted_at) {
        throw badRequest(`${field} must reference a visible message in the same session`);
      }
    }
    const mentions = [...new Set((input.mentions || []).map((identity) => String(identity).trim()).filter(Boolean))];
    if (mentions.length > 50) throw badRequest('mentions must contain at most 50 identities');
    if (mentions.length) {
      const participants = await this.listParticipants({
        tenant_id: input.tenant_id,
        session_id: input.session_id
      });
      const active = new Set(participants.filter((participant) => !participant.left_at).map((participant) => participant.identity));
      if (mentions.some((identity) => !active.has(identity))) {
        throw badRequest('mentions must reference active session participants');
      }
    }
    return { reply_to_message_id: replyId, forwarded_from_message_id: forwardId, mentions };
  }

  private async requireActiveIdentity(tenantId: string, sessionId: string, value: string): Promise<string> {
    const identity = String(value || '').trim();
    if (!identity) throw badRequest('identity is required');
    const participants = await this.listParticipants({ tenant_id: tenantId, session_id: sessionId });
    if (!participants.some((participant) => participant.identity === identity && !participant.left_at)) {
      throw Object.assign(new Error('active collaboration participant not found'), { status: 404 });
    }
    return identity;
  }

  private async requireMessageTarget(
    input: { tenant_id: string; session_id: string; message_id: string },
    requireVisible = false
  ): Promise<CollaborationMessage> {
    const message = await this.getMessage({ tenant_id: input.tenant_id, message_id: input.message_id });
    if (!message || message.session_id !== input.session_id || (requireVisible && message.deleted_at)) {
      throw Object.assign(new Error('collaboration message not found'), { status: 404 });
    }
    return message;
  }
}

function assertTenantRef(tenantId: string, ref: BusinessRef): void {
  if (ref.tenant_id !== tenantId) {
    throw Object.assign(new Error('business_ref tenant mismatch'), { status: 400 });
  }
}

interface PageCursor {
  v: 1;
  scope: string;
  direction: 'before' | 'after';
  created_at: string;
  id: string;
}

function encodePageCursor(
  scope: string,
  direction: PageCursor['direction'],
  createdAt: string,
  id: string
): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    scope,
    direction,
    created_at: timestamp(createdAt),
    id
  } satisfies PageCursor)).toString('base64url');
}

function decodePageCursor(
  value: string | undefined,
  scope: string,
  direction: PageCursor['direction']
): PageCursor | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PageCursor>;
    if (
      decoded.v !== 1 || decoded.scope !== scope || decoded.direction !== direction ||
      !String(decoded.id || '').trim() || !String(decoded.created_at || '').trim() ||
      Number.isNaN(new Date(String(decoded.created_at)).getTime())
    ) throw new Error('invalid cursor payload');
    return {
      v: 1,
      scope,
      direction,
      created_at: new Date(String(decoded.created_at)).toISOString(),
      id: String(decoded.id)
    };
  } catch {
    throw badRequest('invalid or incompatible cursor');
  }
}

function pageLimit(value: number | undefined, fallback: number): number {
  const limit = value == null ? fallback : Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw badRequest('limit must be an integer from 1 to 200');
  }
  return limit;
}

function normalizedSearch(value: string | undefined): string {
  const query = String(value || '').trim().toLowerCase();
  if (query.length > 200) throw badRequest('query must be at most 200 characters');
  return query;
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalId(value: string | undefined): string | null {
  const id = String(value || '').trim();
  if (id.length > 200) throw badRequest('message relation id is too long');
  return id || null;
}

function normalizedEmoji(value: string): string {
  const emoji = String(value || '').trim();
  if (!emoji || emoji.length > 64 || /[\r\n]/.test(emoji)) {
    throw badRequest('emoji must be a single line of at most 64 characters');
  }
  return emoji;
}

function parseStringArray(value: unknown): string[] {
  const parsed = Array.isArray(value)
    ? value
    : parseJson<unknown[]>(String(value || '[]'), []);
  return parsed.map((item) => String(item).trim()).filter(Boolean);
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string | null | undefined, fallback: T = {} as T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function decodeSession(row: Record<string, unknown>): CollaborationSession {
  const metadata = parseJson<Record<string, unknown>>(String(row.metadata || '{}'), {});
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    business_ref_type: String(row.business_ref_type),
    business_ref_id: String(row.business_ref_id),
    business_ref: {
      tenant_id: String(row.tenant_id),
      type: String(row.business_ref_type),
      id: String(row.business_ref_id),
      display_name: String(metadata.business_ref_display_name || ''),
      metadata: (metadata.business_ref_metadata || {}) as Record<string, unknown>
    },
    status: String(row.status) as CollaborationSession['status'],
    title: String(row.title || ''),
    metadata,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    closed_at: row.closed_at ? String(row.closed_at) : null
  };
}

function decodeSessionSummary(row: Record<string, unknown>): NonNullable<CollaborationSession['summary']> {
  const lastMessageId = String(row.last_message_id || '');
  return {
    unread_count: Number(row.unread_count || 0),
    online_participant_count: Number(row.online_participant_count || 0),
    last_message: lastMessageId ? {
      id: lastMessageId,
      body: String(row.last_message_body || ''),
      sender_identity: String(row.last_message_sender_identity || ''),
      message_type: String(row.last_message_type || 'text') as CollaborationMessage['message_type'],
      created_at: String(row.last_message_created_at || ''),
      deleted: row.last_message_deleted === true || String(row.last_message_deleted) === 'true'
    } : null
  };
}

function decodeParticipant(row: Record<string, unknown>): CollaborationParticipant {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    identity: String(row.identity),
    role: String(row.role) as CollaborationParticipant['role'],
    display_name: String(row.display_name || ''),
    user_ref_type: String(row.user_ref_type || ''),
    user_ref_id: String(row.user_ref_id || ''),
    joined_at: String(row.joined_at),
    left_at: row.left_at ? String(row.left_at) : null
  };
}

function decodeMessage(row: Record<string, unknown>): CollaborationMessage {
  const provider = String(row.provider || 'local');
  const providerTopicId = String(row.provider_topic_id || '');
  const providerMessageId = String(row.provider_message_id || '');
  const deliveryStatus = String(row.provider_delivery_status || 'not_required') as CollaborationMessage['provider_delivery']['status'];
  const providerMetadata = parseJson(String(row.provider_delivery_metadata || '{}'), {});
  const storedMetadata = parseJson(String(row.metadata || '{}'), {});
  const deletedAt = row.deleted_at ? String(row.deleted_at) : null;
  const currentBody = String(row.current_body || row.body || '');
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    sender_identity: String(row.sender_identity),
    message_type: String(row.message_type) as CollaborationMessage['message_type'],
    body: deletedAt ? '' : currentBody,
    original_language: String(row.original_language || ''),
    metadata: {
      ...storedMetadata,
      provider,
      provider_topic_id: providerTopicId,
      provider_message_id: providerMessageId,
      provider_sync_status: providerSyncStatus(deliveryStatus),
      provider_metadata: providerMetadata
    },
    attachments: [],
    idempotency_key: String(row.idempotency_key || ''),
    provider_origin: String(row.provider_origin || '') as CollaborationMessage['provider_origin'],
    provider_sequence: Number(row.provider_sequence || 0),
    provider_version: Number(row.provider_version || 0),
    provider_sender_id: String(row.provider_sender_id || ''),
    provider_delivery: {
      provider,
      provider_topic_id: providerTopicId,
      provider_message_id: providerMessageId,
      status: deliveryStatus,
      attempt_count: Number(row.provider_delivery_attempts || 0),
      next_attempt_at: optionalTimestamp(row.provider_next_attempt_at),
      lease_until: optionalTimestamp(row.provider_delivery_lease_until),
      last_error_code: String(row.provider_last_error_code || ''),
      last_error_message: String(row.provider_last_error_message || ''),
      delivered_at: optionalTimestamp(row.provider_delivered_at),
      updated_at: timestamp(row.provider_delivery_updated_at || row.created_at),
      metadata: providerMetadata
    },
    edit_version: Number(row.edit_version || 0),
    edited_at: row.edited_at ? String(row.edited_at) : null,
    deleted_at: deletedAt,
    deleted_by: String(row.deleted_by || ''),
    created_at: timestamp(row.created_at),
    reply_to_message_id: row.reply_to_message_id ? String(row.reply_to_message_id) : null,
    forwarded_from_message_id: row.forwarded_from_message_id ? String(row.forwarded_from_message_id) : null,
    mentions: parseStringArray(row.mentions)
  };
}

function decodeReaction(row: Record<string, unknown>): CollaborationMessageReaction {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    identity: String(row.identity),
    emoji: String(row.emoji),
    created_at: timestamp(row.created_at)
  };
}

function decodePin(row: Record<string, unknown>): CollaborationMessagePin {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    pinned_by: String(row.pinned_by),
    created_at: timestamp(row.created_at)
  };
}

async function messageRowByIdempotencyKey(
  pg: PgQueryable,
  tenantId: string,
  sessionId: string,
  idempotencyKey: string
): Promise<Record<string, unknown> | null> {
  const result = await pg.query(
    `SELECT * FROM collaboration_messages
     WHERE tenant_id = $1 AND session_id = $2 AND idempotency_key = $3`,
    [tenantId, sessionId, idempotencyKey]
  );
  return result.rows[0] || null;
}

async function messageWithAttachments(pg: PgQueryable, message: CollaborationMessage): Promise<CollaborationMessage> {
  const result = await pg.query(
    `SELECT * FROM collaboration_message_attachments
     WHERE tenant_id = $1 AND message_id = $2
     ORDER BY created_at ASC`,
    [message.tenant_id, message.id]
  );
  return { ...message, attachments: result.rows.map(decodeAttachment) };
}

function normalizedIdempotencyKey(value: string | undefined): string {
  const key = String(value || '').trim();
  if (key.length > 128 || /[\r\n]/.test(key)) {
    throw Object.assign(new Error('idempotency key must be a single line of at most 128 characters'), { status: 400 });
  }
  return key;
}

function assertIdempotencyPayload(row: Record<string, unknown>, expectedHash: string): void {
  const actualHash = String(row.idempotency_payload_hash || '');
  if (actualHash !== expectedHash) {
    throw Object.assign(new Error('idempotency key was already used for a different message payload'), { status: 409 });
  }
}

function providerSyncStatus(
  status: CollaborationMessage['provider_delivery']['status']
): 'published' | 'skipped' | 'failed' {
  if (status === 'delivered') return 'published';
  if (status === 'not_required') return 'skipped';
  return 'failed';
}

function optionalTimestamp(value: unknown): string | null {
  return value ? timestamp(value) : null;
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function decodeAttachment(row: Record<string, unknown>): CollaborationMessageAttachment {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    kind: String(row.kind) as CollaborationMessageAttachment['kind'],
    storage_url: String(row.storage_url || ''),
    filename: String(row.filename || ''),
    content_type: String(row.content_type || ''),
    size_bytes: Number(row.size_bytes || 0),
    checksum: String(row.checksum || ''),
    processing_status: String(row.processing_status || 'pending') as CollaborationMessageAttachment['processing_status'],
    ocr_text: String(row.ocr_text || ''),
    asr_text: String(row.asr_text || ''),
    extracted_text: String(row.extracted_text || ''),
    processing_error_code: String(row.processing_error_code || ''),
    processed_at: row.processed_at ? String(row.processed_at) : null,
    updated_at: String(row.updated_at || row.created_at || ''),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at)
  };
}

function decodeTranslation(row: Record<string, unknown>): CollaborationMessageTranslation {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    message_id: String(row.message_id),
    target_language: String(row.target_language),
    translated_body: String(row.translated_body || ''),
    provider: String(row.provider || ''),
    confidence: row.confidence != null ? Number(row.confidence) : null,
    created_at: String(row.created_at)
  };
}

function decodeChatBinding(row: Record<string, unknown>): CollaborationChatBinding {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    provider: String(row.provider || ''),
    provider_topic_id: String(row.provider_topic_id || ''),
    provider_status: String(row.provider_status || ''),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function decodePolicyEvent(row: Record<string, unknown>): CollaborationPolicyEvent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id || ''),
    policy_type: String(row.policy_type),
    severity: String(row.severity) as CollaborationPolicyEvent['severity'],
    matched_text_hash: String(row.matched_text_hash || ''),
    action: String(row.action || ''),
    source: String(row.source || 'text') as CollaborationPolicyEvent['source'],
    source_ref_id: String(row.source_ref_id || ''),
    attachment_id: String(row.attachment_id || ''),
    finding_id: String(row.finding_id || ''),
    created_at: String(row.created_at)
  };
}
