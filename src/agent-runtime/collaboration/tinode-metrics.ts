import { Counter, Gauge } from 'prom-client';

import { metricsRegistry } from '../../metrics.js';
import type { TinodeFileDeliveryTransition } from './tinode-file-delivery-gate.js';
import type { TinodeOperationsSnapshot } from './tinode-operations.js';

const deliveryQueue = new Gauge({
  name: 'opc_ivekit_tinode_delivery_queue_messages',
  help: 'Current Tinode delivery messages by bounded state from the latest operations snapshot',
  labelNames: ['status'],
  registers: [metricsRegistry]
});

const deliveryQueueLag = new Gauge({
  name: 'opc_ivekit_tinode_delivery_queue_lag_seconds',
  help: 'Age of the oldest due Tinode delivery from the latest operations snapshot',
  registers: [metricsRegistry]
});

const inboundCursorLag = new Gauge({
  name: 'opc_ivekit_tinode_inbound_cursor_lag_sequences',
  help: 'Maximum persisted Tinode inbound sequence lag from the latest operations snapshot',
  registers: [metricsRegistry]
});

const deadLetters = new Gauge({
  name: 'opc_ivekit_tinode_inbound_dead_letters',
  help: 'Current open Tinode inbound dead letters by bounded retry state',
  labelNames: ['state'],
  registers: [metricsRegistry]
});

const fileBlockedMessages = new Gauge({
  name: 'opc_ivekit_tinode_file_blocked_messages',
  help: 'Current Tinode messages blocked by file security from the latest operations snapshot',
  labelNames: ['state'],
  registers: [metricsRegistry]
});

const fileGateTransitions = new Counter({
  name: 'opc_ivekit_tinode_file_gate_transitions_total',
  help: 'Total Tinode file security gate transitions',
  labelNames: ['status', 'reason'],
  registers: [metricsRegistry]
});

export const tinodeMetricDefinitions = [
  { name: 'opc_ivekit_tinode_delivery_queue_messages' },
  { name: 'opc_ivekit_tinode_delivery_queue_lag_seconds' },
  { name: 'opc_ivekit_tinode_inbound_cursor_lag_sequences' },
  { name: 'opc_ivekit_tinode_inbound_dead_letters' },
  { name: 'opc_ivekit_tinode_file_blocked_messages' },
  { name: 'opc_ivekit_tinode_file_gate_transitions_total' }
];

export function observeTinodeOperations(snapshot: TinodeOperationsSnapshot): void {
  for (const status of ['pending', 'publishing', 'retry_wait', 'failed'] as const) {
    deliveryQueue.labels(status).set(snapshot.delivery[status]);
  }
  deliveryQueueLag.set(snapshot.delivery.queue_lag_ms / 1_000);
  inboundCursorLag.set(snapshot.inbound.max_cursor_lag_sequences);
  deadLetters.labels('retryable').set(snapshot.dead_letters.retryable);
  deadLetters.labels('terminal').set(snapshot.dead_letters.terminal);
  fileBlockedMessages.labels('waiting').set(snapshot.delivery.blocked_by_file_security);
  fileBlockedMessages.labels('terminal').set(snapshot.delivery.blocked);
}

export function observeTinodeFileGateTransition(
  transition: TinodeFileDeliveryTransition
): void {
  fileGateTransitions.labels(transition.status, transition.reason).inc();
}
