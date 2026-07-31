import { resolveFabricEnv } from '../../../config/converact-env.js';
import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import { withPgTenant } from '../../../db-pg-tenant.js';
import type {
  VoiceCallRepository,
  VoiceConfigurationRepository
} from '../voice/ports.js';
import type {
  RecordingMultipartUpload,
  RecordingSegmentEvent,
  RecordingUploadLease,
  RecordingUploadPart
} from './postgres-recording-manifest-store.js';
import { RecordingManifestStoreError } from './postgres-recording-manifest-store.js';
import {
  createRecordingManifest,
  createRecordingSegment,
  sealRecordingSegment,
  transitionRecordingManifest,
  type RecordingManifest,
  type RecordingSegment
} from './recording-manifest.js';

const MAX_SEGMENT_DURATION_MS = 15 * 60 * 1_000;
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PART_SIZE_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENT_EVENTS = 4096;
const RUSTPBX_EVENT_TYPES = new Set<RecordingSegmentEvent['event_type']>([
  'paused',
  'resumed',
  'masked',
  'unmasked',
  'discontinuity',
  'sample_dropped'
]);

export interface RustPbxRecordingSegmentManifestV1 {
  schema_version: 1;
  recording_id: string;
  segment_id: string;
  interaction_id: string;
  reservation_id: string;
  owner_epoch: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  recorder_node_id: string;
  sequence: number;
  track_id: string;
  payload_filename: string;
  container: string;
  codec: string;
  channels: number;
  sample_rate_hz: number;
  size_bytes: number;
  encoded_payload_bytes: number;
  encoded_payload_sha256: string;
  checksum_scope: 'encoded_payload';
  written_samples: number;
  started_at: number;
  ended_at: number;
}

export interface RustPbxRecordingSegmentEventV1 {
  schema_version: 1;
  recording_id: string;
  segment_id: string;
  interaction_id: string;
  reservation_id: string;
  owner_epoch: string;
  event_sequence: number;
  event_type: RecordingSegmentEvent['event_type'];
  dropped_samples?: number;
  occurred_at: number;
}

export interface RustPbxRecordingCompletionV1 {
  schema_version: 1;
  recording_id: string;
  interaction_id: string;
  reservation_id: string;
  owner_epoch: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  recorder_node_id: string;
  segment_count: number;
  last_segment_sequence: number;
  ended_at: number;
}

export interface RecordingSpoolAuthorization {
  tenant_id: string;
  profile_id: string;
  interaction_id: string;
  consent_id: string;
  recording_mode: 'always' | 'policy';
  retention_until: string;
}

export interface RecordingSpoolAuthorizer {
  authorize(input: {
    tenant_id: string;
    profile_id: string;
    segment: RustPbxRecordingSegmentManifestV1;
    now: Date;
  }): Promise<RecordingSpoolAuthorization>;
  authorizeCompletion(input: {
    tenant_id: string;
    profile_id: string;
    completion: RustPbxRecordingCompletionV1;
    now: Date;
  }): Promise<void>;
}

export interface RecordingSpoolPlacement {
  tenant_id: string;
  interaction_id: string;
  interaction_kind: string;
  profile_id: string;
  reservation_id: string;
  owner_epoch: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  state: string;
}

export interface RecordingSpoolPlacementStore {
  get(tenantId: string, interactionId: string): Promise<RecordingSpoolPlacement | null>;
}

export interface RecordingSpoolIntakeStore {
  createManifest(input: RecordingManifest): Promise<{ manifest: RecordingManifest; created: boolean }>;
  registerSegment(input: RecordingSegment): Promise<{ segment: RecordingSegment; created: boolean }>;
  getSegment(tenantId: string, segmentId: string): Promise<RecordingSegment | null>;
  appendSegmentEvent(input: RecordingSegmentEvent): Promise<{
    event: RecordingSegmentEvent;
    created: boolean;
  }>;
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
  }): Promise<RecordingManifest>;
  claimSegment(input: {
    tenant_id: string;
    segment_id: string;
    worker_id: string;
    lease_token_hash: string;
    now: Date;
    lease_ms: number;
  }): Promise<{ segment: RecordingSegment; lease: RecordingUploadLease }>;
  assertActiveLease(input: LeaseIdentity & { now: Date }): Promise<{
    segment: RecordingSegment;
    lease: RecordingUploadLease;
  }>;
}

