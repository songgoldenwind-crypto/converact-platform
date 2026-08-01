import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { withPgTenant } from '../../../../src/db-pg-tenant.js';
import {
  platformPayloadDigest,
  type PlatformEventV2
} from '../../../../src/agent-runtime/converact/platform-foundation/event-envelope.js';
import type {
  EffectReceipt,
  EffectReceiptStage
} from '../../../../src/agent-runtime/converact/platform-foundation/effect-receipt.js';
import type {
  AiRunUsage,
  UsageEntry
} from '../../../../src/agent-runtime/converact/platform-foundation/billing-ledger.js';
import {
  platformBillingEffectId,
  platformBillingKey
} from '../../../../src/agent-runtime/converact/platform-foundation/billing-ledger.js';
import {
  PostgresPlatformEventReceiptStore
} from '../../../../src/agent-runtime/converact/platform-foundation/postgres-event-receipt-store.js';
import {
  PostgresPlatformBillingLedgerStore
} from '../../../../src/agent-runtime/converact/platform-foundation/postgres-billing-ledger-store.js';
import { evaluateControlledFaultScenario } from './evidence-contract.mjs';

type JsonRecord = Record<string, any>;

const EXPECTED_MIGRATION = '112_converact_platform_history_receipt_integrity';
const GOAL_SHA256 = '742e194e6b2d3e2b6fe9390bbabe96a6bbe0f40bdf99d8ed4ae4060a711a87f9';

export function buildDatabaseEvidence(input: {
  identity: JsonRecord;
  prepare: JsonRecord;
  outage: JsonRecord;
  restart: JsonRecord;
  recover: JsonRecord;
  media: JsonRecord;
}): JsonRecord {
  const prepare = record(input.prepare);
  const outage = record(input.outage);
  const restart = record(input.restart);
  const recover = record(input.recover);
  const media = record(input.media);
  const rls = prepare.status === 'passed'
    && prepare.migration_head === EXPECTED_MIGRATION
    && prepare.tenant_a_visible === 1
    && prepare.tenant_b_visible_from_a === 0
    && prepare.no_context_visible === 0
    && prepare.cross_tenant_insert_denied === true
    && recover.tenant_a_visible === 1
    && recover.tenant_b_visible_from_a === 0
    && recover.no_context_visible === 0;
  const durablePrepare = prepare.inbox_inserted === true
    && prepare.accepted_receipt_inserted === true
    && prepare.completed_receipt_inserted === true
    && prepare.usage_inserted === true;
  const actualOutage = outage.status === 'passed'
    && outage.query_failed_during_outage === true;
  const actualRestart = restart.status === 'passed'
    && restart.same_container === true
    && dockerTimestamp(restart.before_started_at)
    && dockerTimestamp(restart.after_started_at)
    && restart.before_started_at !== restart.after_started_at;
  const processRecovery = recover.status === 'passed'
    && positiveInteger(prepare.process_pid)
    && positiveInteger(recover.process_pid)
    && prepare.process_pid !== recover.process_pid
    && recover.inbox_replayed === true
    && recover.accepted_receipt_replayed === true
    && recover.completed_receipt_replayed === true
    && recover.observed_receipt_inserted === true
    && recover.usage_replayed === true;
  const fences = recover.inbox_conflict_rejected === true
    && recover.stale_writer_rejected === true;
  const immutable = recover.immutable_update_rejected === true;
  const mediaContinuous = media.status === 'passed'
    && media.kind === 'synthetic_transport'
    && positiveInteger(media.sent_packets)
    && media.received_packets === media.sent_packets
    && media.lost_packets === 0
    && media.duplicate_packets === 0
    && finiteBounded(media.maximum_gap_ms, 0, 250)
    && media.established_before_fault === true
    && media.continuous_during_fault === true
    && media.completed_after_recovery === true;
  const isolatedCleanup = restart.validation_resources_remaining === 0
    && restart.unrelated_containers_unchanged === true;

  return evaluateControlledFaultScenario({
    dependency: 'database',
    failure_mode: 'restart',
    executed: true,
    actual_fault: actualOutage && actualRestart,
    identity: input.identity,
    media_probe: {
      kind: 'synthetic_transport',
      established_before_fault: media.established_before_fault === true,
      continuous_during_fault: media.continuous_during_fault === true,
      completed_after_recovery: media.completed_after_recovery === true
    },
    checks: [
      check('migration_runtime_rls', rls),
      check('durable_prepare', durablePrepare),
      check('actual_database_outage', actualOutage),
      check('same_container_restart', actualRestart),
      check('process_restart_reconcile', processRecovery),
      check('idempotency_writer_fence', fences),
      check('append_only_history', immutable),
      check('synthetic_transport_and_cleanup', mediaContinuous && isolatedCleanup)
    ]
  });
}

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'prepare') return runPrepare(requiredArgs(args, 1)[0]!);
  if (mode === 'outage') return runOutage(requiredArgs(args, 1)[0]!);
  if (mode === 'recover') return runRecover(requiredArgs(args, 1)[0]!);
  if (mode === 'restart') {
    const [beforeId, beforeStarted, afterId, afterStarted, beforeSnapshot,
      afterSnapshot, remaining, output] = requiredArgs(args, 8, false);
    return runRestartReport({
      before_id: beforeId!, before_started_at: beforeStarted!,
      after_id: afterId!, after_started_at: afterStarted!,
      before_snapshot: resolve(beforeSnapshot!), after_snapshot: resolve(afterSnapshot!),
      remaining: Number(remaining), output: resolve(output!)
    });
  }
  if (mode === 'identity') return writeIdentity(requiredArgs(args, 1)[0]!);
  if (mode === 'finalize') {
    const [identity, prepare, outage, restart, recover, media, output] = requiredArgs(args, 7);
    const result = buildDatabaseEvidence({
      identity: readJson(identity!), prepare: readJson(prepare!), outage: readJson(outage!),
      restart: readJson(restart!), recover: readJson(recover!), media: readJson(media!)
    });
    writeJson(output!, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'verified_controlled') process.exitCode = 1;
    return;
  }
  throw new Error('database_probe_mode_invalid');
}

