import { createHash } from 'node:crypto';
import { DirectFileOutput, EgressClient, EncodedFileOutput, EncodedFileType } from 'livekit-server-sdk';
import { all, id, json, one, parseJson, run } from '../../db-compat.js';
import {
  assertRecordingObjectExportSize,
  deleteRecordingObject,
  resolveRecordingObjectContent,
  resolveRecordingObjectStream
} from '../media-recording-object.js';
import { isLiveKitConfigured, readLiveKitConfig } from './config.js';
import type {
  EgressRecord,
  LiveKitEgressJob,
  LiveKitEgressClientLike,
  LiveKitEgressPlacementReservation,
  LiveKitRecordingMode,
  LiveKitRecordingTrackSelector,
  LiveKitRecordingDependencies,
  LiveKitRecordingServiceApi,
  MediaBusinessRef,
  RecordingFormat,
  RecordingObjectContentResult,
  RecordingObjectDeleteResult,
  RecordingObjectExport,
  RecordingObjectInspection,
  RecordingRetentionCleanupResult,
  RecordingCursorPage,
  RecordingListOptions,
  StartRecordingOptions
} from './types.js';

export interface EgressConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  minioEndpoint?: string;
  minioBucket?: string;
  recordingRetentionDays?: number;
}

function configFromEgressConfig(config: EgressConfig) {
  const envConfig = readLiveKitConfig();
  return {
    ...envConfig,
    url: config.livekitUrl || envConfig.url,
    apiKey: config.livekitApiKey || envConfig.apiKey,
    apiSecret: config.livekitApiSecret || envConfig.apiSecret
  };
}

function toHttpUrl(wsUrl: string): string {
  if (wsUrl.startsWith('wss://')) return `https://${wsUrl.slice('wss://'.length)}`;
  if (wsUrl.startsWith('ws://')) return `http://${wsUrl.slice('ws://'.length)}`;
  return wsUrl;
}

function mapFileType(format: string): EncodedFileType {
  switch (format) {
    case 'mp4':
      return EncodedFileType.MP4;
    case 'ogg':
      return EncodedFileType.OGG;
    case 'wav':
    case 'webm':
    default:
      return EncodedFileType.DEFAULT_FILETYPE;
  }
}

function safeStorageSegment(value: string): string {
  return String(value || 'unbound').replace(/[^a-zA-Z0-9._-]/g, '_') || 'unbound';
}

function normalizeBusinessRef(
  tenantId: string,
  callSessionId: string | null | undefined,
  businessRef?: MediaBusinessRef | null
): MediaBusinessRef | null {
  if (businessRef) {
    const type = String(businessRef.type || '').trim();
    const idValue = String(businessRef.id || '').trim();
    const refTenant = String(businessRef.tenant_id || tenantId);
    if (refTenant !== tenantId) {
      throw Object.assign(new Error('business_ref tenant mismatch'), { status: 400 });
    }
    if (!type || !idValue) {
      throw Object.assign(new Error('business_ref.type and business_ref.id are required'), { status: 400 });
    }
    return {
      tenant_id: tenantId,
      type,
      id: idValue,
      display_name: businessRef.display_name ? String(businessRef.display_name) : undefined,
      metadata: businessRef.metadata && typeof businessRef.metadata === 'object' ? businessRef.metadata : {}
    };
  }
  if (callSessionId) {
    return {
      tenant_id: tenantId,
      type: 'call_session',
      id: callSessionId,
      metadata: {}
    };
  }
  return null;
}

export function resolveRecordingRetentionUntil(
  input: { retentionUntil?: string | null; retentionDays?: number } = {},
  now = new Date(),
  configuredDays?: number
): string {
  if (input.retentionUntil) {
    const parsed = new Date(input.retentionUntil);
    if (Number.isNaN(parsed.getTime())) {
      throw Object.assign(new Error('retention_until must be a valid timestamp'), { status: 400 });
    }
    return parsed.toISOString();
  }
  const envDays = Number(process.env.OPC_MEDIA_RECORDING_RETENTION_DAYS || 90);
  const requestedDays = input.retentionDays ?? configuredDays ?? envDays;
  if (!Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > 3650) {
    throw Object.assign(new Error('retention_days must be between 1 and 3650'), { status: 400 });
  }
  return new Date(now.getTime() + Math.floor(requestedDays) * 86_400_000).toISOString();
}

export class LiveKitRecordingService implements LiveKitRecordingServiceApi {
  constructor(
    private readonly db: unknown,
    private readonly config: EgressConfig = {
      livekitUrl: '',
      livekitApiKey: '',
      livekitApiSecret: ''
    },
    private readonly deps: LiveKitRecordingDependencies = {}
  ) {}

