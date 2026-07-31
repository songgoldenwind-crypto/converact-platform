import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  createExternalRealtimeSpeechFactory,
  decodeRealtimeAudioEnvelope,
  encodeRealtimeAudioEnvelope
} from '../src/agent-runtime/converact/voice/adapters/external-realtime-speech.js';
import {
  RealtimeSpeechTranslationRegistry,
  RealtimeSpeechTranslationService,
  type RealtimeAudioFrame,
  type RealtimeSpeechProviderProfile,
  type RealtimeSpeechTranslationEvent
} from '../src/agent-runtime/converact/voice/realtime-speech-translation.js';

test('realtime audio binary envelope preserves timing and payload without base64', () => {
  const frame = audioFrame(42, 20, new Uint8Array([1, 2, 3, 4]));
  const encoded = encodeRealtimeAudioEnvelope(frame, {
    encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1
  });

  assert.equal(encoded.subarray(0, 4).toString('ascii'), 'IVAF');
  assert.equal(encoded.byteLength, 28);
  assert.deepEqual(decodeRealtimeAudioEnvelope(encoded), {
    sequence: 42,
    captured_at: '2026-07-22T08:00:00.000Z',
    duration_ms: 20,
    audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 },
    audio: Buffer.from([1, 2, 3, 4])
  });
});

test('external realtime speech adapter uses authenticated WSS control and binary audio frames', async (t) => {
  const provider = await startProvider();
  t.after(() => provider.close());
  const events: RealtimeSpeechTranslationEvent[] = [];
  const service = serviceFor(provider.url);
  const session = await service.startSession(profile(provider.url), startInput(), (event) => {
    events.push(event);
  });

  assert.equal(provider.authorization, 'Bearer speech-secret');
  assert.equal(new URL(provider.url).search, '');
  assert.equal(provider.start?.interaction_id, 'interaction-a');
  assert.equal(provider.start?.audio_format.encoding, 'pcm_s16le');
  assert.equal(session.tryWriteAudio(audioFrame(1)), 'accepted');

  await waitFor(() => provider.frames.length === 1 && events.some(
    (event) => event.type === 'transcript.final'
  ));
  assert.equal(provider.frames[0].sequence, 1);
  assert.equal(provider.frames[0].audio.byteLength, 640);
  assert.equal(events.find((event) => event.type === 'transcript.final')?.source_text, 'hello');

  await session.end({ reason: 'call_ended', idempotency_key: 'end-a' });
  await session.close();
  assert.equal(session.tryWriteAudio(audioFrame(2)), 'closed');
});

