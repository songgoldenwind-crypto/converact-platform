import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  rename,
  unlink
} from 'node:fs/promises';
import path from 'node:path';

import {
  MEDIA_CONTROL_ACTIONS,
  type MediaControlAction,
  type MediaSessionState
} from './protocol.js';
import {
  checkedMediaControlTerminalEvent,
  type MediaControlTerminalEvent
} from './events.js';

const HEADER_BYTES = 40;
const MAX_UINT64 = (1n << 64n) - 1n;
const CLOSE_ON_EXEC =
  (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
const TERMINAL_STATES = new Set<MediaSessionState>([
  'cancelled',
  'closed',
  'expired'
]);

export interface MediaCommandJournalRecord {
  action: MediaControlAction;
  command_id: string;
  media_reservation_id: string;
  command_hash: string;
  owner_epoch: string;
  command_sequence: number;
  transport_call_id: string;
  result_class: 'succeeded' | 'failed' | 'unknown';
  error_code: string | null;
  retryable: boolean | null;
  effective_sdp: string;
  session_state: MediaSessionState | null;
  from_tag: string | null;
  to_tag: string | null;
  recorded_at: string;
  terminal_at: string | null;
  tenant_id?: string;
  leg_id?: string;
  cell_id?: string;
  owner_node_id?: string;
  expires_at?: string;
}

export interface MediaCommandJournalOptions {
  path: string;
  maxRecords?: number;
  maxBytes?: number;
  maxRecordBytes?: number;
  terminalRetentionMs?: number;
}

export class MediaCommandJournalError extends Error {
  constructor(readonly code: string, options: { cause?: unknown } = {}) {
    super(code, options);
    this.name = 'MediaCommandJournalError';
  }
}

export class MediaCommandJournal {
  readonly #path: string;
  readonly #directory: string;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxRecordBytes: number;
  readonly #terminalRetentionMs: number;
  readonly #directoryIdentity: FileIdentity;
  readonly #lease: JournalLease;
  #handle: FileHandle | null;
  #records: MediaCommandJournalRecord[];
  #bytes: number;
  #tail: Promise<void> = Promise.resolve();
  #closeRequested = false;
  #broken: MediaCommandJournalError | null = null;

  private constructor(input: {
    path: string;
    handle: FileHandle;
    records: MediaCommandJournalRecord[];
    bytes: number;
    maxRecords: number;
    maxBytes: number;
    maxRecordBytes: number;
    terminalRetentionMs: number;
    directoryIdentity: FileIdentity;
    lease: JournalLease;
  }) {
    this.#path = input.path;
    this.#directory = path.dirname(input.path);
    this.#handle = input.handle;
    this.#records = input.records;
    this.#bytes = input.bytes;
    this.#maxRecords = input.maxRecords;
    this.#maxBytes = input.maxBytes;
    this.#maxRecordBytes = input.maxRecordBytes;
    this.#terminalRetentionMs = input.terminalRetentionMs;
    this.#directoryIdentity = input.directoryIdentity;
    this.#lease = input.lease;
  }

  static async open(
    options: MediaCommandJournalOptions
  ): Promise<MediaCommandJournal> {
    const journalPath = checkedPath(options.path);
    const parent = path.dirname(journalPath);
    const directoryIdentity = await assertSafeDirectory(parent);
    const maxRecords = checkedInteger(
      options.maxRecords ?? 1_000_000,
      1,
      10_000_000,
      'maxRecords'
    );
    const maxBytes = checkedInteger(
      options.maxBytes ?? 256 * 1024 * 1024,
      512,
      16 * 1024 * 1024 * 1024,
      'maxBytes'
    );
    const maxRecordBytes = checkedInteger(
      options.maxRecordBytes ?? Math.min(2 * 1024 * 1024, maxBytes - HEADER_BYTES),
      256,
      Math.min(maxBytes - HEADER_BYTES, 64 * 1024 * 1024),
      'maxRecordBytes'
    );
    const terminalRetentionMs = checkedInteger(
      options.terminalRetentionMs ?? 300_000,
      0,
      30 * 24 * 60 * 60 * 1_000,
      'terminalRetentionMs'
    );

    const lease = await JournalLease.acquire(
      `${journalPath}.lock`,
      parent,
      directoryIdentity
    );
    let handle: FileHandle | null = null;
    try {
      await cleanupStaleTemps(journalPath, parent);
      const existed = await assertSafeTarget(journalPath);
      handle = await openJournalHandle(journalPath, !existed);
      if (!existed) {
        await handle.chmod(0o600);
        await handle.sync();
        await syncDirectory(parent);
      }
      await assertCurrentTarget(
        handle,
        journalPath,
        parent,
        directoryIdentity
      );
      const stat = await handle.stat();
      if (stat.size > maxBytes) throw capacity();
      const decoded = await decodeRecords(
        handle,
        stat.size,
        maxRecordBytes,
        maxRecords
      );
      if (decoded.bytesRead < stat.size) {
        await handle.truncate(decoded.bytesRead);
        await handle.sync();
      }
      await lease.verify();
      return new MediaCommandJournal({
        path: journalPath,
        handle,
        records: decoded.records,
        bytes: decoded.bytesRead,
        maxRecords,
        maxBytes,
        maxRecordBytes,
        terminalRetentionMs,
        directoryIdentity,
        lease
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      await lease.release().catch(() => {});
      throw projectOpenError(error);
    }
  }

  append(record: MediaCommandJournalRecord): Promise<void> {
    return this.#enqueue(async () => {
      const checked = checkedRecord(record);
      const encoded = encodeRecord(checked, this.#maxRecordBytes);
      if (this.#records.length >= this.#maxRecords ||
          this.#bytes + encoded.length > this.#maxBytes) {
        throw capacity();
      }
      const handle = this.#requiredHandle();
      await this.#assertWritable(handle);
      const previousBytes = this.#bytes;
      try {
        await writeAll(handle, encoded);
        await handle.sync();
        await this.#assertWritable(handle);
      } catch (error) {
        try {
          await handle.truncate(previousBytes);
          await handle.sync();
          await this.#assertWritable(handle);
        } catch (rollbackError) {
          await this.#breakJournal(rollbackError);
        }
        throw error instanceof MediaCommandJournalError
          ? error
          : new MediaCommandJournalError(
              'journal_append_failed',
              { cause: error }
            );
      }
      this.#records.push(checked);
      this.#bytes += encoded.length;
    });
  }

  replay(): Promise<MediaCommandJournalRecord[]> {
    return this.#enqueue(async () => structuredClone(this.#records));
  }

  compact(now: Date): Promise<{
    removedRecords: number;
    retainedRecords: number;
  }> {
    return this.#enqueue(async () => {
      const timestamp = now.getTime();
      if (!Number.isFinite(timestamp)) {
        throw new MediaCommandJournalError('journal_time_invalid');
      }
      const cutoff = timestamp - this.#terminalRetentionMs;
      const latest = new Map<string, MediaCommandJournalRecord>();
      const unresolved = new Map<string, string>();
      for (const record of this.#records) {
        latest.set(record.media_reservation_id, record);
        const key = [
          record.media_reservation_id,
          record.owner_epoch,
          record.command_id,
          record.command_hash
        ].join('\0');
        if (record.result_class === 'unknown') {
          unresolved.set(key, record.media_reservation_id);
        } else {
          unresolved.delete(key);
        }
      }
      const unresolvedReservations = new Set(unresolved.values());
      const removable = new Set<string>();
      for (const [reservationId, record] of latest) {
        if (!unresolvedReservations.has(reservationId) &&
            isExpiredTerminal(record, cutoff)) {
          removable.add(reservationId);
        }
      }
      if (removable.size === 0) {
        return {
          removedRecords: 0,
          retainedRecords: this.#records.length
        };
      }

      const retained = this.#records.filter(
        (record) => !removable.has(record.media_reservation_id)
      );
      const frames = retained.map(
        (record) => encodeRecord(record, this.#maxRecordBytes)
      );
      const compactedBytes = frames.reduce(
        (total, frame) => total + frame.length,
        0
      );
      if (retained.length > this.#maxRecords ||
          compactedBytes > this.#maxBytes) {
        throw capacity();
      }
      await this.#replace(frames);
      const removedRecords = this.#records.length - retained.length;
      this.#records = retained;
      this.#bytes = compactedBytes;
      return {
        removedRecords,
        retainedRecords: retained.length
      };
    });
  }

  close(): Promise<void> {
    if (this.#closeRequested) return this.#tail;
    this.#closeRequested = true;
    const closing = this.#tail.then(async () => {
      const handle = this.#handle;
      this.#handle = null;
      await closeMediaCommandJournalResources(
        async () => handle?.close(),
        async () => this.#lease.release()
      );
    });
    this.#tail = closing.then(() => undefined, () => undefined);
    return closing;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closeRequested) {
      return Promise.reject(
        new MediaCommandJournalError('journal_closed')
      );
    }
    const result = this.#tail.then(async () => {
      if (this.#broken) throw this.#broken;
      return operation();
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #replace(frames: Buffer[]): Promise<void> {
    const temporaryPath = path.join(
      this.#directory,
      `.${path.basename(this.#path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    );
    let temporary: FileHandle | null = null;
    let replaced = false;
    try {
      temporary = await openTemporaryHandle(temporaryPath);
      await temporary.chmod(0o600);
      for (const frame of frames) await writeAll(temporary, frame);
      await temporary.sync();
      await temporary.close();
      temporary = null;

      const previous = this.#requiredHandle();
      await this.#assertWritable(previous);
      this.#handle = null;
      await previous.close();
      await assertSafeTarget(this.#path);
      await rename(temporaryPath, this.#path);
      replaced = true;
      await syncDirectory(this.#directory);
      this.#handle = await openJournalHandle(this.#path, false);
      await assertCurrentTarget(
        this.#handle,
        this.#path,
        this.#directory,
        this.#directoryIdentity
      );
      await this.#lease.verify();
    } catch (error) {
      await temporary?.close().catch(() => {});
      if (!replaced) await unlink(temporaryPath).catch(() => {});
      if (replaced) {
        await this.#breakJournal(error);
      } else if (!this.#handle) {
        this.#handle = await openJournalHandle(this.#path, false)
          .catch(() => null);
      }
      throw error instanceof MediaCommandJournalError
        ? error
        : new MediaCommandJournalError(
            'journal_compaction_failed',
            { cause: error }
          );
    }
  }

  #requiredHandle(): FileHandle {
    if (!this.#handle) throw new MediaCommandJournalError('journal_closed');
    return this.#handle;
  }

  async #assertWritable(handle: FileHandle): Promise<void> {
    await this.#lease.verify();
    await assertCurrentTarget(
      handle,
      this.#path,
      this.#directory,
      this.#directoryIdentity
    );
  }

  async #breakJournal(cause: unknown): Promise<void> {
    if (!this.#broken) {
      this.#broken = new MediaCommandJournalError(
        'journal_unavailable',
        { cause }
      );
    }
    const handle = this.#handle;
    this.#handle = null;
    await handle?.close().catch(() => {});
  }
}

export interface MediaTerminalEventJournalOptions {
  path: string;
  maxRecords?: number;
  maxBytes?: number;
  maxRecordBytes?: number;
}

export class MediaTerminalEventJournalError extends Error {
  constructor(readonly code: string, options: { cause?: unknown } = {}) {
    super(code, options);
    this.name = 'MediaTerminalEventJournalError';
  }
}

export class MediaTerminalEventJournal {
  readonly #path: string;
  readonly #directory: string;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxRecordBytes: number;
  readonly #directoryIdentity: FileIdentity;
  readonly #lease: JournalLease;
  #handle: FileHandle | null;
  #records: MediaControlTerminalEvent[];
  #byEventId: Map<string, MediaControlTerminalEvent>;
  #nextSequenceByOwner: Map<string, number>;
  #bytes: number;
  #tail: Promise<void> = Promise.resolve();
  #closeRequested = false;
  #broken: MediaTerminalEventJournalError | null = null;

  private constructor(input: {
    path: string;
    handle: FileHandle;
    records: MediaControlTerminalEvent[];
    bytes: number;
    maxRecords: number;
    maxBytes: number;
    maxRecordBytes: number;
    directoryIdentity: FileIdentity;
    lease: JournalLease;
  }) {
    this.#path = input.path;
    this.#directory = path.dirname(input.path);
    this.#handle = input.handle;
    this.#records = input.records;
    const indexes = terminalEventIndexes(input.records);
    this.#byEventId = indexes.byEventId;
    this.#nextSequenceByOwner = indexes.nextSequenceByOwner;
    this.#bytes = input.bytes;
    this.#maxRecords = input.maxRecords;
    this.#maxBytes = input.maxBytes;
    this.#maxRecordBytes = input.maxRecordBytes;
    this.#directoryIdentity = input.directoryIdentity;
    this.#lease = input.lease;
  }

  static async open(
    options: MediaTerminalEventJournalOptions
  ): Promise<MediaTerminalEventJournal> {
    let lease: JournalLease | null = null;
    let handle: FileHandle | null = null;
    try {
      const journalPath = checkedPath(options.path);
      const parent = path.dirname(journalPath);
      const directoryIdentity = await assertSafeDirectory(parent);
      const maxRecords = eventJournalInteger(
        options.maxRecords ?? 1_000_000,
        1,
        10_000_000,
        'max_records'
      );
      const maxBytes = eventJournalInteger(
        options.maxBytes ?? 256 * 1024 * 1024,
        512,
        16 * 1024 * 1024 * 1024,
        'max_bytes'
      );
      const maxRecordBytes = eventJournalInteger(
        options.maxRecordBytes ??
          Math.min(256 * 1024, maxBytes - HEADER_BYTES),
        256,
        Math.min(maxBytes - HEADER_BYTES, 4 * 1024 * 1024),
        'max_record_bytes'
      );
      lease = await JournalLease.acquire(
        `${journalPath}.lock`,
        parent,
        directoryIdentity
      );
      await cleanupStaleTemps(journalPath, parent);
      const existed = await assertSafeTarget(journalPath);
      handle = await openJournalHandle(journalPath, !existed);
      if (!existed) {
        await handle.chmod(0o600);
        await handle.sync();
        await syncDirectory(parent);
      }
      await assertCurrentTarget(
        handle,
        journalPath,
        parent,
        directoryIdentity
      );
      const stat = await handle.stat();
      if (stat.size > maxBytes) throw terminalJournalCapacity();
      const decoded = await decodeTerminalEventRecords(
        handle,
        stat.size,
        maxRecordBytes,
        maxRecords
      );
      if (decoded.bytesRead < stat.size) {
        await handle.truncate(decoded.bytesRead);
        await handle.sync();
      }
      await lease.verify();
      return new MediaTerminalEventJournal({
        path: journalPath,
        handle,
        records: decoded.records,
        bytes: decoded.bytesRead,
        maxRecords,
        maxBytes,
        maxRecordBytes,
        directoryIdentity,
        lease
      });
    } catch (error) {
      await handle?.close().catch(() => {});
      await lease?.release().catch(() => {});
      throw projectTerminalJournalError(
        error,
        'media_event_journal_open_failed'
      );
    }
  }

  append(
    event: MediaControlTerminalEvent
  ): Promise<{ replayed: boolean }> {
    return this.#enqueue(async () => {
      const checked = checkedTerminalEvent(event);
      const existing = this.#byEventId.get(checked.event_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(checked)) {
          throw new MediaTerminalEventJournalError(
            'media_event_journal_identity_conflict'
          );
        }
        return { replayed: true };
      }
      const expected = this.#nextSequenceByOwner.get(
        checked.owner_node_id
      ) ?? 1;
      if (checked.event_sequence !== expected) {
        throw new MediaTerminalEventJournalError(
          'media_event_journal_sequence_gap'
        );
      }
      if (this.#records.length >= this.#maxRecords) {
        throw terminalJournalCapacity();
      }
      const encoded = encodeTerminalEventRecord(
        checked,
        this.#maxRecordBytes
      );
      if (this.#bytes + encoded.length > this.#maxBytes) {
        throw terminalJournalCapacity();
      }
      const handle = this.#requiredHandle();
      await this.#assertWritable(handle);
      const previousBytes = this.#bytes;
      try {
        await writeAll(handle, encoded);
        await handle.sync();
        await this.#assertWritable(handle);
      } catch (error) {
        try {
          await handle.truncate(previousBytes);
          await handle.sync();
          await this.#assertWritable(handle);
        } catch (rollbackError) {
          await this.#breakJournal(rollbackError);
        }
        throw projectTerminalJournalError(
          error,
          'media_event_journal_append_failed'
        );
      }
      this.#records.push(checked);
      this.#byEventId.set(checked.event_id, checked);
      this.#nextSequenceByOwner.set(
        checked.owner_node_id,
        checked.event_sequence + 1
      );
      this.#bytes += encoded.length;
      return { replayed: false };
    });
  }

  replay(): Promise<MediaControlTerminalEvent[]> {
    return this.#enqueue(async () => structuredClone(this.#records));
  }

  compact(maxRetainedPerOwner: number): Promise<{
    removedRecords: number;
    retainedRecords: number;
  }> {
    return this.#enqueue(async () => {
      const maximum = eventJournalInteger(
        maxRetainedPerOwner,
        1,
        1_000_000,
        'max_retained_per_owner'
      );
      const counts = new Map<string, number>();
      const retained: MediaControlTerminalEvent[] = [];
      for (let index = this.#records.length - 1; index >= 0; index -= 1) {
        const record = this.#records[index];
        const count = counts.get(record.owner_node_id) ?? 0;
        if (count >= maximum) continue;
        counts.set(record.owner_node_id, count + 1);
        retained.push(record);
      }
      retained.reverse();
      if (retained.length === this.#records.length) {
        return {
          removedRecords: 0,
          retainedRecords: retained.length
        };
      }
      const frames = retained.map((record) =>
        encodeTerminalEventRecord(record, this.#maxRecordBytes)
      );
      const compactedBytes = frames.reduce(
        (total, frame) => total + frame.length,
        0
      );
      if (retained.length > this.#maxRecords ||
          compactedBytes > this.#maxBytes) {
        throw terminalJournalCapacity();
      }
      await this.#replace(frames);
      const removedRecords = this.#records.length - retained.length;
      this.#records = retained;
      const indexes = terminalEventIndexes(retained);
      this.#byEventId = indexes.byEventId;
      this.#nextSequenceByOwner = indexes.nextSequenceByOwner;
      this.#bytes = compactedBytes;
      return {
        removedRecords,
        retainedRecords: retained.length
      };
    });
  }

  close(): Promise<void> {
    if (this.#closeRequested) return this.#tail;
    this.#closeRequested = true;
    const closing = this.#tail.then(async () => {
      const handle = this.#handle;
      this.#handle = null;
      await closeMediaCommandJournalResources(
        async () => handle?.close(),
        async () => this.#lease.release()
      );
    });
    this.#tail = closing.then(() => undefined, () => undefined);
    return closing.catch((error) => {
      throw projectTerminalJournalError(
        error,
        'media_event_journal_close_failed'
      );
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closeRequested) {
      return Promise.reject(
        new MediaTerminalEventJournalError('media_event_journal_closed')
      );
    }
    const result = this.#tail.then(async () => {
      if (this.#broken) throw this.#broken;
      try {
        return await operation();
      } catch (error) {
        throw projectTerminalJournalError(
          error,
          'media_event_journal_operation_failed'
        );
      }
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #replace(frames: Buffer[]): Promise<void> {
    const temporaryPath = path.join(
      this.#directory,
      `.${path.basename(this.#path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    );
    let temporary: FileHandle | null = null;
    let replaced = false;
    try {
      temporary = await openTemporaryHandle(temporaryPath);
      await temporary.chmod(0o600);
      for (const frame of frames) await writeAll(temporary, frame);
      await temporary.sync();
      await temporary.close();
      temporary = null;

      const previous = this.#requiredHandle();
      await this.#assertWritable(previous);
      this.#handle = null;
      await previous.close();
      await assertSafeTarget(this.#path);
      await rename(temporaryPath, this.#path);
      replaced = true;
      await syncDirectory(this.#directory);
      this.#handle = await openJournalHandle(this.#path, false);
      await assertCurrentTarget(
        this.#handle,
        this.#path,
        this.#directory,
        this.#directoryIdentity
      );
      await this.#lease.verify();
    } catch (error) {
      await temporary?.close().catch(() => {});
      if (!replaced) await unlink(temporaryPath).catch(() => {});
      if (replaced) {
        await this.#breakJournal(error);
      } else if (!this.#handle) {
        this.#handle = await openJournalHandle(this.#path, false)
          .catch(() => null);
      }
      throw projectTerminalJournalError(
        error,
        'media_event_journal_compaction_failed'
      );
    }
  }

  #requiredHandle(): FileHandle {
    if (!this.#handle) {
      throw new MediaTerminalEventJournalError(
        'media_event_journal_closed'
      );
    }
    return this.#handle;
  }

  async #assertWritable(handle: FileHandle): Promise<void> {
    await this.#lease.verify();
    await assertCurrentTarget(
      handle,
      this.#path,
      this.#directory,
      this.#directoryIdentity
    );
  }

  async #breakJournal(cause: unknown): Promise<void> {
    if (!this.#broken) {
      this.#broken = new MediaTerminalEventJournalError(
        'media_event_journal_unavailable',
        { cause }
      );
    }
    const handle = this.#handle;
    this.#handle = null;
    await handle?.close().catch(() => {});
  }
}

export async function closeMediaCommandJournalResources(
  closeJournal: () => Promise<unknown>,
  releaseLease: () => Promise<unknown>
): Promise<void> {
  let closeError: unknown;
  try {
    await closeJournal();
  } catch (error) {
    closeError = error;
  }
  try {
    await releaseLease();
  } catch (leaseError) {
    if (closeError) {
      throw new AggregateError(
        [closeError, leaseError],
        'journal_close_failed'
      );
    }
    throw leaseError;
  }
  if (closeError) throw closeError;
}

class JournalLease {
  readonly #handle: FileHandle;
  readonly #path: string;
  readonly #directory: string;
  readonly #directoryIdentity: FileIdentity;
  #released = false;

  private constructor(
    handle: FileHandle,
    lockPath: string,
    directory: string,
    directoryIdentity: FileIdentity
  ) {
    this.#handle = handle;
    this.#path = lockPath;
    this.#directory = directory;
    this.#directoryIdentity = directoryIdentity;
  }

  static async acquire(
    lockPath: string,
    directory: string,
    directoryIdentity: FileIdentity
  ): Promise<JournalLease> {
    const opened = await openPersistentLockHandle(lockPath);
    try {
      if (opened.created) {
        await opened.handle.chmod(0o600);
        await opened.handle.sync();
        await syncDirectory(directory);
      }
      await assertCurrentTarget(
        opened.handle,
        lockPath,
        directory,
        directoryIdentity
      );
      await mutateDescriptorLock(opened.handle.fd, 'lock');
      return new JournalLease(
        opened.handle,
        lockPath,
        directory,
        directoryIdentity
      );
    } catch (error) {
      await opened.handle.close().catch(() => {});
      throw error;
    }
  }

  async verify(): Promise<void> {
    if (this.#released) {
      throw new MediaCommandJournalError('journal_lock_lost');
    }
    await assertCurrentTarget(
      this.#handle,
      this.#path,
      this.#directory,
      this.#directoryIdentity
    );
  }

  async release(): Promise<void> {
    if (this.#released) return;
    let unlockError: unknown;
    try {
      await mutateDescriptorLock(this.#handle.fd, 'unlock');
    } catch (error) {
      unlockError = error;
    }
    this.#released = true;
    try {
      await this.#handle.close();
    } catch (closeError) {
      if (unlockError) {
        throw new AggregateError(
          [unlockError, closeError],
          'journal_lock_release_failed'
        );
      }
      throw closeError;
    }
    if (unlockError) throw unlockError;
  }
}

async function openPersistentLockHandle(
  lockPath: string
): Promise<{ handle: FileHandle; created: boolean }> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existed = await assertSafeTarget(lockPath);
    try {
      const handle = await open(
        lockPath,
        constants.O_RDWR |
          noFollow |
          CLOSE_ON_EXEC |
          (existed ? 0 : constants.O_CREAT | constants.O_EXCL),
        0o600
      );
      return { handle, created: !existed };
    } catch (error) {
      if (!existed && isNodeError(error, 'EEXIST')) continue;
      throw new MediaCommandJournalError(
        isNodeError(error, 'ELOOP')
          ? 'journal_path_unsafe'
          : 'journal_lock_failed',
        { cause: error }
      );
    }
  }
  throw new MediaCommandJournalError('journal_lock_failed');
}

async function mutateDescriptorLock(
  descriptor: number,
  operation: 'lock' | 'unlock'
): Promise<void> {
  const helper = descriptorLockHelper(operation);
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    error?: unknown;
  }>((resolve) => {
    const child = spawn(helper.command, helper.args, {
      stdio: ['ignore', 'ignore', 'pipe', descriptor]
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 4_096) stderr += chunk.slice(0, 4_096 - stderr.length);
    });
    let spawnError: unknown;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, stderr, error: spawnError });
    });
  });
  if (outcome.code === 0 && !outcome.signal && !outcome.error) return;
  if (outcome.code === 73 && !outcome.signal) {
    throw new MediaCommandJournalError('journal_locked');
  }
  throw new MediaCommandJournalError('journal_lock_failed', {
    cause: outcome.error ?? new Error(
      `descriptor lock helper failed: code=${String(outcome.code)} signal=${String(outcome.signal)} stderr=${outcome.stderr.trim()}`
    )
  });
}

