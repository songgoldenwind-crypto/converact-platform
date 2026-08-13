import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

import { Pool } from 'pg';

import { initializeConveractFabricRuntimeRole } from '../../../../src/converact-runtime-role.js';
import { withPgTenant } from '../../../../src/db-pg-tenant.js';
import {
  runConveractFabricBackup,
  runConveractFabricRestore,
  type ConveractFabricProcessRunner
} from '../../../../src/agent-runtime/converact/operations/backup-runner.js';
import { validateConveractFabricBackupSet } from
  '../../../../src/agent-runtime/converact/operations/backup.js';
import { buildBackupRestoreEvidence } from './campaign-evidence.mjs';

type JsonRecord = Record<string, any>;

const EXPECTED_MIGRATION = '116_converact_sip_capability_recovery_fence';
const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2);
  if (['backup', 'empty', 'restore', 'orchestrate'].includes(String(mode))) {
    requiredEnv('CONVERACT_G02_RESTORE_CONFIRM', /^G02_PLATFORM_RESTORE_EVIDENCE$/u);
  }
  if (mode === 'backup') {
    const [container, directory, output] = requiredArgs(args, 3, false);
    return runBackup(container!, directory!, output!);
  }
  if (mode === 'empty') {
    const [container, output] = requiredArgs(args, 2, false);
    return runEmpty(container!, output!);
  }
  if (mode === 'restore') {
    const [container, directory, output] = requiredArgs(args, 3, false);
    return runRestore(container!, directory!, output!);
  }
  if (mode === 'orchestrate') {
    const [container, directory, backup, empty, restored, verified] = requiredArgs(args, 6, false);
    return runOrchestratedRestore(
      container!, directory!, backup!, empty!, restored!, verified!
    );
  }
  if (mode === 'verify') {
    const [backup, empty, restored, output] = requiredArgs(args, 4, false);
    return runVerify(backup!, empty!, restored!, output!);
  }
  if (mode === 'cleanup') {
    const [verified, before, after, remaining, output] = requiredArgs(args, 5, false);
    return writeCleanupResult(verified!, before!, after!, remaining!, output!);
  }
  if (mode === 'finalize') {
    const [identity, backup, restored, output] = requiredArgs(args, 4);
    const result = buildBackupRestoreEvidence({
      identity: readJson(identity!),
      backup: readJson(backup!),
      restore: readJson(restored!)
    });
    writeJson(output!, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'verified_controlled') process.exitCode = 1;
    return;
  }
  throw operationError('restore_probe_mode_invalid');
}

async function runBackup(containerInput: string, directoryInput: string, output: string): Promise<void> {
  const container = containerId(containerInput);
  const directory = resolve(directoryInput);
  const object = createSourceObject();
  await assertValidationContainer(container, 'source');
  const admin = databasePool('admin');
  const startedAt = new Date().toISOString();
  let checkpoint;
  try {
    checkpoint = await databaseCheckpoint(admin);
  } finally {
    await admin.end();
  }
  const result = await runConveractFabricBackup({
    directory,
    backup_id: `restore-${runId()}`,
    env: process.env,
    source_commit: requiredEnv('CONVERACT_G02_SOURCE_COMMIT', /^[a-f0-9]{40}$/u),
    processRunner: dockerPostgresRunner(container)
  });
  const completedAt = new Date().toISOString();
  const artifactSha256 = readFileSync(join(directory, 'manifest.sha256'), 'utf8').trim();
  if (!sha256Digest(artifactSha256) || result.manifest.objects.object_count !== 1) {
    throw operationError('restore_backup_manifest_invalid');
  }
  writeJson(output, {
    status: 'passed',
    process_pid: process.pid,
    source_database_id: container,
    backup_id: result.manifest.backup_id,
    artifact_sha256: artifactSha256,
    checkpoint_records: checkpoint.records,
    checkpoint_digest: checkpoint.digest,
    object_count: 1,
    object_digest: object.digest,
    backup_started_at: startedAt,
    backup_completed_at: completedAt
  });
}

async function runEmpty(containerInput: string, output: string): Promise<void> {
  const container = containerId(containerInput);
  await assertValidationContainer(container, 'target');
  const admin = databasePool('admin');
  try {
    const result = await admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
    );
    const tableCount = Number(result.rows[0]?.count || -1);
    if (tableCount !== 0) throw operationError('restore_target_not_empty');
    writeJson(output, {
      status: 'passed',
      process_pid: process.pid,
      target_database_id: container,
      target_was_empty: true,
      public_table_count: tableCount
    });
  } finally {
    await admin.end();
  }
}

