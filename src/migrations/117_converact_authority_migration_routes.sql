-- Durable, exact-key migration routing for moving one Authority writer at a
-- time. This schema is additive and does not route any current runtime.

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'opc_migration_executor'
  ) THEN
    CREATE ROLE opc_migration_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOINHERIT NOBYPASSRLS;
  END IF;
  ALTER ROLE opc_migration_executor
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
    NOREPLICATION NOINHERIT NOBYPASSRLS;
END
$$;

CREATE TABLE converact_authority_routes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT CHECK (
    octet_length(tenant_id) BETWEEN 1 AND 255 AND
    tenant_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  authority_kind TEXT NOT NULL CHECK (
    octet_length(authority_kind) BETWEEN 1 AND 255 AND
    authority_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  partition_key TEXT NOT NULL CHECK (
    octet_length(partition_key) BETWEEN 1 AND 255 AND
    partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  current_generation NUMERIC(20, 0) NOT NULL CHECK (
    current_generation BETWEEN 1 AND 18446744073709551615
  ),
  route_revision NUMERIC(20, 0) NOT NULL CHECK (
    route_revision BETWEEN 1 AND 18446744073709551615
  ),
  route_state TEXT NOT NULL CHECK (
    route_state IN (
      'shadow', 'prepare', 'committed', 'draining', 'active_zero', 'retired'
    )
  ),
  prepared_generation NUMERIC(20, 0) CHECK (
    prepared_generation IS NULL OR
    prepared_generation BETWEEN 1 AND 18446744073709551615
  ),
  prepare_operation_id TEXT CHECK (
    prepare_operation_id IS NULL OR (
      octet_length(prepare_operation_id) BETWEEN 1 AND 255 AND
      prepare_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
    )
  ),
  prepare_request_hash TEXT CHECK (
    prepare_request_hash IS NULL OR
    prepare_request_hash ~ '^[0-9a-f]{64}$'
  ),
  resume_state TEXT CHECK (
    resume_state IS NULL OR
    resume_state IN ('shadow', 'committed', 'draining', 'active_zero')
  ),
  draining_generation NUMERIC(20, 0) CHECK (
    draining_generation IS NULL OR
    draining_generation BETWEEN 1 AND 18446744073709551615
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, authority_kind, partition_key),
  CHECK (
    (route_state = 'prepare' AND
      prepared_generation IS NOT NULL AND
      prepare_operation_id IS NOT NULL AND
      prepare_request_hash IS NOT NULL AND
      resume_state IS NOT NULL) OR
    (route_state <> 'prepare' AND
      prepared_generation IS NULL AND
      prepare_operation_id IS NULL AND
      prepare_request_hash IS NULL AND
      resume_state IS NULL)
  ),
  CHECK (
    prepared_generation IS NULL OR prepared_generation <> current_generation
  ),
  CHECK (
    draining_generation IS NULL OR draining_generation <> current_generation
  ),
  CHECK (
    route_state NOT IN ('committed', 'draining', 'active_zero') OR
    draining_generation IS NOT NULL
  )
);

CREATE TABLE converact_authority_generations (
  tenant_id TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  generation NUMERIC(20, 0) NOT NULL CHECK (
    generation BETWEEN 1 AND 18446744073709551615
  ),
  cell_id TEXT NOT NULL CHECK (
    octet_length(cell_id) BETWEEN 1 AND 255 AND
    cell_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  implementation TEXT NOT NULL CHECK (
    implementation IN ('typescript', 'rust', 'external')
  ),
  owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    owner_epoch BETWEEN 0 AND 18446744073709551615
  ),
  schema_revision NUMERIC(20, 0) NOT NULL CHECK (
    schema_revision BETWEEN 1 AND 18446744073709551615
  ),
  generation_state TEXT NOT NULL CHECK (
    generation_state IN (
      'prepared', 'accepting_new_work', 'draining', 'active_zero', 'retired'
    )
  ),
  lease_token_sha256 TEXT NOT NULL CHECK (
    lease_token_sha256 ~ '^[0-9a-f]{64}$'
  ),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  durable_active_count NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (
    durable_active_count BETWEEN 0 AND 18446744073709551615
  ),
  nonterminal_claims NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (
    nonterminal_claims BETWEEN 0 AND 18446744073709551615
  ),
  claim_tracking_ready_at TIMESTAMPTZ,
  rollback_not_before TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, authority_kind, partition_key, generation),
  FOREIGN KEY (tenant_id, authority_kind, partition_key)
    REFERENCES converact_authority_routes(
      tenant_id, authority_kind, partition_key
  ) ON DELETE RESTRICT,
  CHECK (
    generation_state <> 'active_zero' OR
    (durable_active_count = 0 AND
      nonterminal_claims = 0 AND
      rollback_not_before IS NOT NULL)
  ),
  CHECK (
    generation_state <> 'retired' OR
    (durable_active_count = 0 AND nonterminal_claims = 0)
  )
);

ALTER TABLE converact_authority_routes
  ADD CONSTRAINT converact_authority_route_current_generation_fk
  FOREIGN KEY (
    tenant_id, authority_kind, partition_key, current_generation
  ) REFERENCES converact_authority_generations(
    tenant_id, authority_kind, partition_key, generation
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT converact_authority_route_prepared_generation_fk
  FOREIGN KEY (
    tenant_id, authority_kind, partition_key, prepared_generation
  ) REFERENCES converact_authority_generations(
    tenant_id, authority_kind, partition_key, generation
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT converact_authority_route_draining_generation_fk
  FOREIGN KEY (
    tenant_id, authority_kind, partition_key, draining_generation
  ) REFERENCES converact_authority_generations(
    tenant_id, authority_kind, partition_key, generation
  ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX converact_authority_one_new_work_writer
  ON converact_authority_generations(
    tenant_id, authority_kind, partition_key
  )
  WHERE generation_state = 'accepting_new_work';

CREATE INDEX converact_authority_nonterminal_predecessor_page
  ON converact_authority_generations(
    tenant_id,
    authority_kind,
    partition_key,
    generation
  ) WHERE generation_state IN ('draining', 'active_zero');

CREATE TABLE converact_authority_generation_claims (
  tenant_id TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  generation NUMERIC(20, 0) NOT NULL CHECK (
    generation BETWEEN 1 AND 18446744073709551615
  ),
  claim_kind TEXT NOT NULL CHECK (
    claim_kind IN ('durable_object', 'nonterminal_effect')
  ),
  claim_id TEXT NOT NULL CHECK (
    octet_length(claim_id) BETWEEN 1 AND 255 AND
    claim_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  claim_state TEXT NOT NULL DEFAULT 'active' CHECK (
    claim_state IN ('active', 'released')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  released_at TIMESTAMPTZ,
  idempotency_expires_at TIMESTAMPTZ,
  PRIMARY KEY (
    tenant_id, authority_kind, partition_key, generation, claim_kind, claim_id
  ),
  FOREIGN KEY (tenant_id, authority_kind, partition_key, generation)
    REFERENCES converact_authority_generations(
      tenant_id, authority_kind, partition_key, generation
    ) ON DELETE RESTRICT,
  CHECK (
    (claim_state = 'active' AND released_at IS NULL AND
      idempotency_expires_at IS NULL) OR
    (claim_state = 'released' AND released_at IS NOT NULL AND
      idempotency_expires_at IS NOT NULL AND
      idempotency_expires_at > released_at)
  )
);

CREATE INDEX converact_authority_active_claim_lookup
  ON converact_authority_generation_claims(
    tenant_id, authority_kind, partition_key, generation, claim_kind, claim_id
  ) WHERE claim_state = 'active';

CREATE INDEX converact_authority_released_claim_generation_purge
  ON converact_authority_generation_claims(
    tenant_id, authority_kind, partition_key, generation,
    idempotency_expires_at, claim_kind, claim_id
  ) WHERE claim_state = 'released';

CREATE TABLE converact_authority_route_receipts (
  tenant_id TEXT NOT NULL,
  authority_kind TEXT NOT NULL,
  partition_key TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (
    octet_length(operation_id) BETWEEN 1 AND 255 AND
    operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  request_hash TEXT NOT NULL CHECK (
    request_hash ~ '^[0-9a-f]{64}$'
  ),
  request_binding_sha256 TEXT NOT NULL CHECK (
    request_binding_sha256 ~ '^[0-9a-f]{64}$'
  ),
  command_kind TEXT NOT NULL CHECK (
    command_kind IN (
      'prepare', 'commit', 'abort', 'drain', 'mark_active_zero', 'retire'
    )
  ),
  result_code TEXT NOT NULL CHECK (
    octet_length(result_code) BETWEEN 1 AND 100 AND
    result_code ~ '^[a-z][a-z0-9_]{0,99}$'
  ),
  result_generation NUMERIC(20, 0) NOT NULL CHECK (
    result_generation BETWEEN 1 AND 18446744073709551615
  ),
  result_revision NUMERIC(20, 0) NOT NULL CHECK (
    result_revision BETWEEN 1 AND 18446744073709551615
  ),
  result_payload JSONB NOT NULL CHECK (
    jsonb_typeof(result_payload) = 'object'
  ),
  result_payload_sha256 TEXT NOT NULL CHECK (
    result_payload_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, authority_kind, partition_key, operation_id),
  FOREIGN KEY (tenant_id, authority_kind, partition_key)
    REFERENCES converact_authority_routes(
      tenant_id, authority_kind, partition_key
  ) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION converact_authority_generation_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.generation_state NOT IN ('prepared', 'accepting_new_work') OR
     NEW.durable_active_count <> 0 OR
     NEW.nonterminal_claims <> 0 OR
     NEW.claim_tracking_ready_at IS NOT NULL OR
     NEW.rollback_not_before IS NOT NULL OR
     NEW.lease_expires_at <= transaction_timestamp()
  THEN
    RAISE EXCEPTION 'authority generation bootstrap is invalid'
      USING ERRCODE = '55000';
  END IF;
  NEW.created_at := transaction_timestamp();
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER converact_authority_generation_insert
BEFORE INSERT ON converact_authority_generations
FOR EACH ROW
EXECUTE FUNCTION converact_authority_generation_insert_guard();

CREATE OR REPLACE FUNCTION converact_authority_generation_transition_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authority generation deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.authority_kind IS DISTINCT FROM OLD.authority_kind OR
     NEW.partition_key IS DISTINCT FROM OLD.partition_key OR
     NEW.generation IS DISTINCT FROM OLD.generation OR
     NEW.cell_id IS DISTINCT FROM OLD.cell_id OR
     NEW.implementation IS DISTINCT FROM OLD.implementation OR
     NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch OR
     NEW.schema_revision IS DISTINCT FROM OLD.schema_revision OR
     NEW.lease_token_sha256 IS DISTINCT FROM OLD.lease_token_sha256 OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.lease_expires_at < OLD.lease_expires_at
  THEN
    RAISE EXCEPTION 'authority generation identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.rollback_not_before IS DISTINCT FROM OLD.rollback_not_before AND NOT (
    OLD.generation_state = 'draining' AND
    NEW.generation_state = 'active_zero' AND
    OLD.rollback_not_before IS NULL AND
    NEW.rollback_not_before IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'authority generation rollback boundary is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.claim_tracking_ready_at IS DISTINCT FROM OLD.claim_tracking_ready_at AND NOT (
    OLD.generation_state = 'draining' AND
    NEW.generation_state = 'draining' AND
    OLD.claim_tracking_ready_at IS NULL AND
    NEW.claim_tracking_ready_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'authority generation claim tracking boundary is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.generation_state = 'accepting_new_work' AND
     NEW.lease_expires_at <= transaction_timestamp()
  THEN
    RAISE EXCEPTION 'authority generation lease expired before activation'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.generation_state <> OLD.generation_state AND NOT (
    (OLD.generation_state = 'prepared' AND
      NEW.generation_state IN ('accepting_new_work', 'retired')) OR
    (OLD.generation_state = 'accepting_new_work' AND
      NEW.generation_state = 'draining') OR
    (OLD.generation_state = 'draining' AND
      NEW.generation_state = 'active_zero') OR
    (OLD.generation_state = 'active_zero' AND
      NEW.generation_state = 'retired')
  ) THEN
    RAISE EXCEPTION 'authority generation transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.generation_state = 'active_zero' AND (
    NEW.durable_active_count <> 0 OR
    NEW.nonterminal_claims <> 0 OR
    NEW.claim_tracking_ready_at IS NULL OR
    NEW.rollback_not_before IS NULL OR
    EXISTS (
      SELECT 1
      FROM converact_authority_generation_claims AS claim
      WHERE claim.tenant_id = NEW.tenant_id
        AND claim.authority_kind = NEW.authority_kind
        AND claim.partition_key = NEW.partition_key
        AND claim.generation = NEW.generation
        AND claim.claim_state = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'authority generation is not durably quiescent'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.generation_state = 'retired' AND (
    OLD.generation_state = 'active_zero' AND (
      OLD.rollback_not_before IS NULL OR
      OLD.rollback_not_before > transaction_timestamp()
    )
  ) THEN
    RAISE EXCEPTION 'authority generation rollback window remains open'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.generation_state IN ('active_zero', 'retired') AND
     NEW.generation_state = OLD.generation_state
  THEN
    RAISE EXCEPTION 'sealed authority generation is immutable'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER converact_authority_generation_transition
BEFORE UPDATE OR DELETE ON converact_authority_generations
FOR EACH ROW
EXECUTE FUNCTION converact_authority_generation_transition_guard();

CREATE OR REPLACE FUNCTION converact_authority_route_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.route_state <> 'shadow' OR
     NEW.route_revision <> 1 OR
     NEW.prepared_generation IS NOT NULL OR
     NEW.draining_generation IS NOT NULL
  THEN
    RAISE EXCEPTION 'authority route bootstrap is invalid'
      USING ERRCODE = '55000';
  END IF;
  NEW.created_at := transaction_timestamp();
  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER converact_authority_route_insert
BEFORE INSERT ON converact_authority_routes
FOR EACH ROW
EXECUTE FUNCTION converact_authority_route_insert_guard();

CREATE OR REPLACE FUNCTION converact_authority_route_transition_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authority route deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.authority_kind IS DISTINCT FROM OLD.authority_kind OR
     NEW.partition_key IS DISTINCT FROM OLD.partition_key OR
     NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'authority route identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.route_revision = 18446744073709551615 OR
     NEW.route_revision <> OLD.route_revision + 1
  THEN
    RAISE EXCEPTION 'authority route revision is stale or exhausted'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.route_state IN ('shadow', 'committed', 'draining', 'active_zero') AND
      NEW.route_state = 'prepare') OR
    (OLD.route_state = 'prepare' AND
      NEW.route_state = OLD.resume_state) OR
    (OLD.route_state = 'prepare' AND NEW.route_state = 'committed') OR
    (OLD.route_state = 'committed' AND NEW.route_state = 'draining') OR
    (OLD.route_state = 'draining' AND NEW.route_state = 'active_zero') OR
    (OLD.route_state = 'active_zero' AND NEW.route_state = 'retired')
  ) THEN
    RAISE EXCEPTION 'authority route transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.route_state = 'prepare' AND (
    NEW.resume_state IS DISTINCT FROM OLD.route_state OR
    OLD.current_generation = 18446744073709551615 OR
    NEW.prepared_generation <> OLD.current_generation + 1 OR
    NEW.draining_generation IS DISTINCT FROM OLD.draining_generation
  ) THEN
    RAISE EXCEPTION 'authority route prepare binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.route_state = 'prepare' AND NEW.route_state = 'committed' THEN
    IF NEW.current_generation IS DISTINCT FROM OLD.prepared_generation OR
       NEW.draining_generation IS DISTINCT FROM OLD.current_generation
    THEN
      RAISE EXCEPTION 'authority route commit binding is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.route_state = 'active_zero' AND NEW.route_state = 'retired' THEN
    IF NEW.current_generation IS DISTINCT FROM OLD.current_generation OR
       NEW.draining_generation IS NOT NULL
    THEN
      RAISE EXCEPTION 'authority route retirement did not seal predecessor'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.current_generation IS DISTINCT FROM OLD.current_generation THEN
    RAISE EXCEPTION 'authority route current generation changed out of commit'
      USING ERRCODE = '55000';
  ELSIF NEW.draining_generation IS DISTINCT FROM OLD.draining_generation THEN
    RAISE EXCEPTION 'authority route predecessor changed out of commit'
      USING ERRCODE = '55000';
  END IF;

  NEW.updated_at := transaction_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER converact_authority_route_transition
BEFORE UPDATE OR DELETE ON converact_authority_routes
FOR EACH ROW
EXECUTE FUNCTION converact_authority_route_transition_guard();

CREATE OR REPLACE FUNCTION converact_authority_route_consistency_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_state TEXT;
  current_lease_expires_at TIMESTAMPTZ;
  current_owner_epoch NUMERIC(20, 0);
  prepared_state TEXT;
  prepared_owner_epoch NUMERIC(20, 0);
  draining_state TEXT;
  expected_draining_state TEXT;
BEGIN
  SELECT generation.generation_state, generation.lease_expires_at,
    generation.owner_epoch
  INTO current_state, current_lease_expires_at, current_owner_epoch
  FROM converact_authority_generations AS generation
  WHERE generation.tenant_id = NEW.tenant_id
    AND generation.authority_kind = NEW.authority_kind
    AND generation.partition_key = NEW.partition_key
    AND generation.generation = NEW.current_generation;

  IF current_state IS DISTINCT FROM 'accepting_new_work' OR (
     NEW.route_state <> 'prepare' AND
     current_lease_expires_at <= transaction_timestamp()
  )
  THEN
    RAISE EXCEPTION 'authority route current generation is not writable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.route_state = 'prepare' THEN
    SELECT generation.generation_state, generation.owner_epoch
    INTO prepared_state, prepared_owner_epoch
    FROM converact_authority_generations AS generation
    WHERE generation.tenant_id = NEW.tenant_id
      AND generation.authority_kind = NEW.authority_kind
      AND generation.partition_key = NEW.partition_key
      AND generation.generation = NEW.prepared_generation;
    IF prepared_state IS DISTINCT FROM 'prepared' OR
       prepared_owner_epoch <= current_owner_epoch
    THEN
      RAISE EXCEPTION 'authority route prepared generation is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  expected_draining_state := CASE
    WHEN NEW.route_state = 'committed' THEN 'draining'
    WHEN NEW.route_state = 'draining' THEN 'draining'
    WHEN NEW.route_state = 'active_zero' THEN 'active_zero'
    WHEN NEW.route_state = 'prepare' AND NEW.resume_state IN ('committed', 'draining')
      THEN 'draining'
    WHEN NEW.route_state = 'prepare' AND NEW.resume_state = 'active_zero'
      THEN 'active_zero'
    ELSE NULL
  END;

  IF expected_draining_state IS NOT NULL THEN
    SELECT generation.generation_state
    INTO draining_state
    FROM converact_authority_generations AS generation
    WHERE generation.tenant_id = NEW.tenant_id
      AND generation.authority_kind = NEW.authority_kind
      AND generation.partition_key = NEW.partition_key
      AND generation.generation = NEW.draining_generation;
    IF draining_state IS DISTINCT FROM expected_draining_state THEN
      RAISE EXCEPTION 'authority route predecessor generation is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.draining_generation IS NOT NULL THEN
    RAISE EXCEPTION 'authority route has an unexpected predecessor generation'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER converact_authority_route_consistency
AFTER INSERT OR UPDATE ON converact_authority_routes
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION converact_authority_route_consistency_guard();

CREATE OR REPLACE FUNCTION converact_authority_generation_route_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  route_current_generation NUMERIC(20, 0);
  route_prepared_generation NUMERIC(20, 0);
  route_draining_generation NUMERIC(20, 0);
  route_state_value TEXT;
  route_resume_state TEXT;
  expected_draining_state TEXT;
BEGIN
  SELECT
    route.current_generation,
    route.prepared_generation,
    route.draining_generation,
    route.route_state,
    route.resume_state
  INTO STRICT
    route_current_generation,
    route_prepared_generation,
    route_draining_generation,
    route_state_value,
    route_resume_state
  FROM converact_authority_routes AS route
  WHERE route.tenant_id = NEW.tenant_id
    AND route.authority_kind = NEW.authority_kind
    AND route.partition_key = NEW.partition_key;

  IF NEW.generation = route_current_generation THEN
    IF NEW.generation_state <> 'accepting_new_work' OR
       NEW.lease_expires_at <= transaction_timestamp()
    THEN
      RAISE EXCEPTION 'authority current generation lost write authority'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.generation = route_prepared_generation THEN
    IF route_state_value <> 'prepare' OR NEW.generation_state <> 'prepared' THEN
      RAISE EXCEPTION 'authority prepared generation is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.generation = route_draining_generation THEN
    expected_draining_state := CASE
      WHEN route_state_value IN ('committed', 'draining') THEN 'draining'
      WHEN route_state_value = 'active_zero' THEN 'active_zero'
      WHEN route_state_value = 'prepare' AND
        route_resume_state IN ('committed', 'draining') THEN 'draining'
      WHEN route_state_value = 'prepare' AND
        route_resume_state = 'active_zero' THEN 'active_zero'
      ELSE NULL
    END;
    IF NEW.generation_state IS DISTINCT FROM expected_draining_state THEN
      RAISE EXCEPTION 'authority predecessor generation is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.generation_state IN ('prepared', 'accepting_new_work') THEN
    RAISE EXCEPTION 'authority generation has unreferenced write authority'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER converact_authority_generation_route_consistency
AFTER INSERT OR UPDATE ON converact_authority_generations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION converact_authority_generation_route_guard();

CREATE OR REPLACE FUNCTION converact_authority_generation_claim_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.claim_state = 'released' AND
       OLD.idempotency_expires_at <= transaction_timestamp()
    THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'authority generation claim deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.claim_state <> 'active' OR NEW.released_at IS NOT NULL OR
       NEW.idempotency_expires_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'authority generation claim bootstrap is invalid'
        USING ERRCODE = '55000';
    END IF;
    NEW.created_at := transaction_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR
     NEW.authority_kind IS DISTINCT FROM OLD.authority_kind OR
     NEW.partition_key IS DISTINCT FROM OLD.partition_key OR
     NEW.generation IS DISTINCT FROM OLD.generation OR
     NEW.claim_kind IS DISTINCT FROM OLD.claim_kind OR
     NEW.claim_id IS DISTINCT FROM OLD.claim_id OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     OLD.claim_state <> 'active' OR
     NEW.claim_state <> 'released' OR
     OLD.released_at IS NOT NULL OR
     NEW.released_at IS NULL OR
     OLD.idempotency_expires_at IS NOT NULL OR
     NEW.idempotency_expires_at IS NULL
  THEN
    RAISE EXCEPTION 'authority generation claim transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  NEW.released_at := transaction_timestamp();
  NEW.idempotency_expires_at := transaction_timestamp() + interval '7 days';
  RETURN NEW;
END
$$;

CREATE TRIGGER converact_authority_generation_claim_transition
BEFORE INSERT OR UPDATE OR DELETE ON converact_authority_generation_claims
FOR EACH ROW
EXECUTE FUNCTION converact_authority_generation_claim_guard();

CREATE OR REPLACE FUNCTION converact_authority_route_receipt_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'authority migration receipts are immutable'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER converact_authority_route_receipt_immutable
BEFORE UPDATE OR DELETE ON converact_authority_route_receipts
FOR EACH ROW
EXECUTE FUNCTION converact_authority_route_receipt_immutable();

CREATE OR REPLACE FUNCTION converact_authority_writer_fence(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_owner_epoch NUMERIC(20, 0),
  p_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_generation NUMERIC(20, 0);
  matched_generation_state TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'authority writer tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;

  IF octet_length(p_tenant_id) NOT BETWEEN 1 AND 255 OR
     octet_length(p_authority_kind) NOT BETWEEN 1 AND 255 OR
     octet_length(p_partition_key) NOT BETWEEN 1 AND 255 OR
     p_generation NOT BETWEEN 1 AND 18446744073709551615 OR
     p_owner_epoch NOT BETWEEN 0 AND 18446744073709551615 OR
     p_lease_token !~ '^[0-9a-f]{64}$' OR
     p_object_scope NOT IN ('new', 'existing')
  THEN
    RAISE EXCEPTION 'authority writer fence input is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT route.current_generation, generation.generation_state
  INTO current_generation, matched_generation_state
  FROM converact_authority_generations AS generation
  INNER JOIN converact_authority_routes AS route
    ON route.tenant_id = generation.tenant_id
   AND route.authority_kind = generation.authority_kind
   AND route.partition_key = generation.partition_key
  WHERE route.tenant_id = p_tenant_id
    AND route.authority_kind = p_authority_kind
    AND route.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.owner_epoch = p_owner_epoch
    AND generation.lease_token_sha256 =
      encode(sha256(convert_to(p_lease_token, 'UTF8')), 'hex')
    AND generation.lease_expires_at > transaction_timestamp()
  FOR SHARE OF route, generation;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority writer fence is stale'
      USING ERRCODE = '55000';
  END IF;

  IF p_object_scope = 'new' AND
     p_object_starting_generation IS NULL AND
     current_generation = p_generation AND
     matched_generation_state = 'accepting_new_work'
  THEN
    RETURN TRUE;
  END IF;

  IF p_object_scope = 'existing' AND
     p_object_starting_generation = p_generation AND
     matched_generation_state IN ('accepting_new_work', 'draining')
  THEN
    RETURN TRUE;
  END IF;

  RAISE EXCEPTION 'authority writer generation is not authorized'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_renew_lease(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_owner_epoch NUMERIC(20, 0),
  p_lease_token TEXT,
  p_lease_ttl_ms BIGINT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  renewed_expires_at TIMESTAMPTZ;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'authority lease tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;

  IF p_generation NOT BETWEEN 1 AND 18446744073709551615 OR
     p_owner_epoch NOT BETWEEN 0 AND 18446744073709551615 OR
     p_lease_token !~ '^[0-9a-f]{64}$' OR
     p_lease_ttl_ms NOT BETWEEN 1 AND 86400000
  THEN
    RAISE EXCEPTION 'authority lease renewal input is invalid'
      USING ERRCODE = '55000';
  END IF;

  UPDATE converact_authority_generations AS generation
  SET lease_expires_at = GREATEST(
    generation.lease_expires_at,
    transaction_timestamp() + (p_lease_ttl_ms * interval '1 millisecond')
  )
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.owner_epoch = p_owner_epoch
    AND generation.lease_token_sha256 =
      encode(sha256(convert_to(p_lease_token, 'UTF8')), 'hex')
    AND generation.lease_expires_at > transaction_timestamp()
    AND generation.generation_state IN (
      'prepared', 'accepting_new_work', 'draining'
    )
  RETURNING generation.lease_expires_at INTO renewed_expires_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority lease renewal fence is stale'
      USING ERRCODE = '55000';
  END IF;
  RETURN renewed_expires_at;
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_claim_generation_work(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_owner_epoch NUMERIC(20, 0),
  p_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_claim_kind TEXT,
  p_claim_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  inserted_count BIGINT;
  existing_state TEXT;
  updated_count BIGINT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
       nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'authority generation claim tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  IF p_claim_kind NOT IN ('durable_object', 'nonterminal_effect') OR
     octet_length(p_claim_id) NOT BETWEEN 1 AND 255 OR
     p_claim_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  THEN
    RAISE EXCEPTION 'authority generation claim input is invalid'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM converact_authority_routes AS route
  WHERE route.tenant_id = p_tenant_id
    AND route.authority_kind = p_authority_kind
    AND route.partition_key = p_partition_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority generation claim route is missing'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM converact_authority_generations AS generation
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority generation claim target is missing'
      USING ERRCODE = '55000';
  END IF;

  PERFORM converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key, p_generation,
    p_owner_epoch, p_lease_token, p_object_scope,
    p_object_starting_generation
  );
  INSERT INTO converact_authority_generation_claims (
    tenant_id, authority_kind, partition_key, generation, claim_kind, claim_id
  ) VALUES (
    p_tenant_id, p_authority_kind, p_partition_key, p_generation,
    p_claim_kind, p_claim_id
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count = 0 THEN
    SELECT claim.claim_state INTO existing_state
    FROM converact_authority_generation_claims AS claim
    WHERE claim.tenant_id = p_tenant_id
      AND claim.authority_kind = p_authority_kind
      AND claim.partition_key = p_partition_key
      AND claim.generation = p_generation
      AND claim.claim_kind = p_claim_kind
      AND claim.claim_id = p_claim_id;
    IF existing_state = 'active' THEN
      RETURN FALSE;
    END IF;
    RAISE EXCEPTION 'authority generation claim cannot be resurrected'
      USING ERRCODE = '55000';
  END IF;

  UPDATE converact_authority_generations AS generation
  SET durable_active_count = generation.durable_active_count +
        CASE WHEN p_claim_kind = 'durable_object' THEN 1 ELSE 0 END,
      nonterminal_claims = generation.nonterminal_claims +
        CASE WHEN p_claim_kind = 'nonterminal_effect' THEN 1 ELSE 0 END
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.generation_state IN ('accepting_new_work', 'draining')
    AND generation.durable_active_count < 18446744073709551615
    AND generation.nonterminal_claims < 18446744073709551615;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'authority generation claim counter rejected'
      USING ERRCODE = '55000';
  END IF;
  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_release_generation_work(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_owner_epoch NUMERIC(20, 0),
  p_lease_token TEXT,
  p_claim_kind TEXT,
  p_claim_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  released_kind TEXT;
  existing_state TEXT;
  updated_count BIGINT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
       nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'authority generation release tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM converact_authority_routes AS route
  WHERE route.tenant_id = p_tenant_id
    AND route.authority_kind = p_authority_kind
    AND route.partition_key = p_partition_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority generation release route is missing'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM converact_authority_generations AS generation
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority generation release target is missing'
      USING ERRCODE = '55000';
  END IF;
  PERFORM converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key, p_generation,
    p_owner_epoch, p_lease_token, 'existing', p_generation
  );
  UPDATE converact_authority_generation_claims AS claim
  SET claim_state = 'released', released_at = transaction_timestamp(),
      idempotency_expires_at = transaction_timestamp() + interval '7 days'
  WHERE claim.tenant_id = p_tenant_id
    AND claim.authority_kind = p_authority_kind
    AND claim.partition_key = p_partition_key
    AND claim.generation = p_generation
    AND claim.claim_kind = p_claim_kind
    AND claim.claim_id = p_claim_id
    AND claim.claim_state = 'active'
  RETURNING claim.claim_kind INTO released_kind;
  IF NOT FOUND THEN
    SELECT claim.claim_state INTO existing_state
    FROM converact_authority_generation_claims AS claim
    WHERE claim.tenant_id = p_tenant_id
      AND claim.authority_kind = p_authority_kind
      AND claim.partition_key = p_partition_key
      AND claim.generation = p_generation
      AND claim.claim_kind = p_claim_kind
      AND claim.claim_id = p_claim_id;
    IF existing_state = 'released' THEN
      RETURN FALSE;
    END IF;
    RAISE EXCEPTION 'authority generation claim is missing'
      USING ERRCODE = '55000';
  END IF;

  UPDATE converact_authority_generations AS generation
  SET durable_active_count = generation.durable_active_count -
        CASE WHEN released_kind = 'durable_object' THEN 1 ELSE 0 END,
      nonterminal_claims = generation.nonterminal_claims -
        CASE WHEN released_kind = 'nonterminal_effect' THEN 1 ELSE 0 END
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.durable_active_count >=
      CASE WHEN released_kind = 'durable_object' THEN 1 ELSE 0 END
    AND generation.nonterminal_claims >=
      CASE WHEN released_kind = 'nonterminal_effect' THEN 1 ELSE 0 END;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'authority generation release counter rejected'
      USING ERRCODE = '55000';
  END IF;
  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_reconcile_generation_claim(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_claim_kind TEXT,
  p_claim_id TEXT,
  p_is_active BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  changed_count BIGINT;
  existing_state TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '') OR
     p_claim_kind NOT IN ('durable_object', 'nonterminal_effect')
  THEN
    RAISE EXCEPTION 'authority claim reconciliation fence rejected'
      USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM converact_authority_generations AS generation
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.generation_state = 'draining'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authority claim reconciliation generation rejected'
      USING ERRCODE = '55000';
  END IF;

  IF p_is_active THEN
    INSERT INTO converact_authority_generation_claims (
      tenant_id, authority_kind, partition_key, generation, claim_kind, claim_id
    ) VALUES (
      p_tenant_id, p_authority_kind, p_partition_key, p_generation,
      p_claim_kind, p_claim_id
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS changed_count = ROW_COUNT;
    IF changed_count = 0 THEN
      SELECT claim.claim_state INTO existing_state
      FROM converact_authority_generation_claims AS claim
      WHERE claim.tenant_id = p_tenant_id
        AND claim.authority_kind = p_authority_kind
        AND claim.partition_key = p_partition_key
        AND claim.generation = p_generation
        AND claim.claim_kind = p_claim_kind
        AND claim.claim_id = p_claim_id;
      IF existing_state = 'active' THEN
        RETURN FALSE;
      END IF;
      RAISE EXCEPTION 'released authority claim cannot be reconciled active'
        USING ERRCODE = '55000';
    END IF;
    UPDATE converact_authority_generations AS generation
    SET durable_active_count = generation.durable_active_count +
          CASE WHEN p_claim_kind = 'durable_object' THEN 1 ELSE 0 END,
        nonterminal_claims = generation.nonterminal_claims +
          CASE WHEN p_claim_kind = 'nonterminal_effect' THEN 1 ELSE 0 END
    WHERE generation.tenant_id = p_tenant_id
      AND generation.authority_kind = p_authority_kind
      AND generation.partition_key = p_partition_key
      AND generation.generation = p_generation;
    RETURN TRUE;
  END IF;

  UPDATE converact_authority_generation_claims AS claim
  SET claim_state = 'released', released_at = transaction_timestamp(),
      idempotency_expires_at = transaction_timestamp() + interval '7 days'
  WHERE claim.tenant_id = p_tenant_id
    AND claim.authority_kind = p_authority_kind
    AND claim.partition_key = p_partition_key
    AND claim.generation = p_generation
    AND claim.claim_kind = p_claim_kind
    AND claim.claim_id = p_claim_id
    AND claim.claim_state = 'active';
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count = 0 THEN
    SELECT claim.claim_state INTO existing_state
    FROM converact_authority_generation_claims AS claim
    WHERE claim.tenant_id = p_tenant_id
      AND claim.authority_kind = p_authority_kind
      AND claim.partition_key = p_partition_key
      AND claim.generation = p_generation
      AND claim.claim_kind = p_claim_kind
      AND claim.claim_id = p_claim_id;
    IF existing_state = 'released' THEN
      RETURN FALSE;
    END IF;
    RAISE EXCEPTION 'authority claim reconciliation target is missing'
      USING ERRCODE = '55000';
  END IF;
  UPDATE converact_authority_generations AS generation
  SET durable_active_count = generation.durable_active_count -
        CASE WHEN p_claim_kind = 'durable_object' THEN 1 ELSE 0 END,
      nonterminal_claims = generation.nonterminal_claims -
        CASE WHEN p_claim_kind = 'nonterminal_effect' THEN 1 ELSE 0 END
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation;
  RETURN TRUE;
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_seal_generation_claims(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  changed_count BIGINT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'authority claim seal tenant fence rejected'
      USING ERRCODE = '42501';
  END IF;
  UPDATE converact_authority_generations AS generation
  SET claim_tracking_ready_at = transaction_timestamp()
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.generation_state = 'draining'
    AND generation.claim_tracking_ready_at IS NULL;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count = 1 THEN
    RETURN TRUE;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM converact_authority_generations AS generation
    WHERE generation.tenant_id = p_tenant_id
      AND generation.authority_kind = p_authority_kind
      AND generation.partition_key = p_partition_key
      AND generation.generation = p_generation
      AND generation.generation_state = 'draining'
      AND generation.claim_tracking_ready_at IS NOT NULL
  );
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_mark_unreferenced_active_zero(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_rollback_window_ms BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  route_current NUMERIC(20, 0);
  route_prepared NUMERIC(20, 0);
  route_draining NUMERIC(20, 0);
  changed_count BIGINT;
  existing_state TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
       nullif(current_setting('app.current_tenant', true), '') OR
     p_rollback_window_ms NOT BETWEEN 1 AND 2592000000
  THEN
    RAISE EXCEPTION 'authority predecessor active-zero input rejected'
      USING ERRCODE = '42501';
  END IF;
  SELECT route.current_generation, route.prepared_generation,
    route.draining_generation
  INTO STRICT route_current, route_prepared, route_draining
  FROM converact_authority_routes AS route
  WHERE route.tenant_id = p_tenant_id
    AND route.authority_kind = p_authority_kind
    AND route.partition_key = p_partition_key
  FOR UPDATE;
  IF p_generation IN (route_current, route_prepared, route_draining) THEN
    RAISE EXCEPTION 'authority predecessor is still route referenced'
      USING ERRCODE = '55000';
  END IF;
  UPDATE converact_authority_generations AS generation
  SET generation_state = 'active_zero',
      rollback_not_before = transaction_timestamp() +
        (p_rollback_window_ms * interval '1 millisecond')
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.generation_state = 'draining'
    AND generation.claim_tracking_ready_at IS NOT NULL
    AND generation.durable_active_count = 0
    AND generation.nonterminal_claims = 0
    AND NOT EXISTS (
      SELECT 1 FROM converact_authority_generation_claims AS claim
      WHERE claim.tenant_id = p_tenant_id
        AND claim.authority_kind = p_authority_kind
        AND claim.partition_key = p_partition_key
        AND claim.generation = p_generation
        AND claim.claim_state = 'active'
    );
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count = 1 THEN
    RETURN TRUE;
  END IF;
  SELECT generation.generation_state INTO existing_state
  FROM converact_authority_generations AS generation
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation;
  IF existing_state = 'active_zero' THEN
    RETURN FALSE;
  END IF;
  RAISE EXCEPTION 'authority predecessor is not durably quiescent'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_retire_unreferenced_generation(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  route_current NUMERIC(20, 0);
  route_prepared NUMERIC(20, 0);
  route_draining NUMERIC(20, 0);
  changed_count BIGINT;
  existing_state TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
     nullif(current_setting('app.current_tenant', true), '')
  THEN
    RAISE EXCEPTION 'authority predecessor retirement tenant rejected'
      USING ERRCODE = '42501';
  END IF;
  SELECT route.current_generation, route.prepared_generation,
    route.draining_generation
  INTO STRICT route_current, route_prepared, route_draining
  FROM converact_authority_routes AS route
  WHERE route.tenant_id = p_tenant_id
    AND route.authority_kind = p_authority_kind
    AND route.partition_key = p_partition_key
  FOR UPDATE;
  IF p_generation IN (route_current, route_prepared, route_draining) THEN
    RAISE EXCEPTION 'authority predecessor is still route referenced'
      USING ERRCODE = '55000';
  END IF;
  UPDATE converact_authority_generations AS generation
  SET generation_state = 'retired'
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation
    AND generation.generation_state = 'active_zero'
    AND generation.rollback_not_before <= transaction_timestamp()
    AND generation.durable_active_count = 0
    AND generation.nonterminal_claims = 0;
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count = 1 THEN
    RETURN TRUE;
  END IF;
  SELECT generation.generation_state INTO existing_state
  FROM converact_authority_generations AS generation
  WHERE generation.tenant_id = p_tenant_id
    AND generation.authority_kind = p_authority_kind
    AND generation.partition_key = p_partition_key
    AND generation.generation = p_generation;
  IF existing_state = 'retired' THEN
    RETURN FALSE;
  END IF;
  RAISE EXCEPTION 'authority predecessor rollback window remains open'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_authority_purge_released_claims(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_generation NUMERIC(20, 0),
  p_expired_before TIMESTAMPTZ,
  p_limit INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM
       nullif(current_setting('app.current_tenant', true), '') OR
     p_authority_kind IS NULL OR
     p_partition_key IS NULL OR
     p_expired_before IS NULL OR
     p_limit IS NULL OR
     octet_length(p_authority_kind) NOT BETWEEN 1 AND 255 OR
     p_authority_kind !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR
     octet_length(p_partition_key) NOT BETWEEN 1 AND 255 OR
     p_partition_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' OR
     p_generation IS NULL OR
     p_generation NOT BETWEEN 1 AND 18446744073709551615 OR
     p_expired_before > transaction_timestamp() OR
     p_limit NOT BETWEEN 1 AND 256
  THEN
    RAISE EXCEPTION 'authority claim purge input rejected'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM converact_authority_generations AS generation
    WHERE generation.tenant_id = p_tenant_id
      AND generation.authority_kind = p_authority_kind
      AND generation.partition_key = p_partition_key
      AND generation.generation = p_generation
      AND generation.generation_state = 'retired'
  ) THEN
    RETURN 0;
  END IF;
  DELETE FROM converact_authority_generation_claims AS claim
  WHERE claim.ctid IN (
    SELECT candidate.ctid
    FROM converact_authority_generation_claims AS candidate
    WHERE candidate.tenant_id = p_tenant_id
      AND candidate.authority_kind = p_authority_kind
      AND candidate.partition_key = p_partition_key
      AND candidate.generation = p_generation
      AND candidate.claim_state = 'released'
      AND candidate.idempotency_expires_at <= p_expired_before
    ORDER BY candidate.idempotency_expires_at, candidate.claim_kind,
      candidate.claim_id
    FOR UPDATE OF candidate SKIP LOCKED
    LIMIT p_limit
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count::INTEGER;
END
$$;

ALTER TABLE converact_authority_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_authority_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_authority_routes FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_authority_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_authority_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_authority_generations FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_authority_generation_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_authority_generation_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_authority_generation_claims FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_authority_route_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_authority_route_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_authority_route_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL PRIVILEGES ON
  converact_authority_routes,
  converact_authority_generations,
  converact_authority_generation_claims,
  converact_authority_route_receipts
FROM PUBLIC;

REVOKE ALL ON FUNCTION converact_authority_generation_insert_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_generation_transition_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_route_insert_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_route_transition_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_route_consistency_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_generation_route_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_generation_claim_guard()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_route_receipt_immutable()
  FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_renew_lease(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, BIGINT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_claim_generation_work(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_release_generation_work(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_reconcile_generation_claim(
  TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, BOOLEAN
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_seal_generation_claims(
  TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_mark_unreferenced_active_zero(
  TEXT, TEXT, TEXT, NUMERIC, BIGINT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_retire_unreferenced_generation(
  TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_authority_purge_released_claims(
  TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, INTEGER
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime') THEN
    GRANT SELECT ON converact_authority_routes TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_authority_renew_lease(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, BIGINT
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_authority_claim_generation_work(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT
    ) TO opc_runtime;
    GRANT EXECUTE ON FUNCTION converact_authority_release_generation_work(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT
    ) TO opc_runtime;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO opc_migration_executor;
GRANT SELECT, INSERT, UPDATE ON
  converact_authority_routes,
  converact_authority_generations
TO opc_migration_executor;
GRANT SELECT, INSERT ON converact_authority_route_receipts
  TO opc_migration_executor;
GRANT SELECT ON converact_authority_generation_claims
  TO opc_migration_executor;
GRANT EXECUTE ON FUNCTION converact_authority_reconcile_generation_claim(
  TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, BOOLEAN
) TO opc_migration_executor;
GRANT EXECUTE ON FUNCTION converact_authority_seal_generation_claims(
  TEXT, TEXT, TEXT, NUMERIC
) TO opc_migration_executor;
GRANT EXECUTE ON FUNCTION converact_authority_mark_unreferenced_active_zero(
  TEXT, TEXT, TEXT, NUMERIC, BIGINT
) TO opc_migration_executor;
GRANT EXECUTE ON FUNCTION converact_authority_retire_unreferenced_generation(
  TEXT, TEXT, TEXT, NUMERIC
) TO opc_migration_executor;
GRANT EXECUTE ON FUNCTION converact_authority_purge_released_claims(
  TEXT, TEXT, TEXT, NUMERIC, TIMESTAMPTZ, INTEGER
) TO opc_migration_executor;

COMMENT ON TABLE converact_authority_routes IS
  'Exact tenant/Authority/partition implementation route; one current new-work writer.';
COMMENT ON TABLE converact_authority_generations IS
  'Immutable writer identity and forward-only generation lifecycle; stores only a lease digest.';
COMMENT ON TABLE converact_authority_generation_claims IS
  'Idempotent durable-object and nonterminal-effect claims gating active-zero.';
COMMENT ON TABLE converact_authority_route_receipts IS
  'Immutable operation receipt used to query and reconcile unknown migration outcomes without replay.';
COMMENT ON FUNCTION converact_authority_writer_fence(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
) IS
  'Atomic database-time write authorization for one exact route and object generation.';
