import { resolveConveractEnv } from '../../config/converact-env.js';
import { createHash } from 'node:crypto';

import type {
  ConveractFabricMediaConnectionEvent,
  ConveractFabricMediaConnectionEventInput,
  ConveractFabricMediaConnectionEventResult,
  ConveractFabricMediaConnectionState,
  ConveractFabricMediaQualityLevel,
  ConveractFabricMediaQualityParticipantState,
  ConveractFabricMediaQualityReportResult,
  ConveractFabricMediaQualitySnapshot,
  ConveractFabricMediaQualitySnapshotInput,
  ConveractFabricMediaQualityState,
  ConveractFabricMediaQualitySummary,
  ConveractFabricMediaQualityTransition
} from './types.js';

const QUALITY_SNAPSHOT_KEYS = new Set([
  'participant_identity',
  'connection_revision',
  'sample_id',
  'track_source',
  'quality_level',
  'rtt_ms',
  'jitter_ms',
  'packet_loss_ratio',
  'bitrate_bps',
  'quality_score',
  'sampled_at'
]);
const CONNECTION_EVENT_KEYS = new Set([
  'participant_identity',
  'event_id',
  'connection_revision',
  'event_type',
  'reason_code',
  'occurred_at'
]);
const TRACK_SOURCES = new Set(['camera', 'microphone', 'screen_share', 'screen_share_audio']);
const QUALITY_LEVELS = new Set(['excellent', 'good', 'poor', 'lost', 'unknown']);
const CONNECTION_EVENT_TYPES = new Set([
  'connected',
  'reconnecting',
  'reconnected',
  'disconnected',
  'rejoining',
  'rejoined',
  'failed'
]);
const QUALITY_PARTICIPANT_STATUSES = new Set(['accepted', 'joined']);

export interface MediaQualityStorePort {
  transaction<T>(
    tenantId: string,
    fn: (store: MediaQualityStorePort) => Promise<T>
  ): Promise<T>;
  getParticipantForUpdate(input: {
    tenant_id: string;
    call_id: string;
    identity: string;
  }): Promise<ConveractFabricMediaQualityParticipantState | null>;
  insertQualitySnapshot(input: ConveractFabricMediaQualitySnapshotInput & {
    tenant_id: string;
    call_id: string;
    payload_hash: string;
    retention_until: string;
  }): Promise<{ snapshot: ConveractFabricMediaQualitySnapshot; replayed: boolean }>;
  updateParticipantQuality(input: {
    tenant_id: string;
    call_id: string;
    identity: string;
    connection_revision: number;
    quality_state: ConveractFabricMediaQualityState;
    quality_degraded_streak: number;
    quality_recovered_streak: number;
    last_quality_level: ConveractFabricMediaQualityLevel;
    last_quality_sample_id: string;
    last_qos_at: string;
  }): Promise<ConveractFabricMediaQualityParticipantState>;
  getConnectionEvent(input: {
    tenant_id: string;
    call_id: string;
    participant_identity: string;
    event_id: string;
  }): Promise<{ value: ConveractFabricMediaConnectionEvent; payloadHash: string } | null>;
  insertConnectionEvent(input: ConveractFabricMediaConnectionEventInput & {
    tenant_id: string;
    call_id: string;
    reason_code: string;
    connection_state: ConveractFabricMediaConnectionState;
    payload_hash: string;
  }): Promise<ConveractFabricMediaConnectionEvent>;
  updateParticipantConnection(input: {
    tenant_id: string;
    call_id: string;
    identity: string;
    connection_revision: number;
    connection_state: ConveractFabricMediaConnectionState;
    connection_updated_at: string;
    last_disconnected_at: string | null;
    last_rejoined_at: string | null;
  }): Promise<ConveractFabricMediaQualityParticipantState>;
  getQualitySummary(input: {
    tenant_id: string;
    call_id: string;
    limit: number;
    generated_at: string;
  }): Promise<ConveractFabricMediaQualitySummary | null>;
  pruneQualitySnapshots(input: {
    tenant_id: string;
    before: string;
    limit: number;
  }): Promise<number>;
}

