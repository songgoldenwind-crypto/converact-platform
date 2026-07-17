import type { LiveKitEgressJobStatus } from './types.js';
import { withPgTransaction, type PgQueryable } from '../../db-pg.js';
import { PostgresInteractionPlacementRepository } from '../ivekit/placement/interaction-placement.js';

export interface LiveKitEgressProviderInfo {
  egressId?: string;
  egress_id?: string;
  status?: number | string;
  error?: string;
  errorCode?: number;
  error_code?: number;
  fileResults?: Array<Record<string, unknown>>;
  file_results?: Array<Record<string, unknown>>;
}

export interface LiveKitEgressProjection {
  status: LiveKitEgressJobStatus;
  failure_code: string;
  duration_ms: number;
  file_size_bytes: number;
  storage_url: string;
}

export interface LiveKitEgressReconciliationJob {
  id: string;
  tenant_id: string;
  recording_id: string;
  room_name: string;
  media_call_id: string;
  egress_id: string;
  status: LiveKitEgressJobStatus;
  failure_code: string;
  reservation_id: string;
  owner_epoch: string;
  storage_url: string;
  duration_ms: number | null;
  file_size_bytes: number | null;
  provider_missing_count: number;
  reconcile_attempts: number;
  reconcile_worker_id: string;
  reconcile_lease_until: string | null;
  reconcile_after: string;
  provider_observed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveKitEgressReconciliationStore {
  claim(input: {
    tenant_id: string;
    worker_id: string;
    now: string;
    stale_before: string;
    lease_until: string;
    limit: number;
  }): Promise<LiveKitEgressReconciliationJob[]>;
  settle(input: {
    job: LiveKitEgressReconciliationJob;
    worker_id: string;
    now: string;
    next_attempt_at: string;
    projection: LiveKitEgressProjection;
  }): Promise<boolean>;
  markMissing(input: {
    job: LiveKitEgressReconciliationJob;
    worker_id: string;
    now: string;
    next_attempt_at: string;
    max_missing_observations: number;
  }): Promise<{ settled: boolean; failed: boolean }>;
  releaseProviderError(input: {
    job: LiveKitEgressReconciliationJob;
    worker_id: string;
    now: string;
    next_attempt_at: string;
  }): Promise<boolean>;
}

export interface LiveKitEgressReconciliationProvider {
  listEgress(job: LiveKitEgressReconciliationJob): Promise<LiveKitEgressProviderInfo[]>;
}

export interface LiveKitEgressReconciliationRunResult {
  claimed: number;
  completed: number;
  failed: number;
  active: number;
  missing: number;
  provider_errors: number;
  stale: number;
}

export class PostgresLiveKitEgressReconciliationStore implements LiveKitEgressReconciliationStore {
  constructor(private readonly pg: PgQueryable) {}

  async claim(input: Parameters<LiveKitEgressReconciliationStore['claim']>[0]): Promise<LiveKitEgressReconciliationJob[]> {
    const result = await this.pg.query(
      `WITH candidates AS (
         SELECT job.id
         FROM livekit_egress_jobs job
         WHERE job.tenant_id = $1
           AND job.status IN ('starting', 'recording', 'stopping')
           AND job.egress_id != ''
           AND job.egress_id NOT LIKE 'egress_pending_%'
           AND job.reconcile_after <= $3::timestamptz
           AND job.updated_at <= $4::timestamptz
           AND (job.reconcile_lease_until IS NULL OR job.reconcile_lease_until <= $3::timestamptz)
         ORDER BY job.reconcile_after ASC, job.updated_at ASC, job.id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $6
       )
       UPDATE livekit_egress_jobs job
       SET reconcile_worker_id = $2,
           reconcile_lease_until = $5::timestamptz,
           reconcile_attempts = job.reconcile_attempts + 1
       FROM candidates
       WHERE job.tenant_id = $1 AND job.id = candidates.id
       RETURNING job.*,
         COALESCE((
           SELECT recording.media_call_id
           FROM call_recordings recording
           WHERE recording.tenant_id = job.tenant_id AND recording.id = job.recording_id
         ), '') AS media_call_id`,
      [
        input.tenant_id,
        input.worker_id,
        input.now,
        input.stale_before,
        input.lease_until,
        input.limit
      ]
    );
    return result.rows.map(decodeReconciliationJob);
  }

