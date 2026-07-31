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
  assertDialogShadowPair,
  assertDialogShadowRecord,
  dialogShadowPairHash,
  dialogShadowRecordHash,
  type DialogShadowJournalAppendResult,
  type DialogShadowJournalPort,
  type DialogShadowPairAppendResult,
  type DialogShadowRecord
} from './dialog-shadow.js';

const MAGIC = Buffer.from('IVDS', 'ascii');
const VERSION = 1;
const HEADER_BYTES = 16;
const DEFAULT_MAX_RECORDS = 1_000_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 32 * 1024;
const PAIR_FRAME_OVERHEAD_BYTES = 4 * 1024;
const CRC_TABLE = crcTable();

interface DialogShadowPairFrame {
  frame_type: 'dialog_shadow_pair';
  schema_version: 1;
  pair_hash: string;
  records: [DialogShadowRecord, DialogShadowRecord];
}

type DialogShadowPersistedFrame =
  | { frame_type: 'dialog_shadow_record'; record: DialogShadowRecord }
  | DialogShadowPairFrame;

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
  readonly #maxFrameBytes: number;
  #handle: FileHandle | null;
  #records: DialogShadowRecord[];
  #frames: DialogShadowPersistedFrame[];
  #bytes: number;
  #tail: Promise<void> = Promise.resolve();
  #closeRequested = false;

  private constructor(input: {
    path: string;
    handle: FileHandle;
    records: DialogShadowRecord[];
    frames: DialogShadowPersistedFrame[];
    bytes: number;
    maxRecords: number;
    maxBytes: number;
    maxRecordBytes: number;
    maxFrameBytes: number;
  }) {
    this.#path = input.path;
    this.#directory = path.dirname(input.path);
    this.#handle = input.handle;
    this.#records = input.records;
    this.#frames = input.frames;
    this.#bytes = input.bytes;
    this.#maxRecords = input.maxRecords;
    this.#maxBytes = input.maxBytes;
    this.#maxRecordBytes = input.maxRecordBytes;
    this.#maxFrameBytes = input.maxFrameBytes;
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
    const maxFrameBytes = Math.min(
      maxBytes - HEADER_BYTES,
      maxRecordBytes * 2 + PAIR_FRAME_OVERHEAD_BYTES
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
      const decoded = decodeFrames(
        bytes,
        maxRecordBytes,
        maxFrameBytes,
        maxRecords
      );
      if (decoded.bytesRead < stat.size) {
        await handle.truncate(decoded.bytesRead);
        await handle.sync();
      }
      return new DialogShadowJournal({
        path: journalPath,
        handle,
        records: decoded.records,
        frames: decoded.frames,
        bytes: decoded.bytesRead,
        maxRecords,
        maxBytes,
        maxRecordBytes,
        maxFrameBytes
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
      this.#frames.push({
        frame_type: 'dialog_shadow_record',
        record
      });
      this.#bytes += frame.byteLength;
      return { status: 'committed', record_hash: hash };
    });
  }

  appendPair(
    values: readonly [DialogShadowRecord, DialogShadowRecord]
  ): Promise<DialogShadowPairAppendResult> {
    return this.#enqueue(async () => {
      const records = assertDialogShadowPair(values);
      const pairHash = dialogShadowPairHash(records);
      const recordHashes = records.map(dialogShadowRecordHash).sort();
      const transitions = validatePairTransitions(this.#records, records);
      if (transitions.every((transition) => transition === 'replayed') &&
          this.#frames.some((frame) =>
            frame.frame_type === 'dialog_shadow_pair' &&
            frame.pair_hash === pairHash
          )) {
        return {
          status: 'replayed',
          pair_hash: pairHash,
          record_hashes: recordHashes
        };
      }
      const frame = encodePairFrame(
        {
          frame_type: 'dialog_shadow_pair',
          schema_version: 1,
          pair_hash: pairHash,
          records
        },
        this.#maxRecordBytes,
        this.#maxFrameBytes
      );
      const appendCount = transitions.filter(
        (transition) => transition === 'append'
      ).length;
      if (this.#records.length + appendCount > this.#maxRecords ||
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
        throw projectError(error, 'dialog_shadow_pair_append_failed');
      }
      for (const [index, transition] of transitions.entries()) {
        if (transition === 'append') this.#records.push(records[index]!);
      }
      this.#frames.push({
        frame_type: 'dialog_shadow_pair',
        schema_version: 1,
        pair_hash: pairHash,
        records
      });
      this.#bytes += frame.byteLength;
      return {
        status: 'committed',
        pair_hash: pairHash,
        record_hashes: recordHashes
      };
    });
  }

  replay(): Promise<DialogShadowRecord[]> {
    return this.#enqueue(async () => structuredClone(this.#records));
  }

  latestRecoveryPair(input: {
    tenant_id: string;
    cell_id: string;
    call_session_ref: string;
    owner_node_id?: string;
    owner_epoch?: number;
    takeover_id?: string;
  }): Promise<DialogShadowRecord[]> {
    const tenantId = journalIdentifier(input.tenant_id);
    const cellId = journalIdentifier(input.cell_id);
    const callSessionRef = journalIdentifier(input.call_session_ref);
    const ownerNodeId = input.owner_node_id === undefined
      ? undefined
      : journalIdentifier(input.owner_node_id);
    const ownerEpoch = input.owner_epoch === undefined
      ? undefined
      : boundedInteger(input.owner_epoch, 1, 0xffff_ffff, 'ownerEpoch');
    const takeoverId = input.takeover_id === undefined
      ? undefined
      : journalIdentifier(input.takeover_id);
    return this.#enqueue(async () => {
      return structuredClone(latestRecoveryFrame(
        this.#frames,
        tenantId,
        cellId,
        callSessionRef,
        { owner_node_id: ownerNodeId, owner_epoch: ownerEpoch, takeover_id: takeoverId }
      ));
    });
  }

  resolveRecoveryPair(input: {
    tenant_id: string;
    cell_id: string;
    dialog_id: string;
  }): Promise<{
    call_session_ref: string;
    records: DialogShadowRecord[];
  } | null> {
    const tenantId = journalIdentifier(input.tenant_id);
    const cellId = journalIdentifier(input.cell_id);
    const dialogId = journalIdentifier(input.dialog_id);
    return this.#enqueue(async () => {
      const matched = [...this.#frames].reverse()
        .filter(isPersistedPairFrame)
        .flatMap((frame) => frame.records)
        .find((record) =>
          record.schema_version === 2 &&
          record.tenant_id === tenantId &&
          record.cell_id === cellId &&
          record.dialog_id === dialogId &&
          record.provider_session_ref !== null
        );
      if (!matched?.provider_session_ref) return null;
      const latest = latestRecoveryFrame(
        this.#frames,
        tenantId,
        cellId,
        matched.provider_session_ref
      );
      return {
        call_session_ref: matched.provider_session_ref,
        records: structuredClone(latest)
      };
    });
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
      const latestHashes = new Map(
        [...latest.entries()].map(([key, record]) => [
          key,
          dialogShadowRecordHash(record)
        ])
      );
      const retainedFrames = this.#frames.filter((frame) =>
        frameRecords(frame).some((record) =>
          latestHashes.get(dialogKey(record)) === dialogShadowRecordHash(record)
        )
      );
      const retained = retainedFrames.flatMap(frameRecords)
        .filter((record, index, records) =>
          records.findIndex((candidate) =>
            dialogKey(candidate) === dialogKey(record) &&
            dialogShadowRecordHash(candidate) === dialogShadowRecordHash(record)
          ) === index
        )
        .sort(compareRecords);
      if (retainedFrames.length === this.#frames.length) {
        return {
          removed_records: 0,
          retained_records: retained.length
        };
      }
      const frames = retainedFrames.map(
        (frame) => frame.frame_type === 'dialog_shadow_pair'
          ? encodePairFrame(frame, this.#maxRecordBytes, this.#maxFrameBytes)
          : encodeFrame(frame.record, this.#maxRecordBytes)
      );
      const bytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
      if (retained.length > this.#maxRecords || bytes > this.#maxBytes) {
        throw capacity();
      }
      await this.#replace(frames);
      const removed = this.#records.length - retained.length;
      this.#records = retained;
      this.#frames = retainedFrames;
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

function journalIdentifier(value: unknown): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result)) {
    throw new DialogShadowJournalError('dialog_shadow_recovery_query_invalid');
  }
  return result;
}

