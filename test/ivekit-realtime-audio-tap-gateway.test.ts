import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRealtimeAudioTapTokenCodec,
  type RealtimeAudioTapTokenClaims
} from '../src/agent-runtime/converact/voice/realtime-audio-tap-token.js';
import {
  RustPbxRealtimeAudioTapGateway,
  type RustPbxRealtimeAudioTapGatewayEvent
} from '../src/agent-runtime/converact/voice/rustpbx-realtime-audio-tap-gateway.js';
import {
  RustPbxAudioTapFrameDecoder,
  encodeRustPbxAudioTapFrame
} from '../src/agent-runtime/converact/voice/rustpbx-audio-tap-protocol.js';
import type { PolicyRealtimeSpeechRouter } from '../src/agent-runtime/converact/voice/realtime-speech-routing.js';
import type {
  RealtimeAudioFrame,
  RealtimeSpeechTranslationSession
} from '../src/agent-runtime/converact/voice/realtime-speech-translation.js';

const NOW = new Date('2026-07-23T04:00:00.000Z');
const SECRET = Buffer.alloc(32, 7);

function claims(
  overrides: Partial<RealtimeAudioTapTokenClaims> = {}
): RealtimeAudioTapTokenClaims {
  return {
    tenant_id: 'tenant-a',
    interaction_id: 'call-a',
    media_session_id: 'sip-call-id-a',
    purpose: 'live_translation',
    consent_ref: 'consent-a',
    source_language: 'zh',
    target_languages: ['en'],
    features: ['streaming_asr', 'streaming_translation'],
    tracks: [
      {
        leg: 'caller',
        participant_id: 'customer-a',
        track_id: 'sip-call-id-a:caller'
      },
      {
        leg: 'callee',
        participant_id: 'agent-a',
        track_id: 'sip-call-id-a:callee'
      }
    ],
    ...overrides
  };
}

test('realtime audio tap token is short-lived and bound to the exact media session', () => {
  const codec = createRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => NOW,
    nonce: () => 'nonce-0000000000000001',
    ttl_seconds: 60
  });
  const token = codec.issue(claims());
  const verified = codec.verify(token, {
    expected_media_session_id: 'sip-call-id-a'
  });

  assert.equal(verified.tenant_id, 'tenant-a');
  assert.equal(verified.media_session_id, 'sip-call-id-a');
  assert.equal(verified.issued_at, Math.floor(NOW.getTime() / 1000));
  assert.equal(verified.expires_at, verified.issued_at + 60);
  assert.equal(verified.nonce, 'nonce-0000000000000001');
  assert.deepEqual(verified.tracks.map((track) => track.leg), ['caller', 'callee']);
  assert.equal(token.includes(SECRET.toString('hex')), false);
});