  async settle(input: Parameters<LiveKitEgressReconciliationStore['settle']>[0]): Promise<boolean> {
    return withPgTransaction(this.pg, async (client) => {
      const terminal = input.projection.status === 'completed' || input.projection.status === 'failed';
      const result = await client.query<{ recording_id: string }>(
        `UPDATE livekit_egress_jobs
         SET status = $1,
             failure_code = $2,
             duration_ms = $3,
             file_size_bytes = $4,
             storage_url = CASE WHEN $5 != '' THEN $5 ELSE storage_url END,
             provider_observed_at = $6::timestamptz,
             provider_missing_count = 0,
             reconcile_after = $7::timestamptz,
             reconcile_lease_until = NULL,
             reconcile_worker_id = '',
             completed_at = CASE WHEN $8 THEN COALESCE(completed_at, $6::timestamptz) ELSE completed_at END,
             updated_at = $6::timestamptz
         WHERE tenant_id = $9 AND id = $10
           AND reconcile_worker_id = $11
           AND reconcile_lease_until >= $6::timestamptz
           AND status IN ('starting', 'recording', 'stopping')
         RETURNING recording_id`,
        [
          input.projection.status,
          input.projection.failure_code,
          input.projection.duration_ms,
          input.projection.file_size_bytes,
          input.projection.storage_url,
          input.now,
          input.next_attempt_at,
          terminal,
          input.job.tenant_id,
          input.job.id,
          input.worker_id
        ]
      );
      const recordingId = result.rows[0]?.recording_id;
      if (!recordingId) return false;
      if (terminal) {
        await closeEgressPlacement(
          client,
          input.job,
          `livekit_egress_${input.projection.status}`,
          input.now
        );
      }
      await aggregateRecording(client, input.job.tenant_id, recordingId, input.now);
      return true;
    });
  }

  async markMissing(
    input: Parameters<LiveKitEgressReconciliationStore['markMissing']>[0]
  ): Promise<{ settled: boolean; failed: boolean }> {
    return withPgTransaction(this.pg, async (client) => {
      const result = await client.query<{ recording_id: string; status: LiveKitEgressJobStatus }>(
        `UPDATE livekit_egress_jobs
         SET provider_missing_count = provider_missing_count + 1,
             status = CASE WHEN provider_missing_count + 1 >= $1 THEN 'failed' ELSE status END,
             failure_code = CASE
               WHEN provider_missing_count + 1 >= $1 THEN 'livekit_egress_not_found'
               ELSE 'livekit_egress_reconcile_missing'
             END,
             reconcile_after = $2::timestamptz,
             reconcile_lease_until = NULL,
             reconcile_worker_id = '',
             completed_at = CASE
               WHEN provider_missing_count + 1 >= $1 THEN COALESCE(completed_at, $3::timestamptz)
               ELSE completed_at
             END,
             updated_at = $3::timestamptz
         WHERE tenant_id = $4 AND id = $5
           AND reconcile_worker_id = $6
           AND reconcile_lease_until >= $3::timestamptz
           AND status IN ('starting', 'recording', 'stopping')
         RETURNING recording_id, status`,
        [
          input.max_missing_observations,
          input.next_attempt_at,
          input.now,
          input.job.tenant_id,
          input.job.id,
          input.worker_id
        ]
      );
      const row = result.rows[0];
      if (!row) return { settled: false, failed: false };
      const failed = row.status === 'failed';
      if (failed) {
        await closeEgressPlacement(client, input.job, 'livekit_egress_not_found', input.now);
        await aggregateRecording(client, input.job.tenant_id, row.recording_id, input.now);
      }
      return { settled: true, failed };
    });
  }