async function runRestore(containerInput: string, directoryInput: string, output: string): Promise<void> {
  const container = containerId(containerInput);
  const directory = resolve(directoryInput);
  await assertValidationContainer(container, 'target');
  const manifest = await validateConveractFabricBackupSet({ directory });
  const result = await runConveractFabricRestore({
    directory,
    execute: true,
    env: {
      ...process.env,
      CONVERACT_FABRIC_RESTORE_CONFIRM: `RESTORE:${manifest.backup_id}`,
      CONVERACT_FABRIC_RESTORE_TARGET_EMPTY: '1'
    },
    processRunner: dockerPostgresRunner(container)
  });
  if (result.status !== 'restored' || result.database_restored !== true
    || result.objects_restored !== manifest.objects.object_count) {
    throw operationError('restore_execution_incomplete');
  }
  writeJson(output, {
    status: 'passed',
    process_pid: process.pid,
    target_database_id: container,
    backup_id: result.backup_id,
    database_count: result.database_count,
    databases_restored: result.databases_restored,
    objects_restored: result.objects_restored
  });
}

async function runOrchestratedRestore(
  containerInput: string,
  directoryInput: string,
  backupPath: string,
  emptyPath: string,
  restoredPath: string,
  verifiedPath: string
): Promise<void> {
  const monotonicStarted = performance.now();
  await runRestore(containerInput, directoryInput, restoredPath);
  await initializeRuntimeRole();
  await execFileAsync(process.execPath, [
    '--import', 'tsx', import.meta.filename,
    'verify', backupPath, emptyPath, restoredPath, verifiedPath
  ], {
    env: process.env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024
  });
  const measuredRtoMs = Math.max(1, Math.ceil(performance.now() - monotonicStarted));
  const verified = readJson(verifiedPath);
  if (verified.status !== 'passed') throw operationError('restore_fresh_process_verification_failed');
  replaceJson(verifiedPath, {
    ...verified,
    measured_rto_ms: measuredRtoMs,
    rto_clock_domain: 'monotonic',
    rto_measurement_scope: 'restore_runtime_role_fresh_process_verify'
  });
}

async function initializeRuntimeRole(): Promise<void> {
  const admin = databasePool('admin');
  try {
    await initializeConveractFabricRuntimeRole(
      admin,
      requiredTextEnv('CONVERACT_RUNTIME_DB_PASSWORD')
    );
  } finally {
    await admin.end();
  }
}

async function runVerify(
  backupPath: string,
  emptyPath: string,
  restoredPath: string,
  output: string
): Promise<void> {
  const backup = readJson(backupPath);
  const empty = readJson(emptyPath);
  const restored = readJson(restoredPath);
  const admin = databasePool('admin');
  const runtime = databasePool('runtime');
  try {
    const checkpoint = await databaseCheckpoint(admin);
    const ids = campaignIds();
    const migration = await admin.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    const noContext = await runtime.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM converact_platform_inbox'
    );
    const tenantAVisible = await withPgTenant(runtime, ids.tenantA, async (pg) => {
      const value = await pg.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tenants WHERE id = $1', [ids.tenantA]
      );
      return Number(value.rows[0]?.count || 0);
    });
    const tenantBVisibleFromA = await withPgTenant(runtime, ids.tenantA, async (pg) => {
      const value = await pg.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM tenants WHERE id = $1', [ids.tenantB]
      );
      return Number(value.rows[0]?.count || 0);
    });
    const appendOnly = await rejectsPgCode(
      () => withPgTenant(runtime, ids.tenantA, (pg) => pg.query(
        `UPDATE converact_platform_usage_entries
         SET quantity = quantity + 1
         WHERE tenant_id = $1 AND entry_id = $2`,
        [ids.tenantA, `usage-${ids.runId}`]
      )),
      '55000'
    );
    const object = restoredObject();
    const exactDatabase = checkpoint.records === backup.checkpoint_records
      && checkpoint.digest === backup.checkpoint_digest;
    const exactObject = restored.objects_restored === backup.object_count
      && object.digest === backup.object_digest;
    const rls = Number(noContext.rows[0]?.count || 0) === 0
      && tenantAVisible === 1 && tenantBVisibleFromA === 0;
    const migrationHead = String(migration.rows[0]?.version || '');
    const valid = backup.status === 'passed'
      && empty.status === 'passed'
      && restored.status === 'passed'
      && typeof backup.backup_id === 'string'
      && restored.backup_id === backup.backup_id
      && Number.isSafeInteger(restored.process_pid)
      && restored.process_pid > 0
      && restored.process_pid !== process.pid
      && backup.source_database_id !== empty.target_database_id
      && restored.target_database_id === empty.target_database_id
      && backup.process_pid !== process.pid
      && empty.target_was_empty === true
      && migrationHead === EXPECTED_MIGRATION
      && exactDatabase && exactObject && rls && appendOnly;
    if (!valid) throw operationError('restore_verification_failed');
    writeJson(output, {
      status: 'passed',
      target_database_id: empty.target_database_id,
      backup_id: backup.backup_id,
      target_was_empty: true,
      restore_process_pid: restored.process_pid,
      fresh_process_pid: process.pid,
      migration_head: migrationHead,
      restored_records: checkpoint.records,
      restored_digest: checkpoint.digest,
      restored_object_count: restored.objects_restored,
      restored_object_digest: object.digest,
      measured_rpo_ms: 0,
      runtime_rls_verified: true,
      append_only_verified: true
    });
  } finally {
    await Promise.allSettled([admin.end(), runtime.end()]);
  }
}

