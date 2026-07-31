import { resolveBrandEnv } from '../src/config/converact-env.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RustDeskEvidenceUploaderConfig {
  baseUrl: string;
  deviceTokenFile: string;
  inputDirectory: string;
  spoolDirectory: string;
  observationDirectory: string;
  singleUploadMaxBytes: number;
  partSizeBytes: number;
  retryDelayMs: number;
  maxAttempts: number;
  maxFileBytes: number;
  maxQuarantineRecords: number;
  maxTerminalRecords: number;
  deadLetterRetentionMs: number;
  now?: () => Date;
}

interface RustDeskEvidenceManifest {
  schema_version: 1;
  native_event_id: string;
  source_origin: 'rustdesk_native_event';
  external_id: string;
  operation_id: string;
  authorization_scope: 'operation' | 'session';
  authorization_id: string;
  interaction_id?: string;
  reservation_id?: string;
  owner_epoch?: string;
  kind: 'screen_recording' | 'file';
  payload_filename: string;
  filename: string;
  declared_mime: string;
  observed_at: string;
  retention_until?: string | null;
  direction?: 'upload' | 'download';
  control_version?: number;
}

export interface RustDeskEvidenceUploadRecord {
  id: string;
  state: 'received' | 'uploading' | 'uploaded' | 'dead_letter';
  manifest?: RustDeskEvidenceManifest;
  payload_sha256: string;
  size_bytes: number;
  secure_file_id?: string;
  upload_mode: 'single' | 'multipart';
  part_size_bytes?: number;
  attempt_count: number;
  retry_at?: string;
  last_error_code?: string;
  created_at: string;
  updated_at: string;
  uploaded_at?: string;
  dead_lettered_at?: string;
}

export interface RustDeskEvidenceUploaderPollResult {
  ingested: number;
  uploaded: number;
  deadLettered: number;
}

interface StateDocument {
  version: 1;
  records: RustDeskEvidenceUploadRecord[];
}

export interface RustDeskEvidenceUploaderDependencies {
  removePayload?: (path: string) => Promise<void>;
}

const MANIFEST_FIELDS = new Set([
  'schema_version',
  'native_event_id',
  'source_origin',
  'external_id',
  'operation_id',
  'authorization_scope',
  'authorization_id',
  'interaction_id',
  'reservation_id',
  'owner_epoch',
  'kind',
  'payload_filename',
  'filename',
  'declared_mime',
  'observed_at',
  'retention_until',
  'direction',
  'control_version'
]);
const RECORDS_FILE = 'records.json';
const LOCK_FILE = '.lock';
const MAX_STATE_BYTES = 16 * 1_024 * 1_024;
const MAX_LEGACY_STATE_RECORDS = 100_000;

export function createRustDeskEvidenceUploaderConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskEvidenceUploaderConfig {
  return {
    baseUrl: normalizeBaseUrl(resolveBrandEnv(env, 'RUSTDESK_EDGE_BASE_URL') || ''),
    deviceTokenFile: absolutePath(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_DEVICE_TOKEN_FILE'),
      'CONVERACT_RUSTDESK_EDGE_DEVICE_TOKEN_FILE'
    ),
    inputDirectory: absolutePath(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_INPUT_DIR'),
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR'
    ),
    spoolDirectory: absolutePath(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR'),
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR'
    ),
    observationDirectory: absolutePath(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_OBSERVATION_INPUT_DIR'),
      'CONVERACT_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR'
    ),
    singleUploadMaxBytes: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_SINGLE_UPLOAD_MAX_BYTES'),
      64 * 1_024 * 1_024,
      1,
      512 * 1_024 * 1_024,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_SINGLE_UPLOAD_MAX_BYTES'
    ),
    partSizeBytes: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_PART_SIZE_BYTES'),
      8 * 1_024 * 1_024,
      1,
      512 * 1_024 * 1_024,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_PART_SIZE_BYTES'
    ),
    retryDelayMs: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_RETRY_DELAY_MS'),
      5_000,
      0,
      3_600_000,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_RETRY_DELAY_MS'
    ),
    maxAttempts: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_MAX_ATTEMPTS'),
      10,
      1,
      100,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_MAX_ATTEMPTS'
    ),
    maxFileBytes: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_MAX_FILE_BYTES'),
      10 * 1_024 * 1_024 * 1_024,
      1,
      10 * 1_024 * 1_024 * 1_024,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_MAX_FILE_BYTES'
    ),
    maxQuarantineRecords: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_MAX_QUARANTINE_RECORDS'),
      100,
      1,
      10_000,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_MAX_QUARANTINE_RECORDS'
    ),
    maxTerminalRecords: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_MAX_TERMINAL_RECORDS'),
      2_000,
      1,
      10_000,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_MAX_TERMINAL_RECORDS'
    ),
    deadLetterRetentionMs: boundedEnv(
      resolveBrandEnv(env, 'RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS'),
      7 * 24 * 60 * 60_000,
      60_000,
      90 * 24 * 60 * 60_000,
      'CONVERACT_RUSTDESK_EDGE_EVIDENCE_DEAD_LETTER_RETENTION_MS'
    )
  };
}

