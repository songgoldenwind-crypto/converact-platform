import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  decodeRustDeskEdgeObservation,
  type RustDeskEdgeObservationInput
} from './rustdesk-edge-observation-contract.js';

export type { RustDeskEdgeObservationInput };

export type RustDeskObservationSpoolState =
  | 'received'
  | 'forwarding'
  | 'forwarded'
  | 'dead_letter';

export interface RustDeskObservationSpoolRecord {
  id: string;
  state: RustDeskObservationSpoolState;
  observation?: RustDeskEdgeObservationInput;
  observation_sha256: string;
  attempt_count: number;
  created_at: string;
  updated_at: string;
  retry_at?: string;
  forwarding_started_at?: string;
  forwarded_at?: string;
  dead_lettered_at?: string;
  last_error_code?: string;
}

export interface RustDeskObservationSpoolOptions {
  directory: string;
  forwarding_lease_ms?: number;
  retry_delay_ms?: number;
  max_attempts?: number;
  max_records?: number;
  max_bytes?: number;
  now?: () => Date;
}

interface RustDeskObservationSpoolDocument {
  version: 1;
  records: RustDeskObservationSpoolRecord[];
}

const RECORDS_FILE = 'records.json';
const LOCK_FILE = '.lock';

export class RustDeskObservationSpool {
  private readonly recordsPath: string;
  private readonly lockPath: string;
  private readonly lockToken = randomUUID();
  private readonly now: () => Date;
  private readonly forwardingLeaseMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private records: RustDeskObservationSpoolRecord[] = [];
  private closed = false;

  private constructor(
    private readonly directory: string,
    options: RustDeskObservationSpoolOptions
  ) {
    this.recordsPath = join(directory, RECORDS_FILE);
    this.lockPath = join(directory, LOCK_FILE);
    this.now = options.now || (() => new Date());
    this.forwardingLeaseMs = bounded(options.forwarding_lease_ms, 60_000, 1_000, 3_600_000, 'forwarding_lease_ms');
    this.retryDelayMs = bounded(options.retry_delay_ms, 5_000, 0, 3_600_000, 'retry_delay_ms');
    this.maxAttempts = bounded(options.max_attempts, 10, 1, 100, 'max_attempts');
    this.maxRecords = bounded(options.max_records, 10_000, 1, 100_000, 'max_records');
    this.maxBytes = bounded(options.max_bytes, 16 * 1_024 * 1_024, 4_096, 256 * 1_024 * 1_024, 'max_bytes');
  }

