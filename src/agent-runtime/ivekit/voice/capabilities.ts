import type {
  VoiceActionCapabilities,
  VoiceCapability,
  VoiceCommandKind,
  VoiceConferenceOperation
} from './types.js';

export const VOICE_CAPABILITIES: readonly VoiceCapability[] = [
  'management_http',
  'json_rpc_routing',
  'step_ivr',
  'rwi',
  'webrtc_extension',
  'recording',
  'sipflow',
  'queue',
  'postgres_backend'
];

export const VOICE_CAPABILITY_SCHEMA_VERSION = 1 as const;

export const VOICE_COMMAND_KINDS: readonly VoiceCommandKind[] = [
  'originate',
  'answer',
  'hangup',
  'dtmf',
  'hold',
  'resume',
  'blind_transfer',
  'warm_transfer',
  'conference',
  'park',
  'pickup',
  'recording_start',
  'recording_pause',
  'recording_resume',
  'recording_stop',
  'livekit_bridge_create'
];

export const VOICE_CONFERENCE_OPERATIONS: readonly VoiceConferenceOperation[] = [
  'create', 'add', 'remove', 'destroy'
];

export function normalizeVoiceActionCapabilities(input?: {
  commands?: Partial<Record<VoiceCommandKind, boolean>>;
  conference_operations?: Partial<Record<VoiceConferenceOperation, boolean>>;
} | null): VoiceActionCapabilities {
  return {
    commands: Object.fromEntries(VOICE_COMMAND_KINDS.map((kind) => [
      kind, input?.commands?.[kind] === true
    ])) as Record<VoiceCommandKind, boolean>,
    conference_operations: Object.fromEntries(VOICE_CONFERENCE_OPERATIONS.map((operation) => [
      operation, input?.conference_operations?.[operation] === true
    ])) as Record<VoiceConferenceOperation, boolean>
  };
}

export function supportsVoiceCommand(
  capabilities: VoiceActionCapabilities | null | undefined,
  kind: VoiceCommandKind,
  payload: Record<string, unknown> = {}
): boolean {
  if (capabilities?.commands?.[kind] !== true) return false;
  if (kind !== 'conference') return true;
  const operation = payload.operation === undefined ? 'add' : payload.operation;
  return VOICE_CONFERENCE_OPERATIONS.includes(operation as VoiceConferenceOperation)
    && capabilities.conference_operations?.[operation as VoiceConferenceOperation] === true;
}
