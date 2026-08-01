import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createConveractFabricBackupManifest,
  postgresClientEnvironment,
  requiredRestoreConfirmation,
  sha256,
  validateConveractFabricBackupSet
} from '../src/agent-runtime/converact/operations/backup.js';

test('backup manifest validates database and object inventory checksums', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'database.dump'), 'database-bytes');
  mkdirSync(join(directory, 'objects'));
  const objectBytes = 'a';
  const objectFile = `objects/${sha256('object-a')}.bin`;
  writeFileSync(join(directory, objectFile), objectBytes);
  writeFileSync(join(directory, 'objects.jsonl'), `${JSON.stringify({
    key: 'tenant-a/file-a', backup_file: objectFile,
    sha256: sha256(objectBytes), size_bytes: 1, etag: 'etag-a'
  })}\n`);
  const manifest = await createConveractFabricBackupManifest({
    directory, backup_id: 'backup-a', created_at: '2026-07-15T08:00:00.000Z',
    source_commit: 'a'.repeat(40), database_file: 'database.dump',
    object_manifest_file: 'objects.jsonl', object_count: 1
  });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(directory, 'manifest.json'), bytes);
  writeFileSync(join(directory, 'manifest.sha256'), `${sha256(bytes)}\n`);
  assert.deepEqual(await validateConveractFabricBackupSet({ directory }), manifest);

  writeFileSync(join(directory, 'database.dump'), 'tampered');
  await assert.rejects(
    () => validateConveractFabricBackupSet({ directory }),
    (error: unknown) => (error as { code?: string }).code === 'artifact_checksum_mismatch'
  );
});

test('backup database credentials stay in child environment and restore requires scoped confirmation', () => {
  const env = postgresClientEnvironment({ PATH: '/bin' }, 'postgresql://user:p%40ss@db:5433/ivekit?sslmode=require');
  assert.deepEqual({
    PGHOST: env.PGHOST, PGPORT: env.PGPORT, PGDATABASE: env.PGDATABASE,
    PGUSER: env.PGUSER, PGPASSWORD: env.PGPASSWORD, PGSSLMODE: env.PGSSLMODE
  }, {
    PGHOST: 'db', PGPORT: '5433', PGDATABASE: 'ivekit',
    PGUSER: 'user', PGPASSWORD: 'p@ss', PGSSLMODE: 'require'
  });
  assert.equal('DATABASE_URL' in env, false);
  assert.throws(() => requiredRestoreConfirmation('backup-a', 'yes'));
  assert.doesNotThrow(() => requiredRestoreConfirmation('backup-a', 'RESTORE:backup-a'));
});