function descriptorLockHelper(
  operation: 'lock' | 'unlock'
): { command: string; args: string[] } {
  if (process.platform === 'linux') {
    return {
      command: '/usr/bin/flock',
      args: operation === 'lock'
        ? [
            '--exclusive',
            '--nonblock',
            '--conflict-exit-code',
            '73',
            '3'
          ]
        : ['--unlock', '3']
    };
  }
  if (process.platform === 'darwin') {
    return {
      command: '/usr/bin/python3',
      args: [
        '-c',
        [
          'import fcntl, sys',
          ...(operation === 'lock'
            ? [
                'try:',
                '  fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)',
                'except BlockingIOError:',
                '  sys.exit(73)'
              ]
            : ['fcntl.flock(3, fcntl.LOCK_UN)'])
        ].join('\n')
      ]
    };
  }
  throw new MediaCommandJournalError('journal_lock_platform_unsupported');
}

async function cleanupStaleTemps(
  journalPath: string,
  directory: string
): Promise<void> {
  const prefix = `.${path.basename(journalPath)}.`;
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = path.join(directory, name);
    const stat = await lstat(candidate);
    const uid = process.getuid?.();
    if (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (uid !== undefined && stat.uid !== uid)) {
      throw unsafePath();
    }
    await unlink(candidate);
    removed = true;
  }
  if (removed) await syncDirectory(directory);
}

