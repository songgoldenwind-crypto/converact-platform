CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_durability_contracts (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL,
  store_kind TEXT NOT NULL
    CHECK (store_kind IN ('cloudnativepg', 'postgresql_sync_quorum')),
  fault_domains TEXT[] NOT NULL
    CHECK (cardinality(fault_domains) BETWEEN 2 AND 32),
  quorum_size SMALLINT NOT NULL CHECK (quorum_size BETWEEN 2 AND 32),
  status TEXT NOT NULL
    CHECK (status IN ('active', 'unavailable', 'disabled')),
  config_hash TEXT NOT NULL CHECK (char_length(config_hash) = 64),
  verified_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, region_id),
  CHECK (quorum_size <= cardinality(fault_domains))
);

ALTER TABLE ivekit_voice_dialog_ownership
  ADD COLUMN IF NOT EXISTS terminal_shadow_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS terminal_cdr_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS terminal_cdr_payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS terminal_cdr_call_id TEXT,
  ADD COLUMN IF NOT EXISTS terminal_cdr_receipt_id TEXT,
  ADD COLUMN IF NOT EXISTS terminal_cdr_region_id TEXT,
  ADD COLUMN IF NOT EXISTS terminal_cdr_durability_contract_id TEXT;

ALTER TABLE ivekit_voice_dialog_ownership
  DROP CONSTRAINT IF EXISTS chk_ivekit_dialog_terminal_cdr_pair,
  ADD CONSTRAINT chk_ivekit_dialog_terminal_cdr_pair CHECK (
    (
      terminal_cdr_sequence IS NULL AND
      terminal_cdr_payload_hash IS NULL AND
      terminal_cdr_call_id IS NULL AND
      terminal_cdr_receipt_id IS NULL AND
      terminal_cdr_region_id IS NULL AND
      terminal_cdr_durability_contract_id IS NULL
    ) OR (
      terminal_cdr_sequence IS NOT NULL AND
      terminal_cdr_payload_hash IS NOT NULL AND
      terminal_cdr_call_id IS NOT NULL AND
      terminal_cdr_receipt_id IS NOT NULL AND
      terminal_cdr_region_id IS NOT NULL AND
      terminal_cdr_durability_contract_id IS NOT NULL
    )
  ),
  DROP CONSTRAINT IF EXISTS chk_ivekit_dialog_terminal_cdr_sequence,
  ADD CONSTRAINT chk_ivekit_dialog_terminal_cdr_sequence CHECK (
    terminal_cdr_sequence IS NULL OR
    terminal_cdr_sequence BETWEEN 1 AND 9007199254740991
  ),
  DROP CONSTRAINT IF EXISTS chk_ivekit_dialog_terminal_cdr_hash,
  ADD CONSTRAINT chk_ivekit_dialog_terminal_cdr_hash CHECK (
    terminal_cdr_payload_hash IS NULL OR
    char_length(terminal_cdr_payload_hash) = 64
  ),
  DROP CONSTRAINT IF EXISTS chk_ivekit_dialog_terminal_shadow_fence,
  ADD CONSTRAINT chk_ivekit_dialog_terminal_shadow_fence CHECK (
    NOT terminal_shadow_pending OR (
      terminal = TRUE AND
      terminal_cdr_sequence IS NOT NULL AND
      terminal_cdr_payload_hash IS NOT NULL AND
      terminal_cdr_call_id IS NOT NULL AND
      terminal_cdr_receipt_id IS NOT NULL AND
      terminal_cdr_region_id IS NOT NULL AND
      terminal_cdr_durability_contract_id IS NOT NULL
    )
  );