export interface MediaQualityServiceOptions {
  now?: () => Date;
  degraded_samples?: number;
  recovery_samples?: number;
  degraded_rtt_ms?: number;
  degraded_jitter_ms?: number;
  degraded_packet_loss_ratio?: number;
  degraded_quality_score?: number;
  retention_ms?: number;
  max_sample_age_ms?: number;
  max_event_age_ms?: number;
  max_future_skew_ms?: number;
  onQualityTransition?: (transition: ConveractFabricMediaQualityTransition) => void | Promise<void>;
  onConnectionEvent?: (result: ConveractFabricMediaConnectionEventResult) => void | Promise<void>;
}

export function mediaQualityServiceOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): MediaQualityServiceOptions {
  return compactOptions({
    degraded_samples: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_DEGRADED_SAMPLES'),
    recovery_samples: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_RECOVERY_SAMPLES'),
    degraded_rtt_ms: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_DEGRADED_RTT_MS'),
    degraded_jitter_ms: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_DEGRADED_JITTER_MS'),
    degraded_packet_loss_ratio: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_DEGRADED_PACKET_LOSS_RATIO'),
    degraded_quality_score: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_DEGRADED_QUALITY_SCORE'),
    retention_ms: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_RETENTION_MS'),
    max_sample_age_ms: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_MAX_SAMPLE_AGE_MS'),
    max_event_age_ms: optionalEnvNumber(env, 'CONVERACT_MEDIA_CONNECTION_MAX_EVENT_AGE_MS'),
    max_future_skew_ms: optionalEnvNumber(env, 'CONVERACT_MEDIA_QOS_MAX_FUTURE_SKEW_MS')
  });
}

interface NormalizedQualitySnapshot extends ConveractFabricMediaQualitySnapshotInput {
  rtt_ms: number | null;
  jitter_ms: number | null;
  packet_loss_ratio: number | null;
  bitrate_bps: number | null;
  quality_score: number | null;
}

export class MediaQualityService {
  private readonly now: () => Date;
  private readonly degradedSamples: number;
  private readonly recoverySamples: number;
  private readonly degradedRttMs: number;
  private readonly degradedJitterMs: number;
  private readonly degradedPacketLossRatio: number;
  private readonly degradedQualityScore: number;
  private readonly retentionMs: number;
  private readonly maxSampleAgeMs: number;
  private readonly maxEventAgeMs: number;
  private readonly maxFutureSkewMs: number;

  constructor(
    private readonly store: MediaQualityStorePort,
    private readonly options: MediaQualityServiceOptions = {}
  ) {
    this.now = options.now || (() => new Date());
    this.degradedSamples = boundedInteger(options.degraded_samples ?? 3, 1, 20, 'degraded_samples');
    this.recoverySamples = boundedInteger(options.recovery_samples ?? 3, 1, 20, 'recovery_samples');
    this.degradedRttMs = boundedNumber(options.degraded_rtt_ms ?? 300, 1, 60_000, 'degraded_rtt_ms');
    this.degradedJitterMs = boundedNumber(options.degraded_jitter_ms ?? 60, 1, 10_000, 'degraded_jitter_ms');
    this.degradedPacketLossRatio = boundedNumber(
      options.degraded_packet_loss_ratio ?? 0.05,
      0,
      1,
      'degraded_packet_loss_ratio'
    );
    this.degradedQualityScore = boundedNumber(
      options.degraded_quality_score ?? 2.5,
      0,
      5,
      'degraded_quality_score'
    );
    this.retentionMs = boundedInteger(options.retention_ms ?? 7 * 24 * 60 * 60_000, 60_000, 90 * 24 * 60 * 60_000, 'retention_ms');
    this.maxSampleAgeMs = boundedInteger(options.max_sample_age_ms ?? 5 * 60_000, 1_000, 24 * 60 * 60_000, 'max_sample_age_ms');
    this.maxEventAgeMs = boundedInteger(options.max_event_age_ms ?? 24 * 60 * 60_000, 1_000, 30 * 24 * 60 * 60_000, 'max_event_age_ms');
    this.maxFutureSkewMs = boundedInteger(options.max_future_skew_ms ?? 30_000, 0, 5 * 60_000, 'max_future_skew_ms');
  }

