CREATE TABLE IF NOT EXISTS ivekit_notification_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_key TEXT NOT NULL CHECK (char_length(template_key) BETWEEN 1 AND 128),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 255),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, template_key),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS ivekit_notification_template_versions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  locale TEXT NOT NULL CHECK (char_length(locale) BETWEEN 2 AND 35),
  channels TEXT[] NOT NULL,
  content JSONB NOT NULL,
  content_hash TEXT NOT NULL CHECK (char_length(content_hash) = 64),
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, template_id, revision, locale),
  FOREIGN KEY (tenant_id, template_id)
    REFERENCES ivekit_notification_templates(tenant_id, id) ON DELETE CASCADE,
  CHECK (cardinality(channels) BETWEEN 1 AND 4),
  CHECK (channels <@ ARRAY['in_app', 'webhook', 'email', 'sms']::TEXT[]),
  CHECK (NOT published OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS ivekit_notification_preferences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 255),
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 255),
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'webhook', 'email', 'sms')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  locale TEXT NOT NULL DEFAULT '' CHECK (char_length(locale) <= 35),
  quiet_hours JSONB NOT NULL DEFAULT '{}'::JSONB,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id, event_type, channel)
);

CREATE TABLE IF NOT EXISTS ivekit_notification_endpoints (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  channel TEXT NOT NULL CHECK (channel IN ('webhook', 'email', 'sms')),
  provider_kind TEXT NOT NULL
    CHECK (provider_kind IN ('webhook', 'smtp', 'email_http', 'sms_http', 'controlled')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'degraded', 'disabled', 'archived')),
  endpoint_url TEXT NOT NULL DEFAULT '' CHECK (char_length(endpoint_url) <= 2048),
  secret_ref TEXT NOT NULL DEFAULT '' CHECK (char_length(secret_ref) <= 1024),
  signing_secret_ref TEXT NOT NULL DEFAULT '' CHECK (char_length(signing_secret_ref) <= 1024),
  event_allowlist TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  config JSONB NOT NULL DEFAULT '{}'::JSONB,
  failover_group TEXT NOT NULL DEFAULT 'default' CHECK (char_length(failover_group) <= 128),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  quota_per_minute INTEGER CHECK (quota_per_minute IS NULL OR quota_per_minute > 0),
  quota_per_day INTEGER CHECK (quota_per_day IS NULL OR quota_per_day > 0),
  health_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unhealthy')),
  last_health_at TIMESTAMPTZ,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 255),
  updated_by TEXT NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, name),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  CHECK (secret_ref = '' OR secret_ref ~ '^(env|vault|secret)://'),
  CHECK (signing_secret_ref = '' OR signing_secret_ref ~ '^(env|vault|secret)://')
);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_endpoints_resolution
  ON ivekit_notification_endpoints(tenant_id, channel, status, failover_group, priority, id);

