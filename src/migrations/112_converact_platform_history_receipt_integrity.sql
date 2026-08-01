-- Usage is billable only from an exact, completed effect receipt. The foreign
-- key prevents orphan receipt identifiers; the trigger also binds digest,
-- lifecycle stage, and the typed billing-key-derived effect identity.
DO $integrity$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM converact_platform_usage_entries usage
    LEFT JOIN converact_platform_effect_receipts receipt
      ON receipt.tenant_id = usage.tenant_id
     AND receipt.receipt_id = usage.receipt_id
    WHERE receipt.receipt_id IS NULL
       OR receipt.receipt_digest <> usage.receipt_digest
       OR receipt.stage NOT IN ('completed', 'state_observed')
       OR receipt.effect_id <> 'billing:' ||
          encode(sha256(convert_to(usage.billing_key, 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'existing platform usage has no domain-valid effect receipt'
      USING ERRCODE = '23514';
  END IF;
END
$integrity$;

ALTER TABLE converact_platform_usage_entries
  ADD CONSTRAINT converact_platform_usage_effect_receipt_fkey
  FOREIGN KEY (tenant_id, receipt_id)
  REFERENCES converact_platform_effect_receipts (tenant_id, receipt_id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE converact_platform_usage_entries
  VALIDATE CONSTRAINT converact_platform_usage_effect_receipt_fkey;

CREATE OR REPLACE FUNCTION opc_converact_platform_usage_receipt_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  receipt converact_platform_effect_receipts%ROWTYPE;
BEGIN
  SELECT stored.* INTO receipt
  FROM converact_platform_effect_receipts stored
  WHERE stored.tenant_id = NEW.tenant_id
    AND stored.receipt_id = NEW.receipt_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'platform usage receipt does not exist' USING ERRCODE = '23503';
  END IF;
  IF receipt.receipt_digest <> NEW.receipt_digest THEN
    RAISE EXCEPTION 'platform usage receipt digest mismatch' USING ERRCODE = '23514';
  END IF;
  IF receipt.stage NOT IN ('completed', 'state_observed') OR
     receipt.effect_id <> 'billing:' ||
       encode(sha256(convert_to(NEW.billing_key, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'platform usage receipt is not billable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS converact_platform_usage_receipt_integrity
  ON converact_platform_usage_entries;
CREATE TRIGGER converact_platform_usage_receipt_integrity
  BEFORE INSERT ON converact_platform_usage_entries
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_usage_receipt_guard();

-- Tenant lifecycle is a tombstone/receipt workflow. Platform authority and
-- append-only history must never disappear as a side effect of deleting a
-- tenant row, so replace every G02 cascade with a validated restrictive FK.
DO $tenant_history$
DECLARE
  table_name TEXT;
  old_constraint TEXT;
  new_constraint TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'converact_platform_identity_sessions',
    'converact_platform_revocation_snapshots',
    'converact_platform_policy_revisions',
    'converact_platform_consent_evidence',
    'converact_platform_consent_leases',
    'converact_platform_outbox',
    'converact_platform_inbox',
    'converact_platform_effect_receipts',
    'converact_platform_billing_writers',
    'converact_platform_usage_entries',
    'converact_platform_key_versions',
    'converact_platform_key_lifecycle_receipts',
    'converact_platform_certificate_bindings'
  ] LOOP
    SELECT constraint_meta.conname INTO old_constraint
    FROM pg_constraint constraint_meta
    WHERE constraint_meta.conrelid = table_name::regclass
      AND constraint_meta.confrelid = 'tenants'::regclass
      AND constraint_meta.contype = 'f'
      AND constraint_meta.confdeltype = 'c'
    LIMIT 1;
    IF old_constraint IS NULL THEN
      RAISE EXCEPTION 'missing cascade tenant constraint for %', table_name;
    END IF;

    new_constraint := left(table_name || '_tenant_restrict_fkey', 63);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT NOT VALID',
      table_name,
      new_constraint
    );
    EXECUTE format(
      'ALTER TABLE %I VALIDATE CONSTRAINT %I',
      table_name,
      new_constraint
    );
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT %I',
      table_name,
      old_constraint
    );
    old_constraint := NULL;
  END LOOP;
END
$tenant_history$;

-- The earlier guard exception allowed a parent cascade to erase nominally
-- immutable rows. Restrictive tenant FKs make that path unreachable; these
-- guards now reject every direct UPDATE or DELETE as well.
CREATE OR REPLACE FUNCTION opc_converact_platform_event_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform event history is immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION opc_converact_platform_usage_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform usage history is immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION opc_converact_platform_key_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform key history is immutable' USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION opc_converact_platform_identity_history_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'platform identity history is immutable' USING ERRCODE = '55000';
END
$$;

DROP TRIGGER IF EXISTS converact_platform_revocation_snapshots_append_only
  ON converact_platform_revocation_snapshots;
CREATE TRIGGER converact_platform_revocation_snapshots_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_revocation_snapshots
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_identity_history_guard();

DROP TRIGGER IF EXISTS converact_platform_policy_revisions_append_only
  ON converact_platform_policy_revisions;
CREATE TRIGGER converact_platform_policy_revisions_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_identity_history_guard();

DROP TRIGGER IF EXISTS converact_platform_consent_evidence_append_only
  ON converact_platform_consent_evidence;
CREATE TRIGGER converact_platform_consent_evidence_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_consent_evidence
  FOR EACH ROW EXECUTE FUNCTION opc_converact_platform_identity_history_guard();

REVOKE ALL ON FUNCTION opc_converact_platform_usage_receipt_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION opc_converact_platform_identity_history_guard() FROM PUBLIC;