  async startRecording(
    tenantId: string,
    callSessionId: string | null | undefined,
    roomName: string,
    opts: StartRecordingOptions = {}
  ): Promise<EgressRecord> {
    const format = normalizeFormat(opts.format);
    const recordingPlan = normalizeRecordingPlan(opts);
    const businessRef = normalizeBusinessRef(tenantId, callSessionId, opts.businessRef);
    const now = this.now();
    const timestamp = now.getTime();
    const bucket = safeStorageSegment(this.config.minioBucket || process.env.MINIO_BUCKET || 'recordings');
    const storageRefType = safeStorageSegment(businessRef?.type || 'unbound');
    const storageRefId = safeStorageSegment(businessRef?.id || callSessionId || 'unbound');
    const recordId = id('crec');
    const jobs = buildEgressJobPlans({
      tenantId,
      storageRefType,
      storageRefId,
      timestamp,
      recordId,
      format,
      bucket,
      recordingPlan
    });
    const storageUrl = jobs[0]!.storageUrl;
    const lkConfig = await this.resolveLiveKitConfig({
      tenant_id: tenantId,
      media_call_id: String(opts.mediaCallId || ''),
      room_name: roomName
    });
    const providerConfigured = isLiveKitConfigured(lkConfig);
    const pendingEgressId = providerConfigured ? '' : `egress_pending_${jobs[0]!.jobId}`;
    const tenantRetentionDays = opts.retentionUntil || opts.retentionDays != null
      ? undefined
      : await this.resolveTenantRetentionDays(tenantId);
    const retentionUntil = resolveRecordingRetentionUntil(
      opts,
      now,
      tenantRetentionDays ?? this.config.recordingRetentionDays
    );

    const activeRecording = this.getActiveRecordingByRoom(tenantId, roomName);
    if (activeRecording) throw activeRecordingConflict(activeRecording.id);

    const reservations = new Map<string, LiveKitEgressPlacementReservation>();
    if (providerConfigured && this.deps.reserveEgressJob) {
      try {
        for (const job of jobs) {
          const reservation = await this.deps.reserveEgressJob({
            tenant_id: tenantId,
            recording_id: recordId,
            job_id: job.jobId,
            room_name: roomName,
            recording_mode: recordingPlan.mode,
            business_ref: businessRef
          });
          if (reservation.job_id !== job.jobId || !reservation.reservation_id || !reservation.owner_epoch) {
            throw new Error('invalid LiveKit Egress placement reservation');
          }
          reservations.set(job.jobId, reservation);
        }
      } catch (cause) {
        await this.closeEgressReservations(reservations, 'egress_reservation_failed');
        throw cause;
      }
    }

    try {
      run(
        this.db,
        `INSERT INTO call_recordings
          (id, tenant_id, call_session_id, media_call_id, room_name, business_ref_type, business_ref_id, business_ref_metadata,
           source, format, storage_url, has_video, recording_mode, egress_id, status, retention_until,
           object_status, failure_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'livekit_egress', ?, ?, ?, ?, ?, ?, ?, 'unchecked', '', CURRENT_TIMESTAMP)`,
        [
          recordId,
          tenantId,
          callSessionId || null,
          opts.mediaCallId || null,
          roomName,
          businessRef?.type || '',
          businessRef?.id || '',
          json({
            display_name: businessRef?.display_name || '',
            metadata: businessRef?.metadata || {}
          }),
          format,
          storageUrl,
          recordingPlan.hasVideo ? 1 : 0,
          recordingPlan.mode,
          pendingEgressId,
          providerConfigured ? 'starting' : 'pending',
          retentionUntil
        ]
      );
      for (const [jobIndex, job] of jobs.entries()) {
        run(
          this.db,
          `INSERT INTO livekit_egress_jobs
            (id, tenant_id, recording_id, job_sequence, room_name, recording_mode, track_id, track_kind,
             track_source, audio_track_id, video_track_id, storage_url, egress_id, status,
             failure_code, reservation_id, owner_epoch, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, CURRENT_TIMESTAMP)`,
          [
            job.jobId,
            tenantId,
            recordId,
            jobIndex + 1,
            roomName,
            recordingPlan.mode,
            job.trackId,
            job.trackKind,
            job.trackSource,
            job.audioTrackId,
            job.videoTrackId,
            job.storageUrl,
            providerConfigured ? '' : `egress_pending_${job.jobId}`,
            providerConfigured ? 'starting' : 'pending',
            reservations.get(job.jobId)?.reservation_id || '',
            reservations.get(job.jobId)?.owner_epoch || null
          ]
        );
      }
    } catch (cause) {
      await this.closeEgressReservations(reservations, 'egress_persistence_failed');
      run(this.db, 'DELETE FROM livekit_egress_jobs WHERE recording_id = ?', [recordId]);
      run(this.db, 'DELETE FROM call_recordings WHERE id = ?', [recordId]);
      const concurrent = this.getActiveRecordingByRoom(tenantId, roomName);
      if (concurrent) throw activeRecordingConflict(concurrent.id);
      throw cause;
    }

    if (providerConfigured) {
      let client: LiveKitEgressClientLike | undefined;
      const startedEgressIds: string[] = [];
      let failureCode = 'livekit_egress_start_failed';
      try {
        client = this.createEgressClient(lkConfig);
        for (const job of jobs) {
          const info = await startProviderEgressJob(client, roomName, format, job, recordingPlan);
          const startedEgressId = String(info.egressId || '').trim();
          if (!startedEgressId) throw new Error('missing egress id');
          startedEgressIds.push(startedEgressId);
          try {
            run(
              this.db,
              `UPDATE livekit_egress_jobs
               SET egress_id = ?, status = 'recording', failure_code = '', updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [startedEgressId, job.jobId]
            );
            const reservation = reservations.get(job.jobId);
            if (reservation && this.deps.activateEgressJob) {
              try {
                await this.deps.activateEgressJob(reservation);
              } catch (cause) {
                failureCode = 'livekit_egress_admission_activation_failed';
                throw cause;
              }
            }
          } catch (cause) {
            if (failureCode !== 'livekit_egress_admission_activation_failed') {
              failureCode = 'livekit_egress_persistence_failed';
            }
            throw cause;
          }
        }
        try {
          run(
            this.db,
            `UPDATE call_recordings
             SET egress_id = ?, status = 'recording', failure_code = '', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [startedEgressIds[0], recordId]
          );
        } catch (cause) {
          failureCode = 'livekit_egress_persistence_failed';
          throw cause;
        }
      } catch {
        if (client) {
          for (const egressId of startedEgressIds) {
            try {
              await client.stopEgress(egressId);
            } catch {
              failureCode = 'livekit_egress_compensation_failed';
            }
          }
        }
        await this.closeEgressReservations(reservations, failureCode);
        run(
          this.db,
          `UPDATE livekit_egress_jobs
           SET status = 'failed', failure_code = ?, updated_at = CURRENT_TIMESTAMP
           WHERE recording_id = ? AND status IN ('starting', 'recording')`,
          [failureCode, recordId]
        );
        run(
          this.db,
          `UPDATE call_recordings
           SET status = 'failed', failure_code = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [failureCode, recordId]
        );
        throw providerFailure(failureCode, recordId);
      }
    }

    return this.getRecording(recordId)!;
  }

  startCallRecording(
    tenantId: string,
    callSessionId: string | null | undefined,
    roomName: string,
    opts: StartRecordingOptions & { mediaCallId: string }
  ): Promise<EgressRecord> {
    return this.startRecording(tenantId, callSessionId, roomName, opts);
  }

  async stopRecording(egressId: string): Promise<EgressRecord | null> {
    const record = this.getRecordingByEgressId(egressId);
    if (!record) return null;
    if (record.status === 'deleted' || record.status === 'completed' || record.status === 'stopped') {
      return record;
    }

    const lkConfig = await this.resolveLiveKitConfig({
      tenant_id: record.tenant_id,
      media_call_id: String(record.media_call_id || ''),
      room_name: String(record.room_name || '')
    });
    const jobs = this.listEgressJobs(record.id);
    if (isLiveKitConfigured(lkConfig) && record.status !== 'pending') {
      const client = this.createEgressClient(lkConfig);
      const activeJobs = jobs.filter((job) =>
        ['starting', 'recording', 'stopping'].includes(job.status) &&
        job.egress_id && !job.egress_id.startsWith('egress_pending_')
      );
      const providerIds = activeJobs.length > 0
        ? activeJobs.map((job) => ({ jobId: job.id, egressId: job.egress_id }))
        : [{ jobId: '', egressId }];
      let stopFailed = false;
      for (const provider of providerIds) {
        try {
          await client.stopEgress(provider.egressId);
          if (provider.jobId) {
            run(
              this.db,
              `UPDATE livekit_egress_jobs
               SET status = 'stopping', failure_code = '', updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [provider.jobId]
            );
          }
        } catch {
          stopFailed = true;
          if (provider.jobId) {
            run(
              this.db,
              `UPDATE livekit_egress_jobs
               SET failure_code = 'livekit_egress_stop_failed', updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [provider.jobId]
            );
          }
        }
      }
      if (!stopFailed) {
        run(
          this.db,
          `UPDATE call_recordings
           SET status = 'stopping', failure_code = '', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [record.id]
        );
      } else {
        run(
          this.db,
          `UPDATE call_recordings
           SET failure_code = 'livekit_egress_stop_failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [record.id]
        );
        throw providerFailure('livekit_egress_stop_failed', record.id);
      }
    } else {
      run(
        this.db,
        `UPDATE livekit_egress_jobs
         SET status = 'stopped', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE recording_id = ? AND status IN ('starting', 'pending', 'recording', 'stopping')`,
        [record.id]
      );
      run(
        this.db,
        `UPDATE call_recordings
         SET status = 'stopped', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [record.id]
      );
    }

    return this.getRecording(record.id);
  }

  getRecording(recordingId: string): EgressRecord | null {
    const row = one(this.db, 'SELECT * FROM call_recordings WHERE id = ?', [recordingId]);
    return row ? decodeEgressRecord(row) : null;
  }

  getRecordingByEgressId(egressId: string): EgressRecord | null {
    if (!egressId) return null;
    const row = one(
      this.db,
      `SELECT recording.*
       FROM call_recordings recording
       LEFT JOIN livekit_egress_jobs job ON job.recording_id = recording.id
       WHERE recording.egress_id = ? OR job.egress_id = ?
       ORDER BY recording.created_at DESC LIMIT 1`,
      [egressId, egressId]
    );
    return row ? decodeEgressRecord(row) : null;
  }

  listEgressJobs(recordingId: string): LiveKitEgressJob[] {
    return all(
      this.db,
      `SELECT * FROM livekit_egress_jobs
       WHERE recording_id = ? ORDER BY job_sequence ASC, id ASC`,
      [recordingId]
    ).map(decodeLiveKitEgressJob);
  }

  getEgressJob(recordingId: string, jobId: string): LiveKitEgressJob | null {
    const row = one(
      this.db,
      'SELECT * FROM livekit_egress_jobs WHERE recording_id = ? AND id = ?',
      [recordingId, jobId]
    );
    return row ? decodeLiveKitEgressJob(row) : null;
  }

  private getActiveRecordingByRoom(tenantId: string, roomName: string): EgressRecord | null {
    if (!roomName) return null;
    const row = one(
      this.db,
      `SELECT * FROM call_recordings
       WHERE tenant_id = ? AND room_name = ? AND status IN ('starting', 'pending', 'recording', 'stopping')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenantId, roomName]
    );
    return row ? decodeEgressRecord(row) : null;
  }

  getRecordingBySession(callSessionId: string): EgressRecord | null {
    const row = one(
      this.db,
      'SELECT * FROM call_recordings WHERE call_session_id = ? ORDER BY created_at DESC LIMIT 1',
      [callSessionId]
    );
    return row ? decodeEgressRecord(row) : null;
  }

  setEvidenceRecordId(recordingId: string, evidenceRecordId: string): EgressRecord | null {
    const normalized = String(evidenceRecordId || '').trim();
    if (!normalized) return this.getRecording(recordingId);
    run(
      this.db,
      `UPDATE call_recordings
       SET evidence_record_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalized, recordingId]
    );
    return this.getRecording(recordingId);
  }

  listRecordings(tenantId: string, opts: RecordingListOptions = {}): EgressRecord[] {
    return this.listRecordingsPage(tenantId, opts).items;
  }

  listRecordingsPage(tenantId: string, opts: RecordingListOptions = {}): RecordingCursorPage {
    const limit = boundedLimit(opts.limit, 50);
    const where = ['tenant_id = ?'];
    const params: Array<string | number | null> = [tenantId];
    addRecordingFilter(where, params, 'media_call_id', opts.mediaCallId);
    addRecordingFilter(where, params, 'room_name', opts.roomName);
    addRecordingFilter(where, params, 'business_ref_type', opts.businessRefType);
    addRecordingFilter(where, params, 'business_ref_id', opts.businessRefId);
    addRecordingFilter(where, params, 'status', opts.status);
    const cursor = decodeRecordingCursor(opts.cursor);
    if (cursor) {
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.created_at, cursor.created_at, cursor.id);
    }
    const rows = all(
      this.db,
      `SELECT * FROM call_recordings WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...params, limit + 1]
    ).map(decodeEgressRecord);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return { items, has_more: hasMore, next_cursor: hasMore && last ? encodeRecordingCursor(last) : null };
  }

  async inspectObject(recordingId: string): Promise<RecordingObjectInspection | null> {
    const recording = this.getRecording(recordingId);
    if (!recording) return null;
    const resolved = await this.resolveObject(recording);
    const inspection = inspectionFromContent(resolved);
    this.markObjectChecked(recording.id, inspection.status);
    return inspection;
  }

  async exportObject(recordingId: string): Promise<RecordingObjectExport | null> {
    const recording = this.getRecording(recordingId);
    if (!recording) return null;
    if (this.deps.resolveRecordingObjectStream || !this.deps.resolveRecordingObject) {
      const resolved = await (this.deps.resolveRecordingObjectStream?.(recording) || resolveRecordingObjectStream(recording));
      const readable = resolved.status === 'readable' && Boolean(resolved.stream);
      this.markObjectChecked(recording.id, resolved.status);
      return {
        status: resolved.status,
        readable,
        ...(resolved.source ? { source: resolved.source } : {}),
        size_bytes: resolved.size_bytes || 0,
        checksum: '',
        stream: resolved.stream,
        content_type: contentTypeForFormat(recording.format),
        filename: `${safeStorageSegment(recording.id)}.${recording.format}`
      };
    }
    const resolved = await this.resolveObject(recording);
    const inspection = inspectionFromContent(resolved);
    this.markObjectChecked(recording.id, inspection.status);
    return {
      ...inspection,
      content: resolved.content,
      content_type: contentTypeForFormat(recording.format),
      filename: `${safeStorageSegment(recording.id)}.${recording.format}`
    };
  }

  async inspectJobObject(recordingId: string, jobId: string): Promise<RecordingObjectInspection | null> {
    const recording = this.getRecording(recordingId);
    const job = this.getEgressJob(recordingId, jobId);
    if (!recording || !job) return null;
    const resolved = await this.resolveObject(recordingObjectForJob(recording, job));
    const inspection = inspectionFromContent(resolved);
    this.markJobObjectChecked(job.id, inspection.status);
    return inspection;
  }

  async exportJobObject(recordingId: string, jobId: string): Promise<RecordingObjectExport | null> {
    const recording = this.getRecording(recordingId);
    const job = this.getEgressJob(recordingId, jobId);
    if (!recording || !job) return null;
    const object = recordingObjectForJob(recording, job);
    const filename = `${safeStorageSegment(job.id)}.${recording.format}`;
    if (this.deps.resolveRecordingObjectStream || !this.deps.resolveRecordingObject) {
      const resolved = await (this.deps.resolveRecordingObjectStream?.(object) || resolveRecordingObjectStream(object));
      const readable = resolved.status === 'readable' && Boolean(resolved.stream);
      this.markJobObjectChecked(job.id, resolved.status);
      return {
        status: resolved.status,
        readable,
        ...(resolved.source ? { source: resolved.source } : {}),
        size_bytes: resolved.size_bytes || 0,
        checksum: '',
        stream: resolved.stream,
        content_type: contentTypeForFormat(recording.format),
        filename
      };
    }
    const resolved = await this.resolveObject(object);
    const inspection = inspectionFromContent(resolved);
    this.markJobObjectChecked(job.id, inspection.status);
    return {
      ...inspection,
      content: resolved.content,
      content_type: contentTypeForFormat(recording.format),
      filename
    };
  }

  listRetentionCandidates(
    tenantId: string,
    opts: { before?: string; limit?: number } = {}
  ): EgressRecord[] {
    const before = normalizeTimestamp(opts.before || this.now().toISOString(), 'before');
    const limit = boundedLimit(opts.limit, 25);
    return all(
      this.db,
      `SELECT * FROM call_recordings
       WHERE tenant_id = ?
         AND retention_until IS NOT NULL
         AND retention_until <= ?
         AND status IN ('completed', 'failed', 'stopped')
       ORDER BY retention_until ASC, created_at ASC
       LIMIT ?`,
      [tenantId, before, limit]
    ).map(decodeEgressRecord);
  }

  async cleanupExpiredRecordings(
    tenantId: string,
    opts: {
      before?: string;
      limit?: number;
      dryRun?: boolean;
      onDeleted?: (
        recording: EgressRecord,
        result: RecordingObjectDeleteResult
      ) => void | Promise<void>;
    } = {}
  ): Promise<RecordingRetentionCleanupResult> {
    const candidates = this.listRetentionCandidates(tenantId, opts);
    const dryRun = opts.dryRun !== false;
    const summary: RecordingRetentionCleanupResult = {
      dry_run: dryRun,
      candidates: candidates.length,
      deleted: 0,
      failed: 0,
      results: []
    };
    if (dryRun) return summary;

    for (const recording of candidates) {
      const jobs = this.listEgressJobs(recording.id);
      const objects = jobs.length > 0
        ? jobs.filter((job) => job.object_status !== 'deleted')
        : [null];
      const results: RecordingObjectDeleteResult[] = [];
      for (const job of objects) {
        let result: RecordingObjectDeleteResult;
        try {
          result = await this.deleteObject(
            job && jobs.length > 1 ? recordingObjectForJob(recording, job) : recording
          );
        } catch {
          result = { status: 'delete_failed', error: 'recording_object_delete_failed' };
        }
        results.push(result);
        if (job) this.markJobObjectDeleted(job.id, result);
      }
      const failure = results.find((result) => result.status !== 'deleted' && result.status !== 'not_found');
      const result = failure || results.at(-1) || { status: 'deleted' as const };
      if (!failure) {
        const deletedAt = this.now().toISOString();
        const deletedRecording: EgressRecord = {
          ...recording,
          status: 'deleted',
          object_status: 'deleted',
          deleted_at: deletedAt,
          updated_at: deletedAt
        };
        try {
          await opts.onDeleted?.(deletedRecording, result);
        } catch {
          run(
            this.db,
            `UPDATE call_recordings
             SET object_status = 'delete_failed', object_checked_at = CURRENT_TIMESTAMP,
                 failure_code = 'recording_delete_lifecycle_sync_failed', updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status != 'deleted'`,
            [recording.id]
          );
          summary.results.push({
            recording_id: recording.id,
            status: 'delete_failed',
            source: result.source,
            error: 'recording_delete_lifecycle_sync_failed'
          });
          summary.failed += 1;
          continue;
        }
        run(
          this.db,
          `UPDATE call_recordings
           SET status = 'deleted', object_status = 'deleted', deleted_at = ?,
               failure_code = '', updated_at = ?
           WHERE id = ? AND status != 'deleted'`,
          [deletedAt, deletedAt, recording.id]
        );
        summary.results.push({
          recording_id: recording.id,
          status: result.status,
          source: result.source,
          error: result.error
        });
        summary.deleted += 1;
      } else {
        run(
          this.db,
          `UPDATE call_recordings
           SET object_status = ?, object_checked_at = CURRENT_TIMESTAMP,
               failure_code = 'recording_object_delete_failed', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status != 'deleted'`,
          [result.status === 'unsupported' ? 'unsupported' : 'delete_failed', recording.id]
        );
        summary.results.push({
          recording_id: recording.id,
          status: result.status,
          source: result.source,
          error: result.error
        });
        summary.failed += 1;
      }
    }
    return summary;
  }

  private now(): Date {
    return this.deps.now?.() || new Date();
  }

  private async closeEgressReservations(
    reservations: Map<string, LiveKitEgressPlacementReservation>,
    reason: string
  ): Promise<void> {
    if (!this.deps.closeEgressJob) return;
    await Promise.allSettled(
      [...reservations.values()].map((reservation) =>
        this.deps.closeEgressJob!(reservation, reason)
      )
    );
  }

  private async resolveTenantRetentionDays(tenantId: string): Promise<number | undefined> {
    if (!this.deps.resolveRetentionDays) return undefined;
    try {
      return await this.deps.resolveRetentionDays(tenantId);
    } catch {
      return undefined;
    }
  }

  private async resolveLiveKitConfig(input: {
    tenant_id: string;
    media_call_id: string;
    room_name: string;
  }) {
    const base = configFromEgressConfig(this.config);
    return this.deps.resolveLiveKitConfig
      ? this.deps.resolveLiveKitConfig(input, base)
      : base;
  }

  private createEgressClient(config: ReturnType<typeof configFromEgressConfig>): LiveKitEgressClientLike {
    return this.deps.createEgressClient?.(config) ||
      new EgressClient(toHttpUrl(config.url!), config.apiKey!, config.apiSecret!);
  }

  private async resolveObject(recording: EgressRecord): Promise<RecordingObjectContentResult> {
    const result = await (this.deps.resolveRecordingObject?.(recording) || resolveRecordingObjectContent(recording));
    if (result.content) assertRecordingObjectExportSize(result.content.length);
    return result;
  }

  private deleteObject(recording: EgressRecord): Promise<RecordingObjectDeleteResult> {
    return this.deps.deleteRecordingObject?.(recording) || deleteRecordingObject(recording);
  }

  private markObjectChecked(recordingId: string, status: RecordingObjectContentResult['status']): void {
    run(
      this.db,
      `UPDATE call_recordings
       SET object_status = ?, object_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, recordingId]
    );
  }

  private markJobObjectChecked(jobId: string, status: RecordingObjectContentResult['status']): void {
    run(
      this.db,
      `UPDATE livekit_egress_jobs
       SET object_status = ?, object_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [status, jobId]
    );
  }

  private markJobObjectDeleted(jobId: string, result: RecordingObjectDeleteResult): void {
    const deleted = result.status === 'deleted' || result.status === 'not_found';
    run(
      this.db,
      `UPDATE livekit_egress_jobs
       SET object_status = ?, object_checked_at = CURRENT_TIMESTAMP,
           deleted_at = CASE WHEN ? = 1 THEN COALESCE(deleted_at, CURRENT_TIMESTAMP) ELSE deleted_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [deleted ? 'deleted' : result.status === 'unsupported' ? 'unsupported' : 'delete_failed', deleted ? 1 : 0, jobId]
    );
  }
}

