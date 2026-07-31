import { id, run } from '../../db.js';
import type { VoiceStore } from '../voice/voice-store.js';
import { getComplianceSettings } from './compliance/retention-policy.js';
import type { OutboundTaskStore } from './outbound-task-store.js';
import type { RustPBXCDR } from './types.js';

// Lazy imports to avoid circular dependency at module load time.
// These are loaded on first CDR ingestion, not at import time.
let _triggerAutoQmEvaluation: ((db: unknown, tenantId: string, callSessionId: string) => Promise<void>) | null = null;
let _generateCallSummary: ((db: unknown, tenantId: string, callSessionId: string) => Promise<unknown>) | null = null;

async function loadPostCallHooks() {
  if (!_triggerAutoQmEvaluation) {
    const mod = await import('./qm/auto-evaluate.js');
    _triggerAutoQmEvaluation = mod.triggerAutoQmEvaluation;
  }
  if (!_generateCallSummary) {
    const mod = await import('./agent-tools/auto-summary.js');
    _generateCallSummary = mod.generateCallSummary;
  }
}

export interface CdrReceiverDeps {
  voiceStore: VoiceStore;
  outboundTaskStore: OutboundTaskStore;
  defaultTenantId?: string | null;
  /** Database handle for post-call hooks (auto QM evaluation + summary). */
  db?: unknown;
}

export function ingestRustpbxCdr(cdr: RustPBXCDR, deps: CdrReceiverDeps) {
  const tenantId = String(cdr.metadata?.tenant_id || deps.defaultTenantId || '').trim();
  if (!tenantId) throw new Error('tenant_id is required in CDR metadata');

  const hangupCause = String(cdr.hangup_cause || 'unknown');
  const answered = Boolean(cdr.answer_time);
  const session = deps.voiceStore.ingestRustpbxEvent({
    tenant_id: tenantId,
    rustpbx_call_id: cdr.call_id,
    direction: cdr.direction,
    event_type: answered ? 'hangup' : 'no_answer',
    status: answered ? 'completed' : 'failed',
    occurred_at: cdr.end_time || new Date().toISOString(),
    payload: {
      hangup_cause: hangupCause,
      duration_sec: cdr.duration_sec,
      recording_url: cdr.recording_url
    }
  });

  if (cdr.recording_url) {
    const completedAt = normalizeTimestamp(cdr.end_time) || new Date().toISOString();
    const retentionDays = getComplianceSettings(
      deps.voiceStore.db,
      tenantId
    ).recording_retention_days;
    const retentionUntil = new Date(
      new Date(completedAt).getTime() + retentionDays * 86_400_000
    ).toISOString();
    run(
      deps.voiceStore.db,
      `INSERT INTO call_recordings
        (id, tenant_id, call_session_id, business_ref_type, business_ref_id, business_ref_metadata,
         source, format, storage_url, duration_ms, has_video, status, retention_until,
         object_status, failure_code, completed_at, updated_at)
       VALUES (?, ?, ?, 'call_session', ?, '{}', 'rustpbx_sipflow', 'wav', ?, ?, 0,
               'completed', ?, 'unchecked', '', ?, CURRENT_TIMESTAMP)`,
      [
        id('crec'),
        tenantId,
        session.id,
        session.id,
        cdr.recording_url,
        Number(cdr.duration_sec || 0) * 1000,
        retentionUntil,
        completedAt
      ]
    );
  }

  const taskId = cdr.metadata?.outbound_task_id;
  if (taskId) {
    const task = deps.outboundTaskStore.getTask(taskId);
    if (task) {
      const nextStatus = answered ? 'completed' : task.attempt_count + 1 >= task.max_attempts ? 'failed' : 'pending';
      deps.outboundTaskStore.updateTask(taskId, {
        status: nextStatus,
        completed_at: new Date().toISOString(),
        call_session_id: session.id,
        attempt_count: answered ? task.attempt_count : task.attempt_count + 1,
        result: {
          hangup_cause: hangupCause,
          duration_sec: cdr.duration_sec,
          answered
        }
      });
    }
  }

  // Post-call hooks: trigger auto QM evaluation + call summary.
  // Only for answered calls (no_answer has no conversation turns to evaluate).
  // Fire-and-forget — CDR webhook should return immediately.
  // Dedup: triggerAutoQmEvaluation checks getEvaluationBySession before creating.
  if (answered && deps.db) {
    void loadPostCallHooks().then(() => {
      _triggerAutoQmEvaluation?.(deps.db, tenantId, session.id);
      _generateCallSummary?.(deps.db, tenantId, session.id);
    }).catch((error) => {
      console.warn('[cdr-receiver] post-call hooks failed:', error);
    });
  }

  return session;
}

function normalizeTimestamp(value: unknown): string | null {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
