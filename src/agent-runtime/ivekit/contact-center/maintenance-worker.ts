import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { createPostgresContactCenterCallbackService } from './callback-runtime.js';
import { PostgresContactCenterUnitOfWork } from './postgres/unit-of-work.js';
import {
  ContactCenterQueueService,
  type ContactCenterOfferResult
} from './queue-service.js';
import type { ContactCenterQueueEntry } from './types.js';

export interface ContactCenterMaintenanceWorkerConfig {
  enabled: boolean;
  interval_ms: number;
  tenant_limit: number;
  batch_size: number;
  offer_ttl_seconds: number;
  callback_retry_delay_ms: number;
}

export interface ContactCenterMaintenanceSummary {
  tenants: number;
  failed_tenants: number;
  expired_offers: number;
  timed_out_entries: number;
  queues_scanned: number;
  offers_created: number;
  callbacks_processed: number;
  callbacks_started: number;
  callbacks_retried: number;
  callbacks_failed: number;
  callbacks_reconciled: number;
}

export interface ContactCenterMaintenanceService {
  expireOffers(input: { tenant_id: string; limit: number }): Promise<number>;
  timeoutWaitingEntries(input: {
    tenant_id: string;
    limit: number;
  }): Promise<ContactCenterQueueEntry[]>;
  listRoutableQueueIds(input: { tenant_id: string; limit: number }): Promise<string[]>;
  offerNext(input: {
    tenant_id: string;
    queue_id: string;
    idempotency_key: string;
    offer_ttl_seconds: number;
  }): Promise<ContactCenterOfferResult | null>;
}

export interface ContactCenterCallbackMaintenanceService {
  processDue(input: {
    tenant_id: string;
    limit: number;
    retry_delay_ms: number;
  }): Promise<{ processed: number; started: number; retried: number; failed: number }>;
  reconcile(input: {
    tenant_id: string;
    limit: number;
  }): Promise<{ scanned: number; updated: number }>;
}

export class ContactCenterMaintenanceWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<ContactCenterMaintenanceSummary> | null = null;
  private stopped = true;

  constructor(private readonly input: {
    config: ContactCenterMaintenanceWorkerConfig;
    run_batch: () => Promise<ContactCenterMaintenanceSummary>;
    on_error?: (error: unknown) => void;
  }) {}

  start(): void {
    if (!this.input.config.enabled || !this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  runOnce(): Promise<ContactCenterMaintenanceSummary> {
    if (this.active) return this.active;
    const running = Promise.resolve().then(() => this.input.run_batch());
    const wrapped = running.finally(() => {
      if (this.active === wrapped) this.active = null;
    });
    this.active = wrapped;
    return wrapped;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active.catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.stopped || !this.input.config.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce()
        .catch((error) => this.input.on_error?.(error))
        .finally(() => this.schedule(this.input.config.interval_ms));
    }, delayMs);
    this.timer.unref?.();
  }
}

export async function runContactCenterMaintenanceBatch(input: {
  pg: PgQueryable;
  now?: Date;
  tenant_limit: number;
  batch_size: number;
  offer_ttl_seconds: number;
  callback_retry_delay_ms: number;
  list_tenants?: (now: Date, limit: number) => Promise<string[]>;
  create_service?: (tenantId: string) => ContactCenterMaintenanceService;
  create_callback_service?: (tenantId: string) => ContactCenterCallbackMaintenanceService;
  idempotency_key?: (tenantId: string, queueId: string) => string;
  on_tenant_error?: (tenantId: string, error: unknown) => void;
}): Promise<ContactCenterMaintenanceSummary> {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Contact Center worker now must be a valid date');
  const tenants = await (input.list_tenants
    ? input.list_tenants(now, input.tenant_limit)
    : listContactCenterWorkerTenants(input.pg, now, input.tenant_limit));
  const summary: ContactCenterMaintenanceSummary = {
    tenants: tenants.length,
    failed_tenants: 0,
    expired_offers: 0,
    timed_out_entries: 0,
    queues_scanned: 0,
    offers_created: 0,
    callbacks_processed: 0,
    callbacks_started: 0,
    callbacks_retried: 0,
    callbacks_failed: 0,
    callbacks_reconciled: 0
  };
  for (const tenantId of tenants) {
    try {
      const service = input.create_service?.(tenantId) ?? new ContactCenterQueueService(
        new PostgresContactCenterUnitOfWork(input.pg), { now: () => now }
      );
      summary.expired_offers += await service.expireOffers({
        tenant_id: tenantId,
        limit: input.batch_size
      });
      summary.timed_out_entries += (await service.timeoutWaitingEntries({
        tenant_id: tenantId,
        limit: input.batch_size
      })).length;
      const callbacks = input.create_callback_service?.(tenantId) ??
        createPostgresContactCenterCallbackService(input.pg, { now: () => now });
      const processedCallbacks = await callbacks.processDue({
        tenant_id: tenantId,
        limit: input.batch_size,
        retry_delay_ms: input.callback_retry_delay_ms
      });
      summary.callbacks_processed += processedCallbacks.processed;
      summary.callbacks_started += processedCallbacks.started;
      summary.callbacks_retried += processedCallbacks.retried;
      summary.callbacks_failed += processedCallbacks.failed;
      summary.callbacks_reconciled += (await callbacks.reconcile({
        tenant_id: tenantId,
        limit: input.batch_size
      })).updated;
      const queueIds = await service.listRoutableQueueIds({
        tenant_id: tenantId,
        limit: input.batch_size
      });
      summary.queues_scanned += queueIds.length;
      for (const queueId of queueIds) {
        const offer = await service.offerNext({
          tenant_id: tenantId,
          queue_id: queueId,
          idempotency_key: input.idempotency_key?.(tenantId, queueId) ??
            `cc-worker:${tenantId}:${queueId}:${randomUUID()}`,
          offer_ttl_seconds: input.offer_ttl_seconds
        });
        if (offer) summary.offers_created += 1;
      }
    } catch (error) {
      summary.failed_tenants += 1;
      input.on_tenant_error?.(tenantId, error);
    }
  }
  return summary;
}

