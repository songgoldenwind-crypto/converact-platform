-- Revision 4 SIP protocol-effect oracle.
-- "Oracle" means a protocol-fact arbiter; this is PostgreSQL DDL and has no
-- relationship to Oracle Database.
--
-- This is the only authoritative PostgreSQL DDL for this feature. The
-- sip-foundation-local migration file is intentionally a projection pointer.
-- NUMERIC(20,0) values are decoded by the application as canonical decimal
-- strings; JavaScript Number is never an authority for fences or revisions.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'opc_sip_effect_executor'
  ) THEN
    CREATE ROLE opc_sip_effect_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
  ALTER ROLE opc_sip_effect_executor
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOINHERIT NOBYPASSRLS;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    ALTER ROLE opc_runtime
      NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOINHERIT NOBYPASSRLS;
    GRANT opc_sip_effect_executor TO opc_runtime;
    REVOKE ADMIN OPTION FOR opc_sip_effect_executor FROM opc_runtime;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_schema_registry (
  schema_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  compatibility_slot TEXT NOT NULL CHECK (compatibility_slot IN ('N', 'N+1')),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  activation_receipt_id TEXT,
  activated_at TIMESTAMPTZ,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    enabled = FALSE OR
    (activation_receipt_id IS NOT NULL AND activated_at IS NOT NULL)
  ),
  PRIMARY KEY (schema_id, schema_version),
  UNIQUE (schema_id, schema_version, schema_hash),
  UNIQUE (schema_id, compatibility_slot)
);

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_writer_registry (
  writer_identity TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  activation_receipt_id TEXT,
  activated_at TIMESTAMPTZ,
  minimum_schema_version INTEGER NOT NULL DEFAULT 1
    CHECK (minimum_schema_version IN (1, 2)),
  maximum_schema_version INTEGER NOT NULL DEFAULT 2
    CHECK (
      maximum_schema_version IN (1, 2) AND
      maximum_schema_version >= minimum_schema_version
    ),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    enabled = FALSE OR
    (activation_receipt_id IS NOT NULL AND activated_at IS NOT NULL)
  )
);

INSERT INTO ivekit_sip_effect_schema_registry
  (schema_id, schema_version, schema_hash, compatibility_slot, enabled)
VALUES
  (
    'ivekit.sip-effect-oracle',
    1,
    'ae27a73dac95c90686f8020c2fb5e92dd016cc1712216d03b227ec3a6d6ca5ba',
    'N',
    FALSE
  )
ON CONFLICT (schema_id, schema_version) DO NOTHING;

INSERT INTO ivekit_sip_effect_writer_registry
  (writer_identity, enabled, minimum_schema_version, maximum_schema_version)
