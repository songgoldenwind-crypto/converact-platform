import { resolveBrandEnv } from '../../config/converact-env.js';
import type { OutboundTaskRow } from './outbound-task-store.js';

/** hangup_cause → wait ms before re-pick; null = never retry */
export const RETRY_DELAY_MS: Record<string, number | null> = {
  no_answer: 30_000,
  busy: 30_000,
  reject: 2 * 60 * 60 * 1000,
  decline: 2 * 60 * 60 * 1000,
  invalid_number: null,
  network_error: 60_000,
  normal_clearing: null
};

export function retryDelayForCause(hangupCause: string): number | null {
  const key = String(hangupCause || '').toLowerCase();
  if (key in RETRY_DELAY_MS) return RETRY_DELAY_MS[key];
  if (key.includes('no_answer') || key.includes('timeout')) return RETRY_DELAY_MS.no_answer;
  if (key.includes('busy')) return RETRY_DELAY_MS.busy;
  if (key.includes('reject') || key.includes('decline')) return RETRY_DELAY_MS.reject;
  return 30_000;
}

export function isTaskReadyForRetry(task: OutboundTaskRow, now = Date.now()): boolean {
  if (task.status !== 'pending') return false;
  if (task.scheduled_at && new Date(task.scheduled_at).getTime() > now) return false;
  const cause = String(task.result?.hangup_cause || '');
  if (!cause) return true;
  const delay = retryDelayForCause(cause);
  if (delay === null) return false;
  const updatedAt = new Date(task.updated_at || task.created_at).getTime();
  return now - updatedAt >= delay;
}

export function isInDialingWindow(_tenantId: string, now = new Date()): boolean {
  if (resolveBrandEnv(process.env, 'DIALER_IGNORE_WINDOW') === '1') return true;
  const jstHour = (now.getUTCHours() + 9) % 24;
  return jstHour >= 9 && jstHour < 18;
}
