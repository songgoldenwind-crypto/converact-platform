export type RecordingSource =
  | 'sip_voice'
  | 'livekit_audio_track'
  | 'livekit_video_track'
  | 'livekit_screen_track'
  | 'livekit_room_composite'
  | 'rustdesk_local'
  | 'im_attachment';

export type RecordingManifestState =
  | 'requested'
  | 'reserved'
  | 'recording'
  | 'finalizing'
  | 'uploading'
  | 'uploaded_unverified'
  | 'scanning'
  | 'available'
  | 'quarantined'
  | 'failed'
  | 'deleting'
  | 'deleted';

export type RecordingSegmentState =
  | 'open'
  | 'closed'
  | 'upload_pending'
  | 'uploading'
  | 'uploaded'
  | 'quarantined'
  | 'failed'
  | 'deleting'
  | 'deleted';

export interface RecordingMediaDescriptor {
  container: string;
  codecs: string[];
  channels: number | null;
  sample_rate_hz: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
}

export interface RecordingManifest {
  id: string;
  tenant_id: string;
  interaction_id: string;
  interaction_kind: string;
  owner_epoch: string;
  source: RecordingSource;
  state: RecordingManifestState;
  consent_id: string;
  recording_mode: 'always' | 'policy' | 'on_demand' | 'evidence_only';
  retention_until: string;
  legal_hold: boolean;
  region_id: string;
  zone_id: string;
  cell_id: string;
  recorder_node_id: string;
  media: RecordingMediaDescriptor;
  processing: Record<string, unknown>;
  object_ref: string;
  failure_code: string;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordingSegment {
  id: string;
  tenant_id: string;
  manifest_id: string;
  owner_epoch: string;
  sequence: number;
  track_id: string;
  state: RecordingSegmentState;
  container: string;
  codec: string;
  started_at: string;
  ended_at: string | null;
  size_bytes: number | null;
  sha256: string;
  local_ref: string;
  object_ref: string;
  failure_code: string;
  created_at: string;
  updated_at: string;
}

export type RecordingSpoolAdmission =
  | 'accept'
  | 'defer_non_core'
  | 'reject_must_record';

const MANIFEST_TRANSITIONS: Readonly<Record<RecordingManifestState, readonly RecordingManifestState[]>> = {
  requested: ['reserved', 'failed'],
  reserved: ['recording', 'failed'],
  recording: ['finalizing', 'failed'],
  finalizing: ['uploading', 'failed'],
  uploading: ['uploaded_unverified', 'failed'],
  uploaded_unverified: ['scanning', 'quarantined', 'failed'],
  scanning: ['available', 'quarantined', 'failed'],
  available: ['deleting'],
  quarantined: ['deleting'],
  failed: ['deleting'],
  deleting: ['deleted', 'failed'],
  deleted: []
};

const SEGMENT_TRANSITIONS: Readonly<Record<RecordingSegmentState, readonly RecordingSegmentState[]>> = {
  open: ['closed', 'failed'],
  closed: ['upload_pending', 'failed'],
  upload_pending: ['uploading', 'failed'],
  uploading: ['uploaded', 'upload_pending', 'quarantined', 'failed'],
  uploaded: ['quarantined', 'deleting'],
  quarantined: ['deleting'],
  failed: ['upload_pending', 'deleting'],
  deleting: ['deleted', 'failed'],
  deleted: []
};

export function createRecordingManifest(
  input: Omit<
    RecordingManifest,
    'state' | 'legal_hold' | 'object_ref' | 'failure_code' |
    'started_at' | 'ended_at' | 'created_at' | 'updated_at' | 'processing'
  > & { processing?: Record<string, unknown> },
  now = new Date()
): RecordingManifest {
  const timestamp = validTimestamp(now);
  return {
    id: identifier(input.id, 'recording_id'),
    tenant_id: identifier(input.tenant_id, 'tenant_id'),
    interaction_id: identifier(input.interaction_id, 'interaction_id'),
    interaction_kind: identifier(input.interaction_kind, 'interaction_kind'),
    owner_epoch: ownerEpoch(input.owner_epoch),
    source: input.source,
    state: 'requested',
    consent_id: identifier(input.consent_id, 'consent_id'),
    recording_mode: input.recording_mode,
    retention_until: timestampValue(input.retention_until, 'retention_until'),
    legal_hold: false,
    region_id: identifier(input.region_id, 'region_id'),
    zone_id: identifier(input.zone_id, 'zone_id'),
    cell_id: identifier(input.cell_id, 'cell_id'),
    recorder_node_id: identifier(input.recorder_node_id, 'recorder_node_id'),
    media: mediaDescriptor(input.media),
    processing: jsonRecord(input.processing ?? {}, 'processing'),
    object_ref: '',
    failure_code: '',
    started_at: timestamp,
    ended_at: null,
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function transitionRecordingManifest(
  manifest: RecordingManifest,
  state: RecordingManifestState,
  input: {
    owner_epoch: string;
    at?: Date;
    failure_code?: string;
    object_ref?: string;
  }
): RecordingManifest {
  assertOwner(manifest.owner_epoch, input.owner_epoch);
  if (manifest.state === state) return manifest;
  if (!MANIFEST_TRANSITIONS[manifest.state].includes(state)) {
    throw new Error('recording_manifest_transition_invalid');
  }
  const updatedAt = nextTimestamp(input.at ?? new Date(), manifest.updated_at);
  const failureCode = state === 'failed'
    ? identifier(input.failure_code, 'failure_code')
    : '';
  return {
    ...manifest,
    state,
    failure_code: failureCode,
    object_ref: input.object_ref === undefined
      ? manifest.object_ref
      : boundedText(input.object_ref, 'object_ref', 2_048),
    ended_at: state === 'finalizing' && manifest.ended_at === null
      ? updatedAt
      : manifest.ended_at,
    updated_at: updatedAt
  };
}

export function createRecordingSegment(
  input: Omit<
    RecordingSegment,
    'state' | 'ended_at' | 'size_bytes' | 'sha256' |
    'object_ref' | 'failure_code' | 'created_at' | 'updated_at'
  >,
  now = new Date()
): RecordingSegment {
  const timestamp = validTimestamp(now);
  return {
    id: identifier(input.id, 'segment_id'),
    tenant_id: identifier(input.tenant_id, 'tenant_id'),
    manifest_id: identifier(input.manifest_id, 'manifest_id'),
    owner_epoch: ownerEpoch(input.owner_epoch),
    sequence: positiveInteger(input.sequence, 'sequence'),
    track_id: identifier(input.track_id, 'track_id'),
    state: 'open',
    container: identifier(input.container, 'container'),
    codec: identifier(input.codec, 'codec'),
    started_at: timestampValue(input.started_at, 'started_at'),
    ended_at: null,
    size_bytes: null,
    sha256: '',
    local_ref: boundedText(input.local_ref, 'local_ref', 2_048),
    object_ref: '',
    failure_code: '',
    created_at: timestamp,
    updated_at: timestamp
  };
}

export function transitionRecordingSegment(
  segment: RecordingSegment,
  state: RecordingSegmentState,
  input: {
    owner_epoch: string;
    at?: Date;
    failure_code?: string;
  }
): RecordingSegment {
  assertOwner(segment.owner_epoch, input.owner_epoch);
  if (segment.state === state) return segment;
  if (!SEGMENT_TRANSITIONS[segment.state].includes(state)) {
    throw new Error('recording_segment_transition_invalid');
  }
  const updatedAt = nextTimestamp(input.at ?? new Date(), segment.updated_at);
  return {
    ...segment,
    state,
    failure_code: state === 'failed'
      ? identifier(input.failure_code, 'failure_code')
      : '',
    ended_at: state === 'closed' && segment.ended_at === null
      ? updatedAt
      : segment.ended_at,
    updated_at: updatedAt
  };
}

export function sealRecordingSegment(
  segment: RecordingSegment,
  input: {
    owner_epoch: string;
    size_bytes: number;
    sha256: string;
    ended_at: Date;
  }
): RecordingSegment {
  assertOwner(segment.owner_epoch, input.owner_epoch);
  const sizeBytes = positiveInteger(input.size_bytes, 'size_bytes');
  const sha256 = checksum(input.sha256);
  const endedAt = nextTimestamp(input.ended_at, segment.updated_at);
  if (segment.state === 'closed') {
    if (
      segment.size_bytes === sizeBytes &&
      segment.sha256 === sha256 &&
      segment.ended_at === endedAt
    ) return segment;
    throw new Error('recording_segment_seal_conflict');
  }
  if (segment.state !== 'open') {
    throw new Error('recording_segment_transition_invalid');
  }
  return {
    ...segment,
    state: 'closed',
    size_bytes: sizeBytes,
    sha256,
    ended_at: endedAt,
    updated_at: endedAt
  };
}

export function completeRecordingSegment(
  segment: RecordingSegment,
  input: {
    owner_epoch: string;
    size_bytes: number;
    sha256: string;
    object_ref: string;
    at?: Date;
  }
): RecordingSegment {
  assertOwner(segment.owner_epoch, input.owner_epoch);
  const sizeBytes = nonNegativeInteger(input.size_bytes, 'size_bytes');
  const sha256 = checksum(input.sha256);
  const objectRef = boundedText(input.object_ref, 'object_ref', 2_048);
  if (segment.state === 'uploaded') {
    if (
      segment.size_bytes === sizeBytes &&
      segment.sha256 === sha256 &&
      segment.object_ref === objectRef
    ) return segment;
    throw new Error('recording_segment_completion_conflict');
  }
  if (segment.state !== 'uploading') {
    throw new Error('recording_segment_transition_invalid');
  }
  return {
    ...segment,
    state: 'uploaded',
    size_bytes: sizeBytes,
    sha256,
    object_ref: objectRef,
    failure_code: '',
    updated_at: nextTimestamp(input.at ?? new Date(), segment.updated_at)
  };
}

export function recordingSpoolAdmission(input: {
  used_bytes: number;
  capacity_bytes: number;
  recording_class: 'non_core' | 'must_record';
}): RecordingSpoolAdmission {
  const used = nonNegativeInteger(input.used_bytes, 'used_bytes');
  const capacity = positiveInteger(input.capacity_bytes, 'capacity_bytes');
  if (used > capacity) throw new Error('recording_spool_usage_invalid');
  if (input.recording_class === 'must_record') {
    return used * 100 >= capacity * 90 ? 'reject_must_record' : 'accept';
  }
  return used * 100 >= capacity * 80 ? 'defer_non_core' : 'accept';
}

function assertOwner(expected: string, supplied: string): void {
  if (expected !== ownerEpoch(supplied)) {
    throw new Error('recording_owner_epoch_conflict');
  }
}

function mediaDescriptor(value: RecordingMediaDescriptor): RecordingMediaDescriptor {
  const codecs = value.codecs.map((codec) => identifier(codec, 'codec'));
  if (codecs.length === 0 || codecs.length > 16) {
    throw new Error('recording_media_invalid');
  }
  return {
    container: identifier(value.container, 'container'),
    codecs,
    channels: nullablePositiveInteger(value.channels, 'channels'),
    sample_rate_hz: nullablePositiveInteger(value.sample_rate_hz, 'sample_rate_hz'),
    width: nullablePositiveInteger(value.width ?? null, 'width'),
    height: nullablePositiveInteger(value.height ?? null, 'height'),
    fps: nullablePositiveInteger(value.fps ?? null, 'fps')
  };
}

function jsonRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`recording_${name}_invalid`);
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 16_384) throw new Error(`recording_${name}_invalid`);
  return JSON.parse(encoded) as Record<string, unknown>;
}

