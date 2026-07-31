import { canonicalSha256 } from './canonical-json.js';
import type { RtcPerformanceContract } from './profile-compiler.js';

export interface RtcPerformanceEvidence {
  schema_version: '1.0.0';
  measurement_scope: string;
  clock_offset_p99_ms: number;
  quantiles_collected: string[];
  latency_ms: Record<string, number>;
  media_quality: Record<string, number>;
  reliability: Record<string, number>;
  recovery_ms: Record<string, number>;
  overload: {
    jain_fairness_index: number;
    noisy_neighbor_p99_degradation_ratio: number;
    unbounded_queue_event_count: number;
    audio_priority_violation_count: number;
    slow_consumer_escape_count: number;
    observed_degradation_order: string[];
  };
  security_performance: {
    authorization_p99_ms: number;
    rate_limit_decision_p99_ms: number;
    overload_rejection_p99_ms: number;
    unauthorized_admission_count: number;
    established_media_remote_authorization_count: number;
  };
  resource_metrics: Record<string, number>;
  impairment_profiles: Array<{
    id: string;
    applied: RtcPerformanceContract['impairment_profiles'][number];
    sample_count: number;
    client_crash_count: number;
    established_media_terminated_count: number;
    unbounded_queue_event_count: number;
    reconnect_success_ratio: number;
    recovery_p99_ms: number;
  }>;
}

export interface RtcPerformanceEvaluation {
  passed: boolean;
  reasons: string[];
}

export function evaluateRtcPerformanceEvidence(
  contract: RtcPerformanceContract,
  evidence: RtcPerformanceEvidence
): RtcPerformanceEvaluation {
  const reasons: string[] = [];
  if (!evidence || evidence.schema_version !== '1.0.0') {
    return { passed: false, reasons: ['RTC performance evidence schema is invalid'] };
  }
  if (evidence.measurement_scope !== contract.measurement_scope) {
    reasons.push('RTC performance measurement scope does not match the contract');
  }
  maximum(
    evidence.clock_offset_p99_ms,
    contract.clock_sync.maximum_offset_ms,
    'clock_offset_p99_ms',
    reasons
  );
  if (!sameArray(evidence.quantiles_collected, contract.required_quantiles)) {
    reasons.push('RTC performance evidence is missing required P50/P95/P99 quantiles');
  }

  maximumRecord(evidence.latency_ms, contract.latency_ms, 'latency_ms', reasons);
  maximumRecord(
    evidence.media_quality,
    contract.media_quality,
    'media_quality',
    reasons,
    new Set(['minimum_voice_mos_p50'])
  );
  minimum(
    evidence.media_quality?.minimum_voice_mos_p50,
    contract.media_quality.minimum_voice_mos_p50,
    'media_quality.minimum_voice_mos_p50',
    reasons
  );

  for (const key of [
    'connection_success_ratio',
    'sip_setup_success_ratio',
    'reconnect_success_ratio'
  ]) {
    minimum(evidence.reliability?.[key], contract.reliability[key], `reliability.${key}`, reasons);
  }
  for (const key of [
    'durable_loss_count',
    'duplicate_delivery_count',
    'out_of_order_delivery_count'
  ]) {
    maximum(evidence.reliability?.[key], contract.reliability[key], `reliability.${key}`, reasons);
  }
  maximumRecord(evidence.recovery_ms, contract.recovery_ms, 'recovery_ms', reasons);

  const overload = evidence.overload;
  minimum(
    overload?.jain_fairness_index,
    contract.overload.minimum_jain_fairness_index,
    'overload.jain_fairness_index',
    reasons
  );
  maximum(
    overload?.noisy_neighbor_p99_degradation_ratio,
    contract.overload.maximum_noisy_neighbor_p99_degradation_ratio,
    'overload.noisy_neighbor_p99_degradation_ratio',
    reasons
  );
  zero(overload?.unbounded_queue_event_count, 'overload.unbounded_queue_event_count', reasons);
  zero(overload?.audio_priority_violation_count, 'overload.audio_priority_violation_count', reasons);
  zero(overload?.slow_consumer_escape_count, 'overload.slow_consumer_escape_count', reasons);
  if (!sameArray(overload?.observed_degradation_order, contract.overload.degradation_order)) {
    reasons.push('overload.observed_degradation_order did not preserve audio first');
  }

  const security = evidence.security_performance;
  for (const key of [
    'authorization_p99_ms',
    'rate_limit_decision_p99_ms',
    'overload_rejection_p99_ms'
  ] as const) {
    maximum(security?.[key], contract.security_performance[key], `security_performance.${key}`, reasons);
  }
  zero(security?.unauthorized_admission_count, 'security_performance.unauthorized_admission_count', reasons);
  zero(
    security?.established_media_remote_authorization_count,
    'security_performance.established_media_remote_authorization_count',
    reasons
  );

  const requiredResourceIds = [...contract.required_resource_metrics].sort();
  const observedResourceIds = Object.keys(evidence.resource_metrics || {}).sort();
  if (!sameArray(observedResourceIds, requiredResourceIds)) {
    reasons.push('resource_metrics do not exactly cover the required resource and cost evidence');
  }
  for (const [key, value] of Object.entries(evidence.resource_metrics || {})) {
    nonNegative(value, `resource_metrics.${key}`, reasons);
  }

  const expectedImpairments = new Map(contract.impairment_profiles.map((item) => [item.id, item]));
  const observedImpairments = uniqueImpairments(evidence.impairment_profiles, reasons);
  for (const [id, expected] of expectedImpairments) {
    const observed = observedImpairments.get(id);
    if (!observed) {
      reasons.push(`impairment_profiles.${id} evidence is missing`);
      continue;
    }
    if (canonicalSha256(observed.applied) !== canonicalSha256(expected)) {
      reasons.push(`impairment_profiles.${id} did not apply the contracted network conditions`);
    }
    if (!Number.isInteger(observed.sample_count) || observed.sample_count < 1) {
      reasons.push(`impairment_profiles.${id}.sample_count must be positive`);
    }
    zero(observed.client_crash_count, `impairment_profiles.${id}.client_crash_count`, reasons);
    zero(
      observed.established_media_terminated_count,
      `impairment_profiles.${id}.established_media_terminated_count`,
      reasons
    );
    zero(
      observed.unbounded_queue_event_count,
      `impairment_profiles.${id}.unbounded_queue_event_count`,
      reasons
    );
    minimum(
      observed.reconnect_success_ratio,
      contract.reliability.reconnect_success_ratio,
      `impairment_profiles.${id}.reconnect_success_ratio`,
      reasons
    );
    maximum(
      observed.recovery_p99_ms,
      recoveryLimit(id, contract),
      `impairment_profiles.${id}.recovery_p99_ms`,
      reasons
    );
  }
  for (const id of observedImpairments.keys()) {
    if (!expectedImpairments.has(id)) reasons.push(`unexpected impairment profile ${id}`);
  }

  return { passed: reasons.length === 0, reasons };
}