export interface RecordingSpoolUploadPort {
  ensureMultipart(input: LeaseIdentity & {
    part_size_bytes: number;
    now: Date;
  }): Promise<RecordingMultipartUpload>;
  listParts(input: LeaseIdentity & { now?: Date }): Promise<RecordingUploadPart[]>;
  uploadPart(input: LeaseIdentity & {
    part_number: number;
    content: Buffer;
    sha256: string;
    now: Date;
  }): Promise<RecordingUploadPart>;
  complete(input: LeaseIdentity & { now: Date }): Promise<{
    segment: RecordingSegment;
    upload: RecordingMultipartUpload;
  }>;
}

interface LeaseIdentity {
  tenant_id: string;
  segment_id: string;
  owner_epoch: string;
  worker_id: string;
  lease_token_hash: string;
}

export interface RecordingSpoolInitializeInput {
  tenant_id: string;
  profile_id: string;
  segment: RustPbxRecordingSegmentManifestV1;
  events?: RustPbxRecordingSegmentEventV1[];
  whole_file: { size_bytes: number; sha256: string };
  worker_id: string;
  lease_token: string;
  lease_ms: number;
  part_size_bytes: number;
}

export interface RecordingSpoolFinalizeInput {
  tenant_id: string;
  profile_id: string;
  completion: RustPbxRecordingCompletionV1;
}

export type RecordingSpoolInitializeResult =
  | {
      state: 'uploading';
      manifest: RecordingManifest;
      segment: RecordingSegment;
      lease: RecordingUploadLease;
      upload: RecordingMultipartUpload;
      parts: RecordingUploadPart[];
    }
  | {
      state: 'completed';
      manifest: RecordingManifest;
      segment: RecordingSegment;
      parts: RecordingUploadPart[];
    };

export class RecordingSpoolIntakeError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly retryable = false
  ) {
    super(code);
    this.name = 'RecordingSpoolIntakeError';
  }
}

export function recordingSpoolHttpPartMaxBytes(
  env: NodeJS.ProcessEnv = process.env
): number {
  const value = Number(resolveFabricEnv(env, 'RECORDING_PART_MAX_BYTES') || 8 * 1024 * 1024);
  if (!Number.isInteger(value) || value < MIN_PART_SIZE_BYTES || value > MAX_PART_SIZE_BYTES) {
    throw new Error('CONVERACT_FABRIC_RECORDING_PART_MAX_BYTES is invalid');
  }
  return value;
}

export class PostgresRecordingSpoolPlacementStore implements RecordingSpoolPlacementStore {
  constructor(private readonly pg: PgQueryable) {}

  get(tenantId: string, interactionId: string): Promise<RecordingSpoolPlacement | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<Record<string, unknown>>(
        `SELECT tenant_id, interaction_id, interaction_kind, profile_id,
                reservation_id, owner_epoch, region_id, zone_id, cell_id,
                owner_node_id, state
         FROM ivekit_interaction_placements
         WHERE tenant_id = $1 AND interaction_kind = 'sip_voice'
           AND interaction_id = $2`,
        [tenantId, interactionId]
      );
      const row = result.rows[0];
      return row ? {
        tenant_id: String(row.tenant_id),
        interaction_id: String(row.interaction_id),
        interaction_kind: String(row.interaction_kind),
        profile_id: String(row.profile_id),
        reservation_id: String(row.reservation_id),
        owner_epoch: String(row.owner_epoch),
        region_id: String(row.region_id),
        zone_id: String(row.zone_id),
        cell_id: String(row.cell_id),
        owner_node_id: String(row.owner_node_id),
        state: String(row.state)
      } : null;
    });
  }
}

