import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { canonicalContactCenterPayloadHash } from '../canonical.js';
import { ContactCenterError } from '../errors.js';
import type { ContactCenterRepository } from '../ports.js';
import type {
  ContactCenterAgentPresence,
  ContactCenterAssignment,
  ContactCenterCallbackListInput,
  ContactCenterCallbackRecord,
  ContactCenterOverflowAction,
  ContactCenterPage,
  ContactCenterQueue,
  ContactCenterQueueEntry,
  ContactCenterQueueEntryListInput,
  ContactCenterRoutingCandidate,
  ContactCenterSupervisorSession
} from '../types.js';
import {
  ccJsonRecord,
  ccNullableTimestamp,
  ccNumber,
  ccRequiredRow,
  ccTimestamp,
  type ContactCenterPgRow
} from './row-utils.js';

const QUEUE_COLUMNS = `
  queue.id, queue.tenant_id, queue.name, queue.routing_strategy,
  queue.max_wait_seconds, queue.max_size, queue.callback_after_seconds,
  queue.overflow_action, queue.overflow_queue_id, queue.overflow_target,
  queue.service_level_seconds, queue.status, queue.metadata, queue.revision,
  queue.created_by, queue.updated_by, queue.created_at, queue.updated_at`;

const ENTRY_COLUMNS = `
  entry.id, entry.tenant_id, entry.queue_id, entry.call_id, entry.state,
  entry.priority, entry.idempotency_key, entry.payload_hash, entry.entered_at,
  entry.offered_at, entry.assigned_at, entry.answered_at, entry.ended_at,
  entry.timeout_at, entry.outcome_reason, entry.metadata, entry.revision,
  entry.created_at, entry.updated_at`;

const ASSIGNMENT_COLUMNS = `
  assignment.id, assignment.tenant_id, assignment.queue_entry_id,
  assignment.agent_id, assignment.capacity_slot, assignment.state,
  assignment.attempt, assignment.idempotency_key, assignment.offer_expires_at,
  assignment.accepted_at, assignment.connected_at, assignment.completed_at,
  assignment.outcome_reason, assignment.revision, assignment.created_at,
  assignment.updated_at`;

const PRESENCE_COLUMNS = `
  presence.tenant_id, presence.agent_id, presence.state,
  presence.active_voice_count, presence.voice_capacity, presence.current_call_id,
  presence.idle_since, presence.heartbeat_at, presence.session_ref,
  presence.revision, presence.updated_at`;

const CALLBACK_COLUMNS = `
  callback.id, callback.tenant_id, callback.queue_id, callback.queue_entry_id,
  callback.source_call_id, callback.outbound_call_id,
  callback.business_ref_type, callback.business_ref_id,
  callback.address_kind, callback.address_ciphertext, callback.address_hmac,
  callback.address_redacted, callback.state, callback.scheduled_for,
  callback.attempt_count, callback.max_attempts, callback.idempotency_key,
  callback.requested_by, callback.cancelled_by, callback.failure_code,
  callback.revision, callback.created_at,
  callback.updated_at, callback.completed_at`;

const SUPERVISOR_COLUMNS = `
  supervisor.id, supervisor.tenant_id, supervisor.call_id,
  supervisor.target_agent_id, supervisor.supervisor_identity,
  supervisor.mode, supervisor.state, supervisor.authorization_ref,
  supervisor.idempotency_key, supervisor.provider_session_id,
  supervisor.reason, supervisor.requested_at, supervisor.started_at,
  supervisor.ended_at, supervisor.revision, supervisor.created_at,
  supervisor.updated_at`;

const OVERFLOW_COLUMNS = `
  overflow.id, overflow.tenant_id, overflow.source_entry_id,
  overflow.source_queue_id, overflow.call_id, overflow.priority, overflow.action,
  overflow.target_queue_id, overflow.target, overflow.state,
  overflow.idempotency_key, overflow.attempt_count, overflow.max_attempts,
  overflow.scheduled_for, overflow.result_ref, overflow.error_code,
  overflow.revision, overflow.created_at, overflow.updated_at,
  overflow.completed_at`;

export class PostgresContactCenterRepository implements ContactCenterRepository {
  constructor(private readonly pg: PgQueryable) {}

