import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { pgId } from '../../db-pg.js';
import { CollaborationStore } from './collaboration-store.js';
import {
  CollaborationMessageStateStore,
  messageMutationWindowMs
} from './message-state-store.js';
import type { CollaborationMessageType } from './types.js';
import type { TinodeInboundClaim, TinodeInboundProjectionResult } from './tinode-inbound-store.js';
import { TinodeInboundProjectionError } from './tinode-inbound-store.js';
import type {
  TinodeInboundDataPayload,
  TinodeInboundDeletePayload,
  TinodeInboundNormalizedEvent
} from './tinode-inbound-protocol.js';
import { TinodeProviderUserStore } from './tinode-provider-user-store.js';

export class TinodeInboundProjector {
  private readonly now: () => Date;
  private readonly mutationWindowMs: number;

  constructor(input: { now?: () => Date; mutationWindowMs?: number } = {}) {
    this.now = input.now || (() => new Date());
    this.mutationWindowMs = input.mutationWindowMs ?? messageMutationWindowMs();
  }

  async project(
    pg: PgQueryable,
    claim: TinodeInboundClaim,
    event: TinodeInboundNormalizedEvent
  ): Promise<TinodeInboundProjectionResult> {
    if (event.kind === 'delete') return this.projectDelete(pg, claim, event.payload);
    if (event.payload.head.opc_message_id) {
      return this.projectLocalEcho(pg, claim, event.payload);
    }
    if (event.payload.head.replace) {
      return this.projectReplacement(pg, claim, event.payload);
    }
    return this.projectMessage(pg, claim, event.payload, event.payload_hash);
  }

  private async projectLocalEcho(
    pg: PgQueryable,
    claim: TinodeInboundClaim,
    payload: TinodeInboundDataPayload
  ): Promise<TinodeInboundProjectionResult> {
    const messageId = payload.head.opc_message_id;
    const current = await pg.query(
      `SELECT id, provider, provider_topic_id, provider_sequence
       FROM collaboration_messages
       WHERE id = $1 AND tenant_id = $2 AND session_id = $3
       FOR UPDATE`,
      [messageId, claim.tenant_id, claim.session_id]
    );
    const row = current.rows[0];
    if (!row) throw projectionError('local_message_not_found', 'Tinode echo references an unknown local message', true);
    if (String(row.provider) !== 'tinode' || String(row.provider_topic_id) !== claim.provider_topic_id) {
      throw projectionError('local_message_binding_mismatch', 'Tinode echo does not match the local message binding');
    }
    const existingSequence = Number(row.provider_sequence || 0);
    if (existingSequence && existingSequence !== payload.seq) {
      throw projectionError('provider_sequence_conflict', 'Local message already has a different Tinode sequence');
    }
    try {
      await pg.query(
        `UPDATE collaboration_messages
         SET provider_origin = 'ivekit', provider_sequence = $4,
             provider_version = GREATEST(provider_version, $4),
             provider_sender_id = $5, provider_message_id = $6,
             provider_delivery_status = 'delivered',
             provider_delivered_at = COALESCE(provider_delivered_at, $7),
             provider_delivery_updated_at = $7
         WHERE id = $1 AND tenant_id = $2 AND session_id = $3`,
        [
          messageId,
          claim.tenant_id,
          claim.session_id,
          payload.seq,
          payload.from,
          String(payload.seq),
          payload.ts || this.now().toISOString()
        ]
      );
    } catch (error) {
      rethrowSequenceConflict(error);
    }
    return { status: 'ignored', message_id: messageId };
  }

  private async projectMessage(
    pg: PgQueryable,
    claim: TinodeInboundClaim,
    payload: TinodeInboundDataPayload,
    payloadHash: string
  ): Promise<TinodeInboundProjectionResult> {
    const identity = await new TinodeProviderUserStore(pg).resolveIdentity({
      tenant_id: claim.tenant_id,
      binding_id: claim.binding_id,
      provider_user_id: payload.from
    });
    if (!identity) throw projectionError('provider_user_unmapped', 'Tinode provider user is not mapped', true);
    const session = await pg.query(
      `SELECT status FROM collaboration_sessions WHERE id = $1 AND tenant_id = $2`,
      [claim.session_id, claim.tenant_id]
    );
    if (!session.rows[0]) throw projectionError('session_not_found', 'Collaboration session was not found');
    if (String(session.rows[0].status) !== 'open') {
      throw projectionError('session_closed', 'Collaboration session is closed');
    }

    const collaboration = new CollaborationStore(pg);
    const created = await collaboration.postOutgoingMessage({
      tenant_id: claim.tenant_id,
      session_id: claim.session_id,
      sender_identity: identity,
      message_type: messageType(payload),
      body: payload.body,
      metadata: {
        source: 'tinode_inbound',
        provider_sequence: payload.seq,
        provider_sender_id: payload.from
      },
      attachments: payload.attachments.map((attachment) => ({
        ...attachment,
        processing_status: 'ready'
      })),
      idempotency_key: `tinode:${claim.binding_id}:data:${payload.seq}`,
      idempotency_payload_hash: payloadHash,
      provider: 'tinode',
      provider_topic_id: claim.provider_topic_id,
      provider_payload: payload.body || payload.attachments.map((attachment) => attachment.filename || attachment.storage_url).join('\n'),
      provider_metadata: { source: 'tinode_inbound' },
      provider_delivery_status: 'delivered'
    });
    try {
      await pg.query(
        `UPDATE collaboration_messages
         SET provider_origin = 'tinode', provider_sequence = $4,
             provider_version = GREATEST(provider_version, $4),
             provider_sender_id = $5, provider_message_id = $6,
             provider_delivered_at = COALESCE(provider_delivered_at, $7),
             provider_delivery_updated_at = $7
         WHERE id = $1 AND tenant_id = $2 AND session_id = $3`,
        [
          created.message.id,
          claim.tenant_id,
          claim.session_id,
          payload.seq,
          payload.from,
          String(payload.seq),
          payload.ts || this.now().toISOString()
        ]
      );
    } catch (error) {
      rethrowSequenceConflict(error);
    }
    if (created.created && payload.body.trim()) {
      await collaboration.scanPolicy({
        tenant_id: claim.tenant_id,
        session_id: claim.session_id,
        message_id: created.message.id,
        source: 'text',
        source_ref_id: `tinode:${claim.binding_id}:data:${payload.seq}`,
        evidence_refs: [{ type: 'message', id: created.message.id, version: 0 }],
        text: payload.body
      });
    }
    return { status: 'projected', message_id: created.message.id };
  }

