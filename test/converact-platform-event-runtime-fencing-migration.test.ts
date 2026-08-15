import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('../src/migrations/118_converact_platform_event_runtime_fencing.sql', import.meta.url),
  'utf8'
);
const indexSql = readFileSync(
  new URL('../src/migrations/119_converact_platform_event_runtime_indexes.sql', import.meta.url),
  'utf8'
);
const migrationRunner = readFileSync(
  new URL('../src/postgres-migrations.ts', import.meta.url),
  'utf8'
);

test('migration 118 separates route ownership from event and effect generations', () => {
  for (const table of [
    'converact_platform_outbox',
    'converact_platform_inbox',
    'converact_platform_effect_receipts'
  ]) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table}[\\s\\S]*route_authority_kind`, 'i'));
  }
  for (const column of [
    'route_partition_key',
    'route_generation',
    'route_owner_epoch',
    'route_object_scope',
    'route_object_starting_generation'
  ]) assert.match(sql, new RegExp(column, 'i'), column);
  assert.match(sql, /FOREIGN KEY[\s\S]*REFERENCES converact_authority_generations/i);
  assert.match(sql, /route_object_scope = 'new'[\s\S]*route_object_starting_generation IS NULL/i);
  assert.match(sql, /route_object_scope = 'existing'[\s\S]*route_object_starting_generation = route_generation/i);
});

test('outbox lifecycle is bounded and token state is fail closed for new writes', () => {
  assert.match(sql, /max_attempts[\s\S]*BETWEEN 1 AND 1000/i);
  assert.match(sql, /attempt_count <= max_attempts/i);
  assert.match(sql, /lease_token_hash[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /status = 'claimed'[\s\S]*lease_until IS NOT NULL/i);
  assert.match(sql, /status = 'delivered'[\s\S]*delivered_at IS NOT NULL/i);
  assert.match(sql, /status = 'dead_letter'[\s\S]*dead_lettered_at IS NOT NULL/i);
  assert.match(sql, /transition_revision/i);
  assert.match(sql, /event_envelope JSONB/i);
  assert.match(sql, /jsonb_typeof\(event_envelope\) = 'object'/i);
  assert.match(sql, /NOT VALID/i, 'rolling schema checks must not rewrite legacy rows into target truth');
});

test('outbox transition receipts make commit-unknown reconciliation exact and immutable', () => {
  assert.match(sql, /CREATE TABLE converact_platform_outbox_transitions/i);
  assert.match(sql, /PRIMARY KEY \(tenant_id, transition_id\)/i);
  assert.match(sql, /UNIQUE \(tenant_id, outbox_id, from_revision\)/i);
  assert.match(sql, /command_digest[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON converact_platform_outbox_transitions/i);
  assert.match(sql, /ALTER TABLE converact_platform_outbox_transitions ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /ALTER TABLE converact_platform_outbox_transitions FORCE ROW LEVEL SECURITY/i);
  assert.match(sql, /CREATE POLICY tenant_isolation ON converact_platform_outbox_transitions/i);
});

test('target Rust event role cannot bypass the fenced mutation functions', () => {
  assert.match(sql, /converact_event_runtime/i);
  assert.match(
    sql,
    /REVOKE ALL ON converact_platform_outbox, converact_platform_inbox,[\s\S]*converact_platform_effect_receipts FROM converact_event_runtime/i
  );
  assert.match(
    sql,
    /GRANT SELECT ON converact_platform_outbox, converact_platform_inbox,[\s\S]*converact_platform_effect_receipts TO converact_event_runtime/i
  );
  for (const mutation of [
    'converact_platform_inbox_append',
    'converact_platform_effect_append',
    'converact_platform_outbox_enqueue',
    'converact_platform_outbox_claim',
    'converact_platform_outbox_transition_apply'
  ]) {
    assert.match(sql, new RegExp(`FUNCTION ${mutation}\\(`, 'i'), mutation);
  }
  assert.match(sql, /SECURITY DEFINER/g);
  assert.match(sql, /SET search_path = pg_catalog, public, pg_temp/g);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[\s\S]*TO converact_event_runtime/i);
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION converact_authority_claim_generation_work[\s\S]*FROM converact_event_runtime/i
  );
  assert.match(
    sql,
    /REVOKE EXECUTE ON FUNCTION converact_authority_release_generation_work[\s\S]*FROM converact_event_runtime/i
  );
  assert.match(sql, /legacy platform event writer cannot access target provenance/i);
  assert.match(sql, /current_user = 'opc_runtime' OR session_user = 'opc_runtime'/i);
  for (const table of [
    'converact_platform_outbox',
    'converact_platform_inbox',
    'converact_platform_effect_receipts'
  ]) {
    assert.match(
      sql,
      new RegExp(`BEFORE INSERT OR UPDATE ON ${table}[\\s\\S]*legacy_provenance_guard`, 'i')
    );
  }
});

test('security-definer wrappers derive canonical generation claims in PostgreSQL', () => {
  assert.doesNotMatch(sql, /p_claim_id/i);
  assert.match(
    sql,
    /'effect:'\s*\|\|\s*encode\(sha256\([\s\S]*convert_to\(p_effect_id, 'UTF8'\)[\s\S]*int8send\(p_effect_generation\)/i
  );
  assert.match(
    sql,
    /'outbox:'\s*\|\|\s*encode\([\s\S]*sha256\(convert_to\(p_outbox_id, 'UTF8'\)/i
  );
});

test('claim operations are immutable exact receipts including an empty batch', () => {
  assert.match(sql, /CREATE TABLE converact_platform_outbox_claim_operations/i);
  assert.match(sql, /PRIMARY KEY \(tenant_id, claim_operation_id\)/i);
  assert.match(sql, /UNIQUE \(tenant_id, delivery_token_hash\)/i);
  assert.match(sql, /CREATE TABLE converact_platform_outbox_claim_receipts/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, claim_operation_id\)/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON converact_platform_outbox_claim_operations/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON converact_platform_outbox_claim_receipts/i);
});

test('large-table indexes are prepared concurrently outside migration transactions', () => {
  assert.doesNotMatch(
    sql,
    /CREATE (?:UNIQUE )?INDEX\s+(?:converact_authority_generation_owner_identity|idx_converact_platform_outbox_route_)/i
  );
  assert.match(migrationRunner, /preparePlatformEventGenerationOwnerIndex/);
  assert.match(migrationRunner, /preparePlatformEventRuntimeIndexes/);
  assert.match(
    migrationRunner,
    /name: 'converact_authority_generation_owner_identity'[\s\S]*unique: true/i
  );
  assert.match(
    migrationRunner,
    /CREATE \$\{uniqueness\}INDEX CONCURRENTLY \$\{spec\.name\}/i
  );
  for (const index of [
    'idx_converact_platform_outbox_route_pending',
    'idx_converact_platform_outbox_route_expired',
    'idx_converact_platform_outbox_route_exhausted'
  ]) {
    assert.match(migrationRunner, new RegExp(`name: '${index}'`, 'i'));
    assert.match(indexSql, new RegExp(index, 'i'));
  }
  assert.match(
    migrationRunner,
    /preparePlatformEventRuntimeIndexes\(pg\);[\s\S]*await pg\.query\('BEGIN'\)/i
  );
});
