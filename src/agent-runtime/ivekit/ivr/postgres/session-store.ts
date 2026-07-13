import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { IvrError } from '../errors.js';
import type {
  IvrPendingActionClaimInput,
  IvrPendingActionReleaseInput,
  IvrPendingActionRepository,
  IvrSessionRepository,
  IvrSessionStepRepository
} from '../ports.js';
import type { IvrAction, IvrPendingAction, IvrSession, IvrSessionStep } from '../types.js';
import {
  jsonRecord,
  numberValue,
  requiredRow,
  timestamp,
  type IvrPgRow
} from './row-utils.js';

const SESSION_COLUMNS = `
  session.id, session.tenant_id, session.call_id, session.flow_id, session.flow_version,
  session.state, session.current_node_id, session.context, session.step_count, session.revision,
  session.waiting_reason, session.termination_reason, session.created_at, session.updated_at,
  session.completed_at, session.provider_profile_id, session.provider_session_id,
  session.last_event_sequence, session.last_event_payload_hash, session.last_action_revision,
  session.last_action, session.provider_metadata, session.trace_id`;

const ACTION_COLUMNS = `
  action.id, action.tenant_id, action.session_id, action.step_index, action.node_id,
  action.action_kind, action.state, action.dispatch_mode, action.idempotency_key,
  action.payload_hash, action.payload, action.result, action.attempt_count, action.max_attempts,
  action.next_attempt_at, action.lease_until, action.worker_id, action.provider_profile_id,
  action.provider_action_id, action.error_code, action.error_message, action.trace_id,
  action.reconciliation_count, action.created_at, action.updated_at, action.completed_at`;

export class PostgresIvrSessionStore implements IvrSessionRepository {
  constructor(private readonly pg: PgQueryable) {}

  get(tenantId: string, sessionId: string, options: { for_update?: boolean } = {}): Promise<IvrSession | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${SESSION_COLUMNS}
         FROM ivekit_ivr_sessions session
         WHERE session.tenant_id = $1 AND session.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, sessionId]
      );
      return result.rows[0] ? decodeSession(result.rows[0]) : null;
    });
  }

  findByProviderBinding(
    tenantId: string,
    profileId: string,
    providerSessionId: string,
    options: { for_update?: boolean } = {}
  ): Promise<IvrSession | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${SESSION_COLUMNS}
         FROM ivekit_ivr_sessions session
         WHERE session.tenant_id = $1 AND session.provider_profile_id = $2
           AND session.provider_session_id = $3
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, profileId, providerSessionId]
      );
      return result.rows[0] ? decodeSession(result.rows[0]) : null;
    });
  }

  insert(session: IvrSession): Promise<IvrSession> {
    return withPgTenant(this.pg, session.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `INSERT INTO ivekit_ivr_sessions
          (id, tenant_id, call_id, flow_id, flow_version, state, current_node_id,
           context, step_count, revision, waiting_reason, termination_reason,
           created_at, updated_at, completed_at, provider_profile_id, provider_session_id,
           last_event_sequence, last_event_payload_hash, last_action_revision, last_action,
           provider_metadata, trace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
                 $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23)
         RETURNING *`,
        sessionParams(session)
      );
      return decodeSession(requiredRow(result.rows[0], 'not_found'));
    });
  }

  update(session: IvrSession, expectedRevision: number): Promise<IvrSession> {
    return withPgTenant(this.pg, session.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `UPDATE ivekit_ivr_sessions
         SET state = $3, current_node_id = $4, context = $5::jsonb, step_count = $6,
             revision = $7, waiting_reason = $8, termination_reason = $9,
             updated_at = $10, completed_at = $11, last_event_sequence = $12,
             last_event_payload_hash = $13, last_action_revision = $14,
             last_action = $15::jsonb, provider_metadata = $16::jsonb, trace_id = $17
         WHERE tenant_id = $1 AND id = $2 AND revision = $18
         RETURNING *`,
        [
          session.tenant_id, session.id, session.state, session.current_node_id,
          JSON.stringify(session.context), session.step_count, session.revision,
          session.waiting_reason, session.termination_reason, session.updated_at,
          session.completed_at, session.last_event_sequence, session.last_event_payload_hash,
          session.last_action_revision, JSON.stringify(session.last_action),
          JSON.stringify(session.provider_metadata), session.trace_id, expectedRevision
        ]
      );
      return decodeSession(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }
}