async function runPrepare(output: string): Promise<void> {
  const admin = pool('admin');
  const runtime = pool('runtime');
  try {
    const ids = campaignIds();
    const head = await admin.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    const migrationHead = String(head.rows[0]?.version || '');
    if (migrationHead !== EXPECTED_MIGRATION) throw new Error('database_migration_head_invalid');
    for (const [id, name] of [[ids.tenantA, 'G02 tenant A'], [ids.tenantB, 'G02 tenant B']]) {
      await admin.query(
        `INSERT INTO tenants (id, name, status, plan_code, settings)
         VALUES ($1, $2, 'active', 'enterprise', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [id, name]
      );
    }

    const noContext = await runtime.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM converact_platform_inbox'
    );
    const tenantAVisible = await tenantCount(runtime, ids.tenantA, 'tenants');
    const tenantBVisibleFromA = await withPgTenant(runtime, ids.tenantA, async (pg) => {
      const result = await pg.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tenants WHERE id = $1', [ids.tenantB]
      );
      return Number(result.rows[0]?.count || 0);
    });
    const crossTenantInsertDenied = await rejectsPgCode(
      () => withPgTenant(runtime, ids.tenantA, (pg) => pg.query(
        `INSERT INTO converact_platform_inbox
          (tenant_id, consumer_id, event_id, payload_digest, aggregate_revision,
           ordering_key, received_at)
         VALUES ($1, $2, $3, $4, 1, $5, $6)`,
        [ids.tenantB, 'cross-tenant-probe', `cross-${ids.runId}`, 'f'.repeat(64),
          `order-${ids.runId}`, campaignTimestamp()]
      )),
      '42501'
    );

    const eventStore = new PostgresPlatformEventReceiptStore(runtime);
    const billingStore = new PostgresPlatformBillingLedgerStore(runtime);
    const inbox = await eventStore.appendInbox({
      tenant_id: ids.tenantA, consumer_id: ids.consumer, event: platformEvent(ids)
    });
    const accepted = await eventStore.appendEffectReceipt(effectReceipt(ids, 'accepted'));
    const completed = await eventStore.appendEffectReceipt(effectReceipt(ids, 'completed'));
    const usageResult = await billingStore.append(usageEntry(ids), billableSource(ids));
    const result = {
      status: 'passed', process_pid: process.pid, migration_head: migrationHead,
      tenant_a_visible: tenantAVisible, tenant_b_visible_from_a: tenantBVisibleFromA,
      no_context_visible: Number(noContext.rows[0]?.count || 0),
      cross_tenant_insert_denied: crossTenantInsertDenied,
      inbox_inserted: inbox.status === 'inserted',
      accepted_receipt_inserted: accepted.status === 'inserted',
      completed_receipt_inserted: completed.status === 'inserted',
      usage_inserted: usageResult.status === 'inserted'
    };
    if (!result.cross_tenant_insert_denied || !result.inbox_inserted
      || !result.accepted_receipt_inserted || !result.completed_receipt_inserted
      || !result.usage_inserted
      || result.tenant_a_visible !== 1 || result.tenant_b_visible_from_a !== 0
      || result.no_context_visible !== 0) throw new Error('database_prepare_checks_failed');
    writeJson(output, result);
  } finally {
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
}

async function runOutage(output: string): Promise<void> {
  const runtime = pool('runtime', 750);
  let failed = false;
  try {
    await runtime.query('SELECT 1');
  } catch {
    failed = true;
  } finally {
    await runtime.end().catch(() => undefined);
  }
  if (!failed) throw new Error('database_outage_not_observed');
  writeJson(output, { status: 'passed', query_failed_during_outage: true });
}

async function runRecover(output: string): Promise<void> {
  const admin = pool('admin');
  const runtime = pool('runtime');
  try {
    const ids = campaignIds();
    const noContext = await runtime.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM converact_platform_inbox'
    );
    const tenantAVisible = await tenantCount(runtime, ids.tenantA, 'tenants');
    const tenantBVisibleFromA = await withPgTenant(runtime, ids.tenantA, async (pg) => {
      const result = await pg.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tenants WHERE id = $1', [ids.tenantB]
      );
      return Number(result.rows[0]?.count || 0);
    });
    const eventStore = new PostgresPlatformEventReceiptStore(runtime);
    const billingStore = new PostgresPlatformBillingLedgerStore(runtime);
    const inboxReplay = await eventStore.appendInbox({
      tenant_id: ids.tenantA, consumer_id: ids.consumer, event: platformEvent(ids)
    });
    const inboxConflict = await rejectsCode(
      () => eventStore.appendInbox({
        tenant_id: ids.tenantA,
        consumer_id: ids.consumer,
        event: platformEvent(ids, { state: 'conflicting' })
      }),
      'platform_inbox_conflict'
    );
    const acceptedReplay = await eventStore.appendEffectReceipt(effectReceipt(ids, 'accepted'));
    const completedReplay = await eventStore.appendEffectReceipt(effectReceipt(ids, 'completed'));
    const observed = await eventStore.appendEffectReceipt(effectReceipt(ids, 'state_observed'));
    const usageReplay = await billingStore.append(usageEntry(ids), billableSource(ids));
    const staleWriter = await rejectsCode(
      () => billingStore.append(usageEntry(ids, {
        entry_id: `usage-stale-${ids.runId}`,
        writer_epoch: 5
      }), billableSource(ids)),
      'platform_usage_stale_writer'
    );
    const immutableUpdate = await rejectsPgCode(
      () => withPgTenant(runtime, ids.tenantA, (pg) => pg.query(
        `UPDATE converact_platform_usage_entries
         SET quantity = quantity + 1
         WHERE tenant_id = $1 AND entry_id = $2`,
        [ids.tenantA, `usage-${ids.runId}`]
      )),
      '55000'
    );
    const result = {
      status: 'passed', process_pid: process.pid,
      tenant_a_visible: tenantAVisible, tenant_b_visible_from_a: tenantBVisibleFromA,
      no_context_visible: Number(noContext.rows[0]?.count || 0),
      inbox_replayed: inboxReplay.status === 'replay',
      inbox_conflict_rejected: inboxConflict,
      accepted_receipt_replayed: acceptedReplay.status === 'replay',
      completed_receipt_replayed: completedReplay.status === 'replay',
      observed_receipt_inserted: observed.status === 'inserted',
      usage_replayed: usageReplay.status === 'replay',
      stale_writer_rejected: staleWriter,
      immutable_update_rejected: immutableUpdate
    };
    if (Object.entries(result).some(([key, value]) =>
      key !== 'process_pid' && key !== 'tenant_a_visible'
      && key !== 'tenant_b_visible_from_a' && key !== 'no_context_visible'
      && value !== true && value !== 'passed')
      || result.tenant_a_visible !== 1 || result.tenant_b_visible_from_a !== 0
      || result.no_context_visible !== 0) throw new Error('database_recovery_checks_failed');
    writeJson(output, result);
  } finally {
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
}

function runRestartReport(input: {
  before_id: string;
  before_started_at: string;
  after_id: string;
  after_started_at: string;
  before_snapshot: string;
  after_snapshot: string;
  remaining: number;
  output: string;
}): void {
  const sameContainer = token(input.before_id) && input.before_id === input.after_id;
  const timestamps = dockerTimestamp(input.before_started_at)
    && dockerTimestamp(input.after_started_at)
    && input.before_started_at !== input.after_started_at;
  const unrelatedUnchanged = readFileSync(input.before_snapshot, 'utf8')
    === readFileSync(input.after_snapshot, 'utf8');
  const result = {
    status: sameContainer && timestamps && input.remaining === 0 && unrelatedUnchanged
      ? 'passed' : 'failed',
    same_container: Boolean(sameContainer),
    before_started_at: input.before_started_at,
    after_started_at: input.after_started_at,
    validation_resources_remaining: input.remaining,
    unrelated_containers_unchanged: unrelatedUnchanged
  };
  writeJson(input.output, result);
  if (result.status !== 'passed') throw new Error('database_restart_identity_failed');
}

function writeIdentity(output: string): void {
  const identity = {
    goal_id: 'G02',
    goal_sha256: GOAL_SHA256,
    source_commit: requiredEnv('CONVERACT_G02_SOURCE_COMMIT', /^[a-f0-9]{40}$/u),
    config_sha256: requiredEnv('CONVERACT_G02_CONFIG_SHA256', /^[a-f0-9]{64}$/u),
    raw_output_sha256: requiredEnv('CONVERACT_G02_RAW_OUTPUT_SHA256', /^[a-f0-9]{64}$/u),
    image_digests: [
      requiredEnv('POSTGRES_IMAGE', /^[^\s@]+@sha256:[a-f0-9]{64}$/u),
      requiredEnv('CONVERACT_G02_NODE_IMAGE', /^[^\s@]+@sha256:[a-f0-9]{64}$/u)
    ],
    node_binary_sha256: requiredEnv('CONVERACT_G02_NODE_BINARY_SHA256', /^[a-f0-9]{64}$/u),
    node_version: requiredEnv('CONVERACT_G02_NODE_VERSION', /^v24\.\d+\.\d+$/u),
    host: requiredEnv('CONVERACT_G02_HOST', /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u),
    hardware: requiredTextEnv('CONVERACT_G02_HARDWARE'),
    clock: requiredTextEnv('CONVERACT_G02_CLOCK'),
    workload: requiredTextEnv('CONVERACT_G02_WORKLOAD'),
    seed: requiredEnv('CONVERACT_G02_SEED', /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u),
    started_at: requiredTimestampEnv('CONVERACT_G02_STARTED_AT'),
    completed_at: new Date().toISOString()
  };
  writeJson(output, identity);
}

function pool(kind: 'admin' | 'runtime', timeout = 2_000): Pool {
  const port = Number(requiredEnv('PGPORT', /^\d{1,5}$/u));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('database_port_invalid');
  return new Pool({
    host: requiredEnv('PGHOST', /^[A-Za-z0-9.:_-]{1,255}$/u),
    port,
    database: requiredEnv('PGDATABASE', /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u),
    user: kind === 'admin' ? 'opc_admin' : 'opc_runtime',
    password: kind === 'admin'
      ? requiredTextEnv('PGPASSWORD')
      : requiredTextEnv('CONVERACT_RUNTIME_DB_PASSWORD'),
    max: 2,
    connectionTimeoutMillis: timeout,
    idleTimeoutMillis: 1_000,
    application_name: `converact-g02-${kind}`
  });
}

async function tenantCount(poolValue: Pool, tenantId: string, table: 'tenants'): Promise<number> {
  return withPgTenant(poolValue, tenantId, async (pg) => {
    const result = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE id = $1`, [tenantId]
    );
    return Number(result.rows[0]?.count || 0);
  });
}

