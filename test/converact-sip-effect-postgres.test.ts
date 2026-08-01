import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { Pool, type PoolClient } from 'pg';

import { initializeConveractFabricRuntimeRole } from '../src/converact-runtime-role.js';
import {
  SIP_EFFECT_SCHEMA_HASH,
  SIP_EFFECT_SCHEMA_ID,
  SIP_EFFECT_SCHEMA_VERSION,
  SipEffectOracle,
  canonicalSipEffectHash,
  type DurableProtocolEffectPrepareInput,
  type EffectRepairFence,
  type ProtocolEffectIdentity,
  type ProtocolEffectRecord
} from '../src/agent-runtime/converact/voice/sip-foundation/effect-oracle.js';
import {
  PostgresEffectStore
} from '../src/agent-runtime/converact/voice/sip-foundation/postgres-effect-store.js';
import {
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256
} from '../src/agent-runtime/converact/voice/sip-foundation/route-binding.js';
import type {
  BackendRuntimeIdentity,
  BoundSipRouteBinding,
  BoundSipWireAttemptFacts,
  PreparedProtocolEffect,
  PreparedProtocolEffectAuthority
} from '../src/agent-runtime/converact/voice/sip-foundation/types.js';

const adminUrl = process.env.CONVERACT_FABRIC_STANDALONE_TEST_DATABASE_URL || '';
const runtimeUrl =
  process.env.CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_DATABASE_URL || '';
const runtimePassword =
  process.env.CONVERACT_FABRIC_STANDALONE_TEST_RUNTIME_PASSWORD || '';
const physicalTest = adminUrl && runtimeUrl && runtimePassword ? test : test.skip;

const EXECUTOR_ROLE = 'opc_sip_effect_executor';
const RUNTIME_ROLE = 'opc_runtime';
const WRITER_IDENTITY = 'unified-rustpbx.sip-foundation';
const WRONG_WRITER_IDENTITY = 'physical-test.wrong-writer';
const FEATURE_TABLES = [
  'ivekit_sip_effect_schema_registry',
  'ivekit_sip_effect_writer_registry',
  'ivekit_sip_protocol_effects',
  'ivekit_sip_effect_receipts',
  'ivekit_sip_durable_boundaries',
  'ivekit_sip_durable_boundary_facts'
] as const;
const READ_ONLY_BOUNDARY_TABLES = [
  'ivekit_sip_durable_boundaries',
  'ivekit_sip_durable_boundary_facts'
] as const;

interface PrivilegeRow {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
}

interface PgFailure extends Error {
  code?: string;
}