function writeCleanupResult(
  verifiedPath: string,
  beforePath: string,
  afterPath: string,
  remainingInput: string,
  output: string
): void {
  const verified = readJson(verifiedPath);
  const remaining = Number(remainingInput);
  const unchanged = readFileSync(resolve(beforePath), 'utf8')
    === readFileSync(resolve(afterPath), 'utf8');
  const valid = verified.status === 'passed'
    && Number.isSafeInteger(remaining) && remaining === 0 && unchanged;
  writeJson(output, {
    ...verified,
    status: valid ? 'passed' : 'failed',
    unrelated_containers_unchanged: unchanged,
    validation_resources_remaining: remaining
  });
  if (!valid) throw operationError('restore_cleanup_verification_failed');
}

async function databaseCheckpoint(pool: Pool): Promise<{ records: number; digest: string }> {
  const ids = campaignIds();
  const [tenants, inbox, receipts, usage] = await Promise.all([
    pool.query(
      `SELECT id, name, status, plan_code, settings::text AS settings
       FROM tenants WHERE id = ANY($1::text[]) ORDER BY id`,
      [[ids.tenantA, ids.tenantB]]
    ),
    pool.query(
      `SELECT tenant_id, consumer_id, event_id, payload_digest, aggregate_revision, ordering_key
       FROM converact_platform_inbox WHERE tenant_id = $1 ORDER BY event_id`,
      [ids.tenantA]
    ),
    pool.query(
      `SELECT tenant_id, receipt_id, effect_id, stage, generation, writer_id, owner_epoch,
              receipt_digest
       FROM converact_platform_effect_receipts WHERE tenant_id = $1 ORDER BY receipt_id`,
      [ids.tenantA]
    ),
    pool.query(
      `SELECT tenant_id, entry_id, billing_key, entry_kind, unit, quantity::text AS quantity,
              receipt_id, receipt_digest, writer_id, writer_epoch
       FROM converact_platform_usage_entries WHERE tenant_id = $1 ORDER BY entry_id`,
      [ids.tenantA]
    )
  ]);
  const records = tenants.rows.length + inbox.rows.length + receipts.rows.length + usage.rows.length;
  if (tenants.rows.length !== 2 || inbox.rows.length !== 1
    || receipts.rows.length !== 2 || usage.rows.length !== 1) {
    throw operationError('restore_checkpoint_incomplete');
  }
  return {
    records,
    digest: sha256(JSON.stringify({
      tenants: tenants.rows,
      inbox: inbox.rows,
      receipts: receipts.rows,
      usage: usage.rows
    }))
  };
}

