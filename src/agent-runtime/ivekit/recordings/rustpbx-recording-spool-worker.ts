import { constants } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  statfs,
  unlink
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  recordingSpoolHttpPartMaxBytes,
  validateRecordingCompletion,
  validateSegmentEvent,
  validateSegmentManifest,
  type RustPbxRecordingCompletionV1,
  type RustPbxRecordingSegmentEventV1,
  type RustPbxRecordingSegmentManifestV1
} from './recording-spool-intake-service.js';
import { recordingSpoolAdmission } from './recording-manifest.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RustPbxRecordingSpoolWorkerConfig {
  base_url: string;
  profile_id: string;
  worker_id: string;
  spool_directory: string;
  state_directory: string;
  service_key_file: string;
  lease_secret_file: string;
  part_size_bytes: number;
  lease_ms: number;
  scan_limit: number;
  max_concurrent_uploads: number;
  retry_base_ms: number;
  retry_max_ms: number;
  now?: () => Date;
  random?: () => number;
}

export interface RustPbxRecordingSpoolRecord {
  id: string;
  state: 'pending' | 'uploading' | 'uploaded_cleanup_pending' | 'terminal';
  recording_id: string;
  segment_id: string;
  owner_epoch: string;
  manifest_relative_path: string;
  payload_relative_path: string;
  event_relative_paths: string[];
  manifest_sha256: string;
  whole_file_sha256: string;
  size_bytes: number;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error_code: string;
  created_at: string;
  updated_at: string;
  uploaded_at: string | null;
}

export interface RustPbxRecordingSpoolPollResult {
  discovered: number;
  uploaded: number;
  retrying: number;
  terminal: number;
  cleanup_pending: number;
}

export interface RustPbxRecordingSpoolFinalizationRecord {
  recording_id: string;
  state: 'pending' | 'finalizing' | 'finalized_cleanup_pending' | 'terminal';
  marker_relative_path: string;
  marker_sha256: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error_code: string;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
}

interface StateDocument {
  schema_version: 2;
  records: RustPbxRecordingSpoolRecord[];
  finalizations: RustPbxRecordingSpoolFinalizationRecord[];
  last_upload_succeeded_at: string | null;
}

interface WorkerDependencies {
  remove_file?: (path: string) => Promise<void>;
  filesystem_stats?: (path: string) => Promise<{
    capacity_bytes: number;
    available_bytes: number;
  }>;
}

const STATE_FILE = 'records.json';
const METRICS_FILE = 'metrics.json';
const LOCK_FILE = '.lock';
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_BUFFER_BYTES = 1024 * 1024;
const MAX_SEGMENT_EVENTS = 4096;
const COMPLETION_FILE = 'recording-completed.json';
const MAX_FINALIZATIONS = 100_000;

