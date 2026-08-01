import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import { MemoryPg } from '../src/db-pg.js';
import { IntelligenceProviderGovernanceStore } from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { IntelligencePolicyStore } from '../src/agent-runtime/collaboration/intelligence-policy-store.js';
import {
  createExternalRealtimeSpeechFactory,
  decodeRealtimeAudioEnvelope
} from '../src/agent-runtime/converact/voice/adapters/external-realtime-speech.js';
import {
  createPolicyRealtimeSpeechRouter
} from '../src/agent-runtime/converact/voice/realtime-speech-routing.js';
import {
  RealtimeSpeechTranslationRegistry,
  RealtimeSpeechTranslationService,
  type RealtimeAudioFrame,
  type RealtimeSpeechProviderProfile,
  type RealtimeSpeechTranslationEvent
} from '../src/agent-runtime/converact/voice/realtime-speech-translation.js';

const CONTROLLED_TOKEN = 'controlled-realtime-token';
const TENANT_ID = 'tenant-controlled-realtime';

type ControlledRealtimeProviderMode =
  | 'success'
  | 'rate_limited'
  | 'transient_failure'
  | 'terminal_failure'
  | 'auth_failure'
  | 'protocol_mismatch'
  | 'timeout'
  | 'disconnect_after_accept';

export interface ConveractFabricRealtimeSpeechProviderAcceptanceCheck {
  name: string;
  status: 'passed' | 'failed';
  code: string;
}

export interface ConveractFabricRealtimeSpeechProviderAcceptanceReport {
  status: 'passed' | 'failed';
  verification_scope: 'controlled_loopback_realtime_provider';
  real_vendor_evidence: false;
  checks: ConveractFabricRealtimeSpeechProviderAcceptanceCheck[];
}

export async function runConveractFabricRealtimeSpeechProviderAcceptance():
Promise<ConveractFabricRealtimeSpeechProviderAcceptanceReport> {
  const checks: ConveractFabricRealtimeSpeechProviderAcceptanceCheck[] = [];
  await runCheck(checks, 'success_binary_audio', checkSuccessBinaryAudio);
  await runCheck(checks, 'rate_limited_429', () => checkStartError(
    'rate_limited', 'provider_rate_limited', true, 429
  ));
  await runCheck(checks, 'transient_5xx', () => checkStartError(
    'transient_failure', 'provider_transient_failure', true, 503
  ));
  await runCheck(checks, 'terminal_rejected', () => checkStartError(
    'terminal_failure', 'provider_rejected', false, 422
  ));
  await runCheck(checks, 'auth_failed', () => checkStartError(
    'auth_failure', 'provider_auth_failed', false, 502
  ));
  await runCheck(checks, 'protocol_mismatch', () => checkStartError(
    'protocol_mismatch', 'protocol_mismatch', false, 502
  ));
  await runCheck(checks, 'startup_timeout', () => checkStartError(
    'timeout', 'provider_timeout', true, 504
  ));
  await runCheck(checks, 'bounded_audio_overflow', checkBoundedAudioOverflow);
  await runCheck(checks, 'startup_failover', checkStartupFailover);
  await runCheck(checks, 'terminal_no_failover', checkTerminalNoFailover);
  await runCheck(
    checks,
    'established_disconnect_no_failover',
    checkEstablishedDisconnectNoFailover
  );

  return {
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    verification_scope: 'controlled_loopback_realtime_provider',
    real_vendor_evidence: false,
    checks
  };
}

async function checkSuccessBinaryAudio(): Promise<void> {
  await withProvider('success', async (provider) => {
    const events: RealtimeSpeechTranslationEvent[] = [];
    const session = await directService(provider.url).startSession(
      directProfile(provider.url),
      startInput(),
      (event) => events.push(event)
    );
    try {
      required(provider.authorization === `Bearer ${CONTROLLED_TOKEN}`);
      required(session.tryWriteAudio(audioFrame(1)) === 'accepted');
      await waitFor(() => provider.frames.length === 1 && events.some(
        (event) => event.type === 'transcript.final'
      ));
      required(provider.frames[0]?.sequence === 1);
      required(provider.frames[0]?.audio.byteLength === 640);
      required(events.find((event) => event.type === 'transcript.final')?.source_text === 'hello');
    } finally {
      await session.close();
    }
  });
}