function recoveryLimit(id: string, contract: RtcPerformanceContract): number {
  if (id === 'network_handoff') return contract.recovery_ms.network_handoff_p99;
  if (id === 'constrained_bandwidth' || id === 'lossy_jitter') {
    return contract.recovery_ms.bandwidth_step_p99;
  }
  return contract.recovery_ms.reconnect_p99;
}

function uniqueImpairments(
  items: RtcPerformanceEvidence['impairment_profiles'] | undefined,
  reasons: string[]
): Map<string, RtcPerformanceEvidence['impairment_profiles'][number]> {
  const result = new Map<string, RtcPerformanceEvidence['impairment_profiles'][number]>();
  if (!Array.isArray(items)) return result;
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || result.has(item.id)) {
      reasons.push('impairment profile IDs must be present and unique');
      continue;
    }
    result.set(item.id, item);
  }
  return result;
}

function maximumRecord(
  actual: Record<string, number> | undefined,
  target: Record<string, number>,
  prefix: string,
  reasons: string[],
  excluded = new Set<string>()
): void {
  for (const [key, limit] of Object.entries(target)) {
    if (!excluded.has(key)) maximum(actual?.[key], limit, `${prefix}.${key}`, reasons);
  }
  for (const key of Object.keys(actual || {})) {
    if (!(key in target)) reasons.push(`unexpected ${prefix}.${key}`);
  }
}

function maximum(actual: unknown, limit: number, field: string, reasons: string[]): void {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0 || actual > limit) {
    reasons.push(`${field} exceeds ${limit}`);
  }
}

function minimum(actual: unknown, limit: number, field: string, reasons: string[]): void {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < limit) {
    reasons.push(`${field} is below ${limit}`);
  }
}

function zero(actual: unknown, field: string, reasons: string[]): void {
  if (actual !== 0) reasons.push(`${field} must be zero`);
}

function nonNegative(actual: unknown, field: string, reasons: string[]): void {
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0) {
    reasons.push(`${field} must be a finite non-negative number`);
  }
}

function sameArray(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}
