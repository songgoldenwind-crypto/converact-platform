import { safeVoiceProviderPayload } from '../../voice/canonical.js';
import { VoiceError } from '../../voice/errors.js';
import type { IvrAction } from '../types.js';

export interface RustPbxStepIvrAdapterOptions {
  profile_id: string;
  max_metadata_bytes?: number;
}

export interface RustPbxStepIvrSequenceState {
  last_event_sequence: number;
  last_action_revision: number;
}

export interface RustPbxStepIvrEvent {
  type: string;
  digit?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface RustPbxStepIvrNormalizedRequest {
  profile_id: string;
  provider_session_id: string;
  event_sequence: number;
  action_revision: number;
  disposition: 'advance' | 'replay';
  event: RustPbxStepIvrEvent;
  safe_metadata: Record<string, unknown>;
}

export interface RustPbxStepIvrActionNode {
  type: string;
  [key: string]: unknown;
}

const EVENT_TYPES = new Set([
  'session_start',
  'dtmf',
  'dtmf_timeout',
  'dtmf_menu_invalid',
  'dtmf_menu_timeout',
  'audio_complete',
  'recording_complete',
  'queue_update',
  'transfer_complete',
  'hangup',
  'error'
]);

export class RustPbxStepIvrAdapter {
  readonly #profileId: string;
  readonly #maxMetadataBytes: number;

  constructor(options: RustPbxStepIvrAdapterOptions) {
    this.#profileId = boundedString(options.profile_id, 256);
    this.#maxMetadataBytes = boundedInteger(options.max_metadata_bytes, 64 * 1024, 256, 1024 * 1024);
  }

  normalizeRequest(input: unknown, state: RustPbxStepIvrSequenceState): RustPbxStepIvrNormalizedRequest {
    if (!isRecord(input) || !isRecord(state)) throw validationError();
    const profileId = boundedString(input.profile_id, 256);
    if (profileId !== this.#profileId) throw validationError();
    const providerSessionId = boundedString(input.provider_session_id, 256);
    const eventSequence = nonNegativeInteger(input.event_sequence);
    const actionRevision = nonNegativeInteger(input.action_revision);
    const lastEventSequence = nonNegativeInteger(state.last_event_sequence);
    const lastActionRevision = nonNegativeInteger(state.last_action_revision);
    let disposition: 'advance' | 'replay';
    if (eventSequence === lastEventSequence && actionRevision === lastActionRevision) {
      disposition = 'replay';
    } else if (eventSequence === lastEventSequence + 1 && actionRevision === lastActionRevision + 1) {
      disposition = 'advance';
    } else {
      throw new VoiceError({
        code: 'event_sequence_conflict',
        status: 409,
        details: {
          expected_event_sequence: lastEventSequence + 1,
          expected_action_revision: lastActionRevision + 1
        }
      });
    }
    const event = normalizedEvent(input.event);
    const metadata = input.metadata ?? {};
    if (!isRecord(metadata) || jsonBytes(metadata) > this.#maxMetadataBytes) throw validationError();
    return {
      profile_id: profileId,
      provider_session_id: providerSessionId,
      event_sequence: eventSequence,
      action_revision: actionRevision,
      disposition,
      event,
      safe_metadata: safeVoiceProviderPayload(metadata)
    };
  }

  mapAction(action: IvrAction): RustPbxStepIvrActionNode {
    if (!isRecord(action) || !isRecord(action.payload)) throw validationError();
    boundedString(action.node_id, 256);
    switch (action.kind) {
      case 'play': return promptNode(action.payload);
      case 'collect': return collectNode(action.payload);
      case 'queue':
        return { type: 'queue', queue: boundedString(action.payload.queue_id, 256) };
      case 'transfer':
        return { type: 'transfer', target: boundedString(action.payload.target, 1024) };
      case 'record':
        return {
          type: 'record',
          max_duration_ms: boundedInteger(action.payload.max_duration_ms, 60_000, 1_000, 3_600_000),
          beep: optionalBoolean(action.payload.beep, true)
        };
      case 'hangup': {
        const prompt = optionalString(action.payload.prompt, 4_096);
        return prompt ? { type: 'play_and_hangup', tts_text: prompt } : { type: 'hangup' };
      }
      case 'wait':
        return { type: 'wait', duration_ms: boundedInteger(action.payload.duration_ms, 1_000, 10, 300_000) };
      case 'webhook':
      case 'media':
        throw new VoiceError({ code: 'capability_unavailable', status: 501, details: { action: action.kind } });
      default:
        throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    }
  }
}

function promptNode(payload: Record<string, unknown>): RustPbxStepIvrActionNode {
  const node: RustPbxStepIvrActionNode = { type: 'prompt', ...promptFields(payload, 'text') };
  if (payload.interruptible !== undefined) node.interruptible = optionalBoolean(payload.interruptible, false);
  return node;
}

function collectNode(payload: Record<string, unknown>): RustPbxStepIvrActionNode {
  const mode = payload.mode === undefined ? 'digits' : boundedString(payload.mode, 32);
  const prompt = promptFields(payload, 'prompt');
  if (mode === 'menu') {
    return {
      type: 'dtmf_menu',
      ...prompt,
      timeout_ms: boundedInteger(payload.timeout_ms, 10_000, 100, 300_000),
      max_retries: boundedInteger(payload.max_retries, 3, 0, 20)
    };
  }
  if (mode !== 'digits') throw validationError();
  const endKey = payload.end_key === undefined ? undefined : boundedString(payload.end_key, 1);
  if (endKey !== undefined && !/^[*#]$/.test(endKey)) throw validationError();
  return {
    type: 'collect_dtmf',
    ...prompt,
    num_digits: boundedInteger(payload.max_digits, 1, 1, 64),
    timeout_ms: boundedInteger(payload.timeout_ms, 30_000, 100, 300_000),
    ...(endKey ? { end_key: endKey } : {}),
    ...(payload.variable === undefined ? {} : { variable: boundedString(payload.variable, 128) })
  };
}

function promptFields(payload: Record<string, unknown>, textField: string): Record<string, unknown> {
  const audioUrl = optionalString(payload.audio_url, 2_048);
  if (audioUrl) {
    let parsed: URL;
    try {
      parsed = new URL(audioUrl);
    } catch {
      throw validationError();
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw validationError();
    return { file: parsed.toString() };
  }
  return { tts_text: boundedString(payload[textField], 4_096) };
}

function normalizedEvent(value: unknown): RustPbxStepIvrEvent {
  if (!isRecord(value)) throw validationError();
  const type = boundedString(value.type, 128);
  if (!EVENT_TYPES.has(type)) throw validationError();
  const output: RustPbxStepIvrEvent = { type };
  if (type === 'dtmf' || value.digit !== undefined) {
    const digit = boundedString(value.digit, 1);
    if (!/^[0-9*#]$/.test(digit)) throw validationError();
    output.digit = digit;
  }
  if (value.reason !== undefined) output.reason = boundedString(value.reason, 256);
  return output;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw validationError();
  }
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw validationError();
  return value;
}

function optionalString(value: unknown, maxLength: number): string {
  if (value === undefined || value === null || value === '') return '';
  return boundedString(value, maxLength);
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') throw validationError();
  const output = value.trim();
  if (!output || output.length > maxLength || /[\u0000-\u001f\u007f]/.test(output)) throw validationError();
  return output;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const output = value === undefined ? fallback : value;
  if (!Number.isInteger(output) || Number(output) < min || Number(output) > max) throw validationError();
  return Number(output);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER) throw validationError();
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validationError(): VoiceError {
  return new VoiceError({ code: 'validation_failed', status: 422 });
}
