import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type {
  ContactCenterMonitorAgents,
  ContactCenterMonitorCalls,
  ContactCenterMonitorOperations,
  ContactCenterMonitorProjection,
  ContactCenterMonitorQueueProjection,
  ContactCenterMonitorSource
} from '../monitor-service.js';
import type { ContactCenterQueueStatus, ContactCenterRoutingStrategy } from '../types.js';
import { ccNumber, type ContactCenterPgRow } from './row-utils.js';

export class PostgresContactCenterMonitorSource implements ContactCenterMonitorSource {
  constructor(private readonly pg: PgQueryable) {}

  load(
    tenantId: string,
    window: { now: string; day_start: string; day_end: string }
  ): Promise<ContactCenterMonitorProjection> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const agents = await pg.query<ContactCenterPgRow>(AGENT_SUMMARY_SQL, [tenantId]);
      const calls = await pg.query<ContactCenterPgRow>(CALL_SUMMARY_SQL, [tenantId]);
      const operations = await pg.query<ContactCenterPgRow>(OPERATION_SUMMARY_SQL, [
        tenantId, window.day_start, window.day_end
      ]);
      const queues = await pg.query<ContactCenterPgRow>(QUEUE_SUMMARY_SQL, [
        tenantId, window.day_start, window.day_end, window.now
      ]);
      return {
        agents: decodeAgents(agents.rows[0] || {}),
        calls: decodeCalls(calls.rows[0] || {}),
        operations: decodeOperations(operations.rows[0] || {}),
        queues: queues.rows.map(decodeQueue)
      };
    });
  }
}

const AGENT_SUMMARY_SQL = `
  SELECT
    count(*)::integer AS configured,
    count(*) FILTER (WHERE agent.status = 'active')::integer AS active,
    count(*) FILTER (WHERE agent.status = 'active' AND presence.state = 'offline')::integer AS offline,
    count(*) FILTER (WHERE agent.status = 'active' AND presence.state = 'available')::integer AS available,
    count(*) FILTER (WHERE agent.status = 'active' AND presence.state = 'busy')::integer AS busy,
    count(*) FILTER (WHERE agent.status = 'active' AND presence.state = 'after_call')::integer AS after_call,
    count(*) FILTER (WHERE agent.status = 'active' AND presence.state = 'away')::integer AS away,
    COALESCE(sum(presence.active_voice_count) FILTER (WHERE agent.status = 'active'), 0)::integer
      AS active_voice_count,
    COALESCE(sum(presence.voice_capacity) FILTER (WHERE agent.status = 'active'), 0)::integer
      AS voice_capacity
  FROM ivekit_cc_agents agent
  JOIN ivekit_cc_agent_presence presence
    ON presence.tenant_id = agent.tenant_id AND presence.agent_id = agent.id
  WHERE agent.tenant_id = $1 AND agent.status <> 'archived'`;

const CALL_SUMMARY_SQL = `
  SELECT
    count(*) FILTER (WHERE voice_call.direction = 'inbound')::integer AS active_inbound,
    count(*) FILTER (WHERE voice_call.direction = 'outbound')::integer AS active_outbound
  FROM ivekit_voice_calls voice_call
  WHERE voice_call.tenant_id = $1
    AND voice_call.state IN (
      'planned', 'queued', 'dialing', 'ringing', 'active', 'held', 'transferring'
    )`;

const OPERATION_SUMMARY_SQL = `
  SELECT
    (SELECT count(*)::integer FROM ivekit_cc_callbacks callback
      WHERE callback.tenant_id = $1
        AND callback.state IN ('requested', 'scheduled', 'dialing', 'connected')) AS callbacks_pending,
    (SELECT count(*)::integer FROM ivekit_cc_callbacks callback
      WHERE callback.tenant_id = $1 AND callback.state = 'failed'
        AND callback.completed_at >= $2 AND callback.completed_at < $3) AS callbacks_failed_today,
    (SELECT count(*)::integer FROM ivekit_cc_overflow_actions overflow
      WHERE overflow.tenant_id = $1 AND overflow.state IN ('pending', 'retry_wait')) AS overflows_pending,
    (SELECT count(*)::integer FROM ivekit_cc_overflow_actions overflow
      WHERE overflow.tenant_id = $1 AND overflow.state = 'failed'
        AND overflow.completed_at >= $2 AND overflow.completed_at < $3) AS overflows_failed_today,
    (SELECT count(*)::integer FROM ivekit_cc_supervisor_sessions supervisor
      WHERE supervisor.tenant_id = $1 AND supervisor.state = 'requested') AS supervisor_requested,
    (SELECT count(*)::integer FROM ivekit_cc_supervisor_sessions supervisor
      WHERE supervisor.tenant_id = $1 AND supervisor.state = 'active') AS supervisor_active`;