export class PostgresIvrSessionStepStore implements IvrSessionStepRepository {
  constructor(private readonly pg: PgQueryable) {}

  append(step: IvrSessionStep): Promise<void> {
    return withPgTenant(this.pg, step.tenant_id, async (pg) => {
      await pg.query(
        `INSERT INTO ivekit_ivr_session_steps
          (id, tenant_id, session_id, step_index, flow_id, flow_version, node_id, action,
           branch_taken, duration_ms, error_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
        [
          step.id, step.tenant_id, step.session_id, step.step_index,
          step.flow_id, step.flow_version, step.node_id,
          JSON.stringify(step.action), step.branch_taken, step.duration_ms,
          step.error_code, step.created_at
        ]
      );
    });
  }

  list(tenantId: string, sessionId: string): Promise<IvrSessionStep[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT step.* FROM ivekit_ivr_session_steps step
         WHERE step.tenant_id = $1 AND step.session_id = $2
         ORDER BY step.step_index`,
        [tenantId, sessionId]
      );
      return result.rows.map(decodeStep);
    });
  }
}

export class PostgresIvrPendingActionStore implements IvrPendingActionRepository {
  constructor(private readonly pg: PgQueryable) {}

  get(tenantId: string, actionId: string, options: { for_update?: boolean } = {}): Promise<IvrPendingAction | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${ACTION_COLUMNS}
         FROM ivekit_ivr_pending_actions action
         WHERE action.tenant_id = $1 AND action.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, actionId]
      );
      return result.rows[0] ? decodeAction(result.rows[0]) : null;
    });
  }

  claimDue(input: IvrPendingActionClaimInput): Promise<IvrPendingAction[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedInteger(input.limit, 50, 1, 200);
      const leaseMs = boundedInteger(input.lease_ms, 30_000, 1_000, 300_000);
      const now = timestamp(input.now);
      const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
      const result = await pg.query<IvrPgRow>(
        `WITH candidate AS (
           SELECT action.id
           FROM ivekit_ivr_pending_actions action
           WHERE action.tenant_id = $1 AND action.dispatch_mode = 'worker'
             AND action.attempt_count < action.max_attempts
             AND (
               action.state = 'pending'
               OR (action.state = 'retry_wait'
                 AND (action.next_attempt_at IS NULL OR action.next_attempt_at <= $2))
               OR (action.state = 'processing' AND action.lease_until <= $2)
             )
           ORDER BY COALESCE(action.next_attempt_at, action.created_at), action.id
           FOR UPDATE SKIP LOCKED
           LIMIT $5
         )
         UPDATE ivekit_ivr_pending_actions action
         SET state = 'processing', worker_id = $3, lease_until = $4,
             attempt_count = action.attempt_count + 1, updated_at = $2
         FROM candidate
         WHERE action.tenant_id = $1 AND action.id = candidate.id
         RETURNING action.*`,
        [input.tenant_id, now, input.worker_id, leaseUntil, limit]
      );
      return result.rows.map(decodeAction);
    });
  }

  claimUncertain(input: IvrPendingActionClaimInput): Promise<IvrPendingAction[]> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedInteger(input.limit, 50, 1, 200);
      const leaseMs = boundedInteger(input.lease_ms, 30_000, 1_000, 300_000);
      const now = timestamp(input.now);
      const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
      const result = await pg.query<IvrPgRow>(
        `WITH candidate AS (
           SELECT action.id
           FROM ivekit_ivr_pending_actions action
           WHERE action.tenant_id = $1 AND action.dispatch_mode = 'worker'
             AND action.state = 'uncertain'
             AND (action.next_attempt_at IS NULL OR action.next_attempt_at <= $2)
             AND (action.lease_until IS NULL OR action.lease_until <= $2)
           ORDER BY COALESCE(action.next_attempt_at, action.created_at), action.id
           FOR UPDATE SKIP LOCKED
           LIMIT $5
         )
         UPDATE ivekit_ivr_pending_actions action
         SET worker_id = $3, lease_until = $4,
             reconciliation_count = action.reconciliation_count + 1, updated_at = $2
         FROM candidate
         WHERE action.tenant_id = $1 AND action.id = candidate.id
         RETURNING action.*`,
        [input.tenant_id, now, input.worker_id, leaseUntil, limit]
      );
      return result.rows.map(decodeAction);
    });
  }

  findOpenForSession(tenantId: string, sessionId: string): Promise<IvrPendingAction | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `SELECT ${ACTION_COLUMNS}
         FROM ivekit_ivr_pending_actions action
         WHERE action.tenant_id = $1 AND action.session_id = $2
           AND action.state IN ('pending', 'processing', 'retry_wait', 'uncertain')
         ORDER BY action.step_index DESC
         LIMIT 1
         FOR UPDATE`,
        [tenantId, sessionId]
      );
      return result.rows[0] ? decodeAction(result.rows[0]) : null;
    });
  }

  insert(action: IvrPendingAction): Promise<IvrPendingAction> {
    return withPgTenant(this.pg, action.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `INSERT INTO ivekit_ivr_pending_actions
          (id, tenant_id, session_id, step_index, node_id, action_kind, state,
           dispatch_mode, idempotency_key, payload_hash, payload, result, attempt_count,
           max_attempts, next_attempt_at, lease_until, worker_id, provider_profile_id,
           provider_action_id, error_code, error_message, trace_id, reconciliation_count,
           created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
                 $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         RETURNING *`,
        actionParams(action)
      );
      return decodeAction(requiredRow(result.rows[0], 'not_found'));
    });
  }

  settle(input: {
    tenant_id: string;
    action_id: string;
    worker_id?: string;
    state: 'succeeded' | 'failed' | 'cancelled';
    result: Record<string, unknown>;
    error_code: string;
    completed_at: string;
  }): Promise<IvrPendingAction> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `UPDATE ivekit_ivr_pending_actions action
         SET state = $3, result = $4::jsonb, error_code = $5, error_message = '',
             worker_id = '', lease_until = NULL, next_attempt_at = NULL,
             updated_at = $6, completed_at = $6
         WHERE action.tenant_id = $1 AND action.id = $2
           AND ($7 = '' OR action.worker_id = $7)
           AND action.state IN ('pending', 'processing', 'retry_wait', 'uncertain')
         RETURNING action.*`,
        [
          input.tenant_id, input.action_id, input.state, JSON.stringify(input.result),
          input.error_code, input.completed_at, input.worker_id ?? ''
        ]
      );
      return decodeAction(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  release(input: IvrPendingActionReleaseInput): Promise<IvrPendingAction> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<IvrPgRow>(
        `UPDATE ivekit_ivr_pending_actions action
         SET state = $4, next_attempt_at = $5, error_code = $6, error_message = $7,
             worker_id = '', lease_until = NULL, updated_at = $8,
             completed_at = CASE WHEN $4 = 'failed' THEN $8::timestamptz ELSE NULL END
         WHERE action.tenant_id = $1 AND action.id = $2 AND action.worker_id = $3
           AND (
             action.state = 'processing'
             OR (action.state = 'uncertain' AND $4 IN ('uncertain', 'failed'))
           )
         RETURNING action.*`,
        [
          input.tenant_id, input.action_id, input.worker_id, input.state,
          input.next_attempt_at, input.error_code, input.error_message, timestamp(input.now)
        ]
      );
      if (!result.rows[0]) throw new IvrError({ code: 'lease_lost', status: 409 });
      return decodeAction(result.rows[0]);
    });
  }
}

