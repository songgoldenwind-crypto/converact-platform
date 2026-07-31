import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

export interface RustDeskNativeEvidenceBinding {
  kind: 'file' | 'screen_recording';
  external_id: string;
  controller_rustdesk_id: string;
  operation_id: string;
  authorization_scope: 'operation' | 'session';
  authorization_id: string;
  interaction_id?: string;
  reservation_id?: string;
  owner_epoch?: string;
  started_at: string;
  valid_until: string;
  direction?: 'upload' | 'download';
  control_version?: number;
  file_name?: string;
  declared_mime?: string;
  retention_until?: string;
}

export interface RustDeskNativeEvidenceContext {
  schema_version: 1;
  device_id: string;
  rustdesk_id: string;
  generated_at: string;
  expires_at: string;
  bindings: RustDeskNativeEvidenceBinding[];
}

export interface RustDeskNativeEvidenceCorrelatorConfig {
  candidateDirectory: string;
  eventDirectory: string;
  maxCandidateBytes: number;
  maxPendingMs: number;
  maxQuarantineRecords: number;
  now?: () => Date;
}

export interface RustDeskNativeEvidenceCorrelatorPollResult {
  correlated: number;
  waiting: number;
  quarantined: number;
}

interface NativeCandidate {
  schema_version: 1;
  native_candidate_id: string;
  root_class: 'file' | 'recording';
  source_path: string;
  filename: string;
  size_bytes: number;
  observed_at: string;
  controller_rustdesk_ids: string[];
}

const CANDIDATE_FIELDS = new Set([
  'schema_version',
  'native_candidate_id',
  'root_class',
  'source_path',
  'filename',
  'size_bytes',
  'observed_unix_ms',
  'controller_rustdesk_ids'
]);

export class RustDeskNativeEvidenceCorrelator {
  private readonly now: () => Date;
  private readonly quarantineDirectory: string;

  private constructor(private readonly config: RustDeskNativeEvidenceCorrelatorConfig) {
    this.now = config.now || (() => new Date());
    this.quarantineDirectory = join(config.candidateDirectory, 'quarantine');
  }

  static async open(
    config: RustDeskNativeEvidenceCorrelatorConfig
  ): Promise<RustDeskNativeEvidenceCorrelator> {
    validateConfig(config);
    await ensurePrivateDirectory(config.candidateDirectory);
    await ensurePrivateDirectory(config.eventDirectory);
    await ensurePrivateDirectory(join(config.candidateDirectory, 'quarantine'));
    return new RustDeskNativeEvidenceCorrelator(config);
  }

