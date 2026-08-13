-- Durable Native Call recovery fence and exact matched-CANCEL visibility receipt.
-- This migration does not activate recovered calls. It only supplies the
-- default-disabled Rust recovery oracle with one tenant-scoped atomic boundary.

SET LOCAL lock_timeout = '5s';

CREATE TABLE ivekit_sip_effect_session_fences (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  protocol_session_id TEXT NOT NULL CHECK (
    length(protocol_session_id) BETWEEN 1 AND 200
  ),
  owner_epoch_high_watermark NUMERIC(20, 0) NOT NULL CHECK (
    owner_epoch_high_watermark BETWEEN 1 AND 18446744073709551615
  ),
  generation_high_watermark NUMERIC(20, 0) NOT NULL CHECK (
    generation_high_watermark BETWEEN 1 AND 18446744073709551615
  ),
  revision_high_watermark NUMERIC(20, 0) CHECK (
    revision_high_watermark IS NULL OR
    revision_high_watermark BETWEEN 1 AND 18446744073709551615
  ),
  last_recovery_request_sha256 TEXT CHECK (
    last_recovery_request_sha256 IS NULL OR
    last_recovery_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, protocol_session_id)
);

-- Existing protocol effects predate this fence. Seed only the greatest
-- authority tuple per exact session; no historical effect or receipt is
-- rewritten. The new Rust writer locks this row before every new prepare.
INSERT INTO ivekit_sip_effect_session_fences (
  tenant_id,
  protocol_session_id,
  owner_epoch_high_watermark,
  generation_high_watermark,
  revision_high_watermark,
  updated_at
)
SELECT DISTINCT ON (effect.tenant_id, effect.protocol_session_id)
  effect.tenant_id,
  effect.protocol_session_id,
  effect.owner_epoch,
  effect.protocol_session_generation::numeric,
  NULL,
  statement_timestamp()
FROM ivekit_sip_protocol_effects AS effect
ORDER BY
  effect.tenant_id,
  effect.protocol_session_id,
  effect.owner_epoch DESC,
  effect.protocol_session_generation::numeric DESC,
  effect.prepared_at DESC,
  effect.protocol_effect_id DESC
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ivekit_sip_effect_session_insert_fence_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_owner_epoch NUMERIC(20, 0);
  current_generation NUMERIC(20, 0);
  incoming_generation NUMERIC(20, 0);
BEGIN
  incoming_generation := NEW.protocol_session_generation::numeric;
  IF NEW.protocol_session_generation !~ '^[1-9][0-9]*$'
     OR incoming_generation > 18446744073709551615::numeric
  THEN
    RAISE EXCEPTION 'SIP effect session generation is not canonical'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO ivekit_sip_effect_session_fences (
    tenant_id,
    protocol_session_id,
    owner_epoch_high_watermark,
    generation_high_watermark,
    revision_high_watermark,
    updated_at
  ) VALUES (
    NEW.tenant_id,
    NEW.protocol_session_id,
    NEW.owner_epoch,
    incoming_generation,
    NULL,
    statement_timestamp()
  )
  ON CONFLICT DO NOTHING;

  SELECT
    fence.owner_epoch_high_watermark,
    fence.generation_high_watermark
  INTO STRICT current_owner_epoch, current_generation
  FROM ivekit_sip_effect_session_fences AS fence
  WHERE fence.tenant_id = NEW.tenant_id
    AND fence.protocol_session_id = NEW.protocol_session_id
  FOR UPDATE;

  IF current_owner_epoch <> NEW.owner_epoch
     OR current_generation <> incoming_generation
  THEN
    RAISE EXCEPTION 'SIP effect session fence is stale'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ivekit_sip_effect_session_insert_fence
BEFORE INSERT ON ivekit_sip_protocol_effects
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_session_insert_fence_guard();

-- A binary that prepared an effect before takeover must not be able to make
-- its first wire attempt after the successor has advanced the session fence.
-- Later observations for an effect that was already send_attempted remain
-- writable, so real peer/transport evidence is never discarded on takeover.
CREATE OR REPLACE FUNCTION ivekit_sip_effect_send_attempt_fence_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_owner_epoch NUMERIC(20, 0);
  current_generation NUMERIC(20, 0);
  incoming_generation NUMERIC(20, 0);
BEGIN
  IF NEW.state <> 'send_attempted' OR OLD.state = 'send_attempted' THEN
    RETURN NEW;
  END IF;

  IF NEW.protocol_session_generation !~ '^[1-9][0-9]*$' THEN
    RAISE EXCEPTION 'stale SIP effect cannot enter send_attempted'
      USING ERRCODE = '55000';
  END IF;
  incoming_generation := NEW.protocol_session_generation::numeric;
  IF incoming_generation > 18446744073709551615::numeric THEN
    RAISE EXCEPTION 'stale SIP effect cannot enter send_attempted'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    fence.owner_epoch_high_watermark,
    fence.generation_high_watermark
  INTO current_owner_epoch, current_generation
  FROM ivekit_sip_effect_session_fences AS fence
  WHERE fence.tenant_id = NEW.tenant_id
    AND fence.protocol_session_id = NEW.protocol_session_id
  FOR UPDATE;

  IF NOT FOUND
     OR current_owner_epoch <> NEW.owner_epoch
     OR current_generation <> incoming_generation
  THEN
    RAISE EXCEPTION 'stale SIP effect cannot enter send_attempted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ivekit_sip_effect_send_attempt_fence
BEFORE UPDATE OF state ON ivekit_sip_protocol_effects
FOR EACH ROW
WHEN (NEW.state = 'send_attempted' AND OLD.state <> 'send_attempted')
EXECUTE FUNCTION ivekit_sip_effect_send_attempt_fence_guard();