  async releaseProviderError(
    input: Parameters<LiveKitEgressReconciliationStore['releaseProviderError']>[0]
  ): Promise<boolean> {
    const result = await this.pg.query(
      `UPDATE livekit_egress_jobs
       SET failure_code = 'livekit_egress_reconcile_failed',
           reconcile_after = $1::timestamptz,
           reconcile_lease_until = NULL,
           reconcile_worker_id = '',
           updated_at = $2::timestamptz
       WHERE tenant_id = $3 AND id = $4
         AND reconcile_worker_id = $5
         AND reconcile_lease_until >= $2::timestamptz
         AND status IN ('starting', 'recording', 'stopping')
       RETURNING id`,
      [
        input.next_attempt_at,
        input.now,
        input.job.tenant_id,
        input.job.id,
        input.worker_id
      ]
    );
    return result.rows.length === 1;
  }
}

export class LiveKitEgressReconciliationWorker {
  readonly #store: LiveKitEgressReconciliationStore;
  readonly #provider: LiveKitEgressReconciliationProvider;
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #staleMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #maxMissingObservations: number;
  readonly #now: () => Date;
  #active: Promise<LiveKitEgressReconciliationRunResult> | null = null;
  #shutdown = false;

  constructor(input: {
    store: LiveKitEgressReconciliationStore;
    provider: LiveKitEgressReconciliationProvider;
    worker_id: string;
    batch_size?: number;
    lease_ms?: number;
    stale_ms?: number;
    retry_base_ms?: number;
    retry_max_ms?: number;
    max_missing_observations?: number;
    now?: () => Date;
  }) {
    this.#store = input.store;
    this.#provider = input.provider;
    this.#workerId = boundedIdentifier(input.worker_id, 'worker_id');
    this.#batchSize = boundedInteger(input.batch_size, 25, 1, 200, 'batch_size');
    this.#leaseMs = boundedInteger(input.lease_ms, 30_000, 1_000, 15 * 60_000, 'lease_ms');
    this.#staleMs = boundedInteger(input.stale_ms, 30_000, 1_000, 24 * 60 * 60_000, 'stale_ms');
    this.#retryBaseMs = boundedInteger(input.retry_base_ms, 5_000, 100, 60 * 60_000, 'retry_base_ms');
    this.#retryMaxMs = boundedInteger(input.retry_max_ms, 5 * 60_000, this.#retryBaseMs, 24 * 60 * 60_000, 'retry_max_ms');
    this.#maxMissingObservations = boundedInteger(
      input.max_missing_observations,
      2,
      2,
      10,
      'max_missing_observations'
    );
    this.#now = input.now || (() => new Date());
  }

  runOnce(tenantIdInput: string): Promise<LiveKitEgressReconciliationRunResult> {
    if (this.#shutdown) return Promise.reject(new Error('LiveKit Egress reconciliation worker is stopped'));
    if (this.#active) return this.#active;
    const tenantId = boundedIdentifier(tenantIdInput, 'tenant_id');
    const running = this.#run(tenantId);
    const wrapped = running.finally(() => {
      if (this.#active === wrapped) this.#active = null;
    });
    this.#active = wrapped;
    return wrapped;
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true;
    await this.#active?.catch(() => undefined);
  }

  async #run(tenantId: string): Promise<LiveKitEgressReconciliationRunResult> {
    const now = this.#now();
    const nowIso = now.toISOString();
    const jobs = await this.#store.claim({
      tenant_id: tenantId,
      worker_id: this.#workerId,
      now: nowIso,
      stale_before: new Date(now.getTime() - this.#staleMs).toISOString(),
      lease_until: new Date(now.getTime() + this.#leaseMs).toISOString(),
      limit: this.#batchSize
    });
    const result: LiveKitEgressReconciliationRunResult = {
      claimed: jobs.length,
      completed: 0,
      failed: 0,
      active: 0,
      missing: 0,
      provider_errors: 0,
      stale: 0
    };
    for (const job of jobs) await this.#reconcile(job, result);
    return result;
  }

  async #reconcile(
    job: LiveKitEgressReconciliationJob,
    result: LiveKitEgressReconciliationRunResult
  ): Promise<void> {
    const now = this.#now();
    const nowIso = now.toISOString();
    const nextAttemptAt = new Date(now.getTime() + this.#retryDelay(job.reconcile_attempts)).toISOString();
    let providerItems: LiveKitEgressProviderInfo[];
    try {
      providerItems = await this.#provider.listEgress(job);
    } catch {
      const settled = await this.#store.releaseProviderError({
        job,
        worker_id: this.#workerId,
        now: nowIso,
        next_attempt_at: nextAttemptAt
      });
      if (settled) result.provider_errors += 1;
      else result.stale += 1;
      return;
    }
    const providerInfo = providerItems.find((item) =>
      String(item.egressId || item.egress_id || '') === job.egress_id
    );
    if (!providerInfo) {
      const missing = await this.#store.markMissing({
        job,
        worker_id: this.#workerId,
        now: nowIso,
        next_attempt_at: nextAttemptAt,
        max_missing_observations: this.#maxMissingObservations
      });
      if (!missing.settled) result.stale += 1;
      else if (missing.failed) result.failed += 1;
      else result.missing += 1;
      return;
    }
    const projection = projectLiveKitEgressInfo(providerInfo);
    const settled = await this.#store.settle({
      job,
      worker_id: this.#workerId,
      now: nowIso,
      next_attempt_at: nextAttemptAt,
      projection
    });
    if (!settled) {
      result.stale += 1;
      return;
    }
    if (projection.status === 'completed') result.completed += 1;
    else if (projection.status === 'failed') result.failed += 1;
    else result.active += 1;
  }

  #retryDelay(attempts: number): number {
    const exponent = Math.min(Math.max(0, Math.floor(attempts)), 8);
    return Math.min(this.#retryMaxMs, this.#retryBaseMs * 2 ** exponent);
  }
}