test('external realtime speech adapter bounds queued audio by duration before socket I/O', async (t) => {
  const provider = await startProvider();
  t.after(() => provider.close());
  const service = serviceFor(provider.url);
  const session = await service.startSession(
    profile(provider.url, { max_buffered_audio_ms: 100 }),
    startInput(),
    () => undefined
  );

  assert.deepEqual([1, 2, 3, 4, 5].map((sequence) =>
    session.tryWriteAudio(audioFrame(sequence))
  ), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted']);
  assert.equal(session.tryWriteAudio(audioFrame(6)), 'dropped_overflow');

  await session.close();
});

test('provider disconnect degrades only the auxiliary session and closes future writes', async (t) => {
  const provider = await startProvider({ closeAfterAccepted: true });
  t.after(() => provider.close());
  const events: RealtimeSpeechTranslationEvent[] = [];
  const service = serviceFor(provider.url);
  const session = await service.startSession(profile(provider.url), startInput(), (event) => {
    events.push(event);
  });

  await waitFor(() => events.some((event) => event.type === 'provider.degraded'));
  assert.equal(session.tryWriteAudio(audioFrame(1)), 'closed');
  assert.equal(events.find((event) => event.type === 'provider.degraded')?.safe_metadata.reason, 'socket_closed');
  await session.close();
});

test('provider control errors preserve retryable governance classes without leaking details', async (t) => {
  const cases = [
    {
      providerCode: 'rate_limited',
      retryable: true,
      expectedCode: 'provider_rate_limited',
      expectedStatus: 429
    },
    {
      providerCode: 'transient_failure',
      retryable: true,
      expectedCode: 'provider_transient_failure',
      expectedStatus: 503
    },
    {
      providerCode: 'invalid_request',
      retryable: false,
      expectedCode: 'provider_rejected',
      expectedStatus: 422
    },
    {
      providerCode: 'unauthorized',
      retryable: false,
      expectedCode: 'provider_auth_failed',
      expectedStatus: 502
    }
  ];

  for (const scenario of cases) {
    const provider = await startProvider({
      startError: {
        code: scenario.providerCode,
        retryable: scenario.retryable,
        message: 'private provider detail token=secret'
      }
    });
    t.after(() => provider.close());

    await assert.rejects(
      () => serviceFor(provider.url).startSession(
        profile(provider.url),
        startInput(),
        () => undefined
      ),
      (error: unknown) => {
        const value = error as {
          code?: string;
          retryable?: boolean;
          status?: number;
          message?: string;
        };
        assert.equal(value.code, scenario.expectedCode);
        assert.equal(value.retryable, scenario.retryable);
        assert.equal(value.status, scenario.expectedStatus);
        assert.doesNotMatch(String(value.message), /private|token|secret/i);
        return true;
      }
    );
  }
});

function serviceFor(endpoint: string): RealtimeSpeechTranslationService {
  const factory = createExternalRealtimeSpeechFactory({
    env: { SPEECH_TEST_TOKEN: 'speech-secret' }
  });
  return new RealtimeSpeechTranslationService({
    registry: new RealtimeSpeechTranslationRegistry({ 'speech-cloud': factory })
  });
}

function profile(
  endpoint: string,
  limits: Partial<RealtimeSpeechProviderProfile['limits']> = {}
): RealtimeSpeechProviderProfile {
  return {
    id: 'speech-cloud', tenant_id: 'tenant-a', name: 'Speech cloud', provider: 'speech-cloud',
    mode: 'self_hosted', transport: 'websocket', status: 'enabled', endpoint,
    provider_version: '2026-07', data_region: 'controlled-server',
    secret_refs: { authorization: 'env://SPEECH_TEST_TOKEN' },
    limits: {
      connect_timeout_ms: 2_000, idle_timeout_ms: 5_000,
      max_buffered_audio_ms: 200, max_session_seconds: 300, ...limits
    },
    config: {}, revision: 1
  };
}

function startInput() {
  return {
    tenant_id: 'tenant-a', interaction_id: 'interaction-a', media_session_id: 'room-a',
    media_source: 'livekit' as const, participant_id: 'participant-a', track_id: 'track-a',
    purpose: 'live_captions' as const, source_language: 'en-US', target_languages: [],
    features: ['streaming_asr' as const],
    audio_format: { encoding: 'pcm_s16le' as const, sample_rate_hz: 16_000 as const, channels: 1 as const },
    consent_ref: 'consent-a', idempotency_key: 'start-a'
  };
}

function audioFrame(
  sequence: number,
  durationMs = 20,
  audio = new Uint8Array(640)
): RealtimeAudioFrame {
  return {
    sequence,
    captured_at: '2026-07-22T08:00:00.000Z',
    duration_ms: durationMs,
    audio
  };
}

async function startProvider(options: {
  closeAfterAccepted?: boolean;
  startError?: Record<string, unknown>;
} = {}): Promise<{
  url: string;
  authorization: string;
  start: Record<string, any> | null;
  frames: ReturnType<typeof decodeRealtimeAudioEnvelope>[];
  close(): Promise<void>;
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('provider has no TCP port');
  const state = {
    url: `ws://127.0.0.1:${address.port}/v1/realtime-speech`,
    authorization: '',
    start: null as Record<string, any> | null,
    frames: [] as ReturnType<typeof decodeRealtimeAudioEnvelope>[]
  };
  server.on('connection', (socket: WebSocket, request) => {
    state.authorization = String(request.headers.authorization || '');
    socket.on('message', (data, binary) => {
      if (binary) {
        const frame = decodeRealtimeAudioEnvelope(Buffer.from(data as Buffer));
        state.frames.push(frame);
        socket.send(JSON.stringify({
          type: 'event',
          event: {
            event_id: `event-${frame.sequence}`,
            type: 'transcript.final',
            provider_session_id: 'provider-session-a',
            sequence: frame.sequence,
            occurred_at: '2026-07-22T08:00:00.100Z',
            segment_id: `segment-${frame.sequence}`,
            speaker_id: 'customer',
            source_language: 'en-US',
            source_text: 'hello',
            provider_request_id: `request-${frame.sequence}`,
            latency_ms: { final: 100 },
            metadata: { region: 'controlled-server' }
          }
        }));
        return;
      }
      const message = JSON.parse(String(data)) as Record<string, any>;
      if (message.type !== 'session.start') return;
      state.start = message;
      if (options.startError) {
        socket.send(JSON.stringify({ type: 'error', ...options.startError }));
        return;
      }
      socket.send(JSON.stringify({
        type: 'session.accepted',
        provider_session_id: 'provider-session-a',
        provider_version: '2026-07',
        max_buffered_audio_ms: message.max_buffered_audio_ms,
        capabilities: {
          streaming_asr: true, streaming_translation: false, language_detection: true,
          speaker_diarization: false, word_timestamps: true
        }
      }), () => {
        if (options.closeAfterAccepted) socket.close(1011, 'controlled outage');
      });
    });
  });
  return {
    ...state,
    get authorization() { return state.authorization; },
    get start() { return state.start; },
    frames: state.frames,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for realtime speech condition');
}