const QUEUE_SUMMARY_SQL = `
  SELECT
    queue.id AS queue_id,
    queue.name AS queue_name,
    queue.status,
    queue.routing_strategy,
    queue.max_wait_seconds,
    queue.service_level_seconds,
    entry_stats.waiting_count,
    entry_stats.offered_count,
    entry_stats.assigned_count,
    entry_stats.answered_count,
    capacity.available_agents,
    capacity.available_capacity,
    entry_stats.oldest_wait_seconds,
    entry_stats.average_handle_seconds,
    entry_stats.answered_today,
    entry_stats.answered_in_service_level_today,
    entry_stats.abandoned_today,
    entry_stats.timed_out_today,
    entry_stats.overflowed_today,
    entry_stats.average_wait_seconds_today,
    callback_stats.callbacks_pending,
    callback_stats.callbacks_failed_today,
    overflow_stats.overflows_pending,
    overflow_stats.overflows_failed_today
  FROM ivekit_cc_queues queue
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE entry.state = 'waiting')::integer AS waiting_count,
      count(*) FILTER (WHERE entry.state = 'offered')::integer AS offered_count,
      count(*) FILTER (WHERE entry.state = 'assigned')::integer AS assigned_count,
      count(*) FILTER (WHERE entry.state = 'answered')::integer AS answered_count,
      COALESCE(floor(extract(epoch FROM (
        $4::timestamptz - min(entry.entered_at) FILTER (WHERE entry.state = 'waiting')
      ))), 0)::integer AS oldest_wait_seconds,
      COALESCE((
        SELECT avg(extract(epoch FROM (recent.ended_at - recent.answered_at)))
        FROM (
          SELECT handled.answered_at, handled.ended_at
          FROM ivekit_cc_queue_entries handled
          WHERE handled.tenant_id = queue.tenant_id AND handled.queue_id = queue.id
            AND handled.state = 'completed'
            AND handled.answered_at IS NOT NULL AND handled.ended_at IS NOT NULL
          ORDER BY handled.ended_at DESC
          LIMIT 100
        ) recent
      ), 60) AS average_handle_seconds,
      count(*) FILTER (WHERE entry.answered_at >= $2 AND entry.answered_at < $3)::integer
        AS answered_today,
      count(*) FILTER (
        WHERE entry.answered_at >= $2 AND entry.answered_at < $3
          AND extract(epoch FROM (entry.answered_at - entry.entered_at)) <= queue.service_level_seconds
      )::integer AS answered_in_service_level_today,
      count(*) FILTER (WHERE entry.state = 'abandoned'
        AND entry.ended_at >= $2 AND entry.ended_at < $3)::integer AS abandoned_today,
      count(*) FILTER (WHERE entry.state = 'timed_out'
        AND entry.ended_at >= $2 AND entry.ended_at < $3)::integer AS timed_out_today,
      count(*) FILTER (WHERE entry.state = 'overflowed'
        AND entry.ended_at >= $2 AND entry.ended_at < $3)::integer AS overflowed_today,
      COALESCE(avg(extract(epoch FROM (entry.answered_at - entry.entered_at))) FILTER (
        WHERE entry.answered_at >= $2 AND entry.answered_at < $3
      ), 0) AS average_wait_seconds_today
    FROM ivekit_cc_queue_entries entry
    WHERE entry.tenant_id = queue.tenant_id AND entry.queue_id = queue.id
  ) entry_stats ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      count(*)::integer AS available_agents,
      COALESCE(sum(presence.voice_capacity - presence.active_voice_count), 0)::integer
        AS available_capacity
    FROM ivekit_cc_queue_memberships membership
    JOIN ivekit_cc_agents agent
      ON agent.tenant_id = membership.tenant_id AND agent.id = membership.agent_id
    JOIN ivekit_cc_agent_presence presence
      ON presence.tenant_id = membership.tenant_id AND presence.agent_id = membership.agent_id
    WHERE membership.tenant_id = queue.tenant_id AND membership.queue_id = queue.id
      AND membership.enabled = TRUE AND agent.status = 'active'
      AND presence.state IN ('available', 'busy')
      AND presence.active_voice_count < presence.voice_capacity
      AND NOT EXISTS (
        SELECT 1
        FROM ivekit_cc_queue_skill_requirements requirement
        LEFT JOIN ivekit_cc_agent_skills agent_skill
          ON agent_skill.tenant_id = requirement.tenant_id
         AND agent_skill.agent_id = membership.agent_id
         AND agent_skill.skill_id = requirement.skill_id
        WHERE requirement.tenant_id = queue.tenant_id
          AND requirement.queue_id = queue.id
          AND (agent_skill.agent_id IS NULL
            OR agent_skill.proficiency < requirement.minimum_proficiency)
      )
  ) capacity ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE callback.state IN ('requested', 'scheduled', 'dialing', 'connected'))::integer
        AS callbacks_pending,
      count(*) FILTER (WHERE callback.state = 'failed'
        AND callback.completed_at >= $2 AND callback.completed_at < $3)::integer
        AS callbacks_failed_today
    FROM ivekit_cc_callbacks callback
    WHERE callback.tenant_id = queue.tenant_id AND callback.queue_id = queue.id
  ) callback_stats ON TRUE
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE overflow.state IN ('pending', 'retry_wait'))::integer
        AS overflows_pending,
      count(*) FILTER (WHERE overflow.state = 'failed'
        AND overflow.completed_at >= $2 AND overflow.completed_at < $3)::integer
        AS overflows_failed_today
    FROM ivekit_cc_overflow_actions overflow
    WHERE overflow.tenant_id = queue.tenant_id AND overflow.source_queue_id = queue.id
  ) overflow_stats ON TRUE
  WHERE queue.tenant_id = $1 AND queue.status <> 'archived'
  ORDER BY queue.name, queue.id`;

