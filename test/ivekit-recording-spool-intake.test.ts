import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  RecordingSpoolIntakeError,
  RecordingSpoolIntakeService,
  RustPbxRecordingSpoolAuthorizer,
  validateRecordingCompletion,
  validateSegmentEvent,
  type RustPbxRecordingSegmentEventV1,
  type RecordingSpoolAuthorization,
  type RecordingSpoolIntakeStore,
  type RecordingSpoolUploadPort
} from '../src/agent-runtime/converact/recordings/recording-spool-intake-service.js';
import type {
  RecordingManifest,
  RecordingSegment
} from '../src/agent-runtime/converact/recordings/recording-manifest.js';
import type {
  RecordingMultipartUpload,
  RecordingSegmentEvent,
  RecordingUploadLease,
  RecordingUploadPart
} from '../src/agent-runtime/converact/recordings/postgres-recording-manifest-store.js';

const NOW = new Date('2026-07-17T06:01:00.000Z');
const FILE = Buffer.from('whole wav file');

test('RustPBX spool authorization binds call, profile, placement owner, policy, and consent', async () => {
  const authorizer = new RustPbxRecordingSpoolAuthorizer({
    calls: {
      async get(tenantId: string, callId: string) {
        assert.equal(tenantId, 'tenant-a');
        assert.equal(callId, 'call-a');
        return call({ provider_profile_id: 'profile-a' });
      }
    } as never,
    configuration: {
      async getPolicy() {
        return policy({ recording_mode: 'consent_required' });
      },
      async listConsents() {
        return {
          items: [{
            id: 'consent-a', tenant_id: 'tenant-a', subject_ref_type: 'call',
            subject_ref_id: 'call-a', business_ref_type: 'order', business_ref_id: 'order-a',
            consent_type: 'recording', status: 'granted', evidence_ref: 'evidence-a',
            granted_by: 'agent-a', expires_at: null,
            created_at: '2026-07-17T05:55:00.000Z', updated_at: '2026-07-17T05:55:00.000Z'
          }],
          next_cursor: null
        };
      }
    } as never,
    placements: {
      async get() {
        return placement();
      }
    }
  });

  const authorized = await authorizer.authorize({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    segment: segmentManifest(),
    now: NOW
  });

  assert.deepEqual(authorized, {
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    interaction_id: 'call-a',
    consent_id: 'consent-a',
    recording_mode: 'policy',
    retention_until: '2026-08-16T06:00:00.000Z'
  });
});

test('RustPBX spool authorization rejects stale owner topology before intake', async () => {
  const authorizer = new RustPbxRecordingSpoolAuthorizer({
    calls: { async get() { return call(); } } as never,
    configuration: {
      async getPolicy() { return policy({ recording_mode: 'always' }); },
      async listConsents() { throw new Error('not expected'); }
    } as never,
    placements: {
      async get() { return placement({ owner_epoch: '8' }); }
    }
  });

  await assert.rejects(
    authorizer.authorize({
      tenant_id: 'tenant-a', profile_id: 'profile-a', segment: segmentManifest(), now: NOW
    }),
    (error: unknown) => error instanceof RecordingSpoolIntakeError
      && error.code === 'recording_spool_owner_conflict'
      && error.status === 409
  );
});

test('recording spool intake registers a sealed segment and reuses its active upload lease', async () => {
  const store = new MemoryIntakeStore();
  const uploads = new MemoryUploadPort(store);
  const service = new RecordingSpoolIntakeService({
    authorizer: {
      async authorize(): Promise<RecordingSpoolAuthorization> {
        return {
          tenant_id: 'tenant-a', profile_id: 'profile-a', interaction_id: 'call-a',
          consent_id: 'policy-a', recording_mode: 'always',
          retention_until: '2026-08-16T06:00:00.000Z'
        };
      },
      async authorizeCompletion() { throw new Error('not expected'); }
    },
    store,
    uploads,
    now: () => NOW
  });
  const request = {
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    segment: segmentManifest(),
    events: [eventManifest()],
    whole_file: { size_bytes: FILE.length, sha256: sha(FILE) },
    worker_id: 'rustpbx-sidecar-a',
    lease_token: 'a'.repeat(64),
    lease_ms: 60_000,
    part_size_bytes: 8 * 1024 * 1024
  };

  const first = await service.initialize(request);
  const replay = await service.initialize(request);

  assert.equal(first.state, 'uploading');
  assert.equal(replay.state, 'uploading');
  if (first.state !== 'uploading' || replay.state !== 'uploading') {
    throw new Error('expected active recording upload');
  }
  assert.equal(first.segment.sha256, sha(FILE));
  assert.equal(first.segment.local_ref, 'spool://vrec-a/segment-000001.wav');
  assert.equal(first.upload.part_size_bytes, 8 * 1024 * 1024);
  assert.equal(first.lease.worker_id, 'rustpbx-sidecar-a');
  assert.equal(replay.lease.lease_token_hash, first.lease.lease_token_hash);
  assert.equal(store.claimCount, 1);
  assert.equal(store.events.length, 1);
  assert.deepEqual(store.events[0], {
    id: store.events[0]?.id,
    tenant_id: 'tenant-a',
    manifest_id: 'vrec-a',
    segment_id: 'vseg-a',
    owner_epoch: '7',
    event_sequence: 1,
    event_type: 'paused',
    policy_source: 'rustpbx_recorder',
    actor_identity: 'rustpbx-a',
    metadata: { interaction_id: 'call-a', reservation_id: 'reservation-a' },
    occurred_at: '2026-07-17T05:59:30.000Z'
  });
  assert.match(store.events[0]?.id || '', /^rsevt_[a-f0-9]{48}$/);
  assert.equal(store.manifest?.state, 'uploading');
  assert.deepEqual(store.manifest?.processing, {
    reservation_id: 'reservation-a',
    segment_format: 'rustpbx_segmented_wav_v1',
    segment_checksum_scope: 'encoded_payload'
  });
});