function recordingObjectForJob(recording: EgressRecord, job: LiveKitEgressJob): EgressRecord {
  return { ...recording, storage_url: job.storage_url };
}

function inspectionFromContent(result: RecordingObjectContentResult): RecordingObjectInspection {
  const content = result.content;
  return {
    status: result.status,
    readable: result.status === 'readable' && Boolean(content),
    ...(result.source ? { source: result.source } : {}),
    size_bytes: content?.length || 0,
    checksum: content
      ? `sha256:${createHash('sha256').update(content).digest('hex')}`
      : ''
  };
}

function normalizeFormat(value: RecordingFormat | undefined): RecordingFormat {
  const format = value || 'ogg';
  if (format === 'mp4' || format === 'webm' || format === 'wav' || format === 'ogg') return format;
  throw Object.assign(new Error('unsupported recording format'), { status: 400 });
}

interface NormalizedRecordingPlan {
  mode: LiveKitRecordingMode;
  tracks: LiveKitRecordingTrackSelector[];
  audioTrackId: string;
  videoTrackId: string;
  hasVideo: boolean;
}

interface EgressJobPlan {
  jobId: string;
  objectKey: string;
  storageUrl: string;
  trackId: string;
  trackKind: string;
  trackSource: string;
  audioTrackId: string;
  videoTrackId: string;
}