test('realtime audio tap token rejects tampering, expiry and session replay', () => {
  const codec = createRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => NOW,
    nonce: () => 'nonce-0000000000000002',
    ttl_seconds: 30
  });
  const token = codec.issue(claims());
  const parts = token.split('.');
  const replacement = parts[2].endsWith('A') ? 'B' : 'A';
  const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${replacement}`;

  assert.throws(() => codec.verify(tampered), /token_signature_invalid/);
  assert.throws(
    () => codec.verify(token, { expected_media_session_id: 'another-session' }),
    /token_session_mismatch/
  );

  const expiredCodec = createRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => new Date(NOW.getTime() + 31_000),
    nonce: () => 'unused-nonce-000000000'
  });
  assert.throws(() => expiredCodec.verify(token), /token_expired/);
});

test('realtime audio tap token validates consent-scoped track and feature claims', () => {
  const codec = createRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => NOW,
    nonce: () => 'nonce-0000000000000003'
  });

  assert.throws(
    () => codec.issue(claims({ consent_ref: '' })),
    /token_claim_invalid/
  );
  assert.throws(
    () => codec.issue(claims({
      tracks: [
        {
          leg: 'caller',
          participant_id: 'customer-a',
          track_id: 'caller-a'
        },
        {
          leg: 'caller',
          participant_id: 'customer-b',
          track_id: 'caller-b'
        }
      ]
    })),
    /token_claim_invalid/
  );
  assert.throws(
    () => codec.issue(claims({
      purpose: 'live_captions',
      target_languages: ['en']
    })),
    /token_claim_invalid/
  );
});

test('RustPBX stream decoder handles fragmented and coalesced control and PCM frames', () => {
  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const start = encodeRustPbxAudioTapFrame(Buffer.concat([
    Buffer.from('IATJ'),
    Buffer.from(JSON.stringify({
      protocol: 'ivekit-rustpbx-audio-tap-v1',
      event: 'start',
      session_id: 'sip-call-id-a',
      session_key: key.toString('base64url'),
      authorization: `header.payload.${'signature'.repeat(4)}`
    }))
  ]));
  const pcm = encodeRustPbxAudioTapFrame(pcmPayload({
    key,
    sequence: 7n,
    receivedAtMicros: 1_753_243_200_123_000n,
    leg: 0,
    samples: [1, -2, 3, -4]
  }));
  const end = encodeRustPbxAudioTapFrame(Buffer.concat([
    Buffer.from('IATJ'),
    Buffer.from(JSON.stringify({
      protocol: 'ivekit-rustpbx-audio-tap-v1',
      event: 'end',
      session_id: 'sip-call-id-a',
      session_key: key.toString('base64url'),
      reason: 'source_closed'
    }))
  ]));
  const wire = Buffer.concat([start, pcm, end]);
  const decoder = new RustPbxAudioTapFrameDecoder();

  assert.deepEqual(decoder.push(wire.subarray(0, 3)), []);
  const messages = decoder.push(wire.subarray(3));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].type, 'start');
  assert.equal(messages[1].type, 'pcm');
  assert.equal(messages[2].type, 'end');
  if (messages[1].type !== 'pcm') throw new Error('expected pcm');
  assert.equal(messages[1].leg, 'caller');
  assert.equal(messages[1].sequence, 7);
  assert.equal(messages[1].sample_rate_hz, 16_000);
  assert.equal(messages[1].duration_ms, 0.25);
  assert.deepEqual([...messages[1].audio], [...Buffer.from([1, 0, 254, 255, 3, 0, 252, 255])]);
});

test('RustPBX stream decoder rejects oversized and structurally invalid PCM frames', () => {
  const decoder = new RustPbxAudioTapFrameDecoder({ max_frame_bytes: 64 });
  assert.throws(
    () => decoder.push(Buffer.from([0, 0, 0, 65])),
    /audio_tap_frame_too_large/
  );

  const key = Buffer.alloc(16, 1);
  const invalid = pcmPayload({
    key,
    sequence: 1n,
    receivedAtMicros: 1n,
    leg: 1,
    samples: [1, 2]
  });
  invalid.writeUInt32BE(3, 44);
  assert.throws(
    () => new RustPbxAudioTapFrameDecoder().push(encodeRustPbxAudioTapFrame(invalid)),
    /audio_tap_pcm_length_invalid/
  );
});

test('RustPBX gateway authenticates once and lazily forwards both media legs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-audio-tap-'));
  const socketPath = join(directory, 'tap.sock');
  const codec = createRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => NOW,
    nonce: () => 'nonce-gateway-000000001'
  });
  const started: Array<{ input: Parameters<PolicyRealtimeSpeechRouter['startSession']>[0] }> = [];
  const sessions: FakeRealtimeSpeechSession[] = [];
  const events: RustPbxRealtimeAudioTapGatewayEvent[] = [];
  const router: PolicyRealtimeSpeechRouter = {
    async startSession(input) {
      const session = new FakeRealtimeSpeechSession();
      started.push({ input });
      sessions.push(session);
      return {
        session,
        selected_profile_id: 'speech-primary',
        attempt_count: 1,
        failed_over: false,
        attempts: []
      };
    }
  };
  const gateway = new RustPbxRealtimeAudioTapGateway({
    socket_path: socketPath,
    token_codec: codec,
    router,
    max_connections: 4,
    max_prestart_audio_ms: 100,
    idle_timeout_ms: 5_000,
    shutdown_timeout_ms: 500,
    on_event: (event) => { events.push(event); }
  });
  t.after(async () => {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  await gateway.start();

  const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const token = codec.issue(claims());
  const client = createConnection(socketPath);
  client.on('error', () => undefined);
  await once(client, 'connect');
  client.write(Buffer.concat([
    controlFrame('start', key, token),
    encodeRustPbxAudioTapFrame(pcmPayload({
      key,
      sequence: 1n,
      receivedAtMicros: 1_753_243_200_000_000n,
      leg: 0,
      samples: new Array(320).fill(1)
    })),
    encodeRustPbxAudioTapFrame(pcmPayload({
      key,
      sequence: 2n,
      receivedAtMicros: 1_753_243_200_020_000n,
      leg: 1,
      samples: new Array(320).fill(-1)
    }))
  ]));

  await waitFor(() => started.length === 2 && sessions.every((session) => session.frames.length === 1));
  assert.deepEqual(started.map(({ input }) => ({
    participant_id: input.participant_id,
    track_id: input.track_id,
    media_source: input.media_source,
    audio_format: input.audio_format
  })), [
    {
      participant_id: 'customer-a',
      track_id: 'sip-call-id-a:caller',
      media_source: 'rustpbx',
      audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 }
    },
    {
      participant_id: 'agent-a',
      track_id: 'sip-call-id-a:callee',
      media_source: 'rustpbx',
      audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 }
    }
  ]);
  assert.equal(sessions[0].frames[0].duration_ms, 20);
  assert.equal(sessions[1].frames[0].duration_ms, 20);

  client.end(controlFrame('end', key));
  await waitFor(() => sessions.every((session) => session.ends.length === 1 && session.closed));
  assert.equal(events.some((event) => event.type === 'tap.session.started'), true);
  assert.equal(events.some((event) => event.type === 'tap.session.ended'), true);

  const replay = createConnection(socketPath);
  replay.on('error', () => undefined);
  await once(replay, 'connect');
  replay.end(controlFrame('start', key, token));
  await waitFor(() => events.some((event) =>
    event.type === 'tap.connection.rejected' && event.reason === 'token_replayed'
  ));
  assert.equal(started.length, 2);
});

test('RustPBX gateway bounds audio while Provider session startup is slow', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ivekit-audio-tap-slow-'));
  const socketPath = join(directory, 'tap.sock');
  const codec = createRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => NOW,
    nonce: () => 'nonce-gateway-000000002'
  });
  const session = new FakeRealtimeSpeechSession();
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const events: RustPbxRealtimeAudioTapGatewayEvent[] = [];
  const router: PolicyRealtimeSpeechRouter = {
    async startSession() {
      await startGate;
      return {
        session,
        selected_profile_id: 'speech-primary',
        attempt_count: 1,
        failed_over: false,
        attempts: []
      };
    }
  };
  const gateway = new RustPbxRealtimeAudioTapGateway({
    socket_path: socketPath,
    token_codec: codec,
    router,
    max_prestart_audio_ms: 40,
    idle_timeout_ms: 5_000,
    shutdown_timeout_ms: 500,
    on_event: (event) => { events.push(event); }
  });
  t.after(async () => {
    releaseStart?.();
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  });
  await gateway.start();

  const key = Buffer.alloc(16, 3);
  const client = createConnection(socketPath);
  client.on('error', () => undefined);
  await once(client, 'connect');
  const frames = [1n, 2n, 3n, 4n].map((sequence) =>
    encodeRustPbxAudioTapFrame(pcmPayload({
      key,
      sequence,
      receivedAtMicros: 1_753_243_200_000_000n + sequence * 20_000n,
      leg: 0,
      samples: new Array(320).fill(Number(sequence))
    }))
  );
  client.write(Buffer.concat([
    controlFrame('start', key, codec.issue(claims({
      tracks: [claims().tracks[0]]
    }))),
    ...frames
  ]));
  await waitFor(() => events.filter((event) => event.type === 'tap.audio.dropped').length === 2);

  releaseStart?.();
  await waitFor(() => session.frames.length === 2);
  assert.deepEqual(session.frames.map((frame) => frame.sequence), [3, 4]);
  client.end(controlFrame('end', key));
});

function pcmPayload(input: {
  key: Buffer;
  sequence: bigint;
  receivedAtMicros: bigint;
  leg: 0 | 1;
  samples: number[];
}): Buffer {
  const output = Buffer.alloc(48 + input.samples.length * 2);
  output.write('IAT1', 0, 'ascii');
  output[4] = 1;
  output[5] = 2;
  output[6] = input.leg;
  input.key.copy(output, 8);
  output.writeBigUInt64BE(input.sequence, 24);
  output.writeBigUInt64BE(input.receivedAtMicros, 32);
  output.writeUInt32BE(16_000, 40);
  output.writeUInt32BE(input.samples.length, 44);
  input.samples.forEach((sample, index) => output.writeInt16LE(sample, 48 + index * 2));
  return output;
}

function controlFrame(
  event: 'start' | 'end',
  key: Buffer,
  authorization = ''
): Buffer {
  const payload = event === 'start'
    ? {
        protocol: 'ivekit-rustpbx-audio-tap-v1',
        event,
        session_id: 'sip-call-id-a',
        session_key: key.toString('base64url'),
        authorization
      }
    : {
        protocol: 'ivekit-rustpbx-audio-tap-v1',
        event,
        session_id: 'sip-call-id-a',
        session_key: key.toString('base64url'),
        reason: 'source_closed'
      };
  return encodeRustPbxAudioTapFrame(Buffer.concat([
    Buffer.from('IATJ'),
    Buffer.from(JSON.stringify(payload))
  ]));
}

class FakeRealtimeSpeechSession implements RealtimeSpeechTranslationSession {
  readonly plan = {
    provider_session_id: 'provider-session-a',
    provider: 'test-provider',
    provider_version: '1',
    max_buffered_audio_ms: 500,
    capabilities: {
      streaming_asr: true,
      streaming_translation: true,
      language_detection: false,
      speaker_diarization: false,
      word_timestamps: false
    }
  };
  readonly frames: RealtimeAudioFrame[] = [];
  readonly ends: Array<{ reason: string; idempotency_key: string }> = [];
  closed = false;

  tryWriteAudio(frame: RealtimeAudioFrame): 'accepted' {
    this.frames.push(frame);
    return 'accepted';
  }

  async end(input: { reason: string; idempotency_key: string }): Promise<void> {
    this.ends.push(input);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