function latestRecoveryFrame(
  frames: DialogShadowPersistedFrame[],
  tenantId: string,
  cellId: string,
  callSessionRef: string,
  filter: {
    owner_node_id?: string;
    owner_epoch?: number;
    takeover_id?: string;
  } = {}
): DialogShadowRecord[] {
  const eligible = frames.filter(isPersistedPairFrame).filter((frame) =>
    frame.records.every((record) =>
      record.schema_version === 2 &&
      record.tenant_id === tenantId &&
      record.cell_id === cellId &&
      record.provider_session_ref === callSessionRef &&
      (filter.owner_node_id === undefined ||
       record.owner_node_id === filter.owner_node_id) &&
      (filter.owner_epoch === undefined ||
       record.owner_epoch === filter.owner_epoch) &&
      (filter.takeover_id === undefined ||
       record.takeover_id === filter.takeover_id)
    )
  );
  const latest = eligible.sort((left, right) =>
    left.records[0].owner_epoch - right.records[0].owner_epoch ||
    left.records[0].sequence - right.records[0].sequence ||
    left.pair_hash.localeCompare(right.pair_hash)
  ).at(-1);
  return latest
    ? [...latest.records].sort(
      (left, right) => left.dialog_id.localeCompare(right.dialog_id)
    )
    : [];
}

