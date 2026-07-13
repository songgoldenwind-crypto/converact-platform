CREATE TABLE IF NOT EXISTS ivekit_cc_overflow_actions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_entry_id TEXT NOT NULL,
  source_queue_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  action TEXT NOT NULL CHECK (action IN ('queue', 'voicemail', 'hangup', 'external')),
  target_queue_id TEXT,
  target TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'retry_wait', 'completed', 'failed')),
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result_ref TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, source_entry_id)
    REFERENCES ivekit_cc_queue_entries(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, source_queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, target_queue_id)
    REFERENCES ivekit_cc_queues(tenant_id, id) ON DELETE RESTRICT,
  CHECK (attempt_count <= max_attempts),
  CHECK (
    (action = 'queue' AND target_queue_id IS NOT NULL AND target = '')
    OR (action IN ('voicemail', 'external') AND target_queue_id IS NULL AND target <> '')
    OR (action = 'hangup' AND target_queue_id IS NULL AND target = '')
  ),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_entry_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_cc_overflow_due
  ON ivekit_cc_overflow_actions(tenant_id, scheduled_for, id)
  WHERE state IN ('pending', 'retry_wait');

DROP TRIGGER IF EXISTS ivekit_cc_overflow_actions_immutable_delete
  ON ivekit_cc_overflow_actions;
CREATE TRIGGER ivekit_cc_overflow_actions_immutable_delete
BEFORE DELETE ON ivekit_cc_overflow_actions
FOR EACH ROW EXECUTE FUNCTION opc_ivekit_cc_reject_delete();

ALTER TABLE ivekit_cc_overflow_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_cc_overflow_actions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_cc_overflow_actions;
CREATE POLICY tenant_isolation ON ivekit_cc_overflow_actions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

CREATE OR REPLACE FUNCTION opc_ivekit_cc_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT pending.tenant_id
  FROM (
    SELECT assignment.tenant_id, min(assignment.offer_expires_at) AS due_at
    FROM public.ivekit_cc_assignments assignment
    WHERE assignment.state = 'offered' AND assignment.offer_expires_at <= p_now
    GROUP BY assignment.tenant_id

    UNION ALL

    SELECT entry.tenant_id, min(entry.timeout_at) AS due_at
    FROM public.ivekit_cc_queue_entries entry
    WHERE entry.state = 'waiting' AND entry.timeout_at IS NOT NULL
      AND entry.timeout_at <= p_now
    GROUP BY entry.tenant_id

    UNION ALL

    SELECT entry.tenant_id, min(entry.entered_at) AS due_at
    FROM public.ivekit_cc_queue_entries entry
    JOIN public.ivekit_cc_queues queue
      ON queue.tenant_id = entry.tenant_id AND queue.id = entry.queue_id
    WHERE entry.state = 'waiting' AND queue.status = 'active'
      AND (entry.timeout_at IS NULL OR entry.timeout_at > p_now)
      AND EXISTS (
        SELECT 1
        FROM public.ivekit_cc_queue_memberships membership
        JOIN public.ivekit_cc_agents agent
          ON agent.tenant_id = membership.tenant_id AND agent.id = membership.agent_id
        JOIN public.ivekit_cc_agent_presence presence
          ON presence.tenant_id = membership.tenant_id
         AND presence.agent_id = membership.agent_id
        WHERE membership.tenant_id = entry.tenant_id
          AND membership.queue_id = entry.queue_id
          AND membership.enabled = TRUE AND agent.status = 'active'
          AND presence.state IN ('available', 'busy')
          AND presence.active_voice_count < presence.voice_capacity
          AND NOT EXISTS (
            SELECT 1
            FROM public.ivekit_cc_queue_skill_requirements requirement
            LEFT JOIN public.ivekit_cc_agent_skills required_skill
              ON required_skill.tenant_id = requirement.tenant_id
             AND required_skill.agent_id = membership.agent_id
             AND required_skill.skill_id = requirement.skill_id
            WHERE requirement.tenant_id = membership.tenant_id
              AND requirement.queue_id = membership.queue_id
              AND (required_skill.agent_id IS NULL
                OR required_skill.proficiency < requirement.minimum_proficiency)
          )
      )
    GROUP BY entry.tenant_id

    UNION ALL

    SELECT callback.tenant_id,
           min(COALESCE(callback.scheduled_for, callback.created_at)) AS due_at
    FROM public.ivekit_cc_callbacks callback
    WHERE callback.state IN ('requested', 'scheduled')
      AND COALESCE(callback.scheduled_for, callback.created_at) <= p_now
    GROUP BY callback.tenant_id

    UNION ALL

    SELECT callback.tenant_id, min(callback.updated_at) AS due_at
    FROM public.ivekit_cc_callbacks callback
    WHERE callback.state IN ('dialing', 'connected')
      AND callback.outbound_call_id IS NOT NULL
    GROUP BY callback.tenant_id

    UNION ALL

    SELECT overflow.tenant_id, min(overflow.scheduled_for) AS due_at
    FROM public.ivekit_cc_overflow_actions overflow
    WHERE overflow.state IN ('pending', 'retry_wait')
      AND overflow.scheduled_for <= p_now
    GROUP BY overflow.tenant_id
  ) pending
  GROUP BY pending.tenant_id
  ORDER BY min(pending.due_at), pending.tenant_id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

REVOKE ALL ON FUNCTION opc_ivekit_cc_worker_tenant_ids(TIMESTAMPTZ, INTEGER)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT EXECUTE ON FUNCTION opc_ivekit_cc_worker_tenant_ids(TIMESTAMPTZ, INTEGER)
      TO opc_runtime;
  END IF;
END
$$;
