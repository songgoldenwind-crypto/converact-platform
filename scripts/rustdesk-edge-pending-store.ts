import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink
} from 'node:fs/promises';
import { join } from 'node:path';

import type {
  RustDeskEdgeClaimCommand,
  RustDeskEdgeCommandExecutionResult,
  RustDeskEdgeCommandProgressReport
} from './rustdesk-edge-command.js';

export interface RustDeskEdgeSpoolCommand extends Omit<RustDeskEdgeClaimCommand, 'lease_expires_at'> {}

export interface RustDeskEdgeExecutingRecord {
  version: 1;
  state: 'executing';
  edge_instance_id: string;
  device_id: string;
  command: RustDeskEdgeSpoolCommand;
  progress: RustDeskEdgeCommandProgressReport[];
  created_at: string;
  updated_at: string;
}

export interface RustDeskEdgeExecutedRecord extends Omit<RustDeskEdgeExecutingRecord, 'state'> {
  state: 'executed';
  result: RustDeskEdgeCommandExecutionResult;
}

export type RustDeskEdgePendingRecord = RustDeskEdgeExecutingRecord | RustDeskEdgeExecutedRecord;

export interface RustDeskEdgePendingFileStoreOptions {
  directory: string;
  max_bytes?: number;
  max_age_ms?: number;
  max_quarantine_records?: number;
  now?: () => Date;
}

type ExecutingInput = Omit<RustDeskEdgeExecutingRecord, 'version' | 'state' | 'created_at' | 'updated_at'>;
type ExecutedInput = Omit<RustDeskEdgeExecutedRecord, 'version' | 'state' | 'created_at' | 'updated_at'>;

const ACTIVE_FILE = 'active.json';
const LOCK_FILE = '.lock';
const QUARANTINE_DIR = 'quarantine';
const DEFAULT_MAX_BYTES = 64 * 1_024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_QUARANTINE = 100;

export class RustDeskEdgePendingFileStore {
  private readonly activePath: string;
  private readonly lockPath: string;
  private readonly quarantinePath: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxQuarantineRecords: number;
  private readonly now: () => Date;
  private readonly lockToken = randomUUID();
  private closed = false;

  private constructor(private readonly directory: string, options: RustDeskEdgePendingFileStoreOptions) {
    this.activePath = join(directory, ACTIVE_FILE);
    this.lockPath = join(directory, LOCK_FILE);
    this.quarantinePath = join(directory, QUARANTINE_DIR);
    this.maxBytes = bounded(options.max_bytes, DEFAULT_MAX_BYTES, 1_024, 1_048_576, 'max_bytes');
    this.maxAgeMs = bounded(options.max_age_ms, DEFAULT_MAX_AGE_MS, 1_000, 365 * 24 * 60 * 60 * 1_000, 'max_age_ms');
    this.maxQuarantineRecords = bounded(
      options.max_quarantine_records,
      DEFAULT_MAX_QUARANTINE,
      1,
      10_000,
      'max_quarantine_records'
    );
    this.now = options.now || (() => new Date());
  }

  static async open(options: RustDeskEdgePendingFileStoreOptions): Promise<RustDeskEdgePendingFileStore> {
    const directory = String(options.directory || '').trim();
    if (!directory) throw new Error('RustDesk edge spool directory is required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertDirectory(directory, 'RustDesk edge spool directory');
    await chmod(directory, 0o700);
    await mkdir(join(directory, QUARANTINE_DIR), { recursive: true, mode: 0o700 });
    await assertDirectory(join(directory, QUARANTINE_DIR), 'RustDesk edge spool quarantine directory');
    await chmod(join(directory, QUARANTINE_DIR), 0o700);
    const store = new RustDeskEdgePendingFileStore(directory, options);
    await store.acquireLock();
    return store;
  }

  async load(): Promise<RustDeskEdgePendingRecord | null> {
    this.assertOpen();
    await assertRegularFileOrMissing(this.activePath, 'RustDesk edge spool active record');
    let raw: string;
    try {
      raw = await readFile(this.activePath, 'utf8');
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return null;
      throw error;
    }
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) {
      throw new Error('RustDesk edge spool record exceeds configured size limit');
    }
    const record = decodeRecord(raw);
    return record;
  }

  isExpired(record: RustDeskEdgePendingRecord): boolean {
    return this.now().getTime() - Date.parse(record.updated_at) > this.maxAgeMs;
  }

