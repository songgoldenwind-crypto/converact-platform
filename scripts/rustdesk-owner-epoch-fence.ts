import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink
} from 'node:fs/promises';
import { join } from 'node:path';

export interface RustDeskOwnerIdentity {
  interaction_id: string;
  reservation_id: string;
  owner_epoch: string;
}

export interface RustDeskOwnerEpochCommand extends RustDeskOwnerIdentity {
  external_id: string;
  command_id: string;
}

export interface RustDeskOwnerEpochFenceOptions {
  directory: string;
}

interface OwnerEpochRecord extends RustDeskOwnerIdentity {
  schema_version: 2;
  external_id: string;
  command_ids: string[];
  updated_at: string;
}

interface LegacyOwnerEpochRecord extends RustDeskOwnerIdentity {
  external_id: string;
  command_ids: string[];
  updated_at: string;
}

interface LegacyOwnerEpochDocument {
  schema_version: 1;
  records: LegacyOwnerEpochRecord[];
}

const RECORDS_DIR = 'owner-epochs';
const LEGACY_STATE_FILE = 'owner-epochs.json';
const LOCK_FILE = '.owner-epochs.lock';
const MAX_LEGACY_STATE_BYTES = 4 * 1_024 * 1_024;
const MAX_RECORD_BYTES = 64 * 1_024;
const MAX_COMMAND_IDS = 64;
const MAX_LEGACY_RECORDS = 100_000;

export function assertRustDeskOwnerBinding(
  commandValue: RustDeskOwnerIdentity | undefined,
  boundValue: RustDeskOwnerIdentity | undefined,
  placementEnabled: boolean
): void {
  if (!commandValue && !boundValue) {
    if (placementEnabled) throw new Error('rustdesk_owner_binding_required');
    return;
  }
  if (!commandValue || !boundValue) throw new Error('rustdesk_owner_binding_mismatch');
  const command = ownerIdentity(commandValue);
  const bound = ownerIdentity(boundValue);
  if (
    command.interaction_id !== bound.interaction_id ||
    command.reservation_id !== bound.reservation_id ||
    command.owner_epoch !== bound.owner_epoch
  ) {
    throw new Error('rustdesk_owner_binding_mismatch');
  }
}

export class RustDeskOwnerEpochFence {
  private readonly recordsPath: string;
  private readonly legacyStatePath: string;
  private readonly lockPath: string;
  private readonly lockToken = randomUUID();
  private closed = false;
  private operation = Promise.resolve();

  private constructor(private readonly directory: string) {
    this.recordsPath = join(directory, RECORDS_DIR);
    this.legacyStatePath = join(directory, LEGACY_STATE_FILE);
    this.lockPath = join(directory, LOCK_FILE);
  }

  static async open(options: RustDeskOwnerEpochFenceOptions): Promise<RustDeskOwnerEpochFence> {
    const directory = required(options.directory, 'RustDesk owner epoch directory is required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory, 'RustDesk owner epoch directory');
    await chmod(directory, 0o700);
    await mkdir(join(directory, RECORDS_DIR), { recursive: true, mode: 0o700 });
    await assertDirectory(join(directory, RECORDS_DIR), 'RustDesk owner epoch records directory');
    await chmod(join(directory, RECORDS_DIR), 0o700);
    const fence = new RustDeskOwnerEpochFence(directory);
    await fence.acquireLock();
    try {
      await fence.migrateLegacyState();
      return fence;
    } catch (error) {
      await fence.close();
      throw error;
    }
  }

  accept(value: RustDeskOwnerEpochCommand): Promise<'accepted' | 'replayed'> {
    this.assertOpen();
    const run = this.operation.then(() => this.acceptSerialized(value));
    this.operation = run.then(() => undefined, () => undefined);
    return run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.operation;
    try {
      const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token?: string };
      if (lock.token === this.lockToken) await unlink(this.lockPath);
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') throw error;
    }
  }