export class RustDeskEvidenceUploader {
  private readonly recordsPath: string;
  private readonly lockPath: string;
  private readonly quarantineDirectory: string;
  private readonly lockToken = randomUUID();
  private readonly now: () => Date;
  private readonly removePayload: (path: string) => Promise<void>;
  private records: RustDeskEvidenceUploadRecord[] = [];
  private closed = false;

  private constructor(
    private readonly config: RustDeskEvidenceUploaderConfig,
    private readonly deviceToken: string,
    private readonly fetchImpl: FetchLike,
    dependencies: RustDeskEvidenceUploaderDependencies
  ) {
    this.recordsPath = join(config.spoolDirectory, RECORDS_FILE);
    this.lockPath = join(config.spoolDirectory, LOCK_FILE);
    this.quarantineDirectory = join(config.inputDirectory, 'quarantine');
    this.now = config.now || (() => new Date());
    this.removePayload = dependencies.removePayload || unlink;
  }

  static async open(
    config: RustDeskEvidenceUploaderConfig,
    fetchImpl: FetchLike = fetch,
    dependencies: RustDeskEvidenceUploaderDependencies = {}
  ): Promise<RustDeskEvidenceUploader> {
    await ensurePrivateDirectory(config.inputDirectory, 'RustDesk evidence input directory');
    await ensurePrivateDirectory(config.spoolDirectory, 'RustDesk evidence spool directory');
    await ensurePrivateDirectory(config.observationDirectory, 'RustDesk observation input directory');
    await ensurePrivateDirectory(join(config.inputDirectory, 'quarantine'), 'RustDesk evidence quarantine directory');
    await assertRegularFileOrMissing(join(config.spoolDirectory, RECORDS_FILE), 'RustDesk evidence records file');
    const uploader = new RustDeskEvidenceUploader(
      config,
      await readDeviceToken(config.deviceTokenFile),
      fetchImpl,
      dependencies
    );
    await uploader.acquireLock();
    try {
      await uploader.load();
      await uploader.purgeDeadLetterPayloads();
      return uploader;
    } catch (error) {
      await uploader.close();
      throw error;
    }
  }

  async pollOnce(deviceIdValue: string): Promise<RustDeskEvidenceUploaderPollResult> {
    this.assertOpen();
    await this.purgeDeadLetterPayloads();
    const deviceId = required(deviceIdValue, 'RustDesk evidence device id is required');
    const ingested = await this.ingestManifests();
    let uploaded = await this.cleanupUploadedPayloads();
    let deadLettered = 0;
    const now = this.now().getTime();
    for (const record of this.records) {
      if (
        (record.state !== 'received' && record.state !== 'uploading') ||
        (record.retry_at && Date.parse(record.retry_at) > now)
      ) continue;
      record.attempt_count += 1;
      record.updated_at = this.now().toISOString();
      delete record.retry_at;
      await this.persist();
      try {
        if (await this.uploadRecord(deviceId, record)) uploaded += 1;
      } catch (error) {
        const retriable = !(error instanceof RustDeskEvidenceUploadHttpError) || error.retriable;
        record.last_error_code = errorCodeForRecord(error);
        record.updated_at = this.now().toISOString();
        if (!retriable || record.attempt_count >= this.config.maxAttempts) {
          record.state = 'dead_letter';
          record.dead_lettered_at = record.updated_at;
          delete record.retry_at;
          deadLettered += 1;
        } else {
          record.retry_at = new Date(this.now().getTime() + this.config.retryDelayMs).toISOString();
        }
        await this.persist();
      }
    }
    return { ingested, uploaded, deadLettered };
  }

