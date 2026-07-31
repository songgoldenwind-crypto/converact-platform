import { safeVoiceProviderPayload } from './canonical.js';
import { VoiceError } from './errors.js';
import type { RealtimeVoiceAiNormalizedEvent } from './realtime-ai.js';

export interface RealtimeVoiceAiProjectionPolicy {
  persist_transcripts: boolean;
  persist_partial_transcripts: boolean;
  allowed_tool_refs: string[];
  max_transcript_chars: number;
}

export interface RealtimeVoiceAiProjectedEvent extends RealtimeVoiceAiNormalizedEvent {
  transcript_persisted: boolean;
}

export function projectRealtimeVoiceAiEvent(
  event: RealtimeVoiceAiNormalizedEvent,
  policy: RealtimeVoiceAiProjectionPolicy
): RealtimeVoiceAiProjectedEvent {
  const maxTranscriptChars = boundedInteger(policy.max_transcript_chars, 1, 8_192);
  const partial = event.type === 'transcript.partial';
  const transcriptEvent = partial || event.type === 'transcript.final';
  const transcriptAllowed = transcriptEvent && policy.persist_transcripts
    && (!partial || policy.persist_partial_transcripts);
  if (event.tool_ref && !policy.allowed_tool_refs.includes(event.tool_ref)) {
    throw new VoiceError({ code: 'compliance_denied', status: 403 });
  }
  return {
    ...structuredClone(event),
    transcript_text: transcriptAllowed ? event.transcript_text.slice(0, maxTranscriptChars) : '',
    transcript_persisted: transcriptAllowed && Boolean(event.transcript_text),
    safe_metadata: sanitizeMetadata(event.safe_metadata),
    latency_ms: boundedLatency(event.latency_ms)
  };
}

function sanitizeMetadata(value: Record<string, unknown>): Record<string, unknown> {
  return dropContentFields(safeVoiceProviderPayload(value, {
    max_depth: 4, max_string_length: 256, max_array_length: 16, max_object_entries: 40
  })) as Record<string, unknown>;
}

function dropContentFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropContentFields);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (/raw|audio|prompt|argument|toolinput|tooloutput|transcript|message|content/.test(normalized)) continue;
    output[key] = dropContentFields(item);
  }
  return output;
}

function boundedLatency(value: Record<string, number>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(value).slice(0, 16)) {
    if (/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)
      && Number.isFinite(item) && item >= 0 && item <= 3_600_000) output[key] = item;
  }
  return output;
}

function boundedInteger(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return Number(value);
}
