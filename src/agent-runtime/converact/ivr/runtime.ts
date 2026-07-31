import { resolveFabricEnv } from '../../../config/converact-env.js';
import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { IvrError } from './errors.js';
import {
  emitIvrSessionEvents,
  projectIvrSessionEvents,
  type IvrSessionEventPublisher
} from './events.js';
import type { IvrPendingActionExecutor, IvrPendingActionReconciler } from './ports.js';
import { PostgresIvrPendingActionStore } from './postgres/session-store.js';
import { PostgresIvrSessionUnitOfWork } from './postgres/unit-of-work.js';
import { IvrSessionActionCompletion } from './session-action-completion.js';
import { IvrSessionService } from './session-service.js';
import { IvrPendingActionWorker } from './workers/pending-action-worker.js';
import { IvrPendingActionReconciliationWorker } from './workers/reconciliation-worker.js';

export interface IveKitIvrWorkerConfig {
  enabled: boolean;
  action_interval_ms: number;
  action_batch_size: number;
  action_lease_ms: number;
  action_retry_base_ms: number;
  action_retry_max_ms: number;
  reconciliation_interval_ms: number;
  reconciliation_lease_ms: number;
  reconciliation_retry_ms: number;
  reconciliation_max_attempts: number;
  tenant_limit: number;
}

export interface IveKitIvrRuntimeInput {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  executor?: IvrPendingActionExecutor;
  reconciler?: IvrPendingActionReconciler;
  publish?: IvrSessionEventPublisher;
}

export interface IveKitIvrWorkerHandle {
  stop(): Promise<void>;
}

export function iveKitIvrWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): IveKitIvrWorkerConfig {
  const retryBaseMs = boundedInteger(
    resolveFabricEnv(env, 'IVR_ACTION_RETRY_BASE_MS'), 1_000, 100, 300_000,
    'CONVERACT_FABRIC_IVR_ACTION_RETRY_BASE_MS'
  );
  const retryMaxMs = boundedInteger(
    resolveFabricEnv(env, 'IVR_ACTION_RETRY_MAX_MS'), 60_000, 100, 3_600_000,
    'CONVERACT_FABRIC_IVR_ACTION_RETRY_MAX_MS'
  );
  if (retryMaxMs < retryBaseMs) {
    throw new Error('CONVERACT_FABRIC_IVR_ACTION_RETRY_MAX_MS must be at least CONVERACT_FABRIC_IVR_ACTION_RETRY_BASE_MS');
  }
  return {
    enabled: binaryFlag(
      resolveFabricEnv(env, 'IVR_WORKERS_ENABLED'), false, 'CONVERACT_FABRIC_IVR_WORKERS_ENABLED'
    ),
    action_interval_ms: boundedInteger(
      resolveFabricEnv(env, 'IVR_ACTION_INTERVAL_MS'), 1_000, 100, 300_000,
      'CONVERACT_FABRIC_IVR_ACTION_INTERVAL_MS'
    ),
    action_batch_size: boundedInteger(
      resolveFabricEnv(env, 'IVR_ACTION_BATCH_SIZE'), 25, 1, 200,
      'CONVERACT_FABRIC_IVR_ACTION_BATCH_SIZE'
    ),
    action_lease_ms: boundedInteger(
      resolveFabricEnv(env, 'IVR_ACTION_LEASE_MS'), 30_000, 1_000, 300_000,
      'CONVERACT_FABRIC_IVR_ACTION_LEASE_MS'
    ),
    action_retry_base_ms: retryBaseMs,
    action_retry_max_ms: retryMaxMs,
    reconciliation_interval_ms: boundedInteger(
      resolveFabricEnv(env, 'IVR_RECONCILIATION_INTERVAL_MS'), 10_000, 100, 3_600_000,
      'CONVERACT_FABRIC_IVR_RECONCILIATION_INTERVAL_MS'
    ),
    reconciliation_lease_ms: boundedInteger(
      resolveFabricEnv(env, 'IVR_RECONCILIATION_LEASE_MS'), 30_000, 1_000, 300_000,
      'CONVERACT_FABRIC_IVR_RECONCILIATION_LEASE_MS'
    ),
    reconciliation_retry_ms: boundedInteger(
      resolveFabricEnv(env, 'IVR_RECONCILIATION_RETRY_MS'), 10_000, 1_000, 3_600_000,
      'CONVERACT_FABRIC_IVR_RECONCILIATION_RETRY_MS'
    ),
    reconciliation_max_attempts: boundedInteger(
      resolveFabricEnv(env, 'IVR_RECONCILIATION_MAX_ATTEMPTS'), 20, 1, 1_000,
      'CONVERACT_FABRIC_IVR_RECONCILIATION_MAX_ATTEMPTS'
    ),
    tenant_limit: boundedInteger(
      resolveFabricEnv(env, 'IVR_TENANT_LIMIT'), 100, 1, 1_000,
      'CONVERACT_FABRIC_IVR_TENANT_LIMIT'
    )
  };
}