function createSourceObject(): { digest: string } {
  const root = resolve(requiredTextEnv('CONVERACT_UPLOAD_DIR'));
  const path = join(root, campaignIds().tenantA, 'restore-proof.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`${JSON.stringify({ run_id: runId(), kind: 'restore-proof' })}\n`);
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { digest: sha256(bytes) };
}

function restoredObject(): { digest: string } {
  const root = resolve(requiredTextEnv('CONVERACT_UPLOAD_DIR'));
  const path = join(root, campaignIds().tenantA, 'restore-proof.json');
  return { digest: sha256(readFileSync(path)) };
}

function dockerPostgresRunner(container: string): ConveractFabricProcessRunner {
  return async (executable, args, options) => {
    const command = basename(executable);
    if (!['pg_dump', 'pg_restore', 'psql'].includes(command)) {
      throw operationError('restore_postgres_command_invalid');
    }
    const connection = postgresConnectionArgs(options.env);
    const childEnv = { ...process.env, PGPASSWORD: requiredText(options.env.PGPASSWORD) };
    try {
      if (command === 'pg_dump') {
        const file = args.find((value) => value.startsWith('--file='))?.slice('--file='.length);
        if (!file) throw operationError('restore_dump_path_missing');
        const containerFile = '/tmp/converact-g02-backup.dump';
        const translated = args
          .filter((value) => !value.startsWith('--file='))
          .concat(`--file=${containerFile}`);
        const result = await execDocker(
          ['exec', '--env', 'PGPASSWORD', container, command, ...connection, ...translated],
          childEnv
        );
        await execDocker(['cp', `${container}:${containerFile}`, resolve(file)], childEnv);
        return result;
      }
      if (command === 'pg_restore') {
        const source = args.at(-1);
        if (!source) throw operationError('restore_archive_path_missing');
        const containerFile = '/tmp/converact-g02-restore.dump';
        await execDocker(['cp', resolve(source), `${container}:${containerFile}`], childEnv);
        return execDocker(
          ['exec', '--env', 'PGPASSWORD', container, command, ...connection,
            ...args.slice(0, -1), containerFile],
          childEnv
        );
      }
      return execDocker(
        ['exec', '--env', 'PGPASSWORD', container, command, ...connection, ...args],
        childEnv
      );
    } catch (error) {
      if (String((error as { code?: unknown }).code || '').startsWith('restore_')) throw error;
      throw operationError('restore_postgres_command_failed');
    }
  };
}

async function assertValidationContainer(container: string, role: 'source' | 'target'): Promise<void> {
  let result;
  try {
    result = await execDocker([
      'inspect', '--format', '{{index .Config.Labels "com.docker.compose.project"}}', container
    ], process.env);
  } catch {
    throw operationError('restore_validation_container_unavailable');
  }
  if (result.stdout.trim() !== `converact-g02-${runId()}-${role}`) {
    throw operationError('restore_validation_container_scope_invalid');
  }
}

async function execDocker(args: string[], env: NodeJS.ProcessEnv): Promise<{
  stdout: string;
  stderr: string;
}> {
  const result = await execFileAsync('docker', args, {
    env,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024
  });
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function postgresConnectionArgs(env: NodeJS.ProcessEnv): string[] {
  const user = requiredToken(env.PGUSER);
  const database = requiredToken(env.PGDATABASE);
  return ['--host=127.0.0.1', '--port=5432', `--username=${user}`, `--dbname=${database}`];
}

function databasePool(kind: 'admin' | 'runtime'): Pool {
  const port = Number(requiredEnv('PGPORT', /^\d{1,5}$/u));
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw operationError('restore_database_port_invalid');
  }
  return new Pool({
    host: requiredEnv('PGHOST', /^[A-Za-z0-9.:_-]{1,255}$/u),
    port,
    database: requiredEnv('PGDATABASE', /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u),
    user: kind === 'admin' ? 'opc_admin' : 'opc_runtime',
    password: kind === 'admin' ? requiredTextEnv('PGPASSWORD')
      : requiredTextEnv('CONVERACT_RUNTIME_DB_PASSWORD'),
    max: 2,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 1_000,
    application_name: `converact-g02-restore-${kind}`
  });
}

function campaignIds() {
  const currentRun = runId();
  return {
    runId: currentRun,
    tenantA: `g02-a-${currentRun}`,
    tenantB: `g02-b-${currentRun}`
  };
}

function runId(): string {
  return requiredEnv('CONVERACT_G02_FAULT_RUN_ID', /^[a-z0-9][a-z0-9-]{0,39}$/u);
}

async function rejectsPgCode(action: () => Promise<unknown>, code: string): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    return String((error as { code?: unknown }).code || '') === code;
  }
}

function requiredArgs(args: string[], count: number, resolvePaths = true): string[] {
  if (args.length !== count || args.some((value) => !value.trim())) {
    throw operationError('restore_probe_arguments_invalid');
  }
  return resolvePaths ? args.map((value) => resolve(value)) : args;
}

function readJson(path: string): JsonRecord {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw operationError('restore_json_invalid');
  }
  return value;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx', mode: 0o600
  });
}

function replaceJson(path: string, value: unknown): void {
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'w', mode: 0o600
  });
}

function containerId(value: string): string {
  if (!/^[a-f0-9]{12,64}$/u.test(value)) throw operationError('restore_container_id_invalid');
  return value;
}

function requiredEnv(name: string, pattern: RegExp): string {
  const value = String(process.env[name] || '').trim();
  if (!pattern.test(value)) throw operationError(`${name.toLowerCase()}_invalid`);
  return value;
}

function requiredTextEnv(name: string): string {
  const value = String(process.env[name] || '');
  if (value.length < 1 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw operationError(`${name.toLowerCase()}_invalid`);
  }
  return value;
}

function requiredText(value: string | undefined): string {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw operationError('restore_process_environment_invalid');
  }
  return value;
}

function requiredToken(value: string | undefined): string {
  if (!value || !/^[A-Za-z_][A-Za-z0-9_-]{0,62}$/u.test(value)) {
    throw operationError('restore_database_identity_invalid');
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function operationError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

if (resolve(process.argv[1] || '') === resolve(import.meta.filename)) {
  main().catch((error) => {
    const code = String((error as { code?: unknown }).code || 'restore_probe_failed');
    process.stderr.write(`${/^[a-z0-9_]{1,100}$/u.test(code) ? code : 'restore_probe_failed'}\n`);
    process.exitCode = 1;
  });
}