test('recording spool validates and finalizes an exact owner-bound completion marker', async () => {
  const store = new MemoryIntakeStore();
  const service = new RecordingSpoolIntakeService({
    authorizer: {
      async authorize() { throw new Error('not expected'); },
      async authorizeCompletion(input) {
        assert.equal(input.profile_id, 'profile-a');
        assert.equal(input.completion.recording_id, 'vrec-a');
      }
    },
    store,
    uploads: {} as RecordingSpoolUploadPort,
    now: () => NOW
  });
  store.manifest = recordingManifestRecord();

  const finalized = await service.finalize({
    tenant_id: 'tenant-a',
    profile_id: 'profile-a',
    completion: completionManifest()
  });

  assert.equal(finalized.state, 'uploaded_unverified');
  assert.equal(finalized.ended_at, '2026-07-17T06:00:00.000Z');
  assert.equal(finalized.processing.segment_count, 2);
  assert.throws(
    () => validateRecordingCompletion({ ...completionManifest(), owner_epoch: '08' }, 'vrec-a'),
    (error: unknown) => error instanceof RecordingSpoolIntakeError
      && error.code === 'recording_spool_completion_owner_epoch_invalid'
  );
});

test('recording spool intake rejects an event that is not bound to the segment owner', async () => {
  const service = new RecordingSpoolIntakeService({
    authorizer: {
      async authorize() { throw new Error('authorization must not run'); },
      async authorizeCompletion() { throw new Error('authorization must not run'); }
    },
    store: new MemoryIntakeStore(),
    uploads: {} as RecordingSpoolUploadPort,
    now: () => NOW
  });
  await assert.rejects(
    service.initialize({
      tenant_id: 'tenant-a', profile_id: 'profile-a', segment: segmentManifest(),
      events: [eventManifest({ segment_id: 'vseg-other' })],
      whole_file: { size_bytes: FILE.length, sha256: sha(FILE) },
      worker_id: 'rustpbx-sidecar-a', lease_token: 'a'.repeat(64),
      lease_ms: 60_000, part_size_bytes: 8 * 1024 * 1024
    }),
    (error: unknown) => error instanceof RecordingSpoolIntakeError
      && error.code === 'recording_spool_event_owner_conflict'
  );
});

test('recording spool preserves an exact dropped-sample count only on drop events', () => {
  const event = validateSegmentEvent({
    ...eventManifest(), event_type: 'sample_dropped', dropped_samples: 7
  }, segmentManifest());
  assert.equal(event.dropped_samples, 7);
  assert.throws(
    () => validateSegmentEvent({ ...eventManifest(), event_type: 'sample_dropped' }, segmentManifest()),
    (error: unknown) => error instanceof RecordingSpoolIntakeError
      && error.code === 'recording_spool_event_drop_count_invalid'
  );
});

test('recording spool intake rejects sidecar file metadata drift', async () => {
  const service = new RecordingSpoolIntakeService({
    authorizer: {
      async authorize() { throw new Error('authorization must not run'); },
      async authorizeCompletion() { throw new Error('authorization must not run'); }
    },
    store: new MemoryIntakeStore(),
    uploads: {} as RecordingSpoolUploadPort,
    now: () => NOW
  });
  await assert.rejects(
    service.initialize({
      tenant_id: 'tenant-a', profile_id: 'profile-a', segment: segmentManifest(),
      whole_file: { size_bytes: FILE.length + 1, sha256: sha(FILE) },
      worker_id: 'rustpbx-sidecar-a', lease_token: 'a'.repeat(64),
      lease_ms: 60_000, part_size_bytes: 8 * 1024 * 1024
    }),
    (error: unknown) => error instanceof RecordingSpoolIntakeError
      && error.code === 'recording_spool_file_size_conflict'
  );
});

