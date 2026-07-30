import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initializeIveKitRuntimeRole,
  type IveKitRuntimeRoleQueryable
} from '../src/ivekit-runtime-role.js';

class RuntimeRolePg implements IveKitRuntimeRoleQueryable {
  readonly calls: Array<{ text: string; params: unknown[] }> = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    this.calls.push({ text, params });
    if (text.includes('SELECT current_user AS current_user')) {
      return { rows: [{ current_user: 'opc_admin' }], rowCount: 1 };
    }
    if (text.includes("format('ALTER ROLE opc_runtime PASSWORD %L'")) {
      return { rows: [{ statement: "ALTER ROLE opc_runtime PASSWORD 'quoted-by-postgres'" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

test('runtime-role initializer parameterizes password and commits least-privilege grants', async () => {
  const pg = new RuntimeRolePg();
  const password = 'runtime-secret-with-@:/#%';

  await initializeIveKitRuntimeRole(pg, password);

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
    /CREATE ROLE opc_sip_effect_executor[\s\S]*NOLOGIN[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
  assert.match(
    grants,
    /ALTER ROLE opc_runtime[\s\S]*NOINHERIT[\s\S]*NOBYPASSRLS/i
  );
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

test('runtime-role initializer rejects an unexpected migration role', async () => {
  const pg: IveKitRuntimeRoleQueryable = {
    async query() {
      return { rows: [{ current_user: 'postgres' }], rowCount: 1 };
    }
  };

  await assert.rejects(
    () => initializeIveKitRuntimeRole(pg, 'runtime-secret'),
    /must run as opc_admin/i
  );
});
