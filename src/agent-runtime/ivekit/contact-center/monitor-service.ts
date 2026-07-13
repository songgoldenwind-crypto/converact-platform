import { ContactCenterError } from './errors.js';
import type { ContactCenterQueueStatus, ContactCenterRoutingStrategy } from './types.js';

export interface ContactCenterMonitorAgents {
  configured: number;
  active: number;
  offline: number;
  available: number;
  busy: number;
  after_call: number;
  away: number;
  active_voice_count: number;
  voice_capacity: number;
}

export interface ContactCenterMonitorCalls {
  active_inbound: number;
  active_outbound: number;
}

export interface ContactCenterMonitorOperations {
  callbacks_pending: number;
  callbacks_failed_today: number;
  overflows_pending: number;
  overflows_failed_today: number;
  supervisor_requested: number;
  supervisor_active: number;
}

export interface ContactCenterMonitorQueueProjection {
  queue_id: string;
  queue_name: string;
  status: ContactCenterQueueStatus;
  routing_strategy: ContactCenterRoutingStrategy;
  max_wait_seconds: number;
  service_level_seconds: number;
  waiting_count: number;
  offered_count: number;
  assigned_count: number;
  answered_count: number;
  available_agents: number;
  available_capacity: number;
  oldest_wait_seconds: number;
  average_handle_seconds: number;
  answered_today: number;
  answered_in_service_level_today: number;
  abandoned_today: number;
  timed_out_today: number;
  overflowed_today: number;
  average_wait_seconds_today: number;
  callbacks_pending: number;
  callbacks_failed_today: number;
  overflows_pending: number;
  overflows_failed_today: number;
}

export interface ContactCenterMonitorProjection {
  agents: ContactCenterMonitorAgents;
  calls: ContactCenterMonitorCalls;
  operations: ContactCenterMonitorOperations;
  queues: ContactCenterMonitorQueueProjection[];
}

export interface ContactCenterMonitorQueue extends ContactCenterMonitorQueueProjection {
  estimated_wait_seconds: number | null;
  service_level_percent_today: number;
}

export interface ContactCenterMonitorAlert {
  code: 'queue_without_capacity' | 'service_level_wait' |
    'callback_failures' | 'overflow_failures';
  severity: 'warning' | 'critical';
  queue_id: string;
  value: number;
}

export interface ContactCenterMonitorSnapshot {
  generated_at: string;
  agents: ContactCenterMonitorAgents;
  calls: ContactCenterMonitorCalls;
  operations: ContactCenterMonitorOperations;
  queues: ContactCenterMonitorQueue[];
  alerts: ContactCenterMonitorAlert[];
}

export interface ContactCenterMonitorSource {
  load(tenantId: string, window: {
    now: string;
    day_start: string;
    day_end: string;
  }): Promise<ContactCenterMonitorProjection>;
}

export class ContactCenterMonitorService {
  readonly #source: ContactCenterMonitorSource;
  readonly #now: () => Date;

  constructor(source: ContactCenterMonitorSource, options: { now?: () => Date } = {}) {
    this.#source = source;
    this.#now = options.now ?? (() => new Date());
  }

  async snapshot(input: { tenant_id: string }): Promise<ContactCenterMonitorSnapshot> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const now = this.#now();
    if (Number.isNaN(now.getTime())) throw validation('now');
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const projection = await this.#source.load(tenantId, {
      now: now.toISOString(),
      day_start: dayStart.toISOString(),
      day_end: dayEnd.toISOString()
    });
    const queues = projection.queues.map(projectQueue);
    return {
      generated_at: now.toISOString(),
      agents: projection.agents,
      calls: projection.calls,
      operations: projection.operations,
      queues,
      alerts: queues.flatMap(queueAlerts)
    };
  }
}

function projectQueue(queue: ContactCenterMonitorQueueProjection): ContactCenterMonitorQueue {
  const denominator = queue.answered_today + queue.abandoned_today +
    queue.timed_out_today + queue.overflowed_today;
  const serviceLevel = denominator === 0
    ? 100
    : roundPercent((queue.answered_in_service_level_today / denominator) * 100);
  const estimatedWait = queue.waiting_count === 0
    ? 0
    : queue.available_capacity === 0
      ? null
      : Math.min(86_400, Math.max(1, Math.ceil(
        (queue.waiting_count * positive(queue.average_handle_seconds, 60)) /
        queue.available_capacity
      )));
  return {
    ...queue,
    estimated_wait_seconds: estimatedWait,
    service_level_percent_today: serviceLevel
  };
}

function queueAlerts(queue: ContactCenterMonitorQueue): ContactCenterMonitorAlert[] {
  const alerts: ContactCenterMonitorAlert[] = [];
  if (queue.waiting_count > 0 && queue.available_capacity === 0) {
    alerts.push({
      code: 'queue_without_capacity', severity: 'critical',
      queue_id: queue.queue_id, value: queue.waiting_count
    });
  }
  if (queue.oldest_wait_seconds > queue.service_level_seconds) {
    alerts.push({
      code: 'service_level_wait', severity: 'warning',
      queue_id: queue.queue_id, value: queue.oldest_wait_seconds
    });
  }
  if (queue.callbacks_failed_today > 0) {
    alerts.push({
      code: 'callback_failures', severity: 'warning',
      queue_id: queue.queue_id, value: queue.callbacks_failed_today
    });
  }
  if (queue.overflows_failed_today > 0) {
    alerts.push({
      code: 'overflow_failures', severity: 'critical',
      queue_id: queue.queue_id, value: queue.overflows_failed_today
    });
  }
  return alerts;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function identifier(value: unknown, field: string): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) throw validation(field);
  return output;
}

function validation(field: string): ContactCenterError {
  return new ContactCenterError({
    code: 'validation_failed', status: 422, details: { field }
  });
}