  private async acceptSerialized(value: RustDeskOwnerEpochCommand): Promise<'accepted' | 'replayed'> {
    const command = {
      external_id: identifier(value.external_id, 'external_id'),
      command_id: identifier(value.command_id, 'command_id'),
      ...ownerIdentity(value)
    };
    const current = await this.readRecord(command.external_id);
    if (current) {
      if (current.interaction_id !== command.interaction_id) {
        throw new Error('rustdesk_owner_interaction_conflict');
      }
      const comparison = compareEpoch(command.owner_epoch, current.owner_epoch);
      if (comparison < 0) throw new Error('stale_rustdesk_owner_epoch');
      if (comparison === 0 && current.reservation_id !== command.reservation_id) {
        throw new Error('rustdesk_owner_epoch_conflict');
      }
      if (comparison === 0 && current.command_ids.includes(command.command_id)) return 'replayed';
      await this.writeRecord({
        schema_version: 2,
        external_id: command.external_id,
        interaction_id: command.interaction_id,
        reservation_id: command.reservation_id,
        owner_epoch: command.owner_epoch,
        command_ids: comparison > 0
          ? [command.command_id]
          : [...current.command_ids, command.command_id].slice(-MAX_COMMAND_IDS),
        updated_at: new Date().toISOString()
      });
      return 'accepted';
    }
    await this.writeRecord({
      schema_version: 2,
      external_id: command.external_id,
      interaction_id: command.interaction_id,
      reservation_id: command.reservation_id,
      owner_epoch: command.owner_epoch,
      command_ids: [command.command_id],
      updated_at: new Date().toISOString()
    });
    return 'accepted';
  }