function campaignIds() {
  const runId = requiredEnv('CONVERACT_G02_FAULT_RUN_ID', /^[a-z0-9][a-z0-9-]{0,39}$/u);
  return {
    runId,
    tenantA: `g02-a-${runId}`,
    tenantB: `g02-b-${runId}`,
    consumer: `g02-consumer-${runId}`
  };
}

function platformEvent(ids: ReturnType<typeof campaignIds>, data: unknown = { state: 'prepared' }): PlatformEventV2 {
  return {
    schema_version: 2,
    source_schema_version: 2,
    event_id: `event-${ids.runId}`,
    event_type: 'platform.validation.changed',
    tenant_id: ids.tenantA,
    producer_identity: `validation-${ids.runId}`,
    authority: 'Converact Platform Foundation',
    aggregate_type: 'validation',
    aggregate_id: `aggregate-${ids.runId}`,
    aggregate_revision: 1,
    ordering_key: `ordering-${ids.runId}`,
    idempotency_key: `idempotency-${ids.runId}`,
    payload_digest: platformPayloadDigest(data),
    occurred_at: campaignTimestamp(),
    observed_at: campaignTimestamp(),
    correlation: { correlation_id: `correlation-${ids.runId}` },
    causation_event_id: null,
    purpose: 'controlled_validation',
    region_policy: 'validation-only',
    retention_policy: 'ephemeral-validation',
    data,
    effect_semantics: 'effect_receipt_v1',
    extensions: {}
  };
}

