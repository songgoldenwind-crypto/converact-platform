import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from '../../../metrics.js';

const pendingActionTotal = new Counter({
  name: 'opc_ivekit_ivr_pending_actions_total',
  help: 'Total iveKit IVR pending action outcomes',
  labelNames: ['kind', 'result', 'error_code'],
  registers: [metricsRegistry]
});

const pendingActionDuration = new Histogram({
  name: 'opc_ivekit_ivr_pending_action_duration_seconds',
  help: 'iveKit IVR pending action execution duration',
  labelNames: ['kind', 'result'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120],
  registers: [metricsRegistry]
});

const reconciliationTotal = new Counter({
  name: 'opc_ivekit_ivr_reconciliations_total',
  help: 'Total iveKit IVR pending action reconciliation outcomes',
  labelNames: ['kind', 'result'],
  registers: [metricsRegistry]
});

const sessionEventTotal = new Counter({
  name: 'opc_ivekit_ivr_session_events_total',
  help: 'Total committed iveKit IVR session transition events',
  labelNames: ['event_type', 'state'],
  registers: [metricsRegistry]
});

export const ivrMetricDefinitions = [
  { name: 'opc_ivekit_ivr_pending_actions_total', labels: ['kind', 'result', 'error_code'] },
  { name: 'opc_ivekit_ivr_pending_action_duration_seconds', labels: ['kind', 'result'] },
  { name: 'opc_ivekit_ivr_reconciliations_total', labels: ['kind', 'result'] },
  { name: 'opc_ivekit_ivr_session_events_total', labels: ['event_type', 'state'] }
];

export function observeIvrPendingAction(input: {
  kind: string;
  result: string;
  error_code?: string;
  duration_seconds: number;
}): void {
  const kind = enumLabel(input.kind, ACTION_KINDS);
  const result = enumLabel(input.result, ACTION_RESULTS);
  pendingActionTotal.labels(kind, result, errorLabel(input.error_code)).inc();
  pendingActionDuration.labels(kind, result).observe(nonNegative(input.duration_seconds));
}

export function observeIvrReconciliation(input: { kind: string; result: string }): void {
  reconciliationTotal.labels(
    enumLabel(input.kind, ACTION_KINDS),
    enumLabel(input.result, RECONCILIATION_RESULTS)
  ).inc();
}

export function observeIvrSessionEvent(input: { type: string; state: string }): void {
  sessionEventTotal.labels(
    enumLabel(input.type, SESSION_EVENT_TYPES),
    enumLabel(input.state, SESSION_STATES)
  ).inc();
}

const ACTION_KINDS = new Set([
  'play', 'collect', 'flush', 'queue', 'transfer', 'record', 'webhook',
  'knowledge', 'ai', 'media', 'hangup', 'wait'
]);
const ACTION_RESULTS = new Set(['succeeded', 'retry_wait', 'uncertain', 'failed']);
const RECONCILIATION_RESULTS = new Set(['succeeded', 'failed', 'uncertain']);
const SESSION_EVENT_TYPES = new Set([
  'ivr.session.started', 'ivr.session.step_completed', 'ivr.session.waiting',
  'ivr.session.completed'
]);
const SESSION_STATES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled']);
const ERROR_CODES = new Set([
  'none', 'validation_failed', 'publish_validation_failed', 'not_found', 'resource_in_use',
  'revision_conflict', 'idempotency_conflict', 'capability_unavailable',
  'event_sequence_conflict', 'invalid_session_state', 'step_limit_exceeded',
  'simulation_limit_exceeded', 'simulation_script_mismatch', 'branch_missing',
  'lease_lost', 'provider_timeout', 'provider_result_unknown', 'internal_error'
]);

function errorLabel(value: string | undefined): string {
  const label = value || 'none';
  return ERROR_CODES.has(label) ? label : 'other';
}

function enumLabel(value: string, allowed: ReadonlySet<string>): string {
  return allowed.has(value) ? value : 'other';
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