  async listRecords(): Promise<RustDeskEvidenceUploadRecord[]> {
    this.assertOpen();
    return structuredClone(this.records);
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

  private async ingestManifests(): Promise<number> {
    const names = (await readdir(this.config.inputDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort();
    let ingested = 0;
    for (const name of names) {
      const path = join(this.config.inputDirectory, name);
      let raw = Buffer.from('unreadable');
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1_024) {
          throw new Error('invalid manifest file');
        }
        raw = await readFile(path);
        const manifest = decodeManifest(JSON.parse(raw.toString('utf8')), this.now);
        const payloadPath = join(this.config.inputDirectory, manifest.payload_filename);
        const payloadStat = await lstat(payloadPath);
        if (payloadStat.isSymbolicLink() || !payloadStat.isFile()) throw new Error('invalid evidence payload');
        if (payloadStat.size < 1 || payloadStat.size > this.config.maxFileBytes) {
          throw new Error('evidence payload size is invalid');
        }
        const digest = await hashFile(payloadPath, payloadStat.size);
        const id = `rdevid_${createHash('sha256').update([
          manifest.native_event_id,
          manifest.external_id,
          manifest.operation_id,
          digest
        ].join('\u0000')).digest('hex')}`;
        const existing = this.records.find((record) => record.id === id);
        if (existing) {
          if (existing.payload_sha256 !== digest || existing.size_bytes !== payloadStat.size) {
            throw new Error('evidence idempotency conflict');
          }
        } else {
          const timestamp = this.now().toISOString();
          this.records.push({
            id,
            state: 'received',
            manifest,
            payload_sha256: digest,
            size_bytes: payloadStat.size,
            upload_mode: payloadStat.size <= this.config.singleUploadMaxBytes ? 'single' : 'multipart',
            ...(payloadStat.size <= this.config.singleUploadMaxBytes
              ? {}
              : { part_size_bytes: Math.min(this.config.partSizeBytes, payloadStat.size) }),
            attempt_count: 0,
            created_at: timestamp,
            updated_at: timestamp
          });
          await this.persist();
          ingested += 1;
        }
        await unlink(path);
      } catch (error) {
        if (nodeCode(error) === 'ENOENT') continue;
        await this.quarantineManifest(name, raw);
      }
    }
    return ingested;
  }

  private async uploadRecord(deviceId: string, record: RustDeskEvidenceUploadRecord): Promise<boolean> {
    const manifest = record.manifest;
    if (!manifest) throw new Error('RustDesk evidence upload record is missing manifest');
    const payloadPath = join(this.config.inputDirectory, manifest.payload_filename);
    await assertPayload(payloadPath, record.size_bytes, record.payload_sha256);
    if (!record.secure_file_id) {
      const created = await this.requestJson<unknown>(
        'POST',
        `/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/evidence`,
        {
          native_event_id: manifest.native_event_id,
          source_origin: manifest.source_origin,
          external_id: manifest.external_id,
          operation_id: manifest.operation_id,
          authorization_scope: manifest.authorization_scope,
          authorization_id: manifest.authorization_id,
          ...(ownerIdentity(manifest) || {}),
          kind: manifest.kind,
          filename: manifest.filename,
          declared_mime: manifest.declared_mime,
          upload_mode: record.upload_mode,
          expected_size_bytes: record.size_bytes,
          observed_at: manifest.observed_at,
          ...(manifest.kind === 'file'
            ? { direction: manifest.direction, control_version: manifest.control_version }
            : {}),
          ...(record.upload_mode === 'multipart'
            ? { part_size_bytes: requiredPartSize(record) }
            : {}),
          ...(manifest.retention_until === undefined ? {} : { retention_until: manifest.retention_until })
        },
        { 'idempotency-key': record.id }
      );
      const createdFile = secureFileResponse(created, 'create');
      const fileId = identifier(createdFile.file_id, 'secure_file_id');
      if (createdFile.upload_mode !== record.upload_mode) {
        throw invalidUpstream('RustDesk secure evidence upload mode does not match the request');
      }
      if (
        record.upload_mode === 'multipart' &&
        createdFile.part_size_bytes !== requiredPartSize(record)
      ) {
        throw invalidUpstream('RustDesk secure evidence part size does not match the request');
      }
      record.secure_file_id = fileId;
      record.state = 'uploading';
      record.updated_at = this.now().toISOString();
      await this.persist();
    }
    if (record.upload_mode === 'single') {
      const content = await readFile(payloadPath);
      if (content.length !== record.size_bytes) throw new Error('RustDesk evidence payload size changed');
      const uploaded = await this.requestJson<unknown>(
        'PUT',
        this.evidencePath(deviceId, record, '/content'),
        content,
        { 'x-content-sha256': record.payload_sha256 }
      );
      assertCompletedUpload(uploaded, record);
    } else {
      await this.uploadMultipart(deviceId, record, payloadPath);
    }
    await this.emitObservation(record);
    record.state = 'uploaded';
    record.uploaded_at = this.now().toISOString();
    record.updated_at = record.uploaded_at;
    delete record.retry_at;
    delete record.last_error_code;
    await this.persist();
    return this.cleanupUploadedPayload(record);
  }

  private async cleanupUploadedPayloads(): Promise<number> {
    let completed = 0;
    const now = this.now().getTime();
    for (const record of this.records) {
      if (
        record.state !== 'uploaded' || !record.manifest ||
        (record.retry_at && Date.parse(record.retry_at) > now)
      ) continue;
      if (await this.cleanupUploadedPayload(record)) completed += 1;
    }
    return completed;
  }

  private async cleanupUploadedPayload(record: RustDeskEvidenceUploadRecord): Promise<boolean> {
    if (!record.manifest) return true;
    const payloadPath = join(this.config.inputDirectory, record.manifest.payload_filename);
    try {
      await this.removePayload(payloadPath);
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') {
        record.last_error_code = 'payload_cleanup_failed';
        record.retry_at = new Date(this.now().getTime() + this.config.retryDelayMs).toISOString();
        record.updated_at = this.now().toISOString();
        await this.persist();
        return false;
      }
    }
    delete record.manifest;
    delete record.retry_at;
    delete record.last_error_code;
    record.updated_at = this.now().toISOString();
    await this.persist();
    return true;
  }

