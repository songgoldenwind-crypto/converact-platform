import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile as nodeCopyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';

import { requireRustDeskNativeEvidencePolicy } from './rustdesk-native-evidence-policy.js';

export interface RustDeskNativeEvidenceWatcherConfig {
  eventDirectory: string;
  evidenceDirectory: string;
  spoolDirectory: string;
  fileRoots: string[];
  recordingRoots: string[];
  stableMs: number;
  maxFileBytes: number;
  maxEventBytes: number;
  maxQuarantineRecords: number;
  now?: () => Date;
}

export interface RustDeskNativeEvidenceWatcherDependencies {
  copyFile?: (source: string, destination: string) => Promise<void>;
}

export interface RustDeskNativeEvidenceWatcherPollResult {
  ingested: number;
  staged: number;
  waiting: number;
  quarantined: number;
}

interface NativeEvidenceEvent {
  schema_version: 1;
  native_event_id: string;
  event_type: 'file_transfer_completed' | 'screen_recording_completed';
  external_id: string;
  operation_id: string;
  authorization_scope: 'operation' | 'session';
  authorization_id: string;
  interaction_id?: string;
  reservation_id?: string;
  owner_epoch?: string;
  source_path: string;
  filename: string;
  declared_mime: string;
  observed_at: string;
  retention_until?: string | null;
  direction?: 'upload' | 'download';
  control_version?: number;
}

interface WatcherRecord {
  native_event_id: string;
  event_sha256: string;
  state: 'waiting' | 'staged';
  source_size: number;
  source_mtime_ms: number;
  stable_since: string;
  staged_at?: string;
}

interface WatcherState {
  version: 1;
  records: WatcherRecord[];
}

const EVENT_FIELDS = new Set([
  'schema_version',
  'native_event_id',
  'event_type',
  'external_id',
  'operation_id',
  'authorization_scope',
  'authorization_id',
  'interaction_id',
  'reservation_id',
  'owner_epoch',
  'source_path',
  'filename',
  'declared_mime',
  'observed_at',
  'retention_until',
  'direction',
  'control_version'
]);
const STATE_FILE = 'native-evidence-state.json';
const LOCK_FILE = '.native-evidence.lock';
const MAX_STATE_RECORDS = 10_000;

export function createRustDeskNativeEvidenceWatcherConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskNativeEvidenceWatcherConfig {
  return {
    eventDirectory: absolutePath(
      env.OPC_RUSTDESK_NATIVE_EVIDENCE_EVENT_DIR,
      'OPC_RUSTDESK_NATIVE_EVIDENCE_EVENT_DIR'
    ),
    evidenceDirectory: absolutePath(
      env.OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR,
      'OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR'
    ),
    spoolDirectory: absolutePath(
      env.OPC_RUSTDESK_NATIVE_EVIDENCE_SPOOL_DIR,
      'OPC_RUSTDESK_NATIVE_EVIDENCE_SPOOL_DIR'
    ),
    fileRoots: rootList(
      env.OPC_RUSTDESK_NATIVE_FILE_ROOTS_JSON,
      'OPC_RUSTDESK_NATIVE_FILE_ROOTS_JSON'
    ),
    recordingRoots: rootList(
      env.OPC_RUSTDESK_NATIVE_RECORDING_ROOTS_JSON,
      'OPC_RUSTDESK_NATIVE_RECORDING_ROOTS_JSON'
    ),
    stableMs: boundedInteger(
      env.OPC_RUSTDESK_NATIVE_EVIDENCE_STABLE_MS,
      2_000,
      0,
      300_000,
      'OPC_RUSTDESK_NATIVE_EVIDENCE_STABLE_MS'
    ),
    maxFileBytes: boundedInteger(
      env.OPC_RUSTDESK_EDGE_EVIDENCE_MAX_FILE_BYTES,
      10 * 1_024 * 1_024 * 1_024,
      1,
      10 * 1_024 * 1_024 * 1_024,
      'OPC_RUSTDESK_EDGE_EVIDENCE_MAX_FILE_BYTES'
    ),
    maxEventBytes: boundedInteger(
      env.OPC_RUSTDESK_NATIVE_EVIDENCE_MAX_EVENT_BYTES,
      64 * 1_024,
      1_024,
      1_048_576,
      'OPC_RUSTDESK_NATIVE_EVIDENCE_MAX_EVENT_BYTES'
    ),
    maxQuarantineRecords: boundedInteger(
      env.OPC_RUSTDESK_EDGE_EVIDENCE_MAX_QUARANTINE_RECORDS,
      100,
      1,
      10_000,
      'OPC_RUSTDESK_EDGE_EVIDENCE_MAX_QUARANTINE_RECORDS'
    )
  };
}

