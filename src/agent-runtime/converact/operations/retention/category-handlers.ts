import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import { deleteRecordingObject } from '../../../media-recording-object.js';
import {
  createObjectStorage,
  type ObjectStorage
} from '../../../../storage/object-storage.js';
import type { ConveractFabricRetentionCategoryHandler } from './ports.js';
import type {
  ConveractFabricRetentionClaim,
  ConveractFabricRetentionDeletionSummary
} from './types.js';

type RetentionRow = Record<string, unknown>;
type RecordingDeleteResult = Awaited<ReturnType<typeof deleteRecordingObject>>;

export interface PostgresConveractFabricRetentionCategoryHandlerOptions {
  pg: PgQueryable;
  env?: NodeJS.ProcessEnv;
  storage?: ObjectStorage;
  deleteRecording?: (
    recording: { storage_url: string }
  ) => Promise<RecordingDeleteResult>;
  now?: () => Date;
}

export function createPostgresConveractFabricRetentionCategoryHandlers(
  options: PostgresConveractFabricRetentionCategoryHandlerOptions
): Readonly<Record<'secure_files' | 'media_recordings', ConveractFabricRetentionCategoryHandler>> {
  let storage = options.storage;
  const resolveStorage = (): ObjectStorage => {
    storage ||= createObjectStorage(options.env || process.env);
    return storage;
  };
  const now = options.now || (() => new Date());
  return {
    secure_files: {
      deleteExpired: (claim) => deleteSecureFiles(options.pg, resolveStorage(), claim, now)
    },
    media_recordings: {
      deleteExpired: (claim) => deleteMediaRecordings(
        options.pg,
        options.deleteRecording || deleteRecordingObject,
        claim,
        now
      )
    }
  };
}

async function deleteSecureFiles(
  pg: PgQueryable,
  storage: ObjectStorage,
  claim: ConveractFabricRetentionClaim,
  now: () => Date
): Promise<ConveractFabricRetentionDeletionSummary> {
  const claimedAt = now();
  const claimTokenHash = createHash('sha256').update(claim.run_id).digest('hex');
  const cleanupLeaseUntil = new Date(claimedAt.getTime() + 30 * 60_000).toISOString();
  const candidates = await withPgTenant(pg, claim.policy.tenant_id, async (tenantPg) => {
    const result = await tenantPg.query<RetentionRow>(
      `SELECT file.id, file.object_key,
         COALESCE((
           SELECT array_agg(part.object_key ORDER BY part.part_number)
           FROM collaboration_secure_file_parts part
           WHERE part.tenant_id = file.tenant_id AND part.secure_file_id = file.id
         ), ARRAY[]::text[]) AS part_keys,
         COALESCE((
           SELECT array_agg(derivative.object_key ORDER BY derivative.derivative_kind)
           FROM collaboration_secure_file_derivatives derivative
           WHERE derivative.tenant_id = file.tenant_id
             AND derivative.secure_file_id = file.id AND derivative.object_key <> ''
         ), ARRAY[]::text[]) AS derivative_keys,
         EXISTS (
           SELECT 1 FROM ivekit_legal_holds hold
           WHERE hold.tenant_id = file.tenant_id AND hold.category = 'secure_files'
             AND hold.resource_type = 'secure_file' AND hold.resource_id = file.id
             AND hold.status = 'active'
         ) AS held
       FROM collaboration_secure_files file
       WHERE file.tenant_id = $1
         AND file.status IN ('initiated', 'uploading', 'ready', 'quarantined', 'failed')
         AND (
           LEAST(
             COALESCE(file.retention_until, 'infinity'::timestamptz),
             COALESCE(file.expires_at, 'infinity'::timestamptz)
           ) <= $3::timestamptz
           OR (
             file.retention_until IS NULL AND file.expires_at IS NULL
             AND file.created_at <= $2::timestamptz
           )
         )
         AND (file.cleanup_next_attempt_at IS NULL OR file.cleanup_next_attempt_at <= $4::timestamptz)
         AND (file.cleanup_lease_until IS NULL OR file.cleanup_lease_until <= $4::timestamptz)
       ORDER BY held ASC, CASE
         WHEN file.retention_until IS NOT NULL OR file.expires_at IS NOT NULL THEN LEAST(
           COALESCE(file.retention_until, 'infinity'::timestamptz),
           COALESCE(file.expires_at, 'infinity'::timestamptz)
         ) ELSE file.created_at END, file.id
       LIMIT $5 FOR UPDATE OF file SKIP LOCKED`,
      [
        claim.policy.tenant_id,
        claim.cutoff_at,
        claim.started_at,
        claimedAt.toISOString(),
        claim.policy.batch_size
      ]
    );
    for (const row of result.rows) {
      if (truthy(row.held)) continue;
      await tenantPg.query(
        `UPDATE collaboration_secure_files
         SET cleanup_attempt_count = cleanup_attempt_count + 1,
             cleanup_worker_id = $3, cleanup_lease_token_hash = $4,
             cleanup_lease_until = $5::timestamptz, cleanup_next_attempt_at = NULL,
             cleanup_error_code = ''
         WHERE tenant_id = $1 AND id = $2`,
        [claim.policy.tenant_id, String(row.id), claim.worker_id, claimTokenHash, cleanupLeaseUntil]
      );
    }
    return result.rows;
  });

  let deleted = 0;
  for (const candidate of candidates) {
    if (truthy(candidate.held)) continue;
    const keys = uniqueStrings([
      candidate.object_key,
      ...textArray(candidate.part_keys),
      ...textArray(candidate.derivative_keys)
    ]);
    let deleteFailed = false;
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch {
        deleteFailed = true;
        break;
      }
    }
    if (deleteFailed) {
      await releaseSecureFileForRetry(pg, claim, String(candidate.id), claimTokenHash, now());
      continue;
    }
    const expired = await expireSecureFile(pg, claim, String(candidate.id), claimTokenHash, now());
    if (expired) deleted += 1;
  }
  return {
    scanned_count: candidates.length,
    deleted_count: deleted,
    held_count: candidates.filter((candidate) => truthy(candidate.held)).length
  };
}

