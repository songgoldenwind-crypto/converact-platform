import { createHash } from 'node:crypto';

import { pgId, withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { withCollaborationSessionLock } from './collaboration-lock.js';
import { CollaborationStore } from './collaboration-store.js';
import type {
  CollaborationMessageReceipt,
  CollaborationMessageReceiptSource,
  CollaborationMessageReceiptStatus,
  CollaborationMessage,
  CollaborationMessageMutation,
  CollaborationMessageMutationAction,
  CollaborationParticipantRealtimeState,
  CollaborationPresenceStatus
} from './types.js';
import { redactSensitiveText, sanitizePolicyMetadata } from './policy-finding-store.js';

export class CollaborationMessageStateStore {
  constructor(
    private readonly pg: PgQueryable,
    private readonly now: () => Date = () => new Date(),
    private readonly mutationWindowMs: number = messageMutationWindowMs()
  ) {}

  async markReceiptThrough(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    identity: string;
    status: CollaborationMessageReceiptStatus;
    source?: CollaborationMessageReceiptSource;
    provider_sequence?: number;
    metadata?: Record<string, unknown>;
  }): Promise<CollaborationMessageReceipt[]> {
    const identity = requiredIdentity(input.identity);
    const providerSequence = nonNegativeInteger(input.provider_sequence ?? 0, 'provider_sequence');
    return withPgTenant(this.pg, input.tenant_id, (scopedPg) =>
      withPgTransaction(scopedPg, async (pg) => {
        await this.requireActiveParticipant(pg, input.tenant_id, input.session_id, identity);
        const messageRows = await pg.query(
          `SELECT id, sender_identity, deleted_at FROM collaboration_messages
           WHERE tenant_id = $1 AND session_id = $2
           ORDER BY created_at ASC, id ASC`,
          [input.tenant_id, input.session_id]
        );
        const targetIndex = messageRows.rows.findIndex((message) => String(message.id) === input.message_id);
        if (targetIndex < 0) {
          throw Object.assign(new Error('collaboration message not found'), { status: 404 });
        }
        const timestamp = this.now().toISOString();
        const receipts: CollaborationMessageReceipt[] = [];
        for (const message of messageRows.rows.slice(0, targetIndex + 1)) {
          if (String(message.sender_identity) === identity) continue;
          const result = await pg.query(
            `INSERT INTO collaboration_message_receipts
              (id, tenant_id, session_id, message_id, identity, delivered_at, read_at,
               source, provider_sequence, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
             ON CONFLICT (tenant_id, message_id, identity) DO UPDATE SET
               delivered_at = COALESCE(collaboration_message_receipts.delivered_at, EXCLUDED.delivered_at),
               read_at = COALESCE(collaboration_message_receipts.read_at, EXCLUDED.read_at),
               source = CASE
                 WHEN EXCLUDED.read_at IS NOT NULL OR EXCLUDED.provider_sequence >= collaboration_message_receipts.provider_sequence
                 THEN EXCLUDED.source ELSE collaboration_message_receipts.source END,
               provider_sequence = GREATEST(collaboration_message_receipts.provider_sequence, EXCLUDED.provider_sequence),
               metadata = collaboration_message_receipts.metadata || EXCLUDED.metadata,
               updated_at = EXCLUDED.updated_at
             RETURNING *`,
            [
              pgId('cmrcpt'),
              input.tenant_id,
              input.session_id,
              String(message.id),
              identity,
              timestamp,
              input.status === 'read' ? timestamp : null,
              input.source || 'ivekit',
              providerSequence,
              JSON.stringify(sanitizePolicyMetadata(input.metadata || {})),
              timestamp
            ]
          );
          receipts.push(decodeReceipt(result.rows[0]));
        }
        return receipts;
      })
    );
  }

  async listReceipts(input: {
    tenant_id: string;
    session_id: string;
    message_id?: string;
    identity?: string;
  }): Promise<CollaborationMessageReceipt[]> {
    return withPgTenant(this.pg, input.tenant_id, (pg) => this.listReceiptsWithPg(pg, input));
  }

  async unreadCount(input: {
    tenant_id: string;
    session_id: string;
    identity: string;
  }): Promise<number> {
    const identity = requiredIdentity(input.identity);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      await this.requireActiveParticipant(pg, input.tenant_id, input.session_id, identity);
      const result = await pg.query(
        `SELECT COUNT(*) AS unread_count
         FROM collaboration_messages AS message
         WHERE message.tenant_id = $1 AND message.session_id = $2
           AND message.sender_identity <> $3
           AND message.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM collaboration_message_receipts AS receipt
             WHERE receipt.tenant_id = message.tenant_id
               AND receipt.message_id = message.id
               AND receipt.identity = $3
               AND receipt.read_at IS NOT NULL
           )`,
        [input.tenant_id, input.session_id, identity]
      );
      return Number(result.rows[0]?.unread_count || 0);
    });
  }

  async updateTyping(input: {
    tenant_id: string;
    session_id: string;
    identity: string;
    typing: boolean;
    ttl_ms?: number;
  }): Promise<CollaborationParticipantRealtimeState> {
    const identity = requiredIdentity(input.identity);
    const ttlMs = boundedTtl(input.ttl_ms, 8_000, 1_000, 30_000, 'typing ttl_ms');
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      await this.requireActiveParticipant(pg, input.tenant_id, input.session_id, identity);
      const now = this.now();
      await ensureRealtimeStateRow(pg, {
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        identity,
        now: now.toISOString()
      });
      const result = await pg.query(
        `UPDATE collaboration_participant_realtime_state
         SET typing_expires_at = $4, last_seen_at = $5, updated_at = $5
         WHERE tenant_id = $1 AND session_id = $2 AND identity = $3
         RETURNING *`,
        [
          input.tenant_id,
          input.session_id,
          identity,
          input.typing ? new Date(now.getTime() + ttlMs).toISOString() : null,
          now.toISOString()
        ]
      );
      return decodeRealtimeState(result.rows[0], now);
    });
  }

  async updatePresence(input: {
    tenant_id: string;
    session_id: string;
    identity: string;
    status: CollaborationPresenceStatus;
    ttl_ms?: number;
  }): Promise<CollaborationParticipantRealtimeState> {
    const identity = requiredIdentity(input.identity);
    const status = presenceStatus(input.status);
    const ttlMs = boundedTtl(input.ttl_ms, 90_000, 5_000, 600_000, 'presence ttl_ms');
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      await this.requireActiveParticipant(pg, input.tenant_id, input.session_id, identity);
      const now = this.now();
      await ensureRealtimeStateRow(pg, {
        tenant_id: input.tenant_id,
        session_id: input.session_id,
        identity,
        now: now.toISOString()
      });
      const result = await pg.query(
        `UPDATE collaboration_participant_realtime_state
         SET presence_status = $4, presence_expires_at = $5,
             last_seen_at = $6, updated_at = $6
         WHERE tenant_id = $1 AND session_id = $2 AND identity = $3
         RETURNING *`,
        [
          input.tenant_id,
          input.session_id,
          identity,
          status,
          status === 'offline' ? null : new Date(now.getTime() + ttlMs).toISOString(),
          now.toISOString()
        ]
      );
      return decodeRealtimeState(result.rows[0], now);
    });
  }

  async listRealtimeStates(input: {
    tenant_id: string;
    session_id: string;
  }): Promise<CollaborationParticipantRealtimeState[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const collaboration = new CollaborationStore(pg);
      const session = await collaboration.getSession(input.session_id);
      if (!session || session.tenant_id !== input.tenant_id) {
        throw Object.assign(new Error('collaboration session not found'), { status: 404 });
      }
      const result = await pg.query(
        `SELECT * FROM collaboration_participant_realtime_state
         WHERE tenant_id = $1 AND session_id = $2
         ORDER BY updated_at DESC`,
        [input.tenant_id, input.session_id]
      );
      const now = this.now();
      return result.rows.map((row) => decodeRealtimeState(row, now));
    });
  }

  async editMessage(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    actor_identity: string;
    body: string;
    reason?: string;
    enqueue_provider_mutation?: boolean;
  }): Promise<CollaborationMessage> {
    const body = normalizedEditedBody(input.body);
    return this.mutateMessage({ ...input, action: 'edit', body });
  }

  async deleteMessage(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    actor_identity: string;
    reason?: string;
    enqueue_provider_mutation?: boolean;
  }): Promise<CollaborationMessage> {
    return this.mutateMessage({ ...input, action: 'delete' });
  }

  async listMutations(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
  }): Promise<CollaborationMessageMutation[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const messageResult = await pg.query(
        `SELECT id, session_id FROM collaboration_messages
         WHERE id = $1 AND tenant_id = $2`,
        [input.message_id, input.tenant_id]
      );
      if (!messageResult.rows[0] || String(messageResult.rows[0].session_id) !== input.session_id) {
        throw Object.assign(new Error('collaboration message not found'), { status: 404 });
      }
      const result = await pg.query(
        `SELECT * FROM collaboration_message_mutations
         WHERE tenant_id = $1 AND session_id = $2 AND message_id = $3
         ORDER BY version ASC`,
        [input.tenant_id, input.session_id, input.message_id]
      );
      return result.rows.map(decodeMutation);
    });
  }

  private async listReceiptsWithPg(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      session_id: string;
      message_id?: string;
      identity?: string;
    }
  ): Promise<CollaborationMessageReceipt[]> {
    const result = await pg.query(
      `SELECT * FROM collaboration_message_receipts
       WHERE tenant_id = $1 AND session_id = $2
         AND ($3 = '' OR message_id = $3)
         AND ($4 = '' OR identity = $4)
       ORDER BY created_at ASC`,
      [input.tenant_id, input.session_id, input.message_id || '', input.identity || '']
    );
    return result.rows.map(decodeReceipt);
  }

  private async requireActiveParticipant(
    pg: PgQueryable,
    tenantId: string,
    sessionId: string,
    identity: string
  ): Promise<void> {
    const collaboration = new CollaborationStore(pg);
    const session = await collaboration.getSession(sessionId);
    if (!session || session.tenant_id !== tenantId) {
      throw Object.assign(new Error('collaboration session not found'), { status: 404 });
    }
    const participants = await collaboration.listParticipants({ tenant_id: tenantId, session_id: sessionId });
    if (!participants.some((participant) => participant.identity === identity && !participant.left_at)) {
      throw Object.assign(new Error('active collaboration participant not found'), { status: 404 });
    }
  }

  private async mutateMessage(input: {
    tenant_id: string;
    session_id: string;
    message_id: string;
    actor_identity: string;
    action: CollaborationMessageMutationAction;
    body?: string;
    reason?: string;
    enqueue_provider_mutation?: boolean;
  }): Promise<CollaborationMessage> {
    const actorIdentity = requiredIdentity(input.actor_identity);
    return withCollaborationSessionLock(this.pg, {
      tenantId: input.tenant_id,
      sessionId: input.session_id,
      mode: 'shared'
    }, (lockedPg) => withPgTenant(lockedPg, input.tenant_id, (scopedPg) =>
      withPgTransaction(scopedPg, async (pg) => {
        const session = await new CollaborationStore(pg).requireTenantSession(
          input.tenant_id,
          input.session_id
        );
        if (session.status !== 'open') {
          throw Object.assign(new Error('collaboration session is closed'), { status: 409 });
        }
        await this.requireActiveParticipant(pg, input.tenant_id, input.session_id, actorIdentity);
        const rowResult = await pg.query(
          `SELECT * FROM collaboration_messages
           WHERE id = $1 AND tenant_id = $2
           FOR UPDATE`,
          [input.message_id, input.tenant_id]
        );
        const row = rowResult.rows[0];
        if (!row || String(row.session_id) !== input.session_id) {
          throw Object.assign(new Error('collaboration message not found'), { status: 404 });
        }
        if (String(row.sender_identity) !== actorIdentity) {
          throw Object.assign(new Error('only the message sender can mutate a message'), { status: 403 });
        }
        if (String(row.message_type) !== 'text') {
          throw Object.assign(new Error('only text messages can be mutated'), { status: 409 });
        }
        const now = this.now();
        const createdAt = new Date(String(row.created_at)).getTime();
        if (!Number.isFinite(createdAt) || now.getTime() - createdAt > this.mutationWindowMs) {
          throw Object.assign(new Error('message mutation window expired'), { status: 409 });
        }
        if (row.deleted_at) {
          if (input.action === 'delete') {
            const existing = await new CollaborationStore(pg).getMessage({
              tenant_id: input.tenant_id,
              message_id: input.message_id
            });
            if (!existing) throw Object.assign(new Error('collaboration message not found'), { status: 404 });
            return existing;
          }
          throw Object.assign(new Error('deleted messages cannot be edited'), { status: 409 });
        }
        const beforeBody = String(row.current_body || row.body || '');
        if (input.action === 'edit' && beforeBody === input.body) {
          const existing = await new CollaborationStore(pg).getMessage({
            tenant_id: input.tenant_id,
            message_id: input.message_id
          });
          if (!existing) throw Object.assign(new Error('collaboration message not found'), { status: 404 });
          return existing;
        }
        const nextVersion = Number(row.edit_version || 0) + 1;
        const timestamp = now.toISOString();
        const updated = input.action === 'edit'
          ? await pg.query(
            `UPDATE collaboration_messages
             SET current_body = $3, edit_version = $4, edited_at = $5
             WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
             RETURNING *`,
            [input.message_id, input.tenant_id, input.body, nextVersion, timestamp]
          )
          : await pg.query(
            `UPDATE collaboration_messages
             SET edit_version = $3, deleted_at = $4, deleted_by = $5
             WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
             RETURNING *`,
            [input.message_id, input.tenant_id, nextVersion, timestamp, actorIdentity]
          );
        if (!updated.rows[0]) throw Object.assign(new Error('message mutation conflict'), { status: 409 });
        const afterBody = input.action === 'edit' ? input.body || '' : '';
        const mutationId = pgId('cmut');
        await pg.query(
          `INSERT INTO collaboration_message_mutations
            (id, tenant_id, session_id, message_id, version, action, actor_identity,
             before_body_hash, after_body_hash, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            mutationId,
            input.tenant_id,
            input.session_id,
            input.message_id,
            nextVersion,
            input.action,
            actorIdentity,
            sha256(beforeBody),
            sha256(afterBody),
            redactSensitiveText(input.reason || '').slice(0, 1_000),
            timestamp
          ]
        );
        if (String(row.provider) === 'tinode' && input.enqueue_provider_mutation !== false) {
          await pg.query(
            `INSERT INTO tinode_message_mutation_outbox
              (id, tenant_id, session_id, message_id, mutation_id, mutation_version,
               action, provider_topic_id, target_provider_message_id, body,
               status, attempt_count, max_attempts, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                     'pending', 0, 5, $11, $11)
             ON CONFLICT (tenant_id, mutation_id) DO NOTHING`,
            [
              pgId('tmut'),
              input.tenant_id,
              input.session_id,
              input.message_id,
              mutationId,
              nextVersion,
              input.action,
              String(row.provider_topic_id || ''),
              String(row.provider_message_id || ''),
              afterBody,
              timestamp
            ]
          );
        }
        if (input.action === 'edit') {
          await new CollaborationStore(pg).scanPolicy({
            tenant_id: input.tenant_id,
            session_id: input.session_id,
            message_id: input.message_id,
            source: 'text',
            source_ref_id: `${input.message_id}:edit:${nextVersion}`,
            evidence_refs: [{ type: 'message', id: input.message_id, version: nextVersion }],
            text: afterBody
          });
        }
        const message = await new CollaborationStore(pg).getMessage({
          tenant_id: input.tenant_id,
          message_id: input.message_id
        });
        if (!message) throw Object.assign(new Error('collaboration message not found'), { status: 404 });
        return message;
      })
    ));
  }
}

async function ensureRealtimeStateRow(
  pg: PgQueryable,
  input: { tenant_id: string; session_id: string; identity: string; now: string }
): Promise<void> {
  await pg.query(
    `INSERT INTO collaboration_participant_realtime_state
      (id, tenant_id, session_id, identity, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tenant_id, session_id, identity) DO NOTHING`,
    [pgId('cstate'), input.tenant_id, input.session_id, input.identity, input.now]
  );
}

function decodeReceipt(row: Record<string, unknown>): CollaborationMessageReceipt {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    identity: String(row.identity),
    delivered_at: row.delivered_at ? String(row.delivered_at) : null,
    read_at: row.read_at ? String(row.read_at) : null,
    source: String(row.source || 'ivekit') as CollaborationMessageReceiptSource,
    provider_sequence: Number(row.provider_sequence || 0),
    metadata: parseRecord(row.metadata),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || row.created_at || '')
  };
}

function decodeRealtimeState(
  row: Record<string, unknown>,
  now: Date
): CollaborationParticipantRealtimeState {
  const presenceExpiresAt = row.presence_expires_at ? String(row.presence_expires_at) : null;
  const typingExpiresAt = row.typing_expires_at ? String(row.typing_expires_at) : null;
  const presenceExpired = presenceExpiresAt != null && new Date(presenceExpiresAt).getTime() <= now.getTime();
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    identity: String(row.identity),
    presence_status: presenceExpired
      ? 'offline'
      : String(row.presence_status || 'offline') as CollaborationPresenceStatus,
    presence_expires_at: presenceExpiresAt,
    typing: typingExpiresAt != null && new Date(typingExpiresAt).getTime() > now.getTime(),
    typing_expires_at: typingExpiresAt,
    last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
    metadata: parseRecord(row.metadata),
    created_at: String(row.created_at || ''),
    updated_at: String(row.updated_at || row.created_at || '')
  };
}

function decodeMutation(row: Record<string, unknown>): CollaborationMessageMutation {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    session_id: String(row.session_id),
    message_id: String(row.message_id),
    version: Number(row.version || 0),
    action: String(row.action) as CollaborationMessageMutationAction,
    actor_identity: String(row.actor_identity),
    before_body_hash: String(row.before_body_hash || ''),
    after_body_hash: String(row.after_body_hash || ''),
    reason: String(row.reason || ''),
    created_at: String(row.created_at || '')
  };
}

function requiredIdentity(value: string): string {
  const identity = String(value || '').trim();
  if (!identity || identity.length > 200) {
    throw Object.assign(new Error('identity is required and must be at most 200 characters'), { status: 400 });
  }
  return identity;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative safe integer`), { status: 400 });
  }
  return value;
}

function presenceStatus(value: string): CollaborationPresenceStatus {
  if (value === 'online' || value === 'away' || value === 'offline') return value;
  throw Object.assign(new Error('presence status must be online, away, or offline'), { status: 400 });
}

function boundedTtl(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Object.assign(new Error(`${field} must be an integer between ${min} and ${max}`), { status: 400 });
  }
  return value;
}

function normalizedEditedBody(value: string): string {
  const body = String(value || '').trim();
  if (!body || body.length > 20_000) {
    throw Object.assign(new Error('edited body is required and must be at most 20000 characters'), { status: 400 });
  }
  return body;
}

export function messageMutationWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = String(env.OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS || '900000').trim();
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 86_400_000) {
    throw new Error('OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS must be an integer between 1000 and 86400000');
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value || '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
