CREATE TABLE IF NOT EXISTS ivekit_voice_route_snapshot_revisions (
  tenant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, profile_id),
  FOREIGN KEY (tenant_id, profile_id)
    REFERENCES ivekit_voice_deployment_profiles(tenant_id, id) ON DELETE CASCADE
);

INSERT INTO ivekit_voice_route_snapshot_revisions
  (tenant_id, profile_id, revision, changed_at)
SELECT profile.tenant_id, profile.id, 1, CURRENT_TIMESTAMP
FROM ivekit_voice_deployment_profiles profile
WHERE profile.adapter = 'rustpbx'
ON CONFLICT (tenant_id, profile_id) DO NOTHING;

ALTER TABLE ivekit_voice_route_snapshot_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ivekit_voice_route_snapshot_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ivekit_voice_route_snapshot_revisions;
CREATE POLICY tenant_isolation ON ivekit_voice_route_snapshot_revisions
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true));

CREATE OR REPLACE FUNCTION ivekit_bump_voice_route_snapshot_revision(
  p_tenant_id TEXT,
  p_profile_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_tenant_id IS NULL OR p_profile_id IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO ivekit_voice_route_snapshot_revisions
    (tenant_id, profile_id, revision, changed_at)
  SELECT profile.tenant_id, profile.id, 1, CURRENT_TIMESTAMP
  FROM ivekit_voice_deployment_profiles profile
  WHERE profile.tenant_id = p_tenant_id
    AND profile.id = p_profile_id
    AND profile.adapter = 'rustpbx'
  ON CONFLICT (tenant_id, profile_id) DO UPDATE
    SET revision = ivekit_voice_route_snapshot_revisions.revision + 1,
        changed_at = CURRENT_TIMESTAMP;
END;
$$;
REVOKE ALL ON FUNCTION ivekit_bump_voice_route_snapshot_revision(TEXT, TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ivekit_voice_profile_route_snapshot_revision_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.adapter = 'rustpbx' AND NEW.adapter <> 'rustpbx' THEN
    DELETE FROM ivekit_voice_route_snapshot_revisions
    WHERE tenant_id = OLD.tenant_id AND profile_id = OLD.id;
    RETURN NEW;
  END IF;
  IF NEW.adapter = 'rustpbx' THEN
    PERFORM ivekit_bump_voice_route_snapshot_revision(NEW.tenant_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ivekit_voice_direct_route_snapshot_revision_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM ivekit_bump_voice_route_snapshot_revision(OLD.tenant_id, OLD.profile_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF TG_OP = 'INSERT'
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR OLD.profile_id IS DISTINCT FROM NEW.profile_id THEN
      PERFORM ivekit_bump_voice_route_snapshot_revision(NEW.tenant_id, NEW.profile_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ivekit_voice_route_version_snapshot_revision_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  old_profile_id TEXT;
  new_profile_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT route.profile_id INTO old_profile_id
    FROM ivekit_voice_routes route
    WHERE route.tenant_id = OLD.tenant_id AND route.id = OLD.route_id;
    PERFORM ivekit_bump_voice_route_snapshot_revision(OLD.tenant_id, old_profile_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT route.profile_id INTO new_profile_id
    FROM ivekit_voice_routes route
    WHERE route.tenant_id = NEW.tenant_id AND route.id = NEW.route_id;
    IF TG_OP = 'INSERT'
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR old_profile_id IS DISTINCT FROM new_profile_id THEN
      PERFORM ivekit_bump_voice_route_snapshot_revision(NEW.tenant_id, new_profile_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ivekit_voice_did_snapshot_revision_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  old_profile_id TEXT;
  new_profile_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT trunk.profile_id INTO old_profile_id
    FROM ivekit_voice_sip_trunks trunk
    WHERE trunk.tenant_id = OLD.tenant_id AND trunk.id = OLD.trunk_id;
    PERFORM ivekit_bump_voice_route_snapshot_revision(OLD.tenant_id, old_profile_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT trunk.profile_id INTO new_profile_id
    FROM ivekit_voice_sip_trunks trunk
    WHERE trunk.tenant_id = NEW.tenant_id AND trunk.id = NEW.trunk_id;
    IF TG_OP = 'INSERT'
      OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
      OR old_profile_id IS DISTINCT FROM new_profile_id THEN
      PERFORM ivekit_bump_voice_route_snapshot_revision(NEW.tenant_id, new_profile_id);
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ivekit_voice_profile_route_snapshot_revision
  ON ivekit_voice_deployment_profiles;
CREATE TRIGGER ivekit_voice_profile_route_snapshot_revision
AFTER INSERT OR UPDATE OR DELETE ON ivekit_voice_deployment_profiles
FOR EACH ROW EXECUTE FUNCTION ivekit_voice_profile_route_snapshot_revision_trigger();

DROP TRIGGER IF EXISTS ivekit_voice_capability_route_snapshot_revision
  ON ivekit_voice_capability_snapshots;
CREATE TRIGGER ivekit_voice_capability_route_snapshot_revision
AFTER INSERT OR UPDATE OR DELETE ON ivekit_voice_capability_snapshots
FOR EACH ROW EXECUTE FUNCTION ivekit_voice_direct_route_snapshot_revision_trigger();

DROP TRIGGER IF EXISTS ivekit_voice_trunk_route_snapshot_revision
  ON ivekit_voice_sip_trunks;
CREATE TRIGGER ivekit_voice_trunk_route_snapshot_revision
AFTER INSERT OR UPDATE OR DELETE ON ivekit_voice_sip_trunks
FOR EACH ROW EXECUTE FUNCTION ivekit_voice_direct_route_snapshot_revision_trigger();

DROP TRIGGER IF EXISTS ivekit_voice_route_snapshot_revision
  ON ivekit_voice_routes;
CREATE TRIGGER ivekit_voice_route_snapshot_revision
AFTER INSERT OR UPDATE OR DELETE ON ivekit_voice_routes
FOR EACH ROW EXECUTE FUNCTION ivekit_voice_direct_route_snapshot_revision_trigger();

DROP TRIGGER IF EXISTS ivekit_voice_version_route_snapshot_revision
  ON ivekit_voice_route_versions;
CREATE TRIGGER ivekit_voice_version_route_snapshot_revision
AFTER INSERT OR UPDATE OR DELETE ON ivekit_voice_route_versions
FOR EACH ROW EXECUTE FUNCTION ivekit_voice_route_version_snapshot_revision_trigger();

DROP TRIGGER IF EXISTS ivekit_voice_did_route_snapshot_revision
  ON ivekit_voice_dids;
CREATE TRIGGER ivekit_voice_did_route_snapshot_revision
AFTER INSERT OR UPDATE OR DELETE ON ivekit_voice_dids
FOR EACH ROW EXECUTE FUNCTION ivekit_voice_did_snapshot_revision_trigger();
