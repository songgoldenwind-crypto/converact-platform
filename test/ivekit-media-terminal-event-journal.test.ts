import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import type {
  MediaControlTerminalEvent
} from '../src/agent-runtime/ivekit/media-control/events.js';
import {
  MediaTerminalEventJournal,
  MediaTerminalEventJournalError
} from '../src/agent-runtime/ivekit/media-control/journal.js';

type GatherTerminalEvent = Extract<
  MediaControlTerminalEvent,
  { event_type: 'gather_completed' }
>;

describe('checksummed media terminal event journal', () => {
  it('durably replays events and treats an exact source replay as idempotent', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaTerminalEventJournal.open({
        path: journalPath
      });
      const first = event();
      assert.deepEqual(await journal.append(first), { replayed: false });
      assert.deepEqual(await journal.append(first), { replayed: true });
      assert.deepEqual(await journal.replay(), [first]);
      await journal.close();

      const reopened = await MediaTerminalEventJournal.open({
        path: journalPath
      });
      assert.deepEqual(await reopened.replay(), [first]);
      await reopened.close();
    });
  });

  it('holds an exclusive writer lease and rejects sequence or identity conflicts', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaTerminalEventJournal.open({
        path: journalPath
      });
      const first = event();
      await journal.append(first);
      await assert.rejects(
        MediaTerminalEventJournal.open({ path: journalPath }),
        (error: unknown) => journalError(error, 'media_event_journal_locked')
      );
      await assert.rejects(
        journal.append({
          ...first,
          digits: '99'
        }),
        (error: unknown) => journalError(
          error,
          'media_event_journal_identity_conflict'
        )
      );
      await assert.rejects(
        journal.append(event({
          event_sequence: 3,
          event_id: 'processing-event-source-2',
          command_id: 'gather-2'
        })),
        (error: unknown) => journalError(
          error,
          'media_event_journal_sequence_gap'
        )
      );
      await journal.close();
    });
  });

  it('recovers an incomplete tail but fails closed on complete corruption', async () => {
    await withJournalPath(async (journalPath) => {
      const first = event();
      const journal = await MediaTerminalEventJournal.open({
        path: journalPath
      });
      await journal.append(first);
      await journal.close();

      await appendFile(journalPath, Buffer.from([0, 0, 1, 0, 1, 2, 3]));
      const recovered = await MediaTerminalEventJournal.open({
        path: journalPath
      });
      assert.deepEqual(await recovered.replay(), [first]);
      await recovered.close();

      const bytes = await readFile(journalPath);
      bytes[bytes.length - 1] ^= 1;
      await writeFile(journalPath, bytes, { mode: 0o600 });
      await assert.rejects(
        MediaTerminalEventJournal.open({ path: journalPath }),
        (error: unknown) => journalError(
          error,
          'media_event_journal_checksum_mismatch'
        )
      );
    });
  });

  it('compacts to a bounded replay window without resetting owner sequence', async () => {
    await withJournalPath(async (journalPath) => {
      const journal = await MediaTerminalEventJournal.open({
        path: journalPath,
        maxRecords: 16
      });
      for (let sequence = 1; sequence <= 6; sequence += 1) {
        await journal.append(event({
          event_sequence: sequence,
          event_id: `processing-event-source-${sequence}`,
          command_id: `gather-${sequence}`
        }));
      }
      assert.deepEqual(await journal.compact(2), {
        removedRecords: 4,
        retainedRecords: 2
      });
      await journal.close();

      const reopened = await MediaTerminalEventJournal.open({
        path: journalPath,
        maxRecords: 16
      });
      assert.deepEqual(
        (await reopened.replay()).map((item) => item.event_sequence),
        [5, 6]
      );
      await reopened.append(event({
        event_sequence: 7,
        event_id: 'processing-event-source-7',
        command_id: 'gather-7'
      }));
      await reopened.close();
    });
  });
});

function event(
  overrides: Partial<GatherTerminalEvent> = {}
): GatherTerminalEvent {
  return {
    protocol_version: 'ivekit.media-event.v1',
    event_sequence: 1,
    event_type: 'gather_completed',
    event_id: 'processing-event-source-1',
    source: 'processing',
    source_event_sequence: '1',
    tenant_id: 'tenant-a',
    call_id: 'call-a',
    cell_id: 'cell-a',
    owner_node_id: 'node-a',
    owner_epoch: '7',
    media_reservation_id: 'media-a',
    command_id: 'gather-1',
    occurred_at_ms: 1_785_200_000_123,
    digits: '42',
    reason: 'maximum_digits',
    minimum_satisfied: true,
    ...overrides
  };
}

async function withJournalPath(
  run: (journalPath: string) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'ivekit-media-terminal-events-')
  );
  const resolvedDirectory = await realpath(directory);
  try {
    await run(path.join(resolvedDirectory, 'terminal-events.wal'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function journalError(error: unknown, code: string): boolean {
  return error instanceof MediaTerminalEventJournalError &&
    error.code === code;
}