export class RustPbxRecordingSpoolAuthorizer implements RecordingSpoolAuthorizer {
  constructor(private readonly input: {
    calls: Pick<VoiceCallRepository, 'get'>;
    configuration: Pick<VoiceConfigurationRepository, 'getPolicy' | 'listConsents'>;
    placements: RecordingSpoolPlacementStore;
  }) {}

  async authorize(input: {
    tenant_id: string;
    profile_id: string;
    segment: RustPbxRecordingSegmentManifestV1;
    now: Date;
  }): Promise<RecordingSpoolAuthorization> {
    const call = await this.input.calls.get(input.tenant_id, input.segment.interaction_id);
    if (!call || call.tenant_id !== input.tenant_id) throw intakeError('recording_spool_call_not_found', 404);
    if (call.provider_profile_id !== input.profile_id) {
      throw intakeError('recording_spool_profile_conflict', 409);
    }
    const placement = await this.input.placements.get(input.tenant_id, call.id);
    if (!placement) throw intakeError('recording_spool_placement_not_found', 409);
    assertPlacement(placement, input);

    const policy = await this.input.configuration.getPolicy(input.tenant_id);
    if (!policy || policy.status !== 'active' || policy.recording_mode === 'disabled') {
      throw intakeError('recording_spool_policy_denied', 403);
    }
    let consentId = policy.id;
    let recordingMode: RecordingSpoolAuthorization['recording_mode'] = 'always';
    if (policy.recording_mode === 'consent_required') {
      recordingMode = 'policy';
      const page = await this.input.configuration.listConsents({
        tenant_id: input.tenant_id,
        subject_ref_type: 'call',
        subject_ref_id: call.id,
        limit: 100
      });
      const startedAt = input.segment.started_at;
      const consent = page.items.find((candidate) =>
        candidate.consent_type === 'recording' &&
        candidate.status === 'granted' &&
        Boolean(candidate.evidence_ref) &&
        Date.parse(candidate.created_at) <= startedAt &&
        (!candidate.expires_at || Date.parse(candidate.expires_at) > startedAt)
      );
      if (!consent) throw intakeError('recording_spool_consent_required', 403);
      consentId = consent.id;
    }
    const retentionUntil = new Date(
      input.segment.ended_at + policy.recording_retention_days * 86_400_000
    );
    if (!Number.isFinite(retentionUntil.getTime()) || retentionUntil <= input.now) {
      throw intakeError('recording_spool_retention_invalid', 409);
    }
    return {
      tenant_id: input.tenant_id,
      profile_id: input.profile_id,
      interaction_id: call.id,
      consent_id: consentId,
      recording_mode: recordingMode,
      retention_until: retentionUntil.toISOString()
    };
  }

  async authorizeCompletion(input: {
    tenant_id: string;
    profile_id: string;
    completion: RustPbxRecordingCompletionV1;
    now: Date;
  }): Promise<void> {
    const call = await this.input.calls.get(input.tenant_id, input.completion.interaction_id);
    if (!call || call.tenant_id !== input.tenant_id) {
      throw intakeError('recording_spool_call_not_found', 404);
    }
    if (call.provider_profile_id !== input.profile_id) {
      throw intakeError('recording_spool_profile_conflict', 409);
    }
    const placement = await this.input.placements.get(input.tenant_id, call.id);
    if (!placement) throw intakeError('recording_spool_placement_not_found', 409);
    assertCompletionPlacement(placement, input);
  }
}

export class RecordingSpoolIntakeService {
  readonly #now: () => Date;

  constructor(private readonly input: {
    authorizer: RecordingSpoolAuthorizer;
    store: RecordingSpoolIntakeStore;
    uploads: RecordingSpoolUploadPort;
    now?: () => Date;
  }) {
    this.#now = input.now ?? (() => new Date());
  }

