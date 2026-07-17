import { randomUUID } from 'node:crypto';

import type {
  PlacementPgQueryable
} from '../../../src/agent-runtime/ivekit/placement/pg-queryable.js';
import { canonicalSha256 } from '../canonical-json.js';
import {
  LoadRunControlError,
  type CapacityCommandOutboxRecord,
  type CapacityControllerLease,
  type CapacityEvidenceRecord,
  type CapacityLoadRunRepository,
  type CapacityShardAssignment,
  type CapacityShardExecutionCheckpoint,
  type CapacityShardExecutionCheckpointRepository,
  type CapacityShardExecutionResult,
  type CapacityShardLeaseRenewal,
  type CapacityStartShardCommand,
  type CapacityWorkerHeartbeat
} from './types.js';

type Row = Record<string, unknown>;

export class PostgresCapacityLoadRunRepository
implements CapacityLoadRunRepository, CapacityShardExecutionCheckpointRepository {
  readonly #pg: PlacementPgQueryable;
  readonly #id: () => string;

  constructor(pg: PlacementPgQueryable, options: { id?: () => string } = {}) {
    this.#pg = pg;
    this.#id = options.id || randomUUID;
  }

  async createRun(input: Parameters<CapacityLoadRunRepository['createRun']>[0]): Promise<void> {
    const result = await this.#pg.query(
      `WITH inserted_run AS (
         INSERT INTO ivekit_capacity_load_runs
           (run_id, profile_id, manifest_sha256, manifest, state, start_not_before,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, 'planned', $5::timestamptz,
           $6::timestamptz, $6::timestamptz)
         ON CONFLICT (run_id) DO NOTHING
         RETURNING run_id
       ), phase_input AS (
         SELECT value, ordinal::integer - 1 AS phase_ordinal
         FROM jsonb_array_elements($7::jsonb) WITH ORDINALITY AS item(value, ordinal)
       ), inserted_phases AS (
         INSERT INTO ivekit_capacity_load_phases
           (run_id, phase_id, phase_ordinal, duration_seconds, state, created_at, updated_at)
         SELECT $1, value->>'id', phase_ordinal,
           NULLIF(value->>'duration_seconds', '')::integer, 'pending',
           $6::timestamptz, $6::timestamptz
         FROM phase_input WHERE EXISTS (SELECT 1 FROM inserted_run)
         RETURNING run_id, phase_id
       ), shard_input AS (
         SELECT value FROM jsonb_array_elements($8::jsonb)
       ), inserted_shards AS (
         INSERT INTO ivekit_capacity_load_shards
           (run_id, phase_id, shard_id, fleet_id, workload_domain, workload_id,
            workload_kind, ordinal_start, ordinal_end_exclusive, expected_count,
            required_protocols, seed, state, lease_epoch, created_at, updated_at)
         SELECT $1, phase.phase_id, shard.value->>'shard_id',
           shard.value->>'assigned_fleet', shard.value->>'workload_domain',
           shard.value->>'workload_id', shard.value->>'workload_kind',
           (shard.value->>'ordinal_start')::integer,
           (shard.value->>'ordinal_end_exclusive')::integer,
           (shard.value->>'expected_count')::integer,
           shard.value->'required_protocols', shard.value->>'seed',
           'pending', 0, $6::timestamptz, $6::timestamptz
         FROM inserted_phases phase CROSS JOIN shard_input shard
         RETURNING shard_id
       )
       SELECT
         (SELECT COUNT(*) FROM inserted_run)::integer AS runs_inserted,
         (SELECT COUNT(*) FROM inserted_phases)::integer AS phases_inserted,
         (SELECT COUNT(*) FROM inserted_shards)::integer AS shards_inserted`,
      [
        input.manifest.run_id,
        input.manifest.profile_id,
        input.manifest_sha256,
        JSON.stringify(input.manifest),
        input.manifest.start_not_before,
        input.created_at,
        JSON.stringify(input.manifest.phases),
        JSON.stringify(input.manifest.shards)
      ]
    );
    const row = result.rows[0] as Row | undefined;
    if (Number(row?.runs_inserted || 0) !== 1) {
      throw new LoadRunControlError('run_already_exists', 409);
    }
  }

  async readRunControlState(input: {
    run_id: string;
  }): Promise<{
    state: 'planned' | 'ready' | 'running' | 'finalizing' |
      'completed' | 'failed' | 'cancelled' | 'not_run';
    current_phase_id: string;
    manifest_sha256: string;
    evidence_manifest_sha256: string;
    outcome: string;
  }> {
    const result = await this.#pg.query<Row>(
      `SELECT state, COALESCE(current_phase_id, '') AS current_phase_id,
         manifest_sha256, evidence_manifest_sha256, outcome
       FROM ivekit_capacity_load_runs
       WHERE run_id = $1`,
      [input.run_id]
    );
    const row = result.rows[0];
    if (!row) throw new LoadRunControlError('run_not_found', 404);
    const state = runState(row.state);
    return {
      state,
      current_phase_id: String(row.current_phase_id || ''),
      manifest_sha256: String(row.manifest_sha256 || ''),
      evidence_manifest_sha256: String(row.evidence_manifest_sha256 || ''),
      outcome: String(row.outcome || '')
    };
  }

  async readPhaseProgress(input: {
    run_id: string;
    phase_id: string;
  }): Promise<{
    phase_id: string;
    state: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
    total_shards: number;
    completed_shards: number;
    failed_shards: number;
    cancelled_shards: number;
    not_run_shards: number;
    active_shards: number;
  }> {
    const result = await this.#pg.query<Row>(
      `SELECT phase.phase_id, phase.state,
         COUNT(shard.shard_id)::integer AS total_shards,
         COUNT(*) FILTER (WHERE shard.state = 'completed')::integer AS completed_shards,
         COUNT(*) FILTER (WHERE shard.state = 'failed')::integer AS failed_shards,
         COUNT(*) FILTER (WHERE shard.state = 'cancelled')::integer AS cancelled_shards,
         COUNT(*) FILTER (WHERE shard.state = 'not_run')::integer AS not_run_shards,
         COUNT(*) FILTER (WHERE shard.state IN ('leased', 'running'))::integer AS active_shards
       FROM ivekit_capacity_load_phases phase
       LEFT JOIN ivekit_capacity_load_shards shard
         ON shard.run_id = phase.run_id AND shard.phase_id = phase.phase_id
       WHERE phase.run_id = $1 AND phase.phase_id = $2
       GROUP BY phase.phase_id, phase.state`,
      [input.run_id, input.phase_id]
    );
    const row = result.rows[0];
    if (!row) throw new LoadRunControlError('phase_not_found', 404);
    const state = String(row.state);
    if (!['pending', 'running', 'completed', 'failed', 'skipped'].includes(state)) {
      throw new LoadRunControlError('phase_state_invalid', 500);
    }
    return {
      phase_id: String(row.phase_id),
      state: state as 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
      total_shards: nonNegativeRowInteger(row.total_shards, 'total_shards'),
      completed_shards: nonNegativeRowInteger(row.completed_shards, 'completed_shards'),
      failed_shards: nonNegativeRowInteger(row.failed_shards, 'failed_shards'),
      cancelled_shards: nonNegativeRowInteger(row.cancelled_shards, 'cancelled_shards'),
      not_run_shards: nonNegativeRowInteger(row.not_run_shards, 'not_run_shards'),
      active_shards: nonNegativeRowInteger(row.active_shards, 'active_shards')
    };
  }

  async claimController(
    input: Parameters<CapacityLoadRunRepository['claimController']>[0]
  ): Promise<CapacityControllerLease> {
    const leaseExpiresAt = expiresAt(input.now, input.lease_ttl_ms);
    const result = await this.#pg.query<Row>(
      `UPDATE ivekit_capacity_load_runs
       SET controller_lease_epoch = CASE
             WHEN controller_id = $2 AND controller_lease_expires_at > $3::timestamptz
               THEN controller_lease_epoch
             ELSE controller_lease_epoch + 1
           END,
           controller_id = $2,
           controller_lease_expires_at = $4::timestamptz,
           updated_at = $3::timestamptz
       WHERE run_id = $1
         AND state NOT IN ('completed', 'failed', 'cancelled', 'not_run')
         AND (
           controller_id IS NULL OR controller_id = $2
           OR controller_lease_expires_at <= $3::timestamptz
         )
       RETURNING run_id, controller_id,
         controller_lease_epoch::text AS lease_epoch,
         controller_lease_expires_at`,
      [input.run_id, input.controller_id, input.now, leaseExpiresAt]
    );
    if (!result.rows[0]) throw new LoadRunControlError('controller_lease_unavailable', 409, true);
    return decodeControllerLease(result.rows[0]);
  }

  async startPhase(
    input: Parameters<CapacityLoadRunRepository['startPhase']>[0]
  ): Promise<void> {
    const result = await this.#pg.query(
      `WITH fenced_run AS (
         SELECT run_id FROM ivekit_capacity_load_runs
         WHERE run_id = $1 AND controller_id = $3
           AND controller_lease_epoch = $4::bigint
           AND controller_lease_expires_at > $5::timestamptz
           AND start_not_before <= $5::timestamptz
           AND state IN ('planned', 'ready', 'running')
         FOR UPDATE
       ), selected_phase AS (
         SELECT phase.run_id, phase.phase_id
         FROM ivekit_capacity_load_phases phase, fenced_run
         WHERE phase.run_id = $1 AND phase.phase_id = $2 AND phase.state = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM ivekit_capacity_load_phases prior
             WHERE prior.run_id = phase.run_id
               AND prior.phase_ordinal < phase.phase_ordinal
               AND prior.state <> 'completed'
         )
         FOR UPDATE
       ), updated_phase AS (
         UPDATE ivekit_capacity_load_phases phase
         SET state = 'running', started_at = $5::timestamptz, updated_at = $5::timestamptz
         FROM selected_phase
         WHERE phase.run_id = selected_phase.run_id
           AND phase.phase_id = selected_phase.phase_id
         RETURNING phase.run_id, phase.phase_id
       )
       UPDATE ivekit_capacity_load_runs run
       SET state = 'running', current_phase_id = updated_phase.phase_id,
           started_at = COALESCE(run.started_at, $5::timestamptz),
           updated_at = $5::timestamptz
       FROM updated_phase
       WHERE run.run_id = updated_phase.run_id
       RETURNING updated_phase.phase_id`,
      [
        input.run_id, input.phase_id, input.controller_id,
        input.controller_lease_epoch, input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('stale_controller_lease', 409);
  }

  async heartbeatWorker(input: CapacityWorkerHeartbeat): Promise<void> {
    const result = await this.#pg.query(
      `INSERT INTO ivekit_capacity_load_workers
         (run_id, worker_id, fleet_id, release_id, state, safe_capacity,
          assigned_load, reported_load, metadata, heartbeat_at, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, $6, 0, $7, $8::jsonb,
         LEAST($9::timestamptz, clock_timestamp() + INTERVAL '5 seconds'),
         LEAST($9::timestamptz, clock_timestamp() + INTERVAL '5 seconds'),
         LEAST($9::timestamptz, clock_timestamp() + INTERVAL '5 seconds')
       WHERE EXISTS (
         SELECT 1 FROM ivekit_capacity_load_runs
         WHERE run_id = $1
           AND manifest->>'generator_release_id' = $4
           AND state NOT IN ('completed', 'failed', 'cancelled', 'not_run')
       )
       ON CONFLICT (run_id, worker_id) DO UPDATE
       SET fleet_id = EXCLUDED.fleet_id, release_id = EXCLUDED.release_id,
           state = EXCLUDED.state, safe_capacity = EXCLUDED.safe_capacity,
           reported_load = EXCLUDED.reported_load, metadata = EXCLUDED.metadata,
           heartbeat_at = EXCLUDED.heartbeat_at, updated_at = EXCLUDED.updated_at
       WHERE ivekit_capacity_load_workers.fleet_id = EXCLUDED.fleet_id
         AND ivekit_capacity_load_workers.assigned_load <= EXCLUDED.safe_capacity
       RETURNING worker_id`,
      [
        input.run_id, input.worker_id, input.fleet_id, input.release_id,
        input.state, input.safe_capacity, input.reported_load,
        JSON.stringify(input.metadata), input.observed_at
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('worker_heartbeat_rejected', 409);
  }

  async readWorkerOutstanding(input: {
    run_id: string;
    phase_id?: string;
    worker_id: string;
    fleet_id: string;
    now: string;
  }): Promise<{ shard_count: number; reported_load: number }> {
    const result = await this.#pg.query<Row>(
      `SELECT COUNT(*)::integer AS shard_count,
         COALESCE(SUM(expected_count), 0)::integer AS reported_load
       FROM ivekit_capacity_load_shards
       WHERE run_id = $1 AND ($2 = '' OR phase_id = $2) AND lease_owner = $3
         AND fleet_id = $4 AND state IN ('leased', 'running')
         AND lease_expires_at > $5::timestamptz`,
      [
        input.run_id, input.phase_id || '', input.worker_id,
        input.fleet_id, input.now
      ]
    );
    const row = result.rows[0] || {};
    const shardCount = Number(row.shard_count || 0);
    const reportedLoad = Number(row.reported_load || 0);
    if (!Number.isSafeInteger(shardCount) || shardCount < 0 ||
        !Number.isSafeInteger(reportedLoad) || reportedLoad < 0) {
      throw new LoadRunControlError('worker_outstanding_invalid', 500);
    }
    return { shard_count: shardCount, reported_load: reportedLoad };
  }

  async readRunSchedulingState(input: {
    run_id: string;
  }): Promise<{
    state: 'planned' | 'ready' | 'running' | 'finalizing' |
      'completed' | 'failed' | 'cancelled' | 'not_run';
    current_phase_id: string;
  }> {
    const result = await this.#pg.query<Row>(
      `SELECT state, COALESCE(current_phase_id, '') AS current_phase_id
       FROM ivekit_capacity_load_runs
       WHERE run_id = $1`,
      [input.run_id]
    );
    const row = result.rows[0];
    if (!row) throw new LoadRunControlError('run_not_found', 404);
    const state = String(row.state);
    if (![
      'planned', 'ready', 'running', 'finalizing',
      'completed', 'failed', 'cancelled', 'not_run'
    ].includes(state)) {
      throw new LoadRunControlError('run_state_invalid', 500);
    }
    return {
      state: state as 'planned' | 'ready' | 'running' | 'finalizing' |
        'completed' | 'failed' | 'cancelled' | 'not_run',
      current_phase_id: String(row.current_phase_id || '')
    };
  }

  async assignNextShard(
    input: Parameters<CapacityLoadRunRepository['assignNextShard']>[0]
  ): Promise<CapacityShardAssignment | null> {
    const commandId = this.#id();
    const leaseExpiresAt = expiresAt(input.now, input.lease_ttl_ms);
    const subject = commandSubject(input.fleet_id, input.worker_id);
    const result = await this.#pg.query<Row>(
      `WITH selected AS (
         SELECT shard.*
         FROM ivekit_capacity_load_shards shard
         JOIN ivekit_capacity_load_phases phase
           ON phase.run_id = shard.run_id AND phase.phase_id = shard.phase_id
         JOIN ivekit_capacity_load_workers worker
           ON worker.run_id = shard.run_id AND worker.worker_id = $3 AND worker.fleet_id = $4
         WHERE shard.run_id = $1 AND shard.phase_id = $2 AND shard.fleet_id = $4
           AND phase.state = 'running'
           AND worker.state = 'online'
           AND worker.heartbeat_at > $6::timestamptz - INTERVAL '30 seconds'
           AND GREATEST(worker.assigned_load, worker.reported_load) +
             CASE WHEN shard.lease_owner = $3 THEN 0 ELSE shard.expected_count END
             <= worker.safe_capacity
           AND (
             shard.state = 'pending'
             OR (shard.state IN ('leased', 'running') AND shard.lease_expires_at <= $6::timestamptz)
           )
         ORDER BY CASE WHEN shard.lease_owner = $3 THEN 0 ELSE 1 END, shard.shard_id
         LIMIT 1 FOR UPDATE OF shard, worker SKIP LOCKED
       ), released_old_worker AS (
         UPDATE ivekit_capacity_load_workers worker
         SET assigned_load = GREATEST(0, worker.assigned_load - selected.expected_count),
             updated_at = $6::timestamptz
         FROM selected
         WHERE worker.run_id = selected.run_id
           AND worker.worker_id = selected.lease_owner
           AND selected.lease_owner IS NOT NULL
           AND selected.lease_owner <> $3
         RETURNING worker.worker_id
       ), assigned AS (
         UPDATE ivekit_capacity_load_shards shard
         SET state = 'leased', lease_owner = $3,
             lease_epoch = selected.lease_epoch + 1,
             lease_expires_at = $5::timestamptz, heartbeat_at = $6::timestamptz,
             attempt_count = selected.attempt_count + 1,
             execution_state = 'pending', execution_result = '{}'::jsonb,
             execution_result_sha256 = '',
             evidence_id = '', error_code = '', updated_at = $6::timestamptz
         FROM selected
         WHERE shard.run_id = selected.run_id AND shard.phase_id = selected.phase_id
           AND shard.shard_id = selected.shard_id
         RETURNING shard.*
       ), charged_worker AS (
         UPDATE ivekit_capacity_load_workers worker
         SET assigned_load = worker.assigned_load +
               CASE WHEN selected.lease_owner = $3 THEN 0 ELSE selected.expected_count END,
             updated_at = $6::timestamptz
         FROM selected, assigned
         WHERE worker.run_id = assigned.run_id AND worker.worker_id = $3
         RETURNING worker.worker_id
       ), enqueued AS (
         INSERT INTO ivekit_capacity_command_outbox
           (command_id, run_id, command_key, subject, payload, state,
            available_at, created_at, updated_at)
         SELECT $7, assigned.run_id,
           assigned.phase_id || ':' || assigned.shard_id || ':' || assigned.lease_epoch::text,
           $8,
           jsonb_build_object(
             'schema_version', '1.0.0',
             'command_id', $7,
             'command_type', 'start_shard',
             'run_id', assigned.run_id,
             'phase_id', assigned.phase_id,
             'shard_id', assigned.shard_id,
             'worker_id', assigned.lease_owner,
             'fleet_id', assigned.fleet_id,
             'lease_epoch', assigned.lease_epoch::text,
             'lease_expires_at', to_char(assigned.lease_expires_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'issued_at', $6,
             'assignment', jsonb_build_object(
               'workload_domain', assigned.workload_domain,
               'workload_id', assigned.workload_id,
               'workload_kind', assigned.workload_kind,
               'ordinal_start', assigned.ordinal_start,
               'ordinal_end_exclusive', assigned.ordinal_end_exclusive,
               'expected_count', assigned.expected_count,
               'required_protocols', assigned.required_protocols,
               'seed', assigned.seed
             )
           ),
           'pending', $6::timestamptz, $6::timestamptz, $6::timestamptz
         FROM assigned, charged_worker
         ON CONFLICT (run_id, command_key) DO NOTHING
         RETURNING command_id
       )
       SELECT assigned.run_id, assigned.phase_id, assigned.shard_id,
         assigned.lease_owner AS worker_id, assigned.fleet_id,
         assigned.lease_epoch::text AS lease_epoch, assigned.lease_expires_at,
         assigned.workload_domain, assigned.workload_id, assigned.workload_kind,
         assigned.ordinal_start, assigned.ordinal_end_exclusive,
         assigned.expected_count, assigned.required_protocols, assigned.seed
       FROM assigned, charged_worker, enqueued`,
      [
        input.run_id, input.phase_id, input.worker_id, input.fleet_id,
        leaseExpiresAt, input.now, commandId, subject
      ]
    );
    return result.rows[0] ? decodeAssignment(result.rows[0]) : null;
  }

  async renewShardLease(
    input: Parameters<CapacityLoadRunRepository['renewShardLease']>[0]
  ): Promise<CapacityShardLeaseRenewal> {
    const result = await this.#pg.query<Row>(
      `WITH selected AS (
         SELECT run_id, phase_id, shard_id, state, execution_state,
           execution_result, execution_result_sha256
         FROM ivekit_capacity_load_shards
         WHERE run_id = $1 AND phase_id = $2 AND shard_id = $3 AND lease_owner = $4
           AND lease_epoch = $5::bigint
           AND state IN ('leased', 'running')
           AND lease_expires_at > $7::timestamptz
         FOR UPDATE
       )
       UPDATE ivekit_capacity_load_shards shard
       SET lease_expires_at = $6::timestamptz, heartbeat_at = $7::timestamptz,
           state = 'running',
           execution_state = CASE
             WHEN selected.state = 'leased' THEN 'running'
             ELSE selected.execution_state
           END,
           updated_at = $7::timestamptz
       FROM selected
       WHERE shard.run_id = selected.run_id AND shard.phase_id = selected.phase_id
         AND shard.shard_id = selected.shard_id
       RETURNING shard.run_id, shard.phase_id, shard.shard_id,
         shard.lease_owner AS worker_id, shard.fleet_id,
         shard.lease_epoch::text AS lease_epoch, shard.lease_expires_at,
         shard.workload_domain, shard.workload_id, shard.workload_kind,
         shard.ordinal_start, shard.ordinal_end_exclusive,
         shard.expected_count, shard.required_protocols, shard.seed,
         (selected.state = 'leased') AS execution_claimed,
         CASE WHEN selected.state = 'leased' THEN 'running'
           ELSE selected.execution_state END AS execution_state,
         selected.execution_result, selected.execution_result_sha256`,
      [
        input.run_id, input.phase_id, input.shard_id, input.worker_id, input.lease_epoch,
        expiresAt(input.now, input.lease_ttl_ms), input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('stale_shard_lease', 409);
    const checkpoint = decodeExecutionCheckpoint(result.rows[0]);
    return {
      ...decodeAssignment(result.rows[0]),
      execution_claimed: Boolean(result.rows[0].execution_claimed),
      execution_checkpoint: checkpoint
    };
  }

  async saveShardExecutionResult(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    result: CapacityShardExecutionResult;
    result_sha256: string;
    now: string;
  }): Promise<CapacityShardExecutionCheckpoint> {
    const validatedResult = decodeExecutionResult(input.result);
    if (!/^[a-f0-9]{64}$/.test(input.result_sha256) ||
        canonicalSha256(validatedResult) !== input.result_sha256) {
      throw new LoadRunControlError('execution_result_hash_mismatch', 409);
    }
    const encoded = JSON.stringify(validatedResult);
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) {
      throw new LoadRunControlError('execution_result_too_large', 413);
    }
    const result = await this.#pg.query<Row>(
      `UPDATE ivekit_capacity_load_shards
       SET execution_state = 'result_ready', execution_result = $6::jsonb,
           execution_result_sha256 = $7, updated_at = $8::timestamptz
       WHERE run_id = $1 AND phase_id = $2 AND shard_id = $3
         AND lease_owner = $4 AND lease_epoch = $5::bigint
         AND state = 'running' AND execution_state IN ('running', 'result_ready')
         AND lease_expires_at > $8::timestamptz
         AND (
           execution_state = 'running'
           OR (execution_result_sha256 = $7 AND execution_result = $6::jsonb)
         )
       RETURNING execution_state, execution_result, execution_result_sha256`,
      [
        input.run_id, input.phase_id, input.shard_id, input.worker_id,
        input.lease_epoch, encoded, input.result_sha256, input.now
      ]
    );
    if (!result.rows[0]) {
      throw new LoadRunControlError('stale_shard_lease', 409);
    }
    return decodeExecutionCheckpoint(result.rows[0]);
  }

  async completeShard(
    input: Parameters<CapacityLoadRunRepository['completeShard']>[0]
  ): Promise<void> {
    const result = await this.#pg.query(
      `WITH completed AS (
         UPDATE ivekit_capacity_load_shards shard
         SET state = $6, evidence_id = $7, error_code = $8,
             completed_at = $9::timestamptz, updated_at = $9::timestamptz
         FROM ivekit_capacity_load_workers worker
         WHERE shard.run_id = $1 AND shard.phase_id = $2 AND shard.shard_id = $3
           AND shard.lease_owner = $4 AND shard.lease_epoch = $5::bigint
           AND shard.state IN ('leased', 'running')
           AND shard.lease_expires_at > $9::timestamptz
           AND worker.run_id = shard.run_id AND worker.worker_id = shard.lease_owner
         AND (
           ($6 = 'completed' AND EXISTS (
             SELECT 1 FROM ivekit_capacity_evidence evidence
             WHERE evidence.evidence_id = $7 AND evidence.run_id = $1
               AND evidence.phase_id = $2 AND evidence.shard_id = $3
               AND evidence.state = 'verified'
           ))
           OR ($6 <> 'completed' AND (
             $7 = '' OR EXISTS (
               SELECT 1 FROM ivekit_capacity_evidence evidence
               WHERE evidence.evidence_id = $7 AND evidence.run_id = $1
                 AND evidence.phase_id = $2 AND evidence.shard_id = $3
                 AND evidence.state IN ('verified', 'rejected', 'not_run')
             )
           ))
         )
         RETURNING shard.shard_id, shard.lease_owner, shard.expected_count
       ), released_worker AS (
         UPDATE ivekit_capacity_load_workers worker
         SET assigned_load = GREATEST(0, worker.assigned_load - completed.expected_count),
             updated_at = $9::timestamptz
         FROM completed
         WHERE worker.run_id = $1 AND worker.worker_id = completed.lease_owner
         RETURNING worker.worker_id
       )
       SELECT completed.shard_id FROM completed, released_worker`,
      [
        input.run_id, input.phase_id, input.shard_id, input.worker_id, input.lease_epoch,
        input.outcome, input.evidence_id, input.error_code, input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('stale_shard_lease', 409);
  }

  async completePhase(
    input: Parameters<CapacityLoadRunRepository['completePhase']>[0]
  ): Promise<void> {
    const result = await this.#pg.query(
      `WITH fenced_run AS (
         SELECT run_id FROM ivekit_capacity_load_runs
         WHERE run_id = $1 AND controller_id = $3
           AND controller_lease_epoch = $4::bigint
           AND controller_lease_expires_at > $6::timestamptz
         FOR UPDATE
       )
       UPDATE ivekit_capacity_load_phases phase
       SET state = $5, completed_at = $6::timestamptz, updated_at = $6::timestamptz
       FROM fenced_run
       WHERE phase.run_id = $1 AND phase.phase_id = $2 AND phase.state = 'running'
         AND NOT EXISTS (
           SELECT 1 FROM ivekit_capacity_load_shards shard
           WHERE shard.run_id = phase.run_id AND shard.phase_id = phase.phase_id
             AND shard.state NOT IN ('completed', 'failed', 'cancelled', 'not_run')
         )
         AND (
           $5 <> 'completed' OR NOT EXISTS (
             SELECT 1 FROM ivekit_capacity_load_shards shard
             WHERE shard.run_id = phase.run_id AND shard.phase_id = phase.phase_id
               AND shard.state <> 'completed'
           )
         )
       RETURNING phase.phase_id`,
      [
        input.run_id, input.phase_id, input.controller_id,
        input.controller_lease_epoch, input.outcome, input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('phase_barrier_not_satisfied', 409);
  }

  async skipPendingPhases(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void> {
    const result = await this.#pg.query<Row>(
      `WITH fenced_run AS (
         SELECT run_id FROM ivekit_capacity_load_runs
         WHERE run_id = $1 AND controller_id = $2
           AND controller_lease_epoch = $3::bigint
           AND controller_lease_expires_at > $4::timestamptz
           AND state = 'running'
         FOR UPDATE
       ), skipped AS (
         UPDATE ivekit_capacity_load_phases phase
         SET state = 'skipped', completed_at = $4::timestamptz,
             updated_at = $4::timestamptz
         FROM fenced_run
         WHERE phase.run_id = fenced_run.run_id AND phase.state = 'pending'
         RETURNING phase.phase_id
       )
       SELECT EXISTS (SELECT 1 FROM fenced_run) AS fenced,
         (SELECT COUNT(*) FROM skipped)::integer AS skipped_count`,
      [
        input.run_id, input.controller_id,
        input.controller_lease_epoch, input.now
      ]
    );
    if (!result.rows[0]?.fenced) {
      throw new LoadRunControlError('stale_controller_lease', 409);
    }
  }

  async beginRunFinalization(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void> {
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_load_runs run
       SET state = 'finalizing', updated_at = $4::timestamptz
       WHERE run_id = $1 AND controller_id = $2
         AND controller_lease_epoch = $3::bigint
         AND controller_lease_expires_at > $4::timestamptz
         AND state = 'running'
         AND NOT EXISTS (
           SELECT 1 FROM ivekit_capacity_load_phases phase
           WHERE phase.run_id = run.run_id AND phase.state <> 'completed'
         )
       RETURNING run_id`,
      [
        input.run_id, input.controller_id,
        input.controller_lease_epoch, input.now
      ]
    );
    if (!result.rows[0]) {
      throw new LoadRunControlError('run_finalization_barrier_not_satisfied', 409);
    }
  }

  async finalizeRun(
    input: Parameters<CapacityLoadRunRepository['finalizeRun']>[0]
  ): Promise<void> {
    const state = input.outcome === 'passed'
      ? 'completed'
      : input.outcome === 'cancelled'
        ? 'cancelled'
        : input.outcome === 'not_run'
          ? 'not_run'
          : 'failed';
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_load_runs run
       SET state = $4, outcome = $5, evidence_manifest_sha256 = $6,
           failure_code = $7, completed_at = $8::timestamptz,
           updated_at = $8::timestamptz
       WHERE run_id = $1 AND controller_id = $2
         AND controller_lease_epoch = $3::bigint
         AND controller_lease_expires_at > $8::timestamptz
         AND state IN ('running', 'finalizing')
         AND (
           ($5 = 'passed'
             AND NOT EXISTS (
               SELECT 1 FROM ivekit_capacity_load_phases phase
               WHERE phase.run_id = run.run_id AND phase.state <> 'completed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM ivekit_capacity_evidence evidence
               WHERE evidence.run_id = run.run_id AND evidence.state <> 'verified'
             )
             AND EXISTS (
               SELECT 1 FROM ivekit_capacity_evidence evidence
               WHERE evidence.run_id = run.run_id
                 AND evidence.phase_id IS NULL AND evidence.shard_id IS NULL
                 AND evidence.kind = 'run_evidence_manifest'
                 AND evidence.state = 'verified'
                 AND evidence.sha256 = $6
             ))
           OR ($5 <> 'passed'
             AND NOT EXISTS (
               SELECT 1 FROM ivekit_capacity_load_phases phase
               WHERE phase.run_id = run.run_id
                 AND phase.state NOT IN ('completed', 'failed', 'skipped')
             )
             AND NOT EXISTS (
               SELECT 1 FROM ivekit_capacity_evidence evidence
               WHERE evidence.run_id = run.run_id
                 AND evidence.state NOT IN ('verified', 'rejected', 'not_run')
             ))
         )
       RETURNING run_id`,
      [
        input.run_id, input.controller_id, input.controller_lease_epoch,
        state, input.outcome, input.evidence_manifest_sha256,
        input.failure_code, input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('run_finalization_barrier_not_satisfied', 409);
  }

  async registerEvidence(
    input: Parameters<CapacityLoadRunRepository['registerEvidence']>[0]
  ): Promise<CapacityEvidenceRecord> {
    const result = await this.#pg.query<Row>(
      `INSERT INTO ivekit_capacity_evidence
         (evidence_id, run_id, phase_id, shard_id, kind, state, metadata,
          created_at, updated_at)
       SELECT $1, $2, NULLIF($3, ''), NULLIF($4, ''), $5, 'pending',
         $6::jsonb, $7::timestamptz, $7::timestamptz
       WHERE EXISTS (
         SELECT 1 FROM ivekit_capacity_load_runs
         WHERE run_id = $2 AND state NOT IN ('completed', 'failed', 'cancelled', 'not_run')
       )
         AND ($4 = '' OR $3 <> '')
         AND ($3 = '' OR EXISTS (
           SELECT 1 FROM ivekit_capacity_load_phases
           WHERE run_id = $2 AND phase_id = $3
         ))
         AND ($4 = '' OR EXISTS (
           SELECT 1 FROM ivekit_capacity_load_shards
           WHERE run_id = $2 AND shard_id = $4 AND ($3 = '' OR phase_id = $3)
         ))
       ON CONFLICT (evidence_id) DO UPDATE
       SET updated_at = EXCLUDED.updated_at
       WHERE ivekit_capacity_evidence.run_id = EXCLUDED.run_id
         AND ivekit_capacity_evidence.phase_id IS NOT DISTINCT FROM EXCLUDED.phase_id
         AND ivekit_capacity_evidence.shard_id IS NOT DISTINCT FROM EXCLUDED.shard_id
         AND ivekit_capacity_evidence.kind = EXCLUDED.kind
         AND ivekit_capacity_evidence.metadata = EXCLUDED.metadata
       RETURNING *`,
      [
        input.evidence_id, input.run_id, input.phase_id, input.shard_id,
        input.kind, JSON.stringify(input.metadata), input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('evidence_conflict', 409);
    return decodeEvidence(result.rows[0]);
  }

  async startEvidenceUpload(
    input: Parameters<CapacityLoadRunRepository['startEvidenceUpload']>[0]
  ): Promise<CapacityEvidenceRecord> {
    const result = await this.#pg.query<Row>(
      `UPDATE ivekit_capacity_evidence
       SET state = CASE WHEN state = 'pending' THEN 'uploading' ELSE state END,
           updated_at = $2::timestamptz
       WHERE evidence_id = $1
         AND state IN ('pending', 'uploading', 'uploaded', 'verified')
       RETURNING *`,
      [input.evidence_id, input.now]
    );
    if (!result.rows[0]) throw new LoadRunControlError('evidence_state_conflict', 409);
    return decodeEvidence(result.rows[0]);
  }

  async completeEvidenceUpload(
    input: Parameters<CapacityLoadRunRepository['completeEvidenceUpload']>[0]
  ): Promise<CapacityEvidenceRecord> {
    const result = await this.#pg.query<Row>(
      `UPDATE ivekit_capacity_evidence
       SET state = CASE WHEN state = 'uploading' THEN 'uploaded' ELSE state END,
           object_uri = CASE WHEN state = 'uploading' THEN $2 ELSE object_uri END,
           sha256 = CASE WHEN state = 'uploading' THEN $3 ELSE sha256 END,
           byte_size = CASE WHEN state = 'uploading' THEN $4 ELSE byte_size END,
           captured_at = CASE WHEN state = 'uploading' THEN $5::timestamptz ELSE captured_at END,
           updated_at = $6::timestamptz
       WHERE evidence_id = $1
         AND (
           state = 'uploading'
           OR (
             state IN ('uploaded', 'verified') AND object_uri = $2
             AND sha256 = $3 AND byte_size = $4
           )
         )
       RETURNING *`,
      [
        input.evidence_id, input.object_uri, input.sha256,
        input.byte_size, input.captured_at, input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('evidence_state_conflict', 409);
    return decodeEvidence(result.rows[0]);
  }

  async verifyEvidence(
    input: Parameters<CapacityLoadRunRepository['verifyEvidence']>[0]
  ): Promise<CapacityEvidenceRecord> {
    const result = await this.#pg.query<Row>(
      `UPDATE ivekit_capacity_evidence
       SET state = CASE
             WHEN state IN ('uploaded', 'pending', 'uploading') THEN $2
             ELSE state
           END,
           error_code = CASE
             WHEN state IN ('uploaded', 'pending', 'uploading') THEN $3
             ELSE error_code
           END,
           verified_at = CASE
             WHEN state IN ('uploaded', 'pending', 'uploading') THEN $4::timestamptz
             ELSE verified_at
           END,
           updated_at = $4::timestamptz
       WHERE evidence_id = $1
         AND (
           (state = 'uploaded' AND $2 IN ('verified', 'rejected'))
           OR (state IN ('pending', 'uploading') AND $2 = 'not_run')
           OR (state = $2 AND error_code = $3)
         )
       RETURNING *`,
      [input.evidence_id, input.outcome, input.error_code, input.now]
    );
    if (!result.rows[0]) throw new LoadRunControlError('evidence_state_conflict', 409);
    return decodeEvidence(result.rows[0]);
  }

  async claimCommands(
    input: Parameters<CapacityLoadRunRepository['claimCommands']>[0]
  ): Promise<CapacityCommandOutboxRecord[]> {
    const dispatchExpiresAt = expiresAt(input.now, input.lease_ttl_ms);
    const result = await this.#pg.query<Row>(
      `WITH selected AS (
         SELECT command_id FROM ivekit_capacity_command_outbox
         WHERE state = 'pending' AND available_at <= $1::timestamptz
           AND (dispatch_expires_at IS NULL OR dispatch_expires_at <= $1::timestamptz)
         ORDER BY available_at, command_id
         LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE ivekit_capacity_command_outbox command
       SET dispatcher_id = $3, dispatch_epoch = command.dispatch_epoch + 1,
           dispatch_expires_at = $4::timestamptz, attempt_count = command.attempt_count + 1,
           updated_at = $1::timestamptz
       FROM selected WHERE command.command_id = selected.command_id
       RETURNING command.command_id, command.subject, command.payload,
         command.dispatcher_id, command.dispatch_epoch::text AS dispatch_epoch`,
      [input.now, input.limit, input.dispatcher_id, dispatchExpiresAt]
    );
    return result.rows.map(decodeCommand);
  }

  async markCommandPublished(
    input: Parameters<CapacityLoadRunRepository['markCommandPublished']>[0]
  ): Promise<void> {
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_command_outbox
       SET state = 'published', published_at = $4::timestamptz,
           dispatch_expires_at = NULL, updated_at = $4::timestamptz
       WHERE command_id = $1 AND dispatcher_id = $2
         AND dispatch_epoch = $3::bigint AND state = 'pending'
         AND dispatch_expires_at > $4::timestamptz
       RETURNING command_id`,
      [input.command_id, input.dispatcher_id, input.dispatch_epoch, input.now]
    );
    if (!result.rows[0]) throw new LoadRunControlError('stale_dispatch_lease', 409);
  }

  async releaseCommand(
    input: Parameters<CapacityLoadRunRepository['releaseCommand']>[0]
  ): Promise<void> {
    const result = await this.#pg.query(
      `UPDATE ivekit_capacity_command_outbox
       SET dispatcher_id = NULL, dispatch_expires_at = NULL,
           available_at = $5::timestamptz + LEAST(attempt_count, 30) * INTERVAL '1 second',
           last_error_code = $4, updated_at = $5::timestamptz
       WHERE command_id = $1 AND dispatcher_id = $2
         AND dispatch_epoch = $3::bigint AND state = 'pending'
       RETURNING command_id`,
      [
        input.command_id, input.dispatcher_id, input.dispatch_epoch,
        input.error_code, input.now
      ]
    );
    if (!result.rows[0]) throw new LoadRunControlError('stale_dispatch_lease', 409);
  }
}

function decodeControllerLease(row: Row): CapacityControllerLease {
  return {
    run_id: String(row.run_id),
    controller_id: String(row.controller_id),
    lease_epoch: decimalEpoch(row.lease_epoch),
    lease_expires_at: iso(row.lease_expires_at)
  };
}

function decodeAssignment(row: Row): CapacityShardAssignment {
  return {
    run_id: String(row.run_id),
    phase_id: String(row.phase_id),
    shard_id: String(row.shard_id),
    worker_id: String(row.worker_id),
    fleet_id: String(row.fleet_id),
    lease_epoch: decimalEpoch(row.lease_epoch),
    lease_expires_at: iso(row.lease_expires_at),
    workload_domain: row.workload_domain === 'connection' ? 'connection' : 'interaction',
    workload_id: String(row.workload_id),
    workload_kind: String(row.workload_kind),
    ordinal_start: Number(row.ordinal_start),
    ordinal_end_exclusive: Number(row.ordinal_end_exclusive),
    expected_count: Number(row.expected_count),
    required_protocols: stringArray(row.required_protocols),
    seed: String(row.seed)
  };
}

function decodeCommand(row: Row): CapacityCommandOutboxRecord {
  const payload = jsonObject(row.payload) as unknown as CapacityStartShardCommand;
  if (payload.command_type !== 'start_shard' || payload.schema_version !== '1.0.0') {
    throw new LoadRunControlError('command_payload_invalid', 500);
  }
  if (String(row.command_id) !== payload.command_id) {
    throw new LoadRunControlError('command_payload_identity_mismatch', 500);
  }
  return {
    command_id: String(row.command_id),
    subject: String(row.subject),
    payload: structuredClone(payload),
    dispatcher_id: String(row.dispatcher_id),
    dispatch_epoch: decimalEpoch(row.dispatch_epoch)
  };
}

function decodeEvidence(row: Row): CapacityEvidenceRecord {
  return {
    evidence_id: String(row.evidence_id),
    run_id: String(row.run_id),
    phase_id: String(row.phase_id || ''),
    shard_id: String(row.shard_id || ''),
    kind: String(row.kind),
    state: evidenceState(row.state),
    object_uri: String(row.object_uri || ''),
    sha256: String(row.sha256 || ''),
    byte_size: Number(row.byte_size || 0),
    metadata: structuredClone(jsonObject(row.metadata || {})),
    error_code: String(row.error_code || ''),
    captured_at: optionalIso(row.captured_at),
    verified_at: optionalIso(row.verified_at)
  };
}

function decodeExecutionCheckpoint(row: Row): CapacityShardExecutionCheckpoint {
  const state = String(row.execution_state || '');
  if (state !== 'running' && state !== 'result_ready') {
    throw new LoadRunControlError('execution_checkpoint_invalid', 500);
  }
  if (state === 'running') {
    return { state, result: null, result_sha256: '' };
  }
  const result = decodeExecutionResult(row.execution_result);
  const resultSha256 = String(row.execution_result_sha256 || '');
  if (!/^[a-f0-9]{64}$/.test(resultSha256) ||
      canonicalSha256(result) !== resultSha256) {
    throw new LoadRunControlError('execution_checkpoint_invalid', 500);
  }
  return {
    state,
    result,
    result_sha256: resultSha256
  };
}

function decodeExecutionResult(value: unknown): CapacityShardExecutionResult {
  const result = jsonObject(value) as Partial<CapacityShardExecutionResult>;
  if (result.schema_version !== '1.0.0' ||
      !['completed', 'failed', 'cancelled', 'not_run'].includes(String(result.outcome)) ||
      typeof result.error_code !== 'string' ||
      typeof result.evidence_kind !== 'string' ||
      !result.evidence || typeof result.evidence !== 'object' ||
      Array.isArray(result.evidence)) {
    throw new LoadRunControlError('execution_result_invalid', 500);
  }
  return structuredClone(result) as CapacityShardExecutionResult;
}

function expiresAt(now: string, ttlMs: number): string {
  return new Date(Date.parse(now) + ttlMs).toISOString();
}

function commandSubject(fleetId: string, workerId: string): string {
  return `ivekit.capacity.command.${fleetId}.${workerId}`;
}

function decimalEpoch(value: unknown): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) {
    throw new LoadRunControlError('lease_epoch_invalid', 500);
  }
  return text;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new LoadRunControlError('timestamp_invalid', 500);
  return date.toISOString();
}

function optionalIso(value: unknown): string {
  return value == null || value === '' ? '' : iso(value);
}

function evidenceState(value: unknown): CapacityEvidenceRecord['state'] {
  const state = String(value);
  if (!['pending', 'uploading', 'uploaded', 'verified', 'rejected', 'not_run'].includes(state)) {
    throw new LoadRunControlError('evidence_state_invalid', 500);
  }
  return state as CapacityEvidenceRecord['state'];
}

function runState(value: unknown): 'planned' | 'ready' | 'running' |
  'finalizing' | 'completed' | 'failed' | 'cancelled' | 'not_run' {
  const state = String(value);
  if (![
    'planned', 'ready', 'running', 'finalizing',
    'completed', 'failed', 'cancelled', 'not_run'
  ].includes(state)) {
    throw new LoadRunControlError('run_state_invalid', 500);
  }
  return state as 'planned' | 'ready' | 'running' |
    'finalizing' | 'completed' | 'failed' | 'cancelled' | 'not_run';
}

function nonNegativeRowInteger(value: unknown, field: string): number {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new LoadRunControlError(`${field}_invalid`, 500);
  }
  return parsed;
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new LoadRunControlError('string_array_invalid', 500);
  }
  return [...parsed];
}

function jsonObject(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LoadRunControlError('json_object_invalid', 500);
  }
  return parsed as Record<string, unknown>;
}