async function expireSecureFile(
  pg: PgQueryable,
  claim: ConveractFabricRetentionClaim,
  fileId: string,
  claimTokenHash: string,
  now: Date
): Promise<boolean> {
  return withPgTenant(pg, claim.policy.tenant_id, async (tenantPg) => {
    const timestamp = now.toISOString();
    const fenced = await tenantPg.query<{ id: string }>(
      `SELECT id FROM collaboration_secure_files
       WHERE tenant_id = $1 AND id = $2 AND cleanup_worker_id = $3
         AND cleanup_lease_token_hash = $4
       FOR UPDATE`,
      [claim.policy.tenant_id, fileId, claim.worker_id, claimTokenHash]
    );
    if (!fenced.rows[0]) return false;
    await tenantPg.query(
      `UPDATE collaboration_secure_file_derivatives
       SET status = 'expired', next_attempt_at = NULL, lease_token_hash = '',
           lease_until = NULL, worker_id = '', error_code = '',
           completed_at = COALESCE(completed_at, $3::timestamptz), updated_at = $3::timestamptz
       WHERE tenant_id = $1 AND secure_file_id = $2 AND status <> 'expired'`,
      [claim.policy.tenant_id, fileId, timestamp]
    );
    await tenantPg.query(
      `UPDATE collaboration_secure_file_parts
       SET status = 'aborted', updated_at = $3::timestamptz
       WHERE tenant_id = $1 AND secure_file_id = $2 AND status <> 'aborted'`,
      [claim.policy.tenant_id, fileId, timestamp]
    );
    const result = await tenantPg.query<{ id: string }>(
      `UPDATE collaboration_secure_files
       SET status = 'expired', cleanup_next_attempt_at = NULL, cleanup_error_code = '',
           cleanup_lease_token_hash = '', cleanup_lease_until = NULL,
           cleanup_worker_id = '', updated_at = $5::timestamptz
       WHERE tenant_id = $1 AND id = $2 AND cleanup_worker_id = $3
         AND cleanup_lease_token_hash = $4
       RETURNING id`,
      [claim.policy.tenant_id, fileId, claim.worker_id, claimTokenHash, timestamp]
    );
    return Boolean(result.rows[0]);
  });
}

