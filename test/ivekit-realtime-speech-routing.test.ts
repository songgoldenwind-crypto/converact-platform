import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { IntelligenceProviderGovernanceStore } from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { IntelligenceProviderRouteError } from '../src/agent-runtime/collaboration/intelligence-provider-route.js';
import { IntelligencePolicyStore } from '../src/agent-runtime/collaboration/intelligence-policy-store.js';
import { VoiceError } from '../src/agent-runtime/ivekit/voice/errors.js';
import {
  createPolicyRealtimeSpeechRouter
} from '../src/agent-runtime/ivekit/voice/realtime-speech-routing.js';
import type {
  RealtimeAudioFrame,
  RealtimeSpeechProviderPort,
  RealtimeSpeechProviderProfile,
  RealtimeSpeechTranslationEvent,
  RealtimeSpeechTranslationFactory,
  RealtimeSpeechTranslationSession
} from '../src/agent-runtime/ivekit/voice/realtime-speech-translation.js';

test('realtime speech route fails over only while starting and holds the selected lease', async () => {
  const fixture = await routingFixture({ max_concurrency: 1 });
  fixture.primary.startError = new VoiceError({
    code: 'provider_timeout', retryable: true, status: 504
  });
  const result = await fixture.router.startSession(startInput(), () => undefined);

  assert.deepEqual(fixture.primary.started, ['interaction-a']);
  assert.deepEqual(fixture.fallback.started, ['interaction-a']);
  assert.equal(result.selected_profile_id, 'speech-fallback');
  assert.equal(result.attempt_count, 2);
  assert.equal(result.failed_over, true);
  assert.deepEqual(result.attempts, [
    { profile_id: 'speech-primary', status: 'retryable_failure', code: 'provider_timeout' },
    { profile_id: 'speech-fallback', status: 'succeeded', code: '' }
  ]);

  await assert.rejects(
    () => fixture.router.startSession({
      ...startInput(), interaction_id: 'interaction-b', idempotency_key: 'start-b'
    }, () => undefined),
    (error: unknown) => {
      assert.equal(error instanceof IntelligenceProviderRouteError, true);
      assert.equal((error as IntelligenceProviderRouteError).attempts.at(-1)?.code, 'concurrency_exhausted');
      return true;
    }
  );
  await result.session.close();
  fixture.primary.startError = null;
  const afterClose = await fixture.router.startSession({
    ...startInput(), interaction_id: 'interaction-c', idempotency_key: 'start-c'
  }, () => undefined);
  await afterClose.session.close();
});

test('realtime speech route renews a long session lease without spending request quota', async () => {
  const fixture = await routingFixture({ route: ['speech-primary'], lease_renew_interval_ms: 10 });
  let renewals = 0;
  const renew = fixture.governance.renew.bind(fixture.governance);
  fixture.governance.renew = async (input) => {
    renewals += 1;
    return renew(input);
  };

  const result = await fixture.router.startSession(startInput(), () => undefined);
  await waitFor(() => renewals > 0);
  const runtime = await fixture.governance.listRuntime('tenant-route');
  assert.equal(runtime[0]?.minute_request_count, 1);
  assert.equal(runtime[0]?.day_request_count, 1);
  await result.session.end({ reason: 'call_ended', idempotency_key: 'end-a' });
  await result.session.close();
});

test('provider degradation never switches an established media tap to another provider', async () => {
  const fixture = await routingFixture({ failure_threshold: 1 });
  const events: RealtimeSpeechTranslationEvent[] = [];
  const result = await fixture.router.startSession(startInput(), (event) => events.push(event));

  fixture.primary.degrade('socket_closed');
  assert.equal(result.session.tryWriteAudio(audioFrame(1)), 'closed');
  assert.equal(fixture.fallback.started.length, 0);
  assert.equal(events.at(-1)?.type, 'provider.degraded');
  assert.equal(events.at(-1)?.safe_metadata.reason, 'socket_closed');
  await result.session.close();

  const runtime = await fixture.governance.listRuntime('tenant-route');
  assert.equal(runtime.find((item) => item.profile_id === 'speech-primary')?.circuit_state, 'open');
});

test('terminal realtime speech start errors never fail over', async () => {
  const fixture = await routingFixture();
  fixture.primary.startError = new VoiceError({
    code: 'provider_auth_failed', retryable: false, status: 502
  });
  await assert.rejects(
    () => fixture.router.startSession(startInput(), () => undefined),
    (error: unknown) => (error as VoiceError).code === 'provider_auth_failed'
  );
  assert.equal(fixture.fallback.started.length, 0);
});