function normalizeRecordingPlan(opts: StartRecordingOptions): NormalizedRecordingPlan {
  const mode = opts.recordingMode || 'room_composite';
  if (!['track', 'track_composite', 'room_composite'].includes(mode)) {
    throw recordingInputError('unsupported recording mode');
  }
  const tracks = Array.isArray(opts.tracks)
    ? opts.tracks.map((track) => normalizeTrackSelector(track))
    : [];
  const audioTrackId = normalizeTrackId(opts.audioTrackId, 'audio_track_id', false);
  const videoTrackId = normalizeTrackId(opts.videoTrackId, 'video_track_id', false);
  if (tracks.length > 64) throw recordingInputError('tracks must contain at most 64 entries');

  if (mode === 'track') {
    if (tracks.length === 0) throw recordingInputError('tracks are required for track recording');
    if (audioTrackId || videoTrackId) {
      throw recordingInputError('track recording does not accept composite selectors');
    }
    if (new Set(tracks.map((track) => track.trackId)).size !== tracks.length) {
      throw recordingInputError('tracks must be unique');
    }
  } else if (mode === 'track_composite') {
    if (tracks.length > 0) throw recordingInputError('track composite does not accept tracks');
    if (!audioTrackId && !videoTrackId) {
      throw recordingInputError('audio_track_id or video_track_id is required');
    }
    if (audioTrackId && audioTrackId === videoTrackId) {
      throw recordingInputError('audio and video track ids must differ');
    }
  } else if (tracks.length > 0 || audioTrackId || videoTrackId) {
    throw recordingInputError('room composite does not accept track selectors');
  }

  return {
    mode,
    tracks,
    audioTrackId,
    videoTrackId,
    hasVideo: mode === 'track'
      ? tracks.some((track) => track.kind === 'video')
      : mode === 'track_composite'
        ? Boolean(videoTrackId)
        : Boolean(opts.hasVideo)
  };
}