export class RustPbxRecordingSpoolWorker {
  readonly #config: RustPbxRecordingSpoolWorkerConfig;
  readonly #fetch: FetchLike;
  readonly #serviceKey: string;
  readonly #leaseSecret: string;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #removeFile: (path: string) => Promise<void>;
  readonly #filesystemStats: NonNullable<WorkerDependencies['filesystem_stats']>;
  readonly #statePath: string;
  readonly #metricsPath: string;
  readonly #lockPath: string;
  readonly #lockToken = randomUUID();
  #records: RustPbxRecordingSpoolRecord[] = [];
  #finalizations: RustPbxRecordingSpoolFinalizationRecord[] = [];
  #lastUploadSucceededAt: string | null = null;
  #persistChain: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(
    config: RustPbxRecordingSpoolWorkerConfig,
    fetchImpl: FetchLike,
    serviceKey: string,
    leaseSecret: string,
    dependencies: WorkerDependencies
  ) {
    this.#config = validateConfig(config);
    this.#fetch = fetchImpl;
    this.#serviceKey = serviceKey;
    this.#leaseSecret = leaseSecret;
    this.#now = config.now ?? (() => new Date());
    this.#random = config.random ?? Math.random;
    this.#removeFile = dependencies.remove_file ?? unlink;
    this.#filesystemStats = dependencies.filesystem_stats ?? filesystemStats;
    this.#statePath = join(config.state_directory, STATE_FILE);
    this.#metricsPath = join(config.state_directory, METRICS_FILE);
    this.#lockPath = join(config.state_directory, LOCK_FILE);
  }

  static async open(
    config: RustPbxRecordingSpoolWorkerConfig,
    fetchImpl: FetchLike = fetch,
    dependencies: WorkerDependencies = {}
  ): Promise<RustPbxRecordingSpoolWorker> {
    validateConfig(config);
    await assertPrivateDirectory(config.spool_directory, false);
    await assertPrivateDirectory(config.state_directory, true);
    const [serviceKey, leaseSecret] = await Promise.all([
      readSecret(config.service_key_file, 'recording spool service key'),
      readSecret(config.lease_secret_file, 'recording spool lease secret')
    ]);
    if (leaseSecret.length < 32) throw localError('recording_spool_lease_secret_invalid');
    const worker = new RustPbxRecordingSpoolWorker(
      config,
      fetchImpl,
      serviceKey,
      leaseSecret,
      dependencies
    );
    await worker.acquireLock();
    try {
      await worker.load();
      await worker.recoverInterruptedUploads();
      return worker;
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

  async pollOnce(): Promise<RustPbxRecordingSpoolPollResult> {
    this.assertOpen();
    const discovery = await this.discover();
    let uploaded = 0;
    let retrying = 0;
    let terminal = discovery.terminal;

    const cleanup = this.#records.filter((record) => record.state === 'uploaded_cleanup_pending');
    for (const record of cleanup) {
      if (await this.cleanup(record)) uploaded += 1;
    }

    const finalizationCleanup = this.#finalizations.filter(
      (record) => record.state === 'finalized_cleanup_pending'
    );
    for (const record of finalizationCleanup) await this.cleanupFinalization(record);

    const now = this.#now().getTime();
    const due = this.#records.filter((record) =>
      record.state === 'pending' &&
      (!record.next_attempt_at || Date.parse(record.next_attempt_at) <= now)
    );
    for (let offset = 0; offset < due.length; offset += this.#config.max_concurrent_uploads) {
      const batch = due.slice(offset, offset + this.#config.max_concurrent_uploads);
      const results = await Promise.all(batch.map((record) => this.process(record)));
      for (const result of results) {
        if (result === 'uploaded') uploaded += 1;
        if (result === 'retrying') retrying += 1;
        if (result === 'terminal') terminal += 1;
      }
    }
    const dueFinalizations = this.#finalizations.filter((record) =>
      record.state === 'pending' &&
      (!record.next_attempt_at || Date.parse(record.next_attempt_at) <= now) &&
      !this.#records.some((segment) => segment.recording_id === record.recording_id)
    );
    for (let offset = 0; offset < dueFinalizations.length; offset += this.#config.max_concurrent_uploads) {
      await Promise.all(
        dueFinalizations.slice(offset, offset + this.#config.max_concurrent_uploads)
          .map((record) => this.processFinalization(record))
      );
    }
    await this.persist();
    await this.writeMetrics();
    return {
      discovered: discovery.discovered,
      uploaded,
      retrying,
      terminal,
      cleanup_pending: this.#records.filter(
        (record) => record.state === 'uploaded_cleanup_pending'
      ).length
    };
  }

  async listRecords(): Promise<RustPbxRecordingSpoolRecord[]> {
    this.assertOpen();
    await this.#persistChain;
    return structuredClone(this.#records);
  }

  async listFinalizations(): Promise<RustPbxRecordingSpoolFinalizationRecord[]> {
    this.assertOpen();
    await this.#persistChain;
    return structuredClone(this.#finalizations);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#persistChain.catch(() => undefined);
    try {
      const lock = JSON.parse(await readFile(this.#lockPath, 'utf8')) as { token?: string };
      if (lock.token === this.#lockToken) await unlink(this.#lockPath);
    } catch (error) {
      if (nodeCode(error) !== 'ENOENT') throw error;
    }
  }

  private async discover(): Promise<{ discovered: number; terminal: number }> {
    const directories = (await readdir(this.#config.spool_directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    let discovered = 0;
    let terminal = 0;
    for (const directoryName of directories) {
      if (discovered >= this.#config.scan_limit) break;
      const directory = this.spoolPath(directoryName);
      const directoryStat = await lstat(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
      const manifests = (await readdir(directory))
        .filter((name) => /^segment-[0-9]{6}\.json$/.test(name))
        .sort();
      for (const filename of manifests) {
        if (discovered >= this.#config.scan_limit) break;
        const relativeManifest = join(directoryName, filename);
        if (this.#records.some((record) => record.manifest_relative_path === relativeManifest)) {
          continue;
        }
        const discoveredAt = this.#now().toISOString();
        try {
          const manifestFile = await readStableSmallFile(this.spoolPath(relativeManifest), 64 * 1024);
          const manifest = validateSegmentManifest(JSON.parse(manifestFile.content.toString('utf8')));
          if (manifest.recording_id !== directoryName) {
            throw localError('recording_spool_recording_directory_conflict');
          }
          const payloadRelative = join(directoryName, manifest.payload_filename);
          const payload = await inspectStableFile(this.spoolPath(payloadRelative));
          let wholeFileSha: string;
          try {
            if (payload.size !== manifest.size_bytes) {
              throw localError('recording_spool_local_file_size_conflict');
            }
            wholeFileSha = await hashOpenFile(payload.handle, payload.size);
            await assertFileUnchanged(payload.handle, payload.identity);
          } finally {
            await payload.handle.close();
          }
          this.#records.push({
            id: manifest.segment_id,
            state: 'pending',
            recording_id: manifest.recording_id,
            segment_id: manifest.segment_id,
            owner_epoch: manifest.owner_epoch,
            manifest_relative_path: relativeManifest,
            payload_relative_path: payloadRelative,
            event_relative_paths: [],
            manifest_sha256: sha256(manifestFile.content),
            whole_file_sha256: wholeFileSha,
            size_bytes: payload.size,
            attempt_count: 0,
            next_attempt_at: null,
            last_error_code: '',
            created_at: discoveredAt,
            updated_at: discoveredAt,
            uploaded_at: null
          });
          discovered += 1;
        } catch (error) {
          const localId = `invalid_${sha256(Buffer.from(relativeManifest)).slice(0, 48)}`;
          this.#records.push({
            id: localId,
            state: 'terminal',
            recording_id: directoryName,
            segment_id: localId,
            owner_epoch: '0',
            manifest_relative_path: relativeManifest,
            payload_relative_path: '',
            event_relative_paths: [],
            manifest_sha256: '',
            whole_file_sha256: '',
            size_bytes: 0,
            attempt_count: 0,
            next_attempt_at: null,
            last_error_code: errorCode(error, 'recording_spool_local_file_invalid'),
            created_at: discoveredAt,
            updated_at: discoveredAt,
            uploaded_at: null
          });
          discovered += 1;
          terminal += 1;
        }
      }
      if (this.#finalizations.length >= MAX_FINALIZATIONS) continue;
      const markerRelativePath = join(directoryName, COMPLETION_FILE);
      if (this.#finalizations.some((item) => item.marker_relative_path === markerRelativePath)) {
        continue;
      }
      const discoveredAt = this.#now().toISOString();
      try {
        const markerFile = await readStableSmallFile(this.spoolPath(markerRelativePath), 64 * 1024);
        const completion = validateRecordingCompletion(
          JSON.parse(markerFile.content.toString('utf8')),
          directoryName
        );
        this.#finalizations.push({
          recording_id: completion.recording_id,
          state: 'pending',
          marker_relative_path: markerRelativePath,
          marker_sha256: sha256(markerFile.content),
          attempt_count: 0,
          next_attempt_at: null,
          last_error_code: '',
          created_at: discoveredAt,
          updated_at: discoveredAt,
          finalized_at: null
        });
        discovered += 1;
      } catch (error) {
        if (nodeCode(error) === 'ENOENT') continue;
        this.#finalizations.push({
          recording_id: directoryName,
          state: 'terminal',
          marker_relative_path: markerRelativePath,
          marker_sha256: '',
          attempt_count: 0,
          next_attempt_at: null,
          last_error_code: errorCode(error, 'recording_spool_completion_invalid'),
          created_at: discoveredAt,
          updated_at: discoveredAt,
          finalized_at: null
        });
        discovered += 1;
        terminal += 1;
      }
    }
    if (discovered) await this.persist();
    return { discovered, terminal };
  }

  private async process(
    record: RustPbxRecordingSpoolRecord
  ): Promise<'uploaded' | 'retrying' | 'terminal'> {
    record.state = 'uploading';
    record.attempt_count += 1;
    record.next_attempt_at = null;
    record.last_error_code = '';
    record.updated_at = this.#now().toISOString();
    await this.persist();
    try {
      const manifestFile = await readStableSmallFile(
        this.spoolPath(record.manifest_relative_path),
        64 * 1024
      );
      if (sha256(manifestFile.content) !== record.manifest_sha256) {
        throw localError('recording_spool_manifest_changed');
      }
      const manifest = validateSegmentManifest(JSON.parse(manifestFile.content.toString('utf8')));
      assertRecordIdentity(record, manifest);
      const segmentEvents = await this.readSegmentEvents(record, manifest);
      record.event_relative_paths = segmentEvents.relative_paths;
      await this.persist();
      const payload = await inspectStableFile(this.spoolPath(record.payload_relative_path));
      try {
        if (payload.size !== record.size_bytes) throw localError('recording_spool_local_file_changed');
        const wholeFileSha = await hashOpenFile(payload.handle, payload.size);
        if (wholeFileSha !== record.whole_file_sha256) {
          throw localError('recording_spool_local_file_changed');
        }
        const leaseToken = this.leaseToken(record);
        const initialized = await this.requestJson(
          this.segmentsUrl(),
          'POST',
          {
            'content-type': 'application/json'
          },
          Buffer.from(JSON.stringify({
            segment: manifest,
            events: segmentEvents.events,
            whole_file: { size_bytes: record.size_bytes, sha256: record.whole_file_sha256 },
            worker_id: this.#config.worker_id,
            lease_token: leaseToken,
            lease_ms: this.#config.lease_ms,
            part_size_bytes: this.#config.part_size_bytes
          }))
        );
        if (initialized.state === 'completed') {
          await assertFileUnchanged(payload.handle, payload.identity);
          return await this.markUploadedAndCleanup(record);
        }
        const upload = recordValue(initialized.upload, 'recording_spool_upload_response_invalid');
        const partSize = integerValue(upload.part_size_bytes);
        if (partSize !== this.#config.part_size_bytes) {
          throw remoteError('recording_spool_upload_identity_conflict', false);
        }
        const uploadedParts = parseUploadedParts(initialized.parts);
        const partCount = Math.ceil(record.size_bytes / partSize);
        for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
          if (uploadedParts.has(partNumber)) continue;
          const expected = partNumber === partCount
            ? record.size_bytes - partSize * (partCount - 1)
            : partSize;
          const content = await readOpenFilePart(
            payload.handle,
            (partNumber - 1) * partSize,
            expected
          );
          await this.requestJson(
            `${this.segmentUrl(record.segment_id)}/parts/${partNumber}`,
            'PUT',
            this.leaseHeaders(record, leaseToken, {
              'content-type': 'application/octet-stream',
              'x-ivekit-content-sha256': sha256(content)
            }),
            content
          );
        }
        await assertFileUnchanged(payload.handle, payload.identity);
        await this.requestJson(
          `${this.segmentUrl(record.segment_id)}/complete`,
          'POST',
          this.leaseHeaders(record, leaseToken, { 'content-type': 'application/json' }),
          Buffer.from('{}')
        );
        return await this.markUploadedAndCleanup(record);
      } finally {
        await payload.handle.close();
      }
    } catch (error) {
      const retryable = error instanceof RustPbxRecordingSpoolWorkerError && error.retryable;
      record.last_error_code = errorCode(error, 'recording_spool_upload_failed');
      record.updated_at = this.#now().toISOString();
      if (retryable) {
        record.state = 'pending';
        record.next_attempt_at = new Date(
          this.#now().getTime() + this.retryDelay(record.attempt_count)
        ).toISOString();
        await this.persist();
        return 'retrying';
      }
      record.state = 'terminal';
      record.next_attempt_at = null;
      await this.persist();
      return 'terminal';
    }
  }

  private async markUploadedAndCleanup(
    record: RustPbxRecordingSpoolRecord
  ): Promise<'uploaded'> {
    const now = this.#now().toISOString();
    record.state = 'uploaded_cleanup_pending';
    record.uploaded_at = now;
    record.updated_at = now;
    record.next_attempt_at = null;
    record.last_error_code = '';
    this.#lastUploadSucceededAt = now;
    await this.persist();
    await this.cleanup(record);
    return 'uploaded';
  }

  private async cleanup(record: RustPbxRecordingSpoolRecord): Promise<boolean> {
    try {
      if (record.payload_relative_path) {
        await removeIfExists(this.#removeFile, this.spoolPath(record.payload_relative_path));
      }
      for (const relativePath of record.event_relative_paths) {
        await removeIfExists(this.#removeFile, this.spoolPath(relativePath));
      }
      await removeIfExists(this.#removeFile, this.spoolPath(record.manifest_relative_path));
      const index = this.#records.indexOf(record);
      if (index >= 0) this.#records.splice(index, 1);
      await this.persist();
      return true;
    } catch {
      record.state = 'uploaded_cleanup_pending';
      record.last_error_code = 'recording_spool_cleanup_failed';
      record.updated_at = this.#now().toISOString();
      await this.persist();
      return false;
    }
  }

  private async processFinalization(
    record: RustPbxRecordingSpoolFinalizationRecord
  ): Promise<void> {
    record.state = 'finalizing';
    record.attempt_count += 1;
    record.next_attempt_at = null;
    record.last_error_code = '';
    record.updated_at = this.#now().toISOString();
    await this.persist();
    try {
      const markerFile = await readStableSmallFile(
        this.spoolPath(record.marker_relative_path),
        64 * 1024
      );
      if (sha256(markerFile.content) !== record.marker_sha256) {
        throw localError('recording_spool_completion_changed');
      }
      const completion = validateRecordingCompletion(
        JSON.parse(markerFile.content.toString('utf8')),
        record.recording_id
      );
      const response = await this.requestJson(
        this.completionUrl(record.recording_id),
        'POST',
        { 'content-type': 'application/json' },
        Buffer.from(JSON.stringify(completion))
      );
      const uploaded = response.state === 'uploaded_unverified';
      const droppedSamplesFailed = response.state === 'failed'
        && response.failure_code === 'recording_samples_dropped';
      if (response.id !== record.recording_id || (!uploaded && !droppedSamplesFailed)) {
        throw remoteError('recording_spool_completion_response_invalid', true);
      }
      const now = this.#now().toISOString();
      record.state = 'finalized_cleanup_pending';
      record.finalized_at = now;
      record.updated_at = now;
      await this.persist();
      await this.cleanupFinalization(record);
    } catch (error) {
      const retryable = error instanceof RustPbxRecordingSpoolWorkerError && error.retryable;
      record.last_error_code = errorCode(error, 'recording_spool_completion_failed');
      record.updated_at = this.#now().toISOString();
      if (retryable) {
        record.state = 'pending';
        record.next_attempt_at = new Date(
          this.#now().getTime() + this.retryDelay(record.attempt_count)
        ).toISOString();
      } else {
        record.state = 'terminal';
        record.next_attempt_at = null;
      }
      await this.persist();
    }
  }

  private async cleanupFinalization(
    record: RustPbxRecordingSpoolFinalizationRecord
  ): Promise<boolean> {
    try {
      const directory = dirname(record.marker_relative_path);
      for (const filename of ['segments.ndjson', 'events.ndjson', COMPLETION_FILE]) {
        await removeIfExists(this.#removeFile, this.spoolPath(join(directory, filename)));
      }
      const index = this.#finalizations.indexOf(record);
      if (index >= 0) this.#finalizations.splice(index, 1);
      await this.persist();
      return true;
    } catch {
      record.state = 'finalized_cleanup_pending';
      record.last_error_code = 'recording_spool_completion_cleanup_failed';
      record.updated_at = this.#now().toISOString();
      await this.persist();
      return false;
    }
  }

  private async requestJson(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: Buffer
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: { ...headers, 'x-pbx-key': this.#serviceKey },
        body
      });
    } catch {
      throw remoteError('recording_spool_network_unavailable', true);
    }
    const parsed = await boundedJsonResponse(response);
    if (!response.ok) {
      const code = responseCode(parsed) || `recording_spool_http_${response.status}`;
      throw remoteError(
        code,
        response.status === 408 || response.status === 409 || response.status === 429 ||
          response.status >= 500
      );
    }
    return recordValue(parsed.data, 'recording_spool_response_invalid');
  }

  private leaseHeaders(
    record: RustPbxRecordingSpoolRecord,
    leaseToken: string,
    extra: Record<string, string>
  ): Record<string, string> {
    return {
      ...extra,
      'x-ivekit-recording-worker-id': this.#config.worker_id,
      'x-ivekit-recording-owner-epoch': record.owner_epoch,
      'x-ivekit-recording-lease-token': leaseToken
    };
  }

  private leaseToken(record: RustPbxRecordingSpoolRecord): string {
    return createHmac('sha256', this.#leaseSecret)
      .update(record.recording_id)
      .update('\0')
      .update(record.segment_id)
      .update('\0')
      .update(record.owner_epoch)
      .digest('base64url');
  }

  private segmentsUrl(): string {
    return `${this.#config.base_url}/api/ivekit/voice/providers/${encodeURIComponent(
      this.#config.profile_id
    )}/recording-spool/segments`;
  }

  private segmentUrl(segmentId: string): string {
    return `${this.segmentsUrl()}/${encodeURIComponent(segmentId)}`;
  }

  private completionUrl(recordingId: string): string {
    return `${this.#config.base_url}/api/ivekit/voice/providers/${encodeURIComponent(
      this.#config.profile_id
    )}/recording-spool/recordings/${encodeURIComponent(recordingId)}/complete`;
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.#config.retry_max_ms,
      this.#config.retry_base_ms * 2 ** Math.min(Math.max(attempt - 1, 0), 20)
    );
    return Math.max(1, Math.floor(exponential * (0.5 + this.#random())));
  }

  private spoolPath(relativePath: string): string {
    const root = resolve(this.#config.spool_directory);
    const path = resolve(root, relativePath);
    if (path === root || !path.startsWith(`${root}${sep}`) || relative(root, path).startsWith('..')) {
      throw localError('recording_spool_path_invalid');
    }
    return path;
  }

  private async readSegmentEvents(
    record: RustPbxRecordingSpoolRecord,
    manifest: RustPbxRecordingSegmentManifestV1
  ): Promise<{ events: RustPbxRecordingSegmentEventV1[]; relative_paths: string[] }> {
    const directory = dirname(record.manifest_relative_path);
    const filenames = (await readdir(this.spoolPath(directory)))
      .filter((name) => /^event-[0-9]{6,20}\.json$/.test(name))
      .sort();
    if (filenames.length > MAX_SEGMENT_EVENTS) {
      throw localError('recording_spool_events_limit_exceeded');
    }
    const found: Array<{ event: RustPbxRecordingSegmentEventV1; relative_path: string }> = [];
    for (const filename of filenames) {
      const relativePath = join(directory, filename);
      const raw = await readStableSmallFile(this.spoolPath(relativePath), 64 * 1024);
      let value: unknown;
      try {
        value = JSON.parse(raw.content.toString('utf8'));
      } catch {
        throw localError('recording_spool_event_invalid');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw localError('recording_spool_event_invalid');
      }
      if (String((value as Record<string, unknown>).segment_id || '') !== manifest.segment_id) {
        continue;
      }
      const event = validateSegmentEvent(value, manifest);
      const filenameSequence = Number(filename.slice('event-'.length, -'.json'.length));
      if (filenameSequence !== event.event_sequence) {
        throw localError('recording_spool_event_sequence_conflict');
      }
      found.push({ event, relative_path: relativePath });
    }
    found.sort((left, right) => left.event.event_sequence - right.event.event_sequence);
    if (new Set(found.map((item) => item.event.event_sequence)).size !== found.length) {
      throw localError('recording_spool_event_sequence_conflict');
    }
    return {
      events: found.map((item) => item.event),
      relative_paths: found.map((item) => item.relative_path)
    };
  }

  private async acquireLock(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ token: this.#lockToken, pid: process.pid }));
      await handle.sync();
    } catch (error) {
      if (nodeCode(error) === 'EEXIST') throw localError('recording_spool_worker_locked');
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async load(): Promise<void> {
    let raw: Buffer;
    try {
      raw = await readStableSmallFile(this.#statePath, MAX_STATE_BYTES).then((item) => item.content);
    } catch (error) {
      if (nodeCode(error) === 'ENOENT') return;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString('utf8'));
    } catch {
      throw localError('recording_spool_state_invalid');
    }
    const state = decodeState(value);
    this.#records = state.records;
    this.#finalizations = state.finalizations;
    this.#lastUploadSucceededAt = state.last_upload_succeeded_at;
  }

  private async recoverInterruptedUploads(): Promise<void> {
    let changed = false;
    for (const record of this.#records) {
      if (record.state !== 'uploading') continue;
      record.state = 'pending';
      record.next_attempt_at = null;
      record.updated_at = this.#now().toISOString();
      changed = true;
    }
    for (const record of this.#finalizations) {
      if (record.state !== 'finalizing') continue;
      record.state = 'pending';
      record.next_attempt_at = null;
      record.updated_at = this.#now().toISOString();
      changed = true;
    }
    if (changed) await this.persist();
  }

  private persist(): Promise<void> {
    this.#persistChain = this.#persistChain.then(async () => {
      const state: StateDocument = {
        schema_version: 2,
        records: structuredClone(this.#records),
        finalizations: structuredClone(this.#finalizations),
        last_upload_succeeded_at: this.#lastUploadSucceededAt
      };
      await writeAtomicJson(this.#statePath, state);
    });
    return this.#persistChain;
  }

  private async writeMetrics(): Promise<void> {
    const filesystem = validateFilesystemStats(
      await this.#filesystemStats(this.#config.spool_directory)
    );
    const usedBytes = filesystem.capacity_bytes - filesystem.available_bytes;
    const active = this.#records.filter((record) => record.state !== 'terminal');
    const oldest = active.reduce<number | null>((result, record) => {
      const timestamp = Date.parse(record.created_at);
      return result === null || timestamp < result ? timestamp : result;
    }, null);
    const activeFinalizations = this.#finalizations.filter(
      (record) => record.state !== 'terminal'
    );
    const oldestFinalization = activeFinalizations.reduce<number | null>((result, record) => {
      const timestamp = Date.parse(record.created_at);
      return result === null || timestamp < result ? timestamp : result;
    }, null);
    const states = Object.fromEntries(
      ['pending', 'uploading', 'uploaded_cleanup_pending', 'terminal'].map((state) => [
        state,
        this.#records.filter((record) => record.state === state).length
      ])
    );
    await writeAtomicJson(this.#metricsPath, {
      schema_version: 1,
      observed_at: this.#now().toISOString(),
      capacity_bytes: filesystem.capacity_bytes,
      available_bytes: filesystem.available_bytes,
      used_bytes: usedBytes,
      utilization_ratio: usedBytes / filesystem.capacity_bytes,
      non_core_admission: recordingSpoolAdmission({
        used_bytes: usedBytes,
        capacity_bytes: filesystem.capacity_bytes,
        recording_class: 'non_core'
      }),
      must_record_admission: recordingSpoolAdmission({
        used_bytes: usedBytes,
        capacity_bytes: filesystem.capacity_bytes,
        recording_class: 'must_record'
      }),
      backlog_segments: active.length,
      backlog_bytes: active.reduce((total, record) => total + record.size_bytes, 0),
      oldest_backlog_age_seconds: oldest === null
        ? 0
        : Math.max(0, Math.floor((this.#now().getTime() - oldest) / 1000)),
      terminal_segments: states.terminal,
      states,
      finalization_backlog: activeFinalizations.length,
      finalization_terminal: this.#finalizations.filter(
        (record) => record.state === 'terminal'
      ).length,
      oldest_finalization_age_seconds: oldestFinalization === null
        ? 0
        : Math.max(0, Math.floor((this.#now().getTime() - oldestFinalization) / 1000)),
      last_upload_succeeded_at: this.#lastUploadSucceededAt
    });
  }

  private assertOpen(): void {
    if (this.#closed) throw localError('recording_spool_worker_closed');
  }
}

async function filesystemStats(path: string): Promise<{
  capacity_bytes: number;
  available_bytes: number;
}> {
  const stats = await statfs(path, { bigint: true });
  const capacity = stats.blocks * stats.bsize;
  const available = stats.bavail * stats.bsize;
  if (capacity > BigInt(Number.MAX_SAFE_INTEGER) || available > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw localError('recording_spool_filesystem_capacity_invalid');
  }
  return { capacity_bytes: Number(capacity), available_bytes: Number(available) };
}

function validateFilesystemStats(input: {
  capacity_bytes: number;
  available_bytes: number;
}): { capacity_bytes: number; available_bytes: number } {
  if (!Number.isSafeInteger(input.capacity_bytes) || input.capacity_bytes < 1 ||
      !Number.isSafeInteger(input.available_bytes) || input.available_bytes < 0 ||
      input.available_bytes > input.capacity_bytes) {
    throw localError('recording_spool_filesystem_capacity_invalid');
  }
  return input;
}

export function rustPbxRecordingSpoolWorkerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): RustPbxRecordingSpoolWorkerConfig {
  return validateConfig({
    base_url: requiredEnv(env, 'OPC_IVEKIT_RECORDING_BASE_URL'),
    profile_id: requiredEnv(env, 'OPC_IVEKIT_RECORDING_PROFILE_ID'),
    worker_id: requiredEnv(env, 'OPC_IVEKIT_RECORDING_WORKER_ID'),
    spool_directory: requiredEnv(env, 'OPC_IVEKIT_RECORDING_SPOOL_DIR'),
    state_directory: requiredEnv(env, 'OPC_IVEKIT_RECORDING_STATE_DIR'),
    service_key_file: requiredEnv(env, 'OPC_IVEKIT_RECORDING_SERVICE_KEY_FILE'),
    lease_secret_file: requiredEnv(env, 'OPC_IVEKIT_RECORDING_LEASE_SECRET_FILE'),
    part_size_bytes: envInteger(
      env.OPC_IVEKIT_RECORDING_PART_SIZE_BYTES,
      8 * 1024 * 1024,
      5 * 1024 * 1024,
      recordingSpoolHttpPartMaxBytes(env),
      'OPC_IVEKIT_RECORDING_PART_SIZE_BYTES'
    ),
    lease_ms: envInteger(
      env.OPC_IVEKIT_RECORDING_LEASE_MS,
      5 * 60_000,
      10_000,
      15 * 60_000,
      'OPC_IVEKIT_RECORDING_LEASE_MS'
    ),
    scan_limit: envInteger(env.OPC_IVEKIT_RECORDING_SCAN_LIMIT, 1000, 1, 100_000, 'OPC_IVEKIT_RECORDING_SCAN_LIMIT'),
    max_concurrent_uploads: envInteger(
      env.OPC_IVEKIT_RECORDING_UPLOAD_CONCURRENCY,
      4,
      1,
      64,
      'OPC_IVEKIT_RECORDING_UPLOAD_CONCURRENCY'
    ),
    retry_base_ms: envInteger(env.OPC_IVEKIT_RECORDING_RETRY_BASE_MS, 1_000, 1, 60_000, 'OPC_IVEKIT_RECORDING_RETRY_BASE_MS'),
    retry_max_ms: envInteger(env.OPC_IVEKIT_RECORDING_RETRY_MAX_MS, 60_000, 1, 3_600_000, 'OPC_IVEKIT_RECORDING_RETRY_MAX_MS')
  });
}

function validateConfig(config: RustPbxRecordingSpoolWorkerConfig): RustPbxRecordingSpoolWorkerConfig {
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.base_url);
  } catch {
    throw localError('recording_spool_base_url_invalid');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.hash) {
    throw localError('recording_spool_base_url_invalid');
  }
  if (!isAbsolute(config.spool_directory) || !isAbsolute(config.state_directory)
    || resolve(config.spool_directory) === resolve(config.state_directory)) {
    throw localError('recording_spool_directory_invalid');
  }
  identifier(config.profile_id, 'recording_spool_profile_invalid');
  identifier(config.worker_id, 'recording_spool_worker_invalid');
  bounded(config.part_size_bytes, 5 * 1024 * 1024, 16 * 1024 * 1024, 'recording_spool_part_size_invalid');
  bounded(config.lease_ms, 10_000, 15 * 60_000, 'recording_spool_lease_invalid');
  bounded(config.scan_limit, 1, 100_000, 'recording_spool_scan_limit_invalid');
  bounded(config.max_concurrent_uploads, 1, 64, 'recording_spool_concurrency_invalid');
  bounded(config.retry_base_ms, 1, 60_000, 'recording_spool_retry_invalid');
  bounded(config.retry_max_ms, config.retry_base_ms, 3_600_000, 'recording_spool_retry_invalid');
  return { ...config, base_url: baseUrl.toString().replace(/\/$/, '') };
}

async function assertPrivateDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw localError('recording_spool_directory_invalid');
  if (create) await chmod(path, 0o700);
}

async function readSecret(path: string, label: string): Promise<string> {
  const file = await readStableSmallFile(path, 4096);
  const value = file.content.toString('utf8').trim();
  if (!value || /[\u0000-\u001f\u007f]/.test(value) || value.length > 2048) {
    throw localError(`${label.replaceAll(' ', '_')}_invalid`);
  }
  return value;
}

async function readStableSmallFile(
  path: string,
  maxBytes: number
): Promise<{ content: Buffer }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw localError('recording_spool_local_file_invalid');
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.read(content, offset, content.length - offset, offset);
      if (result.bytesRead === 0) throw localError('recording_spool_local_file_changed');
      offset += result.bytesRead;
    }
    await assertFileUnchanged(handle, fileIdentity(before));
    return { content };
  } finally {
    await handle.close();
  }
}

async function inspectStableFile(path: string) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || !Number.isSafeInteger(info.size)) {
      throw localError('recording_spool_local_file_invalid');
    }
    return { handle, size: info.size, identity: fileIdentity(info) };
  } catch (error) {
    await handle?.close();
    throw error instanceof RustPbxRecordingSpoolWorkerError
      ? error
      : localError('recording_spool_local_file_invalid');
  }
}

function fileIdentity(info: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>) {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtimeMs: Number(info.mtimeMs)
  };
}

async function assertFileUnchanged(
  handle: Awaited<ReturnType<typeof open>>,
  expected: { dev: string; ino: string; size: number; mtimeMs: number }
): Promise<void> {
  const current = await handle.stat();
  if (String(current.dev) !== expected.dev || String(current.ino) !== expected.ino ||
    Number(current.size) !== expected.size || Number(current.mtimeMs) !== expected.mtimeMs) {
    throw localError('recording_spool_local_file_changed');
  }
}

async function hashOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number
): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER_BYTES, size));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.length, size - offset);
    const result = await handle.read(buffer, 0, length, offset);
    if (result.bytesRead !== length) throw localError('recording_spool_local_file_changed');
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  return hash.digest('hex');
}

