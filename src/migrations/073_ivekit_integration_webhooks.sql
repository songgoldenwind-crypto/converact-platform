CREATE TABLE IF NOT EXISTS ivekit_event_webhook_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  event_patterns TEXT[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'archived')),
  last_event_id BIGINT NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_code TEXT NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 100),
  lease_token_hash TEXT NOT NULL DEFAULT '' CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[a-f0-9]{64}$'
  ),
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '' CHECK (char_length(worker_id) <= 255),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 255),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES ivekit_notification_endpoints(tenant_id, id) ON DELETE RESTRICT,
  CHECK (cardinality(event_patterns) BETWEEN 1 AND 64),
  CHECK (lease_until IS NULL OR lease_token_hash <> '')
);

CREATE INDEX IF NOT EXISTS idx_ivekit_event_webhook_subscriptions_worker
  ON ivekit_event_webhook_subscriptions(
    tenant_id, status, next_attempt_at, lease_until, last_event_id, id
  );

CREATE OR REPLACE FUNCTION opc_event_webhook_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT subscription.tenant_id
  FROM public.ivekit_event_webhook_subscriptions subscription
  WHERE subscription.status = 'active'
    AND subscription.next_attempt_at <= p_now
    AND (subscription.lease_until IS NULL OR subscription.lease_until <= p_now)
    AND EXISTS (
      SELECT 1
      FROM public.ivekit_tenant_events event
      WHERE event.tenant_id = subscription.tenant_id
        AND event.id > subscription.last_event_id
        AND event.expires_at > p_now
    )
  GROUP BY subscription.tenant_id
  ORDER BY min(subscription.next_attempt_at), subscription.tenant_id
  LIMIT least(greatest(p_limit, 1), 1000);
$$;

ALTER TABLE ivekit_event_webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_event_webhook_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_event_webhook_subscriptions;
CREATE POLICY tenant_isolation ON ivekit_event_webhook_subscriptions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_event_webhook_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_event_webhook_subscriptions TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_event_webhook_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
  END IF;
END
$$;