CREATE TABLE ivekit_sip_capability_recovery_receipts (
  recovery_request_sha256 TEXT NOT NULL CHECK (
    recovery_request_sha256 ~ '^[0-9a-f]{64}$'
  ),
  tenant_id TEXT NOT NULL,
  protocol_session_id TEXT NOT NULL,
  provider_call_id TEXT NOT NULL CHECK (
    length(provider_call_id) BETWEEN 1 AND 200
  ),
  predecessor_binding_sha256 TEXT NOT NULL CHECK (
    predecessor_binding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  transaction_key_sha256 TEXT NOT NULL CHECK (
    transaction_key_sha256 ~ '^[0-9a-f]{64}$'
  ),
  previous_owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    previous_owner_epoch BETWEEN 1 AND 18446744073709551615
  ),
  previous_generation NUMERIC(20, 0) NOT NULL CHECK (
    previous_generation BETWEEN 1 AND 18446744073709551615
  ),
  previous_revision NUMERIC(20, 0) NOT NULL CHECK (
    previous_revision BETWEEN 1 AND 18446744073709551615
  ),
  successor_owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    successor_owner_epoch BETWEEN 1 AND 18446744073709551615
  ),
  successor_generation NUMERIC(20, 0) NOT NULL CHECK (
    successor_generation BETWEEN 1 AND 18446744073709551615
  ),
  successor_revision NUMERIC(20, 0) NOT NULL CHECK (
    successor_revision BETWEEN 1 AND 18446744073709551615
  ),
  cancel_ok_effect_id TEXT NOT NULL CHECK (
    cancel_ok_effect_id ~ '^sip-cancel-ok-[0-9a-f]{64}$'
  ),
  invite_terminated_effect_id TEXT NOT NULL CHECK (
    invite_terminated_effect_id ~ '^sip-invite-487-[0-9a-f]{64}$'
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('no_visible_effect', 'visible_or_ambiguous')
  ),
  successor_fence_receipt_sha256 TEXT NOT NULL CHECK (
    successor_fence_receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, recovery_request_sha256),
  UNIQUE (
    tenant_id,
    protocol_session_id,
    successor_owner_epoch,
    successor_generation,
    successor_revision
  ),
  FOREIGN KEY (tenant_id, protocol_session_id)
    REFERENCES ivekit_sip_effect_session_fences(
      tenant_id, protocol_session_id
    ) ON DELETE RESTRICT,
  CHECK (successor_owner_epoch > previous_owner_epoch),
  CHECK (successor_generation = previous_generation + 1),
  CHECK (successor_revision = previous_revision + 1)
);

CREATE OR REPLACE FUNCTION ivekit_sip_effect_session_fence_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.protocol_session_id IS DISTINCT FROM OLD.protocol_session_id
     OR NEW.owner_epoch_high_watermark <= OLD.owner_epoch_high_watermark
     OR NEW.generation_high_watermark <> OLD.generation_high_watermark + 1
     OR NEW.revision_high_watermark IS NULL
     OR (
       OLD.revision_high_watermark IS NOT NULL AND
       NEW.revision_high_watermark <> OLD.revision_high_watermark + 1
     )
     OR NEW.last_recovery_request_sha256 IS NULL
     OR NEW.last_recovery_request_sha256 IS NOT DISTINCT FROM
       OLD.last_recovery_request_sha256
  THEN
    RAISE EXCEPTION 'SIP effect session fence transition is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER ivekit_sip_effect_session_fence_transition
BEFORE UPDATE ON ivekit_sip_effect_session_fences
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_effect_session_fence_guard();

CREATE OR REPLACE FUNCTION ivekit_sip_capability_recovery_receipt_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'SIP capability recovery receipts are immutable'
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER ivekit_sip_capability_recovery_receipt_immutable
BEFORE UPDATE OR DELETE ON ivekit_sip_capability_recovery_receipts
FOR EACH ROW
EXECUTE FUNCTION ivekit_sip_capability_recovery_receipt_immutable();

ALTER TABLE ivekit_sip_effect_session_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_sip_effect_session_fences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ivekit_sip_effect_session_fences FOR ALL
  TO opc_sip_effect_executor, opc_admin
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE ivekit_sip_capability_recovery_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_sip_capability_recovery_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ivekit_sip_capability_recovery_receipts FOR ALL
  TO opc_sip_effect_executor, opc_admin
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL PRIVILEGES ON
  ivekit_sip_effect_session_fences,
  ivekit_sip_capability_recovery_receipts
FROM PUBLIC, opc_sip_effect_executor;

GRANT SELECT, INSERT ON
  ivekit_sip_effect_session_fences,
  ivekit_sip_capability_recovery_receipts
TO opc_sip_effect_executor;

GRANT UPDATE (
  owner_epoch_high_watermark,
  generation_high_watermark,
  revision_high_watermark,
  last_recovery_request_sha256,
  updated_at
) ON ivekit_sip_effect_session_fences TO opc_sip_effect_executor;

REVOKE ALL ON FUNCTION ivekit_sip_effect_session_fence_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION ivekit_sip_effect_session_insert_fence_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION ivekit_sip_effect_send_attempt_fence_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION ivekit_sip_capability_recovery_receipt_immutable()
  FROM PUBLIC;

COMMENT ON TABLE ivekit_sip_effect_session_fences IS
  'Exact Native Call SIP-effect owner/generation high-watermark; locked before every new Rust effect prepare.';
COMMENT ON TABLE ivekit_sip_capability_recovery_receipts IS
  'Immutable exact-key predecessor visibility decisions; raw SIP transaction keys are never stored.';