function encodeTerminalEventRecord(
  event: MediaControlTerminalEvent,
  maxRecordBytes: number
): Buffer {
  const checked = checkedTerminalEvent(event);
  const payload = Buffer.from(JSON.stringify(checked), 'utf8');
  if (payload.length > maxRecordBytes) throw terminalJournalCapacity();
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt32BE((~payload.length) >>> 0, 4);
  createHash('sha256')
    .update(header.subarray(0, 8))
    .update(payload)
    .digest()
    .copy(header, 8);
  return Buffer.concat([header, payload], HEADER_BYTES + payload.length);
}

async function decodeTerminalEventRecords(
  handle: FileHandle,
  size: number,
  maxRecordBytes: number,
  maxRecords: number
): Promise<{
  records: MediaControlTerminalEvent[];
  bytesRead: number;
}> {
  const records: MediaControlTerminalEvent[] = [];
  let offset = 0;
  while (offset < size) {
    if (size - offset < HEADER_BYTES) break;
    const header = await readAt(handle, HEADER_BYTES, offset);
    if (header.length < HEADER_BYTES) break;
    const payloadBytes = header.readUInt32BE(0);
    const complement = header.readUInt32BE(4);
    if (complement !== ((~payloadBytes) >>> 0) ||
        payloadBytes < 2 ||
        payloadBytes > maxRecordBytes) {
      throw new MediaTerminalEventJournalError(
        'media_event_journal_record_invalid'
      );
    }
    const end = offset + HEADER_BYTES + payloadBytes;
    if (end > size) break;
    const payload = await readAt(
      handle,
      payloadBytes,
      offset + HEADER_BYTES
    );
    if (payload.length < payloadBytes) break;
    const expected = header.subarray(8, HEADER_BYTES);
    const actual = createHash('sha256')
      .update(header.subarray(0, 8))
      .update(payload)
      .digest();
    if (!actual.equals(expected)) {
      throw new MediaTerminalEventJournalError(
        'media_event_journal_checksum_mismatch'
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8')) as unknown;
    } catch (error) {
      throw new MediaTerminalEventJournalError(
        'media_event_journal_record_invalid',
        { cause: error }
      );
    }
    records.push(checkedTerminalEvent(parsed));
    if (records.length > maxRecords) throw terminalJournalCapacity();
    offset = end;
  }
  terminalEventIndexes(records);
  return { records, bytesRead: offset };
}

function checkedTerminalEvent(
  value: unknown
): MediaControlTerminalEvent {
  try {
    return checkedMediaControlTerminalEvent(value);
  } catch (error) {
    throw new MediaTerminalEventJournalError(
      'media_event_journal_record_invalid',
      { cause: error }
    );
  }
}

function terminalEventIndexes(
  records: MediaControlTerminalEvent[]
): {
  byEventId: Map<string, MediaControlTerminalEvent>;
  nextSequenceByOwner: Map<string, number>;
} {
  const byEventId = new Map<string, MediaControlTerminalEvent>();
  const nextSequenceByOwner = new Map<string, number>();
  for (const record of records) {
    const existing = byEventId.get(record.event_id);
    if (existing) {
      throw new MediaTerminalEventJournalError(
        'media_event_journal_identity_conflict'
      );
    }
    const expected = nextSequenceByOwner.get(record.owner_node_id);
    if (expected !== undefined && record.event_sequence !== expected) {
      throw new MediaTerminalEventJournalError(
        'media_event_journal_sequence_gap'
      );
    }
    byEventId.set(record.event_id, record);
    nextSequenceByOwner.set(
      record.owner_node_id,
      record.event_sequence + 1
    );
  }
  return { byEventId, nextSequenceByOwner };
}

function eventJournalInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MediaTerminalEventJournalError(
      `media_event_journal_${field}_invalid`
    );
  }
  return value;
}