async function checkStartError(
  mode: ControlledRealtimeProviderMode,
  expectedCode: string,
  expectedRetryable: boolean,
  expectedStatus: number
): Promise<void> {
  await withProvider(mode, async (provider) => {
    const error = await capturedError(() => directService(provider.url).startSession(
      directProfile(provider.url),
      startInput(),
      () => undefined
    ));
    required(error.code === expectedCode);
    required(error.retryable === expectedRetryable);
    required(error.status === expectedStatus);
    required(!/private|token|secret/i.test(String(error.message || '')));
  });
}

async function checkBoundedAudioOverflow(): Promise<void> {
  await withProvider('success', async (provider) => {
    const session = await directService(provider.url).startSession(
      directProfile(provider.url, { max_buffered_audio_ms: 100 }),
      startInput(),
      () => undefined
    );
    try {
      const accepted = [1, 2, 3, 4, 5].map((sequence) =>
        session.tryWriteAudio(audioFrame(sequence))
      );
      required(accepted.every((result) => result === 'accepted'));
      required(session.tryWriteAudio(audioFrame(6)) === 'dropped_overflow');
    } finally {
      await session.close();
    }
  });
}

async function checkStartupFailover(): Promise<void> {
  await withRoutingScenario('transient_failure', async (scenario) => {
    const result = await scenario.router.startSession(startInput(), () => undefined);
    try {
      required(result.selected_profile_id === 'speech-fallback');
      required(result.failed_over);
      required(result.attempt_count === 2);
      required(result.attempts[0]?.code === 'provider_transient_failure');
      required(scenario.primary.starts === 1);
      required(scenario.fallback.starts === 1);
    } finally {
      await result.session.close();
    }
  });
}

async function checkTerminalNoFailover(): Promise<void> {
  await withRoutingScenario('terminal_failure', async (scenario) => {
    const error = await capturedError(() =>
      scenario.router.startSession(startInput(), () => undefined)
    );
    required(error.code === 'provider_rejected');
    required(error.retryable === false);
    required(scenario.primary.starts === 1);
    required(scenario.fallback.starts === 0);
  });
}

async function checkEstablishedDisconnectNoFailover(): Promise<void> {
  await withRoutingScenario('disconnect_after_accept', async (scenario) => {
    const events: RealtimeSpeechTranslationEvent[] = [];
    const result = await scenario.router.startSession(
      startInput(),
      (event) => events.push(event)
    );
    try {
      required(result.selected_profile_id === 'speech-primary');
      await waitFor(() => events.some((event) => event.type === 'provider.degraded'));
      required(result.session.tryWriteAudio(audioFrame(1)) === 'closed');
      required(scenario.fallback.starts === 0);
      required(events.find(
        (event) => event.type === 'provider.degraded'
      )?.safe_metadata.reason === 'socket_closed');
    } finally {
      await result.session.close();
    }
  });
}

function directService(endpoint: string): RealtimeSpeechTranslationService {
  const factory = createExternalRealtimeSpeechFactory({
    env: { CONTROLLED_REALTIME_SPEECH_TOKEN: CONTROLLED_TOKEN }
  });
  return new RealtimeSpeechTranslationService({
    registry: new RealtimeSpeechTranslationRegistry({
      'speech-controlled': factory
    })
  });
}

function directProfile(
  endpoint: string,
  limits: Partial<RealtimeSpeechProviderProfile['limits']> = {}
): RealtimeSpeechProviderProfile {
  return {
    id: 'speech-controlled',
    tenant_id: TENANT_ID,
    name: 'Controlled realtime speech',
    provider: 'speech-controlled',
    mode: 'self_hosted',
    transport: 'websocket',
    status: 'enabled',
    endpoint,
    provider_version: 'controlled-v1',
    data_region: 'loopback',
    secret_refs: {
      authorization: 'env://CONTROLLED_REALTIME_SPEECH_TOKEN'
    },
    limits: {
      connect_timeout_ms: 250,
      idle_timeout_ms: 1_000,
      max_buffered_audio_ms: 200,
      max_session_seconds: 30,
      ...limits
    },
    config: {},
    revision: 1
  };
}

