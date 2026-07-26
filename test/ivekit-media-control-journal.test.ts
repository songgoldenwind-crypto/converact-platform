import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  closeMediaCommandJournalResources,
  MediaCommandJournal,
  MediaCommandJournalError,
  type MediaCommandJournalRecord
} from '../src/agent-runtime/ivekit/media-control/journal.js';

describe('checksummed media command journal', () => {
  it('appends, replays and survives process-style reopen', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      const first = record({ command_id: 'command-1', command_sequence: 1 });
      const second = record({
        command_id: 'command-2',
        command_sequence: 2,
        effective_sdp: 'v=0\r\nm=audio 23000 RTP/AVP 0\r\n'
      });
      await journal.append(first);
      await journal.append(second);
      assert.deepEqual(await journal.replay(), [first, second]);
      await journal.close();

      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), [first, second]);
      await reopened.close();
    });
  });

  it('replays identity-aware records while preserving legacy WAL compatibility', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      const legacy = record({ command_id: 'legacy-command' });
      const identityAware = {
        ...record({
          command_id: 'identity-command',
          command_sequence: 2
        }),
        tenant_id: 'tenant-a',
        leg_id: 'leg-a',
        cell_id: 'cell-a',
        owner_node_id: 'node-a',
        expires_at: '2026-07-26T08:05:00.000Z'
      } as MediaCommandJournalRecord;
      await journal.append(legacy);
      await journal.append(identityAware);
      await journal.close();

      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), [legacy, identityAware]);
      await reopened.close();
    });
  });

  it('serializes concurrent appends without interleaving records', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({
        path: journalPath,
        maxRecords: 128
      });
      const records = Array.from({ length: 64 }, (_, index) => record({
        command_id: `concurrent-${index + 1}`,
        command_sequence: index + 1
      }));
      await Promise.all(records.map((item) => journal.append(item)));
      assert.deepEqual(await journal.replay(), records);
      await journal.close();

      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), records);
      await reopened.close();
    });
  });

  it('holds an exclusive writer lease until close', async () => {
    await withJournalPath(async (journalPath) => {
      const first = await MediaCommandJournal.open({ path: journalPath });
      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'journal_locked')
      );
      await first.close();

      const reopened = await MediaCommandJournal.open({ path: journalPath });
      await reopened.close();
    });
  });

  it('holds the writer lease on a protected persistent lock inode', async () => {
    await withJournalPath(async (journalPath) => {
      const lockPath = `${journalPath}.lock`;
      const journal = await MediaCommandJournal.open({ path: journalPath });
      let lockedIdentity: { dev: number; ino: number } | null = null;
      try {
        const locked = await lstat(lockPath);
        assert.equal(locked.isFile(), true);
        assert.equal(locked.nlink, 1);
        assert.equal(locked.mode & 0o777, 0o600);
        lockedIdentity = { dev: locked.dev, ino: locked.ino };
      } finally {
        await journal.close();
      }

      const retained = await lstat(lockPath);
      assert.deepEqual(
        { dev: retained.dev, ino: retained.ino },
        lockedIdentity
      );
    });
  });

  it('releases the writer lease even when WAL close reports an error', async () => {
    let released = false;
    await assert.rejects(
      closeMediaCommandJournalResources(
        async () => {
          throw Object.assign(new Error('injected close failure'), {
            code: 'EIO'
          });
        },
        async () => {
          released = true;
        }
      ),
      { code: 'EIO' }
    );
    assert.equal(released, true);
  });

  it('truncates only an incomplete final record before appending again', async () => {
    await withJournalPath(async (journalPath) => {
      const first = record({ command_id: 'complete-1' });
      const journal = await MediaCommandJournal.open({ path: journalPath });
      await journal.append(first);
      await journal.close();
      const completeBytes = (await lstat(journalPath)).size;

      await appendFile(
        journalPath,
        Buffer.from([0, 0, 0, 80, 1, 2, 3, 4, 5, 6]),
        { mode: 0o600 }
      );
      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), [first]);
      assert.equal((await lstat(journalPath)).size, completeBytes);

      const second = record({
        command_id: 'complete-2',
        command_sequence: 2
      });
      await reopened.append(second);
      await reopened.close();
      const final = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await final.replay(), [first, second]);
      await final.close();
    });
  });

  it('recovers a full final header with a partially written payload', async () => {
    await withJournalPath(async (journalPath) => {
      const first = record({ command_id: 'full-header-1' });
      const journal = await MediaCommandJournal.open({ path: journalPath });
      await journal.append(first);
      await journal.append(record({
        command_id: 'full-header-2',
        command_sequence: 2
      }));
      await journal.close();

      const bytes = await readFile(journalPath);
      await truncate(journalPath, bytes.length - 5);
      const recovered = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await recovered.replay(), [first]);
      await recovered.close();
    });
  });

  it('rejects checksum corruption in a complete record', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      await journal.append(record());
      await journal.close();

      const bytes = await readFile(journalPath);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(journalPath, bytes, { mode: 0o600 });
      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'journal_checksum_mismatch')
      );
    });
  });

  it('rolls back partial writes before accepting later records', async () => {
    await withJournalPath(async (journalPath, directory) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      const probe = await openFile(path.join(directory, 'prototype-probe'), 'w', 0o600);
      const prototype = Object.getPrototypeOf(probe) as {
        write: (...args: unknown[]) => Promise<{ bytesWritten: number }>;
      };
      await probe.close();
      const originalWrite = prototype.write;
      let calls = 0;
      prototype.write = async function (...args: unknown[]) {
        calls += 1;
        if (calls === 1) {
          const [buffer, offset, length, position] = args as [
            Buffer,
            number,
            number,
            number | null
          ];
          return originalWrite.call(
            this,
            buffer,
            offset,
            Math.min(20, length),
            position
          );
        }
        if (calls === 2) {
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return originalWrite.apply(this, args);
      };
      try {
        await assert.rejects(
          journal.append(record({ command_id: 'partial-failure' })),
          (error: unknown) => journalError(error, 'journal_append_failed')
        );
      } finally {
        prototype.write = originalWrite;
      }

      const survived = record({ command_id: 'after-partial-failure' });
      await journal.append(survived);
      await journal.close();
      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), [survived]);
      await reopened.close();
    });
  });

  it('rolls back an append whose durability sync fails', async () => {
    await withJournalPath(async (journalPath, directory) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      const probe = await openFile(path.join(directory, 'sync-probe'), 'w', 0o600);
      const prototype = Object.getPrototypeOf(probe) as {
        sync: () => Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let failed = false;
      prototype.sync = async function () {
        if (!failed) {
          failed = true;
          throw Object.assign(new Error('sync failed'), { code: 'EIO' });
        }
        return originalSync.call(this);
      };
      try {
        await assert.rejects(
          journal.append(record({ command_id: 'sync-failure' })),
          (error: unknown) => journalError(error, 'journal_append_failed')
        );
      } finally {
        prototype.sync = originalSync;
      }

      const survived = record({ command_id: 'after-sync-failure' });
      await journal.append(survived);
      await journal.close();
      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), [survived]);
      await reopened.close();
    });
  });

  it('rejects corruption of the length prefix', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      await journal.append(record());
      await journal.close();

      const bytes = await readFile(journalPath);
      bytes.writeUInt32BE(bytes.readUInt32BE(0) + 1, 0);
      await writeFile(journalPath, bytes, { mode: 0o600 });
      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'journal_record_invalid')
      );
    });
  });

  it('refuses symlinks and existing files that are not mode 0600', async () => {
    await withJournalPath(async (journalPath, directory) => {
      const target = path.join(directory, 'target.wal');
      await writeFile(target, '', { mode: 0o600 });
      await symlink(target, journalPath);
      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'journal_path_unsafe')
      );
    });

    await withJournalPath(async (journalPath) => {
      await writeFile(journalPath, '', { mode: 0o600 });
      await chmod(journalPath, 0o644);
      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'journal_permissions_invalid')
      );
    });

    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      assert.equal((await lstat(journalPath)).mode & 0o777, 0o600);
      await journal.close();
    });

    await withJournalPath(async (journalPath, directory) => {
      const target = path.join(directory, 'hardlink-target.wal');
      await writeFile(target, '', { mode: 0o600 });
      await link(target, journalPath);
      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'journal_path_unsafe')
      );
    });
  });

  it('refuses a symbolic link in the directory chain', async () => {
    await withJournalPath(async (_journalPath, directory) => {
      const realParent = path.join(directory, 'real-parent');
      const aliasParent = path.join(directory, 'alias-parent');
      await mkdir(realParent, { mode: 0o700 });
      await symlink(realParent, aliasParent);
      await assert.rejects(
        MediaCommandJournal.open({
          path: path.join(aliasParent, 'media-command.wal')
        }),
        (error: unknown) => journalError(error, 'journal_path_unsafe')
      );
    });
  });

  it('rejects an insecure writable journal directory', async () => {
    await withJournalPath(async (journalPath, directory) => {
      await chmod(directory, 0o777);
      try {
        await assert.rejects(
          MediaCommandJournal.open({ path: journalPath }),
          (error: unknown) => journalError(error, 'journal_path_unsafe')
        );
      } finally {
        await chmod(directory, 0o700);
      }
    });
  });

  it('atomically compacts only expired terminal sessions', async () => {
    await withJournalPath(async (journalPath, directory) => {
      const journal = await MediaCommandJournal.open({
        path: journalPath,
        terminalRetentionMs: 5_000
      });
      const active = record({
        command_id: 'active',
        media_reservation_id: 'reservation-active'
      });
      const unknown = record({
        command_id: 'unknown',
        media_reservation_id: 'reservation-unknown',
        result_class: 'unknown'
      });
      const oldBeforeTerminal = record({
        command_id: 'old-before-terminal',
        media_reservation_id: 'reservation-old',
        session_state: 'committed'
      });
      const oldTerminal = record({
        command_id: 'old-terminal',
        media_reservation_id: 'reservation-old',
        command_sequence: 2,
        session_state: 'closed',
        terminal_at: '2026-07-25T23:59:40.000Z',
        recorded_at: '2026-07-25T23:59:40.000Z'
      });
      const recentTerminal = record({
        command_id: 'recent-terminal',
        media_reservation_id: 'reservation-recent',
        session_state: 'closed',
        terminal_at: '2026-07-25T23:59:58.000Z',
        recorded_at: '2026-07-25T23:59:58.000Z'
      });
      const protectedUnknown = record({
        command_id: 'protected-unknown',
        media_reservation_id: 'reservation-protected',
        result_class: 'unknown'
      });
      const terminalAfterUnknown = record({
        command_id: 'terminal-after-unknown',
        media_reservation_id: 'reservation-protected',
        command_sequence: 2,
        session_state: 'closed',
        terminal_at: '2026-07-25T23:59:40.000Z',
        recorded_at: '2026-07-25T23:59:40.000Z'
      });
      for (const item of [
        active,
        unknown,
        oldBeforeTerminal,
        oldTerminal,
        recentTerminal,
        protectedUnknown,
        terminalAfterUnknown
      ]) {
        await journal.append(item);
      }
      const inodeBefore = (await lstat(journalPath)).ino;

      const result = await journal.compact(
        new Date('2026-07-26T00:00:00.000Z')
      );
      assert.deepEqual(result, {
        removedRecords: 2,
        retainedRecords: 5
      });
      assert.deepEqual(await journal.replay(), [
        active,
        unknown,
        recentTerminal,
        protectedUnknown,
        terminalAfterUnknown
      ]);
      assert.notEqual((await lstat(journalPath)).ino, inodeBefore);
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name.includes('.tmp')),
        []
      );
      await journal.close();

      const reopened = await MediaCommandJournal.open({ path: journalPath });
      assert.deepEqual(await reopened.replay(), [
        active,
        unknown,
        recentTerminal,
        protectedUnknown,
        terminalAfterUnknown
      ]);
      await reopened.close();
    });
  });

  it('compacts a terminal reservation after the same unknown command resolves', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({
        path: journalPath,
        terminalRetentionMs: 5_000
      });
      const uncertain = record({
        command_id: 'resolved-command',
        media_reservation_id: 'reservation-resolved',
        result_class: 'unknown',
        session_state: null,
        terminal_at: null
      });
      const resolved = record({
        command_id: uncertain.command_id,
        command_hash: uncertain.command_hash,
        media_reservation_id: uncertain.media_reservation_id,
        command_sequence: uncertain.command_sequence,
        session_state: 'closed',
        terminal_at: '2026-07-25T23:59:40.000Z',
        recorded_at: '2026-07-25T23:59:40.000Z'
      });
      await journal.append(uncertain);
      await journal.append(resolved);

      assert.deepEqual(
        await journal.compact(new Date('2026-07-26T00:00:00.000Z')),
        { removedRecords: 2, retainedRecords: 0 }
      );
      assert.deepEqual(await journal.replay(), []);
      await journal.close();
    });
  });

  it('enforces record-count and byte bounds without growing the WAL', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({
        path: journalPath,
        maxRecords: 2,
        maxBytes: 64 * 1024
      });
      await journal.append(record({ command_id: 'bounded-1' }));
      await journal.append(record({
        command_id: 'bounded-2',
        command_sequence: 2
      }));
      const bytesAtCapacity = (await lstat(journalPath)).size;
      await assert.rejects(
        journal.append(record({
          command_id: 'bounded-3',
          command_sequence: 3
        })),
        (error: unknown) => journalError(error, 'journal_capacity_exceeded')
      );
      assert.equal((await lstat(journalPath)).size, bytesAtCapacity);
      assert.equal((await journal.replay()).length, 2);
      await journal.close();
    });

    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({
        path: journalPath,
        maxRecords: 100,
        maxBytes: 1_024
      });
      await assert.rejects(
        journal.append(record({ effective_sdp: 'x'.repeat(2_000) })),
        (error: unknown) => journalError(error, 'journal_capacity_exceeded')
      );
      assert.equal((await lstat(journalPath)).size, 0);
      await journal.close();
    });
  });

  it('refuses startup when existing records exceed configured bounds', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({
        path: journalPath,
        maxRecords: 10
      });
      await journal.append(record({ command_id: 'existing-1' }));
      await journal.append(record({
        command_id: 'existing-2',
        command_sequence: 2
      }));
      await journal.close();

      await assert.rejects(
        MediaCommandJournal.open({ path: journalPath, maxRecords: 1 }),
        (error: unknown) => journalError(error, 'journal_capacity_exceeded')
      );
    });
  });

  it('rejects terminal timestamps without an explicit terminal state', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaCommandJournal.open({ path: journalPath });
      await assert.rejects(
        journal.append(record({
          session_state: null,
          terminal_at: '2026-07-25T23:59:40.000Z'
        })),
        (error: unknown) => journalError(error, 'journal_record_invalid')
      );
      await journal.close();
    });
  });

  it('removes stale compaction files only while holding the writer lease', async () => {
    await withJournalPath(async (journalPath, directory) => {
      const stale = path.join(
        directory,
        '.media-command.wal.1234.aaaaaaaaaaaaaaaa.tmp'
      );
      await writeFile(stale, 'stale', { mode: 0o600 });
      const journal = await MediaCommandJournal.open({ path: journalPath });
      assert.equal((await readdir(directory)).includes(path.basename(stale)), false);
      await journal.close();
    });
  });

  it('releases the kernel writer lock when its process is killed', async () => {
    await withJournalPath(async (journalPath) => {
      const moduleUrl = new URL(
        '../src/agent-runtime/ivekit/media-control/journal.js',
        import.meta.url
      ).href;
      const childCode = [
        `import { MediaCommandJournal } from ${JSON.stringify(moduleUrl)};`,
        `const journal = await MediaCommandJournal.open({ path: ${JSON.stringify(journalPath)} });`,
        "process.stdout.write('ready\\n');",
        'setInterval(() => {}, 1000);'
      ].join('\n');
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv.filter((argument) => !argument.startsWith('--test')),
          '--input-type=module',
          '--eval',
          childCode
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] }
      );
      try {
        const output = await childReady(child);
        assert.equal(String(output), 'ready\n');
        await assert.rejects(
          MediaCommandJournal.open({ path: journalPath }),
          (error: unknown) => journalError(error, 'journal_locked')
        );
        assert.equal(child.kill('SIGKILL'), true);
        await once(child, 'exit');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await once(child, 'exit');
        }
      }
      const journal = await MediaCommandJournal.open({ path: journalPath });
      await journal.close();
    });
  });

  it('rejects a sparse oversized WAL without allocating its file size', async () => {
    await withJournalPath(async (journalPath) => {
      await writeFile(journalPath, '', { mode: 0o600 });
      await truncate(journalPath, 512 * 1024 * 1024);
      const heapBefore = process.memoryUsage().heapUsed;
      await assert.rejects(
        MediaCommandJournal.open({
          path: journalPath,
          maxBytes: 1024 * 1024 * 1024
        }),
        (error: unknown) => journalError(error, 'journal_record_invalid')
      );
      const heapGrowth = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
      assert.ok(heapGrowth < 32 * 1024 * 1024);
    });
  });
});