physicalTest(
  'SIP effect executor is a physical fail-closed PostgreSQL DML boundary',
  async (t) => {
    const suffix = `physical_${process.pid}`;
    const tenantA = `ivekit_sip_effect_${suffix}_a`;
    const tenantB = `ivekit_sip_effect_${suffix}_b`;
    const effectA = `sip-effect-${suffix}-a`;
    const effectB = `sip-effect-${suffix}-b`;
    const schemaActivationReceipt =
      `test-only:sip-effect-schema-activation:${suffix}`;
    const writerActivationReceipt =
      `test-only:sip-effect-writer-activation:${suffix}`;
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1 });
    let runtimeClient: PoolClient | null = null;
    let registriesActivated = false;

    try {
      const version = await admin.query<{ server_version: string }>(
        'SHOW server_version'
      );
      t.diagnostic(
        `PostgreSQL server_version=${version.rows[0]?.server_version}; ` +
        'production_eligible=not_run'
      );

      const initialRegistry = await registryState(admin);
      assert.deepEqual(initialRegistry, {
        schema_enabled: false,
        schema_activation_receipt_id: null,
        writer_enabled: false,
        writer_activation_receipt_id: null
      });

      // This ordering is deliberate: the standalone harness already migrated
      // the database, so this proves role initialization cannot re-open ACLs.
      await initializeConveractFabricRuntimeRole(admin, runtimePassword);

      const directPrivileges = await tablePrivileges(
        admin,
        RUNTIME_ROLE,
        FEATURE_TABLES
      );
      assert.equal(directPrivileges.length, FEATURE_TABLES.length);
      for (const privilege of directPrivileges) {
        assert.equal(privilege.can_select, false, privilege.table_name);
        assert.equal(privilege.can_insert, false, privilege.table_name);
        assert.equal(privilege.can_update, false, privilege.table_name);
        assert.equal(privilege.can_delete, false, privilege.table_name);
        assert.equal(privilege.can_truncate, false, privilege.table_name);
      }

      const membership = await admin.query<{
        is_member: boolean;
        has_usage: boolean;
      }>(
        `SELECT
           pg_has_role($1, $2, 'MEMBER') AS is_member,
           pg_has_role($1, $2, 'USAGE') AS has_usage`,
        [RUNTIME_ROLE, EXECUTOR_ROLE]
      );
      assert.deepEqual(membership.rows[0], {
        is_member: true,
        has_usage: false
      });

      const boundaryPrivileges = await tablePrivileges(
        admin,
        EXECUTOR_ROLE,
        READ_ONLY_BOUNDARY_TABLES
      );
      assert.equal(
        boundaryPrivileges.length,
        READ_ONLY_BOUNDARY_TABLES.length
      );
      for (const privilege of boundaryPrivileges) {
        assert.equal(privilege.can_select, true, privilege.table_name);
        assert.equal(privilege.can_insert, false, privilege.table_name);
        assert.equal(privilege.can_update, false, privilege.table_name);
        assert.equal(privilege.can_delete, false, privilege.table_name);
        assert.equal(privilege.can_truncate, false, privilege.table_name);
      }

      await admin.query(
        `INSERT INTO tenants (id, name)
         VALUES ($1, $2), ($3, $4)`,
        [tenantA, `SIP effect ${suffix} A`, tenantB, `SIP effect ${suffix} B`]
      );

      runtimeClient = await runtime.connect();

      await beginExecutor(runtimeClient, tenantA, WRITER_IDENTITY);
      await expectPgFailure(
        runtimeClient.query(
          'SELECT ivekit_assert_sip_effect_writer($1, $2, $3, $4)',
          [
            WRITER_IDENTITY,
            SIP_EFFECT_SCHEMA_ID,
            SIP_EFFECT_SCHEMA_VERSION,
            SIP_EFFECT_SCHEMA_HASH
          ]
        ),
        '55000'
      );
      await runtimeClient.query('ROLLBACK');
      await assertRuntimeIdentity(runtimeClient);

      await activateTestRegistries(
        admin,
        schemaActivationReceipt,
        writerActivationReceipt
      );
      registriesActivated = true;
      assert.deepEqual(await registryState(admin), {
        schema_enabled: true,
        schema_activation_receipt_id: schemaActivationReceipt,
        writer_enabled: true,
        writer_activation_receipt_id: writerActivationReceipt
      });

      await beginElectedExecutor(runtimeClient, tenantA);
      await insertMinimalEffect(runtimeClient, tenantA, effectA);
      await runtimeClient.query('COMMIT');

      await beginElectedExecutor(runtimeClient, tenantB);
      await insertMinimalEffect(runtimeClient, tenantB, effectB);
      await runtimeClient.query('COMMIT');

      await beginElectedExecutor(runtimeClient, tenantA);
      const tenantAView = await runtimeClient.query<{
        protocol_effect_id: string;
      }>(
        `SELECT protocol_effect_id
         FROM ivekit_sip_protocol_effects
         ORDER BY protocol_effect_id`
      );
      assert.deepEqual(tenantAView.rows, [
        { protocol_effect_id: effectA }
      ]);
      await runtimeClient.query('COMMIT');

      await beginExecutor(runtimeClient, tenantA, WRONG_WRITER_IDENTITY);
      await expectPgFailure(
        runtimeClient.query(
          'SELECT ivekit_assert_sip_effect_writer($1, $2, $3, $4)',
          [
            WRITER_IDENTITY,
            SIP_EFFECT_SCHEMA_ID,
            SIP_EFFECT_SCHEMA_VERSION,
            SIP_EFFECT_SCHEMA_HASH
          ]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginRuntimeTransaction(runtimeClient, tenantA);
      await runtimeClient.query(
        `SELECT set_config(
           'app.sip_effect_writer_identity',
           $1,
           TRUE
         )`,
        [WRITER_IDENTITY]
      );
      await expectPgFailure(
        runtimeClient.query(
          'SELECT ivekit_assert_sip_effect_writer($1, $2, $3, $4)',
          [
            WRITER_IDENTITY,
            SIP_EFFECT_SCHEMA_ID,
            SIP_EFFECT_SCHEMA_VERSION,
            SIP_EFFECT_SCHEMA_HASH
          ]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginRuntimeTransaction(runtimeClient, tenantA);
      await expectPgFailure(
        runtimeClient.query(
          `UPDATE ivekit_sip_effect_writer_registry
           SET enabled = enabled
           WHERE writer_identity = $1`,
          [WRITER_IDENTITY]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginElectedExecutor(runtimeClient, tenantA);
      await expectPgFailure(
        runtimeClient.query(
          `UPDATE ivekit_sip_protocol_effects
           SET protocol_session_id = 'identity-mutation',
               revision = revision + 1
           WHERE tenant_id = $1 AND protocol_effect_id = $2`,
          [tenantA, effectA]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginElectedExecutor(runtimeClient, tenantA);
      await expectPgFailure(
        runtimeClient.query(
          `DELETE FROM ivekit_sip_protocol_effects
           WHERE tenant_id = $1 AND protocol_effect_id = $2`,
          [tenantA, effectA]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginElectedExecutor(runtimeClient, tenantA);
      await expectPgFailure(
        runtimeClient.query('TRUNCATE TABLE ivekit_sip_effect_receipts'),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginElectedExecutor(runtimeClient, tenantA);
      await expectPgFailure(
        runtimeClient.query(
          `INSERT INTO ivekit_sip_durable_boundaries
             (boundary_id, tenant_id, boundary_kind, decision_id,
              idempotency_key, request_hash, facts_hash, boundary_hash,
              owner_epoch, command_sequence, committed_at, schema_id,
              schema_version, schema_hash, writer_identity)
           VALUES
             ($1, $2, 'call_admission', $3, $4, $5, $6, $7,
              1, 1, NOW(), $8, $9, $10, $11)`,
          [
            `boundary-${suffix}`,
            tenantA,
            `boundary-decision-${suffix}`,
            `boundary-idempotency-${suffix}`,
            hash('boundary-request'),
            hash('boundary-facts'),
            hash('boundary'),
            SIP_EFFECT_SCHEMA_ID,
            SIP_EFFECT_SCHEMA_VERSION,
            SIP_EFFECT_SCHEMA_HASH,
            WRITER_IDENTITY
          ]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await beginElectedExecutor(runtimeClient, tenantA);
      await expectPgFailure(
        runtimeClient.query(
          `INSERT INTO ivekit_sip_durable_boundary_facts
             (tenant_id, boundary_id, fact_type, receipt_id, aggregate_id,
              aggregate_revision, fact_hash, fact_payload, created_at,
              schema_id, schema_version, schema_hash, writer_identity)
           VALUES
             ($1, $2, 'call_session', $3, $4, 1, $5, '{}'::jsonb,
              NOW(), $6, $7, $8, $9)`,
          [
            tenantA,
            `boundary-${suffix}`,
            `boundary-fact-receipt-${suffix}`,
            `boundary-fact-aggregate-${suffix}`,
            hash('boundary-fact'),
            SIP_EFFECT_SCHEMA_ID,
            SIP_EFFECT_SCHEMA_VERSION,
            SIP_EFFECT_SCHEMA_HASH,
            WRITER_IDENTITY
          ]
        ),
        '42501'
      );
      await runtimeClient.query('ROLLBACK');

      await assertRuntimeIdentity(runtimeClient);
      runtimeClient.release();
      runtimeClient = null;

      await assertPhysicalStoreRepairExhaustion(runtime, tenantA, suffix);
    } finally {
      if (runtimeClient) {
        await runtimeClient.query('ROLLBACK').catch(() => undefined);
        runtimeClient.release();
      }
      try {
        await admin.query('BEGIN');
        await admin.query(
          `DELETE FROM ivekit_sip_effect_receipts
           WHERE tenant_id = ANY($1::text[])`,
          [[tenantA, tenantB]]
        );
        await admin.query(
          'DELETE FROM tenants WHERE id = ANY($1::text[])',
          [[tenantA, tenantB]]
        );
        if (registriesActivated) {
          await admin.query(
            `UPDATE ivekit_sip_effect_writer_registry
             SET enabled = FALSE,
                 activation_receipt_id = NULL,
                 activated_at = NULL
             WHERE writer_identity = $1`,
            [WRITER_IDENTITY]
          );
          await admin.query(
            `UPDATE ivekit_sip_effect_schema_registry
             SET enabled = FALSE,
                 activation_receipt_id = NULL,
                 activated_at = NULL
             WHERE schema_id = $1 AND schema_version = $2`,
            [SIP_EFFECT_SCHEMA_ID, SIP_EFFECT_SCHEMA_VERSION]
          );
        }
        await admin.query('COMMIT');
        const leftovers = await admin.query<{ remaining: string }>(
          `SELECT COUNT(*)::text AS remaining
           FROM tenants
           WHERE id = ANY($1::text[])`,
          [[tenantA, tenantB]]
        );
        assert.equal(leftovers.rows[0]?.remaining, '0');
        if (registriesActivated) {
          assert.deepEqual(await registryState(admin), {
            schema_enabled: false,
            schema_activation_receipt_id: null,
            writer_enabled: false,
            writer_activation_receipt_id: null
          });
        }
      } catch (error) {
        await admin.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await Promise.all([runtime.end(), admin.end()]);
      }
    }
  }
);

async function assertPhysicalStoreRepairExhaustion(
  runtime: Pool,
  tenantId: string,
  suffix: string
): Promise<void> {
  const fixture = physicalStoreFixture(
    tenantId,
    `sip-store-effect-${suffix}`
  );
  const store = new PostgresEffectStore(runtime);
  const lifecycleClock = new Date();
  const oracle = new SipEffectOracle({
    store,
    prepared_effect_authority: fixture.authority,
    now: () => lifecycleClock
  });

  const prepared = await oracle.prepare(fixture.input);
  assert.equal(prepared.replayed, false);
  assert.equal(prepared.effect.state, 'prepared');
  await oracle.recordDurableDecision(
    fixture.identity,
    `store-durable-${suffix}`
  );
  await oracle.recordSendAttempted(
    fixture.identity,
    `store-send-${suffix}`
  );
  await oracle.recordUnknown(
    fixture.identity,
    `store-unknown-${suffix}`,
    { repair_after_ms: 0 }
  );

  for (let epoch = 1; epoch <= 8; epoch += 1) {
    const batch = await oracle.claimRepairBatch({
      tenant_id: tenantId,
      repair_owner_id: `store-worker-${suffix}`,
      repair_owner_epoch: String(epoch),
      claim_token_prefix: `store-claim-${suffix}`,
      claimed_at: lifecycleClock,
      lease_until: new Date(lifecycleClock.getTime() + 30_000),
      limit: 1
    });
    assert.equal(batch.exhausted_count, 0);
    assert.equal(batch.effects.length, 1);
    const claimed = batch.effects[0]!;
    assert.equal(claimed.repair_attempts, epoch);
    assert.equal(claimed.repair_epoch_high_watermark, String(epoch));
    await oracle.releaseRepairClaim({
      identity: fixture.identity,
      fence: repairFence(claimed),
      next_repair_at: lifecycleClock
    });
  }

  const eightAttempts = await oracle.query(fixture.identity);
  assert.ok(eightAttempts);
  assert.equal(eightAttempts.state, 'unknown');
  assert.equal(eightAttempts.repair_attempts, 8);
  assert.equal(eightAttempts.repair_epoch_high_watermark, '8');
  assert.equal(eightAttempts.operator_attention_required, false);

  const exhaustedBatch = await oracle.claimRepairBatch({
    tenant_id: tenantId,
    repair_owner_id: `store-worker-${suffix}`,
    repair_owner_epoch: '9',
    claim_token_prefix: `store-claim-${suffix}`,
    claimed_at: lifecycleClock,
    lease_until: new Date(lifecycleClock.getTime() + 30_000),
    limit: 1
  });
  assert.deepEqual(exhaustedBatch, {
    effects: [],
    exhausted_count: 1
  });

  const exhausted = await oracle.query(fixture.identity);
  assert.ok(exhausted);
  assert.equal(exhausted.repair_attempts, 8);
  assert.equal(exhausted.repair_epoch_high_watermark, '9');
  assert.equal(exhausted.operator_attention_required, true);
  assert.equal(
    exhausted.repair_exhaustion_receipt_hash,
    canonicalSipEffectHash({
      tenant_id: tenantId,
      protocol_effect_id: fixture.identity.protocol_effect_id,
      repair_attempts: 8,
      repair_epoch_high_watermark: '9'
    })
  );
}

function repairFence(effect: ProtocolEffectRecord): EffectRepairFence {
  assert.ok(effect.repair_owner_id);
  assert.ok(effect.repair_owner_epoch);
  assert.ok(effect.repair_claim_token);
  assert.ok(effect.repair_claim_revision);
  return {
    repair_owner_id: effect.repair_owner_id,
    repair_owner_epoch: effect.repair_owner_epoch,
    repair_claim_token: effect.repair_claim_token,
    repair_claim_revision: effect.repair_claim_revision
  };
}

function physicalStoreFixture(
  tenantId: string,
  effectId: string
): {
  authority: PreparedProtocolEffectAuthority;
  input: DurableProtocolEffectPrepareInput;
  identity: ProtocolEffectIdentity;
} {
  const requestHash = hash(`store-request:${effectId}`);
  const route: BoundSipRouteBinding = Object.freeze({
    schema_id: 'sip-foundation-route-binding-v1',
    schema_version: '1.0.0',
    route: Object.freeze({ id: `store-route-${effectId}`, revision: 1 }),
    rfc3263_candidate: 'store-physical.example.test',
    route_set: Object.freeze(['sip:edge.example.test;lr']),
    transport: Object.freeze({
      id: `store-transport-${effectId}`,
      protocol: 'udp',
      next_hop: Object.freeze({ address: '203.0.113.10', port: 5060 })
    }),
    local_endpoint: Object.freeze({ address: '10.0.0.10', port: 5060 }),
    advertised_via_sent_by: Object.freeze({
      host: 'voice.example.test',
      port: 5060
    }),
    tls_sni: null,
    authorization_identity: 'physical-test-trunk',
    authorization_headers_sha256: Object.freeze([])
  });
  const attempt: BoundSipWireAttemptFacts = Object.freeze({
    schema_id: 'sip-foundation-wire-attempt-v1',
    schema_version: '1.0.0',
    attempt_id: effectId,
    transaction_lineage_id: effectId,
    semantic_intent_sha256: requestHash,
    parent_attempt_id: null,
    lineage_reason: 'transaction_root',
    via_branch: `z9hG4bKphysical-${hash(effectId).slice(0, 40)}`
  });
  const wire = Buffer.from(
    `OPTIONS sip:${effectId}@example.test SIP/2.0\r\n` +
    `Via: SIP/2.0/UDP voice.example.test:5060;branch=${attempt.via_branch}\r\n` +
    `Call-ID: ${effectId}\r\n` +
    'CSeq: 1 OPTIONS\r\n' +
    'Content-Length: 0\r\n\r\n'
  );
  const adapterIdentity: BackendRuntimeIdentity = Object.freeze({
    backend_id: 'rsipstack',
    source_digest: hash('physical-store-source'),
    binary_digest: hash('physical-store-binary'),
    config_digest: hash('physical-store-config'),
    capability_set_digest: hash('physical-store-capabilities'),
    runtime_attestation_verification: 'not_run',
    production_eligible: false
  });
  const routeHash = sipRouteBindingSha256(route);
  const attemptHash = sipWireAttemptFactsSha256(attempt);
  const wireHash = hash(wire);
  const prepared: PreparedProtocolEffect = Object.freeze({
    adapter_identity: adapterIdentity,
    wire_identity: Object.freeze({
      protocol_session_id: `store-session-${effectId}`,
      protocol_session_generation:
        '11111111-1111-4111-8111-111111111111',
      effect_id: effectId,
      command_id: `store-command-${effectId}`,
      owner_epoch: '1',
      command_sequence: '1',
      wire_sha256: wireHash,
      route_binding_sha256: routeHash,
      wire_attempt_facts_sha256: attemptHash,
      wire_freeze_sha256: sipWireFreezeSha256({
        route_binding_sha256: routeHash,
        wire_attempt_facts_sha256: attemptHash,
        wire_sha256: wireHash,
        wire_length_bytes: wire.byteLength
      }),
      wire_length_bytes: wire.byteLength
    }),
    route_binding: route,
    wire_attempt_facts: attempt,
    wire_bytes_base64: wire.toString('base64')
  });
  const authority: PreparedProtocolEffectAuthority = Object.freeze({
    verifyPreparedEffect(candidate: PreparedProtocolEffect): Uint8Array {
      assert.equal(candidate, prepared);
      return Buffer.from(wire);
    }
  });
  const input: DurableProtocolEffectPrepareInput = {
    tenant_id: tenantId,
    decision_id: `store-decision-${effectId}`,
    idempotency_key: `store-idempotency-${effectId}`,
    request_hash: requestHash,
    prepared_effect: prepared
  };
  const identity: ProtocolEffectIdentity = {
    tenant_id: tenantId,
    protocol_effect_id: effectId,
    protocol_session_id: prepared.wire_identity.protocol_session_id,
    protocol_session_generation:
      prepared.wire_identity.protocol_session_generation,
    decision_id: input.decision_id,
    idempotency_key: input.idempotency_key,
    request_hash: requestHash,
    command_id: prepared.wire_identity.command_id,
    adapter_identity_hash: canonicalSipEffectHash(adapterIdentity),
    wire_bytes_hash: wireHash,
    wire_length_bytes: wire.byteLength,
    route_binding_hash: routeHash,
    wire_attempt_facts_hash: attemptHash,
    wire_freeze_sha256: prepared.wire_identity.wire_freeze_sha256,
    owner_epoch: prepared.wire_identity.owner_epoch,
    command_sequence: prepared.wire_identity.command_sequence
  };
  return { authority, input, identity };
}

async function tablePrivileges(
  admin: Pool,
  role: string,
  tables: readonly string[]
): Promise<PrivilegeRow[]> {
  const result = await admin.query<PrivilegeRow>(
    `SELECT
       feature_table AS table_name,
       has_table_privilege($1, format('public.%I', feature_table), 'SELECT')
         AS can_select,
       has_table_privilege($1, format('public.%I', feature_table), 'INSERT')
         AS can_insert,
       has_table_privilege($1, format('public.%I', feature_table), 'UPDATE')
         AS can_update,
       has_table_privilege($1, format('public.%I', feature_table), 'DELETE')
         AS can_delete,
       has_table_privilege($1, format('public.%I', feature_table), 'TRUNCATE')
         AS can_truncate
     FROM unnest($2::text[]) AS feature_tables(feature_table)
     ORDER BY feature_table`,
    [role, [...tables]]
  );
  return result.rows;
}

async function registryState(admin: Pool): Promise<{
  schema_enabled: boolean;
  schema_activation_receipt_id: string | null;
  writer_enabled: boolean;
  writer_activation_receipt_id: string | null;
}> {
  const result = await admin.query<{
    schema_enabled: boolean;
    schema_activation_receipt_id: string | null;
    writer_enabled: boolean;
    writer_activation_receipt_id: string | null;
  }>(
    `SELECT
       schema_entry.enabled AS schema_enabled,
       schema_entry.activation_receipt_id AS schema_activation_receipt_id,
       writer.enabled AS writer_enabled,
       writer.activation_receipt_id AS writer_activation_receipt_id
     FROM ivekit_sip_effect_schema_registry AS schema_entry
     CROSS JOIN ivekit_sip_effect_writer_registry AS writer
     WHERE schema_entry.schema_id = $1
       AND schema_entry.schema_version = $2
       AND writer.writer_identity = $3`,
    [
      SIP_EFFECT_SCHEMA_ID,
      SIP_EFFECT_SCHEMA_VERSION,
      WRITER_IDENTITY
    ]
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

async function activateTestRegistries(
  admin: Pool,
  schemaReceiptId: string,
  writerReceiptId: string
): Promise<void> {
  await admin.query('BEGIN');
  try {
    const schema = await admin.query(
      `UPDATE ivekit_sip_effect_schema_registry
       SET enabled = TRUE,
           activation_receipt_id = $3,
           activated_at = clock_timestamp()
       WHERE schema_id = $1 AND schema_version = $2`,
      [SIP_EFFECT_SCHEMA_ID, SIP_EFFECT_SCHEMA_VERSION, schemaReceiptId]
    );
    const writer = await admin.query(
      `UPDATE ivekit_sip_effect_writer_registry
       SET enabled = TRUE,
           activation_receipt_id = $2,
           activated_at = clock_timestamp()
       WHERE writer_identity = $1`,
      [WRITER_IDENTITY, writerReceiptId]
    );
    assert.equal(schema.rowCount, 1);
    assert.equal(writer.rowCount, 1);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}

async function beginRuntimeTransaction(
  client: PoolClient,
  tenantId: string
): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `SELECT set_config('app.current_tenant', $1, TRUE)`,
    [tenantId]
  );
  await client.query(`SET LOCAL statement_timeout = '250ms'`);
  await client.query(`SET LOCAL lock_timeout = '250ms'`);
  await client.query(
    'SET LOCAL search_path = pg_catalog, public, pg_temp'
  );
}

async function beginExecutor(
  client: PoolClient,
  tenantId: string,
  writerIdentity: string
): Promise<void> {
  await beginRuntimeTransaction(client, tenantId);
  await client.query(`SET LOCAL ROLE ${EXECUTOR_ROLE}`);
  await client.query(
    `SELECT set_config(
       'app.sip_effect_writer_identity',
       $1,
       TRUE
     )`,
    [writerIdentity]
  );
}

async function beginElectedExecutor(
  client: PoolClient,
  tenantId: string
): Promise<void> {
  await beginExecutor(client, tenantId, WRITER_IDENTITY);
  await client.query(
    'SELECT ivekit_assert_sip_effect_writer($1, $2, $3, $4)',
    [
      WRITER_IDENTITY,
      SIP_EFFECT_SCHEMA_ID,
      SIP_EFFECT_SCHEMA_VERSION,
      SIP_EFFECT_SCHEMA_HASH
    ]
  );
}

async function insertMinimalEffect(
  client: PoolClient,
  tenantId: string,
  protocolEffectId: string
): Promise<void> {
  const wireBytes = Buffer.from(
    `OPTIONS sip:${protocolEffectId}@example.invalid SIP/2.0\r\n` +
    'Content-Length: 0\r\n\r\n'
  );
  const preparedAt = new Date();
  const auditUntil = new Date(preparedAt.getTime() + 86_400_000);
  const adapterIdentity = { adapter: 'physical-postgres-test' };
  const routeBinding = { route: 'physical-postgres-test' };
  const wireAttemptFacts = { transport: 'udp' };
  const result = await client.query<{ protocol_effect_id: string }>(
    `INSERT INTO ivekit_sip_protocol_effects
       (protocol_effect_id, tenant_id, protocol_session_id,
        protocol_session_generation, decision_id, idempotency_key,
        request_hash, command_id, adapter_identity, adapter_identity_hash,
        wire_bytes_hash, wire_length_bytes, canonical_wire_bytes,
        route_binding, route_binding_hash, wire_attempt_facts,
        wire_attempt_facts_hash, wire_freeze_sha256, effect_identity_hash,
        owner_epoch, command_sequence, schema_id, schema_version, schema_hash,
        writer_identity, state, audit_until, prepared_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13,
        $14::jsonb, $15, $16::jsonb, $17, $18, $19, 1, 1, $20, $21, $22,
        $23, 'prepared', $24::timestamptz, $25::timestamptz,
        $25::timestamptz)
     RETURNING protocol_effect_id`,
    [
      protocolEffectId,
      tenantId,
      `session-${protocolEffectId}`,
      '1',
      `decision-${protocolEffectId}`,
      `idempotency-${protocolEffectId}`,
      hash(`request:${protocolEffectId}`),
      `command-${protocolEffectId}`,
      JSON.stringify(adapterIdentity),
      hash(JSON.stringify(adapterIdentity)),
      hash(wireBytes),
      wireBytes.length,
      wireBytes,
      JSON.stringify(routeBinding),
      hash(JSON.stringify(routeBinding)),
      JSON.stringify(wireAttemptFacts),
      hash(JSON.stringify(wireAttemptFacts)),
      hash(Buffer.concat([Buffer.from('wire-freeze:'), wireBytes])),
      hash(`effect-identity:${protocolEffectId}`),
      SIP_EFFECT_SCHEMA_ID,
      SIP_EFFECT_SCHEMA_VERSION,
      SIP_EFFECT_SCHEMA_HASH,
      WRITER_IDENTITY,
      auditUntil,
      preparedAt
    ]
  );
  assert.deepEqual(result.rows, [{ protocol_effect_id: protocolEffectId }]);
}

async function assertRuntimeIdentity(client: PoolClient): Promise<void> {
  const identity = await client.query<{
    current_user: string;
    session_user: string;
  }>('SELECT current_user, session_user');
  assert.deepEqual(identity.rows[0], {
    current_user: RUNTIME_ROLE,
    session_user: RUNTIME_ROLE
  });
}

async function expectPgFailure(
  operation: Promise<unknown>,
  expectedCode: string
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    const code = String((error as PgFailure).code || '');
    assert.equal(code, expectedCode, error.message);
    return true;
  });
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
