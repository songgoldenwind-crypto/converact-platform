import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from '../../../metrics.js';
import type {
  VoiceAdapter,
  VoiceCallState,
  VoiceCommandKind,
  VoiceRouteDirection
} from './types.js';

const callTotal = new Counter({
  name: 'opc_ivekit_voice_calls_total',
  help: 'Total iveKit Voice call lifecycle observations',
  labelNames: ['adapter', 'direction', 'state'],
  registers: [metricsRegistry]
});

const commandTotal = new Counter({
  name: 'opc_ivekit_voice_commands_total',
  help: 'Total iveKit Voice command outcomes',
  labelNames: ['adapter', 'kind', 'result', 'error_code'],
  registers: [metricsRegistry]
});

const commandDuration = new Histogram({
  name: 'opc_ivekit_voice_command_duration_seconds',
  help: 'iveKit Voice command duration',
  labelNames: ['adapter', 'kind', 'result'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120],
  registers: [metricsRegistry]
});

const uncertainTotal = new Counter({
  name: 'opc_ivekit_voice_uncertain_commands_total',
  help: 'Total iveKit Voice commands entering uncertain state',
  labelNames: ['adapter', 'kind'],
  registers: [metricsRegistry]
});

const reconciliationTotal = new Counter({
  name: 'opc_ivekit_voice_reconciliations_total',
  help: 'Total iveKit Voice reconciliation outcomes',
  labelNames: ['adapter', 'result'],
  registers: [metricsRegistry]
});

const providerEventTotal = new Counter({
  name: 'opc_ivekit_voice_provider_events_total',
  help: 'Total iveKit Voice provider event outcomes',
  labelNames: ['adapter', 'event_type', 'result'],
  registers: [metricsRegistry]
});

const providerEventLag = new Histogram({
  name: 'opc_ivekit_voice_provider_event_lag_seconds',
  help: 'iveKit Voice provider event processing lag',
  labelNames: ['adapter', 'event_type'],
  buckets: [0.01, 0.1, 0.5, 1, 5, 15, 60, 300, 900, 3600],
  registers: [metricsRegistry]
});

const bridgeTotal = new Counter({
  name: 'opc_ivekit_voice_bridges_total',
  help: 'Total iveKit Voice LiveKit SIP bridge outcomes',
  labelNames: ['adapter', 'result'],
  registers: [metricsRegistry]
});

const preflightTotal = new Counter({
  name: 'opc_ivekit_voice_preflight_total',
  help: 'Total iveKit Voice provider preflight outcomes',
  labelNames: ['adapter', 'result'],
  registers: [metricsRegistry]
});

export const voiceMetricDefinitions = [
  { name: 'opc_ivekit_voice_calls_total', labels: ['adapter', 'direction', 'state'] },
  { name: 'opc_ivekit_voice_commands_total', labels: ['adapter', 'kind', 'result', 'error_code'] },
  { name: 'opc_ivekit_voice_command_duration_seconds', labels: ['adapter', 'kind', 'result'] },
  { name: 'opc_ivekit_voice_uncertain_commands_total', labels: ['adapter', 'kind'] },
  { name: 'opc_ivekit_voice_reconciliations_total', labels: ['adapter', 'result'] },
  { name: 'opc_ivekit_voice_provider_events_total', labels: ['adapter', 'event_type', 'result'] },
  { name: 'opc_ivekit_voice_provider_event_lag_seconds', labels: ['adapter', 'event_type'] },
  { name: 'opc_ivekit_voice_bridges_total', labels: ['adapter', 'result'] },
  { name: 'opc_ivekit_voice_preflight_total', labels: ['adapter', 'result'] }
];

export function observeVoiceCall(input: {
  adapter: VoiceAdapter | string;
  direction: VoiceRouteDirection | string;
  state: VoiceCallState | string;
}): void {
  callTotal.labels(
    adapterLabel(input.adapter),
    enumLabel(input.direction, DIRECTIONS),
    enumLabel(input.state, CALL_STATES)
  ).inc();
}