function sessionParams(session: IvrSession): unknown[] {
  return [
    session.id, session.tenant_id, session.call_id, session.flow_id, session.flow_version,
    session.state, session.current_node_id, JSON.stringify(session.context), session.step_count,
    session.revision, session.waiting_reason, session.termination_reason, session.created_at,
    session.updated_at, session.completed_at, session.provider_profile_id, session.provider_session_id,
    session.last_event_sequence, session.last_event_payload_hash, session.last_action_revision,
    JSON.stringify(session.last_action), JSON.stringify(session.provider_metadata), session.trace_id
  ];
}

function actionParams(action: IvrPendingAction): unknown[] {
  return [
    action.id, action.tenant_id, action.session_id, action.step_index, action.node_id,
    action.action_kind, action.state, action.dispatch_mode, action.idempotency_key,
    action.payload_hash, JSON.stringify(action.payload), JSON.stringify(action.result),
    action.attempt_count, action.max_attempts, action.next_attempt_at, action.lease_until,
    action.worker_id, action.provider_profile_id, action.provider_action_id, action.error_code,
    action.error_message, action.trace_id, action.reconciliation_count, action.created_at,
    action.updated_at, action.completed_at
  ];
}

function decodeSession(row: IvrPgRow): IvrSession {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), call_id: String(row.call_id),
    flow_id: String(row.flow_id), flow_version: numberValue(row.flow_version),
    state: row.state as IvrSession['state'], current_node_id: String(row.current_node_id),
    context: jsonRecord(row.context), step_count: numberValue(row.step_count), revision: numberValue(row.revision),
    waiting_reason: String(row.waiting_reason ?? ''), termination_reason: String(row.termination_reason ?? ''),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at),
    provider_profile_id: nullableString(row.provider_profile_id),
    provider_session_id: nullableString(row.provider_session_id),
    last_event_sequence: numberValue(row.last_event_sequence),
    last_event_payload_hash: String(row.last_event_payload_hash ?? ''),
    last_action_revision: numberValue(row.last_action_revision), last_action: jsonRecord(row.last_action),
    provider_metadata: jsonRecord(row.provider_metadata), trace_id: String(row.trace_id ?? '')
  };
}

