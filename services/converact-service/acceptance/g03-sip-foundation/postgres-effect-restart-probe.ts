import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { initializeConveractFabricRuntimeRole } from '../../../../src/converact-runtime-role.js';
import {
  SIP_EFFECT_SCHEMA_HASH,
  SIP_EFFECT_SCHEMA_ID,
  SIP_EFFECT_SCHEMA_VERSION,
  SipEffectOracle,
  canonicalSipEffectHash,
  type DurableProtocolEffectPrepareInput,
  type ProtocolEffectIdentity
} from '../../../../src/agent-runtime/converact/voice/sip-foundation/effect-oracle.js';
import { PostgresEffectStore } from '../../../../src/agent-runtime/converact/voice/sip-foundation/postgres-effect-store.js';
import {
  sipRouteBindingSha256,
  sipWireAttemptFactsSha256,
  sipWireFreezeSha256
} from '../../../../src/agent-runtime/converact/voice/sip-foundation/route-binding.js';
import type {
  BackendRuntimeIdentity,
  BoundSipRouteBinding,
  BoundSipWireAttemptFacts,
  PreparedProtocolEffect,
  PreparedProtocolEffectAuthority
} from '../../../../src/agent-runtime/converact/voice/sip-foundation/types.js';

export type PostgresRestartPhase = 'prepare' | 'recover' | 'cleanup';

const EXECUTOR_ROLE = 'opc_sip_effect_executor';
const RUNTIME_ROLE = 'opc_runtime';
const WRITER_IDENTITY = 'unified-rustpbx.sip-foundation';
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/u;

const RESTART_AUTHORITY: PreparedProtocolEffectAuthority = Object.freeze({
  verifyPreparedEffect(prepared: PreparedProtocolEffect): Uint8Array {
    const bytes = Buffer.from(prepared.wire_bytes_base64, 'base64');
    const routeHash = sipRouteBindingSha256(prepared.route_binding);
    const attemptHash = sipWireAttemptFactsSha256(prepared.wire_attempt_facts);
    const wireHash = sha256(bytes);
    const expectedFreeze = sipWireFreezeSha256({
      route_binding_sha256: routeHash,
      wire_attempt_facts_sha256: attemptHash,
      wire_sha256: wireHash,
      wire_length_bytes: bytes.byteLength
    });
    if (prepared.wire_identity.route_binding_sha256 !== routeHash ||
        prepared.wire_identity.wire_attempt_facts_sha256 !== attemptHash ||
        prepared.wire_identity.wire_sha256 !== wireHash ||
        prepared.wire_identity.wire_freeze_sha256 !== expectedFreeze ||
        prepared.wire_identity.wire_length_bytes !== bytes.byteLength) {
      throw new Error('g03_postgres_restart_prepared_effect_invalid');
    }
    return bytes;
  }
});

export function parsePostgresRestartPhase(args: readonly string[]): PostgresRestartPhase {
  if (args.length !== 1 ||
      (args[0] !== 'prepare' && args[0] !== 'recover' && args[0] !== 'cleanup')) {
    throw new Error('g03_postgres_restart_phase_invalid');
  }
  return args[0];
}