function normalizeTrackSelector(value: LiveKitRecordingTrackSelector): LiveKitRecordingTrackSelector {
  if (!value || typeof value !== 'object') throw recordingInputError('invalid track selector');
  const trackId = normalizeTrackId(value.trackId, 'track_id', true);
  const kind = String(value.kind || '');
  const source = String(value.source || 'unknown');
  if (!['audio', 'video'].includes(kind)) throw recordingInputError('invalid track kind');
  if (!['microphone', 'camera', 'screen_share', 'screen_share_audio', 'unknown'].includes(source)) {
    throw recordingInputError('invalid track source');
  }
  return {
    trackId,
    kind: kind as LiveKitRecordingTrackSelector['kind'],
    source: source as LiveKitRecordingTrackSelector['source']
  };
}

function normalizeTrackId(value: string | undefined, field: string, required: boolean): string {
  const normalized = String(value || '').trim();
  if (!normalized && required) throw recordingInputError(`${field} is required`);
  if (normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw recordingInputError(`${field} is invalid`);
  }
  return normalized;
}

function recordingInputError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function buildEgressJobPlans(input: {
  tenantId: string;
  storageRefType: string;
  storageRefId: string;
  timestamp: number;
  recordId: string;
  format: RecordingFormat;
  bucket: string;
  recordingPlan: NormalizedRecordingPlan;
}): EgressJobPlan[] {
  const prefix = `${safeStorageSegment(input.tenantId)}/${input.storageRefType}/${input.storageRefId}`;
  const stem = `${input.timestamp}-${safeStorageSegment(input.recordId)}`;
  if (input.recordingPlan.mode !== 'track') {
    const objectKey = `${prefix}/${stem}.${input.format}`;
    return [{
      jobId: id('lkeg'),
      objectKey,
      storageUrl: `s3://${input.bucket}/${objectKey}`,
      trackId: '',
      trackKind: '',
      trackSource: '',
      audioTrackId: input.recordingPlan.audioTrackId,
      videoTrackId: input.recordingPlan.videoTrackId
    }];
  }
  return input.recordingPlan.tracks.map((track, index) => {
    const objectKey = `${prefix}/${stem}/${String(index + 1).padStart(2, '0')}-${safeStorageSegment(track.kind)}-${safeStorageSegment(track.source)}-${safeStorageSegment(track.trackId)}.${input.format}`;
    return {
      jobId: id('lkeg'),
      objectKey,
      storageUrl: `s3://${input.bucket}/${objectKey}`,
      trackId: track.trackId,
      trackKind: track.kind,
      trackSource: track.source,
      audioTrackId: '',
      videoTrackId: ''
    };
  });
}

