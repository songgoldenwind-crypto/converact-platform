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
