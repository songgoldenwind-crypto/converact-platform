import type { VoiceDeploymentProfile } from './types.js';

export const RUSTPBX_FAST_MEDIA_PROFILE_ID = 'g711-relay-v1' as const;
export const RUSTPBX_PROCESSING_MEDIA_PROFILE_ID =
  'VOICE-IVR-G711-OPUS-V1' as const;

export type RustPbxMediaCodec = 'PCMU' | 'PCMA' | 'OPUS';

export type RustPbxMediaControlProfile =
  | {
      media_profile_id: typeof RUSTPBX_FAST_MEDIA_PROFILE_ID;
    }
  | {
      media_profile_id: typeof RUSTPBX_PROCESSING_MEDIA_PROFILE_ID;
      leg_a_codec: RustPbxMediaCodec;
      leg_b_codec: RustPbxMediaCodec;
      leg_a_payload_type: number;
      leg_b_payload_type: number;
      packetization_ms: 20;
    };

const FAST_PROFILE_KEYS = new Set(['media_profile_id']);
const PROCESSING_PROFILE_KEYS = new Set([
  'media_profile_id',
  'leg_a_codec',
  'leg_b_codec',
  'leg_a_payload_type',
  'leg_b_payload_type',
  'packetization_ms'
]);

export function resolveRustPbxMediaControlProfile(
  profile: VoiceDeploymentProfile
): RustPbxMediaControlProfile {
  if (profile.adapter !== 'rustpbx') throw invalidProfile();
  const configured = profile.config?.media_control_profile;
  if (configured === undefined) {
    return { media_profile_id: RUSTPBX_FAST_MEDIA_PROFILE_ID };
  }
  return parseRustPbxMediaControlProfile(configured);
}

export function parseRustPbxMediaControlProfile(
  configured: unknown
): RustPbxMediaControlProfile {
  if (!isRecord(configured)) throw invalidProfile();
  if (configured.media_profile_id === RUSTPBX_FAST_MEDIA_PROFILE_ID) {
    exactKeys(configured, FAST_PROFILE_KEYS);
    return { media_profile_id: RUSTPBX_FAST_MEDIA_PROFILE_ID };
  }
  if (configured.media_profile_id !== RUSTPBX_PROCESSING_MEDIA_PROFILE_ID) {
    throw invalidProfile();
  }
  exactKeys(configured, PROCESSING_PROFILE_KEYS);
  const legACodec = codec(configured.leg_a_codec);
  const legBCodec = codec(configured.leg_b_codec);
  if (!isProcessingCodecPair(legACodec, legBCodec) ||
      configured.packetization_ms !== 20) {
    throw invalidProfile();
  }
  const legAPayloadType = payloadType(
    legACodec,
    configured.leg_a_payload_type
  );
  const legBPayloadType = payloadType(
    legBCodec,
    configured.leg_b_payload_type
  );
  return {
    media_profile_id: RUSTPBX_PROCESSING_MEDIA_PROFILE_ID,
    leg_a_codec: legACodec,
    leg_b_codec: legBCodec,
    leg_a_payload_type: legAPayloadType,
    leg_b_payload_type: legBPayloadType,
    packetization_ms: 20
  };
}

function codec(value: unknown): RustPbxMediaCodec {
  if (value === 'PCMU' || value === 'PCMA' || value === 'OPUS') return value;
  throw invalidProfile();
}

function isProcessingCodecPair(
  legACodec: RustPbxMediaCodec,
  legBCodec: RustPbxMediaCodec
): boolean {
  return (legACodec === 'OPUS') !== (legBCodec === 'OPUS');
}

function payloadType(codecValue: RustPbxMediaCodec, value: unknown): number {
  if (!Number.isSafeInteger(value)) throw invalidProfile();
  const payloadTypeValue = Number(value);
  if ((codecValue === 'PCMU' && payloadTypeValue === 0) ||
      (codecValue === 'PCMA' && payloadTypeValue === 8) ||
      (codecValue === 'OPUS' &&
        payloadTypeValue >= 96 &&
        payloadTypeValue <= 127)) {
    return payloadTypeValue;
  }
  throw invalidProfile();
}

function exactKeys(
  value: Record<string, unknown>,
  expected: Set<string>
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw invalidProfile();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidProfile(): Error {
  return new Error('voice_media_control_profile_invalid');
}
