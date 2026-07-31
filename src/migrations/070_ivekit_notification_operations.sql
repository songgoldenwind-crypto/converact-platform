CREATE TABLE IF NOT EXISTS ivekit_notification_delivery_operations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('manual_retry')),
  previous_state TEXT NOT NULL,
  next_state TEXT NOT NULL,
  previous_error_code TEXT NOT NULL DEFAULT '' CHECK (char_length(previous_error_code) <= 100),
  actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 255),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES ivekit_notification_deliveries(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_delivery_operations_timeline
  ON ivekit_notification_delivery_operations(tenant_id, delivery_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_endpoints_admin_list
  ON ivekit_notification_endpoints(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_templates_admin_list
  ON ivekit_notification_templates(tenant_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_deliveries_admin_list
  ON ivekit_notification_deliveries(tenant_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION opc_notification_delivery_transition_allowed(
  previous_state TEXT,
  next_state TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT previous_state = next_state OR CASE previous_state
    WHEN 'pending' THEN next_state IN ('processing', 'cancelled')
    WHEN 'processing' THEN next_state IN (
      'accepted', 'delivered', 'retry_wait', 'uncertain', 'failed', 'dead_letter'
    )
    WHEN 'retry_wait' THEN next_state IN ('processing', 'delivered', 'failed', 'cancelled')
    WHEN 'accepted' THEN next_state IN ('delivered', 'retry_wait', 'uncertain', 'failed')
    WHEN 'uncertain' THEN next_state IN ('delivered', 'failed', 'retry_wait', 'dead_letter')
    WHEN 'failed' THEN next_state = 'retry_wait'
    WHEN 'dead_letter' THEN next_state = 'retry_wait'
    ELSE FALSE
  END
$$;

DROP TRIGGER IF EXISTS ivekit_notification_delivery_operations_immutable
  ON ivekit_notification_delivery_operations;
CREATE TRIGGER ivekit_notification_delivery_operations_immutable
  BEFORE UPDATE OR DELETE ON ivekit_notification_delivery_operations
  FOR EACH ROW EXECUTE FUNCTION opc_notification_immutable_guard();

ALTER TABLE ivekit_notification_delivery_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_delivery_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_delivery_operations;
CREATE POLICY tenant_isolation ON ivekit_notification_delivery_operations FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON ivekit_notification_delivery_operations TO opc_runtime;
  END IF;
END
$$;
