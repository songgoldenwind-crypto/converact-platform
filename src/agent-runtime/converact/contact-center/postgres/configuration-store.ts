import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { canonicalContactCenterPayloadHash } from '../canonical.js';
import type { ContactCenterConfigurationRepository } from '../configuration-ports.js';
import { ContactCenterError } from '../errors.js';
import type {
  ContactCenterAgent,
  ContactCenterAgentPresence,
  ContactCenterAgentSkill,
  ContactCenterConfigurationIdempotencyRecord,
  ContactCenterListInput,
  ContactCenterPage,
  ContactCenterQueue,
  ContactCenterQueueMembership,
  ContactCenterSkill,
  ContactCenterSkillRequirement
} from '../types.js';
import { PostgresContactCenterRepository } from './store.js';
import {
  ccJsonRecord,
  ccNumber,
  ccRequiredRow,
  ccTimestamp,
  type ContactCenterPgRow
} from './row-utils.js';

const SKILL_COLUMNS = `
  skill.id, skill.tenant_id, skill.name, skill.description, skill.status,
  skill.revision, skill.created_by, skill.updated_by, skill.created_at, skill.updated_at`;

const AGENT_COLUMNS = `
  agent.id, agent.tenant_id, agent.identity, agent.display_name,
  agent.voice_extension_id, agent.status, agent.voice_capacity, agent.metadata,
  agent.revision, agent.created_by, agent.updated_by, agent.created_at, agent.updated_at`;

const QUEUE_COLUMNS = `
  queue.id, queue.tenant_id, queue.name, queue.routing_strategy,
  queue.max_wait_seconds, queue.max_size, queue.callback_after_seconds,
  queue.overflow_action, queue.overflow_queue_id, queue.overflow_target,
  queue.service_level_seconds, queue.status, queue.metadata, queue.revision,
  queue.created_by, queue.updated_by, queue.created_at, queue.updated_at`;

export class PostgresContactCenterConfigurationStore implements ContactCenterConfigurationRepository {
  constructor(private readonly pg: PgQueryable) {}