async function startProviderEgressJob(
  client: LiveKitEgressClientLike,
  roomName: string,
  format: RecordingFormat,
  job: EgressJobPlan,
  recordingPlan: NormalizedRecordingPlan
): Promise<{ egressId?: string | null }> {
  if (recordingPlan.mode === 'track') {
    if (!client.startTrackEgress) throw new Error('LiveKit TrackEgress is unavailable');
    return client.startTrackEgress(
      roomName,
      new DirectFileOutput({ filepath: job.objectKey }),
      job.trackId
    );
  }
  const output = new EncodedFileOutput({
    fileType: mapFileType(format),
    filepath: job.objectKey
  });
  if (recordingPlan.mode === 'track_composite') {
    if (!client.startTrackCompositeEgress) {
      throw new Error('LiveKit TrackCompositeEgress is unavailable');
    }
    return client.startTrackCompositeEgress(roomName, output, {
      audioTrackId: job.audioTrackId || undefined,
      videoTrackId: job.videoTrackId || undefined
    });
  }
  return client.startRoomCompositeEgress(roomName, output, {
    audioOnly: !recordingPlan.hasVideo
  });
}

function normalizeTimestamp(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw Object.assign(new Error(`${field} must be a valid timestamp`), { status: 400 });
  }
  return parsed.toISOString();
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value == null) return fallback;
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), 100);
}