function decodeAgents(row: ContactCenterPgRow): ContactCenterMonitorAgents {
  return {
    configured: ccNumber(row.configured), active: ccNumber(row.active),
    offline: ccNumber(row.offline), available: ccNumber(row.available),
    busy: ccNumber(row.busy), after_call: ccNumber(row.after_call),
    away: ccNumber(row.away), active_voice_count: ccNumber(row.active_voice_count),
    voice_capacity: ccNumber(row.voice_capacity)
  };
}

function decodeCalls(row: ContactCenterPgRow): ContactCenterMonitorCalls {
  return {
    active_inbound: ccNumber(row.active_inbound),
    active_outbound: ccNumber(row.active_outbound)
  };
}

function decodeOperations(row: ContactCenterPgRow): ContactCenterMonitorOperations {
  return {
    callbacks_pending: ccNumber(row.callbacks_pending),
    callbacks_failed_today: ccNumber(row.callbacks_failed_today),
    overflows_pending: ccNumber(row.overflows_pending),
    overflows_failed_today: ccNumber(row.overflows_failed_today),
    supervisor_requested: ccNumber(row.supervisor_requested),
    supervisor_active: ccNumber(row.supervisor_active)
  };
}

function decodeQueue(row: ContactCenterPgRow): ContactCenterMonitorQueueProjection {
  return {
    queue_id: String(row.queue_id), queue_name: String(row.queue_name),
    status: row.status as ContactCenterQueueStatus,
    routing_strategy: row.routing_strategy as ContactCenterRoutingStrategy,
    max_wait_seconds: ccNumber(row.max_wait_seconds),
    service_level_seconds: ccNumber(row.service_level_seconds),
    waiting_count: ccNumber(row.waiting_count), offered_count: ccNumber(row.offered_count),
    assigned_count: ccNumber(row.assigned_count), answered_count: ccNumber(row.answered_count),
    available_agents: ccNumber(row.available_agents),
    available_capacity: ccNumber(row.available_capacity),
    oldest_wait_seconds: Math.max(0, Math.floor(ccNumber(row.oldest_wait_seconds))),
    average_handle_seconds: Math.max(1, Math.round(ccNumber(row.average_handle_seconds))),
    answered_today: ccNumber(row.answered_today),
    answered_in_service_level_today: ccNumber(row.answered_in_service_level_today),
    abandoned_today: ccNumber(row.abandoned_today),
    timed_out_today: ccNumber(row.timed_out_today),
    overflowed_today: ccNumber(row.overflowed_today),
    average_wait_seconds_today: Math.max(0, Math.round(ccNumber(row.average_wait_seconds_today))),
    callbacks_pending: ccNumber(row.callbacks_pending),
    callbacks_failed_today: ccNumber(row.callbacks_failed_today),
    overflows_pending: ccNumber(row.overflows_pending),
    overflows_failed_today: ccNumber(row.overflows_failed_today)
  };
}