function decodeStep(row: IvrPgRow): IvrSessionStep {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), session_id: String(row.session_id),
    step_index: numberValue(row.step_index), flow_id: String(row.flow_id),
    flow_version: numberValue(row.flow_version), node_id: String(row.node_id),
    action: jsonRecord(row.action) as unknown as IvrAction,
    branch_taken: String(row.branch_taken ?? ''), duration_ms: numberValue(row.duration_ms),
    error_code: String(row.error_code ?? ''), created_at: timestamp(row.created_at)
  };
}

function decodeAction(row: IvrPgRow): IvrPendingAction {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), session_id: String(row.session_id),
    step_index: numberValue(row.step_index), node_id: String(row.node_id),
    action_kind: row.action_kind as IvrPendingAction['action_kind'],
    state: row.state as IvrPendingAction['state'], dispatch_mode: row.dispatch_mode as IvrPendingAction['dispatch_mode'],
    idempotency_key: String(row.idempotency_key), payload_hash: String(row.payload_hash),
    payload: jsonRecord(row.payload), result: jsonRecord(row.result), attempt_count: numberValue(row.attempt_count),
    max_attempts: numberValue(row.max_attempts), next_attempt_at: nullableTimestamp(row.next_attempt_at),
    lease_until: nullableTimestamp(row.lease_until), worker_id: String(row.worker_id ?? ''),
    provider_profile_id: String(row.provider_profile_id ?? ''), provider_action_id: String(row.provider_action_id ?? ''),
    error_code: String(row.error_code ?? ''), error_message: String(row.error_message ?? ''),
    trace_id: String(row.trace_id ?? ''), reconciliation_count: numberValue(row.reconciliation_count),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function nullableTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : timestamp(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function boundedInteger(value: number, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