  async reportQuality(input: {
    tenant_id: string;
    call_id: string;
    snapshots: ConveractFabricMediaQualitySnapshotInput[];
  }): Promise<ConveractFabricMediaQualityReportResult> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id', 255);
    const callId = requiredText(input.call_id, 'call_id', 255);
    if (!Array.isArray(input.snapshots) || input.snapshots.length < 1 || input.snapshots.length > 100) {
      throw badRequest('snapshots must contain between 1 and 100 items');
    }
    const receivedAt = this.now();
    const snapshots = input.snapshots.map((snapshot) => normalizeSnapshot(
      snapshot,
      receivedAt,
      this.maxSampleAgeMs,
      this.maxFutureSkewMs
    ));
    const groups = groupSnapshots(snapshots);
    const result = await this.store.transaction(tenantId, async (store) => {
      let accepted = 0;
      let replayed = 0;
      const transitions: ConveractFabricMediaQualityTransition[] = [];
      const participantStates = new Map<string, ConveractFabricMediaQualityParticipantState>();

      for (const group of groups) {
        let participant = await store.getParticipantForUpdate({
          tenant_id: tenantId,
          call_id: callId,
          identity: group[0].participant_identity
        });
        requireActiveParticipant(participant);
        if (group[0].connection_revision < participant.connection_revision) {
          throw conflict('connection_revision is stale');
        }

        let inserted = 0;
        for (const snapshot of group) {
          const stored = await store.insertQualitySnapshot({
            tenant_id: tenantId,
            call_id: callId,
            ...snapshot,
            payload_hash: qualityPayloadHash(snapshot),
            retention_until: new Date(receivedAt.getTime() + this.retentionMs).toISOString()
          });
          if (stored.replayed) replayed += 1;
          else {
            accepted += 1;
            inserted += 1;
          }
        }

        const sampleId = group[0].sample_id;
        if (inserted > 0 && participant.last_quality_sample_id !== sampleId) {
          const newRevision = group[0].connection_revision > participant.connection_revision;
          const base = newRevision ? resetQualityForRevision(participant) : participant;
          const qualityLevel = worstQualityLevel(group.map((item) => item.quality_level));
          const degraded = group.some((snapshot) => this.isDegraded(snapshot));
          const observation = nextQualityState(base, degraded, this.degradedSamples, this.recoverySamples);
          participant = await store.updateParticipantQuality({
            tenant_id: tenantId,
            call_id: callId,
            identity: participant.identity,
            connection_revision: group[0].connection_revision,
            quality_state: observation.state,
            quality_degraded_streak: observation.degradedStreak,
            quality_recovered_streak: observation.recoveredStreak,
            last_quality_level: qualityLevel,
            last_quality_sample_id: sampleId,
            last_qos_at: group[0].sampled_at
          });
          if (observation.eventType) {
            transitions.push({
              tenant_id: tenantId,
              call_id: callId,
              participant_identity: participant.identity,
              connection_revision: group[0].connection_revision,
              from: base.quality_state,
              to: observation.state as 'good' | 'degraded',
              event_type: observation.eventType,
              quality_level: qualityLevel,
              sampled_at: group[0].sampled_at
            });
          }
        }
        participantStates.set(participant.identity, participant);
      }

      return {
        accepted,
        replayed,
        participant_states: [...participantStates.values()],
        transitions
      };
    });
    for (const transition of result.transitions) {
      await this.options.onQualityTransition?.(transition);
    }
    return result;
  }

  async reportConnectionEvent(input: {
    tenant_id: string;
    call_id: string;
    event: ConveractFabricMediaConnectionEventInput;
  }): Promise<ConveractFabricMediaConnectionEventResult> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id', 255);
    const callId = requiredText(input.call_id, 'call_id', 255);
    const event = normalizeConnectionEvent(
      input.event,
      this.now(),
      this.maxEventAgeMs,
      this.maxFutureSkewMs
    );
    const payloadHash = connectionPayloadHash(event);
    const result = await this.store.transaction(tenantId, async (store) => {
      let participant = await store.getParticipantForUpdate({
        tenant_id: tenantId,
        call_id: callId,
        identity: event.participant_identity
      });
      requireActiveParticipant(participant);
      const existing = await store.getConnectionEvent({
        tenant_id: tenantId,
        call_id: callId,
        participant_identity: event.participant_identity,
        event_id: event.event_id
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw conflict('event_id payload conflict');
        return { event: existing.value, participant_state: participant, replayed: true };
      }
      if (event.connection_revision < participant.connection_revision) {
        throw conflict('connection_revision is stale');
      }
      if (
        event.connection_revision === participant.connection_revision
        && participant.connection_updated_at
        && Date.parse(event.occurred_at) < Date.parse(participant.connection_updated_at)
      ) {
        throw conflict('connection event occurred_at is stale');
      }
      const connectionState = connectionStateForEvent(event.event_type);
      const storedEvent = await store.insertConnectionEvent({
        tenant_id: tenantId,
        call_id: callId,
        ...event,
        reason_code: event.reason_code || '',
        connection_state: connectionState,
        payload_hash: payloadHash
      });
      participant = await store.updateParticipantConnection({
        tenant_id: tenantId,
        call_id: callId,
        identity: event.participant_identity,
        connection_revision: event.connection_revision,
        connection_state: connectionState,
        connection_updated_at: event.occurred_at,
        last_disconnected_at: event.event_type === 'disconnected'
          ? event.occurred_at
          : participant.last_disconnected_at,
        last_rejoined_at: event.event_type === 'rejoined' || event.event_type === 'reconnected'
          ? event.occurred_at
          : participant.last_rejoined_at
      });
      return { event: storedEvent, participant_state: participant, replayed: false };
    });
    if (!result.replayed) await this.options.onConnectionEvent?.(result);
    return result;
  }

  getSummary(input: {
    tenant_id: string;
    call_id: string;
    limit?: number;
  }): Promise<ConveractFabricMediaQualitySummary | null> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id', 255);
    const callId = requiredText(input.call_id, 'call_id', 255);
    const generatedAt = this.now().toISOString();
    return this.store.transaction(tenantId, (store) => store.getQualitySummary({
      tenant_id: tenantId,
      call_id: callId,
      limit: boundedInteger(input.limit ?? 100, 1, 500, 'limit'),
      generated_at: generatedAt
    }));
  }

  prune(input: { tenant_id: string; before?: string; limit?: number }): Promise<number> {
    const tenantId = requiredText(input.tenant_id, 'tenant_id', 255);
    const before = input.before
      ? boundedTimestamp(input.before, this.now(), 365 * 24 * 60 * 60_000, this.maxFutureSkewMs, 'before')
      : this.now().toISOString();
    return this.store.transaction(tenantId, (store) => store.pruneQualitySnapshots({
      tenant_id: tenantId,
      before,
      limit: boundedInteger(input.limit ?? 1_000, 1, 10_000, 'limit')
    }));
  }

  private isDegraded(snapshot: NormalizedQualitySnapshot): boolean {
    return snapshot.quality_level === 'poor'
      || snapshot.quality_level === 'lost'
      || (snapshot.rtt_ms != null && snapshot.rtt_ms >= this.degradedRttMs)
      || (snapshot.jitter_ms != null && snapshot.jitter_ms >= this.degradedJitterMs)
      || (
        snapshot.packet_loss_ratio != null
        && snapshot.packet_loss_ratio >= this.degradedPacketLossRatio
      )
      || (
        snapshot.quality_score != null
        && snapshot.quality_score <= this.degradedQualityScore
      );
  }
}