  async writeExecuting(input: ExecutingInput): Promise<RustDeskEdgeExecutingRecord> {
    this.assertOpen();
    const now = this.now().toISOString();
    const record: RustDeskEdgeExecutingRecord = {
      version: 1,
      state: 'executing',
      edge_instance_id: required(input.edge_instance_id, 'edge_instance_id'),
      device_id: required(input.device_id, 'device_id'),
      command: spoolCommand(input.command),
      progress: progressReports(input.progress),
      created_at: now,
      updated_at: now
    };
    await this.writeActive(record);
    return record;
  }

  async writeExecuted(input: ExecutedInput): Promise<RustDeskEdgeExecutedRecord> {
    this.assertOpen();
    const current = await this.load();
    const command = spoolCommand(input.command);
    if (current && current.command.id !== command.id) {
      throw new Error('RustDesk edge spool already contains another command');
    }
    const now = this.now().toISOString();
    const record: RustDeskEdgeExecutedRecord = {
      version: 1,
      state: 'executed',
      edge_instance_id: required(input.edge_instance_id, 'edge_instance_id'),
      device_id: required(input.device_id, 'device_id'),
      command,
      progress: progressReports(input.progress),
      result: executionResult(input.result),
      created_at: current?.created_at || now,
      updated_at: now
    };
    await this.writeActive(record);
    return record;
  }

  async remove(commandId?: string): Promise<void> {
    this.assertOpen();
    if (commandId) {
      const current = await this.load();
      if (current && current.command.id !== commandId) {
        throw new Error('RustDesk edge spool command does not match removal request');
      }
    }
    await unlink(this.activePath).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
  }