VALUES ('unified-rustpbx.sip-foundation', FALSE, 1, 2)
ON CONFLICT (writer_identity) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ivekit_sip_effect_schema_registry
    WHERE schema_id = 'ivekit.sip-effect-oracle'
      AND schema_version = 1
      AND schema_hash =
        'ae27a73dac95c90686f8020c2fb5e92dd016cc1712216d03b227ec3a6d6ca5ba'
      AND compatibility_slot = 'N'
      AND enabled = FALSE
      AND activation_receipt_id IS NULL
  ) THEN
    RAISE EXCEPTION 'SIP effect schema registry drift'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ivekit_sip_effect_writer_registry
    WHERE writer_identity = 'unified-rustpbx.sip-foundation'
      AND enabled = FALSE
      AND activation_receipt_id IS NULL
      AND minimum_schema_version = 1
      AND maximum_schema_version = 2
  ) THEN
    RAISE EXCEPTION 'SIP effect writer registry drift'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION ivekit_assert_sip_effect_writer(
  requested_writer_identity TEXT,
  requested_schema_id TEXT,
  requested_schema_version INTEGER,
  requested_schema_hash TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user <> 'opc_sip_effect_executor' OR
     session_user <> 'opc_runtime' OR
     current_setting(
       'app.sip_effect_writer_identity',
       TRUE
     ) IS DISTINCT FROM requested_writer_identity THEN
    RAISE EXCEPTION 'SIP effect executor role is not elected'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ivekit_sip_effect_writer_registry AS writer
    JOIN ivekit_sip_effect_schema_registry AS schema_entry
      ON schema_entry.schema_id = requested_schema_id
     AND schema_entry.schema_version = requested_schema_version
     AND schema_entry.schema_hash = requested_schema_hash
     AND schema_entry.enabled = TRUE
     AND schema_entry.activation_receipt_id IS NOT NULL
     AND schema_entry.activated_at IS NOT NULL
    WHERE writer.writer_identity = requested_writer_identity
      AND writer.enabled = TRUE
      AND writer.activation_receipt_id IS NOT NULL
      AND writer.activated_at IS NOT NULL
      AND requested_schema_version BETWEEN
        writer.minimum_schema_version AND writer.maximum_schema_version
  ) THEN
    RAISE EXCEPTION 'incompatible SIP effect writer/schema'
      USING ERRCODE = '55000';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS ivekit_sip_protocol_effects (
  protocol_effect_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  protocol_session_id TEXT NOT NULL,
  protocol_session_generation TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  command_id TEXT NOT NULL,
  adapter_identity JSONB NOT NULL CHECK (
    jsonb_typeof(adapter_identity) = 'object'
  ),
  adapter_identity_hash TEXT NOT NULL CHECK (
    adapter_identity_hash ~ '^[0-9a-f]{64}$'
  ),
  wire_bytes_hash TEXT NOT NULL CHECK (wire_bytes_hash ~ '^[0-9a-f]{64}$'),
  wire_length_bytes INTEGER NOT NULL CHECK (
    wire_length_bytes BETWEEN 1 AND 65535
  ),
  canonical_wire_bytes BYTEA NOT NULL,
  route_binding JSONB NOT NULL CHECK (jsonb_typeof(route_binding) = 'object'),
  route_binding_hash TEXT NOT NULL CHECK (route_binding_hash ~ '^[0-9a-f]{64}$'),
  wire_attempt_facts JSONB NOT NULL CHECK (
    jsonb_typeof(wire_attempt_facts) = 'object'
  ),
  wire_attempt_facts_hash TEXT NOT NULL CHECK (
    wire_attempt_facts_hash ~ '^[0-9a-f]{64}$'
  ),
  wire_freeze_sha256 TEXT NOT NULL CHECK (
    wire_freeze_sha256 ~ '^[0-9a-f]{64}$'
  ),
  effect_identity_hash TEXT NOT NULL CHECK (
    effect_identity_hash ~ '^[0-9a-f]{64}$'
  ),
  owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    owner_epoch BETWEEN 1 AND 18446744073709551615::numeric
  ),
  command_sequence NUMERIC(20, 0) NOT NULL CHECK (
    command_sequence BETWEEN 1 AND 18446744073709551615::numeric
  ),
  schema_id TEXT NOT NULL CHECK (schema_id = 'ivekit.sip-effect-oracle'),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  writer_identity TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared', 'durable_decision', 'send_attempted',
              'transport_accepted', 'protocol_observed', 'failed', 'unknown')
  ),
  revision NUMERIC(20, 0) NOT NULL DEFAULT 1 CHECK (
    revision BETWEEN 1 AND 18446744073709551615::numeric
  ),
  unknown_count INTEGER NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  last_receipt_id TEXT,
  last_receipt_hash TEXT CHECK (
    last_receipt_hash IS NULL OR last_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  last_receipt_repair_delay_ms INTEGER CHECK (
    last_receipt_repair_delay_ms IS NULL OR
    last_receipt_repair_delay_ms BETWEEN 0 AND 86400000
  ),
  failure_code TEXT NOT NULL DEFAULT '' CHECK (length(failure_code) <= 128),
  repair_due_at TIMESTAMPTZ,
  repair_owner_id TEXT,
  repair_owner_epoch NUMERIC(20, 0) CHECK (
    repair_owner_epoch IS NULL OR
    repair_owner_epoch BETWEEN 1 AND 18446744073709551615::numeric
  ),
  repair_epoch_high_watermark NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (
    repair_epoch_high_watermark BETWEEN 0 AND 18446744073709551615::numeric
  ),
  repair_claim_token TEXT CHECK (
    repair_claim_token IS NULL OR
    length(repair_claim_token) BETWEEN 1 AND 512
  ),
  repair_claim_revision NUMERIC(20, 0) CHECK (
    repair_claim_revision IS NULL OR
    repair_claim_revision BETWEEN 1 AND 18446744073709551615::numeric
  ),
  repair_lease_until TIMESTAMPTZ,
  repair_attempts SMALLINT NOT NULL DEFAULT 0
    CHECK (repair_attempts BETWEEN 0 AND 8),
  repair_exhausted_at TIMESTAMPTZ,
  repair_exhaustion_receipt_hash TEXT CHECK (
    repair_exhaustion_receipt_hash IS NULL OR
    repair_exhaustion_receipt_hash ~ '^[0-9a-f]{64}$'
  ),
  operator_attention_required BOOLEAN NOT NULL DEFAULT FALSE,
  repair_compacted_at TIMESTAMPTZ,
  retention_reference_count INTEGER NOT NULL DEFAULT 0
    CHECK (retention_reference_count >= 0),
  rollback_reference_count INTEGER NOT NULL DEFAULT 0
    CHECK (rollback_reference_count >= 0),
  audit_until TIMESTAMPTZ NOT NULL,
  payload_retained BOOLEAN NOT NULL DEFAULT TRUE,
  terminal_tombstone_id TEXT,
  terminal_tombstone_hash TEXT CHECK (
    terminal_tombstone_hash IS NULL OR
    terminal_tombstone_hash ~ '^[0-9a-f]{64}$'
  ),
  terminal_at TIMESTAMPTZ,
  prepared_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, protocol_effect_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (schema_id, schema_version, schema_hash)
    REFERENCES ivekit_sip_effect_schema_registry(
      schema_id, schema_version, schema_hash
    )
    ON DELETE RESTRICT,
  FOREIGN KEY (writer_identity)
    REFERENCES ivekit_sip_effect_writer_registry(writer_identity)
    ON DELETE RESTRICT,
  CHECK (audit_until > prepared_at),
  CHECK (
    (
      repair_owner_id IS NULL AND
      repair_owner_epoch IS NULL AND
      repair_claim_token IS NULL AND
      repair_claim_revision IS NULL AND
      repair_lease_until IS NULL
    ) OR (
      repair_owner_id IS NOT NULL AND
      repair_owner_epoch IS NOT NULL AND
      repair_claim_token IS NOT NULL AND
      repair_claim_revision IS NOT NULL AND
      repair_lease_until IS NOT NULL AND
      repair_owner_epoch = repair_epoch_high_watermark AND
      repair_claim_revision = revision AND
      repair_lease_until > updated_at
    )
  ),
  CHECK (
    (
      repair_exhausted_at IS NULL AND
      repair_exhaustion_receipt_hash IS NULL AND
      operator_attention_required = FALSE AND
      repair_compacted_at IS NULL
    ) OR (
      repair_exhausted_at IS NOT NULL AND
      repair_exhaustion_receipt_hash IS NOT NULL AND
      operator_attention_required = TRUE AND
      (repair_compacted_at IS NULL OR repair_compacted_at >= repair_exhausted_at)
    )
  ),
  CHECK (
    (last_receipt_id IS NULL) = (last_receipt_hash IS NULL)
  ),
  CHECK (
    (
      state = 'prepared' AND
      revision = 1 AND
      unknown_count = 0 AND
      last_receipt_id IS NULL
    ) OR (
      state <> 'prepared' AND
      last_receipt_id IS NOT NULL
    )
  ),
  CHECK (
    (state = 'unknown') =
      (last_receipt_repair_delay_ms IS NOT NULL)
  ),
  CHECK (
    (state = 'failed') = (length(failure_code) > 0)
  ),
  CHECK (
    state <> 'unknown' OR
    repair_due_at IS NOT NULL OR
    operator_attention_required = TRUE
  ),
  CHECK (
    (
      terminal_tombstone_id IS NULL AND
      terminal_tombstone_hash IS NULL AND
      terminal_at IS NULL AND
      state NOT IN ('protocol_observed', 'failed')
    ) OR (
      terminal_tombstone_id IS NOT NULL AND
      terminal_tombstone_hash IS NOT NULL AND
      terminal_at IS NOT NULL AND
      state IN ('protocol_observed', 'failed') AND
      terminal_tombstone_id = last_receipt_id AND
      terminal_tombstone_hash = last_receipt_hash AND
      terminal_at >= prepared_at AND
      terminal_at <= updated_at
    )
  ),
  CHECK (
    (
      payload_retained = TRUE AND
      octet_length(canonical_wire_bytes) = wire_length_bytes
    ) OR (
      payload_retained = FALSE AND
      octet_length(canonical_wire_bytes) = 0 AND
      terminal_at IS NOT NULL
    )
  ),
  CHECK (updated_at >= prepared_at)
);