function normalizeSnapshot(
  value: ConveractFabricMediaQualitySnapshotInput,
  now: Date,
  maxAgeMs: number,
  maxFutureSkewMs: number
): NormalizedQualitySnapshot {
  const record = objectRecord(value, 'snapshot');
  assertAllowedKeys(record, QUALITY_SNAPSHOT_KEYS, 'snapshot');
  const trackSource = requiredText(record.track_source, 'track_source', 64);
  if (!TRACK_SOURCES.has(trackSource)) throw badRequest('track_source is invalid');
  const qualityLevel = requiredText(record.quality_level, 'quality_level', 32);
  if (!QUALITY_LEVELS.has(qualityLevel)) throw badRequest('quality_level is invalid');
  return {
    participant_identity: requiredText(record.participant_identity, 'participant_identity', 255),
    connection_revision: boundedInteger(record.connection_revision, 1, Number.MAX_SAFE_INTEGER, 'connection_revision'),
    sample_id: requiredText(record.sample_id, 'sample_id', 128),
    track_source: trackSource as NormalizedQualitySnapshot['track_source'],
    quality_level: qualityLevel as ConveractFabricMediaQualityLevel,
    rtt_ms: optionalBoundedNumber(record.rtt_ms, 0, 60_000, 'rtt_ms'),
    jitter_ms: optionalBoundedNumber(record.jitter_ms, 0, 10_000, 'jitter_ms'),
    packet_loss_ratio: optionalBoundedNumber(record.packet_loss_ratio, 0, 1, 'packet_loss_ratio'),
    bitrate_bps: optionalBoundedInteger(record.bitrate_bps, 0, 1_000_000_000, 'bitrate_bps'),
    quality_score: optionalBoundedNumber(record.quality_score, 0, 5, 'quality_score'),
    sampled_at: boundedTimestamp(record.sampled_at, now, maxAgeMs, maxFutureSkewMs, 'sampled_at')
  };
}

