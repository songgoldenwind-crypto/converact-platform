CREATE TABLE IF NOT EXISTS converact_platform_outbox (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  source_schema_version INTEGER NOT NULL CHECK (source_schema_version IN (1, 2)),
  producer_identity TEXT NOT NULL,
  authority TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision BIGINT NOT NULL CHECK (aggregate_revision >= 0),
  ordering_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (char_length(payload_digest) = 64),
  payload JSONB NOT NULL,
  correlation JSONB NOT NULL,
  purpose TEXT NOT NULL,
  region_policy TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'delivered', 'dead_letter')),
  worker_id TEXT NOT NULL DEFAULT '',
  lease_token_hash TEXT NOT NULL DEFAULT ''
    CHECK (lease_token_hash = '' OR char_length(lease_token_hash) = 64),
  lease_until TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurred_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_converact_platform_outbox_claim
  ON converact_platform_outbox (tenant_id, status, next_attempt_at, id)
  WHERE status IN ('pending', 'claimed');

CREATE TABLE IF NOT EXISTS converact_platform_inbox (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  consumer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (char_length(payload_digest) = 64),
  aggregate_revision BIGINT NOT NULL CHECK (aggregate_revision >= 0),
  ordering_key TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, consumer_id, event_id),
  UNIQUE (tenant_id, consumer_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_converact_platform_inbox_order
  ON converact_platform_inbox (tenant_id, consumer_id, ordering_key, aggregate_revision DESC);

CREATE TABLE IF NOT EXISTS converact_platform_effect_receipts (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('accepted', 'completed', 'state_observed')),
  generation BIGINT NOT NULL CHECK (generation > 0),
  writer_id TEXT NOT NULL,
  owner_epoch BIGINT NOT NULL CHECK (owner_epoch >= 0),
  receipt_digest TEXT NOT NULL CHECK (char_length(receipt_digest) = 64),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, effect_id, stage, generation),
  UNIQUE (tenant_id, effect_id, generation, receipt_digest)
);

CREATE INDEX IF NOT EXISTS idx_converact_platform_effect_generation
  ON converact_platform_effect_receipts (tenant_id, effect_id, generation DESC, stage);

CREATE OR REPLACE FUNCTION opc_converact_platform_event_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'platform event history is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_platform_inbox_append_only ON converact_platform_inbox;
CREATE TRIGGER converact_platform_inbox_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_inbox
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_event_history_guard();

DROP TRIGGER IF EXISTS converact_platform_effect_receipts_append_only
  ON converact_platform_effect_receipts;
CREATE TRIGGER converact_platform_effect_receipts_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_effect_receipts
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_event_history_guard();

ALTER TABLE converact_platform_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_outbox;
CREATE POLICY tenant_isolation ON converact_platform_outbox FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_inbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_inbox;
CREATE POLICY tenant_isolation ON converact_platform_inbox FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_effect_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_platform_effect_receipts;
CREATE POLICY tenant_isolation ON converact_platform_effect_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION opc_converact_platform_event_history_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON converact_platform_outbox TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_inbox TO opc_runtime;
    GRANT SELECT, INSERT ON converact_platform_effect_receipts TO opc_runtime;
  END IF;
END
$grant$;
