import assert from 'node:assert/strict';
import test from 'node:test';

import { createHttpAsrProvider } from '../src/agent-runtime/collaboration/asr-provider.js';
import {
  RealtimeSpeechTranslationRegistry,
  RealtimeSpeechTranslationService,
  type StartRealtimeSpeechTranslationInput,
  type RealtimeAudioFrame,
  type RealtimeSpeechProviderPort,
  type RealtimeSpeechProviderProfile,
  type RealtimeSpeechTranslationEvent,
  type RealtimeSpeechTranslationFactory,
  type RealtimeSpeechTranslationSession
} from '../src/agent-runtime/ivekit/voice/realtime-speech-translation.js';

const profile: RealtimeSpeechProviderProfile = {
  id: 'speech-vendor-a',
  tenant_id: 'tenant-a',
  name: 'Speech vendor A',
  provider: 'vendor-a',
  mode: 'third_party',
  transport: 'websocket',
  status: 'enabled',
  endpoint: 'wss://speech.vendor.example/v1/realtime',
  provider_version: '2026-07',
  data_region: 'ap-southeast',
  secret_refs: { api_key: 'env://SPEECH_VENDOR_A_API_KEY' },
  limits: {
    connect_timeout_ms: 5_000,
    idle_timeout_ms: 30_000,
    max_buffered_audio_ms: 1_000,
    max_session_seconds: 14_400
  },
  config: {},
  revision: 1
};

test('realtime speech port accepts RustPBX and LiveKit audio without owning the media path', async () => {
  const events: RealtimeSpeechTranslationEvent[] = [];
  const factory = new ControlledSpeechFactory();
  const registry = new RealtimeSpeechTranslationRegistry({ 'vendor-a': factory });
  const service = new RealtimeSpeechTranslationService({ registry });

  const session = await service.startSession(profile, {
    tenant_id: 'tenant-a',
    interaction_id: 'interaction-a',
    media_session_id: 'room-a',
    media_source: 'livekit',
    participant_id: 'participant-a',
    track_id: 'track-a',
    purpose: 'live_translation',
    source_language: 'auto',
    target_languages: ['zh-cn', 'en-us', 'zh-CN'],
    features: ['streaming_asr', 'streaming_translation', 'language_detection'],
    audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 },
    consent_ref: 'consent-a',
    idempotency_key: 'start-a'
  }, (event) => events.push(event));

  assert.deepEqual(factory.started?.target_languages, ['zh-CN', 'en-US']);
  assert.equal(factory.started?.media_source, 'livekit');
  assert.equal(session.plan.max_buffered_audio_ms, 1_000);
  assert.equal(session.tryWriteAudio(audioFrame(1)), 'accepted');
  assert.equal(factory.frames.length, 1);
  assert.throws(
    () => session.tryWriteAudio(audioFrame(1)),
    (error: any) => error?.code === 'event_sequence_conflict'
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'translation.final');
  assert.equal(events[0].translated_text, '你好');
  assert.deepEqual(events[0].safe_metadata, { stable: 'ok' });

  await session.end({ reason: 'call_ended', idempotency_key: 'end-a' });
  assert.equal(session.tryWriteAudio(audioFrame(2)), 'closed');
  await session.close();
});

test('realtime speech profile requires encrypted third-party transport and env secret refs', async () => {
  const registry = new RealtimeSpeechTranslationRegistry({ 'vendor-a': new ControlledSpeechFactory() });
  const service = new RealtimeSpeechTranslationService({ registry });
  const input: StartRealtimeSpeechTranslationInput = {
    tenant_id: 'tenant-a', interaction_id: 'interaction-a', media_session_id: 'call-a',
    media_source: 'rustpbx' as const, participant_id: 'participant-a', track_id: 'track-a',
    purpose: 'live_captions' as const, source_language: 'zh-CN', target_languages: [],
    features: ['streaming_asr'],
    audio_format: { encoding: 'pcmu' as const, sample_rate_hz: 8_000, channels: 1 as const },
    consent_ref: 'consent-a', idempotency_key: 'start-a'
  };

  await assert.rejects(
    () => service.startSession({ ...profile, endpoint: 'ws://speech.vendor.example/realtime' }, input, () => undefined),
    (error: any) => error?.code === 'validation_failed'
  );
  await assert.rejects(
    () => service.startSession({
      ...profile,
      secret_refs: { api_key: 'plain-text-secret' }
    }, input, () => undefined),
    (error: any) => error?.code === 'secret_ref_invalid'
  );
});

