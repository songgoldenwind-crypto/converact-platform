import type { RtcPerformanceEvidence } from '../../scripts/capacity/performance-evaluator.js';
import type { RtcPerformanceContract } from '../../scripts/capacity/profile-compiler.js';

export function createPassingRtcPerformanceEvidence(
  contract: RtcPerformanceContract
): RtcPerformanceEvidence {
  return {
    schema_version: '1.0.0',
    measurement_scope: contract.measurement_scope,
    clock_offset_p99_ms: contract.clock_sync.maximum_offset_ms,
    quantiles_collected: [...contract.required_quantiles],
    latency_ms: { ...contract.latency_ms },
    media_quality: { ...contract.media_quality },
    reliability: { ...contract.reliability },
    recovery_ms: { ...contract.recovery_ms },
    overload: {
      jain_fairness_index: contract.overload.minimum_jain_fairness_index,
      noisy_neighbor_p99_degradation_ratio:
        contract.overload.maximum_noisy_neighbor_p99_degradation_ratio,
      unbounded_queue_event_count: 0,
      audio_priority_violation_count: 0,
      slow_consumer_escape_count: 0,
      observed_degradation_order: [...contract.overload.degradation_order]
    },
    security_performance: {
      authorization_p99_ms: contract.security_performance.authorization_p99_ms,
      rate_limit_decision_p99_ms:
        contract.security_performance.rate_limit_decision_p99_ms,
      overload_rejection_p99_ms:
        contract.security_performance.overload_rejection_p99_ms,
      unauthorized_admission_count: 0,
      established_media_remote_authorization_count: 0
    },
    resource_metrics: Object.fromEntries(
      contract.required_resource_metrics.map((id) => [id, 1])
    ),
    impairment_profiles: contract.impairment_profiles.map((profile) => ({
      id: profile.id,
      applied: structuredClone(profile),
      sample_count: 1,
      client_crash_count: 0,
      established_media_terminated_count: 0,
      unbounded_queue_event_count: 0,
      reconnect_success_ratio: contract.reliability.reconnect_success_ratio,
      recovery_p99_ms: recoveryLimit(profile.id, contract)
    }))
  };
}

function recoveryLimit(id: string, contract: RtcPerformanceContract): number {
  if (id === 'network_handoff') return contract.recovery_ms.network_handoff_p99;
  if (id === 'constrained_bandwidth' || id === 'lossy_jitter') {
    return contract.recovery_ms.bandwidth_step_p99;
  }
  return contract.recovery_ms.reconnect_p99;
}
