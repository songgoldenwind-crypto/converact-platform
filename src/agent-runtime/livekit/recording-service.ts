import { createHash } from 'node:crypto';
import { EgressClient, EncodedFileOutput, EncodedFileType } from 'livekit-server-sdk';
import { all, id, json, one, parseJson, run } from '../../db-compat.js';
import {
  deleteRecordingObject,
  resolveRecordingObjectContent
} from '../media-recording-object.js';
import { isLiveKitConfigured, readLiveKitConfig } from './config.js';
import type {
  EgressRecord,
  LiveKitEgressClientLike,
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
    const businessRef = normalizeBusinessRef(tenantId, callSessionId, opts.businessRef);
    const now = this.now();
    const timestamp = now.getTime();
    const bucket = safeStorageSegment(this.config.minioBucket || process.env.MINIO_BUCKET || 'recordings');
    const storageRefType = safeStorageSegment(businessRef?.type || 'unbound');
    const storageRefId = safeStorageSegment(businessRef?.id || callSessionId || 'unbound');
    const recordId = id('crec');
    const objectKey = `${safeStorageSegment(tenantId)}/${storageRefType}/${storageRefId}/${timestamp}-${safeStorageSegment(recordId)}.${format}`;
    const storageUrl = `s3://${bucket}/${objectKey}`;
    const lkConfig = configFromEgressConfig(this.config);
    const providerConfigured = isLiveKitConfigured(lkConfig);
    const pendingEgressId = providerConfigured
      ? ''
      : `egress_pending_${recordId}`;
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

    try {
      run(
        this.db,
        `INSERT INTO call_recordings
          (id, tenant_id, call_session_id, media_call_id, room_name, business_ref_type, business_ref_id, business_ref_metadata,
           source, format, storage_url, has_video, egress_id, status, retention_until,
           object_status, failure_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'livekit_egress', ?, ?, ?, ?, ?, ?, 'unchecked', '', CURRENT_TIMESTAMP)`,
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
          opts.hasVideo ? 1 : 0,
          pendingEgressId,
          providerConfigured ? 'starting' : 'pending',
          retentionUntil
        ]
      );
    } catch (cause) {
      const concurrent = this.getActiveRecordingByRoom(tenantId, roomName);
      if (concurrent) throw activeRecordingConflict(concurrent.id);
      throw cause;
    }

    if (providerConfigured) {
      let client: LiveKitEgressClientLike | undefined;
      let startedEgressId = '';
      try {
        client = this.createEgressClient(lkConfig.url!, lkConfig.apiKey!, lkConfig.apiSecret!);
        const output = new EncodedFileOutput({
          fileType: mapFileType(format),
          filepath: objectKey
        });
        const info = await client.startRoomCompositeEgress(roomName, output, {
          audioOnly: !opts.hasVideo
        });
        startedEgressId = String(info.egressId || '').trim();
        if (!startedEgressId) throw new Error('missing egress id');
        run(
          this.db,
          `UPDATE call_recordings
           SET egress_id = ?, status = 'recording', failure_code = '', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [startedEgressId, recordId]
        );
      } catch {
        let failureCode = startedEgressId
          ? 'livekit_egress_persistence_failed'
          : 'livekit_egress_start_failed';
        if (startedEgressId && client) {
          try {
            await client.stopEgress(startedEgressId);
          } catch {
            failureCode = 'livekit_egress_compensation_failed';
          }
        }
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

  async stopRecording(egressId: string): Promise<EgressRecord | null> {
    const record = this.getRecordingByEgressId(egressId);
    if (!record) return null;
    if (record.status === 'deleted' || record.status === 'completed' || record.status === 'stopped') {
      return record;
    }

    const lkConfig = configFromEgressConfig(this.config);
    if (isLiveKitConfigured(lkConfig) && record.status !== 'pending') {
      try {
        const client = this.createEgressClient(lkConfig.url!, lkConfig.apiKey!, lkConfig.apiSecret!);
        await client.stopEgress(egressId);
        run(
          this.db,
          `UPDATE call_recordings
           SET status = 'stopping', failure_code = '', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [record.id]
        );
      } catch {
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
    const row = one(this.db, 'SELECT * FROM call_recordings WHERE egress_id = ?', [egressId]);
    return row ? decodeEgressRecord(row) : null;
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
      let result: RecordingObjectDeleteResult;
      try {
        result = await this.deleteObject(recording);
      } catch {
        result = { status: 'delete_failed', error: 'recording_object_delete_failed' };
      }
      if (result.status === 'deleted' || result.status === 'not_found') {
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

  private async resolveTenantRetentionDays(tenantId: string): Promise<number | undefined> {
    if (!this.deps.resolveRetentionDays) return undefined;
    try {
      return await this.deps.resolveRetentionDays(tenantId);
    } catch {
      return undefined;
    }
  }

  private createEgressClient(url: string, apiKey: string, apiSecret: string): LiveKitEgressClientLike {
    return this.deps.createEgressClient?.() || new EgressClient(toHttpUrl(url), apiKey, apiSecret);
  }

  private resolveObject(recording: EgressRecord): Promise<RecordingObjectContentResult> {
    return this.deps.resolveRecordingObject?.(recording) || resolveRecordingObjectContent(recording);
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
    duration_ms: row.duration_ms != null ? Number(row.duration_ms) : null,
    file_size_bytes: row.file_size_bytes != null ? Number(row.file_size_bytes) : null,
    has_video: Number(row.has_video || 0),
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
