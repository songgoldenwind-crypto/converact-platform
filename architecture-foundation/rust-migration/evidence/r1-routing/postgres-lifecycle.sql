-- Functional RM01 R1 route lifecycle against an isolated PostgreSQL cluster.
-- Prerequisite: the complete root migration plan, including 117, is applied.

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-a', true);
INSERT INTO tenants (id, name) VALUES ('tenant-a', 'Tenant A');
INSERT INTO converact_authority_routes (
  tenant_id, authority_kind, partition_key, current_generation,
  route_revision, route_state
) VALUES ('tenant-a', 'interaction', 'partition-1', 1, 1, 'shadow');
INSERT INTO converact_authority_generations (
  tenant_id, authority_kind, partition_key, generation, cell_id,
  implementation, owner_epoch, schema_revision, generation_state,
  lease_token_sha256, lease_expires_at
) VALUES (
  'tenant-a', 'interaction', 'partition-1', 1, 'cell-a',
  'typescript', 7, 1, 'accepting_new_work',
  encode(sha256(convert_to(repeat('a', 64), 'UTF8')), 'hex'),
  transaction_timestamp() + interval '1 hour'
);
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-a', true);
INSERT INTO converact_authority_generations (
  tenant_id, authority_kind, partition_key, generation, cell_id,
  implementation, owner_epoch, schema_revision, generation_state,
  lease_token_sha256, lease_expires_at
) VALUES (
  'tenant-a', 'interaction', 'partition-1', 2, 'cell-b',
  'rust', 8, 2, 'prepared',
  encode(sha256(convert_to(repeat('b', 64), 'UTF8')), 'hex'),
  transaction_timestamp() + interval '1 hour'
);
UPDATE converact_authority_routes SET
  route_state = 'prepare', route_revision = 2,
  prepared_generation = 2, prepare_operation_id = 'prepare-1',
  prepare_request_hash = repeat('1', 64), resume_state = 'shadow'
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1';
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-a', true);
UPDATE converact_authority_generations SET generation_state = 'draining'
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1' AND generation = 1;
UPDATE converact_authority_generations SET generation_state = 'accepting_new_work'
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1' AND generation = 2;
UPDATE converact_authority_routes SET
  current_generation = 2, route_revision = 3, route_state = 'committed',
  prepared_generation = NULL, prepare_operation_id = NULL,
  prepare_request_hash = NULL, resume_state = NULL, draining_generation = 1
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1';
DO $$
BEGIN
  PERFORM converact_authority_writer_fence(
    'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
    'new', NULL
  );
  RAISE EXCEPTION 'stale writer unexpectedly accepted';
EXCEPTION WHEN SQLSTATE '55000' THEN
  NULL;
END
$$;
SELECT converact_authority_writer_fence(
  'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
  'existing', 1
);
SELECT converact_authority_claim_generation_work(
  'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
  'existing', 1, 'durable_object', 'interaction-1'
);
SELECT NOT converact_authority_claim_generation_work(
  'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
  'existing', 1, 'durable_object', 'interaction-1'
);
SELECT converact_authority_release_generation_work(
  'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
  'durable_object', 'interaction-1'
);
SELECT NOT converact_authority_release_generation_work(
  'tenant-a', 'interaction', 'partition-1', 1, 7, repeat('a', 64),
  'durable_object', 'interaction-1'
);
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-a', true);
UPDATE converact_authority_routes SET route_state = 'draining', route_revision = 4
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1';
SELECT converact_authority_seal_generation_claims(
  'tenant-a', 'interaction', 'partition-1', 1
);
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-a', true);
UPDATE converact_authority_generations SET
  generation_state = 'active_zero', rollback_not_before = transaction_timestamp()
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1' AND generation = 1;
UPDATE converact_authority_routes SET route_state = 'active_zero', route_revision = 5
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1';
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-a', true);
UPDATE converact_authority_generations SET generation_state = 'retired'
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1' AND generation = 1;
UPDATE converact_authority_routes SET
  route_state = 'retired', route_revision = 6, draining_generation = NULL
WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1';
SELECT converact_authority_writer_fence(
  'tenant-a', 'interaction', 'partition-1', 2, 8, repeat('b', 64),
  'new', NULL
);
SELECT converact_authority_renew_lease(
  'tenant-a', 'interaction', 'partition-1', 2, 8, repeat('b', 64), 30000
) > transaction_timestamp();
INSERT INTO converact_authority_route_receipts (
  tenant_id, authority_kind, partition_key, operation_id, request_hash,
  command_kind, request_binding_sha256, result_code, result_generation, result_revision,
  result_payload, result_payload_sha256
) VALUES (
  'tenant-a', 'interaction', 'partition-1', 'retire-1', repeat('2', 64),
  'retire', repeat('4', 64), 'applied', 2, 6, '{}'::jsonb, repeat('3', 64)
);
DO $$
BEGIN
  UPDATE converact_authority_route_receipts SET result_code = 'changed'
  WHERE tenant_id = 'tenant-a' AND authority_kind = 'interaction'
    AND partition_key = 'partition-1' AND operation_id = 'retire-1';
  RAISE EXCEPTION 'receipt unexpectedly mutable';
EXCEPTION WHEN SQLSTATE '55000' THEN
  NULL;
END
$$;
COMMIT;

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-recovery', true);
INSERT INTO tenants (id, name) VALUES ('tenant-recovery', 'Recovery Tenant');
INSERT INTO converact_authority_routes (
  tenant_id, authority_kind, partition_key, current_generation,
  route_revision, route_state
) VALUES ('tenant-recovery', 'interaction', 'partition-1', 1, 1, 'shadow');
INSERT INTO converact_authority_generations (
  tenant_id, authority_kind, partition_key, generation, cell_id,
  implementation, owner_epoch, schema_revision, generation_state,
  lease_token_sha256, lease_expires_at
) VALUES (
  'tenant-recovery', 'interaction', 'partition-1', 1, 'cell-old',
  'typescript', 7, 1, 'accepting_new_work',
  encode(sha256(convert_to(repeat('c', 64), 'UTF8')), 'hex'),
  transaction_timestamp() + interval '10 milliseconds'
);
COMMIT;
SELECT pg_sleep(0.02);

BEGIN;
SELECT set_config('app.current_tenant', 'tenant-recovery', true);
DO $$
BEGIN
  PERFORM converact_authority_renew_lease(
    'tenant-recovery', 'interaction', 'partition-1', 1, 7,
    repeat('c', 64), 30000
  );
  RAISE EXCEPTION 'expired writer unexpectedly renewed';
EXCEPTION WHEN SQLSTATE '55000' THEN
  NULL;
END
$$;
INSERT INTO converact_authority_generations (
  tenant_id, authority_kind, partition_key, generation, cell_id,
  implementation, owner_epoch, schema_revision, generation_state,
  lease_token_sha256, lease_expires_at
) VALUES (
  'tenant-recovery', 'interaction', 'partition-1', 2, 'cell-new',
  'rust', 8, 2, 'prepared',
  encode(sha256(convert_to(repeat('d', 64), 'UTF8')), 'hex'),
  transaction_timestamp() + interval '1 hour'
);
UPDATE converact_authority_routes SET
  route_state = 'prepare', route_revision = 2,
  prepared_generation = 2, prepare_operation_id = 'recovery-prepare-1',
  prepare_request_hash = repeat('5', 64), resume_state = 'shadow'
WHERE tenant_id = 'tenant-recovery' AND authority_kind = 'interaction'
  AND partition_key = 'partition-1';
COMMIT;

SELECT 'migration=' || version
FROM schema_migrations
WHERE version = '117_converact_authority_migration_routes';
SELECT 'route=' || route_state || ':' || current_generation::text || ':' ||
  route_revision::text
FROM converact_authority_routes
WHERE tenant_id = 'tenant-a' AND partition_key = 'partition-1';
SELECT 'generations=' || string_agg(
  generation::text || ':' || generation_state,
  ',' ORDER BY generation
)
FROM converact_authority_generations
WHERE tenant_id = 'tenant-a' AND partition_key = 'partition-1';
SELECT 'expired_recovery=' || route_state || ':' ||
  prepared_generation::text
FROM converact_authority_routes
WHERE tenant_id = 'tenant-recovery';
SELECT 'runtime_update=' || has_table_privilege(
  'opc_runtime', 'converact_authority_generations', 'UPDATE'
)::text;
SELECT 'runtime_generation_select=' || has_table_privilege(
  'opc_runtime', 'converact_authority_generations', 'SELECT'
)::text;
SELECT 'executor_update=' || has_table_privilege(
  'opc_migration_executor', 'converact_authority_generations', 'UPDATE'
)::text;
SELECT 'receipt_count=' || count(*)::text
FROM converact_authority_route_receipts
WHERE tenant_id = 'tenant-a';
