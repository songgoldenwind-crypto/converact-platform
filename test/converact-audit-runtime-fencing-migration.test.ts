import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('../src/migrations/121_converact_audit_runtime_fencing.sql', import.meta.url),
  'utf8'
);
const indexSql = readFileSync(
  new URL('../src/migrations/122_converact_audit_runtime_indexes.sql', import.meta.url),
  'utf8'
);
const migrationRunner = readFileSync(
  new URL('../src/postgres-migrations.ts', import.meta.url),
  'utf8'
);
const routeStore = readFileSync(
  new URL('../server-rs/crates/migration-store/src/postgres.rs', import.meta.url),
  'utf8'
);
const runtimeRole = readFileSync(
  new URL('../src/converact-runtime-role.ts', import.meta.url),
  'utf8'
);

test('audit rolling schema adds nullable provenance and a retention-independent head', () => {
  assert.match(sql, /ALTER TABLE ivekit_audit_events/i);
  for (const column of [
    'route_authority_kind',
    'route_partition_key',
    'route_generation',
    'route_owner_epoch',
    'route_object_scope',
    'route_object_starting_generation',
    'append_position'
  ]) assert.match(sql, new RegExp(column, 'i'), column);
  assert.match(sql, /CREATE TABLE converact_audit_chain_heads/i);
  assert.match(sql, /FOREIGN KEY[\s\S]*REFERENCES converact_authority_generations/i);
  assert.match(sql, /NOT VALID/i);
  const head = sql.match(/CREATE TABLE converact_audit_chain_heads[\s\S]*?\n\);/i)?.[0];
  assert.ok(head);
  assert.doesNotMatch(head, /FOREIGN KEY[\s\S]*ivekit_audit_events/i);
  assert.match(head, /next_position BETWEEN 1 AND 18446744073709551616/i);
});

test('legacy writes serialize with route handoff and require an unexpired TypeScript lease', () => {
  const helper = sql.match(
    /CREATE FUNCTION converact_audit_legacy_writer_allowed\(p_tenant_id TEXT\)[\s\S]*?\n\$\$;/i
  )?.[0];
  const guard = sql.match(
    /CREATE FUNCTION converact_audit_legacy_writer_guard\(\)[\s\S]*?\n\$\$;/i
  )?.[0];
  assert.ok(helper);
  assert.ok(guard);
  assert.match(helper, /SECURITY DEFINER/i);
  assert.match(helper, /current_setting\('app\.current_tenant', true\)/i);
  assert.match(helper, /pg_advisory_xact_lock\(hashtextextended\(p_tenant_id, 947113\)\)/i);
  assert.match(helper, /FOR SHARE OF route, generation/i);
  assert.match(helper, /FROM public\.converact_audit_chain_heads[\s\S]*RETURN FALSE/i);
  assert.match(helper, /implementation_value = 'typescript'/i);
  assert.match(helper, /generation_state_value = 'accepting_new_work'/i);
  assert.match(helper, /lease_expires_at_value > transaction_timestamp\(\)/i);
  assert.doesNotMatch(guard, /SECURITY DEFINER/i);
  assert.match(guard, /converact_audit_legacy_writer_allowed\(NEW\.tenant_id\)/i);
  assert.match(guard, /pg_has_role\(current_user[\s\S]*opc_runtime[\s\S]*USAGE/i);
  assert.match(guard, /legacy audit writer cannot set target provenance/i);
});

test('Rust route mutations acquire the Audit barrier before their route row lock', () => {
  assert.match(routeStore, /AUDIT_TRANSITION_BARRIER_SQL[\s\S]*947113/i);
  assert.match(
    routeStore,
    /set_tenant\(&transaction, key\)\.await\?;[\s\S]*acquire_route_transition_barrier\(&transaction, key\)\.await\?;[\s\S]*load_route\(&transaction, key, true\)/i
  );
  assert.match(routeStore, /authority_kind\(\)\.as_str\(\) == "audit"/i);
  assert.match(routeStore, /partition_key\(\)\.as_str\(\) == "tenant-chain"/i);
});

test('target append advances one database-owned head atomically', () => {
  const append = sql.match(
    /CREATE FUNCTION converact_audit_event_append[\s\S]*?\n\$\$;/i
  )?.[0];
  assert.ok(append);
  assert.match(append, /LANGUAGE plpgsql[\s\S]*SECURITY DEFINER/i);
  assert.match(append, /SET search_path = pg_catalog, public, pg_temp/i);
  assert.match(append, /pg_advisory_xact_lock\(hashtextextended\(p_tenant_id, 947113\)\)/i);
  assert.match(append, /converact_authority_writer_fence\(/i);
  assert.match(append, /FROM public\.converact_audit_chain_heads[\s\S]*FOR UPDATE/i);
  assert.match(append, /current_head_hash IS DISTINCT FROM p_previous_hash/i);
  assert.match(append, /append_position[\s\S]*current_position/i);
  assert.match(append, /next_position = current_position \+ 1/i);
  assert.match(append, /UPDATE public\.converact_audit_chain_heads/i);
  assert.doesNotMatch(append, /ORDER BY occurred_at/i);
});

test('unqualified history fails closed and target append positions are uniquely indexed', () => {
  assert.match(sql, /FROM public\.ivekit_audit_events[\s\S]*audit chain requires qualification/i);
  assert.doesNotMatch(sql, /ORDER BY occurred_at DESC, id DESC/i);
  assert.match(migrationRunner, /AUDIT_RUNTIME_INDEX_MIGRATION[\s\S]*122_converact_audit_runtime_indexes/i);
  assert.match(migrationRunner, /prepareAuditRuntimeIndexes\(pg\);[\s\S]*await pg\.query\('BEGIN'\)/i);
  assert.match(migrationRunner, /name: 'uq_ivekit_audit_events_append_position'/i);
  assert.match(migrationRunner, /columns: \['tenant_id', 'append_position'\]/i);
  assert.match(migrationRunner, /predicate: 'append_position IS NOT NULL'/i);
  assert.match(indexSql, /index_meta\.indisunique/i);
  assert.match(indexSql, /ARRAY\['tenant_id', 'append_position'\]/i);
});

test('only the legacy helper is granted and bootstrap replay preserves the exact graph', () => {
  assert.match(sql, /GRANT EXECUTE ON FUNCTION converact_audit_legacy_writer_allowed\(TEXT\)[\s\S]*TO opc_runtime/i);
  for (const capability of [
    'converact_audit_writer_fence',
    'converact_audit_chain_head',
    'converact_audit_event_append'
  ]) {
    assert.match(sql, new RegExp(`REVOKE (?:ALL|EXECUTE) ON FUNCTION ${capability}`, 'i'));
    assert.match(runtimeRole, new RegExp(`REVOKE ALL ON FUNCTION public\\.${capability}`, 'i'));
  }
  assert.match(sql, /REVOKE ALL PRIVILEGES ON TABLE converact_audit_chain_heads[\s\S]*FROM opc_runtime/i);
  assert.match(runtimeRole, /REVOKE ALL PRIVILEGES ON TABLE public\.converact_audit_chain_heads[\s\S]*FROM PUBLIC, opc_runtime/i);
  assert.match(sql, /audit function privilege graph is invalid/i);
  assert.match(sql, /audit head privilege graph is invalid/i);
});

test('new functions and trigger collide instead of replacing pre-existing objects', () => {
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION converact_audit_/i);
  assert.doesNotMatch(sql, /DROP TRIGGER IF EXISTS ivekit_audit_legacy_writer/i);
  assert.match(sql, /CREATE TRIGGER ivekit_audit_legacy_writer/i);
});
