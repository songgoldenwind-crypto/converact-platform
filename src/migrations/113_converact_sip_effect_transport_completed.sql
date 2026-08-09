-- Goal 03 rolling expand for a local-transport terminal receipt.
--
-- This migration is expand-only. It registers schema N+1 disabled, teaches
-- PostgreSQL to store/read the new value, and leaves every v1 effect, receipt,
-- hash and tombstone byte-identical. A separate activation receipt is required
-- before any writer may create v2 effects.

INSERT INTO ivekit_sip_effect_schema_registry
  (schema_id, schema_version, schema_hash, compatibility_slot, enabled)
VALUES (
  'ivekit.sip-effect-oracle',
  2,
  '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
  'N+1',
  FALSE
)
ON CONFLICT (schema_id, schema_version) DO NOTHING;

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
  ) OR NOT EXISTS (
    SELECT 1
    FROM ivekit_sip_effect_schema_registry
    WHERE schema_id = 'ivekit.sip-effect-oracle'
      AND schema_version = 2
      AND schema_hash =
        '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b'
      AND compatibility_slot = 'N+1'
      AND enabled = FALSE
      AND activation_receipt_id IS NULL
      AND activated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'SIP effect N/N+1 schema registry drift'
      USING ERRCODE = '55000';
  END IF;
END
$$;

-- Anonymous v1 checks are identified by their exact semantic vocabulary. The
-- migration refuses to guess if an installation has zero or multiple matches.
DO $$
DECLARE
  matched TEXT[];
BEGIN
  SELECT array_agg(conname ORDER BY conname)
  INTO matched
  FROM pg_constraint
  WHERE conrelid = 'ivekit_sip_protocol_effects'::regclass
    AND contype = 'c'
    AND position('durable_decision' IN pg_get_constraintdef(oid)) > 0
    AND position('send_attempted' IN pg_get_constraintdef(oid)) > 0
    AND position('transport_accepted' IN pg_get_constraintdef(oid)) > 0
    AND position('protocol_observed' IN pg_get_constraintdef(oid)) > 0
    AND position('terminal_tombstone_id' IN pg_get_constraintdef(oid)) = 0;
  IF cardinality(matched) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'unexpected SIP effect state check set: %', matched
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format(
    'ALTER TABLE ivekit_sip_protocol_effects DROP CONSTRAINT %I',
    matched[1]
  );

  SELECT array_agg(conname ORDER BY conname)
  INTO matched
  FROM pg_constraint
  WHERE conrelid = 'ivekit_sip_protocol_effects'::regclass
    AND contype = 'c'
    AND position('terminal_tombstone_id' IN pg_get_constraintdef(oid)) > 0
    AND position('terminal_tombstone_hash' IN pg_get_constraintdef(oid)) > 0
    AND position('terminal_at' IN pg_get_constraintdef(oid)) > 0
    AND position('payload_retained' IN pg_get_constraintdef(oid)) = 0;
  IF cardinality(matched) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'unexpected SIP terminal tombstone check set: %', matched
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format(
    'ALTER TABLE ivekit_sip_protocol_effects DROP CONSTRAINT %I',
    matched[1]
  );

  SELECT array_agg(conname ORDER BY conname)
  INTO matched
  FROM pg_constraint
  WHERE conrelid = 'ivekit_sip_effect_receipts'::regclass
    AND contype = 'c'
    AND position('level' IN pg_get_constraintdef(oid)) > 0
    AND position('durable_decision' IN pg_get_constraintdef(oid)) > 0
    AND position('send_attempted' IN pg_get_constraintdef(oid)) > 0
    AND position('transport_accepted' IN pg_get_constraintdef(oid)) > 0
    AND position('protocol_observed' IN pg_get_constraintdef(oid)) > 0
    AND position('from_state' IN pg_get_constraintdef(oid)) = 0;
  IF cardinality(matched) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'unexpected SIP receipt level check set: %', matched
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format(
    'ALTER TABLE ivekit_sip_effect_receipts DROP CONSTRAINT %I',
    matched[1]
  );

  SELECT array_agg(conname ORDER BY conname)
  INTO matched
  FROM pg_constraint
  WHERE conrelid = 'ivekit_sip_effect_receipts'::regclass
    AND contype = 'c'
    AND position('level' IN pg_get_constraintdef(oid)) > 0
    AND position('from_state' IN pg_get_constraintdef(oid)) > 0
    AND position('durable_decision' IN pg_get_constraintdef(oid)) > 0
    AND position('protocol_observed' IN pg_get_constraintdef(oid)) > 0;
  IF cardinality(matched) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'unexpected SIP receipt transition check set: %', matched
      USING ERRCODE = '55000';
  END IF;
  EXECUTE format(
    'ALTER TABLE ivekit_sip_effect_receipts DROP CONSTRAINT %I',
    matched[1]
  );
END
$$;

ALTER TABLE ivekit_sip_protocol_effects
  ADD CONSTRAINT ivekit_sip_protocol_effects_state_v2_check CHECK (
    state IN (
      'prepared', 'durable_decision', 'send_attempted',
      'transport_accepted', 'transport_completed',
      'protocol_observed', 'failed', 'unknown'
    ) AND
    (schema_version <> 1 OR state <> 'transport_completed')
  ) NOT VALID;

ALTER TABLE ivekit_sip_protocol_effects
  ADD CONSTRAINT ivekit_sip_protocol_effects_terminal_v2_check CHECK (
    (
      terminal_tombstone_id IS NULL AND
      terminal_tombstone_hash IS NULL AND
      terminal_at IS NULL AND
      state NOT IN ('transport_completed', 'protocol_observed', 'failed')
    ) OR (
      terminal_tombstone_id IS NOT NULL AND
      terminal_tombstone_hash IS NOT NULL AND
      terminal_at IS NOT NULL AND
      state IN ('transport_completed', 'protocol_observed', 'failed') AND
      terminal_tombstone_id = last_receipt_id AND
      terminal_tombstone_hash = last_receipt_hash AND
      terminal_at >= prepared_at AND
      terminal_at <= updated_at
    )
  ) NOT VALID;

ALTER TABLE ivekit_sip_effect_receipts
  ADD CONSTRAINT ivekit_sip_effect_receipts_level_v2_check CHECK (
    level IN (
      'durable_decision', 'send_attempted', 'transport_accepted',
      'transport_completed', 'protocol_observed', 'failed', 'unknown'
    ) AND
    (schema_version <> 1 OR level <> 'transport_completed')
  ) NOT VALID;

ALTER TABLE ivekit_sip_effect_receipts
  ADD CONSTRAINT ivekit_sip_effect_receipts_transition_v2_check CHECK (
    (level = 'durable_decision' AND from_state = 'prepared') OR
    (level = 'send_attempted' AND from_state = 'durable_decision') OR
    (level = 'transport_accepted' AND from_state = 'send_attempted') OR
    (
      level = 'transport_completed' AND
      schema_version = 2 AND
      from_state = 'transport_accepted'
    ) OR
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
  ) NOT VALID;

CREATE OR REPLACE FUNCTION ivekit_sip_effect_identity_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.protocol_effect_id,
    NEW.tenant_id,
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
    OLD.protocol_effect_id,
    OLD.tenant_id,
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
        NEW.state IN (
          'transport_completed', 'protocol_observed', 'failed', 'unknown'
        )
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

COMMENT ON TABLE ivekit_sip_protocol_effects IS
  'Goal 03 v2: transport_completed is a local-transport terminal and never peer evidence.';
