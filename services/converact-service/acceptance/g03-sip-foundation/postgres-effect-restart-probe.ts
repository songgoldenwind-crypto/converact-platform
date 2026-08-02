import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { Pool, type PoolClient } from 'pg';

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

export type PostgresRestartPhase = 'prepare' | 'recover' | 'verify' | 'cleanup';

export interface PostgresRestartCleanupStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly expected_row_count: number;
}

export interface PostgresRestartBinding {
  readonly run_id: string;
  readonly source_commit: string;
  readonly database_name: string;
  readonly confirmation_sha256: string;
  readonly tenant_name: string;
  readonly tenant_marker: Readonly<{
    goal_id: 'G03';
    run_id: string;
    source_commit: string;
    confirmation_sha256: string;
  }>;
  readonly protocol_effect_id: string;
  readonly durable_receipt_id: string;
  readonly send_receipt_id: string;
  readonly accepted_receipt_id: string;
  readonly observed_receipt_id: string;
  readonly writer_activation_receipt_id: string;
  readonly schema_activation_receipt_id: string;
}

export interface PostgresRestartDatabaseIdentity {
  readonly system_identifier: string;
  readonly postmaster_start_time: string;
}

export interface PostgresRestartReplayOracle {
  query(identity: ProtocolEffectIdentity): Promise<{
    readonly state: string;
    readonly revision: string;
    readonly last_receipt_id: string | null;
  } | null>;
  prepare(input: DurableProtocolEffectPrepareInput): Promise<{
    readonly effect: {
      readonly state: string;
      readonly revision: string;
      readonly last_receipt_id: string | null;
    };
    readonly replayed: boolean;
  }>;
  recordTransportAccepted(
    identity: ProtocolEffectIdentity,
    receiptId: string
  ): Promise<{
    readonly state: string;
    readonly revision: string;
    readonly last_receipt_id: string | null;
  }>;
  recordProtocolObserved(
    identity: ProtocolEffectIdentity,
    receiptId: string
  ): Promise<{
    readonly state: string;
    readonly revision: string;
    readonly last_receipt_id: string | null;
  }>;
}

const EXECUTOR_ROLE = 'opc_sip_effect_executor';
const RUNTIME_ROLE = 'opc_runtime';
const WRITER_IDENTITY = 'unified-rustpbx.sip-foundation';
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const RESTART_BINDING_VERSION = 'converact-g03-postgres-restart-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_EVIDENCE_BYTES = 1_048_576;

export const POSTGRES_RESTART_DATABASE_LIMITS = Object.freeze({
  connection_timeout_ms: 2_000,
  statement_timeout_ms: 2_000,
  lock_timeout_ms: 1_000,
  query_timeout_ms: 2_500,
  phase_timeout_ms: 15_000
});

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
      (args[0] !== 'prepare' && args[0] !== 'recover' &&
       args[0] !== 'verify' && args[0] !== 'cleanup')) {
    throw new Error('g03_postgres_restart_phase_invalid');
  }
  return args[0];
}

export function createPostgresRestartBinding(
  runIdInput: string,
  sourceCommitInput: string
): PostgresRestartBinding {
  const runId = checkedRunId(runIdInput);
  const sourceCommit = checkedSourceCommit(sourceCommitInput);
  const databaseName = `converact_g03_${runId.replaceAll('-', '_')}`;
  if (databaseName.length > 63) {
    throw new Error('g03_postgres_restart_database_name_invalid');
  }
  const confirmation = sha256([
    RESTART_BINDING_VERSION,
    runId,
    sourceCommit,
    databaseName
  ].join('\n'));
  const tenantMarker = Object.freeze({
    goal_id: 'G03' as const,
    run_id: runId,
    source_commit: sourceCommit,
    confirmation_sha256: confirmation
  });
  return Object.freeze({
    run_id: runId,
    source_commit: sourceCommit,
    database_name: databaseName,
    confirmation_sha256: confirmation,
    tenant_name: `G03 PostgreSQL restart ${runId}`,
    tenant_marker: tenantMarker,
    protocol_effect_id: `g03-effect-${runId}`,
    durable_receipt_id: `g03-durable-${runId}`,
    send_receipt_id: `g03-send-${runId}`,
    accepted_receipt_id: `g03-accepted-${runId}`,
    observed_receipt_id: `g03-observed-${runId}`,
    writer_activation_receipt_id: `g03-writer-activation-${runId}`,
    schema_activation_receipt_id: `g03-schema-activation-${runId}`
  });
}