function addRecordingFilter(
  where: string[],
  params: Array<string | number | null>,
  column: 'media_call_id' | 'room_name' | 'business_ref_type' | 'business_ref_id' | 'status',
  value: string | undefined
): void {
  const normalized = String(value || '').trim();
  if (!normalized) return;
  where.push(`${column} = ?`);
  params.push(normalized);
}

function encodeRecordingCursor(recording: EgressRecord): string {
  return Buffer.from(JSON.stringify({ created_at: recording.created_at, id: recording.id })).toString('base64url');
}

function decodeRecordingCursor(value: string | undefined): { created_at: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const createdAt = String(parsed.created_at || '');
    const idValue = String(parsed.id || '');
    if (!createdAt || !idValue) throw new Error('missing cursor fields');
    return { created_at: createdAt, id: idValue };
  } catch {
    throw Object.assign(new Error('invalid recording cursor'), { status: 400 });
  }
}

function contentTypeForFormat(format: RecordingFormat): string {
  switch (format) {
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'wav':
      return 'audio/wav';
    case 'ogg':
      return 'audio/ogg';
  }
}

function providerFailure(code: string, recordingId: string): Error & {
  status: number;
  code: string;
  recording_id: string;
} {
  return Object.assign(new Error('LiveKit egress provider request failed'), {
    status: 502,
    code,
    recording_id: recordingId
  });
}