  private async uploadMultipart(
    deviceId: string,
    record: RustDeskEvidenceUploadRecord,
    payloadPath: string
  ): Promise<void> {
    const listed = apiResponseData<{
      parts?: Array<{ part_number?: unknown; status?: unknown }>;
    }>(await this.requestJson<unknown>('GET', this.evidencePath(deviceId, record, '/parts')));
    if (!listed || !Array.isArray(listed.parts)) {
      throw invalidUpstream('RustDesk secure evidence parts response is invalid');
    }
    const uploaded = new Set((listed.parts || []).flatMap((part) => (
      part.status === 'uploaded' && Number.isInteger(Number(part.part_number))
        ? [Number(part.part_number)]
        : []
    )));
    const handle = await open(payloadPath, 'r');
    try {
      const partSize = requiredPartSize(record);
      const partCount = Math.ceil(record.size_bytes / partSize);
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        if (uploaded.has(partNumber)) continue;
        const offset = (partNumber - 1) * partSize;
        const size = Math.min(partSize, record.size_bytes - offset);
        const content = Buffer.alloc(size);
        const result = await handle.read(content, 0, size, offset);
        if (result.bytesRead !== size) throw new Error('RustDesk evidence payload changed during upload');
        const digest = createHash('sha256').update(content).digest('hex');
        await this.requestJson(
          'PUT',
          this.evidencePath(deviceId, record, `/parts/${partNumber}`),
          content,
          { 'x-content-sha256': digest }
        );
      }
    } finally {
      await handle.close();
    }
    const completed = await this.requestJson<unknown>(
      'POST',
      this.evidencePath(deviceId, record, '/complete'),
      { size_bytes: record.size_bytes, sha256: record.payload_sha256 }
    );
    assertCompletedUpload(completed, record);
  }

  private async emitObservation(record: RustDeskEvidenceUploadRecord): Promise<void> {
    const manifest = record.manifest!;
    const fileId = record.secure_file_id!;
    const observation = {
      external_id: manifest.external_id,
      operation_id: manifest.operation_id,
      operation: manifest.kind === 'screen_recording' ? 'record_screen' : 'transfer_file',
      status: 'observed_succeeded',
      observer: 'edge_adapter',
      source_adapter: 'companion_hook',
      ...(ownerIdentity(manifest) || {}),
      provider_operation_id: manifest.native_event_id,
      observed_at: manifest.observed_at,
      evidence_security: 'ivekit_secure_file',
      evidence_refs: [{
        type: 'ivekit_secure_file',
        ref: `ivekit-secure-file://${fileId}`,
        sha256: `sha256:${record.payload_sha256}`
      }],
      byte_count: record.size_bytes,
      checksum_sha256: `sha256:${record.payload_sha256}`,
      ...(manifest.kind === 'file'
        ? { direction: manifest.direction, control_version: manifest.control_version }
        : {})
    };
    const serialized = `${JSON.stringify(observation, null, 2)}\n`;
    const target = join(this.config.observationDirectory, `${record.id}.json`);
    try {
      const existing = await readFile(target, 'utf8');
      if (canonicalJson(JSON.parse(existing)) !== canonicalJson(observation)) {
        throw new Error('RustDesk evidence observation output conflict');
      }
      return;
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') throw error;
    }
    const temporary = join(
      this.config.observationDirectory,
      `.${record.id}.tmp-${process.pid}-${randomUUID()}`
    );
    await writePrivateFile(temporary, serialized);
    try {
      await rename(temporary, target);
      await chmod(target, 0o600);
      await syncDirectory(this.config.observationDirectory);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private evidencePath(
    deviceId: string,
    record: RustDeskEvidenceUploadRecord,
    suffix: string
  ): string {
    return `/api/ivekit/rustdesk/devices/${encodeURIComponent(deviceId)}/evidence/` +
      `${encodeURIComponent(required(record.secure_file_id, 'RustDesk secure evidence file id is missing'))}${suffix}`;
  }

  private async requestJson<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown> | Buffer,
    additionalHeaders: Record<string, string> = {}
  ): Promise<T> {
    let response: Response;
    const requestBody: RequestInit['body'] = body === undefined
      ? undefined
      : Buffer.isBuffer(body)
        ? body as unknown as NonNullable<RequestInit['body']>
        : JSON.stringify(body);
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          'x-rustdesk-edge-token': this.deviceToken,
          ...additionalHeaders,
          ...(Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' })
        },
        ...(requestBody === undefined ? {} : { body: requestBody })
      });
    } catch {
      throw new RustDeskEvidenceUploadHttpError('network_error', 0, true);
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try { payload = JSON.parse(text); } catch {
        throw new RustDeskEvidenceUploadHttpError('invalid_upstream_response', response.status, false);
      }
    }
    if (!response.ok) {
      throw new RustDeskEvidenceUploadHttpError(
        `upstream_${response.status}`,
        response.status,
        response.status === 408 || response.status === 429 || response.status >= 500
      );
    }
    return payload as T;
  }

  private async quarantineManifest(name: string, raw: Buffer): Promise<void> {
    const payload = {
      schema_version: 1,
      source_filename: safeFilePart(name),
      sha256: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      rejection: 'invalid_schema',
      rejected_at: this.now().toISOString()
    };
    const path = join(
      this.quarantineDirectory,
      `${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`
    );
    await writePrivateFile(path, `${JSON.stringify(payload, null, 2)}\n`);
    await unlink(join(this.config.inputDirectory, name)).catch((error) => {
      if (nodeCode(error) !== 'ENOENT') throw error;
    });
    const names = (await readdir(this.quarantineDirectory)).filter((item) => item.endsWith('.json')).sort();
    for (const old of names.slice(0, Math.max(0, names.length - this.config.maxQuarantineRecords))) {
      await unlink(join(this.quarantineDirectory, old));
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try { raw = await readFile(this.recordsPath, 'utf8'); }
    catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) {
      throw new Error('RustDesk evidence records file exceeds size limit');
    }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('RustDesk evidence records file is invalid JSON'); }
    this.records = decodeState(value, this.now);
    if (this.compactTerminalRecords()) await this.persist();
  }

  private async persist(): Promise<void> {
    this.compactTerminalRecords();
    const document: StateDocument = { version: 1, records: this.records };
    const serialized = `${JSON.stringify(document, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new Error('RustDesk evidence records file exceeds size limit');
    }
    const temporary = join(
      this.config.spoolDirectory,
      `.records.tmp-${process.pid}-${randomUUID()}`
    );
    await writePrivateFile(temporary, serialized);
    try {
      await rename(temporary, this.recordsPath);
      await chmod(this.recordsPath, 0o600);
      await syncDirectory(this.config.spoolDirectory);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  private compactTerminalRecords(): boolean {
    const terminal = this.records
      .filter((record) =>
        (record.state === 'uploaded' && !record.manifest) ||
        (record.state === 'dead_letter' && !record.manifest)
      )
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id)
      );
    if (terminal.length <= this.config.maxTerminalRecords) return false;
    const keep = new Set(
      terminal.slice(0, this.config.maxTerminalRecords).map((record) => record.id)
    );
    this.records = this.records.filter((record) => record.manifest || keep.has(record.id));
    return true;
  }

  private async purgeDeadLetterPayloads(): Promise<void> {
    const now = this.now().getTime();
    const payloadBacked = this.records
      .filter((record) => record.state === 'dead_letter' && record.manifest)
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id)
      );
    const purgeIds = new Set(payloadBacked.flatMap((record, index) => {
      const terminalAt = Date.parse(record.dead_lettered_at || record.updated_at);
      const expired = Number.isFinite(terminalAt) &&
        terminalAt + this.config.deadLetterRetentionMs <= now;
      return expired || index >= this.config.maxTerminalRecords ? [record.id] : [];
    }));
    if (!purgeIds.size) return;
    for (const record of payloadBacked) {
      if (!purgeIds.has(record.id) || !record.manifest) continue;
      await this.removePayload(join(this.config.inputDirectory, record.manifest.payload_filename)).catch((error) => {
        if (nodeCode(error) !== 'ENOENT') throw error;
      });
    }
    this.records = this.records.filter((record) => !purgeIds.has(record.id));
    await this.persist();
  }

  private async acquireLock(): Promise<void> {
    const payload = `${JSON.stringify({ version: 1, pid: process.pid, token: this.lockToken })}\n`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, 'wx', 0o600);
        try { await handle.writeFile(payload); await handle.sync(); } finally { await handle.close(); }
        return;
      } catch (error) {
        if (nodeCode(error) !== 'EEXIST') throw error;
        const stat = await lstat(this.lockPath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('RustDesk evidence lock is invalid');
        const existing = await readLock(this.lockPath);
        if (existing && processIsAlive(existing.pid)) {
          throw new Error(`RustDesk evidence spool is already locked by a live process: ${existing.pid}`);
        }
        await unlink(this.lockPath).catch((unlinkError) => {
          if (nodeCode(unlinkError) !== 'ENOENT') throw unlinkError;
        });
      }
    }
    throw new Error('RustDesk evidence spool lock could not be acquired');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('RustDesk evidence uploader is closed');
  }
}

interface SecureFileResponse {
  file_id: string;
  upload_mode: 'single' | 'multipart';
  status: string;
  part_size_bytes: number;
  size_bytes?: number;
  sha256?: string;
}

class RustDeskEvidenceUploadHttpError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retriable: boolean) {
    super(code);
    this.name = 'RustDeskEvidenceUploadHttpError';
  }
}

function secureFileResponse(
  value: unknown,
  operation: string
): SecureFileResponse {
  const payload = apiResponseData<{ file?: SecureFileResponse }>(value);
  if (!payload?.file || typeof payload.file !== 'object') {
    throw invalidUpstream(`RustDesk secure evidence ${operation} response is invalid`);
  }
  return payload.file;
}

function assertCompletedUpload(
  value: unknown,
  record: RustDeskEvidenceUploadRecord
): void {
  const file = secureFileResponse(value, 'upload');
  if (
    identifier(file.file_id, 'secure_file_id') !== record.secure_file_id ||
    file.size_bytes !== record.size_bytes ||
    file.sha256 !== record.payload_sha256
  ) {
    throw invalidUpstream('RustDesk secure evidence upload identity does not match the request');
  }
}

function apiResponseData<T>(value: unknown): T {
  if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'data')) {
    return (value as { data: T }).data;
  }
  return value as T;
}

function requiredPartSize(record: RustDeskEvidenceUploadRecord): number {
  if (record.upload_mode !== 'multipart') {
    throw new Error('RustDesk secure evidence record is not multipart');
  }
  return positiveInteger(record.part_size_bytes, 'record.part_size_bytes');
}

function invalidUpstream(message: string): RustDeskEvidenceUploadHttpError {
  const error = new RustDeskEvidenceUploadHttpError('invalid_upstream_response', 0, false);
  error.message = message;
  return error;
}

function decodeManifest(value: unknown, now: () => Date): RustDeskEvidenceManifest {
  const manifest = strictObject(value, 'RustDesk evidence manifest');
  const unknown = Object.keys(manifest).find((field) => !MANIFEST_FIELDS.has(field));
  if (unknown) throw new Error(`unsupported RustDesk evidence manifest field: ${unknown}`);
  if (manifest.schema_version !== 1) throw new Error('RustDesk evidence manifest schema is unsupported');
  const kind = String(manifest.kind || '');
  if (kind !== 'screen_recording' && kind !== 'file') throw new Error('RustDesk evidence kind is invalid');
  const direction = manifest.direction === undefined ? undefined : String(manifest.direction);
  const controlVersion = manifest.control_version === undefined ? undefined : Number(manifest.control_version);
  const externalId = identifier(manifest.external_id, 'external_id');
  const authorizationScope = String(manifest.authorization_scope || '');
  const authorizationId = identifier(manifest.authorization_id, 'authorization_id');
  if (manifest.source_origin !== 'rustdesk_native_event') {
    throw new Error('RustDesk evidence source_origin is invalid');
  }
  if (kind === 'file') {
    if (authorizationScope !== 'operation') {
      throw new Error('RustDesk file evidence requires operation authorization');
    }
    if (direction !== 'upload' && direction !== 'download') throw new Error('RustDesk file evidence direction is required');
    if (!Number.isSafeInteger(controlVersion) || Number(controlVersion) < 0) {
      throw new Error('RustDesk file evidence control_version is required');
    }
  } else if (direction !== undefined || controlVersion !== undefined) {
    throw new Error('RustDesk recording evidence must not include file control fields');
  } else if (authorizationScope !== 'session' || authorizationId !== externalId) {
    throw new Error('RustDesk recording evidence requires gateway session authorization');
  }
  const payloadFilename = safeBasename(manifest.payload_filename, 'payload_filename');
  const filename = safeBasename(manifest.filename, 'filename');
  const observedAt = manifest.observed_at === undefined
    ? now().toISOString()
    : iso(manifest.observed_at, 'observed_at');
  return {
    schema_version: 1,
    native_event_id: identifier(manifest.native_event_id, 'native_event_id'),
    source_origin: 'rustdesk_native_event',
    external_id: externalId,
    operation_id: identifier(manifest.operation_id, 'operation_id'),
    authorization_scope: authorizationScope as 'operation' | 'session',
    authorization_id: authorizationId,
    ...(optionalOwnerIdentity(manifest) || {}),
    kind,
    payload_filename: payloadFilename,
    filename,
    declared_mime: mime(manifest.declared_mime),
    observed_at: observedAt,
    ...(manifest.retention_until === undefined
      ? {}
      : { retention_until: manifest.retention_until === null ? null : iso(manifest.retention_until, 'retention_until') }),
    ...(kind === 'file' ? { direction: direction as 'upload' | 'download', control_version: controlVersion } : {})
  };
}

function optionalOwnerIdentity(
  value: Record<string, unknown>
): Pick<RustDeskEvidenceManifest, 'interaction_id' | 'reservation_id' | 'owner_epoch'> | null {
  const present = [value.interaction_id, value.reservation_id, value.owner_epoch]
    .filter((item) => item !== undefined && item !== null);
  if (!present.length) return null;
  if (present.length !== 3) throw new Error('RustDesk evidence owner binding is incomplete');
  const ownerEpoch = identifier(value.owner_epoch, 'owner_epoch');
  if (!/^[1-9][0-9]{0,19}$/.test(ownerEpoch)) {
    throw new Error('RustDesk evidence owner_epoch is invalid');
  }
  return {
    interaction_id: identifier(value.interaction_id, 'interaction_id'),
    reservation_id: identifier(value.reservation_id, 'reservation_id'),
    owner_epoch: BigInt(ownerEpoch).toString()
  };
}

function ownerIdentity(
  manifest: RustDeskEvidenceManifest
): Pick<RustDeskEvidenceManifest, 'interaction_id' | 'reservation_id' | 'owner_epoch'> | null {
  return manifest.interaction_id && manifest.reservation_id && manifest.owner_epoch
    ? {
        interaction_id: manifest.interaction_id,
        reservation_id: manifest.reservation_id,
        owner_epoch: manifest.owner_epoch
      }
    : null;
}

function decodeState(value: unknown, now: () => Date): RustDeskEvidenceUploadRecord[] {
  const document = strictObject(value, 'RustDesk evidence state');
  if (
    document.version !== 1 ||
    !Array.isArray(document.records) ||
    document.records.length > MAX_LEGACY_STATE_RECORDS
  ) {
    throw new Error('RustDesk evidence state schema is unsupported');
  }
  return document.records.map((item) => {
    const record = strictObject(item, 'RustDesk evidence record');
    const state = String(record.state || '') as RustDeskEvidenceUploadRecord['state'];
    if (!['received', 'uploading', 'uploaded', 'dead_letter'].includes(state)) {
      throw new Error('RustDesk evidence record state is unsupported');
    }
    const manifest = record.manifest === undefined ? undefined : decodeManifest(record.manifest, now);
    if ((state === 'received' || state === 'uploading') && !manifest) {
      throw new Error('RustDesk active evidence record requires manifest');
    }
    return {
      id: identifier(record.id, 'record.id'),
      state,
      ...(manifest ? { manifest } : {}),
      payload_sha256: digest(record.payload_sha256),
      size_bytes: positiveInteger(record.size_bytes, 'record.size_bytes'),
      ...(record.secure_file_id ? { secure_file_id: identifier(record.secure_file_id, 'record.secure_file_id') } : {}),
      upload_mode: record.upload_mode === 'single' ? 'single' : record.upload_mode === 'multipart' ? 'multipart' : invalidUploadMode(),
      ...(record.upload_mode === 'multipart'
        ? { part_size_bytes: positiveInteger(record.part_size_bytes, 'record.part_size_bytes') }
        : {}),
      attempt_count: nonNegativeInteger(record.attempt_count, 'record.attempt_count'),
      ...(record.retry_at ? { retry_at: iso(record.retry_at, 'record.retry_at') } : {}),
      ...(record.last_error_code ? { last_error_code: errorCode(record.last_error_code) } : {}),
      created_at: iso(record.created_at, 'record.created_at'),
      updated_at: iso(record.updated_at, 'record.updated_at'),
      ...(record.uploaded_at ? { uploaded_at: iso(record.uploaded_at, 'record.uploaded_at') } : {}),
      ...(record.dead_lettered_at ? { dead_lettered_at: iso(record.dead_lettered_at, 'record.dead_lettered_at') } : {})
    };
  });
}

async function assertPayload(path: string, size: number, digestValue: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== size) {
    throw new Error('RustDesk evidence payload identity changed');
  }
  if (await hashFile(path, size) !== digestValue) throw new Error('RustDesk evidence payload digest changed');
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
      if (result.bytesRead !== length) throw new Error('RustDesk evidence payload changed while hashing');
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function readDeviceToken(path: string): Promise<string> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('RustDesk evidence token file is invalid');
  const token = (await readFile(path, 'utf8')).trim();
  if (token.length < 32 || token.length > 4_000 || /\s/.test(token)) {
    throw new Error('RustDesk evidence token content is invalid');
  }
  return token;
}

async function ensurePrivateDirectory(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${name} must be a real directory`);
  await chmod(path, 0o700);
}