export function createPostgresRestartCleanupPlan(
  binding: PostgresRestartBinding
): readonly PostgresRestartCleanupStatement[] {
  return Object.freeze([
    Object.freeze({
      sql: `DELETE FROM ivekit_sip_effect_receipts
            WHERE tenant_id = $1 AND protocol_effect_id = $2`,
      params: Object.freeze([binding.run_id, binding.protocol_effect_id]),
      expected_row_count: 4
    }),
    Object.freeze({
      sql: `DELETE FROM tenants
            WHERE id = $1 AND name = $2 AND settings = $3::jsonb`,
      params: Object.freeze([
        binding.run_id,
        binding.tenant_name,
        JSON.stringify(binding.tenant_marker)
      ]),
      expected_row_count: 1
    }),
    Object.freeze({
      sql: `UPDATE ivekit_sip_effect_writer_registry
            SET enabled = FALSE,
                activation_receipt_id = NULL,
                activated_at = NULL
            WHERE writer_identity = $1
              AND activation_receipt_id = $2
              AND enabled = TRUE`,
      params: Object.freeze([
        WRITER_IDENTITY,
        binding.writer_activation_receipt_id
      ]),
      expected_row_count: 1
    }),
    Object.freeze({
      sql: `UPDATE ivekit_sip_effect_schema_registry
            SET enabled = FALSE,
                activation_receipt_id = NULL,
                activated_at = NULL
            WHERE schema_id = $1
              AND schema_version = $2
              AND activation_receipt_id = $3
              AND enabled = TRUE`,
      params: Object.freeze([
        SIP_EFFECT_SCHEMA_ID,
        SIP_EFFECT_SCHEMA_VERSION,
        binding.schema_activation_receipt_id
      ]),
      expected_row_count: 1
    })
  ]);
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

export async function replayPostgresRestartEffect(
  oracle: PostgresRestartReplayOracle,
  fixture: ReturnType<typeof createPostgresRestartFixture>,
  binding: PostgresRestartBinding
): Promise<Readonly<{
  prepare_replayed: true;
  accepted_receipt_replayed: true;
  recovered_state: 'transport_accepted';
  recovered_revision: '4';
  observed_state: 'protocol_observed';
  observed_revision: '5';
  replay_revision: '5';
}>> {
  const recovered = await oracle.query(fixture.identity);
  if (!recovered || recovered.state !== 'transport_accepted' ||
      recovered.revision !== '4' ||
      recovered.last_receipt_id !== binding.accepted_receipt_id) {
    throw new Error('g03_postgres_restart_recovered_effect_invalid');
  }

  const preparedReplay = await oracle.prepare(fixture.input);
  if (preparedReplay.replayed !== true ||
      preparedReplay.effect.state !== 'transport_accepted' ||
      preparedReplay.effect.revision !== '4' ||
      preparedReplay.effect.last_receipt_id !== binding.accepted_receipt_id) {
    throw new Error('g03_postgres_restart_prepare_replay_invalid');
  }

  const acceptedReplay = await oracle.recordTransportAccepted(
    fixture.identity,
    binding.accepted_receipt_id
  );
  if (acceptedReplay.state !== 'transport_accepted' ||
      acceptedReplay.revision !== '4' ||
      acceptedReplay.last_receipt_id !== binding.accepted_receipt_id) {
    throw new Error('g03_postgres_restart_accepted_replay_invalid');
  }

  const observed = await oracle.recordProtocolObserved(
    fixture.identity,
    binding.observed_receipt_id
  );
  if (observed.state !== 'protocol_observed' || observed.revision !== '5' ||
      observed.last_receipt_id !== binding.observed_receipt_id) {
    throw new Error('g03_postgres_restart_observed_transition_invalid');
  }
  const observedReplay = await oracle.recordProtocolObserved(
    fixture.identity,
    binding.observed_receipt_id
  );
  if (observedReplay.state !== 'protocol_observed' ||
      observedReplay.revision !== '5' ||
      observedReplay.last_receipt_id !== binding.observed_receipt_id) {
    throw new Error('g03_postgres_restart_observed_replay_invalid');
  }

  return Object.freeze({
    prepare_replayed: true,
    accepted_receipt_replayed: true,
    recovered_state: 'transport_accepted',
    recovered_revision: '4',
    observed_state: 'protocol_observed',
    observed_revision: '5',
    replay_revision: '5'
  });
}

export function verifyPostgresRestartEvidence(
  binding: PostgresRestartBinding,
  preparedInput: unknown,
  recoveredInput: unknown
): Readonly<{
  status: 'passed';
  phase: 'verify';
  restart_confirmed: true;
  process_replacement_confirmed: true;
  pre_restart_effect_replay_confirmed: true;
  system_identifier: string;
  previous_postmaster_start_time: string;
  recovered_postmaster_start_time: string;
  production_eligible: false;
}> {
  const prepared = checkedEvidenceRecord(preparedInput, 'prepare');
  const recovered = checkedEvidenceRecord(recoveredInput, 'recover');
  assertEvidenceBinding(prepared, binding);
  assertEvidenceBinding(recovered, binding);
  const preparedProcess = checkedEvidenceUuid(prepared.process_instance_id);
  const recoveredProcess = checkedEvidenceUuid(recovered.process_instance_id);
  if (preparedProcess === recoveredProcess) {
    throw new Error('g03_postgres_restart_process_not_replaced');
  }
  const preparedDatabase = checkedDatabaseIdentity(prepared.postgres_identity);
  const recoveredDatabase = checkedDatabaseIdentity(recovered.postgres_identity);
  if (preparedDatabase.system_identifier !== recoveredDatabase.system_identifier) {
    throw new Error('g03_postgres_restart_system_identifier_changed');
  }
  if (preparedDatabase.postmaster_start_time ===
      recoveredDatabase.postmaster_start_time) {
    throw new Error('g03_postgres_restart_not_observed');
  }
  if (prepared.state !== 'transport_accepted' || prepared.revision !== '4' ||
      prepared.last_receipt_id !== binding.accepted_receipt_id) {
    throw new Error('g03_postgres_restart_prepare_evidence_invalid');
  }
  if (recovered.prepare_replayed !== true ||
      recovered.accepted_receipt_replayed !== true) {
    throw new Error('g03_postgres_restart_pre_restart_replay_missing');
  }
  if (recovered.recovered_state !== 'transport_accepted' ||
      recovered.recovered_revision !== '4' ||
      recovered.observed_state !== 'protocol_observed' ||
      recovered.observed_revision !== '5' ||
      recovered.replay_revision !== '5' ||
      recovered.effect_count !== 1 || recovered.receipt_count !== 4) {
    throw new Error('g03_postgres_restart_recover_evidence_invalid');
  }
  if (prepared.production_eligible !== false ||
      recovered.production_eligible !== false) {
    throw new Error('g03_postgres_restart_eligibility_invalid');
  }
  return Object.freeze({
    status: 'passed',
    phase: 'verify',
    restart_confirmed: true,
    process_replacement_confirmed: true,
    pre_restart_effect_replay_confirmed: true,
    system_identifier: preparedDatabase.system_identifier,
    previous_postmaster_start_time: preparedDatabase.postmaster_start_time,
    recovered_postmaster_start_time: recoveredDatabase.postmaster_start_time,
    production_eligible: false
  });
}

function checkedEvidenceRecord(
  value: unknown,
  phase: 'prepare' | 'recover'
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`g03_postgres_restart_${phase}_evidence_invalid`);
  }
  const record = value as Record<string, unknown>;
  if (record.status !== 'passed' || record.phase !== phase) {
    throw new Error(`g03_postgres_restart_${phase}_evidence_invalid`);
  }
  return record;
}