  async initialize(raw: RecordingSpoolInitializeInput): Promise<RecordingSpoolInitializeResult> {
    const input = validateInitializeInput(raw);
    const now = this.#now();
    const authorization = await this.input.authorizer.authorize({
      tenant_id: input.tenant_id,
      profile_id: input.profile_id,
      segment: input.segment,
      now
    });
    let manifest = createRecordingManifest({
      id: input.segment.recording_id,
      tenant_id: input.tenant_id,
      interaction_id: authorization.interaction_id,
      interaction_kind: 'sip_voice',
      owner_epoch: input.segment.owner_epoch,
      source: 'sip_voice',
      consent_id: authorization.consent_id,
      recording_mode: authorization.recording_mode,
      retention_until: authorization.retention_until,
      region_id: input.segment.region_id,
      zone_id: input.segment.zone_id,
      cell_id: input.segment.cell_id,
      recorder_node_id: input.segment.recorder_node_id,
      media: {
        container: input.segment.container,
        codecs: [input.segment.codec],
        channels: input.segment.channels,
        sample_rate_hz: input.segment.sample_rate_hz
      },
      processing: {
        reservation_id: input.segment.reservation_id,
        segment_format: 'rustpbx_segmented_wav_v1',
        segment_checksum_scope: input.segment.checksum_scope
      }
    }, new Date(input.segment.started_at));
    manifest = transitionRecordingManifest(manifest, 'reserved', {
      owner_epoch: input.segment.owner_epoch,
      at: new Date(input.segment.started_at)
    });
    manifest = transitionRecordingManifest(manifest, 'recording', {
      owner_epoch: input.segment.owner_epoch,
      at: new Date(input.segment.started_at)
    });
    manifest = transitionRecordingManifest(manifest, 'finalizing', {
      owner_epoch: input.segment.owner_epoch,
      at: new Date(input.segment.ended_at)
    });
    manifest = transitionRecordingManifest(manifest, 'uploading', {
      owner_epoch: input.segment.owner_epoch,
      at: new Date(input.segment.ended_at)
    });
    manifest = (await this.input.store.createManifest(manifest)).manifest;

    let segment = createRecordingSegment({
      id: input.segment.segment_id,
      tenant_id: input.tenant_id,
      manifest_id: input.segment.recording_id,
      owner_epoch: input.segment.owner_epoch,
      sequence: input.segment.sequence,
      track_id: input.segment.track_id,
      container: input.segment.container,
      codec: input.segment.codec,
      started_at: new Date(input.segment.started_at).toISOString(),
      local_ref: `spool://${input.segment.recording_id}/${input.segment.payload_filename}`
    }, new Date(input.segment.started_at));
    segment = sealRecordingSegment(segment, {
      owner_epoch: input.segment.owner_epoch,
      size_bytes: input.whole_file.size_bytes,
      sha256: input.whole_file.sha256,
      ended_at: new Date(input.segment.ended_at)
    });
    segment = (await this.input.store.registerSegment(segment)).segment;
    for (const event of input.events || []) {
      await this.input.store.appendSegmentEvent({
        id: recordingSegmentEventId(event),
        tenant_id: input.tenant_id,
        manifest_id: input.segment.recording_id,
        segment_id: input.segment.segment_id,
        owner_epoch: input.segment.owner_epoch,
        event_sequence: event.event_sequence,
        event_type: event.event_type,
        policy_source: 'rustpbx_recorder',
        actor_identity: input.segment.recorder_node_id,
        metadata: {
          interaction_id: input.segment.interaction_id,
          reservation_id: input.segment.reservation_id,
          ...(event.dropped_samples === undefined
            ? {}
            : { dropped_samples: event.dropped_samples })
        },
        occurred_at: new Date(event.occurred_at).toISOString()
      });
    }
    if (segment.state === 'uploaded') {
      return { state: 'completed', manifest, segment, parts: [] };
    }

    const leaseIdentity = {
      tenant_id: input.tenant_id,
      segment_id: input.segment.segment_id,
      owner_epoch: input.segment.owner_epoch,
      worker_id: input.worker_id,
      lease_token_hash: sha256(input.lease_token)
    };
    let claimed: { segment: RecordingSegment; lease: RecordingUploadLease };
    try {
      claimed = await this.input.store.assertActiveLease({ ...leaseIdentity, now });
    } catch (error) {
      if (!leaseConflict(error)) throw error;
      claimed = await this.input.store.claimSegment({
        tenant_id: input.tenant_id,
        segment_id: input.segment.segment_id,
        worker_id: input.worker_id,
        lease_token_hash: leaseIdentity.lease_token_hash,
        now,
        lease_ms: input.lease_ms
      });
    }
    const upload = await this.input.uploads.ensureMultipart({
      ...leaseIdentity,
      part_size_bytes: input.part_size_bytes,
      now
    });
    const parts = await this.input.uploads.listParts({ ...leaseIdentity, now });
    return {
      state: 'uploading',
      manifest,
      segment: claimed.segment,
      lease: claimed.lease,
      upload,
      parts
    };
  }

