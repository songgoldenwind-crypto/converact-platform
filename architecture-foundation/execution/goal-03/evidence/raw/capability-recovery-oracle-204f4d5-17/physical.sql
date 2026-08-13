\set ON_ERROR_STOP on

INSERT INTO tenants (id, name)
VALUES
  ('g03-77-clean', 'g03-77-clean'),
  ('g03-77-visible', 'g03-77-visible')
ON CONFLICT (id) DO NOTHING;

UPDATE ivekit_sip_effect_schema_registry
SET enabled = TRUE,
    activation_receipt_id = 'g03-77-isolated-functional',
    activated_at = statement_timestamp()
WHERE schema_id = 'ivekit.sip-effect-oracle' AND schema_version = 2;

UPDATE ivekit_sip_effect_writer_registry
SET enabled = TRUE,
    activation_receipt_id = 'g03-77-isolated-functional',
    activated_at = statement_timestamp()
WHERE writer_identity = 'unified-rustpbx.sip-foundation';

SET SESSION AUTHORIZATION opc_runtime;
SET ROLE opc_sip_effect_executor;
SELECT set_config('app.current_tenant', 'g03-77-clean', FALSE);
SELECT set_config(
  'app.sip_effect_writer_identity',
  'unified-rustpbx.sip-foundation',
  FALSE
);

-- No-visible-effect decision, immutable replay receipt, and successor fence.
BEGIN;
INSERT INTO ivekit_sip_effect_session_fences (
  tenant_id, protocol_session_id, owner_epoch_high_watermark,
  generation_high_watermark, revision_high_watermark
) VALUES ('g03-77-clean', 'call-g03-77-clean', 7, 11, 19);

-- This old-owner effect is intentionally durable but not wire-visible. The
-- takeover may classify it as no_visible_effect only because the database
-- fence below prevents it from ever entering send_attempted afterwards.
INSERT INTO ivekit_sip_protocol_effects (
  protocol_effect_id, tenant_id, protocol_session_id,
  protocol_session_generation, decision_id, idempotency_key, request_hash,
  command_id, adapter_identity, adapter_identity_hash, wire_bytes_hash,
  wire_length_bytes, canonical_wire_bytes, route_binding, route_binding_hash,
  wire_attempt_facts, wire_attempt_facts_hash, wire_freeze_sha256,
  effect_identity_hash, owner_epoch, command_sequence, schema_id,
  schema_version, schema_hash, writer_identity, state, audit_until,
  prepared_at, updated_at
) VALUES (
  'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0',
  'g03-77-clean', 'call-g03-77-clean', '11', 'decision-clean',
  'idempotency-clean', repeat('1', 64), 'command-clean', '{}',
  repeat('2', 64), repeat('3', 64), 1, decode('00', 'hex'), '{}',
  repeat('4', 64), '{}', repeat('5', 64), repeat('6', 64), repeat('7', 64),
  7, 1, 'ivekit.sip-effect-oracle', 2,
  '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
  'unified-rustpbx.sip-foundation', 'prepared',
  statement_timestamp() + INTERVAL '30 days', statement_timestamp(),
  statement_timestamp()
);

INSERT INTO ivekit_sip_effect_receipts (
  receipt_id, tenant_id, protocol_effect_id, decision_id, idempotency_key,
  request_hash, command_id, wire_bytes_hash, effect_identity_hash,
  owner_epoch, command_sequence, receipt_hash, level, from_state,
  observed_at, schema_id, schema_version, schema_hash, writer_identity
) VALUES (
  'receipt-clean-decision', 'g03-77-clean',
  'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0',
  'decision-clean', 'idempotency-clean', repeat('1', 64),
  'command-clean', repeat('3', 64), repeat('7', 64), 7, 1,
  repeat('8', 64), 'durable_decision', 'prepared', statement_timestamp(),
  'ivekit.sip-effect-oracle', 2,
  '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
  'unified-rustpbx.sip-foundation'
);
UPDATE ivekit_sip_protocol_effects
SET state = 'durable_decision', revision = 2,
    last_receipt_id = 'receipt-clean-decision',
    last_receipt_hash = repeat('8', 64), updated_at = statement_timestamp()
WHERE tenant_id = 'g03-77-clean'
  AND protocol_effect_id =
    'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0';
SET CONSTRAINTS ivekit_sip_effect_receipt_applied IMMEDIATE;

