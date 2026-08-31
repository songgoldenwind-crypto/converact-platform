-- Add immutable dial-policy authority and per-Attempt execution snapshots.
-- Existing Attempts remain nullable for rolling compatibility and fail closed at runtime.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS converact_outbound_dial_policy_revisions (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  caller_id TEXT CHECK (
    caller_id IS NULL OR
    caller_id ~ '^\+[1-9][0-9]{7,14}$' OR
    caller_id ~ '^sips?:[^[:space:]@]+@[^[:space:]@]+$'
  ),
  timeout_secs INTEGER NOT NULL CHECK (timeout_secs BETWEEN 1 AND 120),
  trunk TEXT CHECK (
    trunk IS NULL OR trunk ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, content_hash)
);

DROP TRIGGER IF EXISTS converact_outbound_dial_policy_revisions_immutable
  ON converact_outbound_dial_policy_revisions;
CREATE TRIGGER converact_outbound_dial_policy_revisions_immutable
  BEFORE UPDATE OR DELETE ON converact_outbound_dial_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION converact_outbound_immutable_history_guard();

ALTER TABLE converact_outbound_dial_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_outbound_dial_policy_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON converact_outbound_dial_policy_revisions;
CREATE POLICY tenant_isolation ON converact_outbound_dial_policy_revisions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_outbound_campaigns
  DROP CONSTRAINT IF EXISTS converact_outbound_campaigns_dial_policy_fk;
ALTER TABLE converact_outbound_campaigns
  ADD CONSTRAINT converact_outbound_campaigns_dial_policy_fk
  FOREIGN KEY (tenant_id, dial_policy_revision)
  REFERENCES converact_outbound_dial_policy_revisions(tenant_id, id)
  ON DELETE RESTRICT NOT VALID;

ALTER TABLE converact_outbound_call_attempts
  ADD COLUMN IF NOT EXISTS dial_policy_revision TEXT,
  ADD COLUMN IF NOT EXISTS dial_policy_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS dial_destination TEXT,
  ADD COLUMN IF NOT EXISTS dial_caller_id TEXT,
  ADD COLUMN IF NOT EXISTS dial_timeout_secs INTEGER,
  ADD COLUMN IF NOT EXISTS dial_trunk TEXT;

ALTER TABLE converact_outbound_call_attempts
  DROP CONSTRAINT IF EXISTS converact_outbound_attempt_dial_snapshot_check;
ALTER TABLE converact_outbound_call_attempts
  ADD CONSTRAINT converact_outbound_attempt_dial_snapshot_check CHECK (
    (
      dial_policy_revision IS NULL AND dial_policy_content_hash IS NULL AND dial_destination IS NULL AND
      dial_caller_id IS NULL AND dial_timeout_secs IS NULL AND dial_trunk IS NULL
    ) OR (
      dial_policy_revision ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      dial_policy_content_hash ~ '^[0-9a-f]{64}$' AND
      (
        dial_destination ~ '^\+[1-9][0-9]{7,14}$' OR
        dial_destination ~ '^sips?:[^[:space:]@]+@[^[:space:]@]+$'
      ) AND
      (
        dial_caller_id IS NULL OR
        dial_caller_id ~ '^\+[1-9][0-9]{7,14}$' OR
        dial_caller_id ~ '^sips?:[^[:space:]@]+@[^[:space:]@]+$'
      ) AND
      dial_timeout_secs BETWEEN 1 AND 120 AND
      (
        dial_trunk IS NULL OR
        dial_trunk ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
      )
    )
  ) NOT VALID;

ALTER TABLE converact_outbound_call_attempts
  DROP CONSTRAINT IF EXISTS converact_outbound_attempt_dial_policy_fk;
ALTER TABLE converact_outbound_call_attempts
  ADD CONSTRAINT converact_outbound_attempt_dial_policy_fk
  FOREIGN KEY (tenant_id, dial_policy_revision, dial_policy_content_hash)
  REFERENCES converact_outbound_dial_policy_revisions(tenant_id, id, content_hash)
  ON DELETE RESTRICT NOT VALID;

CREATE OR REPLACE FUNCTION converact_outbound_dial_snapshot_immutable_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.dial_policy_revision, OLD.dial_policy_content_hash, OLD.dial_destination,
    OLD.dial_caller_id, OLD.dial_timeout_secs, OLD.dial_trunk
  ) IS DISTINCT FROM ROW(
    NEW.dial_policy_revision, NEW.dial_policy_content_hash, NEW.dial_destination,
    NEW.dial_caller_id, NEW.dial_timeout_secs, NEW.dial_trunk
  ) THEN
    RAISE EXCEPTION 'AI outbound dial snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS converact_outbound_attempt_dial_snapshot_immutable
  ON converact_outbound_call_attempts;
CREATE TRIGGER converact_outbound_attempt_dial_snapshot_immutable
  BEFORE UPDATE OF dial_policy_revision, dial_policy_content_hash, dial_destination,
    dial_caller_id, dial_timeout_secs, dial_trunk
  ON converact_outbound_call_attempts
  FOR EACH ROW EXECUTE FUNCTION converact_outbound_dial_snapshot_immutable_guard();

REVOKE ALL ON FUNCTION converact_outbound_dial_snapshot_immutable_guard() FROM PUBLIC;

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT, INSERT ON converact_outbound_dial_policy_revisions TO opc_runtime;
  END IF;
END
$grant$;