export class RustDeskNativeEvidenceWatcher {
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly quarantineDirectory: string;
  private readonly lockToken = randomUUID();
  private readonly now: () => Date;
  private readonly copyFile: (source: string, destination: string) => Promise<void>;
  private records: WatcherRecord[] = [];
  private fileRoots: string[] = [];
  private recordingRoots: string[] = [];
  private closed = false;

  private constructor(
    private readonly config: RustDeskNativeEvidenceWatcherConfig,
    dependencies: RustDeskNativeEvidenceWatcherDependencies
  ) {
    this.statePath = join(config.spoolDirectory, STATE_FILE);
    this.lockPath = join(config.spoolDirectory, LOCK_FILE);
    this.quarantineDirectory = join(config.eventDirectory, 'quarantine');
    this.now = config.now || (() => new Date());
    this.copyFile = dependencies.copyFile || nodeCopyFile;
  }

  static async open(
    config: RustDeskNativeEvidenceWatcherConfig,
    dependencies: RustDeskNativeEvidenceWatcherDependencies = {}
  ): Promise<RustDeskNativeEvidenceWatcher> {
    validateConfig(config);
    await ensurePrivateDirectory(config.eventDirectory, 'RustDesk native evidence event directory');
    await ensurePrivateDirectory(config.evidenceDirectory, 'RustDesk evidence input directory');
    await ensurePrivateDirectory(config.spoolDirectory, 'RustDesk native evidence spool directory');
    await ensurePrivateDirectory(
      join(config.eventDirectory, 'quarantine'),
      'RustDesk native evidence quarantine directory'
    );
    const watcher = new RustDeskNativeEvidenceWatcher(config, dependencies);
    await watcher.acquireLock();
    try {
      watcher.fileRoots = await resolveRoots(config.fileRoots, 'file');
      watcher.recordingRoots = await resolveRoots(config.recordingRoots, 'recording');
      await watcher.load();
      return watcher;
    } catch (error) {
      await watcher.close();
      throw error;
    }
  }