function assertEvidenceBinding(
  record: Readonly<Record<string, unknown>>,
  binding: PostgresRestartBinding
): void {
  if (!isDeepStrictEqual(record.campaign_binding, binding)) {
    throw new Error('g03_postgres_restart_evidence_binding_invalid');
  }
}

function checkedEvidenceUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error('g03_postgres_restart_process_identity_invalid');
  }
  return value;
}

function checkedDatabaseIdentity(value: unknown): PostgresRestartDatabaseIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('g03_postgres_restart_database_identity_invalid');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.system_identifier !== 'string' ||
      !/^[0-9]{10,32}$/u.test(record.system_identifier) ||
      typeof record.postmaster_start_time !== 'string' ||
      record.postmaster_start_time.length < 10 ||
      record.postmaster_start_time.length > 128 ||
      /[\u0000-\u001f\u007f]/u.test(record.postmaster_start_time)) {
    throw new Error('g03_postgres_restart_database_identity_invalid');
  }
  return Object.freeze({
    system_identifier: record.system_identifier,
    postmaster_start_time: record.postmaster_start_time
  });
}

function assertPrepareEvidenceForRecovery(
  binding: PostgresRestartBinding,
  preparedInput: unknown,
  recoveredProcessInstanceId: string,
  recoveredDatabaseIdentity: PostgresRestartDatabaseIdentity
): void {
  const prepared = checkedEvidenceRecord(preparedInput, 'prepare');
  assertEvidenceBinding(prepared, binding);
  const preparedProcess = checkedEvidenceUuid(prepared.process_instance_id);
  const recoveredProcess = checkedEvidenceUuid(recoveredProcessInstanceId);
  if (preparedProcess === recoveredProcess) {
    throw new Error('g03_postgres_restart_process_not_replaced');
  }
  const preparedDatabase = checkedDatabaseIdentity(prepared.postgres_identity);
  const recoveredDatabase = checkedDatabaseIdentity(recoveredDatabaseIdentity);
  if (preparedDatabase.system_identifier !== recoveredDatabase.system_identifier) {
    throw new Error('g03_postgres_restart_system_identifier_changed');
  }
  if (preparedDatabase.postmaster_start_time ===
      recoveredDatabase.postmaster_start_time) {
    throw new Error('g03_postgres_restart_not_observed');
  }
  if (prepared.state !== 'transport_accepted' || prepared.revision !== '4' ||
      prepared.last_receipt_id !== binding.accepted_receipt_id ||
      prepared.production_eligible !== false) {
    throw new Error('g03_postgres_restart_prepare_evidence_invalid');
  }
}