async function assertRegularFileOrMissing(path: string, name: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} must be a regular file`);
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error;
  }
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await chmod(path, 0o600);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readLock(path: string): Promise<{ pid: number } | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { pid?: unknown };
    const pid = Number(value.pid);
    return Number.isInteger(pid) && pid > 0 ? { pid } : null;
  } catch { return null; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return nodeCode(error) === 'EPERM'; }
}

function normalizeBaseUrl(value: string): string {
  const result = String(value || '').trim().replace(/\/+$/, '');
  let url: URL;
  try { url = new URL(result); } catch { throw new Error('CONVERACT_RUSTDESK_EDGE_BASE_URL must be an HTTP URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CONVERACT_RUSTDESK_EDGE_BASE_URL must be an HTTP URL without credentials');
  }
  return result;
}

function absolutePath(value: string | undefined, name: string): string {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${name} is required`);
  if (!isAbsolute(result) && !/^[A-Za-z]:[\\/]/.test(result) && !/^\\\\/.test(result)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return result;
}

function strictObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) throw new Error(`RustDesk evidence ${name} is invalid`);
  return result;
}

function safeBasename(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!result || result.length > 255 || result === '.' || result === '..' || /[\\/\u0000-\u001f\u007f]/.test(result)) {
    throw new Error(`RustDesk evidence ${name} is invalid`);
  }
  return result;
}

