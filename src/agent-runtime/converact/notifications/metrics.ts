import { Counter, Gauge, Histogram } from 'prom-client';

import { metricsRegistry } from '../../../metrics.js';
import type {
  NotificationChannel,
  NotificationDeliveryState,
  NotificationEndpointReservationReason,
  NotificationReceiptReconciliation
} from './types.js';

const createdTotal = new Counter({
  name: 'opc_ivekit_notifications_created_total',
  help: 'Total Converact Fabric logical notifications created by channel',
  labelNames: ['channel'], registers: [metricsRegistry]
});
const deliveryAttempts = new Counter({
  name: 'opc_ivekit_notification_delivery_attempts_total',
  help: 'Total Converact Fabric notification delivery attempt outcomes',
  labelNames: ['channel', 'provider', 'result', 'error_code'], registers: [metricsRegistry]
});
const providerReservations = new Counter({
  name: 'opc_ivekit_notification_provider_reservations_total',
  help: 'Total Converact Fabric notification provider quota and circuit reservations',
  labelNames: ['channel', 'result', 'reason'], registers: [metricsRegistry]
});
const providerResults = new Counter({
  name: 'opc_ivekit_notification_provider_results_total',
  help: 'Total Converact Fabric notification provider health observations',
  labelNames: ['channel', 'provider', 'outcome'], registers: [metricsRegistry]
});
const receiptReconciliations = new Counter({
  name: 'opc_ivekit_notification_receipt_reconciliations_total',
  help: 'Total Converact Fabric notification receipt reconciliation outcomes',
  labelNames: ['result'], registers: [metricsRegistry]
});
const queueDepth = new Gauge({
  name: 'opc_ivekit_notification_queue_depth',
  help: 'Current Converact Fabric notification delivery queue depth',
  labelNames: ['state'], registers: [metricsRegistry]
});
const queueOldestAge = new Gauge({
  name: 'opc_ivekit_notification_queue_oldest_age_seconds',
  help: 'Age of the oldest Converact Fabric notification delivery by state',
  labelNames: ['state'], registers: [metricsRegistry]
});
const leaseLost = new Counter({
  name: 'opc_ivekit_notification_lease_lost_total',
  help: 'Total Converact Fabric notification worker lease fencing losses',
  labelNames: ['channel'], registers: [metricsRegistry]
});
const healthProbes = new Counter({
  name: 'opc_ivekit_notification_health_probes_total',
  help: 'Total active notification endpoint health probes',
  labelNames: ['channel', 'provider', 'outcome', 'code'], registers: [metricsRegistry]
});
const healthProbeLatency = new Histogram({
  name: 'opc_ivekit_notification_health_probe_duration_seconds',
  help: 'Notification endpoint health probe duration',
  labelNames: ['channel', 'provider', 'outcome'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry]
});

export const notificationMetricDefinitions = [
  { name: 'opc_ivekit_notifications_created_total', labels: ['channel'] },
  {
    name: 'opc_ivekit_notification_delivery_attempts_total',
    labels: ['channel', 'provider', 'result', 'error_code']
  },
  {
    name: 'opc_ivekit_notification_provider_reservations_total',
    labels: ['channel', 'result', 'reason']
  },
  {
    name: 'opc_ivekit_notification_provider_results_total',
    labels: ['channel', 'provider', 'outcome']
  },
  { name: 'opc_ivekit_notification_receipt_reconciliations_total', labels: ['result'] },
  { name: 'opc_ivekit_notification_queue_depth', labels: ['state'] },
  { name: 'opc_ivekit_notification_queue_oldest_age_seconds', labels: ['state'] },
  { name: 'opc_ivekit_notification_lease_lost_total', labels: ['channel'] },
  {
    name: 'opc_ivekit_notification_health_probes_total',
    labels: ['channel', 'provider', 'outcome', 'code']
  },
  {
    name: 'opc_ivekit_notification_health_probe_duration_seconds',
    labels: ['channel', 'provider', 'outcome']
  }
];

export function observeNotificationCreated(channels: readonly NotificationChannel[]): void {
  for (const channel of new Set(channels)) createdTotal.labels(channelLabel(channel)).inc();
}

export function observeNotificationDelivery(input: {
  channel: string;
  provider?: string;
  result: NotificationDeliveryState;
  error_code?: string;
}): void {
  deliveryAttempts.labels(
    channelLabel(input.channel), providerLabel(input.provider), stateLabel(input.result),
    errorLabel(input.error_code)
  ).inc();
}

export function observeNotificationProviderReservation(input: {
  channel: string;
  allowed: boolean;
  reason: NotificationEndpointReservationReason | null;
}): void {
  providerReservations.labels(
    channelLabel(input.channel), input.allowed ? 'allowed' : 'blocked', input.reason || 'none'
  ).inc();
}

export function observeNotificationProviderResult(input: {
  channel: string;
  provider: string;
  outcome: 'success' | 'failure';
}): void {
  providerResults.labels(
    channelLabel(input.channel), providerLabel(input.provider), input.outcome
  ).inc();
}

export function observeNotificationReceiptReconciliation(
  result: NotificationReceiptReconciliation
): void {
  receiptReconciliations.labels(result).inc();
}

export function setNotificationQueueMetric(input: {
  state: string;
  depth: number;
  oldest_age_seconds: number;
}): void {
  const state = stateLabel(input.state);
  queueDepth.labels(state).set(nonNegative(input.depth));
  queueOldestAge.labels(state).set(nonNegative(input.oldest_age_seconds));
}

export function observeNotificationLeaseLost(channel: string): void {
  leaseLost.labels(channelLabel(channel)).inc();
}

export function observeNotificationHealthProbe(input: {
  channel: string;
  provider: string;
  outcome: 'healthy' | 'degraded' | 'unhealthy';
  code: string;
  latency_ms: number;
}): void {
  const labels = [
    channelLabel(input.channel), providerLabel(input.provider), input.outcome,
    errorLabel(input.code)
  ] as const;
  healthProbes.labels(...labels).inc();
  healthProbeLatency.labels(labels[0], labels[1], labels[2])
    .observe(nonNegative(input.latency_ms) / 1000);
}

const CHANNELS = new Set(['in_app', 'webhook', 'email', 'sms']);
const DELIVERY_STATES = new Set([
  'pending', 'processing', 'accepted', 'retry_wait', 'uncertain',
  'delivered', 'failed', 'cancelled', 'dead_letter'
]);

function channelLabel(value: string): string {
  return CHANNELS.has(value) ? value : 'unknown';
}

function stateLabel(value: string): string {
  return DELIVERY_STATES.has(value) ? value : 'unknown';
}

function providerLabel(value: string | undefined): string {
  const normalized = String(value || 'unresolved').toLowerCase();
  return /^[a-z0-9_-]{1,50}$/.test(normalized) ? normalized : 'unknown';
}

function errorLabel(value: string | undefined): string {
  const normalized = String(value || 'none').toLowerCase();
  return /^[a-z0-9_-]{1,100}$/.test(normalized) ? normalized : 'other';
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