function identifier(value: unknown, name: string): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(text)) {
    throw new Error(`recording_${name}_invalid`);
  }
  return text;
}

function boundedText(value: unknown, name: string, max: number): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new Error(`recording_${name}_invalid`);
  }
  return text;
}

function ownerEpoch(value: unknown): string {
  const text = String(value ?? '');
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text)) {
    throw new Error('recording_owner_epoch_invalid');
  }
  return text;
}

function checksum(value: unknown): string {
  const text = String(value ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error('recording_sha256_invalid');
  }
  return text;
}

function positiveInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`recording_${name}_invalid`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`recording_${name}_invalid`);
  }
  return number;
}

function nullablePositiveInteger(value: unknown, name: string): number | null {
  if (value === null || value === undefined) return null;
  return positiveInteger(value, name);
}

function timestampValue(value: unknown, name: string): string {
  const parsed = new Date(String(value ?? ''));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`recording_${name}_invalid`);
  }
  return parsed.toISOString();
}

function validTimestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('recording_timestamp_invalid');
  }
  return value.toISOString();
}

function nextTimestamp(value: Date, previous: string): string {
  const timestamp = validTimestamp(value);
  if (Date.parse(timestamp) < Date.parse(previous)) {
    throw new Error('recording_timestamp_stale');
  }
  return timestamp;
}