function segmentManifest() {
  return {
    schema_version: 1 as const,
    recording_id: 'vrec-a',
    segment_id: 'vseg-a',
    interaction_id: 'call-a',
    reservation_id: 'reservation-a',
    owner_epoch: '7',
    region_id: 'region-a',
    zone_id: 'zone-a',
    cell_id: 'cell-a',
    recorder_node_id: 'rustpbx-a',
    sequence: 1,
    track_id: 'mixed',
    payload_filename: 'segment-000001.wav',
    container: 'wav',
    codec: 'PCMU',
    channels: 1,
    sample_rate_hz: 8_000,
    size_bytes: FILE.length,
    encoded_payload_bytes: 12,
    encoded_payload_sha256: 'b'.repeat(64),
    checksum_scope: 'encoded_payload' as const,
    written_samples: 8_000,
    started_at: Date.parse('2026-07-17T05:59:00.000Z'),
    ended_at: Date.parse('2026-07-17T06:00:00.000Z')
  };
}

function completionManifest() {
  return {
    schema_version: 1 as const,
    recording_id: 'vrec-a', interaction_id: 'call-a', reservation_id: 'reservation-a',
    owner_epoch: '7', region_id: 'region-a', zone_id: 'zone-a', cell_id: 'cell-a',
    recorder_node_id: 'rustpbx-a', segment_count: 2, last_segment_sequence: 2,
    ended_at: Date.parse('2026-07-17T06:00:00.000Z')
  };
}

function recordingManifestRecord(): RecordingManifest {
  return {
    id: 'vrec-a', tenant_id: 'tenant-a', interaction_id: 'call-a',
    interaction_kind: 'sip_voice', owner_epoch: '7', source: 'sip_voice',
    state: 'uploading', consent_id: 'policy-a', recording_mode: 'always',
    retention_until: '2026-08-16T06:00:00.000Z', legal_hold: false,
    region_id: 'region-a', zone_id: 'zone-a', cell_id: 'cell-a',
    recorder_node_id: 'rustpbx-a',
    media: { container: 'wav', codecs: ['PCMU'], channels: 1, sample_rate_hz: 8000 },
    processing: {
      reservation_id: 'reservation-a', segment_format: 'rustpbx_segmented_wav_v1',
      segment_checksum_scope: 'encoded_payload'
    },
    object_ref: '', failure_code: '', started_at: '2026-07-17T05:58:00.000Z',
    ended_at: '2026-07-17T05:59:00.000Z', created_at: '2026-07-17T05:58:00.000Z',
    updated_at: '2026-07-17T05:59:00.000Z'
  };
}

function eventManifest(
  overrides: Partial<RustPbxRecordingSegmentEventV1> = {}
): RustPbxRecordingSegmentEventV1 {
  return {
    schema_version: 1 as const,
    recording_id: 'vrec-a',
    segment_id: 'vseg-a',
    interaction_id: 'call-a',
    reservation_id: 'reservation-a',
    owner_epoch: '7',
    event_sequence: 1,
    event_type: 'paused',
    occurred_at: Date.parse('2026-07-17T05:59:30.000Z'),
    ...overrides
  };
}