CREATE TABLE IF NOT EXISTS ivekit_sip_effect_receipts (
  receipt_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  protocol_effect_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  command_id TEXT NOT NULL,
  wire_bytes_hash TEXT NOT NULL CHECK (wire_bytes_hash ~ '^[0-9a-f]{64}$'),
  effect_identity_hash TEXT NOT NULL CHECK (
    effect_identity_hash ~ '^[0-9a-f]{64}$'
  ),
  owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    owner_epoch BETWEEN 1 AND 18446744073709551615::numeric
  ),
  command_sequence NUMERIC(20, 0) NOT NULL CHECK (
    command_sequence BETWEEN 1 AND 18446744073709551615::numeric
  ),
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  level TEXT NOT NULL CHECK (
    level IN ('durable_decision', 'send_attempted', 'transport_accepted',
              'protocol_observed', 'failed', 'unknown')
  ),
  from_state TEXT NOT NULL CHECK (
    from_state IN ('prepared', 'durable_decision', 'send_attempted',
                   'transport_accepted', 'unknown')
  ),
  failure_code TEXT NOT NULL DEFAULT '' CHECK (length(failure_code) <= 128),
  repair_delay_ms INTEGER CHECK (
    repair_delay_ms IS NULL OR repair_delay_ms BETWEEN 0 AND 86400000
  ),
  observed_at TIMESTAMPTZ NOT NULL,
  schema_id TEXT NOT NULL CHECK (schema_id = 'ivekit.sip-effect-oracle'),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  writer_identity TEXT NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, protocol_effect_id)
    REFERENCES ivekit_sip_protocol_effects(tenant_id, protocol_effect_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (schema_id, schema_version, schema_hash)
    REFERENCES ivekit_sip_effect_schema_registry(
      schema_id, schema_version, schema_hash
    )
    ON DELETE RESTRICT,
  FOREIGN KEY (writer_identity)
    REFERENCES ivekit_sip_effect_writer_registry(writer_identity)
    ON DELETE RESTRICT,
  CHECK ((level = 'unknown') = (repair_delay_ms IS NOT NULL)),
  CHECK ((level = 'failed') = (length(failure_code) > 0)),
  CHECK (
    (level = 'durable_decision' AND from_state = 'prepared') OR
    (level = 'send_attempted' AND from_state = 'durable_decision') OR
    (level = 'transport_accepted' AND from_state = 'send_attempted') OR
    (
      level = 'protocol_observed' AND
      from_state IN ('send_attempted', 'transport_accepted', 'unknown')
    ) OR
    (
      level = 'failed' AND
      from_state IN (
        'prepared', 'durable_decision', 'send_attempted',
        'transport_accepted', 'unknown'
      )
    ) OR
    (
      level = 'unknown' AND
      from_state IN ('send_attempted', 'transport_accepted', 'unknown')
    )
  )
);

