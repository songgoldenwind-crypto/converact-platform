import { id, json, run } from '../../db.js';
import type { PgQueryable } from '../../db-pg.js';
import {
  markMediaRecordingEvidenceDeleted,
  recordMediaRecordingEvidence
} from '../media-recording-evidence.js';
import {
  deleteRecordingObject,
  resolveRecordingObjectContent
} from '../media-recording-object.js';
import type { RecordingAuditEvent } from '../livekit/media-http.js';
import type { RouteIveKitMediaApiOptions } from './media-http.js';

export interface IveKitMediaHooksInput {
  db: unknown;
  pg: PgQueryable;
}

export function createIveKitMediaHooks(input: IveKitMediaHooksInput): RouteIveKitMediaApiOptions {
  const retentionDays = configuredRetentionDays();
  return {
    onRecordingStarted: (recording, context) => recordMediaRecordingEvidence(input.pg, recording, {
      roomName: context.roomName,
      createdBy: 'ivekit-media-core'
    }),
    onRecordingCompleted: (recording, context) => recordMediaRecordingEvidence(input.pg, recording, {
      roomName: context.roomName,
      createdBy: 'ivekit-media-core',
      resolveContent: resolveRecordingObjectContent
    }),
    resolveRecordingObject: resolveRecordingObjectContent,
    deleteRecordingObject,
    ...(retentionDays === undefined
      ? {}
      : { resolveRecordingRetentionDays: () => retentionDays }),
    onRecordingDeleted: (recording, context) => markMediaRecordingEvidenceDeleted(input.pg, recording, {
      deletedBy: context.actorId,
      deletionSource: context.source
    }),
    onRecordingAudit: (event) => recordIveKitMediaAudit(input.db, event)
  };
}

function configuredRetentionDays(): number | undefined {
  const raw = String(process.env.OPC_RECORDING_RETENTION_DAYS || '').trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error('OPC_RECORDING_RETENTION_DAYS must be an integer between 1 and 3650');
  }
  return value;
}

function recordIveKitMediaAudit(db: unknown, event: RecordingAuditEvent): void {
  const {
    tenant_id: tenantId,
    actor_id: actorId,
    action,
    recording_id: recordingId,
    ...metadata
  } = event;
  run(
    db,
    `INSERT INTO audit_logs
      (id, tenant_id, actor_id, action, object_type, object_id, metadata)
     VALUES (?, ?, ?, ?, 'media_recording', ?, ?)`,
    [id('audit'), tenantId, actorId, action, recordingId, json(metadata)]
  );
}