function normalizeConnectionEvent(
  value: ConveractFabricMediaConnectionEventInput,
  now: Date,
  maxAgeMs: number,
  maxFutureSkewMs: number
): ConveractFabricMediaConnectionEventInput & { reason_code: string } {
  const record = objectRecord(value, 'event');
  assertAllowedKeys(record, CONNECTION_EVENT_KEYS, 'event');
  const eventType = requiredText(record.event_type, 'event_type', 32);
  if (!CONNECTION_EVENT_TYPES.has(eventType)) throw badRequest('event_type is invalid');
  const reasonCode = optionalText(record.reason_code, 'reason_code', 128);
  if (reasonCode && !/^[a-zA-Z0-9_.:-]+$/.test(reasonCode)) {
    throw badRequest('reason_code contains unsupported characters');
  }
  return {
    participant_identity: requiredText(record.participant_identity, 'participant_identity', 255),
    event_id: requiredText(record.event_id, 'event_id', 128),
    connection_revision: boundedInteger(record.connection_revision, 1, Number.MAX_SAFE_INTEGER, 'connection_revision'),
    event_type: eventType as ConveractFabricMediaConnectionEventInput['event_type'],
    reason_code: reasonCode,
    occurred_at: boundedTimestamp(record.occurred_at, now, maxAgeMs, maxFutureSkewMs, 'occurred_at')
  };
}