export function projectLiveKitEgressInfo(info: LiveKitEgressProviderInfo): LiveKitEgressProjection {
  const status = normalizeProviderStatus(info.status);
  const files = info.fileResults || info.file_results || [];
  const file = files[0] || {};
  return {
    status: status.status,
    failure_code: status.failureCode,
    duration_ms: normalizeDurationMs(file),
    file_size_bytes: nonNegativeNumber(file.size),
    storage_url: String(file.location || file.downloadUrl || file.download_url || '')
  };
}

export function normalizeProviderStatus(
  value: unknown,
  fallback: LiveKitEgressJobStatus = 'recording'
): { status: LiveKitEgressJobStatus; failureCode: string } {
  const normalized = typeof value === 'number'
    ? value
    : String(value ?? '').trim().toUpperCase().replace(/^EGRESS_/, '');
  switch (normalized) {
    case 0:
    case '0':
    case 'STARTING':
      return { status: 'starting', failureCode: '' };
    case 1:
    case '1':
    case 'ACTIVE':
      return { status: 'recording', failureCode: '' };
    case 2:
    case '2':
    case 'ENDING':
      return { status: 'stopping', failureCode: '' };
    case 3:
    case '3':
    case 'COMPLETE':
    case 'COMPLETED':
      return { status: 'completed', failureCode: '' };
    case 4:
    case '4':
    case 'FAILED':
      return { status: 'failed', failureCode: 'livekit_egress_failed' };
    case 5:
    case '5':
    case 'ABORTED':
      return { status: 'failed', failureCode: 'livekit_egress_aborted' };
    case 6:
    case '6':
    case 'LIMIT_REACHED':
      return { status: 'failed', failureCode: 'livekit_egress_limit_reached' };
    default:
      return { status: fallback, failureCode: '' };
  }
}

