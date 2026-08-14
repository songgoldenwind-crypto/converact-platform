import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { readPostgresMigrationPlan } from '../src/postgres-migrations.js';

const MIGRATION = new URL(
  '../src/migrations/117_converact_authority_migration_routes.sql',
  import.meta.url
);

function sql(): string {
  return readFileSync(MIGRATION, 'utf8');
}

test('authority migration route schema is exact-key bounded and additive', () => {
  const source = sql();
  const plan = readPostgresMigrationPlan(
    new URL('../src/migrations', import.meta.url).pathname
  );
  assert.equal(plan.at(-1)?.file, '117_converact_authority_migration_routes.sql');

  for (const table of [
    'converact_authority_routes',
    'converact_authority_generations',
    'converact_authority_generation_claims',
    'converact_authority_route_receipts'
  ]) {
    assert.match(source, new RegExp(`CREATE TABLE ${table}`, 'i'));
    assert.match(source, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(source, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
    assert.match(
      source,
      new RegExp(
        `CREATE POLICY tenant_isolation ON ${table}[\\s\\S]*?tenant_id = opc_current_tenant\\(\\)`,
        'i'
      )
    );
  }

  assert.match(source, /PRIMARY KEY\s*\(tenant_id, authority_kind, partition_key\)/i);
  for (const field of ['tenant_id', 'authority_kind', 'partition_key']) {
    assert.match(
      source,
      new RegExp(`octet_length\\(${field}\\) BETWEEN 1 AND 255`, 'i'),
      `${field} must be bounded`
    );
  }
  assert.match(source, /route_state TEXT NOT NULL CHECK\s*\(\s*route_state IN\s*\(\s*'shadow',\s*'prepare',\s*'committed',\s*'draining',\s*'active_zero',\s*'retired'\s*\)\s*\)/i);
  assert.match(source, /generation_state TEXT NOT NULL CHECK\s*\(\s*generation_state IN\s*\(\s*'prepared',\s*'accepting_new_work',\s*'draining',\s*'active_zero',\s*'retired'\s*\)\s*\)/i);
  assert.match(source, /UNIQUE INDEX[\s\S]*WHERE generation_state = 'accepting_new_work'/i);
  assert.match(
    source,
    /CREATE INDEX converact_authority_nonterminal_predecessor_page[\s\S]*tenant_id,[\s\S]*authority_kind,[\s\S]*partition_key,[\s\S]*generation[\s\S]*WHERE generation_state IN \('draining', 'active_zero'\)/i
  );
  assert.doesNotMatch(source, /ON DELETE CASCADE/i);
});

test('authority migration generations use u64 fences and exact route references', () => {
  const source = sql();
  for (const field of [
    'current_generation',
    'prepared_generation',
    'draining_generation',
    'route_revision',
    'generation',
    'owner_epoch',
    'schema_revision',
    'durable_active_count',
    'nonterminal_claims'
  ]) {
    assert.match(source, new RegExp(`${field} NUMERIC\\(20, 0\\)`, 'i'));
  }
  assert.match(source, /BETWEEN 1 AND 18446744073709551615/g);
  assert.match(source, /BETWEEN 0 AND 18446744073709551615/g);
  assert.match(source, /FOREIGN KEY\s*\(\s*tenant_id, authority_kind, partition_key, current_generation\s*\)[\s\S]*REFERENCES converact_authority_generations/i);
  assert.match(source, /FOREIGN KEY\s*\(\s*tenant_id, authority_kind, partition_key, prepared_generation\s*\)[\s\S]*REFERENCES converact_authority_generations/i);
  assert.match(source, /DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(source, /lease_token_sha256 TEXT NOT NULL CHECK\s*\(\s*lease_token_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.doesNotMatch(source, /\b(?:lease_token|raw_token|secret_value)\s+(?:TEXT|BYTEA)/i);
});

test('authority migration transitions and receipts fail closed', () => {
  const source = sql();
  assert.match(source, /CREATE TRIGGER converact_authority_generation_insert[\s\S]*BEFORE INSERT ON converact_authority_generations/i);
  assert.match(source, /NEW\.generation_state NOT IN \('prepared', 'accepting_new_work'\)/i);
  assert.match(source, /CREATE TRIGGER converact_authority_generation_transition[\s\S]*BEFORE UPDATE OR DELETE ON converact_authority_generations/i);
  assert.match(source, /CREATE CONSTRAINT TRIGGER converact_authority_generation_route_consistency[\s\S]*AFTER INSERT OR UPDATE ON converact_authority_generations[\s\S]*DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(source, /OLD\.generation_state = 'prepared'[\s\S]*NEW\.generation_state IN \('accepting_new_work', 'retired'\)/i);
  assert.match(source, /OLD\.generation_state = 'accepting_new_work'[\s\S]*NEW\.generation_state = 'draining'/i);
  assert.match(source, /OLD\.generation_state = 'draining'[\s\S]*NEW\.generation_state = 'active_zero'/i);
  assert.match(source, /OLD\.generation_state = 'active_zero'[\s\S]*NEW\.generation_state = 'retired'/i);
  assert.match(source, /NEW\.generation_state = 'accepting_new_work'[\s\S]*NEW\.lease_expires_at <= transaction_timestamp\(\)/i);
  assert.match(source, /NEW\.tenant_id IS DISTINCT FROM OLD\.tenant_id/i);
  assert.match(source, /CREATE TRIGGER converact_authority_route_insert[\s\S]*BEFORE INSERT ON converact_authority_routes/i);
  assert.match(source, /NEW\.route_state <> 'shadow'[\s\S]*NEW\.route_revision <> 1/i);
  assert.match(source, /NEW\.resume_state IS DISTINCT FROM OLD\.route_state/i);
  assert.match(source, /NEW\.prepared_generation <> OLD\.current_generation \+ 1/i);
  assert.match(source, /CREATE TRIGGER converact_authority_route_receipt_immutable[\s\S]*BEFORE UPDATE OR DELETE ON converact_authority_route_receipts/i);
  assert.match(source, /PRIMARY KEY\s*\(tenant_id, authority_kind, partition_key, operation_id\)/i);
  assert.match(source, /request_hash TEXT NOT NULL CHECK\s*\(\s*request_hash ~ '\^\[0-9a-f\]\{64\}\$'/i);
  assert.match(source, /request_binding_sha256 TEXT NOT NULL CHECK\s*\(\s*request_binding_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/i);
});

test('writer fence uses database time and exact object-generation semantics', () => {
  const source = sql();
  assert.match(source, /CREATE OR REPLACE FUNCTION converact_authority_writer_fence\s*\(\s*p_tenant_id TEXT,\s*p_authority_kind TEXT,\s*p_partition_key TEXT,/i);
  assert.match(source, /p_generation NUMERIC\(20, 0\)/i);
  assert.match(source, /p_owner_epoch NUMERIC\(20, 0\)/i);
  assert.match(source, /p_lease_token TEXT/i);
  assert.match(source, /p_object_scope TEXT/i);
  assert.match(source, /p_object_starting_generation NUMERIC\(20, 0\)/i);
  assert.match(source, /transaction_timestamp\(\)/i);
  assert.doesNotMatch(source, /clock_timestamp\(\)|CURRENT_TIMESTAMP|now\(\)/i);
  assert.match(source, /FOR SHARE/i);
  assert.match(source, /generation_state = 'accepting_new_work'/i);
  assert.match(source, /generation_state IN \('accepting_new_work', 'draining'\)/i);
  assert.match(source, /p_object_starting_generation = p_generation/i);
  assert.match(source, /lease_expires_at > transaction_timestamp\(\)/i);
  assert.match(source, /USING ERRCODE = '55000'/i);
  const fenceBody = source.match(
    /CREATE OR REPLACE FUNCTION converact_authority_writer_fence[\s\S]*?AS \$\$([\s\S]*?)\$\$;/i
  )?.[1];
  assert.ok(fenceBody);
  assert.match(fenceBody, /p_tenant_id IS DISTINCT FROM\s+nullif\(current_setting\('app\.current_tenant', true\), ''\)/i);
  assert.doesNotMatch(fenceBody, /opc_rls_bypass\(\)/i);
  for (const predicate of [
    'route.tenant_id = p_tenant_id',
    'route.authority_kind = p_authority_kind',
    'route.partition_key = p_partition_key',
    'generation.generation = p_generation',
    'generation.owner_epoch = p_owner_epoch',
    "generation.lease_token_sha256 =\\s*encode\\(sha256\\(convert_to\\(p_lease_token, 'UTF8'\\)\\), 'hex'\\)"
  ]) {
    assert.match(source, new RegExp(predicate.replaceAll('.', '\\.')));
  }
});

test('authority route storage is least privilege and exposes no raw lease material', () => {
  const source = sql();
  assert.match(source, /REVOKE ALL PRIVILEGES ON[\s\S]*converact_authority_routes[\s\S]*FROM PUBLIC/i);
  assert.match(source, /REVOKE ALL ON FUNCTION converact_authority_writer_fence[\s\S]*FROM PUBLIC/i);
  for (const functionName of [
    'converact_authority_generation_insert_guard',
    'converact_authority_generation_transition_guard',
    'converact_authority_route_insert_guard',
    'converact_authority_route_transition_guard',
    'converact_authority_route_consistency_guard',
    'converact_authority_generation_route_guard',
    'converact_authority_route_receipt_immutable'
  ]) {
    assert.match(
      source,
      new RegExp(`REVOKE ALL ON FUNCTION ${functionName}\\(\\)[\\s\\S]*?FROM PUBLIC`, 'i')
    );
  }
  assert.match(source, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'opc_runtime'\)/i);
  assert.match(source, /CREATE ROLE opc_migration_executor[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i);
  assert.match(source, /ALTER ROLE opc_migration_executor[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i);
  assert.doesNotMatch(source, /GRANT opc_migration_executor TO opc_runtime/i);
  assert.match(source, /GRANT EXECUTE ON FUNCTION converact_authority_writer_fence[\s\S]*TO opc_runtime/i);
  assert.doesNotMatch(source, /GRANT SELECT ON[\s\S]{0,300}converact_authority_generations[\s\S]{0,300}TO opc_runtime/i);
  assert.doesNotMatch(source, /GRANT[\s\S]{0,100}UPDATE[\s\S]{0,300}TO opc_runtime/i);
  assert.match(source, /GRANT SELECT, INSERT, UPDATE ON[\s\S]*converact_authority_routes[\s\S]*TO opc_migration_executor/i);
  assert.match(source, /CREATE OR REPLACE FUNCTION converact_authority_renew_lease\([\s\S]*p_lease_token TEXT[\s\S]*p_lease_ttl_ms BIGINT/i);
  assert.match(source, /p_lease_ttl_ms NOT BETWEEN 1 AND 86400000/i);
  assert.match(source, /generation\.lease_expires_at > transaction_timestamp\(\)/i);
  assert.match(source, /lease_expires_at = GREATEST\([\s\S]*transaction_timestamp\(\) \+ \(p_lease_ttl_ms \* interval '1 millisecond'\)/i);
  assert.match(source, /GRANT EXECUTE ON FUNCTION converact_authority_renew_lease[\s\S]*TO opc_runtime/i);
  assert.match(source, /SECURITY DEFINER[\s\S]*SET search_path = pg_catalog, public, pg_temp/i);
  assert.doesNotMatch(source, /\b(?:private_key|client_secret|secret_value|raw_lease_token)\b/i);
});

test('expired writer recovery and active-zero accounting are explicit and fenced', () => {
  const source = sql();
  assert.match(source, /prepared_owner_epoch <= current_owner_epoch/i);
  assert.match(source, /NEW\.route_state = 'prepare'[\s\S]*current_lease_expires_at <= transaction_timestamp\(\)/i);
  assert.match(source, /claim_tracking_ready_at TIMESTAMPTZ/i);
  assert.match(source, /CREATE TABLE converact_authority_generation_claims/i);
  assert.match(source, /claim_kind IN \('durable_object', 'nonterminal_effect'\)/i);
  assert.match(source, /claim_state IN \('active', 'released'\)/i);
  assert.match(source, /idempotency_expires_at TIMESTAMPTZ/i);
  for (const functionName of [
    'converact_authority_claim_generation_work',
    'converact_authority_release_generation_work',
    'converact_authority_reconcile_generation_claim',
    'converact_authority_seal_generation_claims',
    'converact_authority_mark_unreferenced_active_zero',
    'converact_authority_retire_unreferenced_generation',
    'converact_authority_purge_released_claims'
  ]) {
    assert.match(source, new RegExp(`CREATE OR REPLACE FUNCTION ${functionName}\\(`, 'i'));
    assert.match(source, new RegExp(`REVOKE ALL ON FUNCTION ${functionName}[\\s\\S]*?FROM PUBLIC`, 'i'));
  }
  assert.match(source, /GRANT EXECUTE ON FUNCTION converact_authority_claim_generation_work[\s\S]*TO opc_runtime/i);
  assert.match(source, /GRANT EXECUTE ON FUNCTION converact_authority_release_generation_work[\s\S]*TO opc_runtime/i);
  assert.match(source, /claim_tracking_ready_at IS NOT NULL/i);
  assert.match(source, /NOT EXISTS \([\s\S]*converact_authority_generation_claims[\s\S]*claim_state = 'active'/i);
  assert.doesNotMatch(source, /count\(\*\) FILTER[\s\S]*converact_authority_generation_claims/i);
  assert.match(source, /p_expired_before IS NULL[\s\S]*p_limit IS NULL[\s\S]*p_generation IS NULL[\s\S]*p_limit NOT BETWEEN 1 AND 256/i);
  assert.match(source, /idempotency_expires_at <= p_expired_before[\s\S]*FOR UPDATE OF candidate SKIP LOCKED[\s\S]*LIMIT p_limit/i);
  assert.match(
    source,
    /CREATE INDEX converact_authority_released_claim_generation_purge[\s\S]*tenant_id, authority_kind, partition_key, generation,[\s\S]*idempotency_expires_at, claim_kind, claim_id[\s\S]*WHERE claim_state = 'released'/i
  );
  const purgeBody = source.match(
    /CREATE OR REPLACE FUNCTION converact_authority_purge_released_claims[\s\S]*?AS \$\$([\s\S]*?)\$\$;/i
  )?.[1];
  assert.ok(purgeBody);
  assert.match(purgeBody, /FROM converact_authority_generations AS generation[\s\S]*generation\.tenant_id = p_tenant_id[\s\S]*generation\.authority_kind = p_authority_kind[\s\S]*generation\.partition_key = p_partition_key[\s\S]*generation\.generation = p_generation[\s\S]*generation\.generation_state = 'retired'/i);
  assert.match(purgeBody, /candidate\.tenant_id = p_tenant_id[\s\S]*candidate\.authority_kind = p_authority_kind[\s\S]*candidate\.partition_key = p_partition_key[\s\S]*candidate\.generation = p_generation[\s\S]*candidate\.idempotency_expires_at <= p_expired_before/i);
  const claimBody = source.match(
    /CREATE OR REPLACE FUNCTION converact_authority_claim_generation_work[\s\S]*?AS \$\$([\s\S]*?)\$\$;/i
  )?.[1];
  assert.ok(claimBody);
  assert.match(claimBody, /FROM converact_authority_routes[\s\S]*FOR UPDATE[\s\S]*FROM converact_authority_generations[\s\S]*FOR UPDATE[\s\S]*converact_authority_writer_fence/i);
  const releaseBody = source.match(
    /CREATE OR REPLACE FUNCTION converact_authority_release_generation_work[\s\S]*?AS \$\$([\s\S]*?)\$\$;/i
  )?.[1];
  assert.ok(releaseBody);
  assert.match(releaseBody, /FROM converact_authority_routes[\s\S]*FOR UPDATE[\s\S]*FROM converact_authority_generations[\s\S]*FOR UPDATE[\s\S]*converact_authority_writer_fence/i);
});