SELECT owner_epoch_high_watermark, generation_high_watermark
FROM ivekit_sip_effect_session_fences
WHERE tenant_id = 'g03-77-clean'
  AND protocol_session_id = 'call-g03-77-clean'
FOR UPDATE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM ivekit_sip_protocol_effects
    WHERE tenant_id = 'g03-77-clean'
      AND protocol_effect_id = ANY(ARRAY[
        'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0',
        'sip-invite-487-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0'
      ]::text[])
      AND state NOT IN ('prepared', 'durable_decision')
  ) THEN
    RAISE EXCEPTION 'clean predecessor unexpectedly visible';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM ivekit_sip_protocol_effects
    WHERE tenant_id = 'g03-77-clean'
      AND protocol_effect_id =
        'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0'
      AND state = 'durable_decision'
  ) THEN
    RAISE EXCEPTION 'clean predecessor durable decision is missing';
  END IF;
END
$$;

UPDATE ivekit_sip_effect_session_fences
SET owner_epoch_high_watermark = 8,
    generation_high_watermark = 12,
    revision_high_watermark = 20,
    last_recovery_request_sha256 = repeat('c', 64),
    updated_at = statement_timestamp()
WHERE tenant_id = 'g03-77-clean'
  AND protocol_session_id = 'call-g03-77-clean'
  AND owner_epoch_high_watermark = 7
  AND generation_high_watermark = 11
  AND revision_high_watermark = 19;

INSERT INTO ivekit_sip_capability_recovery_receipts (
  recovery_request_sha256, tenant_id, protocol_session_id,
  provider_call_id, predecessor_binding_sha256, transaction_key_sha256,
  previous_owner_epoch, previous_generation, previous_revision,
  successor_owner_epoch, successor_generation, successor_revision,
  cancel_ok_effect_id, invite_terminated_effect_id, outcome,
  successor_fence_receipt_sha256
) VALUES (
  repeat('c', 64), 'g03-77-clean', 'call-g03-77-clean',
  'provider-clean@example.test', repeat('a', 64), repeat('b', 64),
  7, 11, 19, 8, 12, 20,
  'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0',
  'sip-invite-487-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0',
  'no_visible_effect', repeat('d', 64)
);
COMMIT;

-- The takeover fence must reject the old owner's first wire attempt even when
-- that binary prepared the exact effect before takeover. The receipt insert
-- and state transition share a subtransaction and therefore roll back
-- together when the fence rejects the transition.
DO $$
BEGIN
  BEGIN
    INSERT INTO ivekit_sip_effect_receipts (
      receipt_id, tenant_id, protocol_effect_id, decision_id, idempotency_key,
      request_hash, command_id, wire_bytes_hash, effect_identity_hash,
      owner_epoch, command_sequence, receipt_hash, level, from_state,
      observed_at, schema_id, schema_version, schema_hash, writer_identity
    ) VALUES (
      'receipt-clean-attempt', 'g03-77-clean',
      'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0',
      'decision-clean', 'idempotency-clean', repeat('1', 64),
      'command-clean', repeat('3', 64), repeat('7', 64), 7, 1,
      repeat('9', 64), 'send_attempted', 'durable_decision',
      statement_timestamp(), 'ivekit.sip-effect-oracle', 2,
      '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
      'unified-rustpbx.sip-foundation'
    );
    UPDATE ivekit_sip_protocol_effects
    SET state = 'send_attempted', revision = 3,
        last_receipt_id = 'receipt-clean-attempt',
        last_receipt_hash = repeat('9', 64), updated_at = statement_timestamp()
    WHERE tenant_id = 'g03-77-clean'
      AND protocol_effect_id =
        'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0';
    RAISE EXCEPTION 'stale prepared effect entered send_attempted';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM <> 'stale SIP effect cannot enter send_attempted' THEN
      RAISE;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM ivekit_sip_effect_receipts
    WHERE tenant_id = 'g03-77-clean'
      AND receipt_id = 'receipt-clean-attempt'
  ) OR NOT EXISTS (
    SELECT 1 FROM ivekit_sip_protocol_effects
    WHERE tenant_id = 'g03-77-clean'
      AND protocol_effect_id =
        'sip-cancel-ok-a5a9c8e3cf178b009c8fc025d4feea208c027242408ba0bcdc0116946a5db0b0'
      AND state = 'durable_decision'
  ) THEN
    RAISE EXCEPTION 'stale send attempt was not rolled back atomically';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ivekit_sip_capability_recovery_receipts
    WHERE tenant_id = 'g03-77-clean'
      AND recovery_request_sha256 = repeat('c', 64)
      AND outcome = 'no_visible_effect'
      AND successor_fence_receipt_sha256 = repeat('d', 64)
  ) THEN
    RAISE EXCEPTION 'clean recovery receipt replay is missing';
  END IF;
