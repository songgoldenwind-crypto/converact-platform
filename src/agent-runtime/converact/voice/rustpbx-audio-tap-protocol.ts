export const RUSTPBX_AUDIO_TAP_PROTOCOL = 'ivekit-rustpbx-audio-tap-v1';

export type RustPbxAudioTapMessage =
  | RustPbxAudioTapStart
  | RustPbxAudioTapPcm
  | RustPbxAudioTapEnd;

export interface RustPbxAudioTapStart {
  type: 'start';
  session_id: string;
  session_key: Uint8Array;
  authorization: string;
}

export interface RustPbxAudioTapPcm {
  type: 'pcm';
  session_key: Uint8Array;
  sequence: number;
  received_at_micros: number;
  leg: 'caller' | 'callee';
  sample_rate_hz: 16_000;
  sample_count: number;
  duration_ms: number;
  audio: Uint8Array;
}

export interface RustPbxAudioTapEnd {
  type: 'end';
  session_id: string;
  session_key: Uint8Array;
  reason: string;
}

interface DecoderOptions {
  max_frame_bytes?: number;
}

const CONTROL_MAGIC = Buffer.from('IATJ');
const PCM_MAGIC = Buffer.from('IAT1');
const PCM_HEADER_BYTES = 48;
const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;
const CONTROL_KEYS = {
  start: ['protocol', 'event', 'session_id', 'session_key', 'authorization'],
  end: ['protocol', 'event', 'session_id', 'session_key', 'reason']
} as const;

export class RustPbxAudioTapFrameDecoder {
  readonly #maxFrameBytes: number;
  #buffer = Buffer.alloc(0);

  constructor(options: DecoderOptions = {}) {
    this.#maxFrameBytes = boundedInteger(
      options.max_frame_bytes ?? DEFAULT_MAX_FRAME_BYTES,
      64,
      4 * 1024 * 1024,
      'audio_tap_frame_limit_invalid'
    );
  }

  push(chunk: Uint8Array): RustPbxAudioTapMessage[] {
    if (!(chunk instanceof Uint8Array)) throw protocolError('audio_tap_chunk_invalid');
    if (chunk.byteLength > 0) {
      this.#buffer = this.#buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#buffer, chunk]);
    }
    const messages: RustPbxAudioTapMessage[] = [];
    let offset = 0;
    while (this.#buffer.length - offset >= 4) {
      const length = this.#buffer.readUInt32BE(offset);
      if (length === 0) throw protocolError('audio_tap_frame_empty');
      if (length > this.#maxFrameBytes) throw protocolError('audio_tap_frame_too_large');
      if (this.#buffer.length - offset - 4 < length) break;
      const payload = this.#buffer.subarray(offset + 4, offset + 4 + length);
      messages.push(decodePayload(payload));
      offset += 4 + length;
    }
    if (offset > 0) this.#buffer = Buffer.from(this.#buffer.subarray(offset));
    if (this.#buffer.length > this.#maxFrameBytes + 4) {
      throw protocolError('audio_tap_buffer_too_large');
    }
    return messages;
  }
}

export function encodeRustPbxAudioTapFrame(payload: Uint8Array): Buffer {
  if (!(payload instanceof Uint8Array) || payload.byteLength === 0) {
    throw protocolError('audio_tap_frame_empty');
  }
  if (payload.byteLength > 0xffff_ffff) throw protocolError('audio_tap_frame_too_large');
  const output = Buffer.allocUnsafe(4 + payload.byteLength);
  output.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload).copy(output, 4);
  return output;
}

function decodePayload(payload: Buffer): RustPbxAudioTapMessage {
  if (payload.length >= 4 && payload.subarray(0, 4).equals(CONTROL_MAGIC)) {
    return decodeControl(payload.subarray(4));
  }
  if (payload.length >= 4 && payload.subarray(0, 4).equals(PCM_MAGIC)) {
    return decodePcm(payload);
  }
  throw protocolError('audio_tap_magic_invalid');
}

function decodeControl(payload: Buffer): RustPbxAudioTapStart | RustPbxAudioTapEnd {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    throw protocolError('audio_tap_control_invalid');
  }
  if (!isRecord(value) || value.protocol !== RUSTPBX_AUDIO_TAP_PROTOCOL) {
    throw protocolError('audio_tap_control_invalid');
  }
  if (value.event === 'start') {
    exactKeys(value, CONTROL_KEYS.start);
    return {
      type: 'start',
      session_id: boundedText(value.session_id, 1, 256),
      session_key: sessionKey(value.session_key),
      authorization: boundedText(value.authorization, 32, 2_048)
    };
  }
  if (value.event === 'end') {
    exactKeys(value, CONTROL_KEYS.end);
    return {
      type: 'end',
      session_id: boundedText(value.session_id, 1, 256),
      session_key: sessionKey(value.session_key),
      reason: boundedText(value.reason, 1, 128)
    };
  }
  throw protocolError('audio_tap_control_invalid');
}

function decodePcm(payload: Buffer): RustPbxAudioTapPcm {
  if (payload.length < PCM_HEADER_BYTES) throw protocolError('audio_tap_pcm_header_invalid');
  if (payload[4] !== 1 || payload[5] !== 2 || payload[7] !== 0) {
    throw protocolError('audio_tap_pcm_header_invalid');
  }
  const leg = payload[6] === 0 ? 'caller' : payload[6] === 1 ? 'callee' : null;
  if (!leg) throw protocolError('audio_tap_pcm_header_invalid');
  const sequence = safeUint64(payload.readBigUInt64BE(24), 'audio_tap_sequence_invalid');
  const receivedAt = safeUint64(
    payload.readBigUInt64BE(32),
    'audio_tap_timestamp_invalid'
  );
  const sampleRate = payload.readUInt32BE(40);
  if (sampleRate !== 16_000) throw protocolError('audio_tap_sample_rate_invalid');
  const sampleCount = payload.readUInt32BE(44);
  if (sampleCount === 0 || payload.length !== PCM_HEADER_BYTES + sampleCount * 2) {
    throw protocolError('audio_tap_pcm_length_invalid');
  }
  return {
    type: 'pcm',
    session_key: Uint8Array.from(payload.subarray(8, 24)),
    sequence,
    received_at_micros: receivedAt,
    leg,
    sample_rate_hz: 16_000,
    sample_count: sampleCount,
    duration_ms: sampleCount / 16,
    audio: Uint8Array.from(payload.subarray(PCM_HEADER_BYTES))
  };
}

function sessionKey(value: unknown): Uint8Array {
  const encoded = String(value || '');
  if (!/^[A-Za-z0-9_-]{22}$/.test(encoded)) {
    throw protocolError('audio_tap_session_key_invalid');
  }
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.length !== 16) throw protocolError('audio_tap_session_key_invalid');
  return Uint8Array.from(decoded);
}

function safeUint64(value: bigint, code: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw protocolError(code);
  return Number(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length ||
      actual.some((key, index) => key !== allowed[index])) {
    throw protocolError('audio_tap_control_invalid');
  }
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  code: string
): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw protocolError(code);
  }
  return number;
}

function boundedText(value: unknown, min: number, max: number): string {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw protocolError('audio_tap_control_invalid');
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function protocolError(code: string): Error {
  return new Error(code);
}