CREATE TABLE IF NOT EXISTS ivekit_sip_durable_boundaries (
  boundary_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  boundary_kind TEXT NOT NULL CHECK (
    boundary_kind IN ('call_admission', 'media_generation', 'bridge_head', 'recording')
  ),
  decision_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  facts_hash TEXT NOT NULL CHECK (facts_hash ~ '^[0-9a-f]{64}$'),
  boundary_hash TEXT NOT NULL CHECK (boundary_hash ~ '^[0-9a-f]{64}$'),
  owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    owner_epoch BETWEEN 1 AND 18446744073709551615::numeric
  ),
  command_sequence NUMERIC(20, 0) NOT NULL CHECK (
    command_sequence BETWEEN 1 AND 18446744073709551615::numeric
  ),
  committed_at TIMESTAMPTZ NOT NULL,
  schema_id TEXT NOT NULL CHECK (schema_id = 'ivekit.sip-effect-oracle'),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  writer_identity TEXT NOT NULL,
  PRIMARY KEY (tenant_id, boundary_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (schema_id, schema_version, schema_hash)
    REFERENCES ivekit_sip_effect_schema_registry(
      schema_id, schema_version, schema_hash
    )
    ON DELETE RESTRICT,
  FOREIGN KEY (writer_identity)
    REFERENCES ivekit_sip_effect_writer_registry(writer_identity)
    ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS ivekit_sip_durable_boundary_facts (
  tenant_id TEXT NOT NULL,
  boundary_id TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (
    fact_type IN (
      'call_session',
      'protocol_effect',
      'effect_wal',
      'capacity_reservation_receipt',
      'idempotency_record',
      'media_plan',
      'directed_media_edges',
      'backend_binding_groups',
      'bridge_command',
      'bridge_decision',
      'bridge_receipt',
      'head_compare_and_swap',
      'recording_intent',
      'root_recording_manifest',
      'source_chain',
      'segment_reference'
    )
  ),
  receipt_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision NUMERIC(20, 0) NOT NULL CHECK (
    aggregate_revision BETWEEN 1 AND 18446744073709551615::numeric
  ),
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  fact_payload JSONB NOT NULL CHECK (
    jsonb_typeof(fact_payload) = 'object' AND
    octet_length(fact_payload::text) <= 65536
  ),
  created_at TIMESTAMPTZ NOT NULL,
  schema_id TEXT NOT NULL CHECK (schema_id = 'ivekit.sip-effect-oracle'),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
  schema_hash TEXT NOT NULL CHECK (schema_hash ~ '^[0-9a-f]{64}$'),
  writer_identity TEXT NOT NULL,
  PRIMARY KEY (tenant_id, boundary_id, fact_type),
  UNIQUE (tenant_id, receipt_id),
  FOREIGN KEY (tenant_id, boundary_id)
    REFERENCES ivekit_sip_durable_boundaries(tenant_id, boundary_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (schema_id, schema_version, schema_hash)
    REFERENCES ivekit_sip_effect_schema_registry(
      schema_id, schema_version, schema_hash
    )
    ON DELETE RESTRICT,
  FOREIGN KEY (writer_identity)
    REFERENCES ivekit_sip_effect_writer_registry(writer_identity)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION ivekit_sip_effect_writer_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM ivekit_assert_sip_effect_writer(
    NEW.writer_identity,
    NEW.schema_id,
    NEW.schema_version,
    NEW.schema_hash
  );
  IF current_setting(
       'app.sip_effect_writer_identity',
       TRUE
     ) IS DISTINCT FROM NEW.writer_identity THEN
    RAISE EXCEPTION 'SIP effect writer session is not elected'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ivekit_sip_effect_writer_guard
  ON ivekit_sip_protocol_effects;
CREATE TRIGGER ivekit_sip_effect_writer_guard
BEFORE INSERT OR UPDATE ON ivekit_sip_protocol_effects
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_writer_guard();

DROP TRIGGER IF EXISTS ivekit_sip_receipt_writer_guard
  ON ivekit_sip_effect_receipts;
CREATE TRIGGER ivekit_sip_receipt_writer_guard
BEFORE INSERT OR UPDATE ON ivekit_sip_effect_receipts
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_writer_guard();

DROP TRIGGER IF EXISTS ivekit_sip_boundary_writer_guard
  ON ivekit_sip_durable_boundaries;
CREATE TRIGGER ivekit_sip_boundary_writer_guard
BEFORE INSERT OR UPDATE ON ivekit_sip_durable_boundaries
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_writer_guard();

DROP TRIGGER IF EXISTS ivekit_sip_boundary_fact_writer_guard
  ON ivekit_sip_durable_boundary_facts;
CREATE TRIGGER ivekit_sip_boundary_fact_writer_guard
BEFORE INSERT OR UPDATE ON ivekit_sip_durable_boundary_facts
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_writer_guard();

CREATE OR REPLACE FUNCTION ivekit_sip_effect_identity_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.tenant_id,
    NEW.protocol_effect_id,
    NEW.protocol_session_id,
    NEW.protocol_session_generation,
    NEW.decision_id,
    NEW.idempotency_key,
    NEW.request_hash,
    NEW.command_id,
    NEW.adapter_identity,
    NEW.adapter_identity_hash,
    NEW.wire_bytes_hash,
    NEW.wire_length_bytes,
    NEW.route_binding,
    NEW.route_binding_hash,
    NEW.wire_attempt_facts,
    NEW.wire_attempt_facts_hash,
    NEW.wire_freeze_sha256,
    NEW.effect_identity_hash,
    NEW.owner_epoch,
    NEW.command_sequence,
    NEW.schema_id,
    NEW.schema_version,
    NEW.schema_hash,
    NEW.writer_identity,
    NEW.prepared_at,
    NEW.audit_until
  ) IS DISTINCT FROM ROW(
    OLD.tenant_id,
    OLD.protocol_effect_id,
    OLD.protocol_session_id,
    OLD.protocol_session_generation,
    OLD.decision_id,
    OLD.idempotency_key,
    OLD.request_hash,
    OLD.command_id,
    OLD.adapter_identity,
    OLD.adapter_identity_hash,
    OLD.wire_bytes_hash,
    OLD.wire_length_bytes,
    OLD.route_binding,
    OLD.route_binding_hash,
    OLD.wire_attempt_facts,
    OLD.wire_attempt_facts_hash,
    OLD.wire_freeze_sha256,
    OLD.effect_identity_hash,
    OLD.owner_epoch,
    OLD.command_sequence,
    OLD.schema_id,
    OLD.schema_version,
    OLD.schema_hash,
    OLD.writer_identity,
    OLD.prepared_at,
    OLD.audit_until
  ) THEN
    RAISE EXCEPTION 'immutable SIP effect identity changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'SIP effect revision must advance exactly once'
      USING ERRCODE = '40001';
  END IF;
  IF NEW.repair_epoch_high_watermark < OLD.repair_epoch_high_watermark OR
     NEW.repair_attempts < OLD.repair_attempts THEN
    RAISE EXCEPTION 'SIP repair fence regressed'
      USING ERRCODE = '40001';
  END IF;
  IF ROW(
       NEW.state,
       NEW.last_receipt_id,
       NEW.last_receipt_hash,
       NEW.last_receipt_repair_delay_ms,
       NEW.failure_code
     ) IS DISTINCT FROM ROW(
       OLD.state,
       OLD.last_receipt_id,
       OLD.last_receipt_hash,
       OLD.last_receipt_repair_delay_ms,
       OLD.failure_code
     ) THEN
    IF NOT (
      (OLD.state = 'prepared' AND NEW.state IN ('durable_decision', 'failed')) OR
      (OLD.state = 'durable_decision' AND NEW.state IN ('send_attempted', 'failed')) OR
      (
        OLD.state = 'send_attempted' AND
        NEW.state IN ('transport_accepted', 'protocol_observed', 'failed', 'unknown')
      ) OR
      (
        OLD.state = 'transport_accepted' AND
        NEW.state IN ('protocol_observed', 'failed', 'unknown')
      ) OR
      (
        OLD.state = 'unknown' AND
        NEW.state IN ('unknown', 'protocol_observed', 'failed')
      )
    ) THEN
      RAISE EXCEPTION 'illegal SIP effect state transition'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM ivekit_sip_effect_receipts AS receipt
      WHERE receipt.tenant_id = NEW.tenant_id
        AND receipt.protocol_effect_id = NEW.protocol_effect_id
        AND receipt.receipt_id = NEW.last_receipt_id
        AND receipt.receipt_hash = NEW.last_receipt_hash
        AND receipt.level = NEW.state
        AND receipt.from_state = OLD.state
        AND receipt.decision_id = NEW.decision_id
        AND receipt.idempotency_key = NEW.idempotency_key
        AND receipt.request_hash = NEW.request_hash
        AND receipt.command_id = NEW.command_id
        AND receipt.wire_bytes_hash = NEW.wire_bytes_hash
        AND receipt.effect_identity_hash = NEW.effect_identity_hash
        AND receipt.owner_epoch = NEW.owner_epoch
        AND receipt.command_sequence = NEW.command_sequence
        AND receipt.failure_code = NEW.failure_code
        AND receipt.repair_delay_ms IS NOT DISTINCT FROM
          NEW.last_receipt_repair_delay_ms
        AND receipt.schema_id = NEW.schema_id
        AND receipt.schema_version = NEW.schema_version
        AND receipt.schema_hash = NEW.schema_hash
        AND receipt.writer_identity = NEW.writer_identity
    ) THEN
      RAISE EXCEPTION 'SIP effect transition lacks matching receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF OLD.terminal_at IS NOT NULL AND ROW(
       NEW.state,
       NEW.terminal_tombstone_id,
       NEW.terminal_tombstone_hash,
       NEW.terminal_at
     ) IS DISTINCT FROM ROW(
       OLD.state,
       OLD.terminal_tombstone_id,
       OLD.terminal_tombstone_hash,
       OLD.terminal_at
     ) THEN
    RAISE EXCEPTION 'terminal SIP effect tombstone changed'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.repair_exhausted_at IS NOT NULL AND ROW(
       NEW.repair_exhausted_at,
       NEW.repair_exhaustion_receipt_hash,
       NEW.operator_attention_required
     ) IS DISTINCT FROM ROW(
       OLD.repair_exhausted_at,
       OLD.repair_exhaustion_receipt_hash,
       OLD.operator_attention_required
     ) THEN
    RAISE EXCEPTION 'repair exhaustion audit changed'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.canonical_wire_bytes IS DISTINCT FROM OLD.canonical_wire_bytes AND NOT (
    OLD.payload_retained = TRUE AND
    NEW.payload_retained = FALSE AND
    octet_length(NEW.canonical_wire_bytes) = 0 AND
    OLD.terminal_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'canonical wire image changed outside terminal pruning'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.payload_retained = FALSE AND NEW.payload_retained = TRUE THEN
    RAISE EXCEPTION 'pruned SIP payload cannot be restored'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ivekit_sip_effect_identity_immutable
  ON ivekit_sip_protocol_effects;
CREATE TRIGGER ivekit_sip_effect_identity_immutable
BEFORE UPDATE ON ivekit_sip_protocol_effects
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_identity_immutable_guard();

CREATE OR REPLACE FUNCTION ivekit_check_sip_effect_receipt_applied()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ivekit_sip_protocol_effects AS effect
    WHERE effect.tenant_id = NEW.tenant_id
      AND effect.protocol_effect_id = NEW.protocol_effect_id
      AND effect.last_receipt_id = NEW.receipt_id
      AND effect.last_receipt_hash = NEW.receipt_hash
      AND effect.last_receipt_repair_delay_ms IS NOT DISTINCT FROM
        NEW.repair_delay_ms
      AND effect.state = NEW.level
      AND effect.decision_id = NEW.decision_id
      AND effect.idempotency_key = NEW.idempotency_key
      AND effect.request_hash = NEW.request_hash
      AND effect.command_id = NEW.command_id
      AND effect.wire_bytes_hash = NEW.wire_bytes_hash
      AND effect.effect_identity_hash = NEW.effect_identity_hash
      AND effect.owner_epoch = NEW.owner_epoch
      AND effect.command_sequence = NEW.command_sequence
      AND effect.failure_code = NEW.failure_code
      AND effect.schema_id = NEW.schema_id
      AND effect.schema_version = NEW.schema_version
      AND effect.schema_hash = NEW.schema_hash
      AND effect.writer_identity = NEW.writer_identity
  ) THEN
    RAISE EXCEPTION 'SIP effect receipt was not applied atomically'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS ivekit_sip_effect_receipt_applied
  ON ivekit_sip_effect_receipts;