  uploadPart(input: LeaseIdentity & {
    part_number: number;
    content: Buffer;
    sha256: string;
  }): Promise<RecordingUploadPart> {
    return this.input.uploads.uploadPart({ ...input, now: this.#now() });
  }

  listParts(input: LeaseIdentity): Promise<RecordingUploadPart[]> {
    return this.input.uploads.listParts({ ...input, now: this.#now() });
  }

  complete(input: LeaseIdentity): Promise<{
    segment: RecordingSegment;
    upload: RecordingMultipartUpload;
  }> {
    return this.input.uploads.complete({ ...input, now: this.#now() });
  }

  async finalize(raw: RecordingSpoolFinalizeInput): Promise<RecordingManifest> {
    const completion = validateRecordingCompletion(raw.completion);
    const tenantId = identifier(raw.tenant_id, 'recording_spool_tenant_invalid', 128);
    const profileId = identifier(raw.profile_id, 'recording_spool_profile_invalid', 128);
    const now = this.#now();
    await this.input.authorizer.authorizeCompletion({
      tenant_id: tenantId,
      profile_id: profileId,
      completion,
      now
    });
    try {
      return await this.input.store.finalizeManifest({
        tenant_id: tenantId,
        manifest_id: completion.recording_id,
        owner_epoch: completion.owner_epoch,
        interaction_id: completion.interaction_id,
        reservation_id: completion.reservation_id,
        region_id: completion.region_id,
        zone_id: completion.zone_id,
        cell_id: completion.cell_id,
        recorder_node_id: completion.recorder_node_id,
        segment_count: completion.segment_count,
        last_segment_sequence: completion.last_segment_sequence,
        ended_at: new Date(completion.ended_at),
        now
      });
    } catch (error) {
      if (error instanceof RecordingManifestStoreError) {
        throw intakeError(error.code, error.status, error.retryable);
      }
      throw error;
    }
  }
}

function validateInitializeInput(input: RecordingSpoolInitializeInput): RecordingSpoolInitializeInput {
  const segment = validateSegmentManifest(input.segment);
  if (input.events !== undefined && !Array.isArray(input.events)) {
    throw intakeError('recording_spool_events_invalid');
  }
  if ((input.events?.length || 0) > MAX_SEGMENT_EVENTS) {
    throw intakeError('recording_spool_events_limit_exceeded');
  }
  const events = (input.events || []).map((event) => validateSegmentEvent(event, segment));
  if (new Set(events.map((event) => event.event_sequence)).size !== events.length) {
    throw intakeError('recording_spool_event_sequence_conflict', 409);
  }
  const fileSize = positiveInteger(input.whole_file?.size_bytes, 'recording_spool_file_size_invalid');
  if (fileSize !== segment.size_bytes) {
    throw intakeError('recording_spool_file_size_conflict', 409);
  }
  const fileSha = checksum(input.whole_file?.sha256, 'recording_spool_file_checksum_invalid');
  const partSize = boundedInteger(
    input.part_size_bytes,
    MIN_PART_SIZE_BYTES,
    MAX_PART_SIZE_BYTES,
    'recording_spool_part_size_invalid'
  );
  const leaseMs = boundedInteger(input.lease_ms, 10_000, 15 * 60_000, 'recording_spool_lease_invalid');
  const workerId = identifier(input.worker_id, 'recording_spool_worker_invalid', 128);
  const leaseToken = String(input.lease_token || '');
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(leaseToken)) {
    throw intakeError('recording_spool_lease_token_invalid');
  }
  return {
    tenant_id: identifier(input.tenant_id, 'recording_spool_tenant_invalid', 128),
    profile_id: identifier(input.profile_id, 'recording_spool_profile_invalid', 128),
    segment,
    events,
    whole_file: { size_bytes: fileSize, sha256: fileSha },
    worker_id: workerId,
    lease_token: leaseToken,
    lease_ms: leaseMs,
    part_size_bytes: partSize
  };
}

export function validateSegmentEvent(
  value: unknown,
  segment: RustPbxRecordingSegmentManifestV1
): RustPbxRecordingSegmentEventV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw intakeError('recording_spool_event_invalid');
  }
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 1) throw intakeError('recording_spool_event_version_invalid');
  const event: RustPbxRecordingSegmentEventV1 = {
    schema_version: 1,
    recording_id: identifier(item.recording_id, 'recording_spool_recording_id_invalid'),
    segment_id: identifier(item.segment_id, 'recording_spool_segment_id_invalid'),
    interaction_id: identifier(item.interaction_id, 'recording_spool_interaction_id_invalid'),
    reservation_id: identifier(item.reservation_id, 'recording_spool_reservation_id_invalid'),
    owner_epoch: ownerEpochValue(item.owner_epoch),
    event_sequence: positiveInteger(item.event_sequence, 'recording_spool_event_sequence_invalid'),
    event_type: String(item.event_type || '') as RecordingSegmentEvent['event_type'],
    ...(item.dropped_samples === undefined
      ? {}
      : {
          dropped_samples: positiveInteger(
            item.dropped_samples,
            'recording_spool_event_drop_count_invalid'
          )
        }),
    occurred_at: nonNegativeInteger(item.occurred_at, 'recording_spool_event_time_invalid')
  };
  if (!RUSTPBX_EVENT_TYPES.has(event.event_type)) {
    throw intakeError('recording_spool_event_type_invalid');
  }
  if ((event.event_type === 'sample_dropped') !== (event.dropped_samples !== undefined)) {
    throw intakeError('recording_spool_event_drop_count_invalid');
  }
  if (
    event.recording_id !== segment.recording_id ||
    event.segment_id !== segment.segment_id ||
    event.interaction_id !== segment.interaction_id ||
    event.reservation_id !== segment.reservation_id ||
    event.owner_epoch !== segment.owner_epoch
  ) {
    throw intakeError('recording_spool_event_owner_conflict', 409);
  }
  if (event.occurred_at < segment.started_at || event.occurred_at > segment.ended_at) {
    throw intakeError('recording_spool_event_time_conflict', 409);
  }
  return event;
}

export function validateSegmentManifest(value: unknown): RustPbxRecordingSegmentManifestV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw intakeError('recording_spool_manifest_invalid');
  }
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 1 || item.checksum_scope !== 'encoded_payload') {
    throw intakeError('recording_spool_manifest_version_invalid');
  }
  const startedAt = nonNegativeInteger(item.started_at, 'recording_spool_started_at_invalid');
  const endedAt = nonNegativeInteger(item.ended_at, 'recording_spool_ended_at_invalid');
  if (endedAt < startedAt || endedAt - startedAt > MAX_SEGMENT_DURATION_MS) {
    throw intakeError('recording_spool_duration_invalid');
  }
  const sizeBytes = positiveInteger(item.size_bytes, 'recording_spool_file_size_invalid');
  const encodedPayloadBytes = positiveInteger(
    item.encoded_payload_bytes,
    'recording_spool_payload_size_invalid'
  );
  if (encodedPayloadBytes > sizeBytes) throw intakeError('recording_spool_payload_size_invalid');
  const payloadFilename = String(item.payload_filename || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(payloadFilename)) {
    throw intakeError('recording_spool_payload_filename_invalid');
  }
  const ownerEpoch = ownerEpochValue(item.owner_epoch);
  const container = identifier(item.container, 'recording_spool_container_invalid', 32);
  if (container !== 'wav') throw intakeError('recording_spool_container_invalid');
  return {
    schema_version: 1,
    recording_id: identifier(item.recording_id, 'recording_spool_recording_id_invalid'),
    segment_id: identifier(item.segment_id, 'recording_spool_segment_id_invalid'),
    interaction_id: identifier(item.interaction_id, 'recording_spool_interaction_id_invalid'),
    reservation_id: identifier(item.reservation_id, 'recording_spool_reservation_id_invalid'),
    owner_epoch: ownerEpoch,
    region_id: identifier(item.region_id, 'recording_spool_region_invalid'),
    zone_id: identifier(item.zone_id, 'recording_spool_zone_invalid'),
    cell_id: identifier(item.cell_id, 'recording_spool_cell_invalid'),
    recorder_node_id: identifier(item.recorder_node_id, 'recording_spool_node_invalid'),
    sequence: positiveInteger(item.sequence, 'recording_spool_sequence_invalid'),
    track_id: identifier(item.track_id, 'recording_spool_track_invalid'),
    payload_filename: payloadFilename,
    container,
    codec: identifier(item.codec, 'recording_spool_codec_invalid', 64),
    channels: boundedInteger(item.channels, 1, 32, 'recording_spool_channels_invalid'),
    sample_rate_hz: boundedInteger(
      item.sample_rate_hz,
      1_000,
      384_000,
      'recording_spool_sample_rate_invalid'
    ),
    size_bytes: sizeBytes,
    encoded_payload_bytes: encodedPayloadBytes,
    encoded_payload_sha256: checksum(
      item.encoded_payload_sha256,
      'recording_spool_payload_checksum_invalid'
    ),
    checksum_scope: 'encoded_payload',
    written_samples: positiveInteger(item.written_samples, 'recording_spool_samples_invalid'),
    started_at: startedAt,
    ended_at: endedAt
  };
}

