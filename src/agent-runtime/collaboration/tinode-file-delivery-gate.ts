import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';

export type TinodeFileDeliveryGateStatus =
  | 'pending'
  | 'blocked_by_file_security'
  | 'blocked';

export interface TinodeFileDeliveryTransition {
  tenant_id: string;
  session_id: string;
  message_id: string;
  previous_status: string;
  status: TinodeFileDeliveryGateStatus;
  reason: 'all_files_ready' | 'files_pending' | 'file_terminal';
  secure_file_count: number;
  pending_file_count: number;
  terminal_file_count: number;
}

export interface TinodeFileDeliveryGateInput {
  pg: PgQueryable;
  now?: () => Date;
  onTransition?: (transition: TinodeFileDeliveryTransition) => void | Promise<void>;
}

export class TinodeFileDeliveryGate {
  private readonly now: () => Date;

  constructor(private readonly input: TinodeFileDeliveryGateInput) {
    this.now = input.now || (() => new Date());
  }

  async reconcileMessage(input: {
    tenant_id: string;
    message_id: string;
  }): Promise<TinodeFileDeliveryTransition | null> {
    const transition = await withPgTenant(this.input.pg, input.tenant_id, (pg) =>
      reconcileMessage(pg, input.tenant_id, input.message_id, this.now())
    );
    if (transition) await this.input.onTransition?.(transition);
    return transition;
  }