  getQueue(tenantId: string, queueId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterQueue | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${QUEUE_COLUMNS}
         FROM ivekit_cc_queues queue
         WHERE queue.tenant_id = $1 AND queue.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, queueId]
      );
      return result.rows[0] ? decodeQueue(result.rows[0]) : null;
    });
  }

  findEntryByIdempotencyKey(tenantId: string, key: string): Promise<ContactCenterQueueEntry | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM ivekit_cc_queue_entries entry
         WHERE entry.tenant_id = $1 AND entry.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeEntry(result.rows[0]) : null;
    });
  }

  countActiveEntries(tenantId: string, queueId: string): Promise<number> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT count(*)::integer AS count
         FROM ivekit_cc_queue_entries
         WHERE tenant_id = $1 AND queue_id = $2
           AND state IN ('waiting', 'offered', 'assigned', 'answered')`,
        [tenantId, queueId]
      );
      return ccNumber(result.rows[0]?.count ?? 0);
    });
  }

  insertEntry(entry: ContactCenterQueueEntry): Promise<ContactCenterQueueEntry> {
    return withPgTenant(this.pg, entry.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_queue_entries
          (id, tenant_id, queue_id, call_id, state, priority, idempotency_key,
           payload_hash, entered_at, offered_at, assigned_at, answered_at,
           ended_at, timeout_at, outcome_reason, metadata, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16::jsonb, $17, $18, $19)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        entryParameters(entry)
      );
      if (result.rows[0]) return decodeEntry(result.rows[0]);
      const replay = await this.findEntryByIdempotencyKey(entry.tenant_id, entry.idempotency_key);
      if (!replay || replay.payload_hash !== entry.payload_hash) throw conflict();
      return replay;
    });
  }

  getEntry(tenantId: string, entryId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterQueueEntry | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM ivekit_cc_queue_entries entry
         WHERE entry.tenant_id = $1 AND entry.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, entryId]
      );
      return result.rows[0] ? decodeEntry(result.rows[0]) : null;
    });
  }

  listEntries(
    input: ContactCenterQueueEntryListInput
  ): Promise<ContactCenterPage<ContactCenterQueueEntry>> {
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const scope = canonicalContactCenterPayloadHash({
      tenant_id: input.tenant_id,
      queue_id: input.queue_id,
      state: input.state ?? ''
    });
    const cursor = decodeEntryCursor(input.cursor, scope);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM ivekit_cc_queue_entries entry
         WHERE entry.tenant_id = $1 AND entry.queue_id = $2
           AND ($3 = '' OR entry.state = $3)
           AND (entry.entered_at, entry.id) < ($4::timestamptz, $5::text)
         ORDER BY entry.entered_at DESC, entry.id DESC
         LIMIT $6`,
        [
          input.tenant_id,
          input.queue_id,
          input.state ?? '',
          cursor.entered_at,
          cursor.id,
          limit + 1
        ]
      );
      return entryPage(result.rows.map(decodeEntry), limit, scope);
    });
  }

  listAssignmentsForEntries(
    tenantId: string,
    entryIds: string[]
  ): Promise<ContactCenterAssignment[]> {
    if (entryIds.length === 0) return Promise.resolve([]);
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM ivekit_cc_assignments assignment
         WHERE assignment.tenant_id = $1
           AND assignment.queue_entry_id = ANY($2::text[])
         ORDER BY assignment.queue_entry_id, assignment.attempt, assignment.id`,
        [tenantId, entryIds]
      );
      return result.rows.map(decodeAssignment);
    });
  }

  getNextWaitingEntry(tenantId: string, queueId: string): Promise<ContactCenterQueueEntry | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM ivekit_cc_queue_entries entry
         WHERE entry.tenant_id = $1 AND entry.queue_id = $2
           AND entry.state = 'waiting'
           AND (entry.timeout_at IS NULL OR entry.timeout_at > CURRENT_TIMESTAMP)
         ORDER BY entry.priority DESC, entry.entered_at, entry.id
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [tenantId, queueId]
      );
      return result.rows[0] ? decodeEntry(result.rows[0]) : null;
    });
  }

  updateEntry(entry: ContactCenterQueueEntry, expectedRevision: number): Promise<ContactCenterQueueEntry> {
    return withPgTenant(this.pg, entry.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_queue_entries
         SET state = $3, offered_at = $4, assigned_at = $5, answered_at = $6,
             ended_at = $7, timeout_at = $8, outcome_reason = $9,
             metadata = $10::jsonb, revision = revision + 1, updated_at = $11
         WHERE tenant_id = $1 AND id = $2 AND revision = $12
         RETURNING *`,
        [
          entry.tenant_id, entry.id, entry.state, entry.offered_at, entry.assigned_at,
          entry.answered_at, entry.ended_at, entry.timeout_at, entry.outcome_reason,
          JSON.stringify(entry.metadata), entry.updated_at, expectedRevision
        ]
      );
      return decodeEntry(ccRequiredRow(result.rows[0], 'conflict'));
    });
  }

  positionOfEntry(tenantId: string, queueId: string, entryId: string): Promise<number | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `WITH ranked AS (
           SELECT id, row_number() OVER (
             ORDER BY priority DESC, entered_at, id
           )::integer AS position
           FROM ivekit_cc_queue_entries
           WHERE tenant_id = $1 AND queue_id = $2 AND state IN ('waiting', 'offered')
         )
         SELECT position FROM ranked WHERE id = $3`,
        [tenantId, queueId, entryId]
      );
      return result.rows[0] ? ccNumber(result.rows[0].position) : null;
    });
  }

  averageHandleSeconds(tenantId: string, queueId: string): Promise<number> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT COALESCE(avg(extract(epoch FROM (ended_at - answered_at))), 60)::float AS seconds
         FROM (
           SELECT answered_at, ended_at
           FROM ivekit_cc_queue_entries
           WHERE tenant_id = $1 AND queue_id = $2 AND state = 'completed'
             AND answered_at IS NOT NULL AND ended_at IS NOT NULL
           ORDER BY ended_at DESC LIMIT 100
         ) recent`,
        [tenantId, queueId]
      );
      return Math.max(1, ccNumber(result.rows[0]?.seconds ?? 60));
    });
  }

  listRoutingCandidates(tenantId: string, queueId: string): Promise<ContactCenterRoutingCandidate[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT membership.agent_id, presence.state AS presence_state,
                presence.active_voice_count, presence.voice_capacity,
                presence.idle_since, membership.priority AS member_priority,
                COALESCE((
                  SELECT jsonb_object_agg(agent_skill.skill_id, agent_skill.proficiency)
                  FROM ivekit_cc_agent_skills agent_skill
                  WHERE agent_skill.tenant_id = membership.tenant_id
                    AND agent_skill.agent_id = membership.agent_id
                ), '{}'::jsonb) AS skills,
                (SELECT count(*)::integer FROM ivekit_cc_assignments handled
                 WHERE handled.tenant_id = membership.tenant_id
                   AND handled.agent_id = membership.agent_id
                   AND handled.state = 'completed') AS handled_count
         FROM ivekit_cc_queue_memberships membership
         JOIN ivekit_cc_agents agent
           ON agent.tenant_id = membership.tenant_id AND agent.id = membership.agent_id
         JOIN ivekit_cc_agent_presence presence
           ON presence.tenant_id = membership.tenant_id AND presence.agent_id = membership.agent_id
         WHERE membership.tenant_id = $1 AND membership.queue_id = $2
           AND membership.enabled = TRUE AND agent.status = 'active'
           AND presence.state IN ('available', 'busy')
           AND presence.active_voice_count < presence.voice_capacity
           AND NOT EXISTS (
             SELECT 1 FROM ivekit_cc_queue_skill_requirements requirement
             LEFT JOIN ivekit_cc_agent_skills required_skill
               ON required_skill.tenant_id = requirement.tenant_id
              AND required_skill.agent_id = membership.agent_id
              AND required_skill.skill_id = requirement.skill_id
             WHERE requirement.tenant_id = membership.tenant_id
               AND requirement.queue_id = membership.queue_id
               AND (required_skill.agent_id IS NULL
                 OR required_skill.proficiency < requirement.minimum_proficiency)
           )
         ORDER BY membership.agent_id
         FOR UPDATE OF presence SKIP LOCKED`,
        [tenantId, queueId]
      );
      return result.rows.map(decodeCandidate);
    });
  }

  getRoutingCursor(tenantId: string, queueId: string): Promise<string | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT last_agent_id FROM ivekit_cc_routing_cursors
         WHERE tenant_id = $1 AND queue_id = $2 FOR UPDATE`,
        [tenantId, queueId]
      );
      return result.rows[0]?.last_agent_id ? String(result.rows[0].last_agent_id) : null;
    });
  }

  setRoutingCursor(tenantId: string, queueId: string, agentId: string): Promise<void> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `INSERT INTO ivekit_cc_routing_cursors
          (tenant_id, queue_id, last_agent_id, sequence, revision, updated_at)
         VALUES ($1, $2, $3, 1, 1, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, queue_id) DO UPDATE
         SET last_agent_id = EXCLUDED.last_agent_id,
             sequence = ivekit_cc_routing_cursors.sequence + 1,
             revision = ivekit_cc_routing_cursors.revision + 1,
             updated_at = CURRENT_TIMESTAMP`,
        [tenantId, queueId, agentId]
      );
    });
  }

  nextCapacitySlot(tenantId: string, agentId: string): Promise<number | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT slot::integer
         FROM ivekit_cc_agent_presence presence
         CROSS JOIN LATERAL generate_series(1, presence.voice_capacity) slot
         WHERE presence.tenant_id = $1 AND presence.agent_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM ivekit_cc_assignments assignment
             WHERE assignment.tenant_id = presence.tenant_id
               AND assignment.agent_id = presence.agent_id
               AND assignment.capacity_slot = slot
               AND assignment.state IN ('offered', 'accepted', 'connected')
           )
         ORDER BY slot LIMIT 1`,
        [tenantId, agentId]
      );
      return result.rows[0] ? ccNumber(result.rows[0].slot) : null;
    });
  }

  nextAssignmentAttempt(tenantId: string, queueEntryId: string): Promise<number> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT COALESCE(max(attempt), 0)::integer + 1 AS attempt
         FROM ivekit_cc_assignments
         WHERE tenant_id = $1 AND queue_entry_id = $2`,
        [tenantId, queueEntryId]
      );
      return ccNumber(result.rows[0]?.attempt ?? 1);
    });
  }

  insertAssignment(assignment: ContactCenterAssignment): Promise<ContactCenterAssignment> {
    return withPgTenant(this.pg, assignment.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_assignments
          (id, tenant_id, queue_entry_id, agent_id, capacity_slot, state, attempt,
           idempotency_key, offer_expires_at, accepted_at, connected_at, completed_at,
           outcome_reason, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        assignmentParameters(assignment)
      );
      if (result.rows[0]) return decodeAssignment(result.rows[0]);
      const replay = await this.findAssignmentByIdempotencyKey(assignment.tenant_id, assignment.idempotency_key);
      if (!replay || replay.queue_entry_id !== assignment.queue_entry_id || replay.agent_id !== assignment.agent_id) {
        throw conflict();
      }
      return replay;
    });
  }

  findAssignmentByIdempotencyKey(tenantId: string, key: string): Promise<ContactCenterAssignment | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM ivekit_cc_assignments assignment
         WHERE assignment.tenant_id = $1 AND assignment.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeAssignment(result.rows[0]) : null;
    });
  }

  getAssignment(tenantId: string, assignmentId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterAssignment | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM ivekit_cc_assignments assignment
         WHERE assignment.tenant_id = $1 AND assignment.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, assignmentId]
      );
      return result.rows[0] ? decodeAssignment(result.rows[0]) : null;
    });
  }

  getActiveAssignmentForEntry(
    tenantId: string,
    queueEntryId: string,
    options: { for_update?: boolean } = {}
  ): Promise<ContactCenterAssignment | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM ivekit_cc_assignments assignment
         WHERE assignment.tenant_id = $1 AND assignment.queue_entry_id = $2
           AND assignment.state IN ('offered', 'accepted', 'connected')
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, queueEntryId]
      );
      return result.rows[0] ? decodeAssignment(result.rows[0]) : null;
    });
  }

  updateAssignment(assignment: ContactCenterAssignment, expectedRevision: number): Promise<ContactCenterAssignment> {
    return withPgTenant(this.pg, assignment.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_assignments
         SET state = $3, accepted_at = $4, connected_at = $5, completed_at = $6,
             outcome_reason = $7, revision = revision + 1, updated_at = $8
         WHERE tenant_id = $1 AND id = $2 AND revision = $9
         RETURNING *`,
        [
          assignment.tenant_id, assignment.id, assignment.state, assignment.accepted_at,
          assignment.connected_at, assignment.completed_at, assignment.outcome_reason,
          assignment.updated_at, expectedRevision
        ]
      );
      return decodeAssignment(ccRequiredRow(result.rows[0], 'conflict'));
    });
  }

  getPresence(tenantId: string, agentId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterAgentPresence | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${PRESENCE_COLUMNS}
         FROM ivekit_cc_agent_presence presence
         WHERE presence.tenant_id = $1 AND presence.agent_id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, agentId]
      );
      return result.rows[0] ? decodePresence(result.rows[0]) : null;
    });
  }

  updatePresence(presence: ContactCenterAgentPresence, expectedRevision: number): Promise<ContactCenterAgentPresence> {
    return withPgTenant(this.pg, presence.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_agent_presence
         SET state = $3, active_voice_count = $4, voice_capacity = $5,
             current_call_id = $6, idle_since = $7, heartbeat_at = $8,
             session_ref = $9, revision = revision + 1, updated_at = $10
         WHERE tenant_id = $1 AND agent_id = $2 AND revision = $11
         RETURNING *`,
        [
          presence.tenant_id, presence.agent_id, presence.state,
          presence.active_voice_count, presence.voice_capacity, presence.current_call_id,
          presence.idle_since, presence.heartbeat_at, presence.session_ref,
          presence.updated_at, expectedRevision
        ]
      );
      return decodePresence(ccRequiredRow(result.rows[0], 'conflict'));
    });
  }

  findCallbackByIdempotencyKey(
    tenantId: string,
    key: string
  ): Promise<ContactCenterCallbackRecord | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${CALLBACK_COLUMNS}
         FROM ivekit_cc_callbacks callback
         WHERE callback.tenant_id = $1 AND callback.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeCallback(result.rows[0]) : null;
    });
  }

  insertCallback(callback: ContactCenterCallbackRecord): Promise<ContactCenterCallbackRecord> {
    return withPgTenant(this.pg, callback.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_callbacks
          (id, tenant_id, queue_id, queue_entry_id, source_call_id, outbound_call_id,
           business_ref_type, business_ref_id, address_kind, address_ciphertext,
           address_hmac, address_redacted, state, scheduled_for, attempt_count,
           max_attempts, idempotency_key, requested_by, cancelled_by,
           failure_code, revision, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
                 $23, $24)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        callbackParameters(callback)
      );
      if (result.rows[0]) return decodeCallback(result.rows[0]);
      const replay = await this.findCallbackByIdempotencyKey(
        callback.tenant_id,
        callback.idempotency_key
      );
      if (!replay) throw conflict();
      return replay;
    });
  }

  getCallback(
    tenantId: string,
    callbackId: string,
    options: { for_update?: boolean } = {}
  ): Promise<ContactCenterCallbackRecord | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${CALLBACK_COLUMNS}
         FROM ivekit_cc_callbacks callback
         WHERE callback.tenant_id = $1 AND callback.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, callbackId]
      );
      return result.rows[0] ? decodeCallback(result.rows[0]) : null;
    });
  }

  updateCallback(
    callback: ContactCenterCallbackRecord,
    expectedRevision: number
  ): Promise<ContactCenterCallbackRecord> {
    return withPgTenant(this.pg, callback.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_callbacks
         SET outbound_call_id = $3, state = $4, scheduled_for = $5,
             attempt_count = $6, cancelled_by = $7, failure_code = $8,
             completed_at = $9, revision = revision + 1, updated_at = $10
         WHERE tenant_id = $1 AND id = $2 AND revision = $11
         RETURNING *`,
        [
          callback.tenant_id, callback.id, callback.outbound_call_id,
          callback.state, callback.scheduled_for, callback.attempt_count,
          callback.cancelled_by, callback.failure_code, callback.completed_at,
          callback.updated_at,
          expectedRevision
        ]
      );
      return decodeCallback(ccRequiredRow(result.rows[0], 'conflict'));
    });
  }

  listCallbacks(
    input: ContactCenterCallbackListInput
  ): Promise<ContactCenterPage<ContactCenterCallbackRecord>> {
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    const scope = canonicalContactCenterPayloadHash({
      tenant_id: input.tenant_id,
      queue_id: input.queue_id ?? '',
      state: input.state ?? ''
    });
    const cursor = decodeCallbackCursor(input.cursor, scope);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${CALLBACK_COLUMNS}
         FROM ivekit_cc_callbacks callback
         WHERE callback.tenant_id = $1
           AND ($2 = '' OR callback.queue_id = $2)
           AND ($3 = '' OR callback.state = $3)
           AND (callback.created_at, callback.id) < ($4::timestamptz, $5::text)
         ORDER BY callback.created_at DESC, callback.id DESC
         LIMIT $6`,
        [
          input.tenant_id, input.queue_id ?? '', input.state ?? '',
          cursor.created_at, cursor.id, limit + 1
        ]
      );
      return callbackPage(result.rows.map(decodeCallback), limit, scope);
    });
  }

  getNextDueCallback(
    tenantId: string,
    now: Date
  ): Promise<ContactCenterCallbackRecord | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${CALLBACK_COLUMNS}
         FROM ivekit_cc_callbacks callback
         WHERE callback.tenant_id = $1
           AND callback.state IN ('requested', 'scheduled')
           AND COALESCE(callback.scheduled_for, callback.created_at) <= $2
         ORDER BY COALESCE(callback.scheduled_for, callback.created_at), callback.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [tenantId, now]
      );
      return result.rows[0] ? decodeCallback(result.rows[0]) : null;
    });
  }

  listCallbacksForReconciliation(
    tenantId: string,
    limit: number
  ): Promise<ContactCenterCallbackRecord[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${CALLBACK_COLUMNS}
         FROM ivekit_cc_callbacks callback
         WHERE callback.tenant_id = $1
           AND callback.state IN ('dialing', 'connected')
           AND callback.outbound_call_id IS NOT NULL
         ORDER BY callback.updated_at, callback.id
         FOR UPDATE SKIP LOCKED
         LIMIT $2`,
        [tenantId, limit]
      );
      return result.rows.map(decodeCallback);
    });
  }

  findSupervisorByIdempotencyKey(
    tenantId: string,
    key: string
  ): Promise<ContactCenterSupervisorSession | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${SUPERVISOR_COLUMNS}
         FROM ivekit_cc_supervisor_sessions supervisor
         WHERE supervisor.tenant_id = $1 AND supervisor.idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeSupervisor(result.rows[0]) : null;
    });
  }

  isAgentAssignedToCall(
    tenantId: string,
    callId: string,
    agentId: string
  ): Promise<boolean> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT EXISTS (
           SELECT 1
           FROM ivekit_cc_assignments assignment
           JOIN ivekit_cc_queue_entries entry
             ON entry.tenant_id = assignment.tenant_id
            AND entry.id = assignment.queue_entry_id
           WHERE assignment.tenant_id = $1
             AND entry.call_id = $2
             AND assignment.agent_id = $3
             AND assignment.state IN ('accepted', 'connected')
         ) AS assigned`,
        [tenantId, callId, agentId]
      );
      return result.rows[0]?.assigned === true;
    });
  }

  insertSupervisorSession(
    session: ContactCenterSupervisorSession
  ): Promise<ContactCenterSupervisorSession> {
    return withPgTenant(this.pg, session.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_supervisor_sessions
          (id, tenant_id, call_id, target_agent_id, supervisor_identity,
           mode, state, authorization_ref, idempotency_key,
           provider_session_id, reason, requested_at, started_at, ended_at,
           revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        supervisorParameters(session)
      );
      if (result.rows[0]) return decodeSupervisor(result.rows[0]);
      const replay = await this.findSupervisorByIdempotencyKey(
        session.tenant_id,
        session.idempotency_key
      );
      if (!replay) throw conflict();
      return replay;
    });
  }

  getSupervisorSession(
    tenantId: string,
    sessionId: string,
    options: { for_update?: boolean } = {}
  ): Promise<ContactCenterSupervisorSession | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${SUPERVISOR_COLUMNS}
         FROM ivekit_cc_supervisor_sessions supervisor
         WHERE supervisor.tenant_id = $1 AND supervisor.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, sessionId]
      );
      return result.rows[0] ? decodeSupervisor(result.rows[0]) : null;
    });
  }

  updateSupervisorSession(
    session: ContactCenterSupervisorSession,
    expectedRevision: number
  ): Promise<ContactCenterSupervisorSession> {
    return withPgTenant(this.pg, session.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_supervisor_sessions
         SET state = $3, provider_session_id = $4, reason = $5,
             started_at = $6, ended_at = $7,
             revision = revision + 1, updated_at = $8
         WHERE tenant_id = $1 AND id = $2 AND revision = $9
         RETURNING *`,
        [
          session.tenant_id, session.id, session.state,
          session.provider_session_id, session.reason, session.started_at,
          session.ended_at, session.updated_at, expectedRevision
        ]
      );
      return decodeSupervisor(ccRequiredRow(result.rows[0], 'conflict'));
    });
  }

  insertOverflowAction(action: ContactCenterOverflowAction): Promise<ContactCenterOverflowAction> {
    return withPgTenant(this.pg, action.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_overflow_actions
          (id, tenant_id, source_entry_id, source_queue_id, call_id, priority, action,
           target_queue_id, target, state, idempotency_key, attempt_count,
           max_attempts, scheduled_for, result_ref, error_code, revision,
           created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12, $13, $14, $15, $16, $17, $18, $19, $20)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING *`,
        overflowParameters(action)
      );
      if (result.rows[0]) return decodeOverflow(result.rows[0]);
      const replay = await pg.query<ContactCenterPgRow>(
        `SELECT ${OVERFLOW_COLUMNS}
         FROM ivekit_cc_overflow_actions overflow
         WHERE overflow.tenant_id = $1 AND overflow.idempotency_key = $2`,
        [action.tenant_id, action.idempotency_key]
      );
      return decodeOverflow(ccRequiredRow(replay.rows[0], 'conflict'));
    });
  }

  getNextDueOverflowAction(
    tenantId: string,
    now: Date
  ): Promise<ContactCenterOverflowAction | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${OVERFLOW_COLUMNS}
         FROM ivekit_cc_overflow_actions overflow
         WHERE overflow.tenant_id = $1
           AND overflow.state IN ('pending', 'retry_wait')
           AND overflow.scheduled_for <= $2
         ORDER BY overflow.scheduled_for, overflow.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [tenantId, now]
      );
      return result.rows[0] ? decodeOverflow(result.rows[0]) : null;
    });
  }

  updateOverflowAction(
    action: ContactCenterOverflowAction,
    expectedRevision: number
  ): Promise<ContactCenterOverflowAction> {
    return withPgTenant(this.pg, action.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_overflow_actions
         SET state = $3, attempt_count = $4, scheduled_for = $5,
             result_ref = $6, error_code = $7, completed_at = $8,
             revision = revision + 1, updated_at = $9
         WHERE tenant_id = $1 AND id = $2 AND revision = $10
         RETURNING *`,
        [
          action.tenant_id, action.id, action.state, action.attempt_count,
          action.scheduled_for, action.result_ref, action.error_code,
          action.completed_at, action.updated_at, expectedRevision
        ]
      );
      return decodeOverflow(ccRequiredRow(result.rows[0], 'conflict'));
    });
  }

  listExpiredOffers(tenantId: string, now: Date, limit: number): Promise<ContactCenterAssignment[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ASSIGNMENT_COLUMNS}
         FROM ivekit_cc_assignments assignment
         WHERE assignment.tenant_id = $1 AND assignment.state = 'offered'
           AND assignment.offer_expires_at <= $2
         ORDER BY assignment.offer_expires_at, assignment.id
         FOR UPDATE SKIP LOCKED LIMIT $3`,
        [tenantId, now, limit]
      );
      return result.rows.map(decodeAssignment);
    });
  }

  listExpiredWaitingEntries(
    tenantId: string,
    now: Date,
    limit: number
  ): Promise<ContactCenterQueueEntry[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${ENTRY_COLUMNS}
         FROM ivekit_cc_queue_entries entry
         WHERE entry.tenant_id = $1 AND entry.state = 'waiting'
           AND entry.timeout_at IS NOT NULL AND entry.timeout_at <= $2
         ORDER BY entry.timeout_at, entry.id
         FOR UPDATE SKIP LOCKED LIMIT $3`,
        [tenantId, now, limit]
      );
      return result.rows.map(decodeEntry);
    });
  }

  listRoutableQueueIds(tenantId: string, now: Date, limit: number): Promise<string[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT queue.id
         FROM ivekit_cc_queues queue
         WHERE queue.tenant_id = $1 AND queue.status = 'active'
           AND EXISTS (
             SELECT 1 FROM ivekit_cc_queue_entries entry
             WHERE entry.tenant_id = queue.tenant_id AND entry.queue_id = queue.id
               AND entry.state = 'waiting'
               AND (entry.timeout_at IS NULL OR entry.timeout_at > $2)
           )
         ORDER BY queue.id LIMIT $3`,
        [tenantId, now, limit]
      );
      return result.rows.map((row) => String(row.id));
    });
  }
}

function decodeQueue(row: ContactCenterPgRow): ContactCenterQueue {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), name: String(row.name),
    routing_strategy: row.routing_strategy as ContactCenterQueue['routing_strategy'],
    max_wait_seconds: ccNumber(row.max_wait_seconds), max_size: ccNumber(row.max_size),
    callback_after_seconds: ccNumber(row.callback_after_seconds),
    overflow_action: row.overflow_action as ContactCenterQueue['overflow_action'],
    overflow_queue_id: row.overflow_queue_id ? String(row.overflow_queue_id) : null,
    overflow_target: String(row.overflow_target || ''),
    service_level_seconds: ccNumber(row.service_level_seconds),
    status: row.status as ContactCenterQueue['status'], metadata: ccJsonRecord(row.metadata),
    revision: ccNumber(row.revision), created_by: String(row.created_by || ''),
    updated_by: String(row.updated_by || ''), created_at: ccTimestamp(row.created_at),
    updated_at: ccTimestamp(row.updated_at)
  };
}

function decodeEntry(row: ContactCenterPgRow): ContactCenterQueueEntry {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), queue_id: String(row.queue_id),
    call_id: String(row.call_id), state: row.state as ContactCenterQueueEntry['state'],
    priority: ccNumber(row.priority), idempotency_key: String(row.idempotency_key),
    payload_hash: String(row.payload_hash), entered_at: ccTimestamp(row.entered_at),
    offered_at: ccNullableTimestamp(row.offered_at), assigned_at: ccNullableTimestamp(row.assigned_at),
    answered_at: ccNullableTimestamp(row.answered_at), ended_at: ccNullableTimestamp(row.ended_at),
    timeout_at: ccNullableTimestamp(row.timeout_at), outcome_reason: String(row.outcome_reason || ''),
    metadata: ccJsonRecord(row.metadata), revision: ccNumber(row.revision),
    created_at: ccTimestamp(row.created_at), updated_at: ccTimestamp(row.updated_at)
  };
}

function decodeAssignment(row: ContactCenterPgRow): ContactCenterAssignment {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), queue_entry_id: String(row.queue_entry_id),
    agent_id: String(row.agent_id), capacity_slot: ccNumber(row.capacity_slot),
    state: row.state as ContactCenterAssignment['state'], attempt: ccNumber(row.attempt),
    idempotency_key: String(row.idempotency_key), offer_expires_at: ccTimestamp(row.offer_expires_at),
    accepted_at: ccNullableTimestamp(row.accepted_at), connected_at: ccNullableTimestamp(row.connected_at),
    completed_at: ccNullableTimestamp(row.completed_at), outcome_reason: String(row.outcome_reason || ''),
    revision: ccNumber(row.revision), created_at: ccTimestamp(row.created_at), updated_at: ccTimestamp(row.updated_at)
  };
}

function decodePresence(row: ContactCenterPgRow): ContactCenterAgentPresence {
  return {
    tenant_id: String(row.tenant_id), agent_id: String(row.agent_id),
    state: row.state as ContactCenterAgentPresence['state'],
    active_voice_count: ccNumber(row.active_voice_count), voice_capacity: ccNumber(row.voice_capacity),
    current_call_id: row.current_call_id ? String(row.current_call_id) : null,
    idle_since: ccNullableTimestamp(row.idle_since), heartbeat_at: ccNullableTimestamp(row.heartbeat_at),
    session_ref: String(row.session_ref || ''), revision: ccNumber(row.revision),
    updated_at: ccTimestamp(row.updated_at)
  };
}

function decodeCallback(row: ContactCenterPgRow): ContactCenterCallbackRecord {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), queue_id: String(row.queue_id),
    queue_entry_id: String(row.queue_entry_id), source_call_id: String(row.source_call_id),
    outbound_call_id: row.outbound_call_id ? String(row.outbound_call_id) : null,
    business_ref_type: String(row.business_ref_type), business_ref_id: String(row.business_ref_id),
    address_kind: row.address_kind as ContactCenterCallbackRecord['address_kind'],
    address_ciphertext: String(row.address_ciphertext), address_hmac: String(row.address_hmac),
    address_redacted: String(row.address_redacted),
    state: row.state as ContactCenterCallbackRecord['state'],
    scheduled_for: ccNullableTimestamp(row.scheduled_for),
    attempt_count: ccNumber(row.attempt_count), max_attempts: ccNumber(row.max_attempts),
    idempotency_key: String(row.idempotency_key), requested_by: String(row.requested_by || ''),
    cancelled_by: String(row.cancelled_by || ''), failure_code: String(row.failure_code || ''),
    revision: ccNumber(row.revision), created_at: ccTimestamp(row.created_at),
    updated_at: ccTimestamp(row.updated_at), completed_at: ccNullableTimestamp(row.completed_at)
  };
}

function decodeSupervisor(row: ContactCenterPgRow): ContactCenterSupervisorSession {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), call_id: String(row.call_id),
    target_agent_id: String(row.target_agent_id),
    supervisor_identity: String(row.supervisor_identity),
    mode: row.mode as ContactCenterSupervisorSession['mode'],
    state: row.state as ContactCenterSupervisorSession['state'],
    authorization_ref: String(row.authorization_ref),
    idempotency_key: String(row.idempotency_key),
    provider_session_id: String(row.provider_session_id || ''),
    reason: String(row.reason || ''), requested_at: ccTimestamp(row.requested_at),
    started_at: ccNullableTimestamp(row.started_at), ended_at: ccNullableTimestamp(row.ended_at),
    revision: ccNumber(row.revision), created_at: ccTimestamp(row.created_at),
    updated_at: ccTimestamp(row.updated_at)
  };
}

function decodeOverflow(row: ContactCenterPgRow): ContactCenterOverflowAction {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id),
    source_entry_id: String(row.source_entry_id),
    source_queue_id: String(row.source_queue_id), call_id: String(row.call_id),
    priority: ccNumber(row.priority),
    action: row.action as ContactCenterOverflowAction['action'],
    target_queue_id: row.target_queue_id ? String(row.target_queue_id) : null,
    target: String(row.target || ''),
    state: row.state as ContactCenterOverflowAction['state'],
    idempotency_key: String(row.idempotency_key),
    attempt_count: ccNumber(row.attempt_count), max_attempts: ccNumber(row.max_attempts),
    scheduled_for: ccTimestamp(row.scheduled_for), result_ref: String(row.result_ref || ''),
    error_code: String(row.error_code || ''), revision: ccNumber(row.revision),
    created_at: ccTimestamp(row.created_at), updated_at: ccTimestamp(row.updated_at),
    completed_at: ccNullableTimestamp(row.completed_at)
  };
}

function decodeCandidate(row: ContactCenterPgRow): ContactCenterRoutingCandidate {
  const skills = Object.fromEntries(Object.entries(ccJsonRecord(row.skills)).map(([key, value]) => [key, ccNumber(value)]));
  return {
    agent_id: String(row.agent_id),
    presence_state: row.presence_state as ContactCenterRoutingCandidate['presence_state'],
    active_voice_count: ccNumber(row.active_voice_count), voice_capacity: ccNumber(row.voice_capacity),
    idle_since: row.idle_since ? ccTimestamp(row.idle_since) : '',
    handled_count: ccNumber(row.handled_count), member_priority: ccNumber(row.member_priority), skills
  };
}

function entryParameters(entry: ContactCenterQueueEntry): unknown[] {
  return [
    entry.id, entry.tenant_id, entry.queue_id, entry.call_id, entry.state, entry.priority,
    entry.idempotency_key, entry.payload_hash, entry.entered_at, entry.offered_at,
    entry.assigned_at, entry.answered_at, entry.ended_at, entry.timeout_at,
    entry.outcome_reason, JSON.stringify(entry.metadata), entry.revision,
    entry.created_at, entry.updated_at
  ];
}

function assignmentParameters(assignment: ContactCenterAssignment): unknown[] {
  return [
    assignment.id, assignment.tenant_id, assignment.queue_entry_id, assignment.agent_id,
    assignment.capacity_slot, assignment.state, assignment.attempt, assignment.idempotency_key,
    assignment.offer_expires_at, assignment.accepted_at, assignment.connected_at,
    assignment.completed_at, assignment.outcome_reason, assignment.revision,
    assignment.created_at, assignment.updated_at
  ];
}

function callbackParameters(callback: ContactCenterCallbackRecord): unknown[] {
  return [
    callback.id, callback.tenant_id, callback.queue_id, callback.queue_entry_id,
    callback.source_call_id, callback.outbound_call_id, callback.business_ref_type,
    callback.business_ref_id, callback.address_kind, callback.address_ciphertext,
    callback.address_hmac, callback.address_redacted, callback.state,
    callback.scheduled_for, callback.attempt_count, callback.max_attempts,
    callback.idempotency_key, callback.requested_by, callback.cancelled_by,
    callback.failure_code, callback.revision, callback.created_at,
    callback.updated_at, callback.completed_at
  ];
}

function supervisorParameters(session: ContactCenterSupervisorSession): unknown[] {
  return [
    session.id, session.tenant_id, session.call_id, session.target_agent_id,
    session.supervisor_identity, session.mode, session.state,
    session.authorization_ref, session.idempotency_key,
    session.provider_session_id, session.reason, session.requested_at,
    session.started_at, session.ended_at, session.revision,
    session.created_at, session.updated_at
  ];
}

function overflowParameters(action: ContactCenterOverflowAction): unknown[] {
  return [
    action.id, action.tenant_id, action.source_entry_id, action.source_queue_id,
    action.call_id, action.priority, action.action, action.target_queue_id, action.target,
    action.state, action.idempotency_key, action.attempt_count,
    action.max_attempts, action.scheduled_for, action.result_ref,
    action.error_code, action.revision, action.created_at, action.updated_at,
    action.completed_at
  ];
}

function conflict(): ContactCenterError {
  return new ContactCenterError({ code: 'conflict' });
}

function decodeEntryCursor(
  cursor: string | undefined,
  scope: string
): { entered_at: string; id: string } {
  if (!cursor) return { entered_at: '9999-12-31T23:59:59.999Z', id: '\uffff' };
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || value.scope !== scope || typeof value.entered_at !== 'string' ||
      typeof value.id !== 'string') throw new Error('invalid cursor');
    return { entered_at: ccTimestamp(value.entered_at), id: value.id };
  } catch {
    throw new ContactCenterError({
      code: 'validation_failed', status: 400, details: { field: 'cursor' }
    });
  }
}

function entryPage(
  rows: ContactCenterQueueEntry[],
  limit: number,
  scope: string
): ContactCenterPage<ContactCenterQueueEntry> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify({
      v: 1, scope, entered_at: last.entered_at, id: last.id
    }), 'utf8').toString('base64url') : null
  };
}

function decodeCallbackCursor(
  cursor: string | undefined,
  scope: string
): { created_at: string; id: string } {
  if (!cursor) return { created_at: '9999-12-31T23:59:59.999Z', id: '\uffff' };
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || value.scope !== scope || typeof value.created_at !== 'string' ||
      typeof value.id !== 'string') throw new Error('invalid cursor');
    return { created_at: ccTimestamp(value.created_at), id: value.id };
  } catch {
    throw new ContactCenterError({
      code: 'validation_failed', status: 400, details: { field: 'cursor' }
    });
  }
}

function callbackPage(
  rows: ContactCenterCallbackRecord[],
  limit: number,
  scope: string
): ContactCenterPage<ContactCenterCallbackRecord> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify({
      v: 1, scope, created_at: last.created_at, id: last.id
    }), 'utf8').toString('base64url') : null
  };
}