  async pollOnce(rawContext: RustDeskNativeEvidenceContext): Promise<RustDeskNativeEvidenceCorrelatorPollResult> {
    const result = { correlated: 0, waiting: 0, quarantined: 0 };
    const now = this.now();
    const context = decodeContext(rawContext);
    const bindings = now.getTime() <= Date.parse(context.expires_at) ? context.bindings : [];
    const names = (await readdir(this.config.candidateDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    for (const name of names) {
      const candidatePath = join(this.config.candidateDirectory, name);
      let raw = Buffer.from('unreadable');
      try {
        const candidateStat = await lstat(candidatePath);
        if (
          candidateStat.isSymbolicLink() || !candidateStat.isFile() ||
          candidateStat.size < 2 || candidateStat.size > this.config.maxCandidateBytes
        ) throw new Error('native candidate file is invalid');
        raw = await readFile(candidatePath);
        const candidate = decodeCandidate(JSON.parse(raw.toString('utf8')));
        await assertCandidateSource(candidate);
        const matches = bindings.filter((binding) => bindingMatches(binding, candidate, now));
        if (matches.length !== 1) {
          if (now.getTime() - Date.parse(candidate.observed_at) <= this.config.maxPendingMs) {
            result.waiting += 1;
            continue;
          }
          await this.quarantine(name, raw, matches.length > 1
            ? 'native_evidence_binding_ambiguous'
            : 'native_evidence_binding_unavailable');
          result.quarantined += 1;
          continue;
        }
        const event = createEvidenceEvent(candidate, matches[0]);
        await writeAtomicEvent(this.config.eventDirectory, event);
        await unlink(candidatePath);
        result.correlated += 1;
      } catch (error) {
        if (nodeCode(error) === 'ENOENT') continue;
        await this.quarantine(name, raw, errorCode(error));
        result.quarantined += 1;
      }
    }
    return result;
  }

  private async quarantine(name: string, raw: Buffer, rejection: string): Promise<void> {
    const record = {
      schema_version: 1,
      source_filename: safeFilePart(name),
      sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      rejection,
      rejected_at: this.now().toISOString()
    };
    const destination = join(
      this.quarantineDirectory,
      `${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
    );
    await writeFile(destination, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await unlink(join(this.config.candidateDirectory, name)).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
    const names = (await readdir(this.quarantineDirectory)).filter((item) => item.endsWith('.json')).sort();
    for (const old of names.slice(0, Math.max(0, names.length - this.config.maxQuarantineRecords))) {
      await unlink(join(this.quarantineDirectory, old));
    }
  }
}

function createEvidenceEvent(candidate: NativeCandidate, binding: RustDeskNativeEvidenceBinding) {
  const common = {
    schema_version: 1,
    native_event_id: `${candidate.native_candidate_id}:${binding.operation_id}`,
    event_type: binding.kind === 'file' ? 'file_transfer_completed' : 'screen_recording_completed',
    external_id: binding.external_id,
    operation_id: binding.operation_id,
    authorization_scope: binding.authorization_scope,
    authorization_id: binding.authorization_id,
    ...(ownerIdentity(binding) || {}),
    source_path: candidate.source_path,
    filename: candidate.filename,
    declared_mime: binding.declared_mime || inferredMime(candidate.filename, binding.kind),
    observed_at: candidate.observed_at,
    ...(binding.retention_until ? { retention_until: binding.retention_until } : {})
  };
  return binding.kind === 'file'
    ? { ...common, direction: binding.direction, control_version: binding.control_version }
    : common;
}

function bindingMatches(
  binding: RustDeskNativeEvidenceBinding,
  candidate: NativeCandidate,
  now: Date
): boolean {
  const kind = candidate.root_class === 'file' ? 'file' : 'screen_recording';
  if (binding.kind !== kind) return false;
  if (!candidate.controller_rustdesk_ids.includes(binding.controller_rustdesk_id)) return false;
  const observed = Date.parse(candidate.observed_at);
  if (observed < Date.parse(binding.started_at) - 5_000 || observed > Date.parse(binding.valid_until)) return false;
  if (now.getTime() > Date.parse(binding.valid_until)) return false;
  if (binding.kind === 'file') {
    if (!binding.file_name) return false;
    return binding.file_name.toLocaleLowerCase('en-US') === candidate.filename.toLocaleLowerCase('en-US');
  }
  return !binding.file_name ||
    binding.file_name.toLocaleLowerCase('en-US') === candidate.filename.toLocaleLowerCase('en-US');
}

async function assertCandidateSource(candidate: NativeCandidate): Promise<void> {
  const source = await lstat(candidate.source_path);
  if (source.isSymbolicLink() || !source.isFile() || source.size !== candidate.size_bytes) {
    throw new Error('native candidate source no longer matches the completed file');
  }
}

function decodeCandidate(value: unknown): NativeCandidate {
  const input = strictObject(value, 'RustDesk native candidate');
  const unknown = Object.keys(input).find((field) => !CANDIDATE_FIELDS.has(field));
  if (unknown) throw new Error(`unsupported RustDesk native candidate field: ${unknown}`);
  if (input.schema_version !== 1) throw new Error('RustDesk native candidate schema is unsupported');
  const nativeCandidateId = identifier(input.native_candidate_id, 'native_candidate_id');
  if (input.root_class !== 'file' && input.root_class !== 'recording') {
    throw new Error('RustDesk native candidate root_class is invalid');
  }
  const sourcePath = requiredString(input.source_path, 'source_path');
  if (!isAbsolute(sourcePath)) throw new Error('RustDesk native candidate source_path must be absolute');
  const filename = safeFilename(input.filename);
  const sizeBytes = Number(input.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new Error('RustDesk native candidate size_bytes is invalid');
  }
  const observedUnixMs = Number(input.observed_unix_ms);
  if (!Number.isSafeInteger(observedUnixMs) || observedUnixMs < 1_577_836_800_000) {
    throw new Error('RustDesk native candidate observed_unix_ms is invalid');
  }
  const observedAt = new Date(observedUnixMs).toISOString();
  if (!Array.isArray(input.controller_rustdesk_ids) || input.controller_rustdesk_ids.length < 1 ||
      input.controller_rustdesk_ids.length > 16) {
    throw new Error('RustDesk native candidate controller_rustdesk_ids is invalid');
  }
  const controllerRustDeskIds = [...new Set(input.controller_rustdesk_ids.map((item) =>
    identifier(item, 'controller_rustdesk_id')))].sort();
  return {
    schema_version: 1,
    native_candidate_id: nativeCandidateId,
    root_class: input.root_class,
    source_path: sourcePath,
    filename,
    size_bytes: sizeBytes,
    observed_at: observedAt,
    controller_rustdesk_ids: controllerRustDeskIds
  };
}

function decodeContext(value: unknown): RustDeskNativeEvidenceContext {
  const input = strictObject(value, 'RustDesk native evidence context');
  if (input.schema_version !== 1 || !Array.isArray(input.bindings) || input.bindings.length > 1_000) {
    throw new Error('RustDesk native evidence context schema is unsupported');
  }
  return {
    schema_version: 1,
    device_id: identifier(input.device_id, 'device_id'),
    rustdesk_id: identifier(input.rustdesk_id, 'rustdesk_id'),
    generated_at: isoTimestamp(input.generated_at, 'generated_at'),
    expires_at: isoTimestamp(input.expires_at, 'expires_at'),
    bindings: input.bindings.map(decodeBinding)
  };
}

function decodeBinding(value: unknown): RustDeskNativeEvidenceBinding {
  const input = strictObject(value, 'RustDesk native evidence binding');
  const kind = input.kind;
  if (kind !== 'file' && kind !== 'screen_recording') throw new Error('native evidence binding kind is invalid');
  const scope = input.authorization_scope;
  if (scope !== (kind === 'file' ? 'operation' : 'session')) {
    throw new Error('native evidence binding authorization_scope is invalid');
  }
  const authorizationScope: 'operation' | 'session' = kind === 'file' ? 'operation' : 'session';
  const direction = input.direction;
  const controlVersion = input.control_version === undefined ? undefined : Number(input.control_version);
  const binding: RustDeskNativeEvidenceBinding = {
    kind,
    external_id: identifier(input.external_id, 'external_id'),
    controller_rustdesk_id: identifier(input.controller_rustdesk_id, 'controller_rustdesk_id'),
    operation_id: identifier(input.operation_id, 'operation_id'),
    authorization_scope: authorizationScope,
    authorization_id: identifier(input.authorization_id, 'authorization_id'),
    ...(optionalOwnerIdentity(input) || {}),
    started_at: isoTimestamp(input.started_at, 'started_at'),
    valid_until: isoTimestamp(input.valid_until, 'valid_until'),
    ...(input.file_name === undefined ? {} : { file_name: safeFilename(input.file_name) }),
    ...(input.declared_mime === undefined ? {} : { declared_mime: mime(input.declared_mime) }),
    ...(input.retention_until === undefined
      ? {}
      : { retention_until: isoTimestamp(input.retention_until, 'retention_until') })
  };
  if (kind === 'screen_recording') return binding;
  if (direction !== 'upload' && direction !== 'download') {
    throw new Error('native file evidence binding direction is invalid');
  }
  if (controlVersion === undefined || !Number.isSafeInteger(controlVersion) || controlVersion < 1) {
    throw new Error('native file evidence binding control_version is invalid');
  }
  return { ...binding, direction, control_version: controlVersion };
}

function optionalOwnerIdentity(
  value: Record<string, unknown>
): Pick<RustDeskNativeEvidenceBinding, 'interaction_id' | 'reservation_id' | 'owner_epoch'> | null {
  const present = [value.interaction_id, value.reservation_id, value.owner_epoch]
    .filter((item) => item !== undefined && item !== null);
  if (!present.length) return null;
  if (present.length !== 3) throw new Error('native evidence binding owner identity is incomplete');
  const ownerEpoch = identifier(value.owner_epoch, 'owner_epoch');
  if (!/^[1-9][0-9]{0,19}$/.test(ownerEpoch)) {
    throw new Error('native evidence binding owner_epoch is invalid');
  }
  return {
    interaction_id: identifier(value.interaction_id, 'interaction_id'),
    reservation_id: identifier(value.reservation_id, 'reservation_id'),
    owner_epoch: BigInt(ownerEpoch).toString()
  };
}

function ownerIdentity(
  binding: RustDeskNativeEvidenceBinding
): Pick<RustDeskNativeEvidenceBinding, 'interaction_id' | 'reservation_id' | 'owner_epoch'> | null {
  return binding.interaction_id && binding.reservation_id && binding.owner_epoch
    ? {
        interaction_id: binding.interaction_id,
        reservation_id: binding.reservation_id,
        owner_epoch: binding.owner_epoch
      }
    : null;
}

async function writeAtomicEvent(directory: string, event: Record<string, unknown>): Promise<void> {
  const payload = `${JSON.stringify(event)}\n`;
  const name = `${createHash('sha256').update(String(event.native_event_id)).digest('hex')}.json`;
  const destination = join(directory, name);
  try {
    const existing = await readFile(destination, 'utf8');
    if (existing !== payload) throw new Error('native evidence event id conflict');
    return;
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error;
  }
  const temporary = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function inferredMime(filename: string, kind: RustDeskNativeEvidenceBinding['kind']): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mkv')) return 'video/x-matroska';
  return kind === 'screen_recording' ? 'application/octet-stream' : 'application/octet-stream';
}

function validateConfig(config: RustDeskNativeEvidenceCorrelatorConfig): void {
  for (const [path, name] of [
    [config.candidateDirectory, 'candidateDirectory'],
    [config.eventDirectory, 'eventDirectory']
  ] as const) {
    if (!isAbsolute(path)) throw new Error(`RustDesk native evidence ${name} must be absolute`);
  }
  for (const [value, min, max, name] of [
    [config.maxCandidateBytes, 1_024, 1_048_576, 'maxCandidateBytes'],
    [config.maxPendingMs, 30_000, 86_400_000, 'maxPendingMs'],
    [config.maxQuarantineRecords, 1, 10_000, 'maxQuarantineRecords']
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`RustDesk native evidence ${name} is invalid`);
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`RustDesk native evidence ${name} is required`);
  const result = value.trim();
  if (!result || result.length > 4_096 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`RustDesk native evidence ${name} is invalid`);
  }
  return result;
}

function identifier(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(result)) throw new Error(`RustDesk native evidence ${name} is invalid`);
  return result;
}

function safeFilename(value: unknown): string {
  const result = requiredString(value, 'filename');
  if (result.length > 255 || basename(result) !== result) throw new Error('RustDesk native evidence filename is invalid');
  return result;
}

function isoTimestamp(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`RustDesk native evidence ${name} must be ISO-8601`);
  return new Date(result).toISOString();
}

function mime(value: unknown): string {
  const result = requiredString(value, 'declared_mime');
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(result)) {
    throw new Error('RustDesk native evidence declared_mime is invalid');
  }
  return result;
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'candidate';
}

function nodeCode(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code || '');
}

function errorCode(error: unknown): string {
  const message = String((error as Error | null)?.message || 'native evidence candidate rejected');
  return message.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160).toLowerCase();
}