  async reconcileFile(input: {
    tenant_id: string;
    secure_file_id: string;
    limit?: number;
  }): Promise<TinodeFileDeliveryTransition[]> {
    const limit = boundedLimit(input.limit);
    const messageIds = await withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT DISTINCT message.id
         FROM collaboration_messages AS message
         JOIN collaboration_message_attachments AS attachment
           ON attachment.tenant_id = message.tenant_id
          AND attachment.session_id = message.session_id
          AND attachment.message_id = message.id
         WHERE message.tenant_id = $1 AND message.provider = 'tinode'
           AND attachment.secure_file_id = $2
           AND message.provider_delivery_status IN (
             'pending', 'retry_wait', 'blocked_by_file_security', 'blocked'
           )
         ORDER BY message.id
         LIMIT $3`,
        [input.tenant_id, input.secure_file_id, limit]
      );
      return result.rows.map((row) => String(row.id));
    });
    return this.reconcileIds(input.tenant_id, messageIds);
  }

  async reconcileDue(input: {
    tenant_id: string;
    limit?: number;
  }): Promise<TinodeFileDeliveryTransition[]> {
    const limit = boundedLimit(input.limit);
    const messageIds = await withPgTenant(this.input.pg, input.tenant_id, async (pg) => {
      const result = await pg.query(
        `SELECT message.id
         FROM collaboration_messages AS message
         WHERE message.tenant_id = $1 AND message.provider = 'tinode'
           AND message.provider_delivery_status IN (
             'pending', 'retry_wait', 'blocked_by_file_security', 'blocked'
           )
           AND EXISTS (
             SELECT 1 FROM collaboration_message_attachments AS attachment
             WHERE attachment.tenant_id = message.tenant_id
               AND attachment.session_id = message.session_id
               AND attachment.message_id = message.id
               AND attachment.secure_file_id IS NOT NULL
           )
         ORDER BY message.provider_delivery_updated_at ASC, message.id ASC
         LIMIT $2`,
        [input.tenant_id, limit]
      );
      return result.rows.map((row) => String(row.id));
    });
    return this.reconcileIds(input.tenant_id, messageIds);
  }

  private async reconcileIds(
    tenantId: string,
    messageIds: string[]
  ): Promise<TinodeFileDeliveryTransition[]> {
    const transitions: TinodeFileDeliveryTransition[] = [];
    for (const messageId of messageIds) {
      const transition = await this.reconcileMessage({ tenant_id: tenantId, message_id: messageId });
      if (transition) transitions.push(transition);
    }
    return transitions;
  }
}

async function reconcileMessage(
  pg: PgQueryable,
  tenantId: string,
  messageId: string,
  now: Date
): Promise<TinodeFileDeliveryTransition | null> {
  const messageResult = await pg.query(
    `SELECT id, session_id, provider_delivery_status
     FROM collaboration_messages
     WHERE id = $1 AND tenant_id = $2 AND provider = 'tinode'
     FOR UPDATE`,
    [messageId, tenantId]
  );
  const message = messageResult.rows[0];
  if (!message) return null;
  const previousStatus = String(message.provider_delivery_status);
  if (!['pending', 'retry_wait', 'blocked_by_file_security', 'blocked'].includes(previousStatus)) {
    return null;
  }
  const stateResult = await pg.query(
    `SELECT
       COUNT(*)::INTEGER AS secure_file_count,
       COUNT(*) FILTER (
         WHERE file.status = 'ready' AND file.threat_status = 'clean'
       )::INTEGER AS ready_file_count,
       COUNT(*) FILTER (
         WHERE file.status IN ('quarantined', 'failed', 'expired')
       )::INTEGER AS terminal_file_count
     FROM collaboration_message_attachments AS attachment
     JOIN collaboration_secure_files AS file
       ON file.tenant_id = attachment.tenant_id
      AND file.session_id = attachment.session_id
      AND file.id = attachment.secure_file_id
     WHERE attachment.tenant_id = $1 AND attachment.session_id = $2
       AND attachment.message_id = $3
       AND attachment.secure_file_id IS NOT NULL`,
    [tenantId, String(message.session_id), messageId]
  );
  const state = stateResult.rows[0] || {};
  const secureFileCount = Number(state.secure_file_count || 0);
  const readyFileCount = Number(state.ready_file_count || 0);
  const terminalFileCount = Number(state.terminal_file_count || 0);
  const pendingFileCount = Math.max(0, secureFileCount - readyFileCount - terminalFileCount);
  if (secureFileCount === 0) return null;

  let status: TinodeFileDeliveryGateStatus;
  let reason: TinodeFileDeliveryTransition['reason'];
  let errorCode: string;
  let errorMessage: string;
  if (terminalFileCount > 0) {
    status = 'blocked';
    reason = 'file_terminal';
    errorCode = 'file_security_terminal';
    errorMessage = 'message delivery blocked by terminal file security state';
  } else if (readyFileCount !== secureFileCount) {
    status = 'blocked_by_file_security';
    reason = 'files_pending';
    errorCode = 'blocked_by_file_security';
    errorMessage = 'message delivery is waiting for secure files';
  } else {
    if (previousStatus === 'blocked') return null;
    status = 'pending';
    reason = 'all_files_ready';
    errorCode = '';
    errorMessage = '';
  }
  if (status === previousStatus) return null;

  const updated = await pg.query(
    `UPDATE collaboration_messages
     SET provider_delivery_status = $3,
         provider_next_attempt_at = CASE WHEN $3 = 'pending' THEN NULL ELSE provider_next_attempt_at END,
         provider_last_error_code = $4,
         provider_last_error_message = $5,
         provider_delivery_updated_at = $6
     WHERE id = $1 AND tenant_id = $2
       AND provider_delivery_status = $7
     RETURNING id`,
    [
      messageId,
      tenantId,
      status,
      errorCode,
      errorMessage,
      now.toISOString(),
      previousStatus
    ]
  );
  if (!updated.rows[0]) return null;
  return {
    tenant_id: tenantId,
    session_id: String(message.session_id),
    message_id: messageId,
    previous_status: previousStatus,
    status,
    reason,
    secure_file_count: secureFileCount,
    pending_file_count: pendingFileCount,
    terminal_file_count: terminalFileCount
  };
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 200;
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  return Math.min(limit, 1_000);
}