async function readDatabaseIdentity(
  database: Pool | PoolClient
): Promise<PostgresRestartDatabaseIdentity> {
  const result = await database.query<{
    system_identifier: string;
    postmaster_start_time: string;
  }>(
    `SELECT
       control.system_identifier::text AS system_identifier,
       pg_postmaster_start_time()::text AS postmaster_start_time
     FROM pg_control_system() AS control`
  );
  if (result.rows.length !== 1) {
    throw new Error('g03_postgres_restart_database_identity_invalid');
  }
  return checkedDatabaseIdentity(result.rows[0]);
}

async function main(): Promise<void> {
  const phase = parsePostgresRestartPhase(process.argv.slice(2));
  const binding = createPostgresRestartBinding(
    requiredEnv('CONVERACT_G03_RESTART_RUN_ID'),
    requiredEnv('CONVERACT_G03_SOURCE_COMMIT')
  );
  assert.equal(
    requiredEnv('PGDATABASE'),
    binding.database_name,
    'g03_postgres_restart_database_binding_invalid'
  );
  assert.equal(
    requiredEnv('CONVERACT_G03_RESTART_CONFIRMATION_SHA256'),
    binding.confirmation_sha256,
    'g03_postgres_restart_confirmation_invalid'
  );
  const outputPath = requiredOutputPath();
  await withPostgresRestartPhaseDeadline(async () => {
    if (phase === 'prepare') await prepare(binding, outputPath);
    if (phase === 'recover') await recover(binding, outputPath);
    if (phase === 'verify') await verify(binding, outputPath);
    if (phase === 'cleanup') await cleanup(binding, outputPath);
  });
}