export function validateRecordingCompletion(
  value: unknown,
  expectedRecordingId?: string
): RustPbxRecordingCompletionV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw intakeError('recording_spool_completion_invalid');
  }
  const item = value as Record<string, unknown>;
  if (item.schema_version !== 1) {
    throw intakeError('recording_spool_completion_version_invalid');
  }
  const segmentCount = boundedInteger(
    item.segment_count,
    1,
    1_000_000,
    'recording_spool_completion_segment_count_invalid'
  );
  const lastSequence = boundedInteger(
    item.last_segment_sequence,
    1,
    1_000_000,
    'recording_spool_completion_segment_count_invalid'
  );
  if (segmentCount !== lastSequence) {
    throw intakeError('recording_spool_completion_segment_count_invalid');
  }
  const completion: RustPbxRecordingCompletionV1 = {
    schema_version: 1,
    recording_id: identifier(item.recording_id, 'recording_spool_recording_id_invalid'),
    interaction_id: identifier(item.interaction_id, 'recording_spool_interaction_id_invalid'),
    reservation_id: identifier(item.reservation_id, 'recording_spool_reservation_id_invalid'),
    owner_epoch: completionOwnerEpoch(item.owner_epoch),
    region_id: identifier(item.region_id, 'recording_spool_region_invalid'),
    zone_id: identifier(item.zone_id, 'recording_spool_zone_invalid'),
    cell_id: identifier(item.cell_id, 'recording_spool_cell_invalid'),
    recorder_node_id: identifier(item.recorder_node_id, 'recording_spool_node_invalid'),
    segment_count: segmentCount,
    last_segment_sequence: lastSequence,
    ended_at: nonNegativeInteger(item.ended_at, 'recording_spool_completion_time_invalid')
  };
  if (expectedRecordingId && completion.recording_id !== expectedRecordingId) {
    throw intakeError('recording_spool_completion_recording_conflict', 409);
  }
  return completion;
}

