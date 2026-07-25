import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { dirname } from 'node:path';

import {
  LiveKitRealtimeAudioTapGateway
} from '../../../../src/agent-runtime/ivekit/voice/livekit-realtime-audio-tap-gateway.js';
import {
  createLiveKitRealtimeAudioTapTokenCodec
} from '../../../../src/agent-runtime/ivekit/voice/livekit-realtime-audio-tap-token.js';
import type { PolicyRealtimeSpeechRouter } from '../../../../src/agent-runtime/ivekit/voice/realtime-speech-routing.js';
import type {
  RealtimeAudioFrame,
  RealtimeSpeechTranslationSession
} from '../../../../src/agent-runtime/ivekit/voice/realtime-speech-translation.js';

const host = ipv4Env('GATEWAY_HOST');
const gatewayPort = integerEnv('GATEWAY_PORT', 0, 65_535);
const authorizationPort = integerEnv('AUTHORIZATION_PORT', 0, 65_535);
const eventsFile = requiredEnv('GATEWAY_EVENTS_FILE');
const gatewayReadyFile = requiredEnv('GATEWAY_READY_FILE');
const runId = safeRunId(requiredEnv('RUN_ID'));
const secret = Buffer.from(requiredEnv('GATEWAY_SECRET_B64'), 'base64');
if (secret.byteLength !== 32) throw new Error('gateway_secret_invalid');

mkdirSync(dirname(eventsFile), { recursive: true });
const codec = createLiveKitRealtimeAudioTapTokenCodec({ secret, ttl_seconds: 45 });
const router: PolicyRealtimeSpeechRouter = {
  async startSession(input) {
    const session = new ControlledSession(eventsFile);
    appendEvent(eventsFile, {
      type: 'session_started',
      pid: process.pid,
      participant_id: input.participant_id
    });
    return {
      session,
      selected_profile_id: 'speech-recovery',
      attempt_count: 1,
      failed_over: false,
      attempts: []
    };
  }
};
const gateway = new LiveKitRealtimeAudioTapGateway({
  listen_host: host,
  listen_port: gatewayPort,
  path: '/audio-tap',
  token_codec: codec,
  router,
  max_connections: 8,
  max_prestart_audio_ms: 100,
  idle_timeout_ms: 10_000,
  start_timeout_ms: 1_000,
  shutdown_timeout_ms: 500
});

await gateway.start();
const actualGatewayPort = gateway.address()?.port;
if (!actualGatewayPort) throw new Error('gateway_address_unavailable');

const authorizationServer = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/ready') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ready', run_id: runId, pid: process.pid }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/authorize') {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  const token = codec.issue({
    tenant_id: 'tenant-realtime-recovery',
    interaction_id: 'interaction-realtime-recovery',
    media_session_id: 'room-realtime-recovery',
    participant_id: 'customer-realtime-recovery',
    track_id: 'TR_realtime_recovery',
    purpose: 'live_translation',
    consent_ref: 'consent-realtime-recovery',
    source_language: 'en',
    target_languages: ['zh-CN'],
    features: ['streaming_asr', 'streaming_translation'],
    audience_user_ids: ['agent-realtime-recovery']
  });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    token,
    gateway_url: `ws://${host}:${actualGatewayPort}/audio-tap`,
    protocol: 'ivekit.livekit-audio-tap.v1',
    audio: {
      encoding: 'pcm_s16le',
      sample_rate: 16_000,
      channels: 1
    }
  }));
});

await new Promise<void>((resolve, reject) => {
  authorizationServer.once('error', reject);
  authorizationServer.listen(authorizationPort, host, resolve);
});
const authorizationAddress = authorizationServer.address();
if (!authorizationAddress || typeof authorizationAddress === 'string') {
  throw new Error('authorization_address_unavailable');
}
writeFileSync(gatewayReadyFile, `${JSON.stringify({
  run_id: runId,
  pid: process.pid,
  gateway_port: actualGatewayPort,
  authorization_port: authorizationAddress.port
})}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
appendEvent(eventsFile, { type: 'gateway_ready', pid: process.pid, run_id: runId });
process.stdout.write(`gateway_ready pid=${process.pid} run_id=${runId}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([
    gateway.close(),
    new Promise<void>((resolve) => authorizationServer.close(() => resolve()))
  ]);
}

process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
process.once('SIGINT', () => void stop().finally(() => process.exit(0)));

class ControlledSession implements RealtimeSpeechTranslationSession {
  readonly plan = {
    provider_session_id: `provider-session-${process.pid}`,
    provider: 'controlled-process-recovery',
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

  constructor(private readonly outputFile: string) {}

  tryWriteAudio(frame: RealtimeAudioFrame): 'accepted' {
    appendEvent(this.outputFile, {
      type: 'audio_frame',
      pid: process.pid,
      sequence: frame.sequence,
      duration_ms: frame.duration_ms
    });
    return 'accepted';
  }

  async end(): Promise<void> {}

  async close(): Promise<void> {}
}

function appendEvent(path: string, event: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify(event)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
}

function requiredEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnv(name: string, minimum: number, maximum: number): number {
  const value = Number(requiredEnv(name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function ipv4Env(name: string): string {
  const value = requiredEnv(name);
  if (isIP(value) !== 4) throw new Error(`${name} is invalid`);
  return value;
}

function safeRunId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new Error('RUN_ID is invalid');
  return value;
}
