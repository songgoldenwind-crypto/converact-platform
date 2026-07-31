import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  runIveKitBackup,
  runIveKitRestore,
  type IveKitProcessRunner
} from '../src/agent-runtime/converact/operations/backup-runner.js';
import { validateIveKitBackupSet } from '../src/agent-runtime/converact/operations/backup.js';

test('backup runner creates a validated database and streamed object backup set', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-backup-runner-'));
  const output = join(root, 'backup-a');
  t.after(() => rm(root, { recursive: true, force: true }));
  const invocations: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: IveKitProcessRunner = async (executable, args, options) => {
    invocations.push({ executable, args, env: options.env });
    const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);
    assert.ok(file);
    writeFileSync(file, 'database-dump');
    return { stdout: '', stderr: '' };
  };
  const result = await runIveKitBackup({
    directory: output,
    backup_id: 'backup-a',
    created_at: '2026-07-15T09:00:00.000Z',
    source_commit: 'a'.repeat(40),
    env: { PATH: '/bin', DATABASE_URL: 'postgresql://user:secret@db/ivekit' },
    processRunner: runner,
    objectSource: {
      async *list() {
        yield {
          key: 'tenant-a/attachments/file-a', etag: 'etag-a', body: Readable.from('object-a')
        };
        yield {
          key: 'tenant-a/recordings/file-b', etag: 'etag-b', body: Readable.from('object-b')
        };
      }
    }
  });
  assert.equal(result.manifest.objects.object_count, 2);
  assert.equal((await validateIveKitBackupSet({ directory: output })).backup_id, 'backup-a');
  assert.equal(JSON.parse(readFileSync(join(output, '.ivekit-backup'), 'utf8')).status, 'complete');
  assert.equal(invocations[0]?.args.some((arg) => arg.includes('secret')), false);
  assert.equal(invocations[0]?.env.PGPASSWORD, 'secret');
});

test('failed backup remains explicitly partial and is never accepted as complete', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-backup-partial-'));
  const output = join(root, 'backup-a');
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => runIveKitBackup({
    directory: output,
    backup_id: 'backup-a',
    env: { PGHOST: 'db', PGDATABASE: 'ivekit', PGUSER: 'user' },
    processRunner: async () => {
      throw Object.assign(new Error('failed'), { code: 'pg_dump_failed' });
    },
    objectSource: { async *list() {} }
  }));
  assert.equal(JSON.parse(readFileSync(join(output, '.ivekit-backup'), 'utf8')).status, 'partial');
  await assert.rejects(() => validateIveKitBackupSet({ directory: output }));
});

