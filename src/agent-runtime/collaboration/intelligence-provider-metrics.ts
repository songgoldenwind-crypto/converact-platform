import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from '../../metrics.js';
import type { IntelligenceProviderCapability } from './intelligence-provider-registry.js';

const reservationTotal = new Counter({
  name: 'opc_ivekit_intelligence_provider_reservations_total',
  help: 'Total iveKit intelligence provider reservation outcomes',
  labelNames: ['capability', 'profile_id', 'result'],
  registers: [metricsRegistry]
});

const requestTotal = new Counter({
  name: 'opc_ivekit_intelligence_provider_requests_total',
  help: 'Total iveKit intelligence provider request outcomes',
  labelNames: ['capability', 'profile_id', 'result', 'error_code'],
  registers: [metricsRegistry]
});

const requestDuration = new Histogram({
  name: 'opc_ivekit_intelligence_provider_request_duration_seconds',
  help: 'iveKit intelligence provider request duration',
  labelNames: ['capability', 'profile_id', 'result'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120, 300],
  registers: [metricsRegistry]
});

const failoverTotal = new Counter({
  name: 'opc_ivekit_intelligence_provider_failovers_total',
  help: 'Total iveKit intelligence provider failovers',
  labelNames: ['capability', 'from_profile', 'to_profile'],
  registers: [metricsRegistry]
});

const routeExhaustedTotal = new Counter({
  name: 'opc_ivekit_intelligence_provider_routes_exhausted_total',
  help: 'Total exhausted iveKit intelligence provider routes',
  labelNames: ['capability'],
  registers: [metricsRegistry]
});

const circuitTransitionTotal = new Counter({
  name: 'opc_ivekit_intelligence_provider_circuit_transitions_total',
  help: 'Total iveKit intelligence provider circuit state transitions',
  labelNames: ['capability', 'profile_id', 'from_state', 'to_state'],
  registers: [metricsRegistry]
});

export const intelligenceProviderMetricDefinitions = [
  { name: 'opc_ivekit_intelligence_provider_reservations_total' },
  { name: 'opc_ivekit_intelligence_provider_requests_total' },
  { name: 'opc_ivekit_intelligence_provider_request_duration_seconds' },
  { name: 'opc_ivekit_intelligence_provider_failovers_total' },
  { name: 'opc_ivekit_intelligence_provider_routes_exhausted_total' },
  { name: 'opc_ivekit_intelligence_provider_circuit_transitions_total' }
];

export function observeIntelligenceProviderReservation(input: {
  capability: IntelligenceProviderCapability;
  profile_id: string;
  result: string;
}): void {
  reservationTotal.labels(input.capability, profileLabel(input.profile_id), reservationResult(input.result)).inc();
}

export function observeIntelligenceProviderRequest(input: {
  capability: IntelligenceProviderCapability;
  profile_id: string;
  result: 'succeeded' | 'retryable_failure' | 'terminal_failure';
  error_code?: string;
  duration_seconds: number;
}): void {
  const profile = profileLabel(input.profile_id);
  requestTotal.labels(
    input.capability,
    profile,
    input.result,
    errorLabel(input.error_code)
  ).inc();
  requestDuration.labels(input.capability, profile, input.result)
    .observe(nonNegative(input.duration_seconds));
}

export function observeIntelligenceProviderFailover(input: {
  capability: IntelligenceProviderCapability;
  from_profile: string;
  to_profile: string;
}): void {
  failoverTotal.labels(
    input.capability,
    profileLabel(input.from_profile),
    profileLabel(input.to_profile)
  ).inc();
}

export function observeIntelligenceProviderRouteExhausted(
  capability: IntelligenceProviderCapability
): void {
  routeExhaustedTotal.labels(capability).inc();
}

export function observeIntelligenceProviderCircuitTransition(input: {
  capability: IntelligenceProviderCapability;
  profile_id: string;
  from_state: 'closed' | 'open' | 'half_open';
  to_state: 'closed' | 'open' | 'half_open';
}): void {
  circuitTransitionTotal.labels(
    input.capability,
    profileLabel(input.profile_id),
    input.from_state,
    input.to_state
  ).inc();
}

const RESERVATION_RESULTS = new Set([
  'granted', 'minute_quota_exhausted', 'day_quota_exhausted', 'concurrency_exhausted',
  'circuit_open', 'circuit_half_open_busy', 'provider_credential_unavailable',
  'third_party_not_allowed', 'provider_unavailable'
]);
const ERROR_CODES = new Set([
  'none', 'provider_timeout', 'provider_unavailable', 'provider_route_unavailable',
  'provider_invalid_response', 'provider_response_too_large', 'provider_source_ref_invalid',
  'translation_source_empty', 'translation_source_too_large', 'source_language_invalid',
  'target_language_invalid'
]);

function reservationResult(value: string): string {
  return RESERVATION_RESULTS.has(value) ? value : 'other';
}

function errorLabel(value: string | undefined): string {
  const code = value || 'none';
  return ERROR_CODES.has(code) || /^provider_http_[1-5][0-9]{2}$/.test(code) ? code : 'other';
}

function profileLabel(value: string): string {
  return /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : 'other';
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