END
$$;

-- Even an old binary that does not know the Rust-side fence is rejected by
-- the database trigger after the successor takes ownership.
DO $$
BEGIN
  BEGIN
    INSERT INTO ivekit_sip_protocol_effects (
      protocol_effect_id, tenant_id, protocol_session_id,
      protocol_session_generation, owner_epoch
    ) VALUES (
      'old-writer-must-fail', 'g03-77-clean', 'call-g03-77-clean', '11', 7
    );
    RAISE EXCEPTION 'old writer bypassed the session fence';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM <> 'SIP effect session fence is stale' THEN
      RAISE;
    END IF;
  END;
END
$$;

RESET SESSION AUTHORIZATION;

-- Prepare one exact predecessor effect and advance it to send_attempted using
-- the existing receipt/transition contract, then prove the recovery outcome
-- is visible_or_ambiguous.
SET SESSION AUTHORIZATION opc_runtime;
SET ROLE opc_sip_effect_executor;
SELECT set_config('app.current_tenant', 'g03-77-visible', FALSE);
SELECT set_config(
  'app.sip_effect_writer_identity',
  'unified-rustpbx.sip-foundation',
  FALSE
);
INSERT INTO ivekit_sip_protocol_effects (
  protocol_effect_id, tenant_id, protocol_session_id,
  protocol_session_generation, decision_id, idempotency_key, request_hash,
  command_id, adapter_identity, adapter_identity_hash, wire_bytes_hash,
  wire_length_bytes, canonical_wire_bytes, route_binding, route_binding_hash,
  wire_attempt_facts, wire_attempt_facts_hash, wire_freeze_sha256,
  effect_identity_hash, owner_epoch, command_sequence, schema_id,
  schema_version, schema_hash, writer_identity, state, audit_until,
  prepared_at, updated_at
) VALUES (
  'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef',
  'g03-77-visible', 'call-g03-77-visible', '11', 'decision-visible',
  'idempotency-visible', repeat('1', 64), 'command-visible', '{}',
  repeat('2', 64), repeat('3', 64), 1, decode('00', 'hex'), '{}',
  repeat('4', 64), '{}', repeat('5', 64), repeat('6', 64), repeat('7', 64),
  7, 1, 'ivekit.sip-effect-oracle', 2,
  '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
  'unified-rustpbx.sip-foundation', 'prepared',
  statement_timestamp() + INTERVAL '30 days', statement_timestamp(),
  statement_timestamp()
);

BEGIN;
INSERT INTO ivekit_sip_effect_receipts (
  receipt_id, tenant_id, protocol_effect_id, decision_id, idempotency_key,
  request_hash, command_id, wire_bytes_hash, effect_identity_hash,
  owner_epoch, command_sequence, receipt_hash, level, from_state,
  observed_at, schema_id, schema_version, schema_hash, writer_identity
) VALUES (
  'receipt-visible-decision', 'g03-77-visible',
  'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef',
  'decision-visible', 'idempotency-visible', repeat('1', 64),
  'command-visible', repeat('3', 64), repeat('7', 64), 7, 1,
  repeat('8', 64), 'durable_decision', 'prepared', statement_timestamp(),
  'ivekit.sip-effect-oracle', 2,
  '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
  'unified-rustpbx.sip-foundation'
);
UPDATE ivekit_sip_protocol_effects
SET state = 'durable_decision', revision = 2,
    last_receipt_id = 'receipt-visible-decision',
    last_receipt_hash = repeat('8', 64), updated_at = statement_timestamp()
WHERE tenant_id = 'g03-77-visible'
  AND protocol_effect_id =
    'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef';
SET CONSTRAINTS ivekit_sip_effect_receipt_applied IMMEDIATE;
COMMIT;

