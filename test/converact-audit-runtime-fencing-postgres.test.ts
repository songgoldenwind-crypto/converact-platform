import assert from 'node:assert/strict';
import test from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { initializeConveractFabricRuntimeRole } from '../src/converact-runtime-role.js';

const adminUrl = process.env.CONVERACT_AUDIT_TEST_DATABASE_URL || '';
const runtimePassword = process.env.CONVERACT_AUDIT_TEST_RUNTIME_PASSWORD || '';
const physicalTest = adminUrl && runtimePassword ? test : test.skip;

physicalTest('audit rolling fence preserves one writer, one chain and an exact role graph', async () => {
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const runtime = new Pool({ connectionString: roleUrl(adminUrl, 'opc_runtime', runtimePassword), max: 1 });
  let member: Pool | undefined;
  try {
    await seedRoute(admin, 'tenant-audit-typescript', 'typescript', 'a');
    await seedRoute(admin, 'tenant-audit-legacy-fenced', 'rust', 'b');
    await seedRoute(admin, 'tenant-audit-expired', 'typescript', 'c', '1 millisecond');
    await createTenant(admin, 'tenant-audit-unqualified');
    await legacyAppend(runtime, 'tenant-audit-unqualified', 'audit-unqualified-a');
    await seedRoute(admin, 'tenant-audit-unqualified', 'rust', 'd');
    await seedRoute(admin, 'tenant-audit-race', 'typescript', 'e');
    await prepareRustGeneration(admin, 'tenant-audit-race', 'f');
    member = await createRuntimeMember(admin, adminUrl, runtimePassword);

    await legacyAppend(runtime, 'tenant-audit-typescript', 'audit-typescript-a');
    await legacyAppend(member, 'tenant-audit-typescript', 'audit-member-a');
    const legacy = await admin.query<{
      route_authority_kind: string | null;
      route_partition_key: string | null;
      append_position: string | null;
    }>(`
      SELECT route_authority_kind, route_partition_key,
             append_position::text AS append_position
      FROM ivekit_audit_events
      WHERE tenant_id = 'tenant-audit-typescript' AND id = 'audit-typescript-a'
    `);
    assert.deepEqual(legacy.rows, [{
      route_authority_kind: null,
      route_partition_key: null,
      append_position: null
    }]);

    await assert.rejects(
      () => legacyAppend(runtime, 'tenant-audit-legacy-fenced', 'audit-rust-bypass'),
      /legacy audit writer is fenced/i
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => legacyAppend(runtime, 'tenant-audit-expired', 'audit-expired-bypass'),
      /legacy audit writer is fenced/i
    );
    await assertCrossTenantHelperRejected(runtime);
    await assertTargetProvenanceRejected(member, 'audit-member-target', false);
    await assertTargetProvenanceRejected(member, 'audit-set-role-target', true);
    await assertUnqualifiedHistoryRejected(admin);
    await assertTransitionWaitsForLegacyAppend();
    await assertReverseHandoffFailsClosed(admin, runtime);

    await initializeConveractFabricRuntimeRole(admin, runtimePassword);
    await assertExactPrivilegeGraph(admin, runtime);
    await assertTargetFunctionsUnavailable(runtime);
  } finally {
    await member?.end();
    await runtime.end();
    await admin.end();
  }
});

async function seedRoute(
  admin: Pool,
  tenantId: string,
  implementation: 'typescript' | 'rust',
  leaseCharacter: string,
  leaseInterval = '1 hour'
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query(
      'INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [tenantId, tenantId]
    );
    await client.query(`
      INSERT INTO converact_authority_routes (
        tenant_id, authority_kind, partition_key,
        current_generation, route_revision, route_state
      ) VALUES ($1, 'audit', 'tenant-chain', 1, 1, 'shadow')
    `, [tenantId]);
    await client.query(`
      INSERT INTO converact_authority_generations (
        tenant_id, authority_kind, partition_key, generation,
        cell_id, implementation, owner_epoch, schema_revision,
        generation_state, lease_token_sha256, lease_expires_at
      ) VALUES (
        $1, 'audit', 'tenant-chain', 1,
        'cell-a', $2, 7, 1, 'accepting_new_work',
        encode(sha256(convert_to(repeat($3, 64), 'UTF8')), 'hex'),
        transaction_timestamp() + $4::interval
      )
    `, [tenantId, implementation, leaseCharacter, leaseInterval]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createTenant(admin: Pool, tenantId: string): Promise<void> {
  await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, tenantId]);
}

