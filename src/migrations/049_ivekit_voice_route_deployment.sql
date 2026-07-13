-- Route payloads remain immutable after publication. Only provider deployment
-- evidence may converge as an asynchronous configuration command completes.
CREATE OR REPLACE FUNCTION opc_ivekit_voice_route_version_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = OLD.tenant_id
  ) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
    AND ROW(
      NEW.id, NEW.tenant_id, NEW.route_id, NEW.version, NEW.rules,
      NEW.payload_hash, NEW.published_by, NEW.published_at
    ) IS NOT DISTINCT FROM ROW(
      OLD.id, OLD.tenant_id, OLD.route_id, OLD.version, OLD.rules,
      OLD.payload_hash, OLD.published_by, OLD.published_at
    )
    AND NOT (OLD.deployment_state = 'applied' AND NEW.deployment_state <> 'applied')
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'iveKit Voice route version payloads are immutable'
    USING ERRCODE = '55000';
END;
$$;