test('offline external ASR accepts bounded diarized segments for quality review', async () => {
  const provider = createHttpAsrProvider({
    mode: 'third_party',
    baseUrl: 'https://asr.vendor.example',
    token: 'provider-secret',
    fetch: async () => new Response(JSON.stringify({
      text: 'hello 你好',
      language: 'en-US',
      confidence: 0.94,
      segments: [
        {
          segment_id: 'segment-1', speaker_id: 'customer', start_ms: 0, end_ms: 820,
          text: 'hello', language: 'en-US', confidence: 0.96,
          words: [{ text: 'hello', start_ms: 0, end_ms: 800, confidence: 0.96 }]
        },
        {
          segment_id: 'segment-2', speaker_id: 'agent', start_ms: 900, end_ms: 1_500,
          text: '你好', language: 'zh-CN', confidence: 0.92
        }
      ]
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });

  const result = await provider.extract({
    attachment_id: 'recording-a', tenant_id: 'tenant-a', session_id: 'session-a',
    message_id: 'message-a', filename: 'recording.wav', content_type: 'audio/wav',
    source_ref: 'ivekit://attachment/recording-a', content: Buffer.from('audio')
  });

  assert.equal(result.speech_segments?.length, 2);
  assert.deepEqual(result.speech_segments?.map((segment) => [
    segment.segment_id, segment.speaker_id, segment.start_ms, segment.end_ms
  ]), [
    ['segment-1', 'customer', 0, 820],
    ['segment-2', 'agent', 900, 1_500]
  ]);
  assert.equal(result.speech_segments?.[0].words?.[0].text, 'hello');
});

class ControlledSpeechFactory implements RealtimeSpeechTranslationFactory {
  started: Record<string, unknown> | null = null;
  frames: RealtimeAudioFrame[] = [];

  async create(): Promise<RealtimeSpeechProviderPort> {
    return {
      preflight: async () => ({
        provider: 'vendor-a', provider_version: '2026-07', checked_at: new Date(0).toISOString(),
        capabilities: {
          streaming_asr: true, streaming_translation: true, language_detection: true,
          speaker_diarization: true, word_timestamps: true
        }
      }),
      startSession: async (input, emit) => {
        this.started = structuredClone(input) as unknown as Record<string, unknown>;
        emit({
          event_id: 'event-a', type: 'translation.final', provider_session_id: 'provider-session-a',
          sequence: 1, occurred_at: '2026-07-22T00:00:00.000Z', segment_id: 'segment-a',
          speaker_id: 'customer', source_language: 'en-US', target_language: 'zh-CN',
          source_text: 'hello', translated_text: '你好', confidence: 0.95,
          start_ms: 0, end_ms: 800,
          metadata: { stable: 'ok', raw_audio: 'must-not-survive', transcript: 'must-not-survive' }
        });
        const session: RealtimeSpeechTranslationSession = {
          plan: {
            provider_session_id: 'provider-session-a', provider: 'vendor-a',
            provider_version: '2026-07', max_buffered_audio_ms: 1_000,
            capabilities: {
              streaming_asr: true, streaming_translation: true, language_detection: true,
              speaker_diarization: true, word_timestamps: true
            }
          },
          tryWriteAudio: (frame) => {
            this.frames.push(frame);
            return 'accepted';
          },
          end: async () => undefined,
          close: async () => undefined
        };
        return session;
      },
      close: async () => undefined
    };
  }
}

function audioFrame(sequence: number): RealtimeAudioFrame {
  return {
    sequence,
    captured_at: '2026-07-22T00:00:00.000Z',
    duration_ms: 20,
    audio: new Uint8Array(640)
  };
}