async function readOpenFilePart(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  size: number
): Promise<Buffer> {
  const content = Buffer.allocUnsafe(size);
  let read = 0;
  while (read < size) {
    const result = await handle.read(content, read, size - read, offset + read);
    if (result.bytesRead === 0) throw localError('recording_spool_local_file_changed');
    read += result.bytesRead;
  }
  return content;
}

async function boundedJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw remoteError('recording_spool_response_too_large', true);
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw remoteError('recording_spool_response_too_large', true);
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) return {};
  try {
    return recordValue(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'recording_spool_response_invalid');
  } catch (error) {
    if (error instanceof RustPbxRecordingSpoolWorkerError) throw error;
    throw remoteError('recording_spool_response_invalid', true);
  }
}

function parseUploadedParts(value: unknown): Set<number> {
  if (!Array.isArray(value)) throw remoteError('recording_spool_upload_response_invalid', true);
  const parts = new Set<number>();
  for (const item of value) {
    const part = recordValue(item, 'recording_spool_upload_response_invalid');
    const number = integerValue(part.part_number);
    if (number < 1 || number > 10_000 || parts.has(number)) {
      throw remoteError('recording_spool_upload_response_invalid', true);
    }
    parts.add(number);
  }
  return parts;
}

function assertRecordIdentity(
  record: RustPbxRecordingSpoolRecord,
  manifest: RustPbxRecordingSegmentManifestV1
): void {
  if (manifest.recording_id !== record.recording_id ||
    manifest.segment_id !== record.segment_id ||
    manifest.owner_epoch !== record.owner_epoch ||
    manifest.size_bytes !== record.size_bytes ||
    join(manifest.recording_id, manifest.payload_filename) !== record.payload_relative_path) {
    throw localError('recording_spool_manifest_changed');
  }
}