async function aggregateRecording(
  pg: PgQueryable,
  tenantId: string,
  recordingId: string,
  now: string
): Promise<void> {
  await pg.query(
    `WITH aggregate AS (
       SELECT COUNT(*)::integer AS total_jobs,
              COUNT(*) FILTER (WHERE status = 'completed')::integer AS completed_jobs,
              COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_jobs,
              COUNT(*) FILTER (WHERE status = 'stopped')::integer AS stopped_jobs,
              COUNT(*) FILTER (WHERE status IN ('completed', 'failed', 'stopped'))::integer AS terminal_jobs,
              COUNT(*) FILTER (WHERE status = 'recording')::integer AS recording_jobs,
              COUNT(*) FILTER (WHERE status = 'stopping')::integer AS stopping_jobs,
              COUNT(*) FILTER (WHERE status = 'starting')::integer AS starting_jobs,
              COALESCE(MAX(duration_ms), 0)::bigint AS duration_ms,
              COALESCE(SUM(file_size_bytes), 0)::bigint AS file_size_bytes
       FROM livekit_egress_jobs
       WHERE tenant_id = $1 AND recording_id = $2
     ), primary_job AS (
       SELECT storage_url
       FROM livekit_egress_jobs
       WHERE tenant_id = $1 AND recording_id = $2
       ORDER BY job_sequence ASC
       LIMIT 1
     ), first_failure AS (
       SELECT failure_code
       FROM livekit_egress_jobs
       WHERE tenant_id = $1 AND recording_id = $2 AND status = 'failed'
       ORDER BY job_sequence ASC
       LIMIT 1
     )
     UPDATE call_recordings recording
     SET status = CASE
           WHEN aggregate.total_jobs > 0 AND aggregate.terminal_jobs = aggregate.total_jobs THEN
             CASE
               WHEN aggregate.failed_jobs > 0 THEN 'failed'
               WHEN aggregate.completed_jobs = aggregate.total_jobs THEN 'completed'
               ELSE 'stopped'
             END
           WHEN aggregate.recording_jobs > 0 THEN 'recording'
           WHEN aggregate.stopping_jobs > 0 THEN 'stopping'
           WHEN aggregate.starting_jobs > 0 THEN 'starting'
           ELSE recording.status
         END,
         failure_code = CASE
           WHEN aggregate.failed_jobs > 0 THEN COALESCE((SELECT failure_code FROM first_failure), 'livekit_egress_child_failed')
           WHEN aggregate.completed_jobs = aggregate.total_jobs THEN ''
           ELSE recording.failure_code
         END,
         storage_url = COALESCE(NULLIF((SELECT storage_url FROM primary_job), ''), recording.storage_url),
         duration_ms = aggregate.duration_ms,
         file_size_bytes = aggregate.file_size_bytes,
         completed_at = CASE
           WHEN aggregate.total_jobs > 0 AND aggregate.terminal_jobs = aggregate.total_jobs
             THEN COALESCE(recording.completed_at, $3::timestamptz)
           ELSE recording.completed_at
         END,
         updated_at = $3::timestamptz
     FROM aggregate
     WHERE recording.tenant_id = $1 AND recording.id = $2`,
    [tenantId, recordingId, now]
  );
}

async function closeEgressPlacement(
  pg: PgQueryable,
  job: LiveKitEgressReconciliationJob,
  reason: string,
  now: string
): Promise<void> {
  if (!job.reservation_id || !job.owner_epoch) return;
  await new PostgresInteractionPlacementRepository(pg).requestState({
    tenant_id: job.tenant_id,
    interaction_kind: 'livekit_av',
    interaction_id: job.id,
    desired_state: 'closed',
    reason,
    expected_reservation_id: job.reservation_id,
    expected_owner_epoch: job.owner_epoch,
    now: new Date(now)
  });
}

function decodeReconciliationJob(row: Record<string, unknown>): LiveKitEgressReconciliationJob {
  return {
    id: String(row.id || ''),
    tenant_id: String(row.tenant_id || ''),
    recording_id: String(row.recording_id || ''),
    room_name: String(row.room_name || ''),
    media_call_id: String(row.media_call_id || ''),
    egress_id: String(row.egress_id || ''),
    status: String(row.status || 'recording') as LiveKitEgressJobStatus,
    failure_code: String(row.failure_code || ''),
    reservation_id: String(row.reservation_id || ''),
    owner_epoch: row.owner_epoch == null ? '' : String(row.owner_epoch),
    storage_url: String(row.storage_url || ''),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    file_size_bytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
    provider_missing_count: Number(row.provider_missing_count || 0),
    reconcile_attempts: Number(row.reconcile_attempts || 0),
    reconcile_worker_id: String(row.reconcile_worker_id || ''),
    reconcile_lease_until: nullableTimestamp(row.reconcile_lease_until),
    reconcile_after: timestamp(row.reconcile_after),
    provider_observed_at: nullableTimestamp(row.provider_observed_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}

function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value || '');
}

function normalizeDurationMs(file: Record<string, unknown>): number {
  const explicitMs = file.durationMs ?? file.duration_ms;
  if (explicitMs != null) return nonNegativeNumber(explicitMs);
  const raw = nonNegativeNumber(file.duration);
  return raw > 86_400_000 ? Math.round(raw / 1_000_000) : raw;
}

function nonNegativeNumber(value: unknown): number {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function boundedIdentifier(value: string, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200) throw new Error(`${field} is required and must not exceed 200 characters`);
  return normalized;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}
