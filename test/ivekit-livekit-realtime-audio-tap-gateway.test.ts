import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  createLiveKitRealtimeAudioTapTokenCodec,
  type LiveKitRealtimeAudioTapTokenClaims
} from '../src/agent-runtime/ivekit/voice/livekit-realtime-audio-tap-token.js';
import type { PolicyRealtimeSpeechRouter } from '../src/agent-runtime/ivekit/voice/realtime-speech-routing.js';
import type {
  RealtimeAudioFrame,
  RealtimeSpeechTranslationSession
} from '../src/agent-runtime/ivekit/voice/realtime-speech-translation.js';

const NOW = new Date('2026-07-23T06:00:00.000Z');
const SECRET = Buffer.alloc(32, 13);

test('LiveKit gateway authenticates one track and forwards binary PCM without Provider backpressure', async (t) => {
  const gatewayModule = await import(
    '../src/agent-runtime/ivekit/voice/livekit-realtime-audio-tap-gateway.js'
  ).catch(() => null);
  assert.ok(gatewayModule, 'LiveKit realtime audio tap gateway module is required');
  const started: Array<Parameters<PolicyRealtimeSpeechRouter['startSession']>[0]> = [];
  const sessions: FakeRealtimeSpeechSession[] = [];
  const projections: Array<{ context: Record<string, unknown>; type: string }> = [];
  const events: Array<{ type: string; reason?: string }> = [];
  const router: PolicyRealtimeSpeechRouter = {
    async startSession(input, emit) {
      const session = new FakeRealtimeSpeechSession();
      started.push(input);
      sessions.push(session);
      emit({
        event_id: 'provider-start-a',
        type: 'session.started',
        provider_session_id: session.plan.provider_session_id,
        sequence: 0,
        occurred_at: NOW.toISOString(),
        segment_id: '',
        speaker_id: input.participant_id,
        source_language: input.source_language,
        target_language: '',
        source_text: '',
        translated_text: '',
        provider_request_id: '',
        latency_ms: {},
        safe_metadata: {},
        final: false
      });
      return {
        session,
        selected_profile_id: 'speech-primary',
        attempt_count: 1,
        failed_over: false,
        attempts: []
      };
    }
  };
  const codec = tokenCodec('livekit-gateway-nonce-0001');
  const gateway = new gatewayModule.LiveKitRealtimeAudioTapGateway({
    listen_host: '127.0.0.1',
    listen_port: 0,
    path: '/api/ivekit/realtime-audio-tap/livekit',
    token_codec: codec,
    router,
    max_connections: 4,
    max_prestart_audio_ms: 100,
    idle_timeout_ms: 5_000,
    start_timeout_ms: 1_000,
    shutdown_timeout_ms: 500,
    now: () => NOW,
    on_event: (event) => { events.push(event); },
    on_translation_event: (context, event) => {
      projections.push({ context, type: event.type });
    }
  });
  t.after(() => gateway.close());
  await gateway.start();

  const token = codec.issue(claims());
  const client = new WebSocket(gateway.url(), 'ivekit.livekit-audio-tap.v1', {
    perMessageDeflate: false
  });
  await once(client, 'open');
  client.send(JSON.stringify(startMessage(token)));
  client.send(pcmFrame({
    sequence: 1n,
    capturedAtMicros: 1_753_250_400_000_000n,
    samples: new Array(320).fill(7)
  }));

  await waitFor(() => sessions[0]?.frames.length === 1 && projections.length === 1);
  assert.deepEqual({
    media_source: started[0].media_source,
    interaction_id: started[0].interaction_id,
    media_session_id: started[0].media_session_id,
    participant_id: started[0].participant_id,
    track_id: started[0].track_id,
    audio_format: started[0].audio_format
  }, {
    media_source: 'livekit',
    interaction_id: 'media-call-a',
    media_session_id: 'room-a',
    participant_id: 'customer-a',
    track_id: 'TR_customer_microphone',
    audio_format: {
      encoding: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channels: 1
    }
  });
  assert.equal(sessions[0].frames[0].sequence, 1);
  assert.equal(sessions[0].frames[0].duration_ms, 20);
  assert.equal(projections[0].context.provider_profile_id, 'speech-primary');
  assert.deepEqual(projections[0].context.audience_user_ids, ['agent-a', 'customer-a']);

  client.send(JSON.stringify({
    protocol: 'ivekit.livekit-audio-tap.v1',
    event: 'end',
    reason: 'track_unpublished'
  }));
  await once(client, 'close');
  await waitFor(() => sessions[0]?.closed === true);
  assert.equal(sessions[0].ends[0]?.reason, 'track_unpublished');
  assert.equal(events.some((event) => event.type === 'tap.session.started'), true);
  assert.equal(events.some((event) => event.type === 'tap.session.ended'), true);

  const replay = new WebSocket(gateway.url(), 'ivekit.livekit-audio-tap.v1', {
    perMessageDeflate: false
  });
  await once(replay, 'open');
  replay.send(JSON.stringify(startMessage(token)));
  const replayClose = await once(replay, 'close') as [number, Buffer];
  assert.equal(replayClose[0], 4001);
  assert.equal(events.some((event) =>
    event.type === 'tap.connection.rejected' && event.reason === 'token_replayed'
  ), true);
});

