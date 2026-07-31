import type {
  RealtimeSpeechTranslationEvent
} from './realtime-speech-translation.js';
import type {
  RealtimeSpeechFinalSegment,
  RealtimeSpeechFinalSegmentInput,
  RealtimeSpeechStorePort
} from './realtime-speech-store.js';

export interface RealtimeSpeechProjectionContext {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  media_source: 'rustpbx' | 'livekit';
  participant_id: string;
  track_id: string;
  purpose: 'live_captions' | 'live_translation';
  consent_ref: string;
  provider_profile_id: string;
  provider: string;
  provider_version: string;
  retention_until: string;
  audience_user_ids: string[];
}

export interface RealtimeSpeechEphemeralProjectionEvent {
  tenant_id: string;
  interaction_id: string;
  media_session_id: string;
  audience_user_ids: string[];
  type: `media.realtime_speech.${RealtimeSpeechTranslationEvent['type']}`;
  data: RealtimeSpeechTranslationEvent & { projection_id?: string };
}

export interface RealtimeSpeechFinalProjectionEvent {
  tenant_id: string;
  type: 'collaboration.intelligence.realtime_speech.finalized';
  data: {
    projection_id: string;
    call_id: string;
    interaction_id: string;
    media_session_id: string;
    media_source: 'rustpbx' | 'livekit';
    participant_id: string;
    provider_profile_id: string;
    provider_version: string;
    kind: 'transcript' | 'translation';
    segment_id: string;
    speaker_id: string;
    source_language: string;
    target_language: string;
    confidence?: number;
    start_ms?: number;
    end_ms?: number;
    occurred_at: string;
    retention_until: string;
  };
}

export interface RealtimeSpeechProjectionResult {
  status: 'ephemeral' | 'persisted';
  projection: RealtimeSpeechFinalSegment | null;
  replayed: boolean;
}

export class RealtimeSpeechProjection {
  constructor(private readonly options: {
    store: RealtimeSpeechStorePort;
    broadcastEphemeral(event: RealtimeSpeechEphemeralProjectionEvent): void | Promise<void>;
    publishFinal(event: RealtimeSpeechFinalProjectionEvent): void | Promise<void>;
  }) {}

  async project(
    context: RealtimeSpeechProjectionContext,
    event: RealtimeSpeechTranslationEvent
  ): Promise<RealtimeSpeechProjectionResult> {
    if (!isFinalContent(event)) {
      await this.options.broadcastEphemeral(ephemeralEvent(context, event));
      return { status: 'ephemeral', projection: null, replayed: false };
    }
    const stored = await this.options.store.upsertFinal(finalInput(context, event));
    if (stored.replayed) {
      return { status: 'persisted', projection: stored.segment, replayed: true };
    }
    await this.options.broadcastEphemeral(ephemeralEvent(context, event, stored.segment.id));
    await this.options.publishFinal(finalEvent(stored.segment));
    return { status: 'persisted', projection: stored.segment, replayed: false };
  }
}

function isFinalContent(event: RealtimeSpeechTranslationEvent): boolean {
  return event.type === 'transcript.final' || event.type === 'translation.final';
}

function finalInput(
  context: RealtimeSpeechProjectionContext,
  event: RealtimeSpeechTranslationEvent
): RealtimeSpeechFinalSegmentInput {
  if (!event.final || !event.segment_id) throw projectionError('final segment identity is required');
  return {
    ...context,
    source_event_id: event.event_id,
    provider_session_id: event.provider_session_id,
    sequence: event.sequence,
    kind: event.type === 'translation.final' ? 'translation' : 'transcript',
    segment_id: event.segment_id,
    speaker_id: event.speaker_id,
    source_language: event.source_language,
    target_language: event.target_language,
    source_text: event.source_text,
    translated_text: event.translated_text,
    ...(event.confidence === undefined ? {} : { confidence: event.confidence }),
    ...(event.start_ms === undefined ? {} : { start_ms: event.start_ms }),
    ...(event.end_ms === undefined ? {} : { end_ms: event.end_ms }),
    provider_request_id: event.provider_request_id,
    latency_ms: { ...event.latency_ms },
    safe_metadata: structuredClone(event.safe_metadata),
    occurred_at: event.occurred_at
  };
}

function ephemeralEvent(
  context: RealtimeSpeechProjectionContext,
  event: RealtimeSpeechTranslationEvent,
  projectionId?: string
): RealtimeSpeechEphemeralProjectionEvent {
  return {
    tenant_id: context.tenant_id,
    interaction_id: context.interaction_id,
    media_session_id: context.media_session_id,
    audience_user_ids: [...context.audience_user_ids],
    type: `media.realtime_speech.${event.type}`,
    data: { ...structuredClone(event), ...(projectionId ? { projection_id: projectionId } : {}) }
  };
}

function finalEvent(segment: RealtimeSpeechFinalSegment): RealtimeSpeechFinalProjectionEvent {
  return {
    tenant_id: segment.tenant_id,
    type: 'collaboration.intelligence.realtime_speech.finalized',
    data: {
      projection_id: segment.id,
      call_id: segment.interaction_id,
      interaction_id: segment.interaction_id,
      media_session_id: segment.media_session_id,
      media_source: segment.media_source,
      participant_id: segment.participant_id,
      provider_profile_id: segment.provider_profile_id,
      provider_version: segment.provider_version,
      kind: segment.kind,
      segment_id: segment.segment_id,
      speaker_id: segment.speaker_id,
      source_language: segment.source_language,
      target_language: segment.target_language,
      ...(segment.confidence === undefined ? {} : { confidence: segment.confidence }),
      ...(segment.start_ms === undefined ? {} : { start_ms: segment.start_ms }),
      ...(segment.end_ms === undefined ? {} : { end_ms: segment.end_ms }),
      occurred_at: segment.occurred_at,
      retention_until: segment.retention_until
    }
  };
}

function projectionError(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 422, code: 'protocol_mismatch' });
}
