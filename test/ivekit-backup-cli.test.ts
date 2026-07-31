import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { parseIveKitBackupCli } from '../src/converact-backup.js';
import { parseIveKitRestoreCli } from '../src/converact-restore.js';

test('backup CLI creates a unique backup directory under an explicit root', () => {
  const options = parseIveKitBackupCli(
    [],
    { CONVERACT_FABRIC_BACKUP_ROOT: './backups' },
    new Date('2026-07-15T10:11:12.000Z')
  );
  assert.match(options.backup_id, /^ivekit-20260715-101112000Z-[0-9a-f-]{36}$/);
  assert.equal(options.output_directory, resolve('./backups', options.backup_id));
});

test('backup CLI accepts an exact output and rejects unknown arguments', () => {
  assert.deepEqual(
    parseIveKitBackupCli(['--output', './backup-a', '--backup-id', 'backup-a'], {}),
    { backup_id: 'backup-a', output_directory: resolve('./backup-a') }
  );
  assert.throws(() => parseIveKitBackupCli(['--force'], {}));
  assert.throws(() => parseIveKitBackupCli([], {}));
});

test('restore CLI is dry-run by default and execution is explicit', () => {
  assert.deepEqual(parseIveKitRestoreCli(['--backup', './backup-a']), {
    backup_directory: resolve('./backup-a'), execute: false
  });
  assert.deepEqual(parseIveKitRestoreCli(['--execute', '--backup', './backup-a']), {
    backup_directory: resolve('./backup-a'), execute: true
  });
  assert.throws(() => parseIveKitRestoreCli(['--execute']));
});