test('LiveKit gateway bounds audio while Provider startup is slow', async (t) => {
  const gatewayModule = await import(
    '../src/agent-runtime/ivekit/voice/livekit-realtime-audio-tap-gateway.js'
  ).catch(() => null);
  assert.ok(gatewayModule, 'LiveKit realtime audio tap gateway module is required');
  const session = new FakeRealtimeSpeechSession();
  let releaseStart: (() => void) | undefined;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  const events: Array<{ type: string; reason?: string; dropped_duration_ms?: number }> = [];
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
  const codec = tokenCodec('livekit-gateway-nonce-0002');
  const gateway = new gatewayModule.LiveKitRealtimeAudioTapGateway({
    listen_host: '127.0.0.1',
    listen_port: 0,
    path: '/api/ivekit/realtime-audio-tap/livekit',
    token_codec: codec,
    router,
    max_prestart_audio_ms: 40,
    idle_timeout_ms: 5_000,
    start_timeout_ms: 1_000,
    shutdown_timeout_ms: 500,
    now: () => NOW,
    on_event: (event) => { events.push(event); }
  });
  t.after(async () => {
    releaseStart?.();
    await gateway.close();
  });
  await gateway.start();

  const client = new WebSocket(gateway.url(), 'ivekit.livekit-audio-tap.v1', {
    perMessageDeflate: false
  });
  await once(client, 'open');
  client.send(JSON.stringify(startMessage(codec.issue(claims()))));
  for (let sequence = 1n; sequence <= 4n; sequence += 1n) {
    client.send(pcmFrame({
      sequence,
      capturedAtMicros: 1_753_250_400_000_000n + sequence * 20_000n,
      samples: new Array(320).fill(Number(sequence))
    }));
  }
  await waitFor(() =>
    events.filter((event) =>
      event.type === 'tap.audio.dropped' &&
      event.reason === 'provider_start_buffer_overflow'
    ).length === 2
  );

  releaseStart?.();
  await waitFor(() => session.frames.length === 2);
  assert.deepEqual(session.frames.map((frame) => frame.sequence), [3, 4]);
  client.close();
});

function claims(): LiveKitRealtimeAudioTapTokenClaims {
  return {
    tenant_id: 'tenant-a',
    interaction_id: 'media-call-a',
    media_session_id: 'room-a',
    participant_id: 'customer-a',
    track_id: 'TR_customer_microphone',
    purpose: 'live_translation',
    consent_ref: 'consent-livekit-a',
    source_language: 'en',
    target_languages: ['zh-CN'],
    features: ['streaming_asr', 'streaming_translation'],
    audience_user_ids: ['agent-a', 'customer-a']
  };
}

function tokenCodec(nonce: string) {
  return createLiveKitRealtimeAudioTapTokenCodec({
    secret: SECRET,
    now: () => NOW,
    nonce: () => nonce,
    ttl_seconds: 45
  });
}

function startMessage(token: string) {
  return {
    protocol: 'ivekit.livekit-audio-tap.v1',
    event: 'start',
    authorization: token,
    media_session_id: 'room-a',
    participant_id: 'customer-a',
    track_id: 'TR_customer_microphone',
    audio: {
      encoding: 'pcm_s16le',
      sample_rate_hz: 16_000,
      channels: 1
    }
  };
}

function pcmFrame(input: {
  sequence: bigint;
  capturedAtMicros: bigint;
  samples: number[];
}): Buffer {
  const output = Buffer.alloc(32 + input.samples.length * 2);
  output.write('LAT1', 0, 'ascii');
  output[4] = 1;
  output[5] = 1;
  output[6] = 1;
  output.writeBigUInt64BE(input.sequence, 8);
  output.writeBigUInt64BE(input.capturedAtMicros, 16);
  output.writeUInt32BE(16_000, 24);
  output.writeUInt32BE(input.samples.length, 28);
  input.samples.forEach((sample, index) =>
    output.writeInt16LE(sample, 32 + index * 2)
  );
  return output;
}

class FakeRealtimeSpeechSession implements RealtimeSpeechTranslationSession {
  readonly plan = {
    provider_session_id: 'provider-session-livekit-a',
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