  static async open(options: RustDeskObservationSpoolOptions): Promise<RustDeskObservationSpool> {
    const directory = String(options.directory || '').trim();
    if (!directory) throw new Error('RustDesk observation spool directory is required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory, 'RustDesk observation spool directory');
    await chmod(directory, 0o700);
    await assertRegularFileOrMissing(join(directory, RECORDS_FILE), 'RustDesk observation records file');
    const spool = new RustDeskObservationSpool(directory, options);
    await spool.acquireLock();
    try {
      await spool.load();
      await spool.recoverExpiredForwarding();
      return spool;
    } catch (error) {
      await spool.close();
      throw error;
    }
  }

  async receive(value: RustDeskEdgeObservationInput): Promise<RustDeskObservationSpoolRecord> {
    this.assertOpen();
    const observation = decodeRustDeskEdgeObservation(value);
    const canonical = canonicalJson(observation);
    const observationSha256 = sha256(canonical);
    const id = `rdobs_${createHash('sha256').update([
      observation.external_id,
      observation.operation_id,
      observation.status,
      observation.source_adapter
    ].join('\u0000')).digest('hex')}`;
    const existing = this.records.find((record) => record.id === id);
    if (existing) {
      if (existing.observation_sha256 !== observationSha256) {
        throw new Error('RustDesk observation idempotency conflict');
      }
      return clone(existing);
    }
    this.makeRoom();
    const now = this.now().toISOString();
    const record: RustDeskObservationSpoolRecord = {
      id,
      state: 'received',
      observation,
      observation_sha256: observationSha256,
      attempt_count: 0,
      created_at: now,
      updated_at: now
    };
    this.records.push(record);
    await this.persist();
    return clone(record);
  }

  async list(): Promise<RustDeskObservationSpoolRecord[]> {
    this.assertOpen();
    return clone(this.records);
  }

  async claimBatch(limitValue: number): Promise<RustDeskObservationSpoolRecord[]> {
    this.assertOpen();
    const limit = bounded(limitValue, 1, 1, 100, 'claim batch limit');
    const now = this.now();
    const claimed = this.records.filter((record) => (
      record.state === 'received' &&
      (!record.retry_at || Date.parse(record.retry_at) <= now.getTime())
    )).slice(0, limit);
    if (!claimed.length) return [];
    for (const record of claimed) {
      record.state = 'forwarding';
      record.attempt_count += 1;
      record.forwarding_started_at = now.toISOString();
      record.updated_at = now.toISOString();
      delete record.retry_at;
      delete record.last_error_code;
    }
    await this.persist();
    return clone(claimed);
  }

  async markForwarded(ids: string[]): Promise<void> {
    this.assertOpen();
    const records = this.forwardingRecords(ids);
    const now = this.now().toISOString();
    for (const record of records) {
      record.state = 'forwarded';
      record.forwarded_at = now;
      record.updated_at = now;
      delete record.observation;
      delete record.forwarding_started_at;
      delete record.last_error_code;
    }
    await this.persist();
  }

  async markFailed(
    ids: string[],
    failure: { retriable: boolean; error_code: string }
  ): Promise<void> {
    this.assertOpen();
    const records = this.forwardingRecords(ids);
    const now = this.now();
    const errorCode = safeErrorCode(failure.error_code);
    for (const record of records) {
      record.last_error_code = errorCode;
      record.updated_at = now.toISOString();
      delete record.forwarding_started_at;
      if (!failure.retriable || record.attempt_count >= this.maxAttempts) {
        record.state = 'dead_letter';
        record.dead_lettered_at = now.toISOString();
        delete record.retry_at;
      } else {
        record.state = 'received';
        record.retry_at = new Date(now.getTime() + this.retryDelayMs).toISOString();
      }
    }
    await this.persist();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const lock = JSON.parse(await readFile(this.lockPath, 'utf8')) as { token?: string };
      if (lock.token === this.lockToken) await unlink(this.lockPath);
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') throw error;
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.recordsPath, 'utf8');
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) {
      throw new Error('RustDesk observation records file exceeds configured size limit');
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('RustDesk observation records file contains invalid JSON');
    }
    this.records = decodeDocument(value, this.maxRecords);
  }

  private async recoverExpiredForwarding(): Promise<void> {
    const now = this.now();
    let changed = false;
    for (const record of this.records) {
      if (
        record.state === 'forwarding' &&
        record.forwarding_started_at &&
        now.getTime() - Date.parse(record.forwarding_started_at) >= this.forwardingLeaseMs
      ) {
        record.state = 'received';
        record.updated_at = now.toISOString();
        delete record.forwarding_started_at;
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private makeRoom(): void {
    if (this.records.length < this.maxRecords) return;
    const terminalIndex = this.records.findIndex((record) => record.state === 'forwarded');
    if (terminalIndex >= 0) {
      this.records.splice(terminalIndex, 1);
      return;
    }
    throw new Error('RustDesk observation spool record limit reached');
  }

  private forwardingRecords(ids: string[]): RustDeskObservationSpoolRecord[] {
    const unique = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!unique.length) throw new Error('RustDesk observation record ids are required');
    const records = unique.map((id) => this.records.find((record) => record.id === id));
    if (records.some((record) => !record || record.state !== 'forwarding')) {
      throw new Error('RustDesk observation record is not forwarding');
    }
    return records as RustDeskObservationSpoolRecord[];
  }

  private async persist(): Promise<void> {
    const document: RustDeskObservationSpoolDocument = { version: 1, records: this.records };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new Error('RustDesk observation records file exceeds configured size limit');
    }
    const temporaryPath = join(this.directory, `.records.tmp-${process.pid}-${randomUUID()}`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.recordsPath);
      await chmod(this.recordsPath, 0o600);
      await syncDirectory(this.directory);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  private async acquireLock(): Promise<void> {
    const payload = `${JSON.stringify({ version: 1, pid: process.pid, token: this.lockToken })}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(payload, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (nodeCode(error) !== 'EEXIST') throw error;
        await assertRegularFile(this.lockPath, 'RustDesk observation spool lock');
        const existing = await readLock(this.lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new Error(`RustDesk observation spool is already locked by a live process: ${existing.pid}`);
        }
        await unlink(this.lockPath).catch((unlinkError) => {
          if (nodeCode(unlinkError) !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('RustDesk observation spool lock could not be acquired');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RustDesk observation spool is closed');
  }
}

function decodeDocument(value: unknown, maxRecords: number): RustDeskObservationSpoolRecord[] {
  const document = strictObject(value, 'RustDesk observation spool document');
  if (document.version !== 1 || !Array.isArray(document.records) || document.records.length > maxRecords) {
    throw new Error('RustDesk observation records schema is unsupported');
  }
  return document.records.map(decodeRecord);
}

function decodeRecord(value: unknown): RustDeskObservationSpoolRecord {
  const record = strictObject(value, 'RustDesk observation spool record');
  const state = String(record.state || '') as RustDeskObservationSpoolState;
  if (!['received', 'forwarding', 'forwarded', 'dead_letter'].includes(state)) {
    throw new Error('RustDesk observation spool record state is unsupported');
  }
  const observation = record.observation === undefined
    ? undefined
    : decodeRustDeskEdgeObservation(record.observation);
  if ((state === 'received' || state === 'forwarding' || state === 'dead_letter') && !observation) {
    throw new Error('RustDesk active observation spool record is missing observation');
  }
  if (state === 'forwarded' && observation) {
    throw new Error('RustDesk forwarded observation spool record must not retain observation');
  }
  const result: RustDeskObservationSpoolRecord = {
    id: required(record.id, 'record id'),
    state,
    ...(observation ? { observation } : {}),
    observation_sha256: digest(record.observation_sha256),
    attempt_count: nonNegativeInteger(record.attempt_count, 'attempt_count'),
    created_at: iso(record.created_at, 'created_at'),
    updated_at: iso(record.updated_at, 'updated_at'),
    ...(record.retry_at ? { retry_at: iso(record.retry_at, 'retry_at') } : {}),
    ...(record.forwarding_started_at ? { forwarding_started_at: iso(record.forwarding_started_at, 'forwarding_started_at') } : {}),
    ...(record.forwarded_at ? { forwarded_at: iso(record.forwarded_at, 'forwarded_at') } : {}),
    ...(record.dead_lettered_at ? { dead_lettered_at: iso(record.dead_lettered_at, 'dead_lettered_at') } : {}),
    ...(record.last_error_code ? { last_error_code: safeErrorCode(record.last_error_code) } : {})
  };
  if (observation && sha256(canonicalJson(observation)) !== result.observation_sha256) {
    throw new Error('RustDesk observation spool record digest mismatch');
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function digest(value: unknown): string {
  const result = String(value || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) throw new Error('RustDesk observation digest is invalid');
  return result;
}

function safeErrorCode(value: unknown): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(result)) throw new Error('RustDesk observation error code is invalid');
  return result;
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function required(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!result || result.length > 512) throw new Error(`RustDesk observation ${name} is invalid`);
  return result;
}

function iso(value: unknown, name: string): string {
  const result = required(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`RustDesk observation ${name} is invalid`);
  return new Date(result).toISOString();
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`RustDesk observation ${name} is invalid`);
  return Number(value);
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number, name: string): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`RustDesk observation ${name} is out of range`);
  }
  return result;
}

async function assertDirectory(path: string, name: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${name} must be a real directory, not a symbolic link`);
}

async function assertRegularFile(path: string, name: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} must not be a symbolic link and must be regular`);
}

async function assertRegularFileOrMissing(path: string, name: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link`);
    if (!stat.isFile()) throw new Error(`${name} must be a regular file`);
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error;
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

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function nodeCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code || '');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