async function withRoutingScenario(
  primaryMode: ControlledRealtimeProviderMode,
  run: (scenario: RoutingScenario) => Promise<void>
): Promise<void> {
  const primary = await startProvider(primaryMode);
  const fallback = await startProvider('success');
  try {
    const env: NodeJS.ProcessEnv = {
      CONTROLLED_REALTIME_SPEECH_TOKEN: CONTROLLED_TOKEN,
      CONVERACT_FABRIC_PROVIDER_PROFILES_JSON: JSON.stringify([
        routeProfile('speech-primary', primary.baseUrl),
        routeProfile('speech-fallback', fallback.baseUrl)
      ])
    };
    const pg = new MemoryPg();
    const registry = createIntelligenceProviderRegistry(env);
    const governance = new IntelligenceProviderGovernanceStore(pg);
    await new IntelligencePolicyStore(pg, registry).updatePolicy({
      tenant_id: TENANT_ID,
      actor_identity: 'controlled-acceptance',
      expected_version: 0,
      policy: {
        ocr_enabled: false,
        asr_enabled: false,
        quality_review_enabled: false,
        translation_enabled: false,
        realtime_speech_enabled: true,
        realtime_speech_profile_ids: ['speech-primary', 'speech-fallback'],
        allow_third_party: true,
        auto_ocr: false,
        auto_asr: false,
        auto_quality_review: false,
        auto_translation: false,
        translation_target_languages: [],
        min_ocr_confidence: 0,
        min_asr_confidence: 0
      }
    });
    await run({
      primary,
      fallback,
      router: createPolicyRealtimeSpeechRouter({
        pg,
        registry,
        governance,
        env
      })
    });
  } finally {
    await Promise.all([primary.close(), fallback.close()]);
  }
}

function routeProfile(id: string, baseUrl: string): Record<string, unknown> {
  return {
    id,
    capability: 'realtime_speech',
    mode: 'self_hosted',
    base_url: baseUrl,
    endpoint: '/v1/realtime-speech',
    token_env: 'CONTROLLED_REALTIME_SPEECH_TOKEN',
    timeout_ms: 1_000,
    reservation_ttl_ms: 6_000,
    max_concurrency: 10,
    failure_threshold: 3,
    adapter: 'ivekit_realtime_speech_v1',
    provider_version: 'controlled-v1',
    data_region: 'loopback',
    max_buffered_audio_ms: 200,
    max_session_seconds: 30
  };
}

function startInput() {
  return {
    tenant_id: TENANT_ID,
    interaction_id: 'interaction-controlled',
    media_session_id: 'media-controlled',
    media_source: 'livekit' as const,
    participant_id: 'participant-controlled',
    track_id: 'track-controlled',
    purpose: 'live_captions' as const,
    source_language: 'en-US',
    target_languages: [],
    features: ['streaming_asr' as const],
    audio_format: {
      encoding: 'pcm_s16le' as const,
      sample_rate_hz: 16_000 as const,
      channels: 1 as const
    },
    consent_ref: 'consent-controlled',
    idempotency_key: 'start-controlled'
  };
}

function audioFrame(sequence: number): RealtimeAudioFrame {
  return {
    sequence,
    captured_at: '2026-07-23T08:00:00.000Z',
    duration_ms: 20,
    audio: new Uint8Array(640)
  };
}

interface ControlledRealtimeProvider {
  url: string;
  baseUrl: string;
  readonly authorization: string;
  readonly starts: number;
  frames: ReturnType<typeof decodeRealtimeAudioEnvelope>[];
  close(): Promise<void>;
}