export async function listContactCenterWorkerTenants(
  pg: PgQueryable,
  now: Date,
  limit: number
): Promise<string[]> {
  const result = await pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_ivekit_cc_worker_tenant_ids($1, $2)',
    [now.toISOString(), bounded(limit, 100, 1, 1_000, 'tenant_limit')]
  );
  return [...new Set(result.rows.map((row) => String(row.tenant_id || '')).filter(Boolean))];
}

export function contactCenterMaintenanceWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): ContactCenterMaintenanceWorkerConfig {
  const enabledValue = String(env.OPC_IVEKIT_CONTACT_CENTER_WORKER_ENABLED || '0').trim();
  if (enabledValue !== '0' && enabledValue !== '1') {
    throw new Error('OPC_IVEKIT_CONTACT_CENTER_WORKER_ENABLED must be 0 or 1');
  }
  return {
    enabled: enabledValue === '1',
    interval_ms: bounded(env.OPC_IVEKIT_CONTACT_CENTER_INTERVAL_MS, 1_000, 250, 60_000,
      'OPC_IVEKIT_CONTACT_CENTER_INTERVAL_MS'),
    tenant_limit: bounded(env.OPC_IVEKIT_CONTACT_CENTER_TENANT_LIMIT, 100, 1, 1_000,
      'OPC_IVEKIT_CONTACT_CENTER_TENANT_LIMIT'),
    batch_size: bounded(env.OPC_IVEKIT_CONTACT_CENTER_BATCH_SIZE, 100, 1, 1_000,
      'OPC_IVEKIT_CONTACT_CENTER_BATCH_SIZE'),
    offer_ttl_seconds: bounded(env.OPC_IVEKIT_CONTACT_CENTER_OFFER_TTL_SECONDS, 20, 1, 300,
      'OPC_IVEKIT_CONTACT_CENTER_OFFER_TTL_SECONDS'),
    callback_retry_delay_ms: bounded(
      env.OPC_IVEKIT_CONTACT_CENTER_CALLBACK_RETRY_DELAY_MS,
      30_000,
      1_000,
      3_600_000,
      'OPC_IVEKIT_CONTACT_CENTER_CALLBACK_RETRY_DELAY_MS'
    )
  };
}

export function startContactCenterMaintenanceWorker(input: {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
}): ContactCenterMaintenanceWorker {
  const config = contactCenterMaintenanceWorkerConfig(input.env || process.env);
  const worker = new ContactCenterMaintenanceWorker({
    config,
    run_batch: () => runContactCenterMaintenanceBatch({
      pg: input.pg,
      tenant_limit: config.tenant_limit,
      batch_size: config.batch_size,
      offer_ttl_seconds: config.offer_ttl_seconds,
      callback_retry_delay_ms: config.callback_retry_delay_ms,
      on_tenant_error: (tenantId, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ivekit-contact-center] tenant ${tenantId} failed:`, message.slice(0, 500));
      }
    }),
    on_error: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[ivekit-contact-center] worker failed:', message.slice(0, 500));
    }
  });
  worker.start();
  return worker;
}

function bounded(
  value: string | number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