function activeRecordingConflict(recordingId: string): Error & { status: number; recording_id: string } {
  return Object.assign(new Error('an active recording already exists for this room'), {
    status: 409,
    recording_id: recordingId
  });
}

export function decodeEgressRecord(row: Record<string, unknown>): EgressRecord {
  const metadata = parseJson(String(row.business_ref_metadata || '{}'), {}) as {
    display_name?: unknown;
    metadata?: unknown;
  };
  const businessRefType = String(row.business_ref_type || '');
  const businessRefId = String(row.business_ref_id || '');
  const businessRef = businessRefType && businessRefId
    ? {
        tenant_id: String(row.tenant_id),
        type: businessRefType,
        id: businessRefId,
        display_name: String(metadata.display_name || ''),
        metadata: metadata.metadata && typeof metadata.metadata === 'object'
          ? (metadata.metadata as Record<string, unknown>)
          : {}
      }
    : null;
  const createdAt = String(row.created_at || '');
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    call_session_id: row.call_session_id ? String(row.call_session_id) : '',
    media_call_id: row.media_call_id ? String(row.media_call_id) : '',
    room_name: String(row.room_name || ''),
    business_ref_type: businessRefType,
    business_ref_id: businessRefId,
    business_ref: businessRef,
    source: String(row.source) as EgressRecord['source'],
    format: String(row.format) as EgressRecord['format'],
    storage_url: String(row.storage_url || ''),
    evidence_record_id: String(row.evidence_record_id || ''),
    duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
    file_size_bytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    has_video: Number(row.has_video || 0),
    recording_mode: String(row.recording_mode || 'room_composite') as EgressRecord['recording_mode'],
    egress_id: String(row.egress_id || ''),
    status: String(row.status || 'completed') as EgressRecord['status'],
    retention_until: String(row.retention_until || ''),
    object_status: String(row.object_status || 'unchecked') as EgressRecord['object_status'],
    object_checked_at: row.object_checked_at ? String(row.object_checked_at) : null,
    failure_code: String(row.failure_code || ''),
    completed_at: row.completed_at ? String(row.completed_at) : null,
    deleted_at: row.deleted_at ? String(row.deleted_at) : null,
    updated_at: String(row.updated_at || createdAt),
    created_at: createdAt
  };
}

export function decodeLiveKitEgressJob(row: Record<string, unknown>): LiveKitEgressJob {
  const createdAt = String(row.created_at || '');
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    recording_id: String(row.recording_id),
    job_sequence: Number(row.job_sequence || 0),
    room_name: String(row.room_name || ''),
    recording_mode: String(row.recording_mode || 'room_composite') as LiveKitEgressJob['recording_mode'],
    track_id: String(row.track_id || ''),
    track_kind: String(row.track_kind || ''),
    track_source: String(row.track_source || ''),
    audio_track_id: String(row.audio_track_id || ''),
    video_track_id: String(row.video_track_id || ''),
    storage_url: String(row.storage_url || ''),
    egress_id: String(row.egress_id || ''),
    status: String(row.status || 'pending') as LiveKitEgressJob['status'],
    failure_code: String(row.failure_code || ''),
    reservation_id: String(row.reservation_id || ''),
    owner_epoch: String(row.owner_epoch || ''),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    file_size_bytes: row.file_size_bytes == null ? null : Number(row.file_size_bytes),
    object_status: String(row.object_status || 'unchecked') as LiveKitEgressJob['object_status'],
    object_checked_at: row.object_checked_at ? String(row.object_checked_at) : null,
    provider_observed_at: row.provider_observed_at ? String(row.provider_observed_at) : null,
    provider_missing_count: Number(row.provider_missing_count || 0),
    reconcile_attempts: Number(row.reconcile_attempts || 0),
    reconcile_after: String(row.reconcile_after || row.updated_at || createdAt),
    reconcile_lease_until: row.reconcile_lease_until ? String(row.reconcile_lease_until) : null,
    reconcile_worker_id: String(row.reconcile_worker_id || ''),
    completed_at: row.completed_at ? String(row.completed_at) : null,
    deleted_at: row.deleted_at ? String(row.deleted_at) : null,
    updated_at: String(row.updated_at || createdAt),
    created_at: createdAt
  };
}