async function routingFixture(options: {
  route?: string[];
  max_concurrency?: number;
  failure_threshold?: number;
  lease_renew_interval_ms?: number;
} = {}) {
  const env: NodeJS.ProcessEnv = {
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      providerProfile('speech-primary', 'primary-adapter', options),
      providerProfile('speech-fallback', 'fallback-adapter', options)
    ])
  };
  const pg = new MemoryPg();
  const registry = createIntelligenceProviderRegistry(env);
  const governance = new IntelligenceProviderGovernanceStore(pg);
  const route = options.route ?? ['speech-primary', 'speech-fallback'];
  await new IntelligencePolicyStore(pg, registry).updatePolicy({
    tenant_id: 'tenant-route', actor_identity: 'owner-a', expected_version: 0,
    policy: {
      ocr_enabled: false, asr_enabled: false, quality_review_enabled: false,
      translation_enabled: false, realtime_speech_enabled: true,
      realtime_speech_profile_ids: route,
      allow_third_party: true, auto_ocr: false, auto_asr: false,
      auto_quality_review: false, auto_translation: false,
      translation_target_languages: [], min_ocr_confidence: 0, min_asr_confidence: 0
    }
  });
  const primary = new ControlledSpeechFactory();
  const fallback = new ControlledSpeechFactory();
  const router = createPolicyRealtimeSpeechRouter({
    pg,
    registry,
    governance,
    adapters: { 'primary-adapter': primary, 'fallback-adapter': fallback },
    ...(options.lease_renew_interval_ms
      ? { lease_renew_interval_ms: options.lease_renew_interval_ms }
      : {})
  });
  return { pg, registry, governance, router, primary, fallback };
}

function providerProfile(
  id: string,
  adapter: string,
  options: { max_concurrency?: number; failure_threshold?: number }
) {
  return {
    id, capability: 'realtime_speech', mode: 'self_hosted',
    base_url: `http://${id}:8080`, endpoint: '/v1/realtime-speech',
    timeout_ms: 1_000, reservation_ttl_ms: 5_000,
    max_concurrency: options.max_concurrency ?? 10,
    failure_threshold: options.failure_threshold ?? 3,
    adapter, provider_version: 'controlled-v1', data_region: 'test',
    max_buffered_audio_ms: 100, max_session_seconds: 300
  };
}

class ControlledSpeechFactory implements RealtimeSpeechTranslationFactory {
  readonly started: string[] = [];
  startError: Error | null = null;
  #emit: ((event: unknown) => void) | null = null;
  #closed = false;
  #profile: RealtimeSpeechProviderProfile | null = null;

  async create(profile: RealtimeSpeechProviderProfile): Promise<RealtimeSpeechProviderPort> {
    this.#profile = profile;
    return {
      preflight: async () => ({
        provider: profile.provider, provider_version: profile.provider_version,
        checked_at: new Date().toISOString(), capabilities: capabilities()
      }),
      startSession: async (input, emit) => {
        this.started.push(input.interaction_id);
        if (this.startError) throw this.startError;
        this.#emit = emit;
        this.#closed = false;
        const session: RealtimeSpeechTranslationSession = {
          plan: {
            provider_session_id: `${profile.id}-session-${this.started.length}`,
            provider: profile.provider, provider_version: profile.provider_version,
            max_buffered_audio_ms: profile.limits.max_buffered_audio_ms,
            capabilities: capabilities()
          },
          tryWriteAudio: () => this.#closed ? 'closed' : 'accepted',
          end: async () => { this.#closed = true; },
          close: async () => { this.#closed = true; }
        };
        return session;
      },
      close: async () => undefined
    };
  }

  degrade(reason: string): void {
    if (!this.#emit || !this.#profile) throw new Error('provider session not started');
    this.#closed = true;
    this.#emit({
      event_id: 'degraded-a', type: 'provider.degraded',
      provider_session_id: `${this.#profile.id}-session-${this.started.length}`,
      sequence: 0, occurred_at: new Date().toISOString(), segment_id: '', speaker_id: '',
      source_language: 'en-US', target_language: '', source_text: '', translated_text: '',
      provider_request_id: '', latency_ms: {}, metadata: { reason }
    });
  }
}

function startInput() {
  return {
    tenant_id: 'tenant-route', interaction_id: 'interaction-a', media_session_id: 'room-a',
    media_source: 'livekit' as const, participant_id: 'participant-a', track_id: 'track-a',
    purpose: 'live_captions' as const, source_language: 'en-US', target_languages: [],
    features: ['streaming_asr' as const],
    audio_format: { encoding: 'pcm_s16le' as const, sample_rate_hz: 16_000 as const, channels: 1 as const },
    consent_ref: 'consent-a', idempotency_key: 'start-a'
  };
}

function audioFrame(sequence: number): RealtimeAudioFrame {
  return {
    sequence, captured_at: new Date().toISOString(), duration_ms: 20,
    audio: new Uint8Array(640)
  };
}

function capabilities() {
  return {
    streaming_asr: true, streaming_translation: true, language_detection: true,
    speaker_diarization: true, word_timestamps: true
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for realtime route condition');
}
