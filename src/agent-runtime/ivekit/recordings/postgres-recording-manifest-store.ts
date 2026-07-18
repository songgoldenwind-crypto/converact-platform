import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import type {
  RecordingManifest,
  RecordingSegment,
  RecordingSegmentState
} from './recording-manifest.js';

export interface RecordingSegmentEvent {
  id: string;
  tenant_id: string;
  manifest_id: string;
  segment_id: string;
  owner_epoch: string;
  event_sequence: number;
  event_type:
    | 'opened'
    | 'closed'
    | 'paused'
    | 'resumed'
    | 'masked'
    | 'unmasked'
    | 'discontinuity'
    | 'sample_dropped'
    | 'upload_started'
    | 'upload_completed'
    | 'upload_failed';
  policy_source: string;
  actor_identity: string;
  metadata: Record<string, unknown>;
  occurred_at: string;
}

export interface RecordingUploadLease {
  tenant_id: string;
  segment_id: string;
  worker_id: string;
  lease_token_hash: string;
  state: 'pending' | 'leased' | 'retry_wait' | 'completed' | 'terminal';
  attempt_count: number;
  max_attempts: number;
  lease_expires_at: string | null;
  next_attempt_at: string | null;
  last_error_code: string;
  last_error_message: string;
  created_at: string;
  updated_at: string;
}

export interface RecordingMultipartUpload {
  tenant_id: string;
  segment_id: string;
  upload_id: string;
  object_key: string;
  storage_url: string;
  part_size_bytes: number;
  state: 'initiated' | 'uploading' | 'completed' | 'aborted';
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface RecordingUploadPart {
  tenant_id: string;
  segment_id: string;
  part_number: number;
  size_bytes: number;
  sha256: string;
  etag: string;
  status: 'uploaded' | 'committed' | 'aborted';
  created_at: string;
  updated_at: string;
}

export class RecordingManifestStoreError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    readonly retryable = false
  ) {
    super(code);
    this.name = 'RecordingManifestStoreError';
  }
}

export class PostgresRecordingManifestStore {
  constructor(private readonly pg: PgQueryable) {}

