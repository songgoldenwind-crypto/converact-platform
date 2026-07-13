import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { ContactCenterError } from '../errors.js';
import type { ContactCenterRepository } from '../ports.js';
import type {
  ContactCenterAgentPresence,
  ContactCenterAssignment,
  ContactCenterQueue,
  ContactCenterQueueEntry,
  ContactCenterRoutingCandidate
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
  queue.created_at, queue.updated_at`;

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
    revision: ccNumber(row.revision), created_at: ccTimestamp(row.created_at), updated_at: ccTimestamp(row.updated_at)
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

function conflict(): ContactCenterError {
  return new ContactCenterError({ code: 'conflict' });
}