function effectReceipt(
  ids: ReturnType<typeof campaignIds>,
  stage: EffectReceiptStage
): EffectReceipt {
  const digest = ({ accepted: 'a', completed: 'b', state_observed: 'c' } as const)[stage];
  return {
    receipt_id: `receipt-${stage}-${ids.runId}`,
    tenant_id: ids.tenantA,
    effect_id: platformBillingEffectId(billableSource(ids)),
    event_id: `event-${ids.runId}`,
    correlation_id: `correlation-${ids.runId}`,
    stage,
    generation: 1,
    writer_id: `writer-${ids.runId}`,
    owner_epoch: 1,
    receipt_digest: digest.repeat(64),
    observed_at: campaignTimestamp()
  };
}

function usageEntry(
  ids: ReturnType<typeof campaignIds>,
  overrides: Partial<UsageEntry> = {}
): UsageEntry {
  return {
    entry_id: `usage-${ids.runId}`,
    tenant_id: ids.tenantA,
    billing_key: platformBillingKey(billableSource(ids)),
    entry_kind: 'usage',
    unit: 'seconds',
    quantity: 1,
    receipt_id: `receipt-completed-${ids.runId}`,
    receipt_digest: 'b'.repeat(64),
    writer_id: `rating-${ids.runId}`,
    writer_epoch: 6,
    occurred_at: campaignTimestamp(),
    reverses_entry_id: null,
    ...overrides
  };
}

