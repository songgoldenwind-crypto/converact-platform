import { resolveBrandEnv } from '../../config/converact-env.js';
import { id, json, run } from '../../db-compat.js';
import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import {
  markMediaRecordingEvidenceDeleted,
  recordMediaRecordingEvidence
} from '../media-recording-evidence.js';
import {
  deleteRecordingObject,
  resolveRecordingObjectContent,
  resolveRecordingObjectStream
} from '../media-recording-object.js';
import type { RecordingAuditEvent } from '../livekit/media-http.js';
import type {
  LiveKitIngressAuditEvent,
  RouteConveractFabricMediaApiOptions
} from './media-http.js';
import { ConveractFabricTenantEventJournal } from './tenant-event-store.js';
import { RealtimeSpeechStore } from './voice/realtime-speech-store.js';

export interface ConveractFabricMediaHooksInput {
  db: unknown;
  pg: PgQueryable;
}

export function createConveractFabricMediaHooks(input: ConveractFabricMediaHooksInput): RouteConveractFabricMediaApiOptions {
  const retentionDays = configuredRetentionDays();
  return {
    pg: input.pg,
    eventStore: new ConveractFabricTenantEventJournal(input.pg),
    realtimeSpeechStore: new RealtimeSpeechStore(input.pg),
    onRecordingStarted: (recording, context) => withPgTenant(input.pg, recording.tenant_id, (pg) =>
      recordMediaRecordingEvidence(pg, recording, {
        roomName: context.roomName,
        createdBy: 'converact-media-core'
      })
    ),
    onRecordingCompleted: (recording, context) => withPgTenant(input.pg, recording.tenant_id, (pg) =>
      recordMediaRecordingEvidence(pg, recording, {
        roomName: context.roomName,
        createdBy: 'converact-media-core',
        resolveContent: resolveRecordingObjectContent
      })
    ),
    resolveRecordingObject: resolveRecordingObjectContent,
    resolveRecordingObjectStream,
    deleteRecordingObject,
    ...(retentionDays === undefined
      ? {}
      : { resolveRecordingRetentionDays: () => retentionDays }),
    onRecordingDeleted: (recording, context) => withPgTenant(input.pg, recording.tenant_id, async (pg) => {
      await markMediaRecordingEvidenceDeleted(pg, recording, {
        deletedBy: context.actorId,
        deletionSource: context.source
      });
      const interactionId = recording.media_call_id || recording.call_session_id;
      if (interactionId) {
        await new RealtimeSpeechStore(pg).deleteByInteraction({
          tenant_id: recording.tenant_id,
          interaction_id: interactionId
        });
      }
    }),
    onRecordingAudit: (event) => recordConveractFabricMediaAudit(input.db, event),
    onIngressAudit: (event) => recordConveractFabricIngressAudit(input.db, event)
  };
}

function configuredRetentionDays(): number | undefined {
  const raw = String(resolveBrandEnv(process.env, 'RECORDING_RETENTION_DAYS') || '').trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error('CONVERACT_RECORDING_RETENTION_DAYS must be an integer between 1 and 3650');
  }
  return value;
}

function recordConveractFabricMediaAudit(db: unknown, event: RecordingAuditEvent): void {
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

function recordConveractFabricIngressAudit(db: unknown, event: LiveKitIngressAuditEvent): void {
  const {
    tenant_id: tenantId,
    actor_id: actorId,
    action,
    ingress_id: ingressId,
    ...metadata
  } = event;
  run(
    db,
    `INSERT INTO audit_logs
      (id, tenant_id, actor_id, action, object_type, object_id, metadata)
     VALUES (?, ?, ?, ?, 'livekit_ingress', ?, ?)`,
    [id('audit'), tenantId, actorId, action, ingressId, json(metadata)]
  );
}