  private async projectReplacement(
    pg: PgQueryable,
    claim: TinodeInboundClaim,
    payload: TinodeInboundDataPayload
  ): Promise<TinodeInboundProjectionResult> {
    const identity = await new TinodeProviderUserStore(pg).resolveIdentity({
      tenant_id: claim.tenant_id,
      binding_id: claim.binding_id,
      provider_user_id: payload.from
    });
    if (!identity) throw projectionError('provider_user_unmapped', 'Tinode provider user is not mapped', true);
    const targetSequence = Number(payload.head.replace.slice('msg:'.length));
    const target = await pg.query(
      `SELECT * FROM collaboration_messages
       WHERE tenant_id = $1 AND session_id = $2 AND provider = 'tinode'
         AND provider_topic_id = $3 AND provider_sequence = $4
       FOR UPDATE`,
      [claim.tenant_id, claim.session_id, claim.provider_topic_id, targetSequence]
    );
    const row = target.rows[0];
    if (!row) throw projectionError('replacement_target_missing', 'Tinode replacement target is not available', true);
    if (String(row.provider_sender_id) !== payload.from || String(row.sender_identity) !== identity) {
      throw projectionError('replacement_sender_mismatch', 'Tinode replacement sender does not own the target');
    }
    const message = await new CollaborationMessageStateStore(
      pg,
      this.now,
      this.mutationWindowMs
    ).editMessage({
      tenant_id: claim.tenant_id,
      session_id: claim.session_id,
      message_id: String(row.id),
      actor_identity: identity,
      body: payload.body,
      reason: `tinode replacement seq ${payload.seq}`
    });
    await pg.query(
      `UPDATE collaboration_messages
       SET provider_version = GREATEST(provider_version, $3)
       WHERE id = $1 AND tenant_id = $2`,
      [message.id, claim.tenant_id, payload.seq]
    );
    return { status: 'projected', message_id: message.id };
  }

  private async projectDelete(
    pg: PgQueryable,
    claim: TinodeInboundClaim,
    payload: TinodeInboundDeletePayload
  ): Promise<TinodeInboundProjectionResult> {
    const low = Math.min(...payload.ranges.map((range) => range.low));
    const high = Math.max(...payload.ranges.map((range) => range.hi));
    const candidates = await pg.query(
      `SELECT * FROM collaboration_messages
       WHERE tenant_id = $1 AND session_id = $2 AND provider = 'tinode'
         AND provider_topic_id = $3
         AND provider_sequence >= $4 AND provider_sequence < $5
       ORDER BY provider_sequence ASC
       FOR UPDATE`,
      [claim.tenant_id, claim.session_id, claim.provider_topic_id, low, high]
    );
    const selected = candidates.rows.filter((row) => payload.ranges.some((range) =>
      Number(row.provider_sequence) >= range.low && Number(row.provider_sequence) < range.hi
    ));
    for (const row of selected) {
      if (row.deleted_at) continue;
      const beforeBody = String(row.current_body || row.body || '');
      const nextVersion = Number(row.edit_version || 0) + 1;
      const timestamp = this.now().toISOString();
      await pg.query(
        `UPDATE collaboration_messages
         SET edit_version = $3, deleted_at = $4, deleted_by = 'tinode',
             provider_version = GREATEST(provider_version, $5)
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [row.id, claim.tenant_id, nextVersion, timestamp, payload.delete_id]
      );
      await pg.query(
        `INSERT INTO collaboration_message_mutations
          (id, tenant_id, session_id, message_id, version, action, actor_identity,
           before_body_hash, after_body_hash, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, 'delete', 'tinode', $6, $7, $8, $9)`,
        [
          pgId('cmut'),
          claim.tenant_id,
          claim.session_id,
          row.id,
          nextVersion,
          sha256(beforeBody),
          sha256(''),
          `tinode delete ${payload.delete_id}`,
          timestamp
        ]
      );
    }
    return {
      status: selected.length > 0 ? 'projected' : 'ignored',
      message_id: selected.length === 1 ? String(selected[0].id) : undefined
    };
  }
}

function messageType(payload: TinodeInboundDataPayload): CollaborationMessageType {
  const kind = payload.attachments[0]?.kind;
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind) return 'file';
  return 'text';
}

function projectionError(code: string, message: string, retryable = false): TinodeInboundProjectionError {
  return new TinodeInboundProjectionError(code, message, retryable);
}

function rethrowSequenceConflict(error: unknown): never | void {
  if (String((error as { code?: unknown }).code || '') === '23505') {
    throw projectionError('provider_sequence_conflict', 'Tinode sequence is already assigned to another message');
  }
  throw error;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
