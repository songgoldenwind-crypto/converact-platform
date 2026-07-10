import { one } from '../../db.js';
import { broadcastCallCompleted, broadcastOutboundTaskUpdated } from '../../call-center-events.js';
import { deleteCallSessionCache, initCallSessionCache } from '../../redis-session-cache.js';
import type { VoiceStore } from '../voice/voice-store.js';
import type { OutboundTaskStore } from './outbound-task-store.js';
import type { RWIClientLike } from './rwi-client.js';
import type { RWIEvent } from './rwi-types.js';
import type { TaskLockStore } from './task-lock.js';
import { findSessionByRustpbxCallId } from './outbound-dialer.js';
import { dialerWaitRegistry } from './dialer-wait-registry.js';

export interface RwiSessionSyncDeps {
  db: unknown;
  voiceStore: VoiceStore;
  outboundTaskStore: OutboundTaskStore;
  taskLock: TaskLockStore;
}

let attachedClient: RWIClientLike | null = null;

export function attachRwiSessionSync(client: RWIClientLike, deps: RwiSessionSyncDeps): void {
  if (attachedClient === client) return;
  attachedClient = client;

  client.onEvent((event: RWIEvent) => {
    // Telephony signaling callbacks are high-frequency and must not crash the
    // process on a single bad event. handleRwiEvent does DB writes (taskLock,
    // session updates) that can reject on transient DB failures.
    void handleRwiEvent(event, deps).catch((error) => {
      console.warn('[rwi] event handling failed:', error instanceof Error ? error.message : error);
    });
  });
}

async function handleRwiEvent(event: RWIEvent, deps: RwiSessionSyncDeps): Promise<void> {
  const callId = String(event.call_id || '');
  const state = String(event.state || '');
  if (!callId) return;

  dialerWaitRegistry.notifyCallState(callId, state);

  const sessionRow = findSessionByRustpbxCallId(deps.db, callId);
  if (!sessionRow) return;

  const tenantId = String(sessionRow.tenant_id);
  const sessionId = String(sessionRow.id);
  const sessionPatch: Record<string, unknown> = {};
  let taskPatch: Record<string, unknown> | null = null;

  const taskId = one(deps.db, 'SELECT id, attempt_count, max_attempts FROM outbound_tasks WHERE call_session_id = ?', [
    sessionId
  ]);

  switch (state) {
    case 'ringing':
      sessionPatch.status = 'ringing';
      taskPatch = { status: 'dialing' };
      break;
    case 'answered':
      sessionPatch.status = 'active';
      sessionPatch.started_at = event.timestamp || new Date().toISOString();
      sessionPatch.ai_handled = 1;
      taskPatch = { status: 'connected' };
      break;
    case 'hangup': {
      const cause = String(event.data?.hangup_cause || 'unknown');
      const normal = cause === 'normal_clearing';
      sessionPatch.status = normal ? 'completed' : 'failed';
      sessionPatch.ended_at = event.timestamp || new Date().toISOString();
      if (taskId?.id) {
        if (normal) {
          taskPatch = {
            status: 'completed',
            completed_at: event.timestamp || new Date().toISOString(),
            result: { hangup_cause: cause, answered: true }
          };
        } else {
          const nextAttempts = Number(taskId.attempt_count || 0) + 1;
          const failedPermanent = nextAttempts >= Number(taskId.max_attempts || 3);
          taskPatch = {
            status: failedPermanent ? 'failed' : 'pending',
            attempt_count: nextAttempts,
            completed_at: failedPermanent ? event.timestamp || new Date().toISOString() : null,
            result: { hangup_cause: cause, answered: false }
          };
        }
      }
      break;
    }
    default:
      break;
  }

  if (Object.keys(sessionPatch).length) {
    deps.voiceStore.updateCallSession(tenantId, sessionId, sessionPatch);
  }
  if (taskPatch && taskId?.id) {
    const updated = deps.outboundTaskStore.updateTask(String(taskId.id), taskPatch as any);
    if (updated) {
      broadcastOutboundTaskUpdated(tenantId, updated as unknown as Record<string, unknown>);
      if (updated.status === 'completed' || updated.status === 'failed') {
        broadcastCallCompleted(tenantId, {
          call_session_id: sessionId,
          task_id: String(taskId.id),
          status: updated.status,
          phone_number: String(updated.phone_number || ''),
          result: (updated.result as Record<string, unknown>) || {}
        });
        void deleteCallSessionCache(sessionId).catch((error) => {
          console.warn('[session-cache] delete failed:', error);
        });
      }
    }
  }

  await deps.taskLock.setCallActive(callId, {
    state,
    tenant_id: tenantId,
    session_id: sessionId,
    updated_at: new Date().toISOString()
  });
}