function terminalJournalCapacity(): MediaTerminalEventJournalError {
  return new MediaTerminalEventJournalError(
    'media_event_journal_capacity_exhausted'
  );
}

function projectTerminalJournalError(
  error: unknown,
  fallback: string
): MediaTerminalEventJournalError {
  if (error instanceof MediaTerminalEventJournalError) return error;
  if (error instanceof MediaCommandJournalError) {
    const code = error.code === 'journal_locked'
      ? 'media_event_journal_locked'
      : error.code === 'journal_path_unsafe'
        ? 'media_event_journal_path_unsafe'
        : error.code === 'journal_capacity_exhausted'
          ? 'media_event_journal_capacity_exhausted'
          : fallback;
    return new MediaTerminalEventJournalError(code, { cause: error });
  }
  return new MediaTerminalEventJournalError(fallback, { cause: error });
}

function encodeRecord(
  record: MediaCommandJournalRecord,
  maxRecordBytes: number
): Buffer {
  const payload = Buffer.from(JSON.stringify(record), 'utf8');
  if (payload.length > maxRecordBytes) throw capacity();
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt32BE((~payload.length) >>> 0, 4);
  createHash('sha256')
    .update(header.subarray(0, 8))
    .update(payload)
    .digest()
    .copy(header, 8);
  return Buffer.concat([header, payload], HEADER_BYTES + payload.length);
}