  async pollOnce(): Promise<RustDeskNativeEvidenceWatcherPollResult> {
    this.assertOpen();
    const result: RustDeskNativeEvidenceWatcherPollResult = {
      ingested: 0,
      staged: 0,
      waiting: 0,
      quarantined: 0
    };
    const names = (await readdir(this.config.eventDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const name of names) {
      const eventPath = join(this.config.eventDirectory, name);
      let raw = Buffer.from('unreadable');
      try {
        const eventStat = await lstat(eventPath);
        if (eventStat.isSymbolicLink() || !eventStat.isFile() || eventStat.size > this.config.maxEventBytes) {
          throw new Error('native evidence event file is invalid');
        }
        raw = await readFile(eventPath);
        const event = decodeEvent(JSON.parse(raw.toString('utf8')));
        const eventSha256 = sha256(raw);
        const existing = this.records.find((record) => record.native_event_id === event.native_event_id);
        if (existing?.state === 'staged') {
          if (existing.event_sha256 !== eventSha256) throw new Error('native evidence event id conflict');
          await unlink(eventPath);
          continue;
        }
        const source = await this.inspectSource(event);
        if (!existing) {
          this.records.push({
            native_event_id: event.native_event_id,
            event_sha256: eventSha256,
            state: 'waiting',
            source_size: source.size,
            source_mtime_ms: source.mtimeMs,
            stable_since: this.now().toISOString()
          });
          result.ingested += 1;
          await this.persist();
        } else if (existing.event_sha256 !== eventSha256) {
          throw new Error('native evidence event id conflict');
        } else if (
          existing.source_size !== source.size ||
          existing.source_mtime_ms !== source.mtimeMs
        ) {
          existing.source_size = source.size;
          existing.source_mtime_ms = source.mtimeMs;
          existing.stable_since = this.now().toISOString();
          await this.persist();
        }
        const record = this.records.find((item) => item.native_event_id === event.native_event_id)!;
        if (this.now().getTime() - Date.parse(record.stable_since) < this.config.stableMs) {
          result.waiting += 1;
          continue;
        }
        await this.stage(event, eventSha256, source.path, source.size, source.mtimeMs);
        record.state = 'staged';
        record.staged_at = this.now().toISOString();
        this.trimRecords();
        await this.persist();
        await unlink(eventPath);
        result.staged += 1;
      } catch (error) {
        if (nodeCode(error) === 'ENOENT') continue;
        await this.quarantine(name, raw, errorCode(error));
        result.quarantined += 1;
      }
    }
    return result;
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

  private async inspectSource(event: NativeEvidenceEvent) {
    const sourceStat = await lstat(event.source_path);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
      throw new Error('native evidence source must be a regular file');
    }
    if (sourceStat.size < 1 || sourceStat.size > this.config.maxFileBytes) {
      throw new Error('native evidence source size is invalid');
    }
    const resolved = await realpath(event.source_path);
    const policy = requireRustDeskNativeEvidencePolicy(event);
    const roots = policy.root_class === 'file'
      ? this.fileRoots
      : this.recordingRoots;
    if (!roots.some((root) => isWithin(root, resolved))) {
      throw new Error('native evidence source is outside its allowlisted roots');
    }
    return { path: resolved, size: sourceStat.size, mtimeMs: sourceStat.mtimeMs };
  }

  private async stage(
    event: NativeEvidenceEvent,
    eventSha256: string,
    sourcePath: string,
    expectedSize: number,
    expectedMtimeMs: number
  ): Promise<void> {
    const outputId = createHash('sha256')
      .update(`${event.native_event_id}\u0000${eventSha256}`)
      .digest('hex');
    const payloadFilename = `native-${outputId}.payload`;
    const manifestFilename = `native-${outputId}.json`;
    const payloadPath = join(this.config.evidenceDirectory, payloadFilename);
    const manifestPath = join(this.config.evidenceDirectory, manifestFilename);
    const temporary = join(
      this.config.evidenceDirectory,
      `.native-${outputId}.tmp-${process.pid}-${randomUUID()}`
    );
    const beforeDigest = await hashFile(sourcePath, expectedSize);
    try {
      await this.copyFile(sourcePath, temporary);
      await chmod(temporary, 0o600);
      const [sourceAfter, copyStat] = await Promise.all([lstat(sourcePath), lstat(temporary)]);
      if (
        sourceAfter.isSymbolicLink() ||
        !sourceAfter.isFile() ||
        sourceAfter.size !== expectedSize ||
        sourceAfter.mtimeMs !== expectedMtimeMs ||
        !copyStat.isFile() ||
        copyStat.size !== expectedSize
      ) {
        throw new Error('native evidence source changed during copy');
      }
      const [sourceAfterDigest, copyDigest] = await Promise.all([
        hashFile(sourcePath, expectedSize),
        hashFile(temporary, expectedSize)
      ]);
      if (sourceAfterDigest !== beforeDigest || copyDigest !== beforeDigest) {
        throw new Error('native evidence source changed during copy');
      }
      await installIdenticalFile(temporary, payloadPath, beforeDigest, expectedSize);
      const manifest = {
        schema_version: 1,
        native_event_id: event.native_event_id,
        source_origin: 'rustdesk_native_event',
        external_id: event.external_id,
        operation_id: event.operation_id,
        authorization_scope: event.authorization_scope,
        authorization_id: event.authorization_id,
        ...(ownerIdentity(event) || {}),
        kind: event.event_type === 'screen_recording_completed' ? 'screen_recording' : 'file',
        payload_filename: payloadFilename,
        filename: event.filename,
        declared_mime: event.declared_mime,
        observed_at: event.observed_at,
        ...(event.retention_until === undefined ? {} : { retention_until: event.retention_until }),
        ...(event.event_type === 'file_transfer_completed'
          ? { direction: event.direction, control_version: event.control_version }
          : {})
      };
      await writeAtomicJson(manifestPath, manifest);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      try {
        await lstat(manifestPath);
      } catch (manifestError) {
        if (nodeCode(manifestError) === 'ENOENT') await unlink(payloadPath).catch(() => {});
      }
      throw error;
    }
  }

  private async quarantine(name: string, raw: Buffer, rejection: string): Promise<void> {
    const eventPath = join(this.config.eventDirectory, name);
    const record = {
      schema_version: 1,
      source_filename: safeFilePart(name),
      sha256: `sha256:${sha256(raw)}`,
      rejection,
      rejected_at: this.now().toISOString()
    };
    const path = join(
      this.quarantineDirectory,
      `${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
    );
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await unlink(eventPath).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
    const names = (await readdir(this.quarantineDirectory))
      .filter((item) => item.endsWith('.json'))
      .sort();
    for (const old of names.slice(0, Math.max(0, names.length - this.config.maxQuarantineRecords))) {
      await unlink(join(this.quarantineDirectory, old));
    }
  }

  private trimRecords(): void {
    if (this.records.length <= MAX_STATE_RECORDS) return;
    const waiting = this.records.filter((record) => record.state === 'waiting');
    const staged = this.records
      .filter((record) => record.state === 'staged')
      .sort((left, right) => String(right.staged_at).localeCompare(String(left.staged_at)));
    this.records = [...waiting, ...staged.slice(0, Math.max(0, MAX_STATE_RECORDS - waiting.length))];
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    const value = JSON.parse(raw) as WatcherState;
    if (value.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX_STATE_RECORDS) {
      throw new Error('RustDesk native evidence state schema is unsupported');
    }
    this.records = value.records.map(decodeRecord);
  }

  private async persist(): Promise<void> {
    const temporary = join(
      this.config.spoolDirectory,
      `.native-evidence-state.tmp-${process.pid}-${randomUUID()}`
    );
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 1, records: this.records }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' }
    );
    try {
      await rename(temporary, this.statePath);
      await chmod(this.statePath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private async acquireLock(): Promise<void> {
    const payload = `${JSON.stringify({ version: 1, pid: process.pid, token: this.lockToken })}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(payload);
          await handle.sync();
        } finally {
          await handle.close();
        }
        return;
      } catch (error) {
        if (nodeCode(error) !== 'EEXIST') throw error;
        const existing = await readLock(this.lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new Error(`RustDesk native evidence spool is locked by live process ${existing.pid}`);
        }
        await unlink(this.lockPath).catch((unlinkError) => {
          if (nodeCode(unlinkError) !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('RustDesk native evidence spool lock could not be acquired');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RustDesk native evidence watcher is closed');
  }
}

function decodeEvent(value: unknown): NativeEvidenceEvent {
  const input = strictObject(value, 'RustDesk native evidence event');
  const unknown = Object.keys(input).find((field) => !EVENT_FIELDS.has(field));
  if (unknown) throw new Error(`unsupported RustDesk native evidence field: ${unknown}`);
  if (input.schema_version !== 1) throw new Error('RustDesk native evidence schema is unsupported');
  const eventType = required(input.event_type, 'event_type') as NativeEvidenceEvent['event_type'];
  if (eventType !== 'file_transfer_completed' && eventType !== 'screen_recording_completed') {
    throw new Error('RustDesk native evidence event type is unsupported');
  }
  const externalId = identifier(input.external_id, 'external_id');
  const authorizationScope = required(
    input.authorization_scope,
    'authorization_scope'
  ) as NativeEvidenceEvent['authorization_scope'];
  const authorizationId = identifier(input.authorization_id, 'authorization_id');
  const direction = input.direction === undefined ? undefined : String(input.direction);
  const controlVersion = input.control_version === undefined ? undefined : Number(input.control_version);
  requireRustDeskNativeEvidencePolicy({
    event_type: eventType,
    external_id: externalId,
    authorization_scope: authorizationScope,
    authorization_id: authorizationId,
    ...(optionalOwnerIdentity(input) || {}),
    direction,
    control_version: controlVersion
  });
  return {
    schema_version: 1,
    native_event_id: identifier(input.native_event_id, 'native_event_id'),
    event_type: eventType,
    external_id: externalId,
    operation_id: identifier(input.operation_id, 'operation_id'),
    authorization_scope: authorizationScope,
    authorization_id: authorizationId,
    ...(optionalOwnerIdentity(input) || {}),
    source_path: absolutePath(String(input.source_path || ''), 'source_path'),
    filename: safeBasename(input.filename, 'filename'),
    declared_mime: mime(input.declared_mime),
    observed_at: iso(input.observed_at, 'observed_at'),
    ...(input.retention_until === undefined
      ? {}
      : { retention_until: input.retention_until === null ? null : iso(input.retention_until, 'retention_until') }),
    ...(eventType === 'file_transfer_completed'
      ? { direction: direction as 'upload' | 'download', control_version: controlVersion }
      : {})
  };
}

function optionalOwnerIdentity(
  value: Record<string, unknown>
): Pick<NativeEvidenceEvent, 'interaction_id' | 'reservation_id' | 'owner_epoch'> | null {
  const present = [value.interaction_id, value.reservation_id, value.owner_epoch]
    .filter((item) => item !== undefined && item !== null);
  if (!present.length) return null;
  if (present.length !== 3) throw new Error('RustDesk native evidence owner binding is incomplete');
  const ownerEpoch = identifier(value.owner_epoch, 'owner_epoch');
  if (!/^[1-9][0-9]{0,19}$/.test(ownerEpoch)) {
    throw new Error('RustDesk native evidence owner_epoch is invalid');
  }
  return {
    interaction_id: identifier(value.interaction_id, 'interaction_id'),
    reservation_id: identifier(value.reservation_id, 'reservation_id'),
    owner_epoch: BigInt(ownerEpoch).toString()
  };
}

function ownerIdentity(
  event: NativeEvidenceEvent
): Pick<NativeEvidenceEvent, 'interaction_id' | 'reservation_id' | 'owner_epoch'> | null {
  return event.interaction_id && event.reservation_id && event.owner_epoch
    ? {
        interaction_id: event.interaction_id,
        reservation_id: event.reservation_id,
        owner_epoch: event.owner_epoch
      }
    : null;
}

function decodeRecord(value: unknown): WatcherRecord {
  const record = strictObject(value, 'RustDesk native evidence state record');
  const state = String(record.state || '');
  if (state !== 'waiting' && state !== 'staged') {
    throw new Error('RustDesk native evidence state is invalid');
  }
  return {
    native_event_id: identifier(record.native_event_id, 'native_event_id'),
    event_sha256: digest(record.event_sha256),
    state,
    source_size: positiveInteger(record.source_size, 'source_size'),
    source_mtime_ms: nonNegativeNumber(record.source_mtime_ms, 'source_mtime_ms'),
    stable_since: iso(record.stable_since, 'stable_since'),
    ...(state === 'staged' ? { staged_at: iso(record.staged_at, 'staged_at') } : {})
  };
}

async function resolveRoots(values: string[], label: string): Promise<string[]> {
  const roots: string[] = [];
  for (const value of values) {
    const stat = await lstat(value);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`RustDesk native ${label} root must be a real directory`);
    }
    roots.push(await realpath(value));
  }
  return [...new Set(roots)];
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return Boolean(path) && path !== '..' && !path.startsWith(`..${separator()}`) && !isAbsolute(path);
}

function separator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

async function installIdenticalFile(
  temporary: string,
  destination: string,
  expectedDigest: string,
  expectedSize: number
): Promise<void> {
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    if (nodeCode(error) !== 'EEXIST' && nodeCode(error) !== 'EPERM') throw error;
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedSize) {
      throw new Error('RustDesk native evidence payload output conflict');
    }
    if (await hashFile(destination, expectedSize) !== expectedDigest) {
      throw new Error('RustDesk native evidence payload output conflict');
    }
    await unlink(temporary);
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const existing = await readFile(path, 'utf8');
    if (canonicalJson(existing) !== canonicalJson(serialized)) {
      throw new Error('RustDesk native evidence manifest output conflict');
    }
    return;
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error;
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, serialized, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function hashFile(path: string, size: number): Promise<string> {
  const handle = await open(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(Math.min(1_024 * 1_024, Math.max(1, size)));
  let offset = 0;
  try {
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('RustDesk native evidence file changed while hashing');
      hash.update(buffer.subarray(0, length));
      offset += length;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function ensurePrivateDirectory(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${name} must be a real directory`);
  }
  await chmod(path, 0o700);
}

async function readLock(path: string): Promise<{ pid: number } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    const pid = Number(value.pid);
    return Number.isSafeInteger(pid) && pid > 0 ? { pid } : null;
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

function rootList(value: string | undefined, name: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch {
    throw new Error(`${name} must be a JSON array of absolute paths`);
  }
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 32) {
    throw new Error(`${name} must contain from 1 to 32 absolute paths`);
  }
  return parsed.map((item) => absolutePath(String(item || ''), name));
}

function validateConfig(config: RustDeskNativeEvidenceWatcherConfig): void {
  if (!config.fileRoots.length || !config.recordingRoots.length) {
    throw new Error('RustDesk native evidence file and recording roots are required');
  }
  for (const [value, minimum, maximum, name] of [
    [config.stableMs, 0, 300_000, 'stableMs'],
    [config.maxFileBytes, 1, 10 * 1_024 * 1_024 * 1_024, 'maxFileBytes'],
    [config.maxEventBytes, 1_024, 1_048_576, 'maxEventBytes'],
    [config.maxQuarantineRecords, 1, 10_000, 'maxQuarantineRecords']
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`RustDesk native evidence ${name} is invalid`);
    }
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function absolutePath(value: string | undefined, name: string): string {
  const result = String(value || '').trim();
  if (!result || (!isAbsolute(result) && !/^[A-Za-z]:[\\/]/.test(result) && !/^\\\\/.test(result))) {
    throw new Error(`RustDesk native evidence ${name} must be an absolute path`);
  }
  if (/\u0000/.test(result)) throw new Error(`RustDesk native evidence ${name} is invalid`);
  return result;
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  const result = required(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) {
    throw new Error(`RustDesk native evidence ${name} is invalid`);
  }
  return result;
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`RustDesk native evidence ${name} is required`);
  const result = value.trim();
  if (!result || result.length > 512 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`RustDesk native evidence ${name} is invalid`);
  }
  return result;
}

function safeBasename(value: unknown, name: string): string {
  const result = required(value, name);
  if (basename(result) !== result || result === '.' || result === '..') {
    throw new Error(`RustDesk native evidence ${name} must be a basename`);
  }
  return result;
}

function mime(value: unknown): string {
  const result = required(value, 'declared_mime').toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(result)) {
    throw new Error('RustDesk native evidence declared_mime is invalid');
  }
  return result;
}

function iso(value: unknown, name: string): string {
  const result = required(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`RustDesk native evidence ${name} is invalid`);
  return new Date(result).toISOString();
}

function digest(value: unknown): string {
  const result = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('RustDesk native evidence digest is invalid');
  return result;
}

function positiveInteger(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`RustDesk native evidence ${name} is invalid`);
  }
  return result;
}

function nonNegativeNumber(value: unknown, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new Error(`RustDesk native evidence ${name} is invalid`);
  }
  return result;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: string): string {
  return JSON.stringify(JSON.parse(value));
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'native-event.json';
}

function errorCode(error: unknown): string {
  const value = String((error as Error)?.message || 'invalid_native_event')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return value || 'invalid_native_event';
}

function nodeCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code || '');
}