function isPersistedPairFrame(
  frame: DialogShadowPersistedFrame
): frame is DialogShadowPairFrame {
  return frame.frame_type === 'dialog_shadow_pair';
}

function frameRecords(frame: DialogShadowPersistedFrame): DialogShadowRecord[] {
  return frame.frame_type === 'dialog_shadow_pair'
    ? [...frame.records]
    : [frame.record];
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

function encodePairFrame(
  value: DialogShadowPairFrame,
  maxRecordBytes: number,
  maxFrameBytes: number
): Buffer {
  const records = assertDialogShadowPair(value.records);
  const pairHash = dialogShadowPairHash(records);
  if (value.schema_version !== 1 ||
      value.frame_type !== 'dialog_shadow_pair' ||
      value.pair_hash !== pairHash ||
      records.some((record) =>
        Buffer.byteLength(JSON.stringify(record), 'utf8') > maxRecordBytes
      )) {
    throw new DialogShadowJournalError('dialog_shadow_pair_frame_invalid');
  }
  return encodeRawFrame({
    frame_type: 'dialog_shadow_pair',
    schema_version: 1,
    pair_hash: pairHash,
    records
  }, maxFrameBytes, 'dialog_shadow_pair_too_large');
}

function encodeRawFrame(
  value: unknown,
  maximumBytes: number,
  tooLargeCode: string
): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.byteLength > maximumBytes) {
    throw new DialogShadowJournalError(tooLargeCode);
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
  maxFrameBytes: number,
  maxRecords: number
): {
  records: DialogShadowRecord[];
  frames: DialogShadowPersistedFrame[];
  bytesRead: number;
} {
  const records: DialogShadowRecord[] = [];
  const frames: DialogShadowPersistedFrame[] = [];
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
        payloadBytes === 0 || payloadBytes > maxFrameBytes) {
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
    let decoded: unknown;
    try {
      decoded = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      throw new DialogShadowJournalError(
        'dialog_shadow_record_invalid',
        { cause: error }
      );
    }
    if (isPairFrame(decoded)) {
      const pair = decodePairFrame(decoded, maxRecordBytes);
      const transitions = validatePairTransitions(records, pair.records);
      for (const [index, transition] of transitions.entries()) {
        if (transition === 'append') records.push(pair.records[index]!);
      }
      frames.push(pair);
    } else {
      if (payloadBytes > maxRecordBytes) {
        throw new DialogShadowJournalError('dialog_shadow_record_too_large');
      }
      const record = assertDialogShadowRecord(decoded as DialogShadowRecord);
      const transition = validateTransition(
        records,
        record,
        dialogShadowRecordHash(record)
      );
      if (transition === 'append') records.push(record);
      frames.push({
        frame_type: 'dialog_shadow_record',
        record
      });
    }
    if (records.length > maxRecords) throw capacity();
    offset += HEADER_BYTES + payloadBytes;
  }
  return { records, frames, bytesRead: offset };
}

function isPairFrame(value: unknown): value is DialogShadowPairFrame {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).frame_type === 'dialog_shadow_pair'
  );
}

function decodePairFrame(
  value: DialogShadowPairFrame,
  maxRecordBytes: number
): DialogShadowPairFrame {
  const keys = Object.keys(value).sort();
  const expected = ['frame_type', 'schema_version', 'pair_hash', 'records'].sort();
  if (keys.length !== expected.length ||
      keys.some((key, index) => key !== expected[index]) ||
      value.schema_version !== 1 ||
      !/^[a-f0-9]{64}$/.test(String(value.pair_hash || '')) ||
      !Array.isArray(value.records) ||
      value.records.length !== 2) {
    throw new DialogShadowJournalError('dialog_shadow_pair_frame_invalid');
  }
  const records = assertDialogShadowPair(
    value.records as [DialogShadowRecord, DialogShadowRecord]
  );
  if (records.some((record) =>
    Buffer.byteLength(JSON.stringify(record), 'utf8') > maxRecordBytes
  ) || dialogShadowPairHash(records) !== value.pair_hash) {
    throw new DialogShadowJournalError('dialog_shadow_pair_frame_invalid');
  }
  return { ...value, records };
}

function validatePairTransitions(
  existing: DialogShadowRecord[],
  pair: readonly [DialogShadowRecord, DialogShadowRecord]
): Array<'append' | 'replayed'> {
  const projected = [...existing];
  const transitions: Array<'append' | 'replayed'> = [];
  for (const record of pair) {
    const transition = validateTransition(
      projected,
      record,
      dialogShadowRecordHash(record)
    );
    transitions.push(transition);
    if (transition === 'append') projected.push(record);
  }
  return transitions;
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