async function decodeRecords(
  handle: FileHandle,
  size: number,
  maxRecordBytes: number,
  maxRecords: number
): Promise<{ records: MediaCommandJournalRecord[]; bytesRead: number }> {
  const records: MediaCommandJournalRecord[] = [];
  let offset = 0;
  while (offset < size) {
    if (size - offset < HEADER_BYTES) break;
    const header = await readAt(handle, HEADER_BYTES, offset);
    if (header.length < HEADER_BYTES) break;
    const payloadBytes = header.readUInt32BE(0);
    const complement = header.readUInt32BE(4);
    if (complement !== ((~payloadBytes) >>> 0)) {
      throw new MediaCommandJournalError('journal_record_invalid');
    }
    if (payloadBytes < 2 || payloadBytes > maxRecordBytes) {
      throw new MediaCommandJournalError('journal_record_invalid');
    }
    const end = offset + HEADER_BYTES + payloadBytes;
    if (end > size) break;
    const payload = await readAt(handle, payloadBytes, offset + HEADER_BYTES);
    if (payload.length < payloadBytes) break;
    const expected = header.subarray(8, HEADER_BYTES);
    const actual = createHash('sha256')
      .update(header.subarray(0, 8))
      .update(payload)
      .digest();
    if (!actual.equals(expected)) {
      throw new MediaCommandJournalError('journal_checksum_mismatch');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      throw new MediaCommandJournalError(
        'journal_record_invalid',
        { cause: error }
      );
    }
    records.push(checkedRecord(parsed));
    if (records.length > maxRecords) throw capacity();
    offset = end;
  }
  return { records, bytesRead: offset };
}