function billableSource(ids: ReturnType<typeof campaignIds>): AiRunUsage {
  return {
    kind: 'ai_run',
    tenant_id: ids.tenantA,
    agent_run_id: `agent-${ids.runId}`,
    generation: 1
  };
}

function campaignTimestamp(): string {
  return requiredTimestampEnv('CONVERACT_G02_STARTED_AT');
}

async function rejectsCode(action: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return String((error as { code?: unknown }).code || (error as Error).message) === code;
  }
}

async function rejectsPgCode(action: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return String((error as { code?: unknown }).code || '') === code;
  }
}

function check(id: string, passed: boolean) {
  return { id, passed };
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('database_report_invalid');
  return value as JsonRecord;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function finiteBounded(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function token(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function canonicalTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function dockerTimestamp(value: unknown): boolean {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function requiredArgs(args: string[], count: number, resolvePaths = true): string[] {
  if (args.length !== count || args.some((value) => !value.trim())) {
    throw new Error('database_probe_arguments_invalid');
  }
  return resolvePaths ? args.map((value) => resolve(value)) : args;
}

function requiredEnv(name: string, pattern: RegExp): string {
  const value = String(process.env[name] || '').trim();
  if (!pattern.test(value)) throw new Error(`${name.toLowerCase()}_invalid`);
  return value;
}

function requiredTextEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (value.length < 1 || value.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name.toLowerCase()}_invalid`);
  }
  return value;
}

function requiredTimestampEnv(name: string): string {
  const value = String(process.env[name] || '').trim();
  if (!canonicalTimestamp(value)) throw new Error(`${name.toLowerCase()}_invalid`);
  return value;
}

function readJson(path: string): JsonRecord {
  return record(JSON.parse(readFileSync(resolve(path), 'utf8')) as unknown);
}

function writeJson(pathInput: string, value: unknown): void {
  const path = resolve(pathInput);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing to remove */ }
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: String((error as { code?: unknown }).code || (error as Error).message || 'database_probe_failed')
        .replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 160)
    })}\n`);
    process.exitCode = 1;
  });
}