function groupSnapshots(snapshots: NormalizedQualitySnapshot[]): NormalizedQualitySnapshot[][] {
  const groups = new Map<string, NormalizedQualitySnapshot[]>();
  for (const snapshot of snapshots) {
    const key = [
      snapshot.participant_identity,
      snapshot.connection_revision,
      snapshot.sample_id,
      snapshot.sampled_at
    ].join('\u0000');
    const group = groups.get(key) || [];
    if (group.some((item) => item.track_source === snapshot.track_source)) {
      throw badRequest('duplicate track_source in one QoS sample');
    }
    group.push(snapshot);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function nextQualityState(
  participant: ConveractFabricMediaQualityParticipantState,
  degraded: boolean,
  degradedSamples: number,
  recoverySamples: number
): {
  state: ConveractFabricMediaQualityState;
  degradedStreak: number;
  recoveredStreak: number;
  eventType: 'degraded' | 'recovered' | null;
} {
  if (degraded) {
    const degradedStreak = participant.quality_degraded_streak + 1;
    if (participant.quality_state !== 'degraded' && degradedStreak >= degradedSamples) {
      return { state: 'degraded', degradedStreak, recoveredStreak: 0, eventType: 'degraded' };
    }
    return {
      state: participant.quality_state,
      degradedStreak,
      recoveredStreak: 0,
      eventType: null
    };
  }
  const recoveredStreak = participant.quality_recovered_streak + 1;
  if (participant.quality_state === 'degraded' && recoveredStreak >= recoverySamples) {
    return { state: 'good', degradedStreak: 0, recoveredStreak, eventType: 'recovered' };
  }
  return {
    state: participant.quality_state === 'unknown' ? 'good' : participant.quality_state,
    degradedStreak: 0,
    recoveredStreak,
    eventType: null
  };
}

function resetQualityForRevision(
  participant: ConveractFabricMediaQualityParticipantState
): ConveractFabricMediaQualityParticipantState {
  return {
    ...participant,
    quality_state: 'unknown',
    quality_degraded_streak: 0,
    quality_recovered_streak: 0,
    last_quality_level: 'unknown',
    last_quality_sample_id: '',
    last_qos_at: null
  };
}

function requireActiveParticipant(
  participant: ConveractFabricMediaQualityParticipantState | null
): asserts participant is ConveractFabricMediaQualityParticipantState {
  if (!participant) {
    throw Object.assign(new Error('active media call participant not found'), { status: 404 });
  }
  if (!QUALITY_PARTICIPANT_STATUSES.has(participant.participant_status)) {
    throw conflict('media call participant is not connected or accepted');
  }
}

function connectionStateForEvent(
  eventType: ConveractFabricMediaConnectionEventInput['event_type']
): ConveractFabricMediaConnectionState {
  if (eventType === 'connected' || eventType === 'reconnected' || eventType === 'rejoined') {
    return 'connected';
  }
  if (eventType === 'reconnecting') return 'reconnecting';
  if (eventType === 'rejoining') return 'rejoining';
  if (eventType === 'failed') return 'failed';
  return 'disconnected';
}

function worstQualityLevel(levels: ConveractFabricMediaQualityLevel[]): ConveractFabricMediaQualityLevel {
  const order: Record<ConveractFabricMediaQualityLevel, number> = {
    lost: 0,
    poor: 1,
    unknown: 2,
    good: 3,
    excellent: 4
  };
  return [...levels].sort((left, right) => order[left] - order[right])[0] || 'unknown';
}

function qualityPayloadHash(snapshot: NormalizedQualitySnapshot): string {
  return sha256(JSON.stringify(snapshot));
}

function connectionPayloadHash(event: ConveractFabricMediaConnectionEventInput): string {
  return sha256(JSON.stringify(event));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function objectRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: Set<string>, name: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) throw badRequest(`${name}.${unexpected} is not allowed`);
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw badRequest(`${name} is required`);
  if (text.length > maxLength) throw badRequest(`${name} exceeds maximum length`);
  return text;
}

function optionalText(value: unknown, name: string, maxLength: number): string {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw badRequest(`${name} must be a string`);
  const text = value.trim();
  if (text.length > maxLength) throw badRequest(`${name} exceeds maximum length`);
  return text;
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} is out of range`);
  }
  return parsed;
}

function optionalBoundedInteger(
  value: unknown,
  min: number,
  max: number,
  name: string
): number | null {
  if (value == null || value === '') return null;
  return boundedInteger(value, min, max, name);
}

function boundedNumber(value: unknown, min: number, max: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} is out of range`);
  }
  return parsed;
}

function optionalBoundedNumber(
  value: unknown,
  min: number,
  max: number,
  name: string
): number | null {
  if (value == null || value === '') return null;
  return boundedNumber(value, min, max, name);
}

function boundedTimestamp(
  value: unknown,
  now: Date,
  maxAgeMs: number,
  maxFutureSkewMs: number,
  name: string
): string {
  const text = requiredText(value, name, 64);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw badRequest(`${name} is invalid`);
  if (timestamp < now.getTime() - maxAgeMs || timestamp > now.getTime() + maxFutureSkewMs) {
    throw badRequest(`${name} is outside the accepted time window`);
  }
  return new Date(timestamp).toISOString();
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function optionalEnvNumber(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = String(resolveConveractEnv(env, key) || '').trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}

function compactOptions(
  input: Record<string, number | undefined>
): MediaQualityServiceOptions {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, number] => entry[1] !== undefined)
  ) as MediaQualityServiceOptions;
}

function conflict(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 409 });
}