function checkedRecord(value: unknown): MediaCommandJournalRecord {
  if (!isObject(value)) throw invalidRecord();
  const fields = [
    'action',
    'command_id',
    'media_reservation_id',
    'command_hash',
    'owner_epoch',
    'command_sequence',
    'transport_call_id',
    'result_class',
    'error_code',
    'retryable',
    'effective_sdp',
    'session_state',
    'from_tag',
    'to_tag',
    'recorded_at',
    'terminal_at'
  ];
  const identityFields = [
    'tenant_id',
    'leg_id',
    'cell_id',
    'owner_node_id',
    'expires_at'
  ];
  const identityCount = identityFields.filter(
    (field) => Object.hasOwn(value, field)
  ).length;
  const hasIdentity = identityCount === identityFields.length;
  if ((identityCount !== 0 && !hasIdentity) ||
      Object.keys(value).length !== fields.length +
        (hasIdentity ? identityFields.length : 0) ||
      fields.some((field) => !Object.hasOwn(value, field))) {
    throw invalidRecord();
  }

  const action = String(value.action || '');
  if (!MEDIA_CONTROL_ACTIONS.includes(action as MediaControlAction)) {
    throw invalidRecord();
  }
  const commandId = boundedText(value.command_id, 256);
  const reservationId = boundedText(value.media_reservation_id, 256);
  const commandHash = String(value.command_hash || '');
  if (!/^[a-f0-9]{64}$/.test(commandHash)) throw invalidRecord();
  const ownerEpoch = String(value.owner_epoch || '');
  if (!/^[1-9][0-9]{0,19}$/.test(ownerEpoch)) throw invalidRecord();
  const epoch = BigInt(ownerEpoch);
  if (epoch > MAX_UINT64) throw invalidRecord();
  const commandSequence = Number(value.command_sequence);
  if (!Number.isSafeInteger(commandSequence) ||
      commandSequence < 1 ||
      commandSequence > 0xffff_ffff) {
    throw invalidRecord();
  }
  const transportCallId = boundedText(value.transport_call_id, 512);
  const resultClass = String(value.result_class);
  if (!['succeeded', 'failed', 'unknown'].includes(resultClass)) {
    throw invalidRecord();
  }
  const errorCode = value.error_code === null
    ? null
    : boundedText(value.error_code, 128);
  const retryable = value.retryable;
  if (retryable !== null && typeof retryable !== 'boolean') {
    throw invalidRecord();
  }
  const checkedRetryable = retryable as boolean | null;
  if (resultClass === 'succeeded' &&
      (errorCode !== null || checkedRetryable !== null)) {
    throw invalidRecord();
  }
  if (resultClass !== 'succeeded' &&
      (errorCode === null || typeof checkedRetryable !== 'boolean')) {
    throw invalidRecord();
  }
  if (resultClass === 'unknown' && checkedRetryable !== true) {
    throw invalidRecord();
  }
  if (typeof value.effective_sdp !== 'string' ||
      value.effective_sdp.includes('\0') ||
      Buffer.byteLength(value.effective_sdp, 'utf8') > 256 * 1024) {
    throw invalidRecord();
  }
  const sessionState = value.session_state;
  if (sessionState !== null && !isSessionState(sessionState)) {
    throw invalidRecord();
  }
  const checkedSessionState = sessionState as MediaSessionState | null;
  const fromTag = nullableTag(value.from_tag);
  const toTag = nullableTag(value.to_tag);
  const recordedAt = checkedTimestamp(value.recorded_at);
  const terminalAt = value.terminal_at === null
    ? null
    : checkedTimestamp(value.terminal_at);
  if (resultClass === 'unknown' && terminalAt !== null) throw invalidRecord();
  if (checkedSessionState === null && terminalAt !== null) throw invalidRecord();
  if (checkedSessionState &&
      TERMINAL_STATES.has(checkedSessionState) &&
      terminalAt === null) {
    throw invalidRecord();
  }
  if (checkedSessionState &&
      !TERMINAL_STATES.has(checkedSessionState) &&
      terminalAt !== null) {
    throw invalidRecord();
  }
  const identity = hasIdentity
    ? {
        tenant_id: boundedText(value.tenant_id, 256),
        leg_id: boundedText(value.leg_id, 256),
        cell_id: boundedText(value.cell_id, 256),
        owner_node_id: boundedText(value.owner_node_id, 256),
        expires_at: checkedTimestamp(value.expires_at)
      }
    : {};

  return {
    action: action as MediaControlAction,
    command_id: commandId,
    media_reservation_id: reservationId,
    command_hash: commandHash,
    owner_epoch: epoch.toString(),
    command_sequence: commandSequence,
    transport_call_id: transportCallId,
    result_class: resultClass as MediaCommandJournalRecord['result_class'],
    error_code: errorCode,
    retryable: checkedRetryable,
    effective_sdp: value.effective_sdp,
    session_state: checkedSessionState,
    from_tag: fromTag,
    to_tag: toTag,
    recorded_at: recordedAt,
    terminal_at: terminalAt,
    ...identity
  };
}