export async function withPostgresRestartPhaseDeadline<T>(
  operation: () => Promise<T>
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('g03_postgres_restart_phase_timeout'));
    }, POSTGRES_RESTART_DATABASE_LIMITS.phase_timeout_ms);
    timer.unref();
  });
  try {
    return await Promise.race([operation(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function prepare(
  binding: PostgresRestartBinding,
  outputPath: string
): Promise<void> {
  const runId = binding.run_id;
  const processInstanceId = randomUUID();
  const admin = databasePool('admin');
  const runtimePassword = requiredEnv('CONVERACT_RUNTIME_DB_PASSWORD');
  let runtime: Pool | null = null;
  try {
    await initializeConveractFabricRuntimeRole(admin, runtimePassword);
    await assertRegistryState(admin, false);
    const postgresIdentity = await readDatabaseIdentity(admin);
    await admin.query(
      `INSERT INTO tenants (id, name, settings)
       VALUES ($1, $2, $3::jsonb)`,
      [runId, binding.tenant_name, JSON.stringify(binding.tenant_marker)]
    );
    await activateRegistries(admin, binding);
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
      binding.durable_receipt_id
    );
    await oracle.recordSendAttempted(
      fixture.identity,
      binding.send_receipt_id
    );
    const accepted = await oracle.recordTransportAccepted(
      fixture.identity,
      binding.accepted_receipt_id
    );
    assert.equal(accepted.state, 'transport_accepted');
    assert.equal(accepted.revision, '4');
    writeJson(outputPath, {
      status: 'passed',
      phase: 'prepare',
      process_pid: process.pid,
      process_instance_id: processInstanceId,
      campaign_binding: binding,
      postgres_identity: postgresIdentity,
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

async function recover(
  binding: PostgresRestartBinding,
  outputPath: string
): Promise<void> {
  const runId = binding.run_id;
  const processInstanceId = randomUUID();
  const admin = databasePool('admin');
  const runtime = databasePool('runtime');
  try {
    await assertRegistryState(admin, true, binding);
    const preparedEvidence = readEvidenceFile(
      requiredEvidencePath('CONVERACT_G03_PREPARE_EVIDENCE')
    );
    const postgresIdentity = await readDatabaseIdentity(admin);
    assertPrepareEvidenceForRecovery(
      binding,
      preparedEvidence,
      processInstanceId,
      postgresIdentity
    );
    const fixture = createPostgresRestartFixture(runId);
    const oracle = new SipEffectOracle({
      store: new PostgresEffectStore(runtime),
      prepared_effect_authority: RESTART_AUTHORITY
    });
    const replay = await replayPostgresRestartEffect(
      oracle,
      fixture,
      binding
    );
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
      process_instance_id: processInstanceId,
      campaign_binding: binding,
      postgres_identity: postgresIdentity,
      identity: fixture.identity,
      ...replay,
      effect_count: 1,
      receipt_count: 4,
      production_eligible: false
    });
  } finally {
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
}

async function verify(
  binding: PostgresRestartBinding,
  outputPath: string
): Promise<void> {
  const prepared = readEvidenceFile(
    requiredEvidencePath('CONVERACT_G03_PREPARE_EVIDENCE')
  );
  const recovered = readEvidenceFile(
    requiredEvidencePath('CONVERACT_G03_RECOVER_EVIDENCE')
  );
  writeJson(
    outputPath,
    verifyPostgresRestartEvidence(binding, prepared, recovered)
  );
}

async function cleanup(
  binding: PostgresRestartBinding,
  outputPath: string
): Promise<void> {
  const runId = binding.run_id;
  const admin = databasePool('admin');
  const client = await admin.connect();
  try {
    await beginBoundedTransaction(client);
    await assertCampaignOwnership(client, binding);
    for (const statement of createPostgresRestartCleanupPlan(binding)) {
      const result = await client.query(statement.sql, [...statement.params]);
      assert.equal(
        result.rowCount,
        statement.expected_row_count,
        'g03_postgres_restart_cleanup_row_count_invalid'
      );
    }
    await client.query('COMMIT');
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
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await admin.end();
  }
}

async function activateRegistries(
  admin: Pool,
  binding: PostgresRestartBinding
): Promise<void> {
  const client = await admin.connect();
  try {
    await beginBoundedTransaction(client);
    const schema = await client.query(
      `UPDATE ivekit_sip_effect_schema_registry
       SET enabled = TRUE,
           activation_receipt_id = $3,
           activated_at = clock_timestamp()
       WHERE schema_id = $1
         AND schema_version = $2
         AND enabled = FALSE
         AND activation_receipt_id IS NULL`,
      [
        SIP_EFFECT_SCHEMA_ID,
        SIP_EFFECT_SCHEMA_VERSION,
        binding.schema_activation_receipt_id
      ]
    );
    const writer = await client.query(
      `UPDATE ivekit_sip_effect_writer_registry
       SET enabled = TRUE,
           activation_receipt_id = $2,
           activated_at = clock_timestamp()
       WHERE writer_identity = $1
         AND enabled = FALSE
         AND activation_receipt_id IS NULL`,
      [WRITER_IDENTITY, binding.writer_activation_receipt_id]
    );
    assert.equal(schema.rowCount, 1);
    assert.equal(writer.rowCount, 1);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function beginBoundedTransaction(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query(
    `SET LOCAL statement_timeout = '${POSTGRES_RESTART_DATABASE_LIMITS.statement_timeout_ms}ms'`
  );
  await client.query(
    `SET LOCAL lock_timeout = '${POSTGRES_RESTART_DATABASE_LIMITS.lock_timeout_ms}ms'`
  );
}

async function assertCampaignOwnership(
  admin: Pool | PoolClient,
  binding: PostgresRestartBinding
): Promise<void> {
  const tenant = await admin.query<{
    id: string;
    name: string;
    settings: unknown;
  }>(
    `SELECT id, name, settings
     FROM tenants
     WHERE id = $1
       AND name = $2
       AND settings = $3::jsonb
     FOR UPDATE`,
    [
      binding.run_id,
      binding.tenant_name,
      JSON.stringify(binding.tenant_marker)
    ]
  );
  assert.deepEqual(tenant.rows, [{
    id: binding.run_id,
    name: binding.tenant_name,
    settings: binding.tenant_marker
  }]);

  const effect = await admin.query<{ protocol_effect_id: string }>(
    `SELECT protocol_effect_id
     FROM ivekit_sip_protocol_effects
     WHERE tenant_id = $1 AND protocol_effect_id = $2
     FOR UPDATE`,
    [binding.run_id, binding.protocol_effect_id]
  );
  assert.deepEqual(effect.rows, [{
    protocol_effect_id: binding.protocol_effect_id
  }]);

  const receipts = await admin.query<{ receipt_id: string }>(
    `SELECT receipt_id
     FROM ivekit_sip_effect_receipts
     WHERE tenant_id = $1 AND protocol_effect_id = $2
     ORDER BY receipt_id
     FOR UPDATE`,
    [binding.run_id, binding.protocol_effect_id]
  );
  assert.deepEqual(
    receipts.rows.map(({ receipt_id: receiptId }) => receiptId),
    [
      binding.accepted_receipt_id,
      binding.durable_receipt_id,
      binding.observed_receipt_id,
      binding.send_receipt_id
    ].sort()
  );

  await assertRegistryState(admin, true, binding, true);
}

async function assertRegistryState(
  admin: Pool | PoolClient,
  enabled: boolean,
  binding?: PostgresRestartBinding,
  lock = false
): Promise<void> {
  const result = await admin.query<{
    schema_enabled: boolean;
    schema_activation_receipt_id: string | null;
    writer_enabled: boolean;
    writer_activation_receipt_id: string | null;
    executor_exists: boolean;
    runtime_exists: boolean;
  }>(
    `SELECT
       schema_entry.enabled AS schema_enabled,
       schema_entry.activation_receipt_id AS schema_activation_receipt_id,
       writer.enabled AS writer_enabled,
       writer.activation_receipt_id AS writer_activation_receipt_id,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $4) AS executor_exists,
       EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $5) AS runtime_exists
     FROM ivekit_sip_effect_schema_registry AS schema_entry
     CROSS JOIN ivekit_sip_effect_writer_registry AS writer
     WHERE schema_entry.schema_id = $1
       AND schema_entry.schema_version = $2
       AND writer.writer_identity = $3
     ${lock ? 'FOR UPDATE OF schema_entry, writer' : ''}`,
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
    schema_activation_receipt_id: enabled
      ? binding?.schema_activation_receipt_id
      : null,
    writer_enabled: enabled,
    writer_activation_receipt_id: enabled
      ? binding?.writer_activation_receipt_id
      : null,
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
    connectionTimeoutMillis:
      POSTGRES_RESTART_DATABASE_LIMITS.connection_timeout_ms,
    statement_timeout:
      POSTGRES_RESTART_DATABASE_LIMITS.statement_timeout_ms,
    lock_timeout: POSTGRES_RESTART_DATABASE_LIMITS.lock_timeout_ms,
    query_timeout: POSTGRES_RESTART_DATABASE_LIMITS.query_timeout_ms,
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

function checkedSourceCommit(value: string): string {
  if (!SOURCE_COMMIT_PATTERN.test(value)) {
    throw new Error('g03_postgres_restart_source_commit_invalid');
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

function requiredEvidencePath(name: string): string {
  const value = requiredEnv(name);
  if (!value.startsWith('/')) {
    throw new Error(`g03_postgres_restart_${name.toLowerCase()}_invalid`);
  }
  return resolve(value);
}

function readEvidenceFile(pathInput: string): unknown {
  const path = resolve(pathInput);
  const size = statSync(path).size;
  if (!Number.isSafeInteger(size) || size < 2 || size > MAX_EVIDENCE_BYTES) {
    throw new Error('g03_postgres_restart_evidence_size_invalid');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
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