export function observeVoiceCommand(input: {
  adapter: VoiceAdapter | string;
  kind: VoiceCommandKind | string;
  result: 'succeeded' | 'failed' | 'retry_wait' | 'uncertain' | 'stale' | string;
  error_code?: string;
  duration_seconds: number;
}): void {
  const adapter = adapterLabel(input.adapter);
  const kind = enumLabel(input.kind, COMMAND_KINDS);
  const result = enumLabel(input.result, COMMAND_RESULTS);
  commandTotal.labels(adapter, kind, result, errorLabel(input.error_code)).inc();
  commandDuration.labels(adapter, kind, result).observe(nonNegative(input.duration_seconds));
  if (result === 'uncertain') uncertainTotal.labels(adapter, kind).inc();
}

export function observeVoiceReconciliation(input: {
  adapter: VoiceAdapter | string;
  result: string;
}): void {
  reconciliationTotal.labels(
    adapterLabel(input.adapter),
    enumLabel(input.result, RECONCILIATION_RESULTS)
  ).inc();
}

export function observeVoiceProviderEvent(input: {
  adapter: VoiceAdapter | string;
  event_type: string;
  result: string;
  lag_seconds: number;
}): void {
  const adapter = adapterLabel(input.adapter);
  const eventType = enumLabel(input.event_type, EVENT_TYPES);
  providerEventTotal.labels(
    adapter,
    eventType,
    enumLabel(input.result, EVENT_RESULTS)
  ).inc();
  providerEventLag.labels(adapter, eventType).observe(nonNegative(input.lag_seconds));
}

export function observeVoiceBridge(input: { adapter: VoiceAdapter | string; result: string }): void {
  bridgeTotal.labels(adapterLabel(input.adapter), enumLabel(input.result, BRIDGE_RESULTS)).inc();
}

export function observeVoicePreflight(input: { adapter: VoiceAdapter | string; result: string }): void {
  preflightTotal.labels(adapterLabel(input.adapter), enumLabel(input.result, PREFLIGHT_RESULTS)).inc();
}

const ADAPTERS = new Set(['rustpbx', 'livekit_sip', 'controlled', 'active_call', 'livekit_agents']);
const DIRECTIONS = new Set(['inbound', 'outbound', 'both']);
const CALL_STATES = new Set([
  'planned', 'queued', 'dialing', 'ringing', 'active', 'held', 'transferring',
  'completed', 'cancelled', 'missed', 'rejected', 'failed', 'timed_out'
]);
const COMMAND_KINDS = new Set([
  'originate', 'answer', 'hangup', 'dtmf', 'hold', 'resume', 'blind_transfer',
  'warm_transfer', 'conference', 'park', 'pickup', 'recording_start',
  'recording_pause', 'recording_resume', 'recording_stop', 'livekit_bridge_create',
  'preflight', 'apply', 'test', 'disable', 'delete'
]);
const COMMAND_RESULTS = new Set(['succeeded', 'failed', 'retry_wait', 'uncertain', 'stale']);
const RECONCILIATION_RESULTS = new Set(['succeeded', 'failed', 'pending', 'unknown', 'stale']);
const EVENT_RESULTS = new Set(['processed', 'retry_wait', 'failed', 'stale']);
const BRIDGE_RESULTS = new Set(['active', 'completed', 'failed', 'cancelled', 'pending', 'unknown']);
const PREFLIGHT_RESULTS = new Set(['ready', 'degraded', 'not_available', 'failed']);
const EVENT_TYPES = new Set([
  'call.incoming', 'call.ringing', 'call.answered', 'call.hold', 'call.transfer',
  'call.hangup', 'call.no_answer', 'call.busy', 'call.cdr'
]);
const ERROR_CODES = new Set([
  'none', 'invalid_call_transition', 'terminal_call_state', 'unsupported_provider_call_state',
  'invalid_address', 'address_decryption_failed', 'provider_payload_invalid', 'validation_failed',
  'not_found', 'revision_conflict', 'lease_lost', 'idempotency_conflict',
  'capability_unavailable', 'provider_auth_failed', 'provider_unavailable', 'provider_timeout',
  'provider_response_too_large', 'protocol_mismatch', 'event_sequence_conflict',
  'compliance_denied', 'provider_result_unknown', 'webhook_auth_failed', 'secret_ref_invalid',
  'secret_unavailable', 'provider_command_failed', 'provider_pending'
]);

function adapterLabel(value: string): string {
  return enumLabel(value, ADAPTERS);
}

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