function record(
  overrides: Partial<MediaCommandJournalRecord> = {}
): MediaCommandJournalRecord {
  const resultClass = overrides.result_class ?? 'succeeded';
  return {
    action: 'offer',
    command_id: 'command-1',
    media_reservation_id: 'reservation-1',
    command_hash: 'a'.repeat(64),
    owner_epoch: '4294967297',
    command_sequence: 1,
    transport_call_id: 'transport-call-1',
    result_class: resultClass,
    error_code: resultClass === 'succeeded'
      ? null
      : overrides.error_code ?? 'rtpengine_test_failure',
    retryable: resultClass === 'succeeded'
      ? null
      : overrides.retryable ?? resultClass === 'unknown',
    effective_sdp: '',
    session_state: 'prepared',
    from_tag: 'from-a',
    to_tag: null,
    recorded_at: '2026-07-26T00:00:00.000Z',
    terminal_at: null,
    ...overrides
  };
}

async function childReady(
  child: ReturnType<typeof spawn>
): Promise<Buffer | string> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(child.stdout!, 'data').then(([output]) => output as Buffer | string),
      once(child, 'exit').then(([code, signal]) => {
        throw new Error(
          `journal lock child exited before ready: code=${String(code)} signal=${String(signal)}`
        );
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('journal lock child readiness timeout')),
          5_000
        );
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function journalError(error: unknown, code: string): boolean {
  assert.ok(error instanceof MediaCommandJournalError);
  assert.equal(error.code, code);
  return true;
}

async function withJournalPath(
  run: (journalPath: string, directory: string) => Promise<void>
): Promise<void> {
  const created = await mkdtemp(path.join(os.tmpdir(), 'ivekit-journal-'));
  const directory = await realpath(created);
  const journalPath = path.join(directory, 'media-command.wal');
  try {
    await run(journalPath, directory);
  } finally {
    await rm(created, { recursive: true, force: true });
  }
}
