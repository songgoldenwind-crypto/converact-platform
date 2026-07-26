import { randomBytes } from 'node:crypto';
import {
  constants,
  open,
  rename,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';

import {
  assertDialogShadowRecord,
  dialogShadowRecordHash,
  type DialogShadowJournalAppendResult,
  type DialogShadowJournalPort,
  type DialogShadowRecord
} from './dialog-shadow.js';

const MAGIC = Buffer.from('IVDS', 'ascii');
const VERSION = 1;
const HEADER_BYTES = 16;
const DEFAULT_MAX_RECORDS = 1_000_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 32 * 1024;
const CRC_TABLE = crcTable();

export interface DialogShadowJournalOptions {
  path: string;
  maxRecords?: number;
  maxBytes?: number;
  maxRecordBytes?: number;
}

export class DialogShadowJournal implements DialogShadowJournalPort {
  readonly #path: string;
  readonly #directory: string;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #maxRecordBytes: number;
  #handle: FileHandle | null;
  #records: DialogShadowRecord[];
  #bytes: number;
  #tail: Promise<void> = Promise.resolve();
  #closeRequested = false;

  private constructor(input: {
    path: string;
    handle: FileHandle;
    records: DialogShadowRecord[];
    bytes: number;
    maxRecords: number;
    maxBytes: number;
    maxRecordBytes: number;
  }) {
    this.#path = input.path;
    this.#directory = path.dirname(input.path);
    this.#handle = input.handle;
    this.#records = input.records;
    this.#bytes = input.bytes;
    this.#maxRecords = input.maxRecords;
    this.#maxBytes = input.maxBytes;
    this.#maxRecordBytes = input.maxRecordBytes;
  }

  static async open(
    options: DialogShadowJournalOptions
  ): Promise<DialogShadowJournal> {
    const journalPath = checkedPath(options.path);
    const maxRecords = boundedInteger(
      options.maxRecords ?? DEFAULT_MAX_RECORDS,
      1,
      10_000_000,
      'maxRecords'
    );
    const maxBytes = boundedInteger(
      options.maxBytes ?? DEFAULT_MAX_BYTES,
      512,
      16 * 1024 * 1024 * 1024,
      'maxBytes'
    );
    const maxRecordBytes = boundedInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      256,
      Math.min(maxBytes - HEADER_BYTES, 1024 * 1024),
      'maxRecordBytes'
    );
    const existed = await pathExists(journalPath);
    const handle = await open(
      journalPath,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        closeOnExec(),
      0o600
    );
    try {
      if (!existed) {
        await handle.chmod(0o600);
        await handle.sync();
        await syncDirectory(path.dirname(journalPath));
      }
      await assertSafeFile(handle);
      const stat = await handle.stat();
      if (stat.size > maxBytes) throw capacity();
      const bytes = Buffer.allocUnsafe(stat.size);
      if (stat.size > 0) await readAll(handle, bytes);
      const decoded = decodeFrames(bytes, maxRecordBytes, maxRecords);
      if (decoded.bytesRead < stat.size) {
        await handle.truncate(decoded.bytesRead);
        await handle.sync();
      }
      return new DialogShadowJournal({
        path: journalPath,
        handle,
        records: decoded.records,
        bytes: decoded.bytesRead,
        maxRecords,
        maxBytes,
        maxRecordBytes
      });
    } catch (error) {
      await handle.close().catch(() => {});
      throw projectError(error, 'dialog_shadow_journal_open_failed');
    }
  }

  append(
    value: DialogShadowRecord
  ): Promise<DialogShadowJournalAppendResult> {
    return this.#enqueue(async () => {
      const record = assertDialogShadowRecord(value);
      const hash = dialogShadowRecordHash(record);
      const transition = validateTransition(this.#records, record, hash);
      if (transition === 'replayed') {
        return { status: 'replayed', record_hash: hash };
      }
      const frame = encodeFrame(record, this.#maxRecordBytes);
      if (this.#records.length >= this.#maxRecords ||
          this.#bytes + frame.byteLength > this.#maxBytes) {
        throw capacity();
      }
      const handle = this.#requiredHandle();
      const previousBytes = this.#bytes;
      try {
        await writeAll(handle, frame, previousBytes);
        await handle.sync();
      } catch (error) {
        await handle.truncate(previousBytes).catch(() => {});
        await handle.sync().catch(() => {});
        throw projectError(error, 'dialog_shadow_append_failed');
      }
      this.#records.push(record);
      this.#bytes += frame.byteLength;
      return { status: 'committed', record_hash: hash };
    });
  }

  replay(): Promise<DialogShadowRecord[]> {
    return this.#enqueue(async () => structuredClone(this.#records));
  }

  compact(): Promise<{
    removed_records: number;
    retained_records: number;
  }> {
    return this.#enqueue(async () => {
      const latest = new Map<string, DialogShadowRecord>();
      for (const record of this.#records) {
        latest.set(dialogKey(record), record);
      }
      const retained = [...latest.values()].sort(compareRecords);
      if (retained.length === this.#records.length) {
        return {
          removed_records: 0,
          retained_records: retained.length
        };
      }
      const frames = retained.map(
        (record) => encodeFrame(record, this.#maxRecordBytes)
      );
      const bytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
      if (retained.length > this.#maxRecords || bytes > this.#maxBytes) {
        throw capacity();
      }
      await this.#replace(frames);
      const removed = this.#records.length - retained.length;
      this.#records = retained;
      this.#bytes = bytes;
      return {
        removed_records: removed,
        retained_records: retained.length
      };
    });
  }

  close(): Promise<void> {
    if (this.#closeRequested) return this.#tail;
    this.#closeRequested = true;
    const closing = this.#tail.then(async () => {
      const handle = this.#handle;
      this.#handle = null;
      await handle?.close();
    });
    this.#tail = closing.then(() => undefined, () => undefined);
    return closing;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closeRequested) {
      return Promise.reject(
        new DialogShadowJournalError('dialog_shadow_journal_closed')
      );
    }
    const result = this.#tail.then(operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #requiredHandle(): FileHandle {
    if (!this.#handle) {
      throw new DialogShadowJournalError('dialog_shadow_journal_closed');
    }
    return this.#handle;
  }

  async #replace(frames: Buffer[]): Promise<void> {
    const temporaryPath = path.join(
      this.#directory,
      `.${path.basename(this.#path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    );
    let temporary: FileHandle | null = null;
    try {
      temporary = await open(
        temporaryPath,
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          closeOnExec(),
        0o600
      );
      let offset = 0;
      for (const frame of frames) {
        await writeAll(temporary, frame, offset);
        offset += frame.byteLength;
      }
      await temporary.sync();
      await temporary.close();
      temporary = null;

      const previous = this.#requiredHandle();
      this.#handle = null;
      await previous.close();
      await rename(temporaryPath, this.#path);
      await syncDirectory(this.#directory);
      this.#handle = await open(
        this.#path,
        constants.O_RDWR | constants.O_NOFOLLOW | closeOnExec(),
        0o600
      );
      await assertSafeFile(this.#handle);
    } catch (error) {
      await temporary?.close().catch(() => {});
      await unlink(temporaryPath).catch(() => {});
      if (!this.#handle) {
        try {
          this.#handle = await open(
            this.#path,
            constants.O_RDWR | constants.O_NOFOLLOW | closeOnExec(),
            0o600
          );
          await assertSafeFile(this.#handle);
        } catch {
          this.#handle = null;
        }
      }
      throw projectError(error, 'dialog_shadow_compaction_failed');
    }
  }
}

export class DialogShadowJournalError extends Error {
  readonly code: string;

  constructor(code: string, options?: { cause?: unknown }) {
    super(code, options);
    this.name = 'DialogShadowJournalError';
    this.code = code;
  }
}

function validateTransition(
  records: DialogShadowRecord[],
  candidate: DialogShadowRecord,
  candidateHash: string
): 'append' | 'replayed' {
  const latest = [...records].reverse().find(
    (record) => dialogKey(record) === dialogKey(candidate)
  );
  if (!latest) {
    if (candidate.sequence !== 1) {
      throw new DialogShadowJournalError('dialog_shadow_sequence_gap');
    }
    return 'append';
  }
  if (candidate.owner_epoch < latest.owner_epoch) {
    throw new DialogShadowJournalError('dialog_shadow_stale_owner_epoch');
  }
  if (candidate.owner_epoch > latest.owner_epoch) {
    if (candidate.sequence !== 1) {
      throw new DialogShadowJournalError('dialog_shadow_sequence_gap');
    }
    return 'append';
  }
  if (candidate.sequence === latest.sequence) {
    if (candidateHash !== dialogShadowRecordHash(latest)) {
      throw new DialogShadowJournalError('dialog_shadow_payload_mismatch');
    }
    return 'replayed';
  }
  if (candidate.sequence !== latest.sequence + 1) {
    throw new DialogShadowJournalError('dialog_shadow_sequence_gap');
  }
  if (latest.terminal) {
    throw new DialogShadowJournalError('dialog_shadow_terminal');
  }
  return 'append';
}

function encodeFrame(
  value: DialogShadowRecord,
  maxRecordBytes: number
): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.byteLength > maxRecordBytes) {
    throw new DialogShadowJournalError('dialog_shadow_record_too_large');
  }
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength);
  MAGIC.copy(frame, 0);
  frame.writeUInt16BE(VERSION, 4);
  frame.writeUInt16BE(0, 6);
  frame.writeUInt32BE(payload.byteLength, 8);
  frame.writeUInt32BE(crc32(payload), 12);
  payload.copy(frame, HEADER_BYTES);
  return frame;
}

function decodeFrames(
  bytes: Buffer,
  maxRecordBytes: number,
  maxRecords: number
): { records: DialogShadowRecord[]; bytesRead: number } {
  const records: DialogShadowRecord[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    if (remaining < HEADER_BYTES) break;
    if (!bytes.subarray(offset, offset + 4).equals(MAGIC)) {
      throw new DialogShadowJournalError('dialog_shadow_frame_invalid');
    }
    const version = bytes.readUInt16BE(offset + 4);
    const flags = bytes.readUInt16BE(offset + 6);
    const payloadBytes = bytes.readUInt32BE(offset + 8);
    const checksum = bytes.readUInt32BE(offset + 12);
    if (version !== VERSION || flags !== 0 ||
        payloadBytes === 0 || payloadBytes > maxRecordBytes) {
      throw new DialogShadowJournalError('dialog_shadow_frame_invalid');
    }
    if (remaining < HEADER_BYTES + payloadBytes) break;
    const payload = bytes.subarray(
      offset + HEADER_BYTES,
      offset + HEADER_BYTES + payloadBytes
    );
    if (crc32(payload) !== checksum) {
      throw new DialogShadowJournalError('dialog_shadow_checksum_mismatch');
    }
    let decoded: DialogShadowRecord;
    try {
      decoded = assertDialogShadowRecord(
        JSON.parse(payload.toString('utf8')) as DialogShadowRecord
      );
    } catch (error) {
      throw new DialogShadowJournalError(
        'dialog_shadow_record_invalid',
        { cause: error }
      );
    }
    validateTransition(records, decoded, dialogShadowRecordHash(decoded));
    records.push(decoded);
    if (records.length > maxRecords) throw capacity();
    offset += HEADER_BYTES + payloadBytes;
  }
  return { records, bytesRead: offset };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1
        ? 0xedb8_8320 ^ (value >>> 1)
        : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

async function readAll(handle: FileHandle, target: Buffer): Promise<void> {
  let offset = 0;
  while (offset < target.byteLength) {
    const result = await handle.read(
      target,
      offset,
      target.byteLength - offset,
      offset
    );
    if (result.bytesRead === 0) {
      throw new DialogShadowJournalError('dialog_shadow_read_truncated');
    }
    offset += result.bytesRead;
  }
}

async function writeAll(
  handle: FileHandle,
  source: Buffer,
  position: number
): Promise<void> {
  let offset = 0;
  while (offset < source.byteLength) {
    const result = await handle.write(
      source,
      offset,
      source.byteLength - offset,
      position + offset
    );
    if (result.bytesWritten === 0) {
      throw new DialogShadowJournalError('dialog_shadow_write_stalled');
    }
    offset += result.bytesWritten;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | closeOnExec());
  try {
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, 'EINVAL') && !isNodeError(error, 'ENOTSUP')) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec()
    );
    await handle.close();
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw projectError(error, 'dialog_shadow_path_unsafe');
  }
}

async function assertSafeFile(handle: FileHandle): Promise<void> {
  const stat = await handle.stat();
  const uid = process.getuid?.();
  if (!stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (uid !== undefined && stat.uid !== uid)) {
    throw new DialogShadowJournalError(
      'dialog_shadow_permissions_invalid'
    );
  }
}

function checkedPath(value: unknown): string {
  const result = path.resolve(String(value || ''));
  if (!path.isAbsolute(result) || path.basename(result) === '' ||
      result.includes('\0')) {
    throw new DialogShadowJournalError('dialog_shadow_path_invalid');
  }
  return result;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new DialogShadowJournalError(`dialog_shadow_${field}_invalid`);
  }
  return Number(value);
}

function dialogKey(record: DialogShadowRecord): string {
  return `${record.tenant_id}\0${record.cell_id}\0${record.dialog_id}`;
}

function compareRecords(left: DialogShadowRecord, right: DialogShadowRecord): number {
  return dialogKey(left).localeCompare(dialogKey(right)) ||
    left.owner_epoch - right.owner_epoch ||
    left.sequence - right.sequence;
}

function capacity(): DialogShadowJournalError {
  return new DialogShadowJournalError('dialog_shadow_capacity_exceeded');
}

function projectError(error: unknown, fallback: string): DialogShadowJournalError {
  return error instanceof DialogShadowJournalError
    ? error
    : new DialogShadowJournalError(fallback, { cause: error });
}

function closeOnExec(): number {
  return 'O_CLOEXEC' in constants
    ? Number((constants as Record<string, number>).O_CLOEXEC || 0)
    : 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    'code' in error &&
    String((error as NodeJS.ErrnoException).code) === code;
}
