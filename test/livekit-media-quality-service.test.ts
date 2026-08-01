import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MediaQualityService,
  type MediaQualityStorePort
} from '../src/agent-runtime/livekit/media-quality-service.js';
import type {
  ConveractFabricMediaConnectionEvent,
  ConveractFabricMediaQualityParticipantState,
  ConveractFabricMediaQualitySnapshot,
  ConveractFabricMediaQualitySummary
} from '../src/agent-runtime/livekit/types.js';

const now = new Date('2026-07-15T08:00:00.000Z');

test('QoS degradation and recovery require consecutive new samples', async () => {
  const store = new FakeMediaQualityStore();
  const transitions: string[] = [];
  const service = new MediaQualityService(store, {
    now: () => now,
    degraded_samples: 2,
    recovery_samples: 2,
    onQualityTransition: (transition) => {
      transitions.push(transition.event_type);
    }
  });

  const bad1 = await service.reportQuality({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    snapshots: [sample('sample-bad-1', { packet_loss_ratio: 0.08 })]
  });
  assert.equal(bad1.transitions.length, 0);
  assert.equal(bad1.participant_states[0]?.quality_state, 'unknown');

  const bad2 = await service.reportQuality({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    snapshots: [sample('sample-bad-2', { rtt_ms: 500 })]
  });
  assert.deepEqual(bad2.transitions.map((item) => item.event_type), ['degraded']);
  assert.equal(bad2.participant_states[0]?.quality_state, 'degraded');

  const replay = await service.reportQuality({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    snapshots: [sample('sample-bad-2', { rtt_ms: 500 })]
  });
  assert.equal(replay.accepted, 0);
  assert.equal(replay.replayed, 1);
  assert.equal(replay.transitions.length, 0);

  await service.reportQuality({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    snapshots: [sample('sample-good-1')]
  });
  const recovered = await service.reportQuality({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    snapshots: [sample('sample-good-2')]
  });
  assert.deepEqual(recovered.transitions.map((item) => item.event_type), ['recovered']);
  assert.equal(recovered.participant_states[0]?.quality_state, 'good');
  assert.deepEqual(transitions, ['degraded', 'recovered']);
});