BEGIN;
INSERT INTO ivekit_sip_effect_receipts (
  receipt_id, tenant_id, protocol_effect_id, decision_id, idempotency_key,
  request_hash, command_id, wire_bytes_hash, effect_identity_hash,
  owner_epoch, command_sequence, receipt_hash, level, from_state,
  observed_at, schema_id, schema_version, schema_hash, writer_identity
) VALUES (
  'receipt-visible-attempt', 'g03-77-visible',
  'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef',
  'decision-visible', 'idempotency-visible', repeat('1', 64),
  'command-visible', repeat('3', 64), repeat('7', 64), 7, 1,
  repeat('9', 64), 'send_attempted', 'durable_decision', statement_timestamp(),
  'ivekit.sip-effect-oracle', 2,
  '7f4cd00c42bb4607c6b443261a06b06bd42117718c1f858293f1471e3ccb153b',
  'unified-rustpbx.sip-foundation'
);
UPDATE ivekit_sip_protocol_effects
SET state = 'send_attempted', revision = 3,
    last_receipt_id = 'receipt-visible-attempt',
    last_receipt_hash = repeat('9', 64), updated_at = statement_timestamp()
WHERE tenant_id = 'g03-77-visible'
  AND protocol_effect_id =
    'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef';
SET CONSTRAINTS ivekit_sip_effect_receipt_applied IMMEDIATE;
COMMIT;

BEGIN;
SELECT owner_epoch_high_watermark, generation_high_watermark
FROM ivekit_sip_effect_session_fences
WHERE tenant_id = 'g03-77-visible'
  AND protocol_session_id = 'call-g03-77-visible'
FOR UPDATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ivekit_sip_protocol_effects
    WHERE tenant_id = 'g03-77-visible'
      AND protocol_effect_id = ANY(ARRAY[
        'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef',
        'sip-invite-487-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef'
      ]::text[])
      AND state = 'send_attempted'
  ) THEN
    RAISE EXCEPTION 'visible predecessor attempt is missing';
  END IF;
END
$$;

UPDATE ivekit_sip_effect_session_fences
SET owner_epoch_high_watermark = 8,
    generation_high_watermark = 12,
    revision_high_watermark = 20,
    last_recovery_request_sha256 = repeat('e', 64),
    updated_at = statement_timestamp()
WHERE tenant_id = 'g03-77-visible'
  AND protocol_session_id = 'call-g03-77-visible'
  AND owner_epoch_high_watermark = 7
  AND generation_high_watermark = 11
  AND revision_high_watermark IS NULL;

INSERT INTO ivekit_sip_capability_recovery_receipts (
  recovery_request_sha256, tenant_id, protocol_session_id,
  provider_call_id, predecessor_binding_sha256, transaction_key_sha256,
  previous_owner_epoch, previous_generation, previous_revision,
  successor_owner_epoch, successor_generation, successor_revision,
  cancel_ok_effect_id, invite_terminated_effect_id, outcome,
  successor_fence_receipt_sha256
) VALUES (
  repeat('e', 64), 'g03-77-visible', 'call-g03-77-visible',
  'provider-visible@example.test', repeat('a', 64), repeat('b', 64),
  7, 11, 19, 8, 12, 20,
  'sip-cancel-ok-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef',
  'sip-invite-487-522a04788ebd0a25c3b076cd7c19598f0d5ef2733bd796bf0eefdbc154eacbef',
  'visible_or_ambiguous', repeat('f', 64)
);
COMMIT;

RESET SESSION AUTHORIZATION;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ivekit_sip_capability_recovery_receipts
    WHERE tenant_id = 'g03-77-visible'
      AND outcome = 'visible_or_ambiguous'
  ) THEN
    RAISE EXCEPTION 'visible recovery receipt is missing';
  END IF;
  BEGIN
    UPDATE ivekit_sip_capability_recovery_receipts
    SET outcome = 'no_visible_effect'
    WHERE tenant_id = 'g03-77-visible';
    RAISE EXCEPTION 'immutable recovery receipt changed';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END
$$;

-- Executor RLS sees only its configured tenant.
SET SESSION AUTHORIZATION opc_runtime;
SET ROLE opc_sip_effect_executor;
BEGIN;
SELECT set_config('app.current_tenant', 'g03-77-clean', TRUE);
SELECT (count(*) = 1)::text AS rls_exact_tenant
FROM ivekit_sip_effect_session_fences
\gset
\if :rls_exact_tenant
\else
  \echo 'tenant RLS did not isolate session fences'
  \quit 1
\endif
ROLLBACK;
RESET SESSION AUTHORIZATION;

SELECT 'g03_77_capability_recovery_physical_passed' AS result;
