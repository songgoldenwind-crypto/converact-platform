import { Counter, Histogram } from 'prom-client';

import { metricsRegistry } from '../../metrics.js';
import type {
  IveKitMediaConnectionEventResult,
  IveKitMediaQualityReportResult,
  IveKitMediaQualitySnapshotInput,
  IveKitMediaQualityTransition
} from './types.js';

const qosSamples = new Counter({
  name: 'opc_ivekit_media_qos_samples_total',
  help: 'Accepted and idempotently replayed iveKit media QoS samples',
  labelNames: ['result'],
  registers: [metricsRegistry]
});

const qosRtt = new Histogram({
  name: 'opc_ivekit_media_qos_rtt_seconds',
  help: 'Bounded media QoS round-trip time observations',
  labelNames: ['track_source'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [metricsRegistry]
});

const qosPacketLoss = new Histogram({
  name: 'opc_ivekit_media_qos_packet_loss_ratio',
  help: 'Bounded media QoS packet loss ratio observations',
  labelNames: ['track_source'],
  buckets: [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [metricsRegistry]
});

const qosTransitions = new Counter({
  name: 'opc_ivekit_media_qos_transitions_total',
  help: 'Debounced media quality state transitions',
  labelNames: ['event_type'],
  registers: [metricsRegistry]
});

const connectionEvents = new Counter({
  name: 'opc_ivekit_media_connection_events_total',
  help: 'Accepted and idempotently replayed bounded media connection events',
  labelNames: ['event_type', 'result'],
  registers: [metricsRegistry]
});

export const mediaQualityMetricDefinitions = [
  { name: 'opc_ivekit_media_qos_samples_total' },
  { name: 'opc_ivekit_media_qos_rtt_seconds' },
  { name: 'opc_ivekit_media_qos_packet_loss_ratio' },
  { name: 'opc_ivekit_media_qos_transitions_total' },
  { name: 'opc_ivekit_media_connection_events_total' }
];

export function observeMediaQualityReport(
  snapshots: IveKitMediaQualitySnapshotInput[],
  result: IveKitMediaQualityReportResult
): void {
  qosSamples.labels('accepted').inc(result.accepted);
  qosSamples.labels('replayed').inc(result.replayed);
  if (result.accepted === 0) return;
  for (const snapshot of snapshots) {
    if (snapshot.rtt_ms != null) qosRtt.labels(snapshot.track_source).observe(snapshot.rtt_ms / 1_000);
    if (snapshot.packet_loss_ratio != null) {
      qosPacketLoss.labels(snapshot.track_source).observe(snapshot.packet_loss_ratio);
    }
  }
}

export function observeMediaQualityTransition(transition: IveKitMediaQualityTransition): void {
  qosTransitions.labels(transition.event_type).inc();
}

export function observeMediaConnectionEvent(result: IveKitMediaConnectionEventResult): void {
  connectionEvents.labels(result.event.event_type, result.replayed ? 'replayed' : 'accepted').inc();
}