function assertPlacement(
  placement: RecordingSpoolPlacement,
  input: {
    tenant_id: string;
    profile_id: string;
    segment: RustPbxRecordingSegmentManifestV1;
  }
): void {
  const segment = input.segment;
  const exact = placement.tenant_id === input.tenant_id &&
    placement.interaction_id === segment.interaction_id &&
    placement.interaction_kind === 'sip_voice' &&
    placement.profile_id === input.profile_id &&
    placement.reservation_id === segment.reservation_id &&
    placement.owner_epoch === segment.owner_epoch &&
    placement.region_id === segment.region_id &&
    placement.zone_id === segment.zone_id &&
    placement.cell_id === segment.cell_id &&
    placement.owner_node_id === segment.recorder_node_id &&
    ['active', 'draining', 'recovering', 'closed'].includes(placement.state);
  if (!exact) throw intakeError('recording_spool_owner_conflict', 409);
}

function assertCompletionPlacement(
  placement: RecordingSpoolPlacement,
  input: {
    tenant_id: string;
    profile_id: string;
    completion: RustPbxRecordingCompletionV1;
  }
): void {
  const completion = input.completion;
  const exact = placement.tenant_id === input.tenant_id &&
    placement.interaction_id === completion.interaction_id &&
    placement.interaction_kind === 'sip_voice' &&
    placement.profile_id === input.profile_id &&
    placement.reservation_id === completion.reservation_id &&
    placement.owner_epoch === completion.owner_epoch &&
    placement.region_id === completion.region_id &&
    placement.zone_id === completion.zone_id &&
    placement.cell_id === completion.cell_id &&
    placement.owner_node_id === completion.recorder_node_id &&
    ['active', 'draining', 'recovering', 'closed'].includes(placement.state);
  if (!exact) throw intakeError('recording_spool_owner_conflict', 409);
}