CREATE CONSTRAINT TRIGGER ivekit_sip_effect_receipt_applied
AFTER INSERT ON ivekit_sip_effect_receipts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ivekit_check_sip_effect_receipt_applied();

CREATE OR REPLACE FUNCTION ivekit_check_sip_boundary_fact_set()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  actual TEXT[];
  required TEXT[];
  target_tenant TEXT := NEW.tenant_id;
  target_boundary TEXT := NEW.boundary_id;
  target_kind TEXT;
BEGIN
  SELECT boundary_kind
  INTO target_kind
  FROM ivekit_sip_durable_boundaries
  WHERE tenant_id = target_tenant AND boundary_id = target_boundary;

  IF target_kind IS NULL THEN
    RETURN NULL;
  END IF;
  required := CASE target_kind
    WHEN 'call_admission' THEN ARRAY[
      'call_session', 'protocol_effect', 'effect_wal',
      'capacity_reservation_receipt', 'idempotency_record'
    ]
    WHEN 'media_generation' THEN ARRAY[
      'media_plan', 'directed_media_edges', 'backend_binding_groups',
      'capacity_reservation_receipt'
    ]
    WHEN 'bridge_head' THEN ARRAY[
      'bridge_command', 'bridge_decision', 'bridge_receipt',
      'head_compare_and_swap'
    ]
    WHEN 'recording' THEN ARRAY[
      'recording_intent', 'root_recording_manifest', 'source_chain',
      'segment_reference'
    ]
  END;
  SELECT COALESCE(array_agg(fact_type ORDER BY fact_type), ARRAY[]::TEXT[])
  INTO actual
  FROM ivekit_sip_durable_boundary_facts
  WHERE tenant_id = target_tenant AND boundary_id = target_boundary;

  IF NOT (required <@ actual AND actual <@ required) THEN
    RAISE EXCEPTION 'incomplete or extra SIP durable boundary facts'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM ivekit_sip_durable_boundary_facts AS fact
    JOIN ivekit_sip_durable_boundaries AS boundary
      ON boundary.tenant_id = fact.tenant_id
     AND boundary.boundary_id = fact.boundary_id
    WHERE fact.tenant_id = target_tenant
      AND fact.boundary_id = target_boundary
      AND ROW(
        fact.schema_id,
        fact.schema_version,
        fact.schema_hash,
        fact.writer_identity
      ) IS DISTINCT FROM ROW(
        boundary.schema_id,
        boundary.schema_version,
        boundary.schema_hash,
        boundary.writer_identity
      )
  ) THEN
    RAISE EXCEPTION 'SIP boundary fact writer/schema mismatch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS ivekit_sip_boundary_fact_set_from_boundary
  ON ivekit_sip_durable_boundaries;
