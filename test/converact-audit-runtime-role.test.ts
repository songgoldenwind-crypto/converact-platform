import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationUrl = new URL(
  '../src/migrations/123_converact_audit_runtime_roles.sql',
  import.meta.url
);
const activationUrl = new URL('../src/converact-audit-runtime-role.ts', import.meta.url);
const initializer = readFileSync(
  new URL('../src/converact-runtime-role.ts', import.meta.url),
  'utf8'
);

test('Audit roles are default-disabled and own only the fenced Audit boundary', () => {
  assert.equal(existsSync(migrationUrl), true, 'migration 123 must exist');
  if (!existsSync(migrationUrl)) return;
  const sql = readFileSync(migrationUrl, 'utf8');

  assert.match(
    initializer,
    /CREATE ROLE converact_audit_runtime[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  assert.match(
    initializer,
    /CREATE ROLE converact_audit_store_owner[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  assert.match(sql, /converact_audit_runtime/i);
  assert.match(sql, /converact_audit_store_owner/i);
  assert.match(
    sql,
    /WHERE member IN \([\s\S]*\)\s+OR roleid IN \(/i,
    'both role-membership directions must fail closed'
  );
  assert.match(
    sql,
    /ALTER FUNCTION converact_audit_writer_fence\([\s\S]*OWNER TO converact_audit_store_owner/i
  );
  assert.match(
    sql,
    /ALTER FUNCTION converact_audit_chain_head\([\s\S]*OWNER TO converact_audit_store_owner/i
  );
  assert.match(
    sql,
    /ALTER FUNCTION converact_audit_event_append\([\s\S]*OWNER TO converact_audit_store_owner/i
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION converact_audit_legacy_writer_guard\(\)[\s\S]*current_user <> 'converact_audit_store_owner'[\s\S]*legacy audit writer cannot set target provenance/i,
    'the rolling guard must trust only the isolated definer after ownership transfer'
  );
  assert.match(
    sql,
    /GRANT SELECT ON ivekit_audit_events TO converact_audit_runtime/i
  );
  assert.doesNotMatch(
    sql,
    /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)[^;]+TO converact_audit_runtime/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION converact_audit_writer_fence\([\s\S]*TO converact_audit_runtime/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION converact_audit_chain_head\([\s\S]*TO converact_audit_runtime/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION converact_audit_event_append\([\s\S]*TO converact_audit_runtime/i
  );
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON ivekit_audit_events, converact_audit_chain_heads[\s\S]*FROM converact_audit_runtime/i
  );
  assert.match(
    sql,
    /REVOKE ALL PRIVILEGES ON ivekit_audit_events FROM opc_runtime[\s\S]*GRANT SELECT, INSERT ON ivekit_audit_events TO opc_runtime/i
  );
  assert.doesNotMatch(
    sql,
    /GRANT EXECUTE ON FUNCTION converact_authority_writer_fence\([^;]*\)\s+TO converact_audit_runtime/i
  );
});

test('Audit role activation validates the closed graph before parameterized LOGIN', async () => {
  assert.equal(existsSync(activationUrl), true, 'Audit activation module must exist');
  if (!existsSync(activationUrl)) return;
  const { activateConveractAuditRuntimeRole } = await import(
    '../src/converact-audit-runtime-role.js'
  );
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const pg = {
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (text.includes('SELECT current_user AS current_user')) {
        return { rows: [{ current_user: 'opc_admin' }], rowCount: 1 };
      }
      if (text.includes("format('ALTER ROLE converact_audit_runtime PASSWORD %L'")) {
        return {
          rows: [{ statement: "ALTER ROLE converact_audit_runtime PASSWORD 'quoted'" }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  const password = 'audit-secret-with-@:/#%';

  await activateConveractAuditRuntimeRole(pg, password);

  assert.equal(calls.some((call) => call.text === 'BEGIN'), true);
  assert.equal(calls.some((call) => call.text === 'COMMIT'), true);
  assert.equal(calls.some((call) => call.text.includes(password)), false);
  assert.deepEqual(
    calls.find((call) =>
      call.text.includes("format('ALTER ROLE converact_audit_runtime PASSWORD %L'")
    )?.params,
    [password]
  );
  const statements = calls.map((call) => call.text).join('\n');
  assert.match(statements, /pg_auth_members/i);
  assert.match(statements, /FROM pg_shdepend/i);
  assert.match(statements, /FROM pg_default_acl/i);
  assert.match(statements, /pg_parameter_acl/i);
  assert.match(statements, /FROM pg_largeobject_metadata/i);
  assert.match(statements, /FROM pg_policy AS policy/i);
  assert.match(statements, /FROM pg_trigger AS trigger/i);
  assert.match(statements, /FROM pg_rewrite AS rule/i);
  assert.match(statements, /opc_ivekit_audit_immutable_guard/i);
  assert.match(statements, /session_replication_role/i);
  assert.match(statements, /has_database_privilege/i);
  assert.match(statements, /has_schema_privilege/i);
  assert.match(statements, /has_table_privilege/i);
  assert.match(statements, /has_any_column_privilege/i);
  assert.match(statements, /has_function_privilege/i);
  assert.match(statements, /ALTER ROLE converact_audit_runtime\s+LOGIN/i);
});

test('Audit role activation rejects empty credentials before database mutation', async () => {
  assert.equal(existsSync(activationUrl), true, 'Audit activation module must exist');
  if (!existsSync(activationUrl)) return;
  const { activateConveractAuditRuntimeRole } = await import(
    '../src/converact-audit-runtime-role.js'
  );
  let calls = 0;
  await assert.rejects(
    () => activateConveractAuditRuntimeRole({
      async query() {
        calls += 1;
        return { rows: [], rowCount: 0 };
      }
    }, ''),
    /CONVERACT_AUDIT_RUNTIME_DB_PASSWORD is required/i
  );
  assert.equal(calls, 0);
});