function identifier(value: unknown, code: string, max = 255): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) {
    throw intakeError(code);
  }
  return text;
}

function ownerEpochValue(value: unknown): string {
  const text = String(value ?? '');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) {
    throw intakeError('recording_spool_owner_epoch_invalid');
  }
  try {
    if (BigInt(text) > 18_446_744_073_709_551_615n) throw new Error('overflow');
  } catch {
    throw intakeError('recording_spool_owner_epoch_invalid');
  }
  return text;
}

function completionOwnerEpoch(value: unknown): string {
  try {
    return ownerEpochValue(value);
  } catch {
    throw intakeError('recording_spool_completion_owner_epoch_invalid');
  }
}

function positiveInteger(value: unknown, code: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, code);
}

function nonNegativeInteger(value: unknown, code: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, code);
}

function boundedInteger(value: unknown, min: number, max: number, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw intakeError(code);
  return number;
}

function checksum(value: unknown, code: string): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) throw intakeError(code);
  return text;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function recordingSegmentEventId(event: RustPbxRecordingSegmentEventV1): string {
  return `rsevt_${sha256([
    event.recording_id,
    event.segment_id,
    event.owner_epoch,
    String(event.event_sequence),
    event.event_type
  ].join('\0')).slice(0, 48)}`;
}

function leaseConflict(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' &&
    'code' in error && (error as { code?: unknown }).code === 'recording_segment_lease_conflict');
}

function intakeError(code: string, status = 400, retryable = false): RecordingSpoolIntakeError {
  return new RecordingSpoolIntakeError(code, status, retryable);
}