CREATE CONSTRAINT TRIGGER ivekit_sip_boundary_fact_set_from_boundary
AFTER INSERT ON ivekit_sip_durable_boundaries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ivekit_check_sip_boundary_fact_set();

DROP TRIGGER IF EXISTS ivekit_sip_boundary_fact_set_from_fact
  ON ivekit_sip_durable_boundary_facts;
CREATE CONSTRAINT TRIGGER ivekit_sip_boundary_fact_set_from_fact
AFTER INSERT ON ivekit_sip_durable_boundary_facts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION ivekit_check_sip_boundary_fact_set();

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_repair_due
  ON ivekit_sip_protocol_effects(
    tenant_id,
    repair_due_at,
    repair_epoch_high_watermark,
    protocol_effect_id
  )
  WHERE state = 'unknown' AND operator_attention_required = FALSE;

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_operator_attention
  ON ivekit_sip_protocol_effects(
    tenant_id,
    repair_exhausted_at,
    protocol_effect_id
  )
  WHERE operator_attention_required = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ivekit_sip_effect_active_repair_token
  ON ivekit_sip_protocol_effects(tenant_id, repair_claim_token)
  WHERE repair_claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_terminal_retention
  ON ivekit_sip_protocol_effects(
    tenant_id,
    audit_until,
    protocol_effect_id
  )
  WHERE terminal_at IS NOT NULL AND payload_retained = TRUE;