interface RoutingScenario {
  primary: ControlledRealtimeProvider;
  fallback: ControlledRealtimeProvider;
  router: ReturnType<typeof createPolicyRealtimeSpeechRouter>;
}

async function startProvider(
  mode: ControlledRealtimeProviderMode
): Promise<ControlledRealtimeProvider> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('controlled realtime Provider has no TCP port');
  }
  const state = {
    authorization: '',
    starts: 0,
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
            provider_session_id: 'provider-session-controlled',
            sequence: frame.sequence,
            occurred_at: '2026-07-23T08:00:00.100Z',
            segment_id: `segment-${frame.sequence}`,
            speaker_id: 'customer',
            source_language: 'en-US',
            source_text: 'hello',
            provider_request_id: `request-${frame.sequence}`,
            latency_ms: { final: 100 },
            metadata: { region: 'loopback' }
          }
        }));
        return;
      }
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type !== 'session.start') return;
      state.starts += 1;
      respondToStart(socket, mode, message);
    });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    url: `ws://127.0.0.1:${address.port}/v1/realtime-speech`,
    baseUrl,
    get authorization() {
      return state.authorization;
    },
    get starts() {
      return state.starts;
    },
    frames: state.frames,
    close: async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function respondToStart(
  socket: WebSocket,
  mode: ControlledRealtimeProviderMode,
  message: Record<string, unknown>
): void {
  if (mode === 'timeout') return;
  if (mode === 'protocol_mismatch') {
    socket.send('{');
    return;
  }
  if (mode === 'rate_limited') {
    socket.send(JSON.stringify({
      type: 'error',
      code: 'rate_limited',
      retryable: true,
      message: 'private provider detail token=secret'
    }));
    return;
  }
  if (mode === 'transient_failure') {
    socket.send(JSON.stringify({
      type: 'error',
      code: 'provider_http_503',
      retryable: true,
      message: 'private provider detail token=secret'
    }));
    return;
  }
  if (mode === 'terminal_failure') {
    socket.send(JSON.stringify({
      type: 'error',
      code: 'invalid_request',
      retryable: false,
      message: 'private provider detail token=secret'
    }));
    return;
  }
  if (mode === 'auth_failure') {
    socket.send(JSON.stringify({
      type: 'error',
      code: 'unauthorized',
      retryable: false,
      message: 'private provider detail token=secret'
    }));
    return;
  }
  socket.send(JSON.stringify({
    type: 'session.accepted',
    provider_session_id: 'provider-session-controlled',
    provider_version: 'controlled-v1',
    max_buffered_audio_ms: message.max_buffered_audio_ms,
    capabilities: {
      streaming_asr: true,
      streaming_translation: false,
      language_detection: true,
      speaker_diarization: false,
      word_timestamps: true
    }
  }), () => {
    if (mode === 'disconnect_after_accept') {
      socket.close(1011, 'controlled outage');
    }
  });
}

async function withProvider(
  mode: ControlledRealtimeProviderMode,
  run: (provider: ControlledRealtimeProvider) => Promise<void>
): Promise<void> {
  const provider = await startProvider(mode);
  try {
    await run(provider);
  } finally {
    await provider.close();
  }
}

async function capturedError(run: () => Promise<unknown>): Promise<{
  code?: string;
  retryable?: boolean;
  status?: number;
  message?: string;
}> {
  try {
    await run();
  } catch (error) {
    return error as {
      code?: string;
      retryable?: boolean;
      status?: number;
      message?: string;
    };
  }
  throw new Error('controlled acceptance expected Provider failure');
}

async function runCheck(
  checks: ConveractFabricRealtimeSpeechProviderAcceptanceCheck[],
  name: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
    checks.push({ name, status: 'passed', code: '' });
  } catch {
    checks.push({ name, status: 'failed', code: 'acceptance_check_failed' });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for controlled realtime Provider condition');
}

function required(condition: unknown): asserts condition {
  if (!condition) throw new Error('controlled realtime Provider acceptance assertion failed');
}

async function main(): Promise<void> {
  const report = await runConveractFabricRealtimeSpeechProviderAcceptance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