CREATE TABLE IF NOT EXISTS ivekit_notification_endpoint_runtime (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL,
  circuit_state TEXT NOT NULL DEFAULT 'closed'
    CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  circuit_open_until TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_error_code TEXT NOT NULL DEFAULT '' CHECK (char_length(last_error_code) <= 100),
  minute_bucket TIMESTAMPTZ,
  minute_used INTEGER NOT NULL DEFAULT 0 CHECK (minute_used >= 0),
  day_bucket DATE,
  day_used INTEGER NOT NULL DEFAULT 0 CHECK (day_used >= 0),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, endpoint_id),
  FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES ivekit_notification_endpoints(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_endpoint_runtime_circuit
  ON ivekit_notification_endpoint_runtime(tenant_id, circuit_state, circuit_open_until, endpoint_id);

CREATE TABLE IF NOT EXISTS ivekit_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 255),
  recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('user', 'external', 'endpoint')),
  recipient_ref TEXT NOT NULL DEFAULT '' CHECK (char_length(recipient_ref) <= 255),
  channels TEXT[] NOT NULL,
  locale TEXT NOT NULL DEFAULT '' CHECK (char_length(locale) <= 35),
  template_id TEXT,
  template_revision INTEGER CHECK (template_revision IS NULL OR template_revision > 0),
  content_ciphertext TEXT NOT NULL CHECK (char_length(content_ciphertext) BETWEEN 1 AND 1048576),
  content_projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  force_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  business_ref_type TEXT NOT NULL CHECK (char_length(business_ref_type) BETWEEN 1 AND 100),
  business_ref_id TEXT NOT NULL CHECK (char_length(business_ref_id) BETWEEN 1 AND 255),
  requested_by TEXT NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 255),
  correlation_id TEXT NOT NULL DEFAULT '' CHECK (char_length(correlation_id) <= 255),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  policy JSONB NOT NULL DEFAULT '{}'::JSONB,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'completed', 'partial_failed', 'failed', 'cancelled')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retention_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, template_id)
    REFERENCES ivekit_notification_templates(tenant_id, id) ON DELETE RESTRICT,
  CHECK (cardinality(channels) BETWEEN 1 AND 4),
  CHECK (channels <@ ARRAY['in_app', 'webhook', 'email', 'sms']::TEXT[]),
  CHECK ((template_id IS NULL) = (template_revision IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_ivekit_notifications_business_ref
  ON ivekit_notifications(tenant_id, business_ref_type, business_ref_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_ivekit_notifications_recipient
  ON ivekit_notifications(tenant_id, recipient_kind, recipient_ref, created_at DESC, id);

CREATE TABLE IF NOT EXISTS ivekit_notification_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in_app', 'webhook', 'email', 'sms')),
  endpoint_id TEXT,
  provider_kind TEXT NOT NULL CHECK (char_length(provider_kind) BETWEEN 1 AND 50),
  provider_profile_id TEXT NOT NULL DEFAULT '' CHECK (char_length(provider_profile_id) <= 255),
  recipient_ciphertext TEXT NOT NULL CHECK (char_length(recipient_ciphertext) BETWEEN 1 AND 16384),
  recipient_hmac TEXT NOT NULL CHECK (char_length(recipient_hmac) = 64),
  recipient_redacted TEXT NOT NULL CHECK (char_length(recipient_redacted) BETWEEN 1 AND 255),
  payload_ciphertext TEXT NOT NULL CHECK (char_length(payload_ciphertext) BETWEEN 1 AND 1048576),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  provider_idempotency_key TEXT NOT NULL CHECK (char_length(provider_idempotency_key) BETWEEN 1 AND 255),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN (
      'pending', 'processing', 'accepted', 'retry_wait', 'uncertain',
      'delivered', 'failed', 'cancelled', 'dead_letter'
    )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ,
  lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (lease_token_hash = '' OR char_length(lease_token_hash) = 64),
  lease_until TIMESTAMPTZ,
  worker_id TEXT NOT NULL DEFAULT '' CHECK (char_length(worker_id) <= 255),
  provider_request_id TEXT NOT NULL DEFAULT '' CHECK (char_length(provider_request_id) <= 255),
  provider_message_id TEXT NOT NULL DEFAULT '' CHECK (char_length(provider_message_id) <= 255),
  provider_receipt_projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  error_code TEXT NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 100),
  error_projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, provider_idempotency_key),
  FOREIGN KEY (tenant_id, notification_id)
    REFERENCES ivekit_notifications(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, endpoint_id)
    REFERENCES ivekit_notification_endpoints(tenant_id, id) ON DELETE RESTRICT,
  CHECK (channel != 'in_app' OR endpoint_id IS NULL),
  CHECK (state != 'delivered' OR delivered_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_notification_deliveries_target
  ON ivekit_notification_deliveries(
    tenant_id, notification_id, channel, recipient_hmac, COALESCE(endpoint_id, '')
  );

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_deliveries_due
  ON ivekit_notification_deliveries(
    state, next_attempt_at, lease_until, updated_at, tenant_id, id
  ) WHERE state IN ('pending', 'processing', 'retry_wait');

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_deliveries_uncertain
  ON ivekit_notification_deliveries(tenant_id, state, updated_at, id)
  WHERE state = 'uncertain';

CREATE TABLE IF NOT EXISTS ivekit_notification_inbox_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL,
  user_id TEXT NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 255),
  projection JSONB NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, notification_id, user_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, notification_id)
    REFERENCES ivekit_notifications(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_inbox_user
  ON ivekit_notification_inbox_items(tenant_id, user_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_inbox_unread
  ON ivekit_notification_inbox_items(tenant_id, user_id, created_at DESC, id)
  WHERE read_at IS NULL AND archived_at IS NULL;

CREATE TABLE IF NOT EXISTS ivekit_notification_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL CHECK (char_length(provider_kind) BETWEEN 1 AND 50),
  provider_event_id TEXT NOT NULL CHECK (char_length(provider_event_id) BETWEEN 1 AND 255),
  receipt_status TEXT NOT NULL
    CHECK (receipt_status IN ('accepted', 'delivered', 'failed', 'unknown')),
  canonical_hash TEXT NOT NULL CHECK (char_length(canonical_hash) = 64),
  projection JSONB NOT NULL DEFAULT '{}'::JSONB,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, provider_kind, provider_event_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, delivery_id)
    REFERENCES ivekit_notification_deliveries(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ivekit_notification_receipts_delivery
  ON ivekit_notification_receipts(tenant_id, delivery_id, received_at, id);

CREATE OR REPLACE FUNCTION opc_notification_worker_tenant_ids(
  p_now TIMESTAMPTZ,
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT delivery.tenant_id
  FROM public.ivekit_notification_deliveries delivery
  WHERE (
      delivery.state IN ('pending', 'retry_wait')
      AND (delivery.next_attempt_at IS NULL OR delivery.next_attempt_at <= p_now)
    ) OR (
      delivery.state = 'processing'
      AND (delivery.lease_until IS NULL OR delivery.lease_until <= p_now)
    )
  GROUP BY delivery.tenant_id
  ORDER BY MIN(delivery.updated_at), delivery.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

CREATE OR REPLACE FUNCTION opc_notification_receipt_tenant_ids(
  p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(tenant_id TEXT)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT receipt.tenant_id
  FROM public.ivekit_notification_receipts receipt
  JOIN public.ivekit_notification_deliveries delivery
    ON delivery.tenant_id = receipt.tenant_id AND delivery.id = receipt.delivery_id
  WHERE receipt.receipt_status IN ('delivered', 'failed')
    AND delivery.state IN ('processing', 'accepted', 'retry_wait', 'uncertain')
  GROUP BY receipt.tenant_id
  ORDER BY MIN(receipt.received_at), receipt.tenant_id
  LIMIT GREATEST(1, LEAST(p_limit, 1000))
$$;

CREATE OR REPLACE FUNCTION opc_notification_queue_metrics(
  p_now TIMESTAMPTZ
)
RETURNS TABLE(state TEXT, depth BIGINT, oldest_age_seconds DOUBLE PRECISION)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT delivery.state,
    COUNT(*) AS depth,
    GREATEST(0, EXTRACT(EPOCH FROM (
      p_now - MIN(COALESCE(delivery.next_attempt_at, delivery.updated_at))
    )))::DOUBLE PRECISION AS oldest_age_seconds
  FROM public.ivekit_notification_deliveries delivery
  WHERE delivery.state IN ('pending', 'processing', 'accepted', 'retry_wait', 'uncertain')
  GROUP BY delivery.state
$$;

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
    ELSE FALSE
  END
$$;

CREATE OR REPLACE FUNCTION opc_notification_delivery_state_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT opc_notification_delivery_transition_allowed(OLD.state, NEW.state) THEN
    RAISE EXCEPTION 'invalid notification delivery transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ivekit_notification_deliveries_state_guard
  ON ivekit_notification_deliveries;
CREATE TRIGGER ivekit_notification_deliveries_state_guard
  BEFORE UPDATE OF state ON ivekit_notification_deliveries
  FOR EACH ROW EXECUTE FUNCTION opc_notification_delivery_state_guard();

CREATE OR REPLACE FUNCTION opc_notification_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'notification history is immutable'
    USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS ivekit_notification_template_versions_immutable
  ON ivekit_notification_template_versions;
CREATE TRIGGER ivekit_notification_template_versions_immutable
  BEFORE UPDATE OR DELETE ON ivekit_notification_template_versions
  FOR EACH ROW EXECUTE FUNCTION opc_notification_immutable_guard();

DROP TRIGGER IF EXISTS ivekit_notification_receipts_append_only
  ON ivekit_notification_receipts;
CREATE TRIGGER ivekit_notification_receipts_append_only
  BEFORE UPDATE OR DELETE ON ivekit_notification_receipts
  FOR EACH ROW EXECUTE FUNCTION opc_notification_immutable_guard();

ALTER TABLE ivekit_notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_templates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_templates;
CREATE POLICY tenant_isolation ON ivekit_notification_templates FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_template_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_template_versions;
CREATE POLICY tenant_isolation ON ivekit_notification_template_versions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_preferences;
CREATE POLICY tenant_isolation ON ivekit_notification_preferences FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_endpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_endpoints;
CREATE POLICY tenant_isolation ON ivekit_notification_endpoints FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_endpoint_runtime ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_endpoint_runtime FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_endpoint_runtime;
CREATE POLICY tenant_isolation ON ivekit_notification_endpoint_runtime FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notifications;
CREATE POLICY tenant_isolation ON ivekit_notifications FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_deliveries;
CREATE POLICY tenant_isolation ON ivekit_notification_deliveries FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_inbox_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_inbox_items;
CREATE POLICY tenant_isolation ON ivekit_notification_inbox_items FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_notification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_notification_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_notification_receipts;
CREATE POLICY tenant_isolation ON ivekit_notification_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_notification_worker_tenant_ids(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_receipt_tenant_ids(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_queue_metrics(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_delivery_transition_allowed(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_delivery_state_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_notification_immutable_guard() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_templates TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_template_versions TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_preferences TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_endpoints TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_endpoint_runtime TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notifications TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_deliveries TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ivekit_notification_inbox_items TO opc_runtime;
    GRANT SELECT, INSERT ON ivekit_notification_receipts TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_notification_worker_tenant_ids(TIMESTAMPTZ, INTEGER) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_notification_receipt_tenant_ids(INTEGER) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_notification_queue_metrics(TIMESTAMPTZ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION opc_notification_delivery_transition_allowed(TEXT, TEXT) TO opc_runtime;
  END IF;
END
$$;