  lockIdempotencyKey(tenantId: string, key: string): Promise<void> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`ivekit:cc:configuration:${tenantId}:${key}`]
      );
    });
  }

  findIdempotencyRecord(
    tenantId: string,
    key: string
  ): Promise<ContactCenterConfigurationIdempotencyRecord | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT tenant_id, idempotency_key, resource_type, payload_hash,
                resource_id, created_at
         FROM ivekit_cc_configuration_idempotency
         WHERE tenant_id = $1 AND idempotency_key = $2`,
        [tenantId, key]
      );
      return result.rows[0] ? decodeIdempotencyRecord(result.rows[0]) : null;
    });
  }

  insertIdempotencyRecord(
    record: ContactCenterConfigurationIdempotencyRecord
  ): Promise<ContactCenterConfigurationIdempotencyRecord> {
    return mutation(withPgTenant(this.pg, record.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_configuration_idempotency
          (tenant_id, idempotency_key, resource_type, payload_hash, resource_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          record.tenant_id, record.idempotency_key, record.resource_type,
          record.payload_hash, record.resource_id, record.created_at
        ]
      );
      return decodeIdempotencyRecord(ccRequiredRow(result.rows[0]));
    }));
  }

  insertSkill(skill: ContactCenterSkill): Promise<ContactCenterSkill> {
    return mutation(withPgTenant(this.pg, skill.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_skills
          (id, tenant_id, name, description, status, revision, created_by,
           updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          skill.id, skill.tenant_id, skill.name, skill.description, skill.status,
          skill.revision, skill.created_by, skill.updated_by, skill.created_at, skill.updated_at
        ]
      );
      return decodeSkill(ccRequiredRow(result.rows[0]));
    }));
  }

  getSkill(tenantId: string, skillId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterSkill | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${SKILL_COLUMNS} FROM ivekit_cc_skills skill
         WHERE skill.tenant_id = $1 AND skill.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, skillId]
      );
      return result.rows[0] ? decodeSkill(result.rows[0]) : null;
    });
  }

  updateSkill(skill: ContactCenterSkill, expectedRevision: number): Promise<ContactCenterSkill> {
    return mutation(withPgTenant(this.pg, skill.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_skills
         SET name = $3, description = $4, status = $5, revision = revision + 1,
             updated_by = $6, updated_at = $7
         WHERE tenant_id = $1 AND id = $2 AND revision = $8
         RETURNING *`,
        [
          skill.tenant_id, skill.id, skill.name, skill.description, skill.status,
          skill.updated_by, skill.updated_at, expectedRevision
        ]
      );
      return decodeSkill(revisionRow(result.rows[0]));
    }));
  }

  async listSkills(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterSkill>> {
    return this.#list(input, 'skills', SKILL_COLUMNS, 'ivekit_cc_skills skill', decodeSkill);
  }

  insertAgent(agent: ContactCenterAgent, presence: ContactCenterAgentPresence): Promise<ContactCenterAgent> {
    return mutation(withPgTenant(this.pg, agent.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_agents
          (id, tenant_id, identity, display_name, voice_extension_id, status,
           voice_capacity, metadata, revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          agent.id, agent.tenant_id, agent.identity, agent.display_name,
          agent.voice_extension_id, agent.status, agent.voice_capacity,
          JSON.stringify(agent.metadata), agent.revision, agent.created_by,
          agent.updated_by, agent.created_at, agent.updated_at
        ]
      );
      await pg.query(
        `INSERT INTO ivekit_cc_agent_presence
          (tenant_id, agent_id, state, active_voice_count, voice_capacity,
           current_call_id, idle_since, heartbeat_at, session_ref, revision, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          presence.tenant_id, presence.agent_id, presence.state,
          presence.active_voice_count, presence.voice_capacity, presence.current_call_id,
          presence.idle_since, presence.heartbeat_at, presence.session_ref,
          presence.revision, presence.updated_at
        ]
      );
      return decodeAgent(ccRequiredRow(result.rows[0]));
    }));
  }

  getAgent(tenantId: string, agentId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterAgent | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${AGENT_COLUMNS} FROM ivekit_cc_agents agent
         WHERE agent.tenant_id = $1 AND agent.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, agentId]
      );
      return result.rows[0] ? decodeAgent(result.rows[0]) : null;
    });
  }

  findAgentByIdentity(tenantId: string, identity: string): Promise<ContactCenterAgent | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${AGENT_COLUMNS} FROM ivekit_cc_agents agent
         WHERE agent.tenant_id = $1 AND agent.identity = $2`,
        [tenantId, identity]
      );
      return result.rows[0] ? decodeAgent(result.rows[0]) : null;
    });
  }

  updateAgent(agent: ContactCenterAgent, expectedRevision: number): Promise<ContactCenterAgent> {
    return mutation(withPgTenant(this.pg, agent.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_agents
         SET identity = $3, display_name = $4, voice_extension_id = $5,
             status = $6, voice_capacity = $7, metadata = $8::jsonb,
             revision = revision + 1, updated_by = $9, updated_at = $10
         WHERE tenant_id = $1 AND id = $2 AND revision = $11
         RETURNING *`,
        [
          agent.tenant_id, agent.id, agent.identity, agent.display_name,
          agent.voice_extension_id, agent.status, agent.voice_capacity,
          JSON.stringify(agent.metadata), agent.updated_by, agent.updated_at,
          expectedRevision
        ]
      );
      return decodeAgent(revisionRow(result.rows[0]));
    }));
  }

  async listAgents(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterAgent>> {
    return this.#list(input, 'agents', AGENT_COLUMNS, 'ivekit_cc_agents agent', decodeAgent);
  }

  getPresence(tenantId: string, agentId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterAgentPresence | null> {
    return new PostgresContactCenterRepository(this.pg).getPresence(tenantId, agentId, options);
  }

  updatePresence(presence: ContactCenterAgentPresence, expectedRevision: number): Promise<ContactCenterAgentPresence> {
    return new PostgresContactCenterRepository(this.pg).updatePresence(presence, expectedRevision);
  }

  listAgentSkills(tenantId: string, agentId: string): Promise<ContactCenterAgentSkill[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT skill_id, proficiency FROM ivekit_cc_agent_skills
         WHERE tenant_id = $1 AND agent_id = $2 ORDER BY skill_id`,
        [tenantId, agentId]
      );
      return result.rows.map((row) => ({
        skill_id: String(row.skill_id), proficiency: ccNumber(row.proficiency)
      }));
    });
  }

  replaceAgentSkills(
    tenantId: string,
    agentId: string,
    skills: ContactCenterAgentSkill[],
    now: string
  ): Promise<void> {
    return mutation(withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `DELETE FROM ivekit_cc_agent_skills WHERE tenant_id = $1 AND agent_id = $2`,
        [tenantId, agentId]
      );
      if (skills.length) await pg.query(
        `INSERT INTO ivekit_cc_agent_skills
          (tenant_id, agent_id, skill_id, proficiency, created_at, updated_at)
         SELECT $1, $2, input.skill_id, input.proficiency, $4, $4
         FROM jsonb_to_recordset($3::jsonb) AS input(skill_id text, proficiency integer)`,
        [tenantId, agentId, JSON.stringify(skills), now]
      );
    }));
  }

  insertQueue(queue: ContactCenterQueue): Promise<ContactCenterQueue> {
    return mutation(withPgTenant(this.pg, queue.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_queues
          (id, tenant_id, name, routing_strategy, max_wait_seconds, max_size,
           callback_after_seconds, overflow_action, overflow_queue_id,
           overflow_target, service_level_seconds, status, metadata, revision,
           created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13::jsonb, $14, $15, $16, $17, $18)
         RETURNING *`,
        queueParameters(queue)
      );
      return decodeQueue(ccRequiredRow(result.rows[0]));
    }));
  }

  getQueue(tenantId: string, queueId: string, options: { for_update?: boolean } = {}): Promise<ContactCenterQueue | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${QUEUE_COLUMNS} FROM ivekit_cc_queues queue
         WHERE queue.tenant_id = $1 AND queue.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, queueId]
      );
      return result.rows[0] ? decodeQueue(result.rows[0]) : null;
    });
  }

  updateQueue(queue: ContactCenterQueue, expectedRevision: number): Promise<ContactCenterQueue> {
    return mutation(withPgTenant(this.pg, queue.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `UPDATE ivekit_cc_queues
         SET name = $3, routing_strategy = $4, max_wait_seconds = $5,
             max_size = $6, callback_after_seconds = $7, overflow_action = $8,
             overflow_queue_id = $9, overflow_target = $10,
             service_level_seconds = $11, status = $12, metadata = $13::jsonb,
             revision = revision + 1, updated_by = $14, updated_at = $15
         WHERE tenant_id = $1 AND id = $2 AND revision = $16
         RETURNING *`,
        [
          queue.tenant_id, queue.id, queue.name, queue.routing_strategy,
          queue.max_wait_seconds, queue.max_size, queue.callback_after_seconds,
          queue.overflow_action, queue.overflow_queue_id, queue.overflow_target,
          queue.service_level_seconds, queue.status, JSON.stringify(queue.metadata),
          queue.updated_by, queue.updated_at, expectedRevision
        ]
      );
      return decodeQueue(revisionRow(result.rows[0]));
    }));
  }

  async listQueues(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterQueue>> {
    return this.#list(input, 'queues', QUEUE_COLUMNS, 'ivekit_cc_queues queue', decodeQueue);
  }

  listMemberships(tenantId: string, queueId: string): Promise<ContactCenterQueueMembership[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT queue_id, agent_id, priority, enabled, created_at, updated_at
         FROM ivekit_cc_queue_memberships
         WHERE tenant_id = $1 AND queue_id = $2
         ORDER BY priority DESC, agent_id`,
        [tenantId, queueId]
      );
      return result.rows.map(decodeMembership);
    });
  }

  upsertMembership(
    tenantId: string,
    membership: ContactCenterQueueMembership
  ): Promise<ContactCenterQueueMembership> {
    return mutation(withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `INSERT INTO ivekit_cc_queue_memberships
          (tenant_id, queue_id, agent_id, priority, enabled, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, queue_id, agent_id) DO UPDATE
         SET priority = EXCLUDED.priority, enabled = EXCLUDED.enabled,
             updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          tenantId, membership.queue_id, membership.agent_id, membership.priority,
          membership.enabled, membership.created_at, membership.updated_at
        ]
      );
      return decodeMembership(ccRequiredRow(result.rows[0]));
    }));
  }

  removeMembership(tenantId: string, queueId: string, agentId: string): Promise<boolean> {
    return mutation(withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query(
        `DELETE FROM ivekit_cc_queue_memberships
         WHERE tenant_id = $1 AND queue_id = $2 AND agent_id = $3`,
        [tenantId, queueId, agentId]
      );
      return Number(result.rowCount || 0) > 0;
    }));
  }

  listQueueSkillRequirements(tenantId: string, queueId: string): Promise<ContactCenterSkillRequirement[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT skill_id, minimum_proficiency
         FROM ivekit_cc_queue_skill_requirements
         WHERE tenant_id = $1 AND queue_id = $2 ORDER BY skill_id`,
        [tenantId, queueId]
      );
      return result.rows.map((row) => ({
        skill_id: String(row.skill_id),
        minimum_proficiency: ccNumber(row.minimum_proficiency)
      }));
    });
  }

  replaceQueueSkillRequirements(
    tenantId: string,
    queueId: string,
    requirements: ContactCenterSkillRequirement[],
    now: string
  ): Promise<void> {
    return mutation(withPgTenant(this.pg, tenantId, async (pg) => {
      await pg.query(
        `DELETE FROM ivekit_cc_queue_skill_requirements
         WHERE tenant_id = $1 AND queue_id = $2`,
        [tenantId, queueId]
      );
      if (requirements.length) await pg.query(
        `INSERT INTO ivekit_cc_queue_skill_requirements
          (tenant_id, queue_id, skill_id, minimum_proficiency, created_at, updated_at)
         SELECT $1, $2, input.skill_id, input.minimum_proficiency, $4, $4
         FROM jsonb_to_recordset($3::jsonb)
           AS input(skill_id text, minimum_proficiency integer)`,
        [tenantId, queueId, JSON.stringify(requirements), now]
      );
    }));
  }

  #list<T extends { id: string; created_at: string }>(
    input: ContactCenterListInput,
    resource: string,
    columns: string,
    table: string,
    decode: (row: ContactCenterPgRow) => T
  ): Promise<ContactCenterPage<T>> {
    const limit = boundedLimit(input.limit);
    const scope = canonicalContactCenterPayloadHash({
      tenant_id: input.tenant_id, resource, status: input.status ?? ''
    });
    const cursor = decodeCursor(input.cursor, scope);
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<ContactCenterPgRow>(
        `SELECT ${columns} FROM ${table}
         WHERE tenant_id = $1 AND ($2 = '' OR status = $2)
           AND (created_at, id) < ($3::timestamptz, $4::text)
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [input.tenant_id, input.status ?? '', cursor.created_at, cursor.id, limit + 1]
      );
      return page(result.rows.map(decode), limit, scope);
    });
  }
}

function decodeSkill(row: ContactCenterPgRow): ContactCenterSkill {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), name: String(row.name),
    description: String(row.description || ''), status: row.status as ContactCenterSkill['status'],
    revision: ccNumber(row.revision), created_by: String(row.created_by || ''),
    updated_by: String(row.updated_by || ''), created_at: ccTimestamp(row.created_at),
    updated_at: ccTimestamp(row.updated_at)
  };
}

function decodeIdempotencyRecord(
  row: ContactCenterPgRow
): ContactCenterConfigurationIdempotencyRecord {
  return {
    tenant_id: String(row.tenant_id), idempotency_key: String(row.idempotency_key),
    resource_type: row.resource_type as ContactCenterConfigurationIdempotencyRecord['resource_type'],
    payload_hash: String(row.payload_hash), resource_id: String(row.resource_id),
    created_at: ccTimestamp(row.created_at)
  };
}

function decodeAgent(row: ContactCenterPgRow): ContactCenterAgent {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), identity: String(row.identity),
    display_name: String(row.display_name || ''),
    voice_extension_id: row.voice_extension_id ? String(row.voice_extension_id) : null,
    status: row.status as ContactCenterAgent['status'], voice_capacity: ccNumber(row.voice_capacity),
    metadata: ccJsonRecord(row.metadata), revision: ccNumber(row.revision),
    created_by: String(row.created_by || ''), updated_by: String(row.updated_by || ''),
    created_at: ccTimestamp(row.created_at), updated_at: ccTimestamp(row.updated_at)
  };
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

function decodeMembership(row: ContactCenterPgRow): ContactCenterQueueMembership {
  return {
    queue_id: String(row.queue_id), agent_id: String(row.agent_id),
    priority: ccNumber(row.priority), enabled: row.enabled === true || row.enabled === 'true',
    created_at: ccTimestamp(row.created_at), updated_at: ccTimestamp(row.updated_at)
  };
}

function queueParameters(queue: ContactCenterQueue): unknown[] {
  return [
    queue.id, queue.tenant_id, queue.name, queue.routing_strategy,
    queue.max_wait_seconds, queue.max_size, queue.callback_after_seconds,
    queue.overflow_action, queue.overflow_queue_id, queue.overflow_target,
    queue.service_level_seconds, queue.status, JSON.stringify(queue.metadata),
    queue.revision, queue.created_by, queue.updated_by, queue.created_at, queue.updated_at
  ];
}

function boundedLimit(value: number | undefined): number {
  return Number.isInteger(value) ? Math.min(200, Math.max(1, Number(value))) : 50;
}

function decodeCursor(cursor: string | undefined, scope: string): { created_at: string; id: string } {
  if (!cursor) return { created_at: '9999-12-31T23:59:59.999Z', id: '\uffff' };
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || value.scope !== scope || typeof value.created_at !== 'string' ||
      typeof value.id !== 'string') throw new Error('invalid cursor');
    return { created_at: ccTimestamp(value.created_at), id: value.id };
  } catch {
    throw new ContactCenterError({ code: 'validation_failed', status: 400, details: { field: 'cursor' } });
  }
}

function page<T extends { id: string; created_at: string }>(
  rows: T[],
  limit: number,
  scope: string
): ContactCenterPage<T> {
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

function revisionRow(row: ContactCenterPgRow | undefined): ContactCenterPgRow {
  if (!row) throw new ContactCenterError({ code: 'revision_conflict', status: 409 });
  return row;
}

async function mutation<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof ContactCenterError) throw error;
    const code = String((error as { code?: unknown }).code || '');
    if (code === '23505') throw new ContactCenterError({ code: 'conflict', status: 409, details: { reason: 'duplicate' } });
    if (code === '23503') throw new ContactCenterError({ code: 'conflict', status: 409, details: { reason: 'invalid_reference' } });
    if (code === '23514') throw new ContactCenterError({ code: 'validation_failed', status: 422 });
    throw error;
  }
}