test('restore defaults to checksum-only validation and executes guarded database and object restore', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-restore-runner-'));
  const backup = join(root, 'backup-a');
  t.after(() => rm(root, { recursive: true, force: true }));
  const dumpRunner: IveKitProcessRunner = async (_executable, args) => {
    const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);
    assert.ok(file);
    writeFileSync(file, 'database-dump');
    return { stdout: '', stderr: '' };
  };
  await runIveKitBackup({
    directory: backup,
    backup_id: 'backup-a',
    env: { PGHOST: 'db', PGDATABASE: 'ivekit', PGUSER: 'user' },
    processRunner: dumpRunner,
    objectSource: {
      async *list() {
        yield { key: 'tenant-a/file-a', etag: '', body: Readable.from('object-a') };
      }
    }
  });

  let processCalls = 0;
  const dryRun = await runIveKitRestore({
    directory: backup,
    processRunner: async () => {
      processCalls += 1;
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(dryRun.status, 'validated');
  assert.equal(processCalls, 0);

  const commands: string[] = [];
  const restored: string[] = [];
  const result = await runIveKitRestore({
    directory: backup,
    execute: true,
    env: {
      PGHOST: 'db', PGDATABASE: 'ivekit', PGUSER: 'user',
      IVEKIT_RESTORE_CONFIRM: 'RESTORE:backup-a',
      IVEKIT_RESTORE_TARGET_EMPTY: '1'
    },
    processRunner: async (executable, args) => {
      commands.push(executable);
      if (executable === 'psql' && commands.filter((item) => item === 'psql').length === 1) {
        return { stdout: '0\n', stderr: '' };
      }
      if (executable === 'psql') return { stdout: '0|0\n', stderr: '' };
      assert.equal(args.some((arg) => arg.includes('postgresql://')), false);
      return { stdout: '', stderr: '' };
    },
    objectTarget: {
      async put(entry, sourcePath) {
        assert.equal(readFileSync(sourcePath, 'utf8'), 'object-a');
        restored.push(entry.key);
      }
    }
  });
  assert.deepEqual(commands, ['psql', 'pg_restore', 'psql']);
  assert.deepEqual(restored, ['tenant-a/file-a']);
  assert.deepEqual(result, {
    status: 'restored', backup_id: 'backup-a', object_count: 1,
    database_restored: true, database_count: 1, databases_restored: 1,
    objects_restored: 1
  });
});

test('backup and restore keep iveKit, Tinode and RustPBX databases isolated', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-dependent-databases-'));
  const backup = join(root, 'backup-a');
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupDatabases: string[] = [];
  const backupResult = await runIveKitBackup({
    directory: backup,
    backup_id: 'backup-a',
    env: {
      PGHOST: 'db', PGDATABASE: 'ivekit', PGUSER: 'ivekit-admin',
      CONVERACT_FABRIC_TINODE_ADMIN_DATABASE_URL: 'postgresql://tinode-admin:one@db/tinode',
      CONVERACT_FABRIC_RUSTPBX_ADMIN_DATABASE_URL: 'postgresql://voice-admin:two@db/rustpbx'
    },
    processRunner: async (_executable, args, options) => {
      backupDatabases.push(String(options.env.PGDATABASE));
      const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);
      assert.ok(file);
      writeFileSync(file, `dump-${options.env.PGDATABASE}`);
      return { stdout: '', stderr: '' };
    },
    objectSource: { async *list() {} }
  });
  assert.deepEqual(backupDatabases, ['ivekit', 'tinode', 'rustpbx']);
  assert.deepEqual(
    backupResult.manifest.dependent_databases.map((database) => database.name),
    ['tinode', 'rustpbx']
  );

  const operations: Array<{ executable: string; database: string }> = [];
  const restored = await runIveKitRestore({
    directory: backup,
    execute: true,
    env: {
      PGHOST: 'restore-db', PGDATABASE: 'ivekit-new', PGUSER: 'ivekit-admin',
      CONVERACT_FABRIC_TINODE_ADMIN_DATABASE_URL: 'postgresql://tinode-admin:one@restore-db/tinode-new',
      CONVERACT_FABRIC_RUSTPBX_ADMIN_DATABASE_URL: 'postgresql://voice-admin:two@restore-db/rustpbx-new',
      IVEKIT_RESTORE_CONFIRM: 'RESTORE:backup-a', IVEKIT_RESTORE_TARGET_EMPTY: '1'
    },
    processRunner: async (executable, args, options) => {
      operations.push({ executable, database: String(options.env.PGDATABASE) });
      const sql = args[args.indexOf('-c') + 1] || '';
      if (executable === 'psql' && sql.includes('expected_migration')) {
        return { stdout: '0|0\n', stderr: '' };
      }
      if (executable === 'psql' && operations.some((operation) => operation.executable === 'pg_restore')) {
        return { stdout: '12\n', stderr: '' };
      }
      return { stdout: executable === 'psql' ? '0\n' : '', stderr: '' };
    }
  });
  assert.deepEqual(operations.slice(0, 3), [
    { executable: 'psql', database: 'ivekit-new' },
    { executable: 'psql', database: 'tinode-new' },
    { executable: 'psql', database: 'rustpbx-new' }
  ]);
  assert.equal(operations.slice(0, 3).some((operation) => operation.executable === 'pg_restore'), false);
  assert.equal(restored.database_count, 3);
  assert.equal(restored.databases_restored, 3);
});

test('restore refuses a non-empty database before pg_restore', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-restore-nonempty-'));
  const backup = join(root, 'backup-a');
  t.after(() => rm(root, { recursive: true, force: true }));
  await runIveKitBackup({
    directory: backup,
    backup_id: 'backup-a',
    env: { PGHOST: 'db', PGDATABASE: 'ivekit', PGUSER: 'user' },
    processRunner: async (_executable, args) => {
      const file = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length);
      if (file) writeFileSync(file, 'database-dump');
      return { stdout: '', stderr: '' };
    },
    objectSource: { async *list() {} }
  });
  let calls = 0;
  await assert.rejects(() => runIveKitRestore({
    directory: backup,
    execute: true,
    env: {
      PGHOST: 'db', PGDATABASE: 'ivekit', PGUSER: 'user',
      IVEKIT_RESTORE_CONFIRM: 'RESTORE:backup-a', IVEKIT_RESTORE_TARGET_EMPTY: '1'
    },
    processRunner: async () => {
      calls += 1;
      return { stdout: '3\n', stderr: '' };
    }
  }), (error: unknown) => (error as { code?: string }).code === 'restore_target_not_empty');
  assert.equal(calls, 1);
});