  private async acquireLock(): Promise<void> {
    const payload = `${JSON.stringify({
      schema_version: 1,
      pid: process.pid,
      token: this.lockToken,
      created_at: new Date().toISOString()
    })}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(payload, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(this.lockPath, 0o600);
        return;
      } catch (error) {
        if (nodeCode(error) !== 'EEXIST') throw error;
        await assertRegularFile(this.lockPath, 'RustDesk owner epoch lock');
        const existing = await readLock(this.lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new Error(
            `RustDesk owner epoch fence is already locked by a live process: ${existing.pid}`
          );
        }
        await unlink(this.lockPath).catch((unlinkError) => {
          if (nodeCode(unlinkError) !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('RustDesk owner epoch fence lock could not be acquired');
  }

  private async migrateLegacyState(): Promise<void> {
    let raw: string;
    try {
      const stat = await lstat(this.legacyStatePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_LEGACY_STATE_BYTES) {
        throw new Error('RustDesk legacy owner epoch state file is invalid');
      }
      raw = await readFile(this.legacyStatePath, 'utf8');
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }

    for (const legacy of decodeLegacyDocument(raw).records) {
      const current = await this.readRecord(legacy.external_id);
      const record = mergeLegacyRecord(current, legacy);
      if (record) await this.writeRecord(record);
    }
    await unlink(this.legacyStatePath);
    await syncDirectory(this.directory);
  }

  private async readRecord(externalId: string): Promise<OwnerEpochRecord | null> {
    const path = this.recordPath(externalId);
    let raw: string;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_RECORD_BYTES) {
        throw new Error('RustDesk owner epoch record file is invalid');
      }
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return null;
      throw error;
    }
    const record = decodeRecord(raw);
    if (record.external_id !== externalId) {
      throw new Error('RustDesk owner epoch record identity does not match its shard');
    }
    return record;
  }

  private async writeRecord(record: OwnerEpochRecord): Promise<void> {
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) {
      throw new Error('RustDesk owner epoch record exceeds its size limit');
    }
    const target = this.recordPath(record.external_id);
    const temporary = join(
      this.recordsPath,
      `.${recordFileName(record.external_id)}.${process.pid}.${randomUUID()}.tmp`
    );
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
      await chmod(target, 0o600);
      await syncDirectory(this.recordsPath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private recordPath(externalId: string): string {
    return join(this.recordsPath, recordFileName(externalId));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RustDesk owner epoch fence is closed');
  }
}

function decodeRecord(raw: string): OwnerEpochRecord {
  const value = parseJson(raw, 'RustDesk owner epoch record');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RustDesk owner epoch record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 2) {
    throw new Error('RustDesk owner epoch record schema is unsupported');
  }
  return {
    schema_version: 2,
    external_id: identifier(record.external_id, 'external_id'),
    ...ownerIdentity(record),
    command_ids: commandIds(record.command_ids),
    updated_at: iso(record.updated_at, 'updated_at')
  };
}

function decodeLegacyDocument(raw: string): LegacyOwnerEpochDocument {
  const value = parseJson(raw, 'RustDesk legacy owner epoch state');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RustDesk legacy owner epoch state must be an object');
  }
  const document = value as Record<string, unknown>;
  if (
    document.schema_version !== 1 ||
    !Array.isArray(document.records) ||
    document.records.length > MAX_LEGACY_RECORDS
  ) {
    throw new Error('RustDesk legacy owner epoch state schema is unsupported');
  }
  const seen = new Set<string>();
  const records = document.records.map((rawRecord) => {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) {
      throw new Error('RustDesk legacy owner epoch record is invalid');
    }
    const record = rawRecord as Record<string, unknown>;
    const externalId = identifier(record.external_id, 'external_id');
    if (seen.has(externalId)) throw new Error('RustDesk legacy owner epoch record is duplicated');
    seen.add(externalId);
    return {
      external_id: externalId,
      ...ownerIdentity(record),
      command_ids: commandIds(record.command_ids),
      updated_at: iso(record.updated_at, 'updated_at')
    };
  });
  return { schema_version: 1, records };
}

function mergeLegacyRecord(
  current: OwnerEpochRecord | null,
  legacy: LegacyOwnerEpochRecord
): OwnerEpochRecord | null {
  if (!current) return { schema_version: 2, ...legacy };
  if (current.interaction_id !== legacy.interaction_id) {
    throw new Error('rustdesk_owner_interaction_conflict');
  }
  const comparison = compareEpoch(legacy.owner_epoch, current.owner_epoch);
  if (comparison < 0) return null;
  if (comparison === 0 && legacy.reservation_id !== current.reservation_id) {
    throw new Error('rustdesk_owner_epoch_conflict');
  }
  if (comparison > 0) return { schema_version: 2, ...legacy };
  return {
    ...current,
    command_ids: [...new Set([...current.command_ids, ...legacy.command_ids])].slice(-MAX_COMMAND_IDS),
    updated_at: Date.parse(current.updated_at) >= Date.parse(legacy.updated_at)
      ? current.updated_at
      : legacy.updated_at
  };
}

function ownerIdentity(value: RustDeskOwnerIdentity | Record<string, unknown>): RustDeskOwnerIdentity {
  return {
    interaction_id: identifier(value.interaction_id, 'interaction_id'),
    reservation_id: identifier(value.reservation_id, 'reservation_id'),
    owner_epoch: epoch(value.owner_epoch)
  };
}

function commandIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_IDS) {
    throw new Error('RustDesk owner epoch command history is invalid');
  }
  const result = value.map((item) => identifier(item, 'command_id'));
  if (new Set(result).size !== result.length) {
    throw new Error('RustDesk owner epoch command history is duplicated');
  }
  return result;
}

function recordFileName(externalId: string): string {
  return `${createHash('sha256').update(externalId, 'utf8').digest('hex')}.json`;
}

function compareEpoch(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function epoch(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!/^[1-9][0-9]{0,19}$/.test(normalized)) {
    throw new Error('RustDesk owner_epoch is invalid');
  }
  return BigInt(normalized).toString();
}

function identifier(value: unknown, name: string): string {
  const normalized = required(value, `RustDesk owner epoch ${name} is required`);
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(normalized)) {
    throw new Error(`RustDesk owner epoch ${name} is invalid`);
  }
  return normalized;
}

function iso(value: unknown, name: string): string {
  const normalized = required(value, `RustDesk owner epoch ${name} is required`);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`RustDesk owner epoch ${name} is invalid`);
  }
  return new Date(normalized).toISOString();
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} is invalid JSON`);
  }
}

async function readLock(path: string): Promise<{ pid: number } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    const pid = Number(value.pid);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return nodeCode(error) === 'EPERM';
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(nodeCode(error))) throw error;
  } finally {
    await handle?.close();
  }
}

function required(value: unknown, message: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(message);
  return normalized;
}

function nodeCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code || '');
}
