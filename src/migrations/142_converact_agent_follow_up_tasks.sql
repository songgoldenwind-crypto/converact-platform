-- Additive tenant-scoped Tasks created by authorized Agent Tool Actions.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_agent_follow_up_tasks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (
    id ~ '^agent-follow-up-[0-9a-f]{64}$'
  ),
  tool_call_id TEXT NOT NULL,
  customer_id TEXT NOT NULL CHECK (
    char_length(customer_id) BETWEEN 1 AND 255
  ),
  reason TEXT NOT NULL CHECK (
    char_length(reason) BETWEEN 1 AND 1024
    AND reason = btrim(reason)
    AND reason !~ '[[:cntrl:]]'
  ),
  due_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (
    state IN ('open', 'done', 'cancelled')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, tool_call_id),
  FOREIGN KEY (tenant_id, tool_call_id)
    REFERENCES converact_tool_actions(tenant_id, tool_call_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_converact_agent_follow_up_tasks_open_due
  ON converact_agent_follow_up_tasks (tenant_id, due_at, id)
  WHERE state = 'open';

ALTER TABLE converact_agent_follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_agent_follow_up_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_agent_follow_up_tasks;
CREATE POLICY tenant_isolation ON converact_agent_follow_up_tasks FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_agent_follow_up_tasks TO opc_runtime;
  END IF;
END
$grant$;