function nullableTag(value: unknown): string | null {
  if (value === null) return null;
  const tag = boundedText(value, 256);
  if (/[\0\r\n]/.test(tag)) throw invalidRecord();
  return tag;
}

function isExpiredTerminal(
  record: MediaCommandJournalRecord,
  cutoff: number
): boolean {
  if (record.result_class === 'unknown' ||
      !record.terminal_at ||
      !record.session_state ||
      !TERMINAL_STATES.has(record.session_state)) {
    return false;
  }
  return Date.parse(record.terminal_at) <= cutoff;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

async function assertSafeDirectory(
  directory: string
): Promise<FileIdentity> {
  try {
    const parsed = path.parse(directory);
    let current = parsed.root;
    const segments = path.relative(parsed.root, directory)
      .split(path.sep)
      .filter(Boolean);
    let stat = await lstat(current);
    for (const segment of segments) {
      current = path.join(current, segment);
      stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath();
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath();
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o022) !== 0) {
      throw unsafePath();
    }
    return identity(stat);
  } catch (error) {
    throw error instanceof MediaCommandJournalError
      ? error
      : new MediaCommandJournalError('journal_path_unsafe', { cause: error });
  }
}

async function assertSafeTarget(target: string): Promise<boolean> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw unsafePath();
    }
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error instanceof MediaCommandJournalError
      ? error
      : new MediaCommandJournalError('journal_path_unsafe', { cause: error });
  }
}