  createManifest(input: RecordingManifest): Promise<{
    manifest: RecordingManifest;
    created: boolean;
  }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO ivekit_recording_manifests
          (id, tenant_id, interaction_id, interaction_kind, owner_epoch, source,
           state, consent_id, recording_mode, retention_until, legal_hold,
           region_id, zone_id, cell_id, recorder_node_id, media, object_ref,
           processing, failure_code, started_at, ended_at, created_at, updated_at)
         VALUES (
           $1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16::jsonb, $17, $18::jsonb, $19,
           $20, $21, $22, $23
         )
         ON CONFLICT (tenant_id, id) DO NOTHING
         RETURNING *`,
        manifestParams(input)
      );
      if (inserted.rows[0]) {
        return { manifest: decodeManifest(inserted.rows[0]), created: true };
      }
      const replay = await pg.query<Record<string, unknown>>(
        `SELECT manifest.*
         FROM ivekit_recording_manifests manifest
         WHERE manifest.tenant_id = $1 AND manifest.id = $2`,
        [input.tenant_id, input.id]
      );
      const found = replay.rows[0] ? decodeManifest(replay.rows[0]) : null;
      if (!found) throw new RecordingManifestStoreError('recording_manifest_create_failed', 503);
      if (
        found.interaction_id !== input.interaction_id ||
        found.interaction_kind !== input.interaction_kind ||
        found.owner_epoch !== input.owner_epoch ||
        found.source !== input.source ||
        found.consent_id !== input.consent_id ||
        found.recording_mode !== input.recording_mode ||
        found.retention_until !== input.retention_until ||
        found.region_id !== input.region_id ||
        found.zone_id !== input.zone_id ||
        found.cell_id !== input.cell_id ||
        found.recorder_node_id !== input.recorder_node_id ||
        JSON.stringify(found.media) !== JSON.stringify(input.media) ||
        JSON.stringify(found.processing) !== JSON.stringify(input.processing)
      ) {
        throw new RecordingManifestStoreError('recording_manifest_idempotency_conflict');
      }
      return { manifest: found, created: false };
    });
  }

  getManifest(tenantId: string, id: string): Promise<RecordingManifest | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT manifest.*
         FROM ivekit_recording_manifests manifest
         WHERE manifest.tenant_id = $1 AND manifest.id = $2`,
        [tenantId, id]
      );
      return result.rows[0] ? decodeManifest(result.rows[0]) : null;
    });
  }

  registerSegment(input: RecordingSegment): Promise<{
    segment: RecordingSegment;
    created: boolean;
  }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const manifestResult = await pg.query<Record<string, unknown>>(
        `SELECT manifest.*
         FROM ivekit_recording_manifests manifest
         WHERE manifest.tenant_id = $1 AND manifest.id = $2
         FOR UPDATE`,
        [input.tenant_id, input.manifest_id]
      );
      const manifest = manifestResult.rows[0] ? decodeManifest(manifestResult.rows[0]) : null;
      if (!manifest) throw new RecordingManifestStoreError('recording_manifest_not_found', 404);
      if (manifest.owner_epoch !== input.owner_epoch) {
        throw new RecordingManifestStoreError('recording_owner_epoch_conflict');
      }
      if (manifest.state !== 'uploading') {
        const replay = await this.findSegmentBySequence(pg, input);
        if (replay && sameSegmentIdentity(replay, input)) {
          return { segment: replay, created: false };
        }
        throw new RecordingManifestStoreError('recording_manifest_already_finalized');
      }
      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO ivekit_recording_segments
          (id, tenant_id, manifest_id, owner_epoch, sequence, track_id, state,
           container, codec, started_at, ended_at, size_bytes, sha256,
           local_ref, object_ref, failure_code, created_at, updated_at)
         VALUES (
           $1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16, $17, $18
         )
         ON CONFLICT (tenant_id, manifest_id, track_id, sequence) DO NOTHING
         RETURNING *`,
        segmentParams(input)
      );
      if (inserted.rows[0]) {
        return { segment: decodeSegment(inserted.rows[0]), created: true };
      }
      const found = await this.findSegmentBySequence(pg, input);
      if (!found) throw new RecordingManifestStoreError('recording_segment_create_failed', 503);
      if (!sameSegmentIdentity(found, input)) {
        throw new RecordingManifestStoreError('recording_segment_idempotency_conflict');
      }
      return { segment: found, created: false };
    });
  }

  finalizeManifest(input: {
    tenant_id: string;
    manifest_id: string;
    owner_epoch: string;
    interaction_id: string;
    reservation_id: string;
    region_id: string;
    zone_id: string;
    cell_id: string;
    recorder_node_id: string;
    segment_count: number;
    last_segment_sequence: number;
    ended_at: Date;
    now: Date;
  }): Promise<RecordingManifest> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const locked = await pg.query<Record<string, unknown>>(
        `SELECT manifest.*
         FROM ivekit_recording_manifests manifest
         WHERE manifest.tenant_id = $1 AND manifest.id = $2
         FOR UPDATE`,
        [input.tenant_id, input.manifest_id]
      );
      const manifest = locked.rows[0] ? decodeManifest(locked.rows[0]) : null;
      if (!manifest) {
        throw new RecordingManifestStoreError(
          'recording_manifest_segments_pending',
          409,
          true
        );
      }
      if (!sameManifestCompletionIdentity(manifest, input)) {
        throw new RecordingManifestStoreError('recording_manifest_completion_conflict');
      }
      const summaryResult = await pg.query<Record<string, unknown>>(
        `SELECT COUNT(*)::integer AS segment_count,
                COUNT(*) FILTER (WHERE segment.state = 'uploaded')::integer AS uploaded_count,
                COUNT(DISTINCT segment.sequence)::integer AS distinct_sequences,
                MIN(segment.sequence)::integer AS first_sequence,
                MAX(segment.sequence)::integer AS last_sequence,
                COALESCE((
                  SELECT SUM(
                    CASE
                      WHEN event.metadata->>'dropped_samples' ~ '^[0-9]+$'
                        THEN (event.metadata->>'dropped_samples')::numeric
                      ELSE 0
                    END
                  )
                  FROM ivekit_recording_segment_events event
                  WHERE event.tenant_id = $1
                    AND event.manifest_id = $2
                    AND event.owner_epoch = $3::numeric
                    AND event.event_type = 'sample_dropped'
                ), 0)::text AS dropped_samples
         FROM ivekit_recording_segments segment
         WHERE segment.tenant_id = $1
           AND segment.manifest_id = $2
           AND segment.owner_epoch = $3::numeric
           AND segment.track_id = 'mixed'`,
        [input.tenant_id, input.manifest_id, input.owner_epoch]
      );
      const summary = summaryResult.rows[0] || {};
      const droppedSamples = Number(summary.dropped_samples || 0);
      const exact = Number(summary.segment_count) === input.segment_count &&
        Number(summary.uploaded_count) === input.segment_count &&
        Number(summary.distinct_sequences) === input.segment_count &&
        Number(summary.first_sequence) === 1 &&
        Number(summary.last_sequence) === input.last_segment_sequence &&
        input.segment_count === input.last_segment_sequence;
      if (!exact) {
        throw new RecordingManifestStoreError(
          'recording_manifest_segments_pending',
          409,
          true
        );
      }
      const endedAt = input.ended_at.toISOString();
      const processing = {
        ...manifest.processing,
        segment_count: input.segment_count,
        last_segment_sequence: input.last_segment_sequence,
        ...(droppedSamples > 0 ? { dropped_samples: droppedSamples } : {})
      };
      if (manifest.state === 'failed' && manifest.failure_code === 'recording_samples_dropped') {
        if (manifest.ended_at === endedAt &&
          manifest.processing.segment_count === input.segment_count &&
          manifest.processing.last_segment_sequence === input.last_segment_sequence &&
          manifest.processing.dropped_samples === droppedSamples) {
          return manifest;
        }
        throw new RecordingManifestStoreError('recording_manifest_completion_conflict');
      }
      if (droppedSamples > 0) {
        const failed = await pg.query<Record<string, unknown>>(
          `UPDATE ivekit_recording_manifests
           SET state = 'failed', ended_at = $4,
               object_ref = $5, processing = $6::jsonb,
               failure_code = 'recording_samples_dropped', updated_at = $7
           WHERE tenant_id = $1 AND id = $2 AND owner_epoch = $3::numeric
             AND state IN ('uploading', 'uploaded_unverified')
           RETURNING *`,
          [
            input.tenant_id,
            input.manifest_id,
            input.owner_epoch,
            endedAt,
            `recording-intake://${input.manifest_id}`,
            JSON.stringify(processing),
            input.now.toISOString()
          ]
        );
        if (!failed.rows[0]) {
          throw new RecordingManifestStoreError('recording_manifest_completion_conflict');
        }
        return decodeManifest(failed.rows[0]);
      }
      if (manifest.state === 'uploaded_unverified') {
        if (manifest.ended_at === endedAt &&
          manifest.processing.segment_count === input.segment_count &&
          manifest.processing.last_segment_sequence === input.last_segment_sequence) {
          return manifest;
        }
        throw new RecordingManifestStoreError('recording_manifest_completion_conflict');
      }
      if (manifest.state !== 'uploading') {
        throw new RecordingManifestStoreError('recording_manifest_completion_conflict');
      }
      const updated = await pg.query<Record<string, unknown>>(
        `UPDATE ivekit_recording_manifests
         SET state = 'uploaded_unverified', ended_at = $4,
             object_ref = $5, processing = $6::jsonb,
             failure_code = '', updated_at = $7
         WHERE tenant_id = $1 AND id = $2 AND owner_epoch = $3::numeric
           AND state = 'uploading'
         RETURNING *`,
        [
          input.tenant_id,
          input.manifest_id,
          input.owner_epoch,
          endedAt,
          `recording-intake://${input.manifest_id}`,
          JSON.stringify(processing),
          input.now.toISOString()
        ]
      );
      if (!updated.rows[0]) {
        throw new RecordingManifestStoreError('recording_manifest_completion_conflict');
      }
      return decodeManifest(updated.rows[0]);
    });
  }

  getSegment(tenantId: string, segmentId: string): Promise<RecordingSegment | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT segment.*
         FROM ivekit_recording_segments segment
         WHERE segment.tenant_id = $1 AND segment.id = $2`,
        [tenantId, segmentId]
      );
      return result.rows[0] ? decodeSegment(result.rows[0]) : null;
    });
  }

  assertActiveLease(input: {
    tenant_id: string;
    segment_id: string;
    owner_epoch: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
  }): Promise<{ segment: RecordingSegment; lease: RecordingUploadLease }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT segment.*, row_to_json(lease.*) AS upload_lease
         FROM ivekit_recording_segments segment
         JOIN ivekit_recording_upload_leases lease
           ON lease.tenant_id = segment.tenant_id
          AND lease.segment_id = segment.id
         WHERE segment.tenant_id = $1
           AND segment.id = $2
           AND segment.owner_epoch = $3::numeric
           AND segment.state = 'uploading'
           AND lease.worker_id = $4
           AND lease.lease_token_hash = $5
           AND lease.state = 'leased'
           AND lease.lease_expires_at > $6`,
        [
          input.tenant_id,
          input.segment_id,
          input.owner_epoch,
          input.worker_id,
          input.lease_token_hash,
          input.now.toISOString()
        ]
      );
      if (!result.rows[0]) {
        throw new RecordingManifestStoreError('recording_segment_lease_conflict');
      }
      return {
        segment: decodeSegment(result.rows[0]),
        lease: decodeLease(jsonRecord(result.rows[0].upload_lease))
      };
    });
  }

  appendSegmentEvent(input: RecordingSegmentEvent): Promise<{
    event: RecordingSegmentEvent;
    created: boolean;
  }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const manifestResult = await pg.query<Record<string, unknown>>(
        `SELECT manifest.*
         FROM ivekit_recording_manifests manifest
         WHERE manifest.tenant_id = $1 AND manifest.id = $2
         FOR UPDATE`,
        [input.tenant_id, input.manifest_id]
      );
      const manifest = manifestResult.rows[0]
        ? decodeManifest(manifestResult.rows[0])
        : null;
      if (!manifest || manifest.state !== 'uploading' || manifest.owner_epoch !== input.owner_epoch) {
        throw new RecordingManifestStoreError('recording_segment_event_manifest_closed');
      }
      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO ivekit_recording_segment_events
          (id, tenant_id, manifest_id, segment_id, owner_epoch, event_sequence,
           event_type, policy_source, actor_identity, metadata, occurred_at)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10::jsonb, $11)
         ON CONFLICT (tenant_id, segment_id, event_sequence) DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.tenant_id,
          input.manifest_id,
          input.segment_id,
          input.owner_epoch,
          input.event_sequence,
          input.event_type,
          input.policy_source,
          input.actor_identity,
          JSON.stringify(input.metadata),
          input.occurred_at
        ]
      );
      if (inserted.rows[0]) {
        return { event: decodeEvent(inserted.rows[0]), created: true };
      }
      const replay = await pg.query<Record<string, unknown>>(
        `SELECT event.*
         FROM ivekit_recording_segment_events event
         WHERE event.tenant_id = $1
           AND event.segment_id = $2
           AND event.event_sequence = $3`,
        [input.tenant_id, input.segment_id, input.event_sequence]
      );
      const found = replay.rows[0] ? decodeEvent(replay.rows[0]) : null;
      if (!found) throw new RecordingManifestStoreError('recording_segment_event_create_failed', 503);
      if (
        found.id !== input.id ||
        found.manifest_id !== input.manifest_id ||
        found.owner_epoch !== input.owner_epoch ||
        found.event_type !== input.event_type ||
        found.policy_source !== input.policy_source ||
        found.actor_identity !== input.actor_identity ||
        found.occurred_at !== input.occurred_at ||
        JSON.stringify(found.metadata) !== JSON.stringify(input.metadata)
      ) {
        throw new RecordingManifestStoreError('recording_segment_event_conflict');
      }
      return { event: found, created: false };
    });
  }

  claimSegments(input: {
    tenant_id: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
    lease_ms: number;
    limit: number;
  }): Promise<Array<{ segment: RecordingSegment; lease: RecordingUploadLease }>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const now = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.lease_ms).toISOString();
      const claimed = await pg.query<Record<string, unknown>>(
        `WITH candidate AS (
           SELECT segment.id
           FROM ivekit_recording_segments segment
           LEFT JOIN ivekit_recording_upload_leases lease
             ON lease.tenant_id = segment.tenant_id
            AND lease.segment_id = segment.id
           WHERE segment.tenant_id = $1
             AND segment.state IN ('closed', 'upload_pending', 'uploading', 'failed')
             AND (
               lease.segment_id IS NULL
               OR lease.state = 'pending'
               OR (lease.state = 'retry_wait' AND lease.next_attempt_at <= $2)
               OR (lease.state = 'leased' AND lease.lease_expires_at <= $2)
             )
             AND COALESCE(lease.attempt_count, 0) < COALESCE(lease.max_attempts, 20)
           ORDER BY segment.updated_at, segment.id
           FOR UPDATE OF segment SKIP LOCKED
           LIMIT $3
         )
         UPDATE ivekit_recording_segments segment
         SET state = 'uploading', failure_code = '', updated_at = $2
         FROM candidate
         WHERE segment.tenant_id = $1 AND segment.id = candidate.id
         RETURNING segment.*`,
        [input.tenant_id, now, boundedLimit(input.limit)]
      );
      const result: Array<{ segment: RecordingSegment; lease: RecordingUploadLease }> = [];
      for (const row of claimed.rows) {
        const segment = decodeSegment(row);
        result.push({
          segment,
          lease: await this.leaseSegment(pg, {
            tenant_id: input.tenant_id,
            segment_id: segment.id,
            worker_id: input.worker_id,
            lease_token_hash: input.lease_token_hash,
            lease_expires_at: leaseExpiresAt,
            now
          })
        });
      }
      return result;
    });
  }

  claimSegment(input: {
    tenant_id: string;
    segment_id: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
    lease_ms: number;
  }): Promise<{ segment: RecordingSegment; lease: RecordingUploadLease }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const now = input.now.toISOString();
      const claimed = await pg.query<Record<string, unknown>>(
        `WITH candidate AS (
           SELECT segment.id
           FROM ivekit_recording_segments segment
           LEFT JOIN ivekit_recording_upload_leases lease
             ON lease.tenant_id = segment.tenant_id
            AND lease.segment_id = segment.id
           WHERE segment.tenant_id = $1 AND segment.id = $2
             AND segment.state IN ('closed', 'upload_pending', 'uploading', 'failed')
             AND (
               lease.segment_id IS NULL
               OR lease.state = 'pending'
               OR (lease.state = 'retry_wait' AND lease.next_attempt_at <= $3)
               OR (lease.state = 'leased' AND lease.lease_expires_at <= $3)
             )
             AND COALESCE(lease.attempt_count, 0) < COALESCE(lease.max_attempts, 20)
           FOR UPDATE OF segment SKIP LOCKED
         )
         UPDATE ivekit_recording_segments segment
         SET state = 'uploading', failure_code = '', updated_at = $3
         FROM candidate
         WHERE segment.tenant_id = $1 AND segment.id = candidate.id
         RETURNING segment.*`,
        [input.tenant_id, input.segment_id, now]
      );
      if (!claimed.rows[0]) {
        throw new RecordingManifestStoreError('recording_segment_not_claimable');
      }
      const segment = decodeSegment(claimed.rows[0]);
      return {
        segment,
        lease: await this.leaseSegment(pg, {
          tenant_id: input.tenant_id,
          segment_id: input.segment_id,
          worker_id: input.worker_id,
          lease_token_hash: input.lease_token_hash,
          lease_expires_at: new Date(
            input.now.getTime() + input.lease_ms
          ).toISOString(),
          now
        })
      };
    });
  }

  completeSegment(input: {
    tenant_id: string;
    segment_id: string;
    owner_epoch: string;
    worker_id: string;
    lease_token_hash: string;
    size_bytes: number;
    sha256: string;
    object_ref: string;
    now: Date;
  }): Promise<RecordingSegment> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const completed = await pg.query<Record<string, unknown>>(
        `UPDATE ivekit_recording_segments segment
         SET state = 'uploaded',
             size_bytes = $7,
             sha256 = $8,
             object_ref = $9,
             failure_code = '',
             updated_at = $6
         FROM ivekit_recording_upload_leases lease
         WHERE segment.tenant_id = $1
           AND segment.id = $2
           AND segment.owner_epoch = $3::numeric
           AND segment.state = 'uploading'
           AND lease.tenant_id = segment.tenant_id
           AND lease.segment_id = segment.id
           AND lease.state = 'leased'
           AND lease.worker_id = $4
           AND lease.lease_token_hash = $5
           AND lease.lease_expires_at > $6
         RETURNING segment.*`,
        [
          input.tenant_id,
          input.segment_id,
          input.owner_epoch,
          input.worker_id,
          input.lease_token_hash,
          input.now.toISOString(),
          input.size_bytes,
          input.sha256,
          input.object_ref
        ]
      );
      const row = completed.rows[0];
      if (!row) {
        return this.replayCompletedSegment(pg, input);
      }
      await pg.query(
        `UPDATE ivekit_recording_upload_leases
         SET state = 'completed', lease_expires_at = NULL, next_attempt_at = NULL,
             last_error_code = '', last_error_message = '', updated_at = $5
         WHERE tenant_id = $1 AND segment_id = $2
           AND worker_id = $3 AND lease_token_hash = $4 AND state = 'leased'
         RETURNING *`,
        [
          input.tenant_id,
          input.segment_id,
          input.worker_id,
          input.lease_token_hash,
          input.now.toISOString()
        ]
      );
      return decodeSegment(row);
    });
  }

  releaseSegment(input: {
    tenant_id: string;
    segment_id: string;
    owner_epoch: string;
    worker_id: string;
    lease_token_hash: string;
    retryable: boolean;
    error_code: string;
    error_message?: string;
    next_attempt_at?: Date;
    now: Date;
  }): Promise<RecordingSegment> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const segmentState: RecordingSegmentState = input.retryable
        ? 'upload_pending'
        : 'failed';
      const leaseState: RecordingUploadLease['state'] = input.retryable
        ? 'retry_wait'
        : 'terminal';
      const nextAttemptAt = input.retryable
        ? input.next_attempt_at?.toISOString() ?? input.now.toISOString()
        : null;
      const updated = await pg.query<Record<string, unknown>>(
        `UPDATE ivekit_recording_segments
         SET state = $6, failure_code = $7, updated_at = $5
         WHERE tenant_id = $1 AND id = $2 AND owner_epoch = $3::numeric
           AND state = 'uploading'
           AND EXISTS (
             SELECT 1 FROM ivekit_recording_upload_leases lease
             WHERE lease.tenant_id = $1 AND lease.segment_id = $2
               AND lease.worker_id = $4 AND lease.lease_token_hash = $8
               AND lease.state = 'leased' AND lease.lease_expires_at > $5
           )
         RETURNING *`,
        [
          input.tenant_id,
          input.segment_id,
          input.owner_epoch,
          input.worker_id,
          input.now.toISOString(),
          segmentState,
          input.error_code,
          input.lease_token_hash
        ]
      );
      if (!updated.rows[0]) {
        throw new RecordingManifestStoreError('recording_segment_lease_conflict');
      }
      await pg.query(
        `UPDATE ivekit_recording_upload_leases
         SET lease_expires_at = NULL, next_attempt_at = $7,
             state = $6, last_error_code = $8, last_error_message = $9,
             updated_at = $5
         WHERE tenant_id = $1 AND segment_id = $2
           AND worker_id = $3 AND lease_token_hash = $4 AND state = 'leased'
         RETURNING *`,
        [
          input.tenant_id,
          input.segment_id,
          input.worker_id,
          input.lease_token_hash,
          input.now.toISOString(),
          leaseState,
          nextAttemptAt,
          input.error_code,
          input.error_message ?? ''
        ]
      );
      return decodeSegment(updated.rows[0]);
    });
  }

  attachMultipartUpload(input: {
    tenant_id: string;
    segment_id: string;
    upload_id: string;
    object_key: string;
    storage_url: string;
    part_size_bytes: number;
    now: Date;
  }): Promise<{ upload: RecordingMultipartUpload; created: boolean }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO ivekit_recording_segment_uploads
          (tenant_id, segment_id, upload_id, object_key, storage_url,
           part_size_bytes, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'initiated', $7, $7)
         ON CONFLICT (tenant_id, segment_id) DO NOTHING
         RETURNING *`,
        [
          input.tenant_id,
          input.segment_id,
          input.upload_id,
          input.object_key,
          input.storage_url,
          input.part_size_bytes,
          input.now.toISOString()
        ]
      );
      if (inserted.rows[0]) {
        return { upload: decodeUpload(inserted.rows[0]), created: true };
      }
      const replay = await pg.query<Record<string, unknown>>(
        `SELECT upload.*
         FROM ivekit_recording_segment_uploads upload
         WHERE upload.tenant_id = $1 AND upload.segment_id = $2`,
        [input.tenant_id, input.segment_id]
      );
      const found = replay.rows[0] ? decodeUpload(replay.rows[0]) : null;
      if (!found) throw new RecordingManifestStoreError('recording_upload_create_failed', 503);
      if (
        found.upload_id !== input.upload_id ||
        found.object_key !== input.object_key ||
        found.storage_url !== input.storage_url ||
        found.part_size_bytes !== input.part_size_bytes
      ) {
        throw new RecordingManifestStoreError('recording_upload_identity_conflict');
      }
      return { upload: found, created: false };
    });
  }

  getMultipartUpload(
    tenantId: string,
    segmentId: string
  ): Promise<RecordingMultipartUpload | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT upload.*
         FROM ivekit_recording_segment_uploads upload
         WHERE upload.tenant_id = $1 AND upload.segment_id = $2`,
        [tenantId, segmentId]
      );
      return result.rows[0] ? decodeUpload(result.rows[0]) : null;
    });
  }

  recordUploadedPart(input: {
    tenant_id: string;
    segment_id: string;
    part_number: number;
    size_bytes: number;
    sha256: string;
    etag: string;
    now: Date;
  }): Promise<{ part: RecordingUploadPart; created: boolean }> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const inserted = await pg.query<Record<string, unknown>>(
        `INSERT INTO ivekit_recording_upload_parts
          (tenant_id, segment_id, part_number, size_bytes, sha256, etag,
           status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'uploaded', $7, $7)
         ON CONFLICT (tenant_id, segment_id, part_number) DO NOTHING
         RETURNING *`,
        [
          input.tenant_id,
          input.segment_id,
          input.part_number,
          input.size_bytes,
          input.sha256,
          input.etag,
          input.now.toISOString()
        ]
      );
      if (inserted.rows[0]) {
        return { part: decodePart(inserted.rows[0]), created: true };
      }
      const replay = await pg.query<Record<string, unknown>>(
        `SELECT part.*
         FROM ivekit_recording_upload_parts part
         WHERE part.tenant_id = $1
           AND part.segment_id = $2
           AND part.part_number = $3`,
        [input.tenant_id, input.segment_id, input.part_number]
      );
      const found = replay.rows[0] ? decodePart(replay.rows[0]) : null;
      if (!found) throw new RecordingManifestStoreError('recording_upload_part_create_failed', 503);
      if (
        found.size_bytes !== input.size_bytes ||
        found.sha256 !== input.sha256 ||
        found.etag !== input.etag
      ) {
        throw new RecordingManifestStoreError('recording_upload_part_conflict');
      }
      return { part: found, created: false };
    });
  }

  listUploadedParts(
    tenantId: string,
    segmentId: string
  ): Promise<RecordingUploadPart[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT part.*
         FROM ivekit_recording_upload_parts part
         WHERE part.tenant_id = $1 AND part.segment_id = $2
           AND part.status IN ('uploaded', 'committed')
         ORDER BY part.part_number`,
        [tenantId, segmentId]
      );
      return result.rows.map(decodePart);
    });
  }

  markMultipartCompleted(input: {
    tenant_id: string;
    segment_id: string;
    upload_id: string;
    object_key: string;
    now: Date;
  }): Promise<RecordingMultipartUpload> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const completed = await pg.query<Record<string, unknown>>(
        `UPDATE ivekit_recording_segment_uploads
         SET state = 'completed', completed_at = $5, updated_at = $5
         WHERE tenant_id = $1 AND segment_id = $2
           AND upload_id = $3 AND object_key = $4
           AND state IN ('initiated', 'uploading', 'completed')
         RETURNING *`,
        [
          input.tenant_id,
          input.segment_id,
          input.upload_id,
          input.object_key,
          input.now.toISOString()
        ]
      );
      if (!completed.rows[0]) {
        throw new RecordingManifestStoreError('recording_upload_identity_conflict');
      }
      await pg.query(
        `UPDATE ivekit_recording_upload_parts
         SET status = 'committed', updated_at = $3
         WHERE tenant_id = $1 AND segment_id = $2 AND status = 'uploaded'`,
        [input.tenant_id, input.segment_id, input.now.toISOString()]
      );
      return decodeUpload(completed.rows[0]);
    });
  }

  listWorkerTenants(now: Date, limit: number): Promise<string[]> {
    return this.pg.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM opc_ivekit_recording_worker_tenant_ids($1, $2)`,
      [now.toISOString(), boundedLimit(limit)]
    ).then((result) => result.rows.map((row) => String(row.tenant_id)));
  }

  private async replayCompletedSegment(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      segment_id: string;
      owner_epoch: string;
      size_bytes: number;
      sha256: string;
      object_ref: string;
    }
  ): Promise<RecordingSegment> {
    const replay = await pg.query<Record<string, unknown>>(
      `SELECT segment.*
       FROM ivekit_recording_segments segment
       WHERE segment.tenant_id = $1 AND segment.id = $2`,
      [input.tenant_id, input.segment_id]
    );
    const found = replay.rows[0] ? decodeSegment(replay.rows[0]) : null;
    if (
      found?.state === 'uploaded' &&
      found.owner_epoch === input.owner_epoch &&
      found.size_bytes === input.size_bytes &&
      found.sha256 === input.sha256 &&
      found.object_ref === input.object_ref
    ) return found;
    throw new RecordingManifestStoreError('recording_segment_completion_conflict');
  }

  private async leaseSegment(
    pg: PgQueryable,
    input: {
      tenant_id: string;
      segment_id: string;
      worker_id: string;
      lease_token_hash: string;
      lease_expires_at: string;
      now: string;
    }
  ): Promise<RecordingUploadLease> {
    const leased = await pg.query<Record<string, unknown>>(
      `INSERT INTO ivekit_recording_upload_leases
        (tenant_id, segment_id, worker_id, lease_token_hash, state,
         attempt_count, lease_expires_at, next_attempt_at, last_error_code,
         last_error_message, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'leased', 1, $5, NULL, '', '', $6, $6)
       ON CONFLICT (tenant_id, segment_id) DO UPDATE
       SET worker_id = EXCLUDED.worker_id,
           lease_token_hash = EXCLUDED.lease_token_hash,
           state = 'leased',
           attempt_count = ivekit_recording_upload_leases.attempt_count + 1,
           lease_expires_at = EXCLUDED.lease_expires_at,
           next_attempt_at = NULL,
           last_error_code = '',
           last_error_message = '',
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.tenant_id,
        input.segment_id,
        input.worker_id,
        input.lease_token_hash,
        input.lease_expires_at,
        input.now
      ]
    );
    if (!leased.rows[0]) {
      throw new RecordingManifestStoreError('recording_segment_lease_failed', 503);
    }
    return decodeLease(leased.rows[0]);
  }

  private async findSegmentBySequence(
    pg: PgQueryable,
    input: RecordingSegment
  ): Promise<RecordingSegment | null> {
    const replay = await pg.query<Record<string, unknown>>(
      `SELECT segment.*
       FROM ivekit_recording_segments segment
       WHERE segment.tenant_id = $1
         AND segment.manifest_id = $2
         AND segment.track_id = $3
         AND segment.sequence = $4`,
      [input.tenant_id, input.manifest_id, input.track_id, input.sequence]
    );
    return replay.rows[0] ? decodeSegment(replay.rows[0]) : null;
  }
}

function sameSegmentIdentity(found: RecordingSegment, input: RecordingSegment): boolean {
  return found.id === input.id &&
    found.owner_epoch === input.owner_epoch &&
    found.local_ref === input.local_ref &&
    found.container === input.container &&
    found.codec === input.codec &&
    found.started_at === input.started_at &&
    found.ended_at === input.ended_at &&
    found.size_bytes === input.size_bytes &&
    found.sha256 === input.sha256;
}

function sameManifestCompletionIdentity(
  manifest: RecordingManifest,
  input: {
    owner_epoch: string;
    interaction_id: string;
    reservation_id: string;
    region_id: string;
    zone_id: string;
    cell_id: string;
    recorder_node_id: string;
  }
): boolean {
  return manifest.owner_epoch === input.owner_epoch &&
    manifest.interaction_id === input.interaction_id &&
    manifest.interaction_kind === 'sip_voice' &&
    manifest.source === 'sip_voice' &&
    manifest.processing.reservation_id === input.reservation_id &&
    manifest.region_id === input.region_id &&
    manifest.zone_id === input.zone_id &&
    manifest.cell_id === input.cell_id &&
    manifest.recorder_node_id === input.recorder_node_id;
}

function manifestParams(input: RecordingManifest): unknown[] {
  return [
    input.id,
    input.tenant_id,
    input.interaction_id,
    input.interaction_kind,
    input.owner_epoch,
    input.source,
    input.state,
    input.consent_id,
    input.recording_mode,
    input.retention_until,
    input.legal_hold,
    input.region_id,
    input.zone_id,
    input.cell_id,
    input.recorder_node_id,
    JSON.stringify(input.media),
    input.object_ref,
    JSON.stringify(input.processing),
    input.failure_code,
    input.started_at,
    input.ended_at,
    input.created_at,
    input.updated_at
  ];
}

function segmentParams(input: RecordingSegment): unknown[] {
  return [
    input.id,
    input.tenant_id,
    input.manifest_id,
    input.owner_epoch,
    input.sequence,
    input.track_id,
    input.state,
    input.container,
    input.codec,
    input.started_at,
    input.ended_at,
    input.size_bytes,
    input.sha256,
    input.local_ref,
    input.object_ref,
    input.failure_code,
    input.created_at,
    input.updated_at
  ];
}

function decodeManifest(row: Record<string, unknown>): RecordingManifest {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    interaction_id: String(row.interaction_id),
    interaction_kind: String(row.interaction_kind),
    owner_epoch: String(row.owner_epoch),
    source: row.source as RecordingManifest['source'],
    state: row.state as RecordingManifest['state'],
    consent_id: String(row.consent_id),
    recording_mode: row.recording_mode as RecordingManifest['recording_mode'],
    retention_until: timestamp(row.retention_until),
    legal_hold: row.legal_hold === true,
    region_id: String(row.region_id),
    zone_id: String(row.zone_id),
    cell_id: String(row.cell_id),
    recorder_node_id: String(row.recorder_node_id),
    media: jsonRecord(row.media) as unknown as RecordingManifest['media'],
    processing: jsonRecord(row.processing),
    object_ref: String(row.object_ref ?? ''),
    failure_code: String(row.failure_code ?? ''),
    started_at: timestamp(row.started_at),
    ended_at: nullableTimestamp(row.ended_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeSegment(row: Record<string, unknown>): RecordingSegment {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    manifest_id: String(row.manifest_id),
    owner_epoch: String(row.owner_epoch),
    sequence: Number(row.sequence),
    track_id: String(row.track_id),
    state: row.state as RecordingSegment['state'],
    container: String(row.container),
    codec: String(row.codec),
    started_at: timestamp(row.started_at),
    ended_at: nullableTimestamp(row.ended_at),
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    sha256: String(row.sha256 ?? ''),
    local_ref: String(row.local_ref ?? ''),
    object_ref: String(row.object_ref ?? ''),
    failure_code: String(row.failure_code ?? ''),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeEvent(row: Record<string, unknown>): RecordingSegmentEvent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    manifest_id: String(row.manifest_id),
    segment_id: String(row.segment_id),
    owner_epoch: String(row.owner_epoch),
    event_sequence: Number(row.event_sequence),
    event_type: row.event_type as RecordingSegmentEvent['event_type'],
    policy_source: String(row.policy_source ?? ''),
    actor_identity: String(row.actor_identity ?? ''),
    metadata: jsonRecord(row.metadata),
    occurred_at: timestamp(row.occurred_at)
  };
}

function decodeLease(row: Record<string, unknown>): RecordingUploadLease {
  return {
    tenant_id: String(row.tenant_id),
    segment_id: String(row.segment_id),
    worker_id: String(row.worker_id ?? ''),
    lease_token_hash: String(row.lease_token_hash ?? ''),
    state: row.state as RecordingUploadLease['state'],
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    lease_expires_at: nullableTimestamp(row.lease_expires_at),
    next_attempt_at: nullableTimestamp(row.next_attempt_at),
    last_error_code: String(row.last_error_code ?? ''),
    last_error_message: String(row.last_error_message ?? ''),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function decodeUpload(row: Record<string, unknown>): RecordingMultipartUpload {
  return {
    tenant_id: String(row.tenant_id),
    segment_id: String(row.segment_id),
    upload_id: String(row.upload_id),
    object_key: String(row.object_key),
    storage_url: String(row.storage_url),
    part_size_bytes: Number(row.part_size_bytes),
    state: row.state as RecordingMultipartUpload['state'],
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
    completed_at: nullableTimestamp(row.completed_at)
  };
}

function decodePart(row: Record<string, unknown>): RecordingUploadPart {
  return {
    tenant_id: String(row.tenant_id),
    segment_id: String(row.segment_id),
    part_number: Number(row.part_number),
    size_bytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    etag: String(row.etag),
    status: row.status as RecordingUploadPart['status'],
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at)
  };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function timestamp(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function nullableTimestamp(value: unknown): string | null {
  return value == null || value === '' ? null : timestamp(value);
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RecordingManifestStoreError('recording_worker_limit_invalid', 400);
  }
  return Math.min(value, 1_000);
}
