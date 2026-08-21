import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateConveractEventRuntimeRole,
  initializeConveractFabricRuntimeRole,
  type ConveractFabricRuntimeRoleQueryable
} from '../src/converact-runtime-role.js';

class RuntimeRolePg implements ConveractFabricRuntimeRoleQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    this.calls.push({ text, params });
    if (text.includes('SELECT current_user AS current_user')) {
      return { rows: [{ current_user: 'opc_admin' }], rowCount: 1 };
    }
    if (text.includes("format('ALTER ROLE opc_runtime PASSWORD %L'")) {
      return { rows: [{ statement: "ALTER ROLE opc_runtime PASSWORD 'quoted-by-postgres'" }], rowCount: 1 };
    }
    if (text.includes("format('ALTER ROLE converact_event_runtime PASSWORD %L'")) {
      return {
        rows: [{ statement: "ALTER ROLE converact_event_runtime PASSWORD 'quoted-event-password'" }],
        rowCount: 1
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

test('runtime-role initializer parameterizes password and commits least-privilege grants', async () => {
  const pg = new RuntimeRolePg();
  const password = 'runtime-secret-with-@:/#%';

  await initializeConveractFabricRuntimeRole(pg, password);

  assert.equal(pg.calls.some((call) => call.text === 'BEGIN'), true);
  assert.equal(pg.calls.some((call) => call.text === 'COMMIT'), true);
  assert.equal(pg.calls.some((call) => call.text === 'ROLLBACK'), false);
  assert.equal(pg.calls.some((call) => call.text.includes(password)), false);
  assert.deepEqual(
    pg.calls.find((call) => call.text.includes("format('ALTER ROLE opc_runtime PASSWORD %L'"))?.params,
    [password]
  );
  assert.equal(pg.calls.some((call) => /ALTER ROLE opc_runtime[\s\S]*NOBYPASSRLS/.test(call.text)), true);
  assert.equal(pg.calls.some((call) => call.text.includes('REVOKE CREATE ON SCHEMA public FROM PUBLIC')), true);
  assert.equal(
    pg.calls.some((call) =>
      call.text.includes('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC')
    ),
    true
  );
  assert.equal(pg.calls.some((call) => call.text.includes('REVOKE CREATE ON SCHEMA public')), true);
  assert.equal(pg.calls.some((call) => call.text.includes('ALTER DEFAULT PRIVILEGES FOR ROLE opc_admin')), true);
  assert.equal(pg.calls.some((call) => call.text.includes('schema_migrations')), true);
  assert.equal(
    pg.calls.some((call) => call.text.includes('opc_ivekit_voice_profile_context')),
    true
  );
  assert.equal(
    pg.calls.some((call) => call.text.includes('opc_ivekit_applied_migration_versions')),
    true
  );
  const grants = pg.calls.map((call) => call.text).join('\n');
  assert.match(
    grants,
    /REVOKE UPDATE, DELETE, TRUNCATE\s+ON TABLE public\.ivekit_voice_cdr_submissions\s+FROM opc_runtime/i
  );
  assert.match(
    grants,
    /REVOKE UPDATE, DELETE, TRUNCATE\s+ON TABLE public\.ivekit_voice_cdr_receipts\s+FROM opc_runtime/i
  );
  assert.match(
    grants,
    /REVOKE DELETE, TRUNCATE\s+ON TABLE public\.ivekit_voice_cdr_calls\s+FROM opc_runtime/i
  );
  assert.match(
    grants,
    /REVOKE DELETE, TRUNCATE\s+ON TABLE public\.ivekit_voice_cdr_legs\s+FROM opc_runtime/i
  );
  assert.match(
    grants,
    /REVOKE ALL PRIVILEGES ON TABLE public\.converact_platform_outbox\s+FROM opc_runtime[\s\S]*GRANT SELECT, INSERT, UPDATE ON TABLE public\.converact_platform_outbox\s+TO opc_runtime/i
  );
  assert.match(
    grants,
    /REVOKE ALL PRIVILEGES ON TABLE public\.converact_platform_inbox\s+FROM opc_runtime[\s\S]*GRANT SELECT, INSERT ON TABLE public\.converact_platform_inbox\s+TO opc_runtime/i
  );
  assert.match(
    grants,
    /converact_platform_outbox_claim_operations[\s\S]*FROM opc_runtime/i
  );
  assert.match(
    grants,
    /CREATE ROLE opc_sip_effect_executor[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  assert.match(
    grants,
    /ALTER ROLE opc_runtime[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  assert.match(
    grants,
    /CREATE ROLE converact_event_runtime[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  assert.match(
    grants,
    /CREATE ROLE converact_event_store_owner[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  const eventRoleAlter = grants.match(
    /ALTER ROLE converact_event_runtime([\s\S]*?);/i
  )?.[1] || '';
  assert.match(eventRoleAlter, /NOREPLICATION[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i);
  assert.doesNotMatch(
    eventRoleAlter,
    /\b(?:NO)?LOGIN\b/i,
    'rolling legacy-role replay must preserve an already activated event login'
  );
  assert.doesNotMatch(grants, /GRANT opc_runtime TO converact_event_runtime/i);
  assert.match(
    grants,
    /GRANT opc_sip_effect_executor TO opc_runtime[\s\S]*REVOKE ADMIN OPTION FOR opc_sip_effect_executor FROM opc_runtime/i
  );
  const broadGrant = grants.indexOf(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opc_runtime'
  );
  const featureHardening = grants.indexOf(
    'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, opc_runtime, opc_sip_effect_executor'
  );
  assert.ok(broadGrant >= 0 && featureHardening > broadGrant);
  assert.match(
    grants,
    /GRANT SELECT ON TABLE public\.%I TO opc_sip_effect_executor/
  );
  assert.match(
    grants,
    /GRANT UPDATE \([\s\S]*state,[\s\S]*updated_at[\s\S]*\) ON TABLE public\.ivekit_sip_protocol_effects[\s\S]*TO opc_sip_effect_executor/
  );
  assert.doesNotMatch(
    grants,
    /GRANT (?:DELETE|TRUNCATE|REFERENCES|TRIGGER)[\s\S]*TO opc_sip_effect_executor/i
  );
  assert.doesNotMatch(
    grants,
    /GRANT INSERT ON TABLE public\.ivekit_sip_durable_boundar(?:ies|y_facts)[\s\S]*TO opc_sip_effect_executor/i
  );
  assert.doesNotMatch(
    grants,
    /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]*ivekit_sip_effect_(?:schema|writer)_registry[\s\S]*TO opc_runtime/i
  );
});

test('event runtime activation is explicit, parameterized and validates the exact role graph', async () => {
  const pg = new RuntimeRolePg();
  const password = 'event-runtime-secret-with-@:/#%';

  await activateConveractEventRuntimeRole(pg, password);

  assert.equal(pg.calls.some((call) => call.text === 'BEGIN'), true);
  assert.equal(pg.calls.some((call) => call.text === 'COMMIT'), true);
  assert.equal(pg.calls.some((call) => call.text.includes(password)), false);
  assert.deepEqual(
    pg.calls.find((call) =>
      call.text.includes("format('ALTER ROLE converact_event_runtime PASSWORD %L'")
    )?.params,
    [password]
  );
  const statements = pg.calls.map((call) => call.text).join('\n');
  assert.match(
    statements,
    /converact_event_store_owner[\s\S]*owner_role\.rolcanlogin IS DISTINCT FROM FALSE/i
  );
  assert.match(statements, /converact_event_runtime[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i);
  assert.match(
    statements,
    /pg_auth_members[\s\S]*WHERE member IN \([\s\S]*\)\s+OR roleid IN \(/i
  );
  assert.match(statements, /aclexplode/i);
  assert.match(statements, /procedure\.prosecdef/i);
  assert.match(
    statements,
    /procedure\.proconfig\s*=\s*ARRAY\[\s*'search_path=pg_catalog, public, pg_temp'\s*\]/i
  );
  assert.match(statements, /table_state\.relrowsecurity/i);
  assert.match(statements, /table_state\.relforcerowsecurity/i);
  assert.match(statements, /FROM pg_policy AS policy/i);
  assert.match(statements, /policy\.polname = 'tenant_isolation'/i);
  assert.match(statements, /pg_get_expr\(policy\.polqual, policy\.polrelid\)/i);
  assert.match(
    statements,
    /SELECT count\(\*\)[\s\S]*FROM pg_policy[\s\S]*polrelid = target_table_oid[\s\S]*<> 1/i
  );
  assert.match(
    statements,
    /privilege\.privilege_type IN \('SELECT', 'INSERT', 'UPDATE'\)[\s\S]*<> 3/i
  );
  assert.match(statements, /privilege\.grantee = owner_role\.oid/i);
  assert.match(statements, /privilege\.grantee = event_role\.oid/i);
  assert.match(statements, /privilege\.is_grantable/i);
  assert.match(statements, /FROM pg_default_acl/i);
  assert.match(statements, /FROM pg_attribute/i);
  assert.match(statements, /converact event target relation ACL graph is invalid/i);
  assert.match(statements, /FROM pg_database/i);
  assert.match(statements, /FROM pg_namespace/i);
  assert.match(statements, /FROM pg_shdepend/i);
  assert.match(statements, /has_database_privilege/i);
  assert.match(statements, /has_schema_privilege/i);
  assert.match(statements, /has_table_privilege/i);
  assert.match(statements, /has_any_column_privilege/i);
  assert.match(statements, /has_sequence_privilege/i);
  assert.match(statements, /FROM pg_largeobject_metadata/i);
  assert.match(statements, /acldefault\('L', object\.lomowner\)/i);
  assert.match(
    statements,
    /procedure\.prosecdef[\s\S]*has_function_privilege\([\s\S]*event_role\.oid[\s\S]*EXECUTE/i
  );
  assert.match(
    statements,
    /procedure\.prosecdef[\s\S]*has_function_privilege\([\s\S]*owner_role\.oid[\s\S]*EXECUTE/i
  );
  assert.match(statements, /converact event owner authority function graph is invalid/i);
  assert.match(statements, /converact event runtime has authority outside the exact graph/i);
  assert.match(statements, /converact_platform_outbox_claim_receipts/i);
  assert.match(statements, /converact_platform_outbox_enqueue/i);
  assert.match(statements, /converact_authority_claim_generation_work/i);
  assert.match(statements, /ALTER ROLE converact_event_runtime\s+LOGIN/i);
});

test('event runtime activation rejects an empty password before database mutation', async () => {
  const pg = new RuntimeRolePg();
  await assert.rejects(
    () => activateConveractEventRuntimeRole(pg, ''),
    /CONVERACT_EVENT_RUNTIME_DB_PASSWORD is required/i
  );
  assert.equal(pg.calls.length, 0);
});

test('runtime-role initializer rejects an unexpected migration role', async () => {
  const pg: ConveractFabricRuntimeRoleQueryable = {
    async query() {
      return { rows: [{ current_user: 'postgres' }], rowCount: 1 };
    }
  };

  await assert.rejects(
    () => initializeConveractFabricRuntimeRole(pg, 'runtime-secret'),
    /must run as opc_admin/i
  );
});