  async quarantine(reasonValue: string): Promise<string | null> {
    this.assertOpen();
    const record = await this.load();
    if (!record) return null;
    return this.quarantineRecord(record, reasonValue);
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

  private async acquireLock(): Promise<void> {
    const payload = `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: this.lockToken,
      created_at: this.now().toISOString()
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
        await assertRegularFile(this.lockPath, 'RustDesk edge spool lock');
        const existing = await readLock(this.lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new Error(`RustDesk edge spool is already locked by a live process: ${existing.pid}`);
        }
        await unlink(this.lockPath).catch((unlinkError) => {
          if (nodeCode(unlinkError) !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('RustDesk edge spool lock could not be acquired');
  }

  private async writeActive(record: RustDeskEdgePendingRecord): Promise<void> {
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    assertNoForbiddenFields(JSON.parse(serialized));
    if (Buffer.byteLength(serialized, 'utf8') > this.maxBytes) {
      throw new Error('RustDesk edge spool record exceeds configured size limit');
    }
    const temporaryPath = join(this.directory, `.active.tmp-${process.pid}-${randomUUID()}`);
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, this.activePath);
      await chmod(this.activePath, 0o600);
      await syncDirectory(this.directory);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  private async quarantineRecord(record: RustDeskEdgePendingRecord, reasonValue: string): Promise<string> {
    const reason = required(reasonValue, 'quarantine reason').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    const name = `${this.now().toISOString().replace(/[:.]/g, '-')}-${safeFilePart(record.command.id)}-${randomUUID()}.json`;
    const path = join(this.quarantinePath, name);
    const payload = {
      ...record,
      quarantine_reason: reason,
      quarantined_at: this.now().toISOString()
    };
    await writePrivateFile(path, `${JSON.stringify(payload, null, 2)}\n`, this.maxBytes);
    await unlink(this.activePath).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
    await syncDirectory(this.quarantinePath);
    await syncDirectory(this.directory);
    await this.trimQuarantine();
    return path;
  }

  private async trimQuarantine(): Promise<void> {
    const names = (await readdir(this.quarantinePath)).filter((name) => name.endsWith('.json')).sort();
    const remove = names.slice(0, Math.max(0, names.length - this.maxQuarantineRecords));
    for (const name of remove) await unlink(join(this.quarantinePath, name));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RustDesk edge spool is closed');
  }
}

async function writePrivateFile(path: string, value: string, maxBytes: number): Promise<void> {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new Error('RustDesk edge spool record exceeds configured size limit');
  }
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
}

function decodeRecord(raw: string): RustDeskEdgePendingRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('RustDesk edge spool record is invalid JSON');
  }
  assertNoForbiddenFields(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('RustDesk edge spool record must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || (record.state !== 'executing' && record.state !== 'executed')) {
    throw new Error('RustDesk edge spool record version or state is unsupported');
  }
  const base = {
    version: 1 as const,
    edge_instance_id: required(record.edge_instance_id, 'edge_instance_id'),
    device_id: required(record.device_id, 'device_id'),
    command: spoolCommand(record.command),
    progress: progressReports(record.progress),
    created_at: iso(record.created_at, 'created_at'),
    updated_at: iso(record.updated_at, 'updated_at')
  };
  return record.state === 'executed'
    ? { ...base, state: 'executed', result: executionResult(record.result) }
    : { ...base, state: 'executing' };
}

function spoolCommand(value: unknown): RustDeskEdgeSpoolCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('spool command is required');
  const command = value as Record<string, unknown>;
  const attempt = Number(command.attempt);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('spool command attempt is invalid');
  const reason = String(command.requested_reason || '') as RustDeskEdgeSpoolCommand['requested_reason'];
  if (!['consent_revoked', 'remote_session_ended', 'tool_ended', 'gateway_ended'].includes(reason)) {
    throw new Error('spool command requested_reason is invalid');
  }
  if (command.command_type !== 'disconnect_session') throw new Error('spool command type is invalid');
  return {
    id: required(command.id, 'command.id'),
    command_type: 'disconnect_session',
    external_id: required(command.external_id, 'command.external_id'),
    target_id: required(command.target_id, 'command.target_id'),
    rustdesk_id: required(command.rustdesk_id, 'command.rustdesk_id'),
    requested_reason: reason,
    attempt
  };
}

function progressReports(value: unknown): RustDeskEdgeCommandProgressReport[] {
  if (!Array.isArray(value)) throw new Error('spool progress must be an array');
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('spool progress is invalid');
    const report = item as Record<string, unknown>;
    if (report.progress !== 'session_adapter_failed' && report.progress !== 'fallback_started') {
      throw new Error('spool progress type is invalid');
    }
    return {
      progress: report.progress,
      ...(report.exit_code === undefined ? {} : { exit_code: integer(report.exit_code, 'progress.exit_code') }),
      ...(report.duration_ms === undefined ? {} : { duration_ms: nonNegative(report.duration_ms, 'progress.duration_ms') }),
      metadata: scalarMetadata(report.metadata)
    };
  });
}

function executionResult(value: unknown): RustDeskEdgeCommandExecutionResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('spool result is required');
  const result = value as Record<string, unknown>;
  if (result.status !== 'succeeded' && result.status !== 'failed') throw new Error('spool result status is invalid');
  if (result.execution_method !== 'session_adapter' && result.execution_method !== 'service_restart') {
    throw new Error('spool execution method is invalid');
  }
  return {
    status: result.status,
    execution_method: result.execution_method,
    ...(result.exit_code === undefined ? {} : { exit_code: integer(result.exit_code, 'result.exit_code') }),
    duration_ms: nonNegative(result.duration_ms, 'result.duration_ms'),
    stdout_bytes: nonNegative(result.stdout_bytes, 'result.stdout_bytes'),
    stderr_bytes: nonNegative(result.stderr_bytes, 'result.stderr_bytes'),
    stdout_sha256: sha256(result.stdout_sha256, 'result.stdout_sha256'),
    stderr_sha256: sha256(result.stderr_sha256, 'result.stderr_sha256'),
    metadata: scalarMetadata(result.metadata)
  };
}

function scalarMetadata(value: unknown): Record<string, string | number | boolean | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new Error('spool metadata key is invalid');
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
      throw new Error('spool metadata value is invalid');
    }
    result[key] = item as string | number | boolean | null;
  }
  return result;
}

function assertNoForbiddenFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertNoForbiddenFields(item);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|authorization|api_?key|^stdout$|^stderr$/i.test(key)) {
      throw new Error(`RustDesk edge spool contains forbidden field: ${key}`);
    }
    assertNoForbiddenFields(item);
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

function required(value: unknown, field: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 256) throw new Error(`${field} is invalid`);
  return normalized;
}

function iso(value: unknown, field: string): string {
  const normalized = String(value || '');
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${field} is invalid`);
  return new Date(normalized).toISOString();
}

function integer(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${field} is invalid`);
  return parsed;
}

function nonNegative(value: unknown, field: string): number {
  const parsed = integer(value, field);
  if (parsed < 0) throw new Error(`${field} is invalid`);
  return parsed;
}

function sha256(value: unknown, field: string): string {
  const normalized = String(value || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number, field: string): number {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return resolved;
}

function nodeCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symbolic link`);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file, not a symbolic link`);
  }
}

async function assertRegularFileOrMissing(path: string, label: string): Promise<void> {
  try {
    await assertRegularFile(path, label);
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error;
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

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'command';
}