export function startIveKitIvrPendingActionWorker(
  input: IveKitIvrRuntimeInput
): IveKitIvrWorkerHandle {
  const config = iveKitIvrWorkerConfig(input.env);
  if (!config.enabled) return stoppedHandle();
  if (!input.executor) {
    throw new Error('enabled iveKit IVR pending-action executor must be injected');
  }
  const actions = new PostgresIvrPendingActionStore(input.pg);
  const completion = createSessionCompletion(input);
  const worker = new IvrPendingActionWorker({
    actions,
    executor: input.executor,
    completion,
    worker_id: `ivr-action:${process.pid}:${randomUUID()}`,
    limit: config.action_batch_size,
    lease_ms: config.action_lease_ms,
    retry_base_ms: config.action_retry_base_ms,
    retry_max_ms: config.action_retry_max_ms
  });
  return startTenantLoop({
    interval_ms: config.action_interval_ms,
    list_tenants: () => listIvrWorkerTenants(input.pg, config.tenant_limit),
    run_tenant: (tenantId) => worker.runTenant(tenantId),
    label: 'ivr-pending-action'
  });
}

export function startIveKitIvrReconciliationWorker(
  input: IveKitIvrRuntimeInput
): IveKitIvrWorkerHandle {
  const config = iveKitIvrWorkerConfig(input.env);
  if (!config.enabled) return stoppedHandle();
  if (!input.reconciler) {
    throw new Error('enabled iveKit IVR pending-action reconciler must be injected');
  }
  const actions = new PostgresIvrPendingActionStore(input.pg);
  const completion = createSessionCompletion(input);
  const worker = new IvrPendingActionReconciliationWorker({
    actions,
    reconciler: input.reconciler,
    completion,
    worker_id: `ivr-reconciliation:${process.pid}:${randomUUID()}`,
    limit: config.action_batch_size,
    lease_ms: config.reconciliation_lease_ms,
    retry_ms: config.reconciliation_retry_ms,
    max_reconciliations: config.reconciliation_max_attempts
  });
  return startTenantLoop({
    interval_ms: config.reconciliation_interval_ms,
    list_tenants: () => listIvrWorkerTenants(input.pg, config.tenant_limit),
    run_tenant: (tenantId) => worker.runTenant(tenantId),
    label: 'ivr-reconciliation'
  });
}

export async function listIvrWorkerTenants(
  pg: PgQueryable,
  limit: number,
  now = new Date()
): Promise<string[]> {
  const boundedLimit = numericBound(limit, 1, 1_000);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  const result = await pg.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM opc_worker_tenant_ids($1, $2, $3)',
    ['ivr_pending_action', now.toISOString(), boundedLimit]
  );
  return [...new Set(result.rows.map((row) => String(row.tenant_id || '')).filter(Boolean))];
}

function createSessionCompletion(input: IveKitIvrRuntimeInput): IvrSessionActionCompletion {
  return new IvrSessionActionCompletion(new IvrSessionService({
    unit_of_work: new PostgresIvrSessionUnitOfWork(input.pg)
  }), input.publish ? {
    on_transition: (result) => emitIvrSessionEvents(
      projectIvrSessionEvents(result), input.publish!
    )
  } : {});
}

function startTenantLoop(input: {
  interval_ms: number;
  list_tenants: () => Promise<string[]>;
  run_tenant: (tenantId: string) => Promise<unknown>;
  label: string;
}): IveKitIvrWorkerHandle {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let stopped = false;
  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      if (!active) {
        active = runTenantBatch(input).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${input.label}] worker failed:`, redactError(message));
        }).finally(() => { active = null; });
      }
      void active.finally(() => schedule(input.interval_ms));
    }, delay);
    timer.unref?.();
  };
  schedule(0);
  let stopPromise: Promise<void> | null = null;
  return {
    stop() {
      if (!stopPromise) {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        stopPromise = Promise.resolve(active);
      }
      return stopPromise;
    }
  };
}

async function runTenantBatch(input: {
  list_tenants: () => Promise<string[]>;
  run_tenant: (tenantId: string) => Promise<unknown>;
  label: string;
}): Promise<void> {
  for (const tenantId of await input.list_tenants()) {
    try {
      await input.run_tenant(tenantId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${input.label}] tenant batch failed:`, redactError(message));
    }
  }
}

function stoppedHandle(): IveKitIvrWorkerHandle {
  return { async stop() {} };
}

function binaryFlag(value: string | undefined, fallback: boolean, field: string): boolean {
  if (!String(value || '').trim()) return fallback;
  if (value !== '0' && value !== '1') throw new Error(`${field} must be 0 or 1`);
  return value === '1';
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  if (!String(value || '').trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function numericBound(value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value;
}

function redactError(value: string): string {
  return value
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(token|key|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\/\/[^/@\s]+@/g, '//[redacted]@')
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .slice(0, 500);
}