async function createRuntimeMember(
  admin: Pool,
  databaseUrl: string,
  password: string
): Promise<Pool> {
  const quoted = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE converact_audit_test_member LOGIN INHERIT PASSWORD %L', $1::text) AS statement",
    [password]
  );
  await admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'converact_audit_test_member'
      ) THEN
        CREATE ROLE converact_audit_test_member LOGIN INHERIT;
      END IF;
    END
    $$
  `);
  await admin.query(quoted.rows[0]!.statement);
  await admin.query('GRANT opc_runtime TO converact_audit_test_member');
  return new Pool({
    connectionString: roleUrl(databaseUrl, 'converact_audit_test_member', password),
    max: 1
  });
}

async function prepareRustGeneration(
  admin: Pool,
  tenantId: string,
  leaseCharacter: string
): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query(`
      INSERT INTO converact_authority_generations (
        tenant_id, authority_kind, partition_key, generation,
        cell_id, implementation, owner_epoch, schema_revision,
        generation_state, lease_token_sha256, lease_expires_at
      ) VALUES (
        $1, 'audit', 'tenant-chain', 2,
        'cell-b', 'rust', 8, 1, 'prepared',
        encode(sha256(convert_to(repeat($2, 64), 'UTF8')), 'hex'),
        transaction_timestamp() + interval '1 hour'
      )
    `, [tenantId, leaseCharacter]);
    await client.query(`
      UPDATE converact_authority_routes
      SET route_revision = 2,
          route_state = 'prepare',
          prepared_generation = 2,
          prepare_operation_id = 'audit-race-prepare',
          prepare_request_hash = repeat('1', 64),
          resume_state = 'shadow'
      WHERE tenant_id = $1
        AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain'
    `, [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function assertCrossTenantHelperRejected(runtime: Pool): Promise<void> {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-typescript', true)"
    );
    await assert.rejects(
      () => client.query(
        "SELECT converact_audit_legacy_writer_allowed('tenant-audit-legacy-fenced')"
      ),
      (error: unknown) => postgresCode(error) === '42501'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function assertTargetProvenanceRejected(
  member: Pool,
  auditId: string,
  setRole: boolean
): Promise<void> {
  const client = await member.connect();
  try {
    await client.query('BEGIN');
    if (setRole) await client.query('SET LOCAL ROLE opc_runtime');
    await client.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-typescript', true)"
    );
    await assert.rejects(
      () => insertTargetAudit(client, 'tenant-audit-typescript', auditId),
      (error: unknown) => postgresCode(error) === '42501'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function assertUnqualifiedHistoryRejected(admin: Pool): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-unqualified', true)"
    );
    await assert.rejects(
      () => client.query(`
        SELECT previous_hash FROM converact_audit_chain_head(
          'tenant-audit-unqualified', 'audit', 'tenant-chain', 1, 7,
          repeat('d', 64), 'new', NULL
        )
      `),
      /audit chain requires qualification/i
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function assertTransitionWaitsForLegacyAppend(): Promise<void> {
  const legacyPool = new Pool({
    connectionString: roleUrl(adminUrl, 'opc_runtime', runtimePassword), max: 1
  });
  const transitionPool = new Pool({ connectionString: adminUrl, max: 1 });
  const legacy = await legacyPool.connect();
  const transition = await transitionPool.connect();
  try {
    await legacy.query('BEGIN');
    await legacy.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-race', true)"
    );
    await insertLegacyAudit(legacy, 'tenant-audit-race', 'audit-race-before-commit');

    await transition.query('BEGIN');
    await transition.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-race', true)"
    );
    const barrier = transition.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('tenant-audit-race', 947113))"
    );
    const crossedBeforeLegacyCommit = await Promise.race([
      barrier.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 75))
    ]);
    assert.equal(crossedBeforeLegacyCommit, false);

    await legacy.query('COMMIT');
    await barrier;
    await transition.query(`
      UPDATE converact_authority_generations
      SET generation_state = 'draining'
      WHERE tenant_id = 'tenant-audit-race'
        AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain'
        AND generation = 1
    `);
    await transition.query(`
      UPDATE converact_authority_generations
      SET generation_state = 'accepting_new_work'
      WHERE tenant_id = 'tenant-audit-race'
        AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain'
        AND generation = 2
    `);
    await transition.query(`
      UPDATE converact_authority_routes
      SET current_generation = 2,
          route_revision = 3,
          route_state = 'committed',
          prepared_generation = NULL,
          prepare_operation_id = NULL,
          prepare_request_hash = NULL,
          resume_state = NULL,
          draining_generation = 1
      WHERE tenant_id = 'tenant-audit-race'
        AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain'
    `);
    await transition.query('COMMIT');
    await legacy.query('BEGIN');
    await legacy.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-race', true)"
    );
    await assert.rejects(
      () => insertLegacyAudit(legacy, 'tenant-audit-race', 'audit-race-after-commit'),
      /legacy audit writer is fenced/i
    );
    await legacy.query('ROLLBACK');
  } catch (error) {
    await legacy.query('ROLLBACK').catch(() => undefined);
    await transition.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    legacy.release();
    transition.release();
    await legacyPool.end();
    await transitionPool.end();
  }
}

async function assertReverseHandoffFailsClosed(
  admin: Pool,
  runtime: Pool
): Promise<void> {
  const tenantId = 'tenant-audit-legacy-fenced';
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    const head = await client.query<{ previous_hash: string }>(`
      SELECT previous_hash FROM converact_audit_chain_head(
        $1, 'audit', 'tenant-chain', 1, 7, repeat('b', 64), 'new', NULL
      )
    `, [tenantId]);
    const inserted = await client.query<{ inserted_event_id: string }>(`
      SELECT inserted_event_id FROM converact_audit_event_append(
        $1, 'audit', 'tenant-chain', 1, 7, repeat('b', 64), 'new', NULL,
        'audit-target-before-reverse', 'actor-a', 'system', 'session.created',
        'session', 'session-a', 'interaction', 'interaction-a', 'request-a',
        'audit-target-before-reverse', 'succeeded', 'allow', '', '{}'::jsonb,
        '2026-08-22T00:00:00.000Z', NULL, false, $2, repeat('9', 64)
      )
    `, [tenantId, head.rows[0]!.previous_hash]);
    assert.deepEqual(inserted.rows, [{ inserted_event_id: 'audit-target-before-reverse' }]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await prepareTypeScriptGeneration(admin, tenantId);
  await commitPreparedGeneration(admin, tenantId);
  const before = await targetChainSnapshot(admin, tenantId);
  await assert.rejects(
    () => legacyAppend(runtime, tenantId, 'audit-legacy-after-reverse'),
    /legacy audit writer is fenced/i
  );
  assert.deepEqual(await targetChainSnapshot(admin, tenantId), before);
}

async function prepareTypeScriptGeneration(admin: Pool, tenantId: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query(`
      INSERT INTO converact_authority_generations (
        tenant_id, authority_kind, partition_key, generation,
        cell_id, implementation, owner_epoch, schema_revision,
        generation_state, lease_token_sha256, lease_expires_at
      ) VALUES (
        $1, 'audit', 'tenant-chain', 2,
        'cell-b', 'typescript', 8, 1, 'prepared',
        encode(sha256(convert_to(repeat('g', 64), 'UTF8')), 'hex'),
        transaction_timestamp() + interval '1 hour'
      )
    `, [tenantId]);
    await client.query(`
      UPDATE converact_authority_routes
      SET route_revision = 2,
          route_state = 'prepare',
          prepared_generation = 2,
          prepare_operation_id = 'audit-reverse-prepare',
          prepare_request_hash = repeat('2', 64),
          resume_state = 'shadow'
      WHERE tenant_id = $1
        AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain'
    `, [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function commitPreparedGeneration(admin: Pool, tenantId: string): Promise<void> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await client.query(`
      SELECT pg_advisory_xact_lock(hashtextextended($1, 947113))
    `, [tenantId]);
    await client.query(`
      UPDATE converact_authority_generations SET generation_state = 'draining'
      WHERE tenant_id = $1 AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain' AND generation = 1
    `, [tenantId]);
    await client.query(`
      UPDATE converact_authority_generations SET generation_state = 'accepting_new_work'
      WHERE tenant_id = $1 AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain' AND generation = 2
    `, [tenantId]);
    await client.query(`
      UPDATE converact_authority_routes
      SET current_generation = 2, route_revision = 3, route_state = 'committed',
          prepared_generation = NULL, prepare_operation_id = NULL,
          prepare_request_hash = NULL, resume_state = NULL,
          draining_generation = 1
      WHERE tenant_id = $1 AND authority_kind = 'audit'
        AND partition_key = 'tenant-chain'
    `, [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function targetChainSnapshot(
  admin: Pool,
  tenantId: string
): Promise<{ event_count: string; head_event_id: string; head_event_hash: string }> {
  const result = await admin.query<{
    event_count: string;
    head_event_id: string;
    head_event_hash: string;
  }>(`
    SELECT count(event.id)::text AS event_count,
           head.head_event_id, head.head_event_hash
    FROM converact_audit_chain_heads AS head
    LEFT JOIN ivekit_audit_events AS event ON event.tenant_id = head.tenant_id
    WHERE head.tenant_id = $1
    GROUP BY head.head_event_id, head.head_event_hash
  `, [tenantId]);
  return result.rows[0]!;
}

async function assertExactPrivilegeGraph(admin: Pool, runtime: Pool): Promise<void> {
  const functions = await admin.query<{
    name: string;
    owner: string;
    security_definer: boolean;
    configuration: string[];
    external_grants: string[];
  }>(`
    SELECT procedure.proname AS name,
           owner.rolname AS owner,
           procedure.prosecdef AS security_definer,
           procedure.proconfig AS configuration,
           ARRAY(
             SELECT coalesce(grantee.rolname, 'PUBLIC') || ':' ||
                    privilege.privilege_type || ':' || privilege.is_grantable::text
             FROM aclexplode(
               coalesce(procedure.proacl, acldefault('f', procedure.proowner))
             ) AS privilege
             LEFT JOIN pg_roles AS grantee ON grantee.oid = privilege.grantee
             WHERE privilege.grantee <> procedure.proowner
             ORDER BY 1
           ) AS external_grants
    FROM pg_proc AS procedure
    JOIN pg_roles AS owner ON owner.oid = procedure.proowner
    WHERE procedure.oid IN (
      to_regprocedure('converact_audit_legacy_writer_allowed(text)'),
      to_regprocedure('converact_audit_legacy_writer_guard()'),
      to_regprocedure('converact_audit_writer_fence(text,text,text,numeric,numeric,text,text,numeric)'),
      to_regprocedure('converact_audit_chain_head(text,text,text,numeric,numeric,text,text,numeric)'),
      to_regprocedure('converact_audit_event_append(text,text,text,numeric,numeric,text,text,numeric,text,text,text,text,text,text,text,text,text,text,text,text,text,jsonb,timestamp with time zone,timestamp with time zone,boolean,text,text)')
    )
    ORDER BY name
  `);
  assert.deepEqual(functions.rows, [
    {
      name: 'converact_audit_chain_head', owner: 'converact_audit_store_owner',
      security_definer: true,
      configuration: ['search_path=pg_catalog, public, pg_temp'],
      external_grants: ['converact_audit_runtime:EXECUTE:false']
    },
    {
      name: 'converact_audit_event_append', owner: 'converact_audit_store_owner',
      security_definer: true,
      configuration: ['search_path=pg_catalog, public, pg_temp'],
      external_grants: ['converact_audit_runtime:EXECUTE:false']
    },
    {
      name: 'converact_audit_legacy_writer_allowed', owner: 'opc_admin', security_definer: true,
      configuration: ['search_path=pg_catalog, public, pg_temp'],
      external_grants: ['opc_runtime:EXECUTE:false']
    },
    {
      name: 'converact_audit_legacy_writer_guard', owner: 'opc_admin', security_definer: false,
      configuration: ['search_path=pg_catalog, public, pg_temp'], external_grants: []
    },
    {
      name: 'converact_audit_writer_fence', owner: 'converact_audit_store_owner',
      security_definer: true,
      configuration: ['search_path=pg_catalog, public, pg_temp'],
      external_grants: ['converact_audit_runtime:EXECUTE:false']
    }
  ]);

  const privileges = await admin.query<{
    select_privilege: boolean;
    insert_privilege: boolean;
    update_privilege: boolean;
    delete_privilege: boolean;
    truncate_privilege: boolean;
    references_privilege: boolean;
    trigger_privilege: boolean;
  }>(`
    SELECT
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'SELECT') AS select_privilege,
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'INSERT') AS insert_privilege,
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'UPDATE') AS update_privilege,
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'DELETE') AS delete_privilege,
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'TRUNCATE') AS truncate_privilege,
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'REFERENCES') AS references_privilege,
      has_table_privilege('opc_runtime', 'converact_audit_chain_heads', 'TRIGGER') AS trigger_privilege
  `);
  assert.deepEqual(privileges.rows, [{
    select_privilege: false,
    insert_privilege: false,
    update_privilege: false,
    delete_privilege: false,
    truncate_privilege: false,
    references_privilege: false,
    trigger_privilege: false
  }]);

  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('app.current_tenant', 'tenant-audit-typescript', true)"
    );
    await assert.rejects(
      () => client.query(`
        INSERT INTO converact_audit_chain_heads (
          tenant_id, head_event_id, head_event_hash,
          next_position, qualified_legacy_count
        ) VALUES (
          'tenant-audit-typescript', NULL, repeat('0', 64), 1, 0
        )
      `),
      (error: unknown) => postgresCode(error) === '42501'
    );
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

async function assertTargetFunctionsUnavailable(runtime: Pool): Promise<void> {
  await assert.rejects(
    () => runtime.query(`
      SELECT converact_audit_writer_fence(
        NULL::text, NULL::text, NULL::text, NULL::numeric,
        NULL::numeric, NULL::text, NULL::text, NULL::numeric
      )
    `),
    (error: unknown) => postgresCode(error) === '42501'
  );
  await assert.rejects(
    () => runtime.query(`
      SELECT previous_hash FROM converact_audit_chain_head(
        NULL::text, NULL::text, NULL::text, NULL::numeric,
        NULL::numeric, NULL::text, NULL::text, NULL::numeric
      )
    `),
    (error: unknown) => postgresCode(error) === '42501'
  );
  await assert.rejects(
    () => runtime.query(`
      SELECT inserted_event_id FROM converact_audit_event_append(
        NULL::text, NULL::text, NULL::text, NULL::numeric,
        NULL::numeric, NULL::text, NULL::text, NULL::numeric,
        NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
        NULL::text, NULL::text, NULL::text, NULL::text, NULL::text,
        NULL::text, NULL::text, NULL::text, NULL::jsonb,
        NULL::timestamptz, NULL::timestamptz, NULL::boolean,
        NULL::text, NULL::text
      )
    `),
    (error: unknown) => postgresCode(error) === '42501'
  );
}

async function legacyAppend(runtime: Pool, tenantId: string, auditId: string): Promise<void> {
  const client = await runtime.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
    await insertLegacyAudit(client, tenantId, auditId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertLegacyAudit(
  client: PoolClient,
  tenantId: string,
  auditId: string
): Promise<void> {
  await client.query(`
    INSERT INTO ivekit_audit_events (
      id, tenant_id, actor_id, actor_role, action, resource_type, resource_id,
      business_ref_type, business_ref_id, request_id, idempotency_key, result,
      policy_decision, source_ip_hmac, metadata, occurred_at,
      previous_hash, event_hash, retention_until, legal_hold
    ) VALUES (
      $1, $2, 'actor-a', 'system', 'session.created', 'session', 'session-a',
      'interaction', 'interaction-a', 'request-a', $1, 'succeeded',
      'allow', '', '{}'::jsonb, '2026-08-22T00:00:00.000Z',
      repeat('0', 64),
      encode(sha256(convert_to($1, 'UTF8')), 'hex'), NULL, false
    )
  `, [auditId, tenantId]);
}

async function insertTargetAudit(
  client: PoolClient,
  tenantId: string,
  auditId: string
): Promise<void> {
  await client.query(`
    INSERT INTO ivekit_audit_events (
      id, tenant_id, actor_id, actor_role, action, resource_type, resource_id,
      business_ref_type, business_ref_id, request_id, idempotency_key, result,
      policy_decision, source_ip_hmac, metadata, occurred_at,
      previous_hash, event_hash, retention_until, legal_hold,
      route_authority_kind, route_partition_key, route_generation,
      route_owner_epoch, route_object_scope, route_object_starting_generation,
      append_position
    ) VALUES (
      $1, $2, 'actor-a', 'system', 'session.created', 'session', 'session-a',
      'interaction', 'interaction-a', 'request-a', $1, 'succeeded',
      'allow', '', '{}'::jsonb, '2026-08-22T00:00:00.000Z',
      repeat('0', 64),
      encode(sha256(convert_to($1, 'UTF8')), 'hex'), NULL, false,
      'audit', 'tenant-chain', 1, 7, 'new', NULL, 99
    )
  `, [auditId, tenantId]);
}

function roleUrl(databaseUrl: string, username: string, password: string): string {
  const url = new URL(databaseUrl);
  url.username = username;
  url.password = password;
  return url.toString();
}

function postgresCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}