function mime(value: unknown): string {
  const result = String(value || 'application/octet-stream').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(result)) {
    throw new Error('RustDesk evidence declared_mime is invalid');
  }
  return result;
}

function iso(value: unknown, name: string): string {
  const result = String(value || '').trim();
  if (!result || Number.isNaN(Date.parse(result))) throw new Error(`RustDesk evidence ${name} is invalid`);
  return new Date(result).toISOString();
}

function digest(value: unknown): string {
  const result = String(value || '');
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('RustDesk evidence digest is invalid');
  return result;
}

function required(value: unknown, message: string): string {
  const result = String(value || '').trim();
  if (!result) throw new Error(message);
  return result;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`RustDesk evidence ${name} is invalid`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`RustDesk evidence ${name} is invalid`);
  return Number(value);
}

function boundedEnv(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function errorCodeForRecord(error: unknown): string {
  return error instanceof RustDeskEvidenceUploadHttpError
    ? error.code
    : 'local_io_error';
}

function errorCode(value: unknown): string {
  const result = String(value || '');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(result)) throw new Error('RustDesk evidence error code is invalid');
  return result;
}

function invalidUploadMode(): never {
  throw new Error('RustDesk evidence upload mode is invalid');
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'manifest.json';
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

function nodeCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code || '');
}