CREATE INDEX IF NOT EXISTS idx_ivekit_sip_effect_receipt_lineage
  ON ivekit_sip_effect_receipts(
    tenant_id,
    protocol_effect_id,
    observed_at,
    receipt_id
  );

ALTER TABLE ivekit_sip_protocol_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_sip_protocol_effects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_sip_protocol_effects;
CREATE POLICY tenant_isolation ON ivekit_sip_protocol_effects FOR ALL
  TO opc_sip_effect_executor, opc_admin
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_sip_effect_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_sip_effect_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_sip_effect_receipts;
CREATE POLICY tenant_isolation ON ivekit_sip_effect_receipts FOR ALL
  TO opc_sip_effect_executor, opc_admin
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_sip_durable_boundaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_sip_durable_boundaries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_sip_durable_boundaries;
CREATE POLICY tenant_isolation ON ivekit_sip_durable_boundaries FOR ALL
  TO opc_sip_effect_executor, opc_admin
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_sip_durable_boundary_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_sip_durable_boundary_facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_sip_durable_boundary_facts;
CREATE POLICY tenant_isolation ON ivekit_sip_durable_boundary_facts FOR ALL
  TO opc_sip_effect_executor, opc_admin
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

COMMENT ON TABLE ivekit_sip_protocol_effects IS
  'Revision 4 effect WAL. transport_accepted is local-only and never proves peer receipt.';
