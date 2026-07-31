import type { PgQueryable } from '../../db-pg.js';
import {
  configuredChatGateway,
  type ChatGateway
} from './chat-gateway.js';
import { withCollaborationSessionLock } from './collaboration-lock.js';
import { CollaborationStore } from './collaboration-store.js';
import { TinodeInboundStore } from './tinode-inbound-store.js';
import { TinodeProviderUserStore } from './tinode-provider-user-store.js';
import type {
  CollaborationChatBinding,
  CollaborationSession
} from './types.js';

export interface CollaborationSessionCloseSuccess {
  ok: true;
  session: CollaborationSession;
  was_open: boolean;
  after_commit?: () => Promise<void>;
}

export interface CollaborationSessionCloseFailure {
  ok: false;
  status: 403 | 404 | 409 | 503;
  error: string;
}

export type CollaborationSessionCloseResult =
  | CollaborationSessionCloseSuccess
  | CollaborationSessionCloseFailure;

export async function closeCollaborationSession(input: {
  pg: PgQueryable;
  tenant_id: string;
  session_id: string;
  actor_identity: string;
  gateway?: ChatGateway;
  resolve_gateway?: (pg: PgQueryable) => Promise<ChatGateway>;
  on_tinode_closed?: (
    pg: PgQueryable,
    binding: CollaborationChatBinding
  ) => Promise<(() => Promise<void>) | undefined>;
}): Promise<CollaborationSessionCloseResult> {
  return withCollaborationSessionLock(input.pg, {
    tenantId: input.tenant_id,
    sessionId: input.session_id,
    mode: 'exclusive'
  }, async (lockedPg) => {
    const sessions = new CollaborationStore(lockedPg);
    const current = await sessions.getSession(input.session_id);
    if (!current || current.tenant_id !== input.tenant_id) {
      return closeFailure(404, 'collaboration session not found');
    }

    const participants = await sessions.listParticipants({
      tenant_id: input.tenant_id,
      session_id: current.id
    });
    if (!participants.some((participant) =>
      participant.identity === input.actor_identity && !participant.left_at
    )) {
      return closeFailure(403, 'active participant identity is required');
    }

    const binding = await sessions.getChatBinding({
      tenant_id: input.tenant_id,
      session_id: current.id
    });
    const activeParticipants = participants.filter((participant) => !participant.left_at);
    const providerUsers = binding?.provider === 'tinode'
      ? new TinodeProviderUserStore(lockedPg)
      : null;
    const revokeTargets = await Promise.all(activeParticipants.map(async (participant) => {
      const mapped = providerUsers
        ? await providerUsers.getByIdentity({
          tenant_id: input.tenant_id,
          session_id: current.id,
          provider: 'tinode',
          identity: participant.identity
        })
        : null;
      return {
        participant,
        mapped,
        providerUserId: mapped?.status === 'active' ? mapped.provider_user_id : undefined
      };
    }));
    const missingMapping = providerUsers && revokeTargets.some(({ mapped, providerUserId }) =>
      current.status === 'closed' ? !mapped : !providerUserId
    );
    if (missingMapping) {
      return closeFailure(
        409,
        current.status === 'closed'
          ? 'closed Tinode session requires provider access reconciliation'
          : 'active Tinode participant is missing its provider user mapping'
      );
    }

    const activeRevokeTargets = providerUsers
      ? revokeTargets.filter((target) => Boolean(target.providerUserId))
      : current.status === 'open'
        ? revokeTargets
        : [];
    let gateway: ChatGateway | undefined;
    if (binding && activeRevokeTargets.length > 0) {
      gateway = input.gateway ||
        await input.resolve_gateway?.(lockedPg) ||
        configuredChatGateway();
      if (binding.provider !== gateway.provider) {
        return closeFailure(503, 'chat provider gateway is unavailable');
      }
    }

    if (binding && gateway) {
      await Promise.all(activeRevokeTargets.map(({ participant, providerUserId }) =>
        gateway.removeParticipant({
          tenant_id: input.tenant_id,
          session_id: current.id,
          provider_topic_id: binding.provider_topic_id,
          identity: participant.identity,
          display_name: participant.display_name,
          provider_user_id: providerUserId,
          access_mode: 'N'
        })
      ));
    }

    if (providerUsers) {
      await Promise.all(activeRevokeTargets.map(({ participant }) =>
        providerUsers.revokeIdentity({
          tenant_id: input.tenant_id,
          session_id: current.id,
          provider: 'tinode',
          identity: participant.identity
        })
      ));
    }
    if (binding?.provider === 'tinode') {
      await new TinodeInboundStore({ pg: lockedPg }).pauseBinding({
        tenant_id: input.tenant_id,
        binding_id: binding.id
      });
    }
    await cancelPendingTinodeDeliveries(lockedPg, input.tenant_id, current.id);
    await cancelPendingTinodeMutations(lockedPg, input.tenant_id, current.id);

    const wasOpen = current.status === 'open';
    const closed = wasOpen
      ? await sessions.closeSession(current.id)
      : current;
    if (!closed) return closeFailure(404, 'collaboration session not found');
    const afterCommit = wasOpen && binding?.provider === 'tinode'
      ? await input.on_tinode_closed?.(lockedPg, binding)
      : undefined;
    return {
      ok: true,
      session: closed,
      was_open: wasOpen,
      ...(afterCommit ? { after_commit: afterCommit } : {})
    };
  });
}

async function cancelPendingTinodeDeliveries(
  pg: PgQueryable,
  tenantId: string,
  sessionId: string
): Promise<void> {
  await pg.query(
    `UPDATE collaboration_message_delivery_attempts AS attempt
     SET status = 'failed', completed_at = CURRENT_TIMESTAMP,
         error_code = 'session_closed',
         error_message = 'collaboration session closed before provider delivery completed'
     FROM collaboration_messages AS message
     WHERE message.id = attempt.message_id
       AND message.tenant_id = attempt.tenant_id
       AND message.tenant_id = $1 AND message.session_id = $2
       AND message.provider = 'tinode'
       AND message.provider_delivery_status IN (
         'pending', 'blocked_by_file_security', 'publishing', 'retry_wait'
       )
       AND attempt.status = 'started'`,
    [tenantId, sessionId]
  );
  await pg.query(
    `UPDATE collaboration_messages
     SET provider_delivery_status = 'failed',
         provider_delivery_claim_token_hash = '',
         provider_delivery_lease_until = NULL,
         provider_next_attempt_at = NULL,
         provider_last_error_code = 'session_closed',
         provider_last_error_message = 'collaboration session closed before provider delivery completed',
         provider_delivery_updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $1 AND session_id = $2 AND provider = 'tinode'
       AND provider_delivery_status IN (
         'pending', 'blocked_by_file_security', 'publishing', 'retry_wait'
       )`,
    [tenantId, sessionId]
  );
}

async function cancelPendingTinodeMutations(
  pg: PgQueryable,
  tenantId: string,
  sessionId: string
): Promise<void> {
  await pg.query(
    `UPDATE tinode_message_mutation_outbox
     SET status = 'dead_letter', next_attempt_at = NULL,
         claim_token = '', claimed_until = NULL,
         last_error_code = 'session_closed',
         last_error_message = 'collaboration session closed before provider mutation completed',
         completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE tenant_id = $1 AND session_id = $2
       AND status IN ('pending', 'processing', 'retry_wait')`,
    [tenantId, sessionId]
  );
}

function closeFailure(
  status: CollaborationSessionCloseFailure['status'],
  error: string
): CollaborationSessionCloseFailure {
  return { ok: false, status, error };
}