export function createPostgresRestartFixture(runIdInput: string): {
  authority: PreparedProtocolEffectAuthority;
  input: DurableProtocolEffectPrepareInput;
  identity: ProtocolEffectIdentity;
} {
  const runId = checkedRunId(runIdInput);
  const effectId = `g03-effect-${runId}`;
  const requestHash = sha256(`g03-store-request:${effectId}`);
  const route: BoundSipRouteBinding = Object.freeze({
    schema_id: 'sip-foundation-route-binding-v1',
    schema_version: '1.0.0',
    route: Object.freeze({ id: `g03-route-${effectId}`, revision: 1 }),
    rfc3263_candidate: 'g03-restart.example.test',
    route_set: Object.freeze(['sip:g03-edge.example.test;lr']),
    transport: Object.freeze({
      id: `g03-transport-${effectId}`,
      protocol: 'udp',
      next_hop: Object.freeze({ address: '203.0.113.20', port: 5060 })
    }),
    local_endpoint: Object.freeze({ address: '10.0.0.20', port: 5060 }),
    advertised_via_sent_by: Object.freeze({
      host: 'g03-voice.example.test',
      port: 5060
    }),
    tls_sni: null,
    authorization_identity: 'g03-restart-test-trunk',
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
    via_branch: `z9hG4bKg03-${sha256(effectId).slice(0, 40)}`
  });
  const wire = Buffer.from(
    `OPTIONS sip:${effectId}@example.test SIP/2.0\r\n` +
    `Via: SIP/2.0/UDP g03-voice.example.test:5060;branch=${attempt.via_branch}\r\n` +
    `Call-ID: ${effectId}\r\n` +
    'CSeq: 1 OPTIONS\r\n' +
    'Content-Length: 0\r\n\r\n'
  );
  const adapterIdentity: BackendRuntimeIdentity = Object.freeze({
    backend_id: 'rsipstack',
    source_digest: sha256('g03-postgres-restart-source'),
    binary_digest: sha256('g03-postgres-restart-binary'),
    config_digest: sha256('g03-postgres-restart-config'),
    capability_set_digest: sha256('g03-postgres-restart-capabilities'),
    runtime_attestation_verification: 'not_run',
    production_eligible: false
  });
  const routeHash = sipRouteBindingSha256(route);
  const attemptHash = sipWireAttemptFactsSha256(attempt);
  const wireHash = sha256(wire);
  const prepared: PreparedProtocolEffect = Object.freeze({
    adapter_identity: adapterIdentity,
    wire_identity: Object.freeze({
      protocol_session_id: `g03-session-${effectId}`,
      protocol_session_generation: '33333333-3333-4333-8333-333333333333',
      effect_id: effectId,
      command_id: `g03-command-${effectId}`,
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
  const input: DurableProtocolEffectPrepareInput = Object.freeze({
    tenant_id: runId,
    decision_id: `g03-decision-${effectId}`,
    idempotency_key: `g03-idempotency-${effectId}`,
    request_hash: requestHash,
    prepared_effect: prepared
  });
  const identity: ProtocolEffectIdentity = Object.freeze({
    tenant_id: runId,
    protocol_effect_id: effectId,
    protocol_session_id: prepared.wire_identity.protocol_session_id,
    protocol_session_generation: prepared.wire_identity.protocol_session_generation,
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
  });
  return Object.freeze({ authority: RESTART_AUTHORITY, input, identity });
}

async function main(): Promise<void> {
  const phase = parsePostgresRestartPhase(process.argv.slice(2));
  const runId = checkedRunId(requiredEnv('CONVERACT_G03_RESTART_RUN_ID'));
  const outputPath = requiredOutputPath();
  if (phase === 'prepare') await prepare(runId, outputPath);
  if (phase === 'recover') await recover(runId, outputPath);
  if (phase === 'cleanup') await cleanup(runId, outputPath);
}

async function prepare(runId: string, outputPath: string): Promise<void> {
  const admin = databasePool('admin');
  const runtimePassword = requiredEnv('CONVERACT_RUNTIME_DB_PASSWORD');
  let runtime: Pool | null = null;
  try {
    await initializeConveractFabricRuntimeRole(admin, runtimePassword);
    await assertRegistryState(admin, false);
    await admin.query(
      `INSERT INTO tenants (id, name)
       VALUES ($1, $2)`,
      [runId, `G03 PostgreSQL restart ${runId}`]
    );
    await activateRegistries(admin, runId);
    runtime = databasePool('runtime');
    const fixture = createPostgresRestartFixture(runId);
    const oracle = new SipEffectOracle({
      store: new PostgresEffectStore(runtime),
      prepared_effect_authority: fixture.authority
    });
    const prepared = await oracle.prepare(fixture.input);
    assert.equal(prepared.replayed, false);
    await oracle.recordDurableDecision(
      fixture.identity,
      `g03-durable-${runId}`
    );
    await oracle.recordSendAttempted(
      fixture.identity,
      `g03-send-${runId}`
    );
    const accepted = await oracle.recordTransportAccepted(
      fixture.identity,
      `g03-accepted-${runId}`
    );
    assert.equal(accepted.state, 'transport_accepted');
    assert.equal(accepted.revision, '4');
    writeJson(outputPath, {
      status: 'passed',
      phase: 'prepare',
      process_pid: process.pid,
      identity: fixture.identity,
      state: accepted.state,
      revision: accepted.revision,
      last_receipt_id: accepted.last_receipt_id,
      production_eligible: false
    });
  } finally {
    await Promise.allSettled([
      admin.end(),
      runtime?.end() ?? Promise.resolve()
    ]);
  }
}

async function recover(runId: string, outputPath: string): Promise<void> {
  const admin = databasePool('admin');
  const runtime = databasePool('runtime');
  try {
    await assertRegistryState(admin, true);
    const fixture = createPostgresRestartFixture(runId);
    const oracle = new SipEffectOracle({
      store: new PostgresEffectStore(runtime),
      prepared_effect_authority: RESTART_AUTHORITY
    });
    const recovered = await oracle.query(fixture.identity);
    assert.ok(recovered);
    assert.equal(recovered.state, 'transport_accepted');
    assert.equal(recovered.revision, '4');
    assert.equal(recovered.last_receipt_id, `g03-accepted-${runId}`);
    const receiptId = `g03-observed-${runId}`;
    const observed = await oracle.recordProtocolObserved(fixture.identity, receiptId);
    assert.equal(observed.state, 'protocol_observed');
    assert.equal(observed.revision, '5');
    const replayed = await oracle.recordProtocolObserved(fixture.identity, receiptId);
    assert.equal(replayed.state, 'protocol_observed');
    assert.equal(replayed.revision, '5');
    const counts = await admin.query<{
      effects: string;
      receipts: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM ivekit_sip_protocol_effects
          WHERE tenant_id = $1) AS effects,
         (SELECT COUNT(*)::text FROM ivekit_sip_effect_receipts
          WHERE tenant_id = $1) AS receipts`,
      [runId]
    );
    assert.deepEqual(counts.rows, [{ effects: '1', receipts: '4' }]);
    writeJson(outputPath, {
      status: 'passed',
      phase: 'recover',
      process_pid: process.pid,
      identity: fixture.identity,
      recovered_state: recovered.state,
      recovered_revision: recovered.revision,
      observed_state: observed.state,
      observed_revision: observed.revision,
      replay_revision: replayed.revision,
      effect_count: 1,
      receipt_count: 4,
      production_eligible: false
    });
  } finally {
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
}

async function cleanup(runId: string, outputPath: string): Promise<void> {
  const admin = databasePool('admin');
  try {
    await admin.query('BEGIN');
    await admin.query('DELETE FROM tenants WHERE id = $1', [runId]);
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
    await admin.query('COMMIT');
    await assertRegistryState(admin, false);
    const remaining = await admin.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM tenants
       WHERE id = $1`,
      [runId]
    );
    assert.deepEqual(remaining.rows, [{ count: '0' }]);
    writeJson(outputPath, {
      status: 'passed',
      phase: 'cleanup',
      tenant_rows_remaining: 0,
      campaign_effect_rows_remaining: 0,
      production_eligible: false
    });
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await admin.end();
  }
}

async function activateRegistries(admin: Pool, runId: string): Promise<void> {
  await admin.query('BEGIN');
  try {
    const schema = await admin.query(
      `UPDATE ivekit_sip_effect_schema_registry
       SET enabled = TRUE,
           activation_receipt_id = $3,
           activated_at = clock_timestamp()
       WHERE schema_id = $1 AND schema_version = $2`,
      [
        SIP_EFFECT_SCHEMA_ID,
        SIP_EFFECT_SCHEMA_VERSION,
        `g03-schema-activation-${runId}`
      ]
    );
    const writer = await admin.query(
      `UPDATE ivekit_sip_effect_writer_registry
       SET enabled = TRUE,
           activation_receipt_id = $2,
           activated_at = clock_timestamp()
       WHERE writer_identity = $1`,
      [WRITER_IDENTITY, `g03-writer-activation-${runId}`]
    );
    assert.equal(schema.rowCount, 1);
    assert.equal(writer.rowCount, 1);
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function assertRegistryState(admin: Pool, enabled: boolean): Promise<void> {
  const result = await admin.query<{
    schema_enabled: boolean;
    writer_enabled: boolean;
    executor_exists: boolean;
    runtime_exists: boolean;
  }>(
    `SELECT
       schema_entry.enabled AS schema_enabled,
       writer.enabled AS writer_enabled,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $4) AS executor_exists,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $5) AS runtime_exists
     FROM ivekit_sip_effect_schema_registry AS schema_entry
     CROSS JOIN ivekit_sip_effect_writer_registry AS writer
     WHERE schema_entry.schema_id = $1
       AND schema_entry.schema_version = $2
       AND writer.writer_identity = $3`,
    [
      SIP_EFFECT_SCHEMA_ID,
      SIP_EFFECT_SCHEMA_VERSION,
      WRITER_IDENTITY,
      EXECUTOR_ROLE,
      RUNTIME_ROLE
    ]
  );
  assert.deepEqual(result.rows, [{
    schema_enabled: enabled,
    writer_enabled: enabled,
    executor_exists: true,
    runtime_exists: true
  }]);
}

function databasePool(kind: 'admin' | 'runtime'): Pool {
  const port = Number(requiredEnv('PGPORT'));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('g03_postgres_restart_port_invalid');
  }
  return new Pool({
    host: checkedToken(requiredEnv('PGHOST'), 'host'),
    port,
    database: checkedToken(requiredEnv('PGDATABASE'), 'database'),
    user: kind === 'admin' ? 'opc_admin' : RUNTIME_ROLE,
    password: kind === 'admin'
      ? requiredEnv('PGPASSWORD')
      : requiredEnv('CONVERACT_RUNTIME_DB_PASSWORD'),
    max: 2,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 1_000,
    application_name: `converact-g03-restart-${kind}`
  });
}

function checkedRunId(value: string): string {
  if (!RUN_ID_PATTERN.test(value)) {
    throw new Error('g03_postgres_restart_run_id_invalid');
  }
  return value;
}

function checkedToken(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`g03_postgres_restart_${name}_invalid`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`g03_postgres_restart_${name.toLowerCase()}_invalid`);
  }
  return value;
}

function requiredOutputPath(): string {
  const value = requiredEnv('CONVERACT_G03_RESTART_OUTPUT');
  if (!value.startsWith('/')) {
    throw new Error('g03_postgres_restart_output_invalid');
  }
  return resolve(value);
}

function writeJson(pathInput: string, value: unknown): void {
  const path = resolve(pathInput);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to remove.
    }
    throw error;
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = String((error as { code?: unknown }).code ||
      'g03_postgres_restart_probe_failed')
      .replace(/[^A-Za-z0-9._-]/gu, '_')
      .slice(0, 128);
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  });
}