async function releaseSecureFileForRetry(
  pg: PgQueryable,
  claim: ConveractFabricRetentionClaim,
  fileId: string,
  claimTokenHash: string,
  now: Date
): Promise<void> {
  await withPgTenant(pg, claim.policy.tenant_id, async (tenantPg) => {
    await tenantPg.query(
      `UPDATE collaboration_secure_files
       SET cleanup_next_attempt_at = $5::timestamptz + INTERVAL '60 seconds',
           cleanup_error_code = 'retention_object_delete_failed',
           cleanup_lease_token_hash = '', cleanup_lease_until = NULL,
           cleanup_worker_id = ''
       WHERE tenant_id = $1 AND id = $2 AND cleanup_worker_id = $3
         AND cleanup_lease_token_hash = $4`,
      [claim.policy.tenant_id, fileId, claim.worker_id, claimTokenHash, now.toISOString()]
    );
  });
}

async function deleteMediaRecordings(
  pg: PgQueryable,
  remove: (recording: { storage_url: string }) => Promise<RecordingDeleteResult>,
  claim: ConveractFabricRetentionClaim,
  now: () => Date
): Promise<ConveractFabricRetentionDeletionSummary> {
  const candidates = await withPgTenant(pg, claim.policy.tenant_id, async (tenantPg) => {
    const result = await tenantPg.query<RetentionRow>(
      `SELECT recording.id, recording.storage_url,
         recording.media_call_id, recording.call_session_id,
         EXISTS (
           SELECT 1 FROM ivekit_legal_holds hold
           WHERE hold.tenant_id = recording.tenant_id AND hold.category = 'media_recordings'
             AND hold.resource_type = 'media_recording' AND hold.resource_id = recording.id
             AND hold.status = 'active'
         ) AS held
       FROM call_recordings recording
       WHERE recording.tenant_id = $1
         AND recording.status IN ('completed', 'failed', 'stopped')
         AND (
           recording.retention_until <= $3::timestamptz
           OR (
             recording.retention_until IS NULL
             AND recording.created_at <= $2::timestamptz
           )
         )
       ORDER BY held ASC, COALESCE(recording.retention_until, recording.created_at), recording.id
       LIMIT $4 FOR UPDATE OF recording SKIP LOCKED`,
      [claim.policy.tenant_id, claim.cutoff_at, claim.started_at, claim.policy.batch_size]
    );
    return result.rows;
  });

  let deleted = 0;
  for (const candidate of candidates) {
    if (truthy(candidate.held)) continue;
    let result: RecordingDeleteResult;
    try {
      result = await remove({ storage_url: String(candidate.storage_url || '') });
    } catch {
      result = { status: 'delete_failed', error: 'recording_object_delete_failed' };
    }
    const deletedObject = result.status === 'deleted' || result.status === 'not_found';
    const stateUpdated = await withPgTenant(pg, claim.policy.tenant_id, async (tenantPg) => {
      if (deletedObject) {
        const updated = await tenantPg.query(
          `UPDATE call_recordings
           SET status = 'deleted', object_status = 'deleted', deleted_at = $3::timestamptz,
               failure_code = '', updated_at = $3::timestamptz
           WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'
           RETURNING id`,
          [claim.policy.tenant_id, String(candidate.id), now().toISOString()]
        );
        const changed = (updated.rowCount ?? updated.rows.length) > 0;
        const interactionId = String(candidate.media_call_id || candidate.call_session_id || '');
        if (changed && interactionId) {
          await tenantPg.query(
            `DELETE FROM ivekit_realtime_speech_segments
             WHERE tenant_id = $1 AND interaction_id = $2`,
            [claim.policy.tenant_id, interactionId]
          );
        }
        return changed;
      }
      await tenantPg.query(
        `UPDATE call_recordings
         SET object_status = $3, object_checked_at = $4::timestamptz,
             failure_code = 'recording_object_delete_failed', updated_at = $4::timestamptz
         WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'`,
        [
          claim.policy.tenant_id,
          String(candidate.id),
          result.status === 'unsupported' ? 'unsupported' : 'delete_failed',
          now().toISOString()
        ]
      );
      return false;
    });
    if (stateUpdated) deleted += 1;
  }
  return {
    scanned_count: candidates.length,
    deleted_count: deleted,
    held_count: candidates.filter((candidate) => truthy(candidate.held)).length
  };
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true';
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    return value.slice(1, -1).split(',').map((item) => item.replace(/^"|"$/g, ''));
  }
  return [];
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