CREATE TABLE IF NOT EXISTS ivekit_voice_dialog_terminal_repairs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cell_id TEXT NOT NULL,
  call_session_ref TEXT NOT NULL,
  source_owner_node_id TEXT NOT NULL,
  source_owner_fault_domain TEXT NOT NULL,
  source_owner_epoch BIGINT NOT NULL
    CHECK (source_owner_epoch BETWEEN 1 AND 4294967294),
  source_pair_hash TEXT NOT NULL CHECK (char_length(source_pair_hash) = 64),
  repair_owner_node_id TEXT NOT NULL,
  repair_owner_fault_domain TEXT NOT NULL,
  repair_owner_epoch BIGINT NOT NULL
    CHECK (repair_owner_epoch BETWEEN 2 AND 4294967295),
  terminal_cdr_sequence BIGINT NOT NULL
    CHECK (terminal_cdr_sequence BETWEEN 1 AND 9007199254740991),
  terminal_cdr_payload_hash TEXT NOT NULL
    CHECK (char_length(terminal_cdr_payload_hash) = 64),
  terminal_cdr_call_id TEXT NOT NULL,
  terminal_cdr_receipt_id TEXT NOT NULL,
  terminal_cdr_region_id TEXT NOT NULL,
  terminal_cdr_durability_contract_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed', 'committed', 'expired')),
  claimed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  terminal_pair_hash TEXT CHECK (
    terminal_pair_hash IS NULL OR char_length(terminal_pair_hash) = 64
  ),
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (tenant_id, cell_id, call_session_ref)
    REFERENCES ivekit_voice_dialog_ownership(
      tenant_id,
      cell_id,
      call_session_ref
    ) ON DELETE CASCADE,
  UNIQUE (tenant_id, cell_id, call_session_ref, repair_owner_epoch),
  CHECK (repair_owner_epoch > source_owner_epoch),
  CHECK (expires_at > claimed_at),
  CHECK (
    (
      state = 'committed' AND
      completed_at IS NOT NULL AND
      terminal_pair_hash IS NOT NULL
    ) OR (
      state IN ('claimed', 'expired') AND
      completed_at IS NULL AND
      terminal_pair_hash IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS ivekit_voice_terminal_repair_worker_leases (
  cell_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  fault_domain TEXT NOT NULL,
  spiffe_id TEXT NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (cell_id, worker_id),
  CHECK (lease_expires_at > heartbeat_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_dialog_terminal_repair_claimed
  ON ivekit_voice_dialog_terminal_repairs(
    tenant_id,
    cell_id,
    call_session_ref
  )
  WHERE state = 'claimed';

CREATE INDEX IF NOT EXISTS idx_ivekit_dialog_terminal_repair_expiry
  ON ivekit_voice_dialog_terminal_repairs(
    cell_id,
    expires_at,
    tenant_id,
    call_session_ref
  )
  WHERE state = 'claimed';

CREATE INDEX IF NOT EXISTS idx_ivekit_terminal_repair_worker_lease_expiry
  ON ivekit_voice_terminal_repair_worker_leases(
    cell_id,
    lease_expires_at,
    worker_id
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.ivekit_tenant_events'::regclass
      AND conname = 'uq_ivekit_tenant_events_tenant_id'
      AND contype = 'u'
  ) THEN
    NULL;
  ELSIF EXISTS (
    SELECT 1
    FROM pg_index index_meta
    JOIN pg_class index_relation
      ON index_relation.oid = index_meta.indexrelid
    JOIN pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'uq_ivekit_tenant_events_tenant_id'
      AND index_meta.indrelid = 'public.ivekit_tenant_events'::regclass
      AND index_meta.indisunique
      AND index_meta.indisvalid
      AND index_meta.indisready
      AND index_meta.indpred IS NULL
      AND index_meta.indexprs IS NULL
      AND index_meta.indnkeyatts = 2
      AND index_meta.indnatts = 2
      AND ARRAY(
        SELECT attribute.attname::text
        FROM unnest(index_meta.indkey::smallint[]) WITH ORDINALITY
          AS key_column(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = index_meta.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.position <= index_meta.indnkeyatts
        ORDER BY key_column.position
      ) = ARRAY['tenant_id', 'id']
  ) THEN
    ALTER TABLE public.ivekit_tenant_events
      ADD CONSTRAINT uq_ivekit_tenant_events_tenant_id
      UNIQUE USING INDEX uq_ivekit_tenant_events_tenant_id;
  ELSIF to_regclass('public.uq_ivekit_tenant_events_tenant_id') IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 103 named unique index is invalid'
      USING HINT =
        'remove the malformed index and rerun the migration preflight';
  ELSIF EXISTS (SELECT 1 FROM public.ivekit_tenant_events LIMIT 1) THEN
    RAISE EXCEPTION
      'migration 103 requires the prebuilt concurrent unique index'
      USING HINT =
        'CREATE UNIQUE INDEX CONCURRENTLY uq_ivekit_tenant_events_tenant_id '
        'ON public.ivekit_tenant_events(tenant_id, id)';
  ELSE
    ALTER TABLE public.ivekit_tenant_events
      ADD CONSTRAINT uq_ivekit_tenant_events_tenant_id
      UNIQUE (tenant_id, id);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ivekit_voice_cdr_active_region_contract
  ON ivekit_voice_cdr_durability_contracts(region_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_calls (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  provider_profile_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  availability_profile TEXT NOT NULL
    CHECK (availability_profile IN ('VOICE-ORDINARY', 'VOICE-HA-T1')),
  owner_epoch BIGINT NOT NULL
    CHECK (owner_epoch BETWEEN 1 AND 9007199254740991),
  highest_sequence BIGINT NOT NULL
    CHECK (highest_sequence BETWEEN 1 AND 9007199254740991),
  latest_payload_hash TEXT NOT NULL CHECK (char_length(latest_payload_hash) = 64),
  state TEXT NOT NULL
    CHECK (state IN ('pending_unacknowledged', 'committed')),
  call_summary JSONB NOT NULL,
  durability_contract_id TEXT,
  durability_region_id TEXT,
  receipt_id TEXT,
  billing_key TEXT NOT NULL,
  billing_event_id BIGINT,
  committed_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, call_id),
  UNIQUE (tenant_id, provider_profile_id, provider_call_id),
  UNIQUE (tenant_id, billing_key),
  UNIQUE (tenant_id, receipt_id),
  UNIQUE (tenant_id, call_id, billing_event_id),
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_calls(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, provider_profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (durability_contract_id, durability_region_id)
    REFERENCES ivekit_voice_cdr_durability_contracts(id, region_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, billing_event_id)
    REFERENCES ivekit_tenant_events(tenant_id, id) ON DELETE RESTRICT,
  CHECK (
    availability_profile <> 'VOICE-HA-T1' OR
    owner_epoch <= 4294967295
  ),
  CHECK (
    (
      state = 'pending_unacknowledged' AND
      durability_contract_id IS NULL AND
      durability_region_id IS NULL AND
      receipt_id IS NULL AND
      committed_at IS NULL
    ) OR (
      state = 'committed' AND
      durability_contract_id IS NOT NULL AND
      durability_region_id IS NOT NULL AND
      receipt_id IS NOT NULL AND
      billing_event_id IS NOT NULL AND
      committed_at IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_legs (
  tenant_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('caller', 'callee')),
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  dialog_id_hash TEXT NOT NULL CHECK (char_length(dialog_id_hash) = 64),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sip_final_code SMALLINT NOT NULL
    CHECK (sip_final_code = 0 OR sip_final_code BETWEEN 100 AND 699),
  hangup_cause TEXT NOT NULL,
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ NOT NULL,
  media_result TEXT NOT NULL
    CHECK (media_result IN (
      'not_started', 'relayed', 'bypassed', 'transcoded', 'timeout', 'failed'
    )),
  reservation_ref TEXT,
  owner_epoch BIGINT NOT NULL
    CHECK (owner_epoch BETWEEN 1 AND 9007199254740991),
  route_snapshot_revision BIGINT NOT NULL
    CHECK (route_snapshot_revision BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, call_id, role),
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_cdr_calls(tenant_id, call_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_submissions (
  tenant_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  payload_hash TEXT NOT NULL CHECK (char_length(payload_hash) = 64),
  cell_id TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  availability_profile TEXT NOT NULL
    CHECK (availability_profile IN ('VOICE-ORDINARY', 'VOICE-HA-T1')),
  owner_epoch BIGINT NOT NULL
    CHECK (owner_epoch BETWEEN 1 AND 9007199254740991),
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, call_id, sequence),
  UNIQUE (tenant_id, call_id, sequence, payload_hash),
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_cdr_calls(tenant_id, call_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ivekit_voice_cdr_receipts (
  tenant_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  acknowledged_sequence BIGINT NOT NULL
    CHECK (acknowledged_sequence BETWEEN 1 AND 9007199254740991),
  committed_sequence BIGINT NOT NULL
    CHECK (
      committed_sequence BETWEEN acknowledged_sequence AND 9007199254740991
    ),
  acknowledged_payload_hash TEXT NOT NULL
    CHECK (char_length(acknowledged_payload_hash) = 64),
  receipt_id TEXT NOT NULL,
  durability_contract_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  billing_event_id BIGINT NOT NULL,
  cell_id TEXT NOT NULL,
  owner_node_id TEXT NOT NULL,
  availability_profile TEXT NOT NULL
    CHECK (availability_profile IN ('VOICE-ORDINARY', 'VOICE-HA-T1')),
  owner_epoch BIGINT NOT NULL
    CHECK (owner_epoch BETWEEN 1 AND 9007199254740991),
  committed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, call_id, acknowledged_sequence),
  UNIQUE (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, call_id)
    REFERENCES ivekit_voice_cdr_calls(tenant_id, call_id) ON DELETE RESTRICT,
  FOREIGN KEY (durability_contract_id, region_id)
    REFERENCES ivekit_voice_cdr_durability_contracts(id, region_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, billing_event_id)
    REFERENCES ivekit_tenant_events(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_id, billing_event_id)
    REFERENCES ivekit_voice_cdr_calls(tenant_id, call_id, billing_event_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, call_id, acknowledged_sequence,
               acknowledged_payload_hash)
    REFERENCES ivekit_voice_cdr_submissions(
      tenant_id, call_id, sequence, payload_hash
    ) ON DELETE RESTRICT
);

ALTER TABLE ivekit_voice_dialog_ownership
  DROP CONSTRAINT IF EXISTS fk_ivekit_dialog_terminal_cdr_receipt,
  ADD CONSTRAINT fk_ivekit_dialog_terminal_cdr_receipt
    FOREIGN KEY (tenant_id, terminal_cdr_receipt_id)
    REFERENCES ivekit_voice_cdr_receipts(tenant_id, receipt_id)
    ON DELETE RESTRICT;

ALTER TABLE ivekit_voice_dialog_terminal_repairs
  DROP CONSTRAINT IF EXISTS fk_ivekit_dialog_terminal_repair_cdr_receipt,
  ADD CONSTRAINT fk_ivekit_dialog_terminal_repair_cdr_receipt
    FOREIGN KEY (tenant_id, terminal_cdr_receipt_id)
    REFERENCES ivekit_voice_cdr_receipts(tenant_id, receipt_id)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_cdr_calls_pending
  ON ivekit_voice_cdr_calls(tenant_id, updated_at, call_id)
  WHERE state = 'pending_unacknowledged';

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_cdr_calls_billing_event
  ON ivekit_voice_cdr_calls(tenant_id, billing_event_id)
  WHERE billing_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_cdr_receipts_committed
  ON ivekit_voice_cdr_receipts(tenant_id, committed_at, call_id);

CREATE INDEX IF NOT EXISTS idx_ivekit_voice_cdr_receipts_billing_event
  ON ivekit_voice_cdr_receipts(tenant_id, billing_event_id);

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
    AND NOT EXISTS (
      SELECT 1 FROM public.ivekit_voice_cdr_calls cdr_call
      WHERE cdr_call.tenant_id = event.tenant_id
        AND cdr_call.billing_event_id = event.id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.ivekit_voice_cdr_receipts cdr_receipt
      WHERE cdr_receipt.tenant_id = event.tenant_id
        AND cdr_receipt.billing_event_id = event.id
    )
  GROUP BY event.tenant_id
  ORDER BY min(event.expires_at), event.tenant_id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;

CREATE OR REPLACE FUNCTION opc_ivekit_terminal_shadow_repair_tenant_ids(
  p_cell_id TEXT,
  p_limit INTEGER
)
RETURNS TABLE (tenant_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT ownership.tenant_id
  FROM public.ivekit_voice_dialog_ownership ownership
  WHERE ownership.cell_id = p_cell_id
    AND ownership.terminal = TRUE
    AND ownership.terminal_shadow_pending = TRUE
    AND ownership.terminal_cdr_sequence IS NOT NULL
    AND ownership.terminal_cdr_payload_hash IS NOT NULL
    AND ownership.terminal_cdr_call_id IS NOT NULL
    AND ownership.terminal_cdr_receipt_id IS NOT NULL
    AND ownership.terminal_cdr_region_id IS NOT NULL
    AND ownership.terminal_cdr_durability_contract_id IS NOT NULL
  GROUP BY ownership.tenant_id
  ORDER BY min(ownership.updated_at), ownership.tenant_id
  LIMIT LEAST(GREATEST(p_limit, 1), 256)
$$;

REVOKE ALL
  ON FUNCTION opc_ivekit_terminal_shadow_repair_tenant_ids(TEXT, INTEGER)
  FROM PUBLIC;

ALTER TABLE ivekit_voice_dialog_terminal_repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_dialog_terminal_repairs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_dialog_terminal_repairs;
CREATE POLICY tenant_isolation ON ivekit_voice_dialog_terminal_repairs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_cdr_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_cdr_calls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_cdr_calls;
CREATE POLICY tenant_isolation ON ivekit_voice_cdr_calls FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_cdr_legs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_cdr_legs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_cdr_legs;
CREATE POLICY tenant_isolation ON ivekit_voice_cdr_legs FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_cdr_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_cdr_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_cdr_receipts;
CREATE POLICY tenant_isolation ON ivekit_voice_cdr_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_voice_cdr_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_cdr_submissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_cdr_submissions;
CREATE POLICY tenant_isolation ON ivekit_voice_cdr_submissions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT ON ivekit_voice_cdr_durability_contracts TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON ivekit_voice_cdr_calls TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE ON ivekit_voice_cdr_legs TO opc_runtime;
    GRANT SELECT, INSERT ON ivekit_voice_cdr_submissions TO opc_runtime;
    GRANT SELECT, INSERT ON ivekit_voice_cdr_receipts TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE
      ON ivekit_voice_dialog_terminal_repairs TO opc_runtime;
    GRANT SELECT, INSERT, UPDATE
      ON ivekit_voice_terminal_repair_worker_leases TO opc_runtime;
    GRANT EXECUTE
      ON FUNCTION opc_ivekit_terminal_shadow_repair_tenant_ids(TEXT, INTEGER)
      TO opc_runtime;
    REVOKE DELETE, TRUNCATE ON ivekit_voice_cdr_calls FROM opc_runtime;
    REVOKE DELETE, TRUNCATE ON ivekit_voice_cdr_legs FROM opc_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON ivekit_voice_cdr_submissions FROM opc_runtime;
    REVOKE UPDATE, DELETE, TRUNCATE ON ivekit_voice_cdr_receipts FROM opc_runtime;
    REVOKE DELETE, TRUNCATE
      ON ivekit_voice_dialog_terminal_repairs FROM opc_runtime;
    REVOKE DELETE, TRUNCATE
      ON ivekit_voice_terminal_repair_worker_leases FROM opc_runtime;
  END IF;
END
$$;