async function assertCurrentTarget(
  handle: FileHandle,
  target: string,
  directory: string,
  directoryIdentity: FileIdentity
): Promise<void> {
  const currentDirectory = await lstat(directory);
  if (!sameIdentity(currentDirectory, directoryIdentity) ||
      !currentDirectory.isDirectory() ||
      currentDirectory.isSymbolicLink()) {
    throw unsafePath();
  }
  const [descriptor, linked] = await Promise.all([
    handle.stat(),
    lstat(target)
  ]);
  if (!descriptor.isFile() ||
      !linked.isFile() ||
      linked.isSymbolicLink() ||
      descriptor.nlink !== 1 ||
      linked.nlink !== 1 ||
      !sameIdentity(descriptor, identity(linked))) {
    throw unsafePath();
  }
  const uid = process.getuid?.();
  if ((descriptor.mode & 0o777) !== 0o600 ||
      (linked.mode & 0o777) !== 0o600 ||
      (uid !== undefined && (descriptor.uid !== uid || linked.uid !== uid))) {
    throw new MediaCommandJournalError('journal_permissions_invalid');
  }
}

async function openJournalHandle(
  target: string,
  createNew: boolean
): Promise<FileHandle> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const flags = constants.O_RDWR |
    constants.O_APPEND |
    noFollow |
    CLOSE_ON_EXEC |
    (createNew ? constants.O_CREAT | constants.O_EXCL : 0);
  try {
    return await open(target, flags, 0o600);
  } catch (error) {
    throw new MediaCommandJournalError(
      isNodeError(error, 'ELOOP') ? 'journal_path_unsafe' : 'journal_open_failed',
      { cause: error }
    );
  }
}

async function openTemporaryHandle(target: string): Promise<FileHandle> {
  const flags = constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0) |
    CLOSE_ON_EXEC;
  return open(target, flags, 0o600);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(
    directory,
    constants.O_RDONLY | CLOSE_ON_EXEC
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readAt(
  handle: FileHandle,
  size: number,
  position: number
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      position + offset
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return offset === bytes.length ? bytes : bytes.subarray(0, offset);
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null
    );
    if (result.bytesWritten === 0) {
      throw new MediaCommandJournalError('journal_write_failed');
    }
    offset += result.bytesWritten;
  }
}

function checkedPath(value: string): string {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.includes('\0')) throw unsafePath();
  return path.resolve(candidate);
}

function checkedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MediaCommandJournalError(`journal_${name}_invalid`);
  }
  return value;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' ||
      value.length < 1 ||
      Buffer.byteLength(value, 'utf8') > maximumBytes ||
      /[\0\r\n]/.test(value)) {
    throw invalidRecord();
  }
  return value;
}

function checkedTimestamp(value: unknown): string {
  if (typeof value !== 'string') throw invalidRecord();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw invalidRecord();
  }
  return value;
}

function isSessionState(value: unknown): value is MediaSessionState {
  return [
    'prepared',
    'committed',
    'cancelled',
    'closed',
    'expired'
  ].includes(String(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function identity(stat: Pick<Stats, 'dev' | 'ino'>): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(
  stat: Pick<Stats, 'dev' | 'ino'>,
  expected: FileIdentity
): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino;
}

function unsafePath(): MediaCommandJournalError {
  return new MediaCommandJournalError('journal_path_unsafe');
}

function invalidRecord(): MediaCommandJournalError {
  return new MediaCommandJournalError('journal_record_invalid');
}

function capacity(): MediaCommandJournalError {
  return new MediaCommandJournalError('journal_capacity_exceeded');
}

function projectOpenError(error: unknown): MediaCommandJournalError {
  return error instanceof MediaCommandJournalError
    ? error
    : new MediaCommandJournalError('journal_open_failed', { cause: error });
}