function decodeState(value: unknown): StateDocument {
  const document = recordValue(value, 'recording_spool_state_invalid');
  if (![1, 2].includes(Number(document.schema_version)) || !Array.isArray(document.records)) {
    throw localError('recording_spool_state_invalid');
  }
  const records = document.records as RustPbxRecordingSpoolRecord[];
  if (records.length > 100_000 || records.some((record) =>
    !record || typeof record !== 'object' ||
    !['pending', 'uploading', 'uploaded_cleanup_pending', 'terminal'].includes(record.state) ||
    typeof record.id !== 'string' || typeof record.manifest_relative_path !== 'string' ||
    (record.event_relative_paths !== undefined && (
      !Array.isArray(record.event_relative_paths) ||
      record.event_relative_paths.length > MAX_SEGMENT_EVENTS ||
      record.event_relative_paths.some((path) => typeof path !== 'string')
    ))
  )) throw localError('recording_spool_state_invalid');
  const last = document.last_upload_succeeded_at;
  if (last !== null && last !== undefined && !Number.isFinite(Date.parse(String(last)))) {
    throw localError('recording_spool_state_invalid');
  }
  const finalizations = document.schema_version === 2 ? document.finalizations : [];
  if (!Array.isArray(finalizations) || finalizations.length > MAX_FINALIZATIONS ||
      finalizations.some((record) => !record || typeof record !== 'object' ||
        !['pending', 'finalizing', 'finalized_cleanup_pending', 'terminal'].includes(record.state) ||
        typeof record.recording_id !== 'string' || typeof record.marker_relative_path !== 'string' ||
        typeof record.marker_sha256 !== 'string')) {
    throw localError('recording_spool_state_invalid');
  }
  return {
    schema_version: 2,
    records: records.map((record) => ({
      ...structuredClone(record),
      event_relative_paths: structuredClone(record.event_relative_paths || [])
    })),
    finalizations: structuredClone(finalizations) as RustPbxRecordingSpoolFinalizationRecord[],
    last_upload_succeeded_at: last ? new Date(String(last)).toISOString() : null
  };
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`);
  if (encoded.length > MAX_STATE_BYTES) throw localError('recording_spool_state_too_large');
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function removeIfExists(
  remove: (path: string) => Promise<void>,
  path: string
): Promise<void> {
  try {
    await remove(path);
  } catch (error) {
    if (nodeCode(error) !== 'ENOENT') throw error;
  }
}

function responseCode(value: Record<string, unknown>): string {
  const direct = value.error;
  const nested = value.data && typeof value.data === 'object'
    ? (value.data as Record<string, unknown>).error
    : null;
  const error = direct && typeof direct === 'object'
    ? direct as Record<string, unknown>
    : nested && typeof nested === 'object'
      ? nested as Record<string, unknown>
      : {};
  return typeof error.code === 'string' && /^[a-z0-9_]{1,128}$/.test(error.code)
    ? error.code
    : '';
}

function recordValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw remoteError(code, true);
  return value as Record<string, unknown>;
}

function integerValue(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw remoteError('recording_spool_upload_response_invalid', true);
  return number;
}

function identifier(value: unknown, code: string): string {
  const text = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(text)) throw localError(code);
  return text;
}

function bounded(value: unknown, min: number, max: number, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw localError(code);
  return number;
}

function envInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  return bounded(value === undefined || value === '' ? fallback : value, min, max, `${name}_invalid`);
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] || '').trim();
  if (!value) throw localError(`${name}_required`);
  return value;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof RustPbxRecordingSpoolWorkerError ? error.code : fallback;
}

function nodeCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
}

export class RustPbxRecordingSpoolWorkerError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = 'RustPbxRecordingSpoolWorkerError';
  }
}

function localError(code: string): RustPbxRecordingSpoolWorkerError {
  return new RustPbxRecordingSpoolWorkerError(code, false);
}

function remoteError(code: string, retryable: boolean): RustPbxRecordingSpoolWorkerError {
  return new RustPbxRecordingSpoolWorkerError(code, retryable);
}