function call(overrides: Record<string, unknown> = {}) {
  return {
    id: 'call-a', tenant_id: 'tenant-a', business_ref: { type: 'order', id: 'order-a' },
    provider_profile_id: 'profile-a', provider_call_id: 'provider-call-a',
    provider_dialog_id: '', media_call_id: null, direction: 'inbound', state: 'completed',
    from: { kind: 'e164', redacted: '+86******0000' },
    to: { kind: 'extension', redacted: '1000' }, idempotency_key: 'call-a',
    initiated_by: 'system', metadata: {}, ringing_at: null, answered_at: null,
    ended_at: '2026-07-17T06:00:00.000Z', termination_reason: 'normal', revision: 1,
    created_at: '2026-07-17T05:58:00.000Z', updated_at: '2026-07-17T06:00:00.000Z',
    ...overrides
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-a', tenant_id: 'tenant-a', require_outbound_consent: false,
    recording_mode: 'always', recording_retention_days: 30, require_ai_disclosure: false,
    allowed_calling_windows: [], masking_policy: {}, status: 'active', revision: 1,
    created_by: 'system', updated_by: 'system',
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

function placement(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-a', interaction_id: 'call-a', interaction_kind: 'sip_voice',
    profile_id: 'profile-a', reservation_id: 'reservation-a', owner_epoch: '7',
    region_id: 'region-a', zone_id: 'zone-a', cell_id: 'cell-a',
    owner_node_id: 'rustpbx-a', state: 'closed',
    ...overrides
  };
}

function sha(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

class MemoryIntakeStore implements RecordingSpoolIntakeStore {
  manifest: RecordingManifest | null = null;
  segment: RecordingSegment | null = null;
  lease: RecordingUploadLease | null = null;
  claimCount = 0;
  events: RecordingSegmentEvent[] = [];

  async createManifest(input: RecordingManifest) {
    if (!this.manifest) this.manifest = structuredClone(input);
    return { manifest: structuredClone(this.manifest), created: this.manifest === input };
  }

  async registerSegment(input: RecordingSegment) {
    const created = !this.segment;
    if (!this.segment) this.segment = structuredClone(input);
    return { segment: structuredClone(this.segment), created };
  }

  async getSegment() {
    return this.segment ? structuredClone(this.segment) : null;
  }

  async appendSegmentEvent(input: RecordingSegmentEvent) {
    const existing = this.events.find((event) =>
      event.segment_id === input.segment_id && event.event_sequence === input.event_sequence
    );
    if (existing) return { event: structuredClone(existing), created: false };
    this.events.push(structuredClone(input));
    return { event: structuredClone(input), created: true };
  }

  async finalizeManifest(input: {
    tenant_id: string; manifest_id: string; owner_epoch: string;
    interaction_id: string; reservation_id: string; region_id: string;
    zone_id: string; cell_id: string; recorder_node_id: string;
    segment_count: number; last_segment_sequence: number; ended_at: Date; now: Date;
  }) {
    assert.equal(input.owner_epoch, '7');
    assert.equal(input.segment_count, 2);
    this.manifest = {
      ...this.manifest!, state: 'uploaded_unverified',
      ended_at: input.ended_at.toISOString(), updated_at: input.now.toISOString(),
      object_ref: `recording-intake://${input.manifest_id}`,
      processing: {
        ...this.manifest!.processing,
        segment_count: input.segment_count,
        last_segment_sequence: input.last_segment_sequence
      }
    };
    return structuredClone(this.manifest);
  }

  async claimSegment(input: {
    tenant_id: string; segment_id: string; worker_id: string;
    lease_token_hash: string; now: Date; lease_ms: number;
  }) {
    this.claimCount += 1;
    this.segment = { ...this.segment!, state: 'uploading', updated_at: input.now.toISOString() };
    this.lease = {
      tenant_id: input.tenant_id, segment_id: input.segment_id, worker_id: input.worker_id,
      lease_token_hash: input.lease_token_hash, state: 'leased', attempt_count: 1,
      max_attempts: 20,
      lease_expires_at: new Date(input.now.getTime() + input.lease_ms).toISOString(),
      next_attempt_at: null, last_error_code: '', last_error_message: '',
      created_at: input.now.toISOString(), updated_at: input.now.toISOString()
    };
    return { segment: structuredClone(this.segment), lease: structuredClone(this.lease) };
  }

  async assertActiveLease(input: { lease_token_hash: string }) {
    if (!this.segment || !this.lease || this.lease.lease_token_hash !== input.lease_token_hash) {
      throw Object.assign(new Error('recording_segment_lease_conflict'), {
        code: 'recording_segment_lease_conflict'
      });
    }
    return { segment: structuredClone(this.segment), lease: structuredClone(this.lease) };
  }
}

class MemoryUploadPort implements RecordingSpoolUploadPort {
  private upload: RecordingMultipartUpload | null = null;

  constructor(private readonly store: MemoryIntakeStore) {}

  async ensureMultipart(input: {
    tenant_id: string; segment_id: string; part_size_bytes: number; now: Date;
  }) {
    if (!this.upload) {
      this.upload = {
        tenant_id: input.tenant_id, segment_id: input.segment_id, upload_id: 'upload-a',
        object_key: 'recording-segments/vseg-a', storage_url: 's3://recordings/vseg-a',
        part_size_bytes: input.part_size_bytes, state: 'initiated',
        created_at: input.now.toISOString(), updated_at: input.now.toISOString(), completed_at: null
      };
    }
    return structuredClone(this.upload);
  }

  async listParts(): Promise<RecordingUploadPart[]> {
    assert.equal(this.store.segment?.state, 'uploading');
    return [];
  }

  async uploadPart(): Promise<RecordingUploadPart> { throw new Error('not used'); }
  async complete(): Promise<never> { throw new Error('not used'); }
}