COMMENT ON TABLE ivekit_sip_durable_boundaries IS
  'Staged typed-boundary schema; runtime writes remain disabled until typed domain ports are wired.';

GRANT USAGE ON SCHEMA public TO opc_sip_effect_executor;

REVOKE ALL PRIVILEGES ON
  ivekit_sip_effect_schema_registry,
  ivekit_sip_effect_writer_registry,
  ivekit_sip_protocol_effects,
  ivekit_sip_effect_receipts,
  ivekit_sip_durable_boundaries,
  ivekit_sip_durable_boundary_facts
FROM PUBLIC, opc_sip_effect_executor;

GRANT SELECT ON
  ivekit_sip_effect_schema_registry,
  ivekit_sip_effect_writer_registry,
  ivekit_sip_protocol_effects,
  ivekit_sip_effect_receipts,
  ivekit_sip_durable_boundaries,
  ivekit_sip_durable_boundary_facts
TO opc_sip_effect_executor;

GRANT INSERT ON
  ivekit_sip_protocol_effects,
  ivekit_sip_effect_receipts
TO opc_sip_effect_executor;

GRANT UPDATE (
  state,
  revision,
  unknown_count,
  last_receipt_id,
  last_receipt_hash,
  last_receipt_repair_delay_ms,
  failure_code,
  repair_due_at,
  repair_owner_id,
  repair_owner_epoch,
  repair_epoch_high_watermark,
  repair_claim_token,
  repair_claim_revision,
  repair_lease_until,
  repair_attempts,
  repair_exhausted_at,
  repair_exhaustion_receipt_hash,
  operator_attention_required,
  repair_compacted_at,
  canonical_wire_bytes,
  payload_retained,
  terminal_tombstone_id,
  terminal_tombstone_hash,
  terminal_at,
  updated_at
) ON ivekit_sip_protocol_effects TO opc_sip_effect_executor;

REVOKE ALL ON FUNCTION ivekit_assert_sip_effect_writer(
  TEXT, TEXT, INTEGER, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ivekit_assert_sip_effect_writer(
  TEXT, TEXT, INTEGER, TEXT
) TO opc_sip_effect_executor;

REVOKE ALL ON FUNCTION ivekit_sip_effect_writer_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION ivekit_sip_effect_identity_immutable_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION ivekit_check_sip_effect_receipt_applied()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION ivekit_check_sip_boundary_fact_set()
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    ALTER ROLE opc_runtime
      NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOINHERIT NOBYPASSRLS;
    GRANT opc_sip_effect_executor TO opc_runtime;
    REVOKE ADMIN OPTION FOR opc_sip_effect_executor FROM opc_runtime;
    REVOKE ALL PRIVILEGES ON
      ivekit_sip_effect_schema_registry,
      ivekit_sip_effect_writer_registry,
      ivekit_sip_protocol_effects,
      ivekit_sip_effect_receipts,
      ivekit_sip_durable_boundaries,
      ivekit_sip_durable_boundary_facts
    FROM opc_runtime;
    REVOKE ALL ON FUNCTION ivekit_assert_sip_effect_writer(
      TEXT, TEXT, INTEGER, TEXT
    ) FROM opc_runtime;
  END IF;
END
$$;
