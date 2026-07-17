CREATE TABLE IF NOT EXISTS ivekit_retention_policies (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'notifications', 'audit', 'rate_limit_buckets', 'secure_files',
    'media_recordings', 'tenant_events'
  )),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
  batch_size INTEGER NOT NULL DEFAULT 100 CHECK (batch_size BETWEEN 1 AND 1000),
  interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (interval_seconds BETWEEN 60 AND 86400),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, category)
);

CREATE INDEX IF NOT EXISTS idx_ivekit_retention_policies_due
  ON ivekit_retention_policies(enabled, next_run_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS ivekit_legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN (
    'notifications', 'audit', 'rate_limit_buckets', 'secure_files',
    'media_recordings', 'tenant_events'
  )),
  resource_type TEXT NOT NULL CHECK (char_length(resource_type) BETWEEN 1 AND 100),
  resource_id TEXT NOT NULL CHECK (char_length(resource_id) BETWEEN 1 AND 255),
  reason_code TEXT NOT NULL CHECK (reason_code ~ '^[a-z0-9_.-]{1,100}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  placed_by TEXT NOT NULL,
  released_by TEXT,
  placed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_legal_holds_active_resource
  ON ivekit_legal_holds(tenant_id, category, resource_type, resource_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ivekit_legal_holds_lookup
  ON ivekit_legal_holds(tenant_id, category, resource_type, resource_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ivekit_retention_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'processing'
    CHECK (state IN ('processing', 'completed', 'failed')),
  cutoff_at TIMESTAMPTZ NOT NULL,
  scanned_count INTEGER NOT NULL DEFAULT 0 CHECK (scanned_count >= 0),
  deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0),
  held_count INTEGER NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  error_code TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id, category)
    REFERENCES ivekit_retention_policies(tenant_id, category) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_retention_runs_timeline
  ON ivekit_retention_runs(tenant_id, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ivekit_audit_retention_checkpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  retention_run_id TEXT NOT NULL REFERENCES ivekit_retention_runs(id) ON DELETE RESTRICT,
  cutoff_at TIMESTAMPTZ NOT NULL,
  first_event_hash TEXT NOT NULL CHECK (char_length(first_event_hash) = 64),
  last_event_hash TEXT NOT NULL CHECK (char_length(last_event_hash) = 64),
  event_hashes JSONB NOT NULL CHECK (jsonb_typeof(event_hashes) = 'array'),
  deleted_count INTEGER NOT NULL CHECK (deleted_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, retention_run_id)
);

CREATE OR REPLACE FUNCTION opc_ivekit_audit_checkpoint_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'iveKit audit retention checkpoints are immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS ivekit_audit_retention_checkpoints_immutable
  ON ivekit_audit_retention_checkpoints;
CREATE TRIGGER ivekit_audit_retention_checkpoints_immutable
  BEFORE UPDATE OR DELETE ON ivekit_audit_retention_checkpoints
  FOR EACH ROW EXECUTE FUNCTION opc_ivekit_audit_checkpoint_immutable_guard();

CREATE OR REPLACE FUNCTION opc_ivekit_retention_tenant_ids(p_limit INTEGER)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT policy.tenant_id
  FROM public.ivekit_retention_policies policy
  WHERE policy.enabled = TRUE
    AND policy.next_run_at <= CURRENT_TIMESTAMP
    AND (policy.lease_expires_at IS NULL OR policy.lease_expires_at <= CURRENT_TIMESTAMP)
  ORDER BY policy.tenant_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_event_retention_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT event.tenant_id
  FROM public.ivekit_tenant_events event
  WHERE event.expires_at <= p_now
    AND NOT EXISTS (
      SELECT 1 FROM public.ivekit_legal_holds hold
      WHERE hold.tenant_id = event.tenant_id
        AND hold.category = 'tenant_events'
        AND hold.resource_type = 'tenant_event'
        AND hold.resource_id = event.id::text
        AND hold.status = 'active'
    )
  GROUP BY event.tenant_id
  ORDER BY min(event.expires_at), event.tenant_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_delete_expired_audit_events(
  p_tenant_id TEXT,
  p_retention_run_id TEXT,
  p_cutoff_at TIMESTAMPTZ,
  p_started_at TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  IF NOT (public.opc_rls_bypass() OR p_tenant_id = public.opc_current_tenant()) THEN
    RAISE EXCEPTION 'tenant scope denied' USING ERRCODE = '42501';
  END IF;
  PERFORM set_config('app.audit_retention_cleanup', 'on', TRUE);
  WITH candidates AS MATERIALIZED (
    SELECT event.id, event.event_hash, event.occurred_at
    FROM public.ivekit_audit_events event
    WHERE event.tenant_id = p_tenant_id
      AND event.legal_hold = FALSE
      AND (
        event.retention_until <= p_started_at
        OR (event.retention_until IS NULL AND event.occurred_at <= p_cutoff_at)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.ivekit_legal_holds hold
        WHERE hold.tenant_id = event.tenant_id
          AND hold.category = 'audit'
          AND hold.resource_type = 'audit_event'
          AND hold.resource_id = event.id
          AND hold.status = 'active'
      )
    ORDER BY event.occurred_at, event.id
    LIMIT LEAST(GREATEST(p_limit, 1), 1000)
    FOR UPDATE SKIP LOCKED
  ), checkpoint AS (
    INSERT INTO public.ivekit_audit_retention_checkpoints
      (id, tenant_id, retention_run_id, cutoff_at, first_event_hash,
       last_event_hash, event_hashes, deleted_count)
    SELECT p_retention_run_id, p_tenant_id, p_retention_run_id, p_cutoff_at,
      (array_agg(event_hash ORDER BY occurred_at, id))[1],
      (array_agg(event_hash ORDER BY occurred_at DESC, id DESC))[1],
      jsonb_agg(event_hash ORDER BY occurred_at, id),
      COUNT(*)::INTEGER
    FROM candidates
    HAVING COUNT(*) > 0
    ON CONFLICT (tenant_id, retention_run_id) DO NOTHING
    RETURNING id
  ), deleted AS (
    DELETE FROM public.ivekit_audit_events event
    USING candidates, checkpoint
    WHERE event.tenant_id = p_tenant_id AND event.id = candidates.id
    RETURNING event.id
  )
  SELECT COUNT(*)::INTEGER INTO deleted_count FROM deleted;
  RETURN deleted_count;
END
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_audit_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE'
    AND current_setting('app.audit_retention_cleanup', TRUE) = 'on'
    AND OLD.legal_hold = FALSE
    AND NOT EXISTS (
      SELECT 1 FROM public.ivekit_legal_holds hold
      WHERE hold.tenant_id = OLD.tenant_id
        AND hold.category = 'audit'
        AND hold.resource_type = 'audit_event'
        AND hold.resource_id = OLD.id
        AND hold.status = 'active'
    ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'iveKit audit history is immutable' USING ERRCODE = '55000';
END
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ivekit_retention_policies', 'ivekit_legal_holds', 'ivekit_retention_runs',
    'ivekit_audit_retention_checkpoints'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL USING (opc_rls_bypass() OR tenant_id = opc_current_tenant()) WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant())',
      table_name
    );
  END LOOP;
END
$$;

REVOKE ALL ON FUNCTION opc_ivekit_retention_tenant_ids(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_delete_expired_audit_events(
  TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_ivekit_audit_checkpoint_immutable_guard() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON ivekit_retention_policies TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON ivekit_legal_holds TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON ivekit_retention_runs TO opc_runtime;
    GRANT SELECT ON ivekit_audit_retention_checkpoints TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_retention_tenant_ids(INTEGER) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_event_retention_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_ivekit_delete_expired_audit_events(
      TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER
    ) TO opc_runtime;
  END IF;
END
$$;