test('connection revisions are monotonic while an old event remains idempotently replayable', async () => {
  const store = new FakeMediaQualityStore();
  const observed: string[] = [];
  const service = new MediaQualityService(store, {
    now: () => now,
    onConnectionEvent: (result) => {
      observed.push(result.event.event_type);
    }
  });

  const connected = await service.reportConnectionEvent({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    event: connection('event-connected', 1, 'connected', '2026-07-15T07:59:00.000Z')
  });
  assert.equal(connected.participant_state.connection_state, 'connected');

  const rejoining = await service.reportConnectionEvent({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    event: connection('event-rejoining', 2, 'rejoining', '2026-07-15T07:59:30.000Z')
  });
  assert.equal(rejoining.participant_state.connection_revision, 2);
  assert.equal(rejoining.participant_state.connection_state, 'rejoining');

  await assert.rejects(
    () => service.reportConnectionEvent({
      tenant_id: 'tenant_media_quality',
      call_id: 'call_quality',
      event: connection('event-stale', 1, 'disconnected', '2026-07-15T07:59:45.000Z')
    }),
    (error: Error & { status?: number }) => error.status === 409
  );

  const replay = await service.reportConnectionEvent({
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    event: connection('event-connected', 1, 'connected', '2026-07-15T07:59:00.000Z')
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.participant_state.connection_revision, 2);
  assert.deepEqual(observed, ['connected', 'rejoining']);
});

test('QoS and connection payloads reject out-of-range and sensitive fields', async () => {
  const service = new MediaQualityService(new FakeMediaQualityStore(), { now: () => now });
  await assert.rejects(
    () => service.reportQuality({
      tenant_id: 'tenant_media_quality',
      call_id: 'call_quality',
      snapshots: [{ ...sample('invalid-loss'), packet_loss_ratio: 1.1 }]
    }),
    (error: Error & { status?: number }) => error.status === 400
  );
  await assert.rejects(
    () => service.reportQuality({
      tenant_id: 'tenant_media_quality',
      call_id: 'call_quality',
      snapshots: [{ ...sample('sensitive'), sdp: 'v=0 secret endpoint' } as never]
    }),
    (error: Error & { status?: number }) => error.status === 400
  );
  await assert.rejects(
    () => service.reportConnectionEvent({
      tenant_id: 'tenant_media_quality',
      call_id: 'call_quality',
      event: { ...connection('sensitive-event', 1, 'connected'), ice_candidate: 'candidate:private' } as never
    }),
    (error: Error & { status?: number }) => error.status === 400
  );
});

function sample(
  sampleId: string,
  override: Record<string, unknown> = {}
) {
  return {
    participant_identity: 'customer-1',
    connection_revision: 1,
    sample_id: sampleId,
    track_source: 'camera' as const,
    quality_level: 'good' as const,
    rtt_ms: 80,
    jitter_ms: 12,
    packet_loss_ratio: 0.01,
    bitrate_bps: 1_500_000,
    quality_score: 4.2,
    sampled_at: '2026-07-15T07:59:50.000Z',
    ...override
  };
}

function connection(
  eventId: string,
  revision: number,
  eventType: 'connected' | 'rejoining' | 'disconnected',
  occurredAt = '2026-07-15T07:59:50.000Z'
) {
  return {
    participant_identity: 'customer-1',
    event_id: eventId,
    connection_revision: revision,
    event_type: eventType,
    reason_code: 'network_change',
    occurred_at: occurredAt
  };
}

class FakeMediaQualityStore implements MediaQualityStorePort {
  private participant: ConveractFabricMediaQualityParticipantState = {
    tenant_id: 'tenant_media_quality',
    call_id: 'call_quality',
    identity: 'customer-1',
    participant_status: 'joined',
    connection_revision: 0,
    connection_state: 'disconnected',
    connection_updated_at: null,
    last_disconnected_at: null,
    last_rejoined_at: null,
    quality_state: 'unknown',
    quality_degraded_streak: 0,
    quality_recovered_streak: 0,
    last_quality_level: 'unknown',
    last_quality_sample_id: '',
    last_qos_at: null
  };
  private readonly snapshots = new Map<string, { value: ConveractFabricMediaQualitySnapshot; payloadHash: string }>();
  private readonly events = new Map<string, { value: ConveractFabricMediaConnectionEvent; payloadHash: string }>();

  transaction<T>(_tenantId: string, fn: (store: MediaQualityStorePort) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async getParticipantForUpdate() {
    return { ...this.participant };
  }

  async insertQualitySnapshot(input: Parameters<MediaQualityStorePort['insertQualitySnapshot']>[0]) {
    const key = [
      input.tenant_id,
      input.call_id,
      input.participant_identity,
      input.connection_revision,
      input.sample_id,
      input.track_source
    ].join(':');
    const existing = this.snapshots.get(key);
    if (existing) {
      if (existing.payloadHash !== input.payload_hash) throw conflict();
      return { snapshot: existing.value, replayed: true };
    }
    const value: ConveractFabricMediaQualitySnapshot = {
      ...input,
      id: `qos-${this.snapshots.size + 1}`,
      received_at: now.toISOString()
    };
    this.snapshots.set(key, { value, payloadHash: input.payload_hash });
    return { snapshot: value, replayed: false };
  }

  async updateParticipantQuality(
    input: Parameters<MediaQualityStorePort['updateParticipantQuality']>[0]
  ) {
    this.participant = { ...this.participant, ...input };
    return { ...this.participant };
  }

  async getConnectionEvent(input: Parameters<MediaQualityStorePort['getConnectionEvent']>[0]) {
    return this.events.get(input.event_id) || null;
  }

  async insertConnectionEvent(input: Parameters<MediaQualityStorePort['insertConnectionEvent']>[0]) {
    const value: ConveractFabricMediaConnectionEvent = {
      ...input,
      id: `connection-${this.events.size + 1}`,
      received_at: now.toISOString()
    };
    this.events.set(input.event_id, { value, payloadHash: input.payload_hash });
    return value;
  }

  async updateParticipantConnection(
    input: Parameters<MediaQualityStorePort['updateParticipantConnection']>[0]
  ) {
    this.participant = { ...this.participant, ...input };
    return { ...this.participant };
  }

  async getQualitySummary(): Promise<ConveractFabricMediaQualitySummary | null> {
    return {
      tenant_id: this.participant.tenant_id,
      call_id: this.participant.call_id,
      generated_at: now.toISOString(),
      participants: [{ ...this.participant }],
      recent_snapshots: [...this.snapshots.values()].map((item) => item.value)
    };
  }

  async pruneQualitySnapshots(): Promise<number> {
    const count = this.snapshots.size;
    this.snapshots.clear();
    return count;
  }
}

function conflict(): Error & { status: number } {
  return Object.assign(new Error('payload conflict'), { status: 409 });
}
