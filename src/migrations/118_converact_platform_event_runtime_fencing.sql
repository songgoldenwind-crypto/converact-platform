-- Additive rolling schema for the Rust event persistence adapter. Legacy rows
-- remain readable with NULL route provenance; every new target row must carry
-- one exact AuthorityRoute generation and owner identity.

SET LOCAL lock_timeout = '5s';

ALTER TABLE converact_platform_outbox
  ADD COLUMN route_authority_kind TEXT,
  ADD COLUMN route_partition_key TEXT,
  ADD COLUMN route_generation NUMERIC(20, 0),
  ADD COLUMN route_owner_epoch NUMERIC(20, 0),
  ADD COLUMN route_object_scope TEXT,
  ADD COLUMN route_object_starting_generation NUMERIC(20, 0),
  ADD COLUMN event_envelope JSONB,
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN last_error_code TEXT NOT NULL DEFAULT '',
  ADD COLUMN transition_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN dead_lettered_at TIMESTAMPTZ,
  ADD CONSTRAINT converact_platform_outbox_route_shape CHECK (
    (
      route_authority_kind IS NULL AND
      route_partition_key IS NULL AND
      route_generation IS NULL AND
      route_owner_epoch IS NULL AND
      route_object_scope IS NULL AND
      route_object_starting_generation IS NULL
    ) OR (
      octet_length(route_authority_kind) BETWEEN 1 AND 255 AND
      route_authority_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      octet_length(route_partition_key) BETWEEN 1 AND 255 AND
      route_partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      route_generation BETWEEN 1 AND 18446744073709551615 AND
      route_owner_epoch BETWEEN 0 AND 18446744073709551615 AND
      jsonb_typeof(event_envelope) = 'object' AND
      (
        (route_object_scope = 'new' AND
          route_object_starting_generation IS NULL) OR
        (route_object_scope = 'existing' AND
          route_object_starting_generation = route_generation)
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT converact_platform_outbox_route_generation_fkey
    FOREIGN KEY (
      tenant_id, route_authority_kind, route_partition_key,
      route_generation, route_owner_epoch
    ) REFERENCES converact_authority_generations (
      tenant_id, authority_kind, partition_key, generation, owner_epoch
    ) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT converact_platform_outbox_attempt_bound CHECK (
    max_attempts BETWEEN 1 AND 1000 AND
    attempt_count >= 0 AND attempt_count <= max_attempts
  ) NOT VALID,
  ADD CONSTRAINT converact_platform_outbox_transition_bound CHECK (
    transition_revision >= 0 AND
    octet_length(last_error_code) <= 255 AND
    (last_error_code = '' OR
      last_error_code ~ '^[a-z][a-z0-9_]{0,254}$')
  ) NOT VALID,
  ADD CONSTRAINT converact_platform_outbox_lease_hash_v2 CHECK (
    lease_token_hash = '' OR lease_token_hash ~ '^[0-9a-f]{64}$'
  ) NOT VALID,
  ADD CONSTRAINT converact_platform_outbox_lifecycle_shape CHECK (
    (
      status = 'pending' AND worker_id = '' AND lease_token_hash = '' AND
      lease_until IS NULL AND delivered_at IS NULL AND
      dead_lettered_at IS NULL
    ) OR (
      status = 'claimed' AND octet_length(worker_id) BETWEEN 1 AND 255 AND
      worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      lease_token_hash ~ '^[0-9a-f]{64}$' AND lease_until IS NOT NULL AND
      delivered_at IS NULL AND dead_lettered_at IS NULL
    ) OR (
      status = 'delivered' AND worker_id = '' AND lease_token_hash = '' AND
      lease_until IS NULL AND delivered_at IS NOT NULL AND
      dead_lettered_at IS NULL
    ) OR (
      status = 'dead_letter' AND worker_id = '' AND lease_token_hash = '' AND
      lease_until IS NULL AND delivered_at IS NULL AND
      dead_lettered_at IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE converact_platform_inbox
  ADD COLUMN route_authority_kind TEXT,
  ADD COLUMN route_partition_key TEXT,
  ADD COLUMN route_generation NUMERIC(20, 0),
  ADD COLUMN route_owner_epoch NUMERIC(20, 0),
  ADD COLUMN route_object_scope TEXT,
  ADD COLUMN route_object_starting_generation NUMERIC(20, 0),
  ADD CONSTRAINT converact_platform_inbox_route_shape CHECK (
    (
      route_authority_kind IS NULL AND
      route_partition_key IS NULL AND
      route_generation IS NULL AND
      route_owner_epoch IS NULL AND
      route_object_scope IS NULL AND
      route_object_starting_generation IS NULL
    ) OR (
      octet_length(route_authority_kind) BETWEEN 1 AND 255 AND
      route_authority_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      octet_length(route_partition_key) BETWEEN 1 AND 255 AND
      route_partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      route_generation BETWEEN 1 AND 18446744073709551615 AND
      route_owner_epoch BETWEEN 0 AND 18446744073709551615 AND
      (
        (route_object_scope = 'new' AND
          route_object_starting_generation IS NULL) OR
        (route_object_scope = 'existing' AND
          route_object_starting_generation = route_generation)
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT converact_platform_inbox_route_generation_fkey
    FOREIGN KEY (
      tenant_id, route_authority_kind, route_partition_key,
      route_generation, route_owner_epoch
    ) REFERENCES converact_authority_generations (
      tenant_id, authority_kind, partition_key, generation, owner_epoch
    ) ON DELETE RESTRICT NOT VALID;

ALTER TABLE converact_platform_effect_receipts
  ADD COLUMN route_authority_kind TEXT,
  ADD COLUMN route_partition_key TEXT,
  ADD COLUMN route_generation NUMERIC(20, 0),
  ADD COLUMN route_owner_epoch NUMERIC(20, 0),
  ADD COLUMN route_object_scope TEXT,
  ADD COLUMN route_object_starting_generation NUMERIC(20, 0),
  ADD CONSTRAINT converact_platform_effect_route_shape CHECK (
    (
      route_authority_kind IS NULL AND
      route_partition_key IS NULL AND
      route_generation IS NULL AND
      route_owner_epoch IS NULL AND
      route_object_scope IS NULL AND
      route_object_starting_generation IS NULL
    ) OR (
      octet_length(route_authority_kind) BETWEEN 1 AND 255 AND
      route_authority_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      octet_length(route_partition_key) BETWEEN 1 AND 255 AND
      route_partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$' AND
      route_generation BETWEEN 1 AND 18446744073709551615 AND
      route_owner_epoch BETWEEN 0 AND 18446744073709551615 AND
      (
        (route_object_scope = 'new' AND
          route_object_starting_generation IS NULL) OR
        (route_object_scope = 'existing' AND
          route_object_starting_generation = route_generation)
      )
    )
  ) NOT VALID,
  ADD CONSTRAINT converact_platform_effect_route_generation_fkey
    FOREIGN KEY (
      tenant_id, route_authority_kind, route_partition_key,
      route_generation, route_owner_epoch
    ) REFERENCES converact_authority_generations (
      tenant_id, authority_kind, partition_key, generation, owner_epoch
    ) ON DELETE RESTRICT NOT VALID;

-- The rolling legacy role retains raw DML only for pre-route rows. It cannot
-- insert target provenance or mutate a row after the Rust writer has claimed
-- it. SECURITY DEFINER target functions run as their migration owner and are
-- therefore not confused with the legacy session principal.
CREATE OR REPLACE FUNCTION converact_platform_event_legacy_provenance_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF (current_user = 'opc_runtime' OR session_user = 'opc_runtime') AND (
    NEW.route_authority_kind IS NOT NULL OR
    NEW.route_partition_key IS NOT NULL OR
    NEW.route_generation IS NOT NULL OR
    NEW.route_owner_epoch IS NOT NULL OR
    NEW.route_object_scope IS NOT NULL OR
    NEW.route_object_starting_generation IS NOT NULL OR
    (TG_OP = 'UPDATE' AND (
      OLD.route_authority_kind IS NOT NULL OR
      OLD.route_partition_key IS NOT NULL OR
      OLD.route_generation IS NOT NULL OR
      OLD.route_owner_epoch IS NOT NULL OR
      OLD.route_object_scope IS NOT NULL OR
      OLD.route_object_starting_generation IS NOT NULL
    ))
  ) THEN
    RAISE EXCEPTION 'legacy platform event writer cannot access target provenance'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER converact_platform_outbox_legacy_provenance
  BEFORE INSERT OR UPDATE ON converact_platform_outbox
  FOR EACH ROW EXECUTE FUNCTION converact_platform_event_legacy_provenance_guard();
CREATE TRIGGER converact_platform_inbox_legacy_provenance
  BEFORE INSERT OR UPDATE ON converact_platform_inbox
  FOR EACH ROW EXECUTE FUNCTION converact_platform_event_legacy_provenance_guard();
CREATE TRIGGER converact_platform_effect_legacy_provenance
  BEFORE INSERT OR UPDATE ON converact_platform_effect_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_platform_event_legacy_provenance_guard();

-- Every delivery transition has an immutable command receipt. This is the
-- exact oracle after an ambiguous COMMIT: callers query the transition id and
-- command digest instead of issuing a blind second mutation.
CREATE TABLE converact_platform_outbox_transitions (
  tenant_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  transition_kind TEXT NOT NULL
    CHECK (transition_kind IN ('complete', 'retry', 'dead_letter')),
  from_revision BIGINT NOT NULL CHECK (from_revision >= 1),
  to_revision BIGINT NOT NULL CHECK (to_revision = from_revision + 1),
  outcome_status TEXT NOT NULL
    CHECK (outcome_status IN ('pending', 'delivered', 'dead_letter')),
  command_digest TEXT NOT NULL
    CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  error_code TEXT NOT NULL DEFAULT '' CHECK (
    error_code = '' OR error_code ~ '^[a-z][a-z0-9_]{0,254}$'
  ),
  retry_delay_ms BIGINT NOT NULL DEFAULT 0 CHECK (
    retry_delay_ms BETWEEN 0 AND 86400000
  ),
  next_attempt_at TIMESTAMPTZ,
  route_authority_kind TEXT NOT NULL CHECK (
    octet_length(route_authority_kind) BETWEEN 1 AND 255 AND
    route_authority_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  route_partition_key TEXT NOT NULL CHECK (
    octet_length(route_partition_key) BETWEEN 1 AND 255 AND
    route_partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  route_generation NUMERIC(20, 0) NOT NULL CHECK (
    route_generation BETWEEN 1 AND 18446744073709551615
  ),
  route_owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    route_owner_epoch BETWEEN 0 AND 18446744073709551615
  ),
  route_object_scope TEXT NOT NULL CHECK (
    route_object_scope IN ('new', 'existing')
  ),
  route_object_starting_generation NUMERIC(20, 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  CHECK (
    (transition_kind = 'complete' AND outcome_status = 'delivered' AND
      error_code = '' AND retry_delay_ms = 0 AND next_attempt_at IS NULL) OR
    (transition_kind = 'retry' AND outcome_status = 'pending' AND
      error_code <> '' AND next_attempt_at IS NOT NULL) OR
    (transition_kind = 'dead_letter' AND outcome_status = 'dead_letter' AND
      error_code <> '' AND retry_delay_ms = 0 AND next_attempt_at IS NULL)
  ),
  PRIMARY KEY (tenant_id, transition_id),
  UNIQUE (tenant_id, outbox_id, from_revision),
  FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES converact_platform_outbox (tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    tenant_id, route_authority_kind, route_partition_key,
    route_generation, route_owner_epoch
  ) REFERENCES converact_authority_generations (
    tenant_id, authority_kind, partition_key, generation, owner_epoch
  ) ON DELETE RESTRICT,
  CHECK (
    (route_object_scope = 'new' AND
      route_object_starting_generation IS NULL) OR
    (route_object_scope = 'existing' AND
      route_object_starting_generation = route_generation)
  )
);

-- One immutable command row exists even when a claim returns an empty batch.
-- The raw delivery capability is never stored, and the per-tenant unique
-- digest makes the capability one-operation-only rather than reusable.
CREATE TABLE converact_platform_outbox_claim_operations (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  claim_operation_id TEXT NOT NULL CHECK (
    octet_length(claim_operation_id) BETWEEN 1 AND 255 AND
    claim_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  worker_id TEXT NOT NULL CHECK (
    octet_length(worker_id) BETWEEN 1 AND 255 AND
    worker_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  delivery_token_hash TEXT NOT NULL CHECK (
    delivery_token_hash ~ '^[0-9a-f]{64}$'
  ),
  delivery_lease_ms BIGINT NOT NULL CHECK (
    delivery_lease_ms BETWEEN 1000 AND 900000
  ),
  batch_limit INTEGER NOT NULL CHECK (batch_limit BETWEEN 1 AND 200),
  command_digest TEXT NOT NULL CHECK (command_digest ~ '^[0-9a-f]{64}$'),
  route_authority_kind TEXT NOT NULL CHECK (
    octet_length(route_authority_kind) BETWEEN 1 AND 255 AND
    route_authority_kind ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  route_partition_key TEXT NOT NULL CHECK (
    octet_length(route_partition_key) BETWEEN 1 AND 255 AND
    route_partition_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$'
  ),
  route_generation NUMERIC(20, 0) NOT NULL CHECK (
    route_generation BETWEEN 1 AND 18446744073709551615
  ),
  route_owner_epoch NUMERIC(20, 0) NOT NULL CHECK (
    route_owner_epoch BETWEEN 0 AND 18446744073709551615
  ),
  route_object_scope TEXT NOT NULL CHECK (
    route_object_scope IN ('new', 'existing')
  ),
  route_object_starting_generation NUMERIC(20, 0),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, claim_operation_id),
  UNIQUE (tenant_id, delivery_token_hash),
  FOREIGN KEY (
    tenant_id, route_authority_kind, route_partition_key,
    route_generation, route_owner_epoch
  ) REFERENCES converact_authority_generations (
    tenant_id, authority_kind, partition_key, generation, owner_epoch
  ) ON DELETE RESTRICT,
  CHECK (
    (route_object_scope = 'new' AND
      route_object_starting_generation IS NULL) OR
    (route_object_scope = 'existing' AND
      route_object_starting_generation = route_generation)
  )
);

CREATE TABLE converact_platform_outbox_claim_receipts (
  tenant_id TEXT NOT NULL,
  claim_operation_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL,
  claim_revision BIGINT NOT NULL CHECK (claim_revision >= 1),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  max_attempts INTEGER NOT NULL CHECK (
    max_attempts BETWEEN 1 AND 1000 AND attempt_count <= max_attempts
  ),
  lease_until TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, claim_operation_id, outbox_id),
  FOREIGN KEY (tenant_id, claim_operation_id)
    REFERENCES converact_platform_outbox_claim_operations (
      tenant_id, claim_operation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, outbox_id)
    REFERENCES converact_platform_outbox (tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_converact_platform_outbox_transition_route
  ON converact_platform_outbox_transitions (
    tenant_id, route_authority_kind, route_partition_key, route_generation,
    outbox_id, to_revision
  );

CREATE OR REPLACE FUNCTION converact_platform_inbox_append(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_consumer_id TEXT,
  p_event_id TEXT,
  p_payload_digest TEXT,
  p_aggregate_revision BIGINT,
  p_ordering_key TEXT,
  p_received_at TIMESTAMPTZ
)
RETURNS TABLE(inserted_event_id TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH authorized AS (
    SELECT public.converact_authority_writer_fence(
      p_tenant_id, p_authority_kind, p_partition_key,
      p_route_generation, p_route_owner_epoch, p_route_lease_token,
      p_object_scope, p_object_starting_generation
    ) AS allowed
  )
  INSERT INTO public.converact_platform_inbox (
    tenant_id, consumer_id, event_id, payload_digest, aggregate_revision,
    ordering_key, received_at, route_authority_kind, route_partition_key,
    route_generation, route_owner_epoch, route_object_scope,
    route_object_starting_generation
  )
  SELECT p_tenant_id, p_consumer_id, p_event_id, p_payload_digest,
         p_aggregate_revision, p_ordering_key, p_received_at,
         p_authority_kind, p_partition_key, p_route_generation,
         p_route_owner_epoch, p_object_scope, p_object_starting_generation
  FROM authorized WHERE allowed
  ON CONFLICT (tenant_id, consumer_id, event_id) DO NOTHING
  RETURNING event_id
$$;

CREATE OR REPLACE FUNCTION converact_platform_effect_append(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_receipt_id TEXT,
  p_effect_id TEXT,
  p_event_id TEXT,
  p_correlation_id TEXT,
  p_stage TEXT,
  p_effect_generation BIGINT,
  p_writer_id TEXT,
  p_effect_owner_epoch BIGINT,
  p_receipt_digest TEXT,
  p_observed_at TIMESTAMPTZ
)
RETURNS TABLE(inserted_receipt_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  inserted_id TEXT;
BEGIN
  IF p_stage NOT IN ('accepted', 'completed', 'state_observed') THEN
    RAISE EXCEPTION 'platform effect stage is invalid' USING ERRCODE = '55000';
  END IF;

  IF p_stage = 'accepted' THEN
    PERFORM public.converact_authority_claim_generation_work(
      p_tenant_id, p_authority_kind, p_partition_key,
      p_route_generation, p_route_owner_epoch, p_route_lease_token,
      p_object_scope, p_object_starting_generation,
      'nonterminal_effect',
      'effect:' || encode(sha256(
        convert_to(p_effect_id, 'UTF8') || decode('00', 'hex') ||
        int8send(p_effect_generation)
      ), 'hex')
    );
  ELSE
    PERFORM public.converact_authority_writer_fence(
      p_tenant_id, p_authority_kind, p_partition_key,
      p_route_generation, p_route_owner_epoch, p_route_lease_token,
      p_object_scope, p_object_starting_generation
    );
  END IF;

  INSERT INTO public.converact_platform_effect_receipts (
    tenant_id, receipt_id, effect_id, event_id, correlation_id, stage,
    generation, writer_id, owner_epoch, receipt_digest, observed_at,
    route_authority_kind, route_partition_key, route_generation,
    route_owner_epoch, route_object_scope, route_object_starting_generation
  ) VALUES (
    p_tenant_id, p_receipt_id, p_effect_id, p_event_id, p_correlation_id,
    p_stage, p_effect_generation, p_writer_id, p_effect_owner_epoch,
    p_receipt_digest, p_observed_at, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_object_scope,
    p_object_starting_generation
  )
  ON CONFLICT DO NOTHING
  RETURNING receipt_id INTO inserted_id;

  IF inserted_id IS NOT NULL AND p_stage = 'state_observed' THEN
    PERFORM public.converact_authority_release_generation_work(
      p_tenant_id, p_authority_kind, p_partition_key,
      p_route_generation, p_route_owner_epoch, p_route_lease_token,
      'nonterminal_effect',
      'effect:' || encode(sha256(
        convert_to(p_effect_id, 'UTF8') || decode('00', 'hex') ||
        int8send(p_effect_generation)
      ), 'hex')
    );
  END IF;
  RETURN QUERY SELECT inserted_id WHERE inserted_id IS NOT NULL;
END
$$;

CREATE OR REPLACE FUNCTION converact_platform_outbox_enqueue(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_outbox_id TEXT,
  p_event_id TEXT,
  p_event_type TEXT,
  p_schema_version INTEGER,
  p_source_schema_version INTEGER,
  p_producer_identity TEXT,
  p_authority TEXT,
  p_aggregate_type TEXT,
  p_aggregate_id TEXT,
  p_aggregate_revision BIGINT,
  p_ordering_key TEXT,
  p_idempotency_key TEXT,
  p_payload_digest TEXT,
  p_payload JSONB,
  p_correlation JSONB,
  p_purpose TEXT,
  p_region_policy TEXT,
  p_retention_policy TEXT,
  p_event_envelope JSONB,
  p_max_attempts INTEGER,
  p_occurred_at TIMESTAMPTZ,
  p_observed_at TIMESTAMPTZ
)
RETURNS TABLE(inserted_outbox_id TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH claimed AS (
    SELECT public.converact_authority_claim_generation_work(
      p_tenant_id, p_authority_kind, p_partition_key,
      p_route_generation, p_route_owner_epoch, p_route_lease_token,
      p_object_scope, p_object_starting_generation,
      'nonterminal_effect',
      'outbox:' || encode(
        sha256(convert_to(p_outbox_id, 'UTF8')), 'hex'
      )
    ) AS claimed
  )
  INSERT INTO public.converact_platform_outbox (
    tenant_id, id, event_id, event_type, schema_version, source_schema_version,
    producer_identity, authority, aggregate_type, aggregate_id,
    aggregate_revision, ordering_key, idempotency_key, payload_digest, payload,
    correlation, purpose, region_policy, retention_policy, status, worker_id,
    lease_token_hash, lease_until, attempt_count, next_attempt_at, occurred_at,
    observed_at, created_at, delivered_at, route_authority_kind,
    route_partition_key, route_generation, route_owner_epoch, route_object_scope,
    route_object_starting_generation, event_envelope, max_attempts,
    last_error_code, transition_revision, dead_lettered_at
  )
  SELECT p_tenant_id, p_outbox_id, p_event_id, p_event_type,
         p_schema_version, p_source_schema_version, p_producer_identity,
         p_authority, p_aggregate_type, p_aggregate_id, p_aggregate_revision,
         p_ordering_key, p_idempotency_key, p_payload_digest, p_payload,
         p_correlation, p_purpose, p_region_policy, p_retention_policy,
         'pending', '', '', NULL, 0, transaction_timestamp(), p_occurred_at,
         p_observed_at, transaction_timestamp(), NULL, p_authority_kind,
         p_partition_key, p_route_generation, p_route_owner_epoch,
         p_object_scope, p_object_starting_generation, p_event_envelope,
         p_max_attempts, '', 0, NULL
  FROM claimed
  ON CONFLICT DO NOTHING
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION converact_platform_outbox_claim(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_claim_operation_id TEXT,
  p_worker_id TEXT,
  p_delivery_token TEXT,
  p_delivery_lease_ms BIGINT,
  p_batch_limit INTEGER
)
RETURNS TABLE(
  outbox_id TEXT,
  event_envelope JSONB,
  attempt_count INTEGER,
  max_attempts INTEGER,
  transition_revision BIGINT,
  lease_until TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  operation_inserted BIGINT;
  operation_digest TEXT;
  existing_digest TEXT;
  released_exhausted_count BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(E'\x1f', 'platform-outbox-claim', p_tenant_id,
      p_claim_operation_id), 0
  ));
  PERFORM public.converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_route_lease_token,
    p_object_scope, p_object_starting_generation
  );

  operation_digest := encode(sha256(convert_to(concat_ws(E'\x1f',
    p_claim_operation_id, p_worker_id,
    encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex'),
    p_delivery_lease_ms::text, p_batch_limit::text,
    p_authority_kind, p_partition_key, p_route_generation::text,
    p_route_owner_epoch::text, p_object_scope,
    coalesce(p_object_starting_generation::text, '')
  ), 'UTF8')), 'hex');

  INSERT INTO public.converact_platform_outbox_claim_operations (
    tenant_id, claim_operation_id, worker_id, delivery_token_hash,
    delivery_lease_ms, batch_limit, command_digest, route_authority_kind,
    route_partition_key, route_generation, route_owner_epoch,
    route_object_scope, route_object_starting_generation, recorded_at
  ) VALUES (
    p_tenant_id, p_claim_operation_id, p_worker_id,
    encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex'),
    p_delivery_lease_ms, p_batch_limit, operation_digest,
    p_authority_kind, p_partition_key, p_route_generation,
    p_route_owner_epoch, p_object_scope, p_object_starting_generation,
    transaction_timestamp()
  ) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS operation_inserted = ROW_COUNT;

  IF operation_inserted = 0 THEN
    SELECT operation.command_digest INTO existing_digest
    FROM public.converact_platform_outbox_claim_operations AS operation
    WHERE operation.tenant_id = p_tenant_id
      AND operation.claim_operation_id = p_claim_operation_id;
    IF existing_digest IS DISTINCT FROM operation_digest THEN
      RAISE EXCEPTION 'platform outbox claim operation conflicts'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY
      SELECT receipt.outbox_id, outbox.event_envelope,
             receipt.attempt_count, receipt.max_attempts,
             receipt.claim_revision, receipt.lease_until
      FROM public.converact_platform_outbox_claim_receipts AS receipt
      JOIN public.converact_platform_outbox AS outbox
        ON outbox.tenant_id = receipt.tenant_id
       AND outbox.id = receipt.outbox_id
      WHERE receipt.tenant_id = p_tenant_id
        AND receipt.claim_operation_id = p_claim_operation_id
      ORDER BY receipt.outbox_id;
    RETURN;
  END IF;

  WITH candidate AS (
    SELECT outbox.id, outbox.transition_revision AS from_revision
    FROM public.converact_platform_outbox AS outbox
    WHERE outbox.tenant_id = p_tenant_id
      AND outbox.route_authority_kind = p_authority_kind
      AND outbox.route_partition_key = p_partition_key
      AND outbox.route_generation = p_route_generation
      AND outbox.route_owner_epoch = p_route_owner_epoch
      AND outbox.status = 'claimed'
      AND outbox.attempt_count >= outbox.max_attempts
      AND outbox.lease_until <= transaction_timestamp()
    ORDER BY outbox.lease_until, outbox.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_limit
  ), updated AS (
    UPDATE public.converact_platform_outbox AS outbox
    SET status = 'dead_letter', worker_id = '', lease_token_hash = '',
        lease_until = NULL, last_error_code = 'delivery_attempts_exhausted',
        dead_lettered_at = transaction_timestamp(),
        transition_revision = outbox.transition_revision + 1
    FROM candidate
    WHERE outbox.tenant_id = p_tenant_id AND outbox.id = candidate.id
    RETURNING outbox.id, candidate.from_revision,
              outbox.transition_revision AS to_revision
  ), receipts AS (
    INSERT INTO public.converact_platform_outbox_transitions (
      tenant_id, transition_id, outbox_id, transition_kind, from_revision,
      to_revision, outcome_status, command_digest, error_code,
      retry_delay_ms, next_attempt_at, route_authority_kind,
      route_partition_key, route_generation, route_owner_epoch,
      route_object_scope, route_object_starting_generation, recorded_at
    )
    SELECT p_tenant_id,
           'exhausted-' || encode(sha256(convert_to(
             updated.id || ':' || updated.from_revision::text, 'UTF8'
           )), 'hex'),
           updated.id, 'dead_letter', updated.from_revision,
           updated.to_revision, 'dead_letter', encode(sha256(convert_to(
             'exhausted:' || updated.id || ':' || updated.from_revision::text,
             'UTF8'
           )), 'hex'), 'delivery_attempts_exhausted', 0, NULL,
           p_authority_kind, p_partition_key, p_route_generation,
           p_route_owner_epoch, p_object_scope,
           p_object_starting_generation, transaction_timestamp()
    FROM updated
    RETURNING converact_platform_outbox_transitions.outbox_id
  )
  SELECT count(public.converact_authority_release_generation_work(
    p_tenant_id, p_authority_kind, p_partition_key, p_route_generation,
    p_route_owner_epoch, p_route_lease_token, 'nonterminal_effect',
    'outbox:' || encode(sha256(convert_to(receipts.outbox_id, 'UTF8')), 'hex')
  )) INTO released_exhausted_count FROM receipts;

  WITH pending_candidate AS (
    SELECT outbox.id, 0 AS priority, outbox.next_attempt_at AS due_at
    FROM public.converact_platform_outbox AS outbox
    WHERE outbox.tenant_id = p_tenant_id
      AND outbox.route_authority_kind = p_authority_kind
      AND outbox.route_partition_key = p_partition_key
      AND outbox.route_generation = p_route_generation
      AND outbox.route_owner_epoch = p_route_owner_epoch
      AND outbox.status = 'pending'
      AND outbox.attempt_count < outbox.max_attempts
      AND outbox.next_attempt_at <= transaction_timestamp()
    ORDER BY outbox.next_attempt_at, outbox.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_limit
  ), expired_candidate AS (
    SELECT outbox.id, 1 AS priority, outbox.lease_until AS due_at
    FROM public.converact_platform_outbox AS outbox
    WHERE outbox.tenant_id = p_tenant_id
      AND outbox.route_authority_kind = p_authority_kind
      AND outbox.route_partition_key = p_partition_key
      AND outbox.route_generation = p_route_generation
      AND outbox.route_owner_epoch = p_route_owner_epoch
      AND outbox.status = 'claimed'
      AND outbox.attempt_count < outbox.max_attempts
      AND outbox.lease_until <= transaction_timestamp()
    ORDER BY outbox.lease_until, outbox.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_limit
  ), candidate AS (
    SELECT selected.id
    FROM (
      SELECT * FROM pending_candidate
      UNION ALL
      SELECT * FROM expired_candidate
    ) AS selected
    ORDER BY selected.priority, selected.due_at, selected.id
    LIMIT p_batch_limit
  ), updated AS (
    UPDATE public.converact_platform_outbox AS outbox
    SET status = 'claimed', worker_id = p_worker_id,
        lease_token_hash = encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex'),
        lease_until = transaction_timestamp() +
          (p_delivery_lease_ms * interval '1 millisecond'),
        attempt_count = outbox.attempt_count + 1, last_error_code = '',
        transition_revision = outbox.transition_revision + 1
    FROM candidate
    WHERE outbox.tenant_id = p_tenant_id AND outbox.id = candidate.id
    RETURNING outbox.id, outbox.attempt_count, outbox.max_attempts,
              outbox.transition_revision, outbox.lease_until
  )
  INSERT INTO public.converact_platform_outbox_claim_receipts (
    tenant_id, claim_operation_id, outbox_id, claim_revision,
    attempt_count, max_attempts, lease_until, recorded_at
  )
  SELECT p_tenant_id, p_claim_operation_id, updated.id,
         updated.transition_revision, updated.attempt_count,
         updated.max_attempts, updated.lease_until, transaction_timestamp()
  FROM updated;

  RETURN QUERY
    SELECT receipt.outbox_id, outbox.event_envelope,
           receipt.attempt_count, receipt.max_attempts,
           receipt.claim_revision, receipt.lease_until
    FROM public.converact_platform_outbox_claim_receipts AS receipt
    JOIN public.converact_platform_outbox AS outbox
      ON outbox.tenant_id = receipt.tenant_id
     AND outbox.id = receipt.outbox_id
    WHERE receipt.tenant_id = p_tenant_id
      AND receipt.claim_operation_id = p_claim_operation_id
    ORDER BY receipt.outbox_id;
END
$$;

CREATE OR REPLACE FUNCTION converact_platform_outbox_transition_apply(
  p_tenant_id TEXT,
  p_authority_kind TEXT,
  p_partition_key TEXT,
  p_route_generation NUMERIC(20, 0),
  p_route_owner_epoch NUMERIC(20, 0),
  p_route_lease_token TEXT,
  p_object_scope TEXT,
  p_object_starting_generation NUMERIC(20, 0),
  p_transition_id TEXT,
  p_outbox_id TEXT,
  p_worker_id TEXT,
  p_claim_revision BIGINT,
  p_delivery_token TEXT,
  p_error_code TEXT,
  p_retry_delay_ms BIGINT,
  p_transition_kind TEXT,
  p_outcome_status TEXT
)
RETURNS TABLE(applied_outbox_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  command_digest_value TEXT;
  existing_digest TEXT;
  next_attempt_value TIMESTAMPTZ;
  updated_id TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws(E'\x1f', 'platform-outbox-transition', p_tenant_id,
      p_transition_id), 0
  ));
  PERFORM public.converact_authority_writer_fence(
    p_tenant_id, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_route_lease_token,
    p_object_scope, p_object_starting_generation
  );
  command_digest_value := encode(sha256(convert_to(concat_ws(E'\x1f',
    p_transition_id, p_outbox_id, p_worker_id, p_claim_revision::text,
    encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex'),
    p_error_code, p_transition_kind, p_outcome_status,
    p_retry_delay_ms::text, p_authority_kind, p_partition_key,
    p_route_generation::text, p_route_owner_epoch::text, p_object_scope,
    coalesce(p_object_starting_generation::text, '')
  ), 'UTF8')), 'hex');

  SELECT transition.command_digest INTO existing_digest
  FROM public.converact_platform_outbox_transitions AS transition
  WHERE transition.tenant_id = p_tenant_id
    AND transition.transition_id = p_transition_id;
  IF existing_digest IS NOT NULL THEN
    IF existing_digest IS DISTINCT FROM command_digest_value THEN
      RAISE EXCEPTION 'platform outbox transition conflicts'
        USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT p_outbox_id;
    RETURN;
  END IF;

  IF p_transition_kind = 'complete' AND p_outcome_status = 'delivered' AND
     p_error_code = '' AND p_retry_delay_ms = 0 THEN
    UPDATE public.converact_platform_outbox AS outbox
    SET status = 'delivered', worker_id = '', lease_token_hash = '',
        lease_until = NULL, delivered_at = transaction_timestamp(),
        last_error_code = '', transition_revision = outbox.transition_revision + 1
    WHERE outbox.tenant_id = p_tenant_id AND outbox.id = p_outbox_id
      AND outbox.route_authority_kind = p_authority_kind
      AND outbox.route_partition_key = p_partition_key
      AND outbox.route_generation = p_route_generation
      AND outbox.route_owner_epoch = p_route_owner_epoch
      AND outbox.status = 'claimed' AND outbox.worker_id = p_worker_id
      AND outbox.transition_revision = p_claim_revision
      AND outbox.lease_token_hash =
        encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex')
      AND outbox.lease_until > transaction_timestamp()
    RETURNING outbox.id INTO updated_id;
  ELSIF p_transition_kind = 'retry' AND p_outcome_status = 'pending' AND
        p_error_code ~ '^[a-z][a-z0-9_]{0,254}$' AND
        p_retry_delay_ms BETWEEN 0 AND 86400000 THEN
    next_attempt_value := transaction_timestamp() +
      (p_retry_delay_ms * interval '1 millisecond');
    UPDATE public.converact_platform_outbox AS outbox
    SET status = 'pending', worker_id = '', lease_token_hash = '',
        lease_until = NULL, next_attempt_at = next_attempt_value,
        last_error_code = p_error_code,
        transition_revision = outbox.transition_revision + 1
    WHERE outbox.tenant_id = p_tenant_id AND outbox.id = p_outbox_id
      AND outbox.route_authority_kind = p_authority_kind
      AND outbox.route_partition_key = p_partition_key
      AND outbox.route_generation = p_route_generation
      AND outbox.route_owner_epoch = p_route_owner_epoch
      AND outbox.status = 'claimed' AND outbox.worker_id = p_worker_id
      AND outbox.transition_revision = p_claim_revision
      AND outbox.attempt_count < outbox.max_attempts
      AND outbox.lease_token_hash =
        encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex')
      AND outbox.lease_until > transaction_timestamp()
    RETURNING outbox.id INTO updated_id;
  ELSIF p_transition_kind = 'dead_letter' AND
        p_outcome_status = 'dead_letter' AND
        p_error_code ~ '^[a-z][a-z0-9_]{0,254}$' AND
        p_retry_delay_ms = 0 THEN
    UPDATE public.converact_platform_outbox AS outbox
    SET status = 'dead_letter', worker_id = '', lease_token_hash = '',
        lease_until = NULL, dead_lettered_at = transaction_timestamp(),
        last_error_code = p_error_code,
        transition_revision = outbox.transition_revision + 1
    WHERE outbox.tenant_id = p_tenant_id AND outbox.id = p_outbox_id
      AND outbox.route_authority_kind = p_authority_kind
      AND outbox.route_partition_key = p_partition_key
      AND outbox.route_generation = p_route_generation
      AND outbox.route_owner_epoch = p_route_owner_epoch
      AND outbox.status = 'claimed' AND outbox.worker_id = p_worker_id
      AND outbox.transition_revision = p_claim_revision
      AND outbox.lease_token_hash =
        encode(sha256(convert_to(p_delivery_token, 'UTF8')), 'hex')
      AND outbox.lease_until > transaction_timestamp()
    RETURNING outbox.id INTO updated_id;
  ELSE
    RAISE EXCEPTION 'platform outbox transition shape is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF updated_id IS NULL THEN
    RAISE EXCEPTION 'platform outbox transition target is stale'
      USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.converact_platform_outbox_transitions (
    tenant_id, transition_id, outbox_id, transition_kind, from_revision,
    to_revision, outcome_status, command_digest, error_code,
    retry_delay_ms, next_attempt_at, route_authority_kind,
    route_partition_key, route_generation, route_owner_epoch,
    route_object_scope, route_object_starting_generation, recorded_at
  ) VALUES (
    p_tenant_id, p_transition_id, p_outbox_id, p_transition_kind,
    p_claim_revision, p_claim_revision + 1, p_outcome_status,
    command_digest_value, p_error_code, p_retry_delay_ms,
    next_attempt_value, p_authority_kind, p_partition_key,
    p_route_generation, p_route_owner_epoch, p_object_scope,
    p_object_starting_generation, transaction_timestamp()
  );

  IF p_transition_kind IN ('complete', 'dead_letter') THEN
    PERFORM public.converact_authority_release_generation_work(
      p_tenant_id, p_authority_kind, p_partition_key, p_route_generation,
      p_route_owner_epoch, p_route_lease_token, 'nonterminal_effect',
      'outbox:' || encode(sha256(convert_to(p_outbox_id, 'UTF8')), 'hex')
    );
  END IF;
  RETURN QUERY SELECT updated_id;
END
$$;

CREATE OR REPLACE FUNCTION converact_platform_outbox_transition_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'platform outbox transition history is immutable'
    USING ERRCODE = '55000';
END
$$;

CREATE OR REPLACE FUNCTION converact_platform_outbox_claim_receipt_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'platform outbox claim history is immutable'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER converact_platform_outbox_transition_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_outbox_transitions
  FOR EACH ROW EXECUTE FUNCTION converact_platform_outbox_transition_immutable();

CREATE TRIGGER converact_platform_outbox_claim_operation_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_outbox_claim_operations
  FOR EACH ROW EXECUTE FUNCTION converact_platform_outbox_claim_receipt_immutable();
CREATE TRIGGER converact_platform_outbox_claim_receipt_append_only
  BEFORE UPDATE OR DELETE ON converact_platform_outbox_claim_receipts
  FOR EACH ROW EXECUTE FUNCTION converact_platform_outbox_claim_receipt_immutable();

ALTER TABLE converact_platform_outbox_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_outbox_transitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_platform_outbox_transitions FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_outbox_claim_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_outbox_claim_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_platform_outbox_claim_operations FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

ALTER TABLE converact_platform_outbox_claim_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE converact_platform_outbox_claim_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON converact_platform_outbox_claim_receipts FOR ALL
  USING (opc_rls_bypass() OR tenant_id = opc_current_tenant())
  WITH CHECK (opc_rls_bypass() OR tenant_id = opc_current_tenant());

REVOKE ALL ON FUNCTION converact_platform_outbox_transition_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_claim_receipt_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_event_legacy_provenance_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_inbox_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_effect_append(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_enqueue(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT,
  TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, JSONB, INTEGER,
  TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_claim(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, INTEGER
) FROM PUBLIC;
REVOKE ALL ON FUNCTION converact_platform_outbox_transition_apply(
  TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
  TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT
) FROM PUBLIC;

DO $grant$
BEGIN
  -- opc_runtime remains the time-bounded legacy principal for NULL-provenance
  -- rows during the rolling window. It is deliberately not a member of the
  -- target Rust role and receives no access to target claim/transition truth.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'converact_event_runtime') THEN
    REVOKE ALL ON converact_platform_outbox, converact_platform_inbox,
      converact_platform_effect_receipts FROM converact_event_runtime;
    REVOKE ALL ON converact_platform_outbox_transitions,
      converact_platform_outbox_claim_operations,
      converact_platform_outbox_claim_receipts FROM converact_event_runtime;
    GRANT SELECT ON converact_platform_outbox, converact_platform_inbox,
      converact_platform_effect_receipts TO converact_event_runtime;
    GRANT SELECT ON converact_platform_outbox_transitions,
      converact_platform_outbox_claim_operations,
      converact_platform_outbox_claim_receipts TO converact_event_runtime;
    GRANT EXECUTE ON FUNCTION converact_authority_writer_fence(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC
    ) TO converact_event_runtime;
    REVOKE EXECUTE ON FUNCTION converact_authority_claim_generation_work(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC, TEXT, TEXT
    ) FROM converact_event_runtime;
    REVOKE EXECUTE ON FUNCTION converact_authority_release_generation_work(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, TEXT
    ) FROM converact_event_runtime;
    GRANT EXECUTE ON FUNCTION converact_platform_inbox_append(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
      TEXT, TEXT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
    ) TO converact_event_runtime;
    GRANT EXECUTE ON FUNCTION converact_platform_effect_append(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
      TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, BIGINT, TEXT, TIMESTAMPTZ
    ) TO converact_event_runtime;
    GRANT EXECUTE ON FUNCTION converact_platform_outbox_enqueue(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
      TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, TEXT, TEXT, BIGINT,
      TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, TEXT, JSONB, INTEGER,
      TIMESTAMPTZ, TIMESTAMPTZ
    ) TO converact_event_runtime;
    GRANT EXECUTE ON FUNCTION converact_platform_outbox_claim(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
      TEXT, TEXT, TEXT, BIGINT, INTEGER
    ) TO converact_event_runtime;
    GRANT EXECUTE ON FUNCTION converact_platform_outbox_transition_apply(
      TEXT, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, TEXT, NUMERIC,
      TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, BIGINT, TEXT, TEXT
    ) TO converact_event_runtime;
  END IF;
END
$grant$;

COMMENT ON COLUMN converact_platform_effect_receipts.generation IS
  'Effect lifecycle generation; deliberately distinct from route_generation.';
COMMENT ON COLUMN converact_platform_effect_receipts.route_generation IS
  'AuthorityRoute writer generation that authorized this append.';
COMMENT ON COLUMN converact_platform_outbox.lease_token_hash IS
  'SHA-256 of an ephemeral delivery claim capability; never a raw token.';
COMMENT ON COLUMN converact_platform_outbox.transition_revision IS
  'Monotonic row transition revision used for exact unknown-outcome reconciliation.';
