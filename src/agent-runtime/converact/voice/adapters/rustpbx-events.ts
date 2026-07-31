import { safeVoiceProviderPayload } from '../canonical.js';
import { VoiceError } from '../errors.js';
import type { VoiceNormalizedProviderEvent } from '../types.js';

export type RustPbxEventSource = 'rwi' | 'http' | 'cdr';

export interface RustPbxNormalizedEvent extends VoiceNormalizedProviderEvent {
  provider_call_id: string;
}

const DIRECT_EVENT_STATES: Readonly<Record<string, string>> = {
  'call.incoming': 'ringing',
  'call.ringing': 'ringing',
  'call.answered': 'answered',
  'call.hold': 'held',
  'call.hangup': 'completed',
  'call.no_answer': 'no_answer',
  'call.busy': 'busy',
  'call.transfer': 'transferring'
};

const RWI_STATE_EVENTS: Readonly<Record<string, { event_type: string; provider_state: string }>> = {
  incoming: { event_type: 'call.incoming', provider_state: 'ringing' },
  trying: { event_type: 'call.ringing', provider_state: 'dialing' },
  dialing: { event_type: 'call.ringing', provider_state: 'dialing' },
  ringing: { event_type: 'call.ringing', provider_state: 'ringing' },
  answered: { event_type: 'call.answered', provider_state: 'answered' },
  active: { event_type: 'call.answered', provider_state: 'active' },
  held: { event_type: 'call.hold', provider_state: 'held' },
  transferring: { event_type: 'call.transfer', provider_state: 'transferring' },
  completed: { event_type: 'call.hangup', provider_state: 'completed' },
  hangup: { event_type: 'call.hangup', provider_state: 'completed' },
  no_answer: { event_type: 'call.no_answer', provider_state: 'no_answer' },
  busy: { event_type: 'call.busy', provider_state: 'busy' },
  failed: { event_type: 'call.hangup', provider_state: 'failed' }
};

export class RustPbxEventsAdapter {
  normalize(source: RustPbxEventSource, input: unknown): RustPbxNormalizedEvent {
    const value = record(input);
    if (source === 'cdr') return normalizeCdr(value);
    if (source === 'rwi') return normalizeRwi(value);
    if (source === 'http') return normalizeHttp(value);
    throw protocolMismatch();
  }
}

function normalizeHttp(value: Record<string, unknown>): RustPbxNormalizedEvent {
  const externalEventId = requiredIdentifier(value.event_id);
  const providerCallId = requiredIdentifier(value.call_id);
  const eventType = boundedString(value.event, 64);
  const providerState = DIRECT_EVENT_STATES[eventType];
  if (!providerState) throw protocolMismatch();
  return normalized({
    external_event_id: externalEventId,
    event_type: eventType,
    provider_state: providerState,
    provider_call_id: providerCallId,
    occurred_at: optionalTimestamp(value.occurred_at),
    safe_payload: safeVoiceProviderPayload({
      event_id: externalEventId,
      event: eventType,
      call_id: providerCallId,
      occurred_at: optionalTimestamp(value.occurred_at),
      direction: boundedOptionalString(value.direction, 16),
      reason: boundedOptionalString(value.reason, 128),
      target_kind: boundedOptionalString(value.target_kind, 32)
    })
  });
}

function normalizeRwi(value: Record<string, unknown>): RustPbxNormalizedEvent {
  const event = boundedString(value.event, 64);
  if (event !== 'call_state_change') throw protocolMismatch();
  const externalEventId = requiredIdentifier(value.event_id);
  const providerCallId = requiredIdentifier(value.call_id);
  const state = boundedString(value.state, 64).toLowerCase().replace(/[\s-]+/g, '_');
  const mapped = RWI_STATE_EVENTS[state];
  if (!mapped) throw protocolMismatch();
  return normalized({
    external_event_id: externalEventId,
    ...mapped,
    provider_call_id: providerCallId,
    occurred_at: optionalTimestamp(value.occurred_at),
    safe_payload: safeVoiceProviderPayload({
      event_id: externalEventId,
      event,
      call_id: providerCallId,
      state,
      occurred_at: optionalTimestamp(value.occurred_at),
      reason: boundedOptionalString(value.reason, 128)
    })
  });
}

function normalizeCdr(value: Record<string, unknown>): RustPbxNormalizedEvent {
  const externalEventId = requiredIdentifier(value.cdr_id ?? value.event_id);
  const providerCallId = requiredIdentifier(value.call_id);
  const providerState = boundedOptionalString(value.state, 64).toLowerCase() || 'completed';
  const durationMs = boundedNonNegativeInteger(value.duration_ms, 31 * 24 * 60 * 60 * 1_000);
  const metadata = parsedMetadata(value.metadata);
  return normalized({
    external_event_id: externalEventId,
    event_type: 'call.cdr',
    provider_state: providerState,
    provider_call_id: providerCallId,
    occurred_at: optionalTimestamp(value.ended_at ?? value.occurred_at),
    safe_payload: safeVoiceProviderPayload({
      cdr_id: externalEventId,
      call_id: providerCallId,
      state: providerState,
      duration_ms: durationMs,
      hangup_reason: boundedOptionalString(value.hangup_reason, 128),
      recording_id: boundedOptionalIdentifier(value.recording_id),
      recording_object_ref: boundedOptionalString(value.recording_object_ref, 2_048),
      recording_evidence_ref: boundedOptionalString(value.recording_evidence_ref, 2_048),
      recording_checksum: boundedOptionalString(value.recording_checksum, 256),
      captured_at: optionalTimestamp(value.captured_at),
      metadata
    })
  });
}

function normalized(input: RustPbxNormalizedEvent): RustPbxNormalizedEvent {
  return input;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw protocolMismatch();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw protocolMismatch();
  return value as Record<string, unknown>;
}

function parsedMetadata(value: unknown): Record<string, unknown> {
  if (value == null || value === '') return {};
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 64 * 1024) throw protocolMismatch();
    try {
      return record(JSON.parse(value));
    } catch {
      throw protocolMismatch();
    }
  }
  return record(value);
}

function requiredIdentifier(value: unknown): string {
  const result = boundedString(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(result)) throw protocolMismatch();
  return result;
}

function boundedOptionalIdentifier(value: unknown): string {
  if (value == null || value === '') return '';
  return requiredIdentifier(value);
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string') throw protocolMismatch();
  const result = value.trim();
  if (!result || Buffer.byteLength(result, 'utf8') > max) throw protocolMismatch();
  return result;
}

function boundedOptionalString(value: unknown, max: number): string {
  if (value == null || value === '') return '';
  return boundedString(value, max);
}

function boundedNonNegativeInteger(value: unknown, max: number): number | null {
  if (value == null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw protocolMismatch();
  return Number(value);
}

function optionalTimestamp(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) throw protocolMismatch();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw protocolMismatch();
  return parsed.toISOString();
}

function protocolMismatch(): VoiceError {
  return new VoiceError({ code: 'protocol_mismatch', status: 422 });
}
