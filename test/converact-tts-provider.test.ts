import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TtsProviderError,
  createHttpTtsProvider
} from '../src/agent-runtime/collaboration/tts-provider.js';

test('TTS provider sends bounded JSON and returns normalized audio chunks', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createHttpTtsProvider({
    mode: 'third_party', baseUrl: 'https://tts.example.test', endpoint: '/v2/speech',
    token: 'tts-secret', profileId: 'tts-cloud', providerVersion: '2026-07',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse({
        audio_base64: Buffer.from([1, 2, 3, 4]).toString('base64'),
        audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 },
        duration_ms: 20,
        provider_request_id: ' request id ',
        metadata: { model: 'voice-v3', authorization: 'must-drop', note: 'tts-secret' }
      });
    }
  });

  const result = await provider.synthesize(validInput());
  const chunks = await collect(result.audio);
  assert.equal(requests[0]?.url, 'https://tts.example.test/v2/speech');
  assert.equal(new Headers(requests[0]?.init?.headers).get('authorization'), 'Bearer tts-secret');
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    text: 'hello', language: 'en-US', voice: 'neutral-a',
    audio_format: { encoding: 'pcm_s16le', sample_rate_hz: 16_000, channels: 1 },
    idempotency_key: 'tts-a'
  });
  assert.equal(result.profile_id, 'tts-cloud');
  assert.equal(result.provider_version, '2026-07');
  assert.equal(result.provider_request_id, 'request_id');
  assert.deepEqual(result.metadata, { model: 'voice-v3' });
  assert.deepEqual(chunks, [{ sequence: 0, duration_ms: 20, audio: Buffer.from([1, 2, 3, 4]) }]);
});

test('TTS provider consumes bounded SSE audio incrementally without buffering the whole response', async () => {
  const encoder = new TextEncoder();
  const events = [
    'event: metadata\ndata: {"provider_request_id":"stream-a","audio_format":{"encoding":"pcm_s16le","sample_rate_hz":16000,"channels":1}}\n\n',
    `event: audio\ndata: {"sequence":0,"duration_ms":20,"audio_base64":"${Buffer.from([1, 2]).toString('base64')}"}\n\n`,
    `event: audio\ndata: {"sequence":1,"duration_ms":20,"audio_base64":"${Buffer.from([3, 4]).toString('base64')}"}\n\n`,
    'event: done\ndata: {}\n\n'
  ];
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls >= events.length) return controller.close();
      controller.enqueue(encoder.encode(events[pulls++]));
    }
  });
  const provider = createHttpTtsProvider({
    mode: 'self_hosted', baseUrl: 'http://tts-worker:8080',
    fetch: async () => new Response(body, {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    })
  });

  const result = await provider.synthesize(validInput());
  assert.equal(pulls <= 1, true);
  const iterator = result.audio[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), {
    done: false, value: { sequence: 0, duration_ms: 20, audio: Buffer.from([1, 2]) }
  });
  assert.equal(pulls < events.length, true);
  assert.deepEqual(await iterator.next(), {
    done: false, value: { sequence: 1, duration_ms: 20, audio: Buffer.from([3, 4]) }
  });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  assert.equal(result.provider_request_id, 'stream-a');
});

test('TTS provider propagates caller cancellation and classifies bounded failures safely', async () => {
  const caller = new AbortController();
  let downstreamAborted = false;
  const provider = createHttpTtsProvider({
    mode: 'self_hosted', baseUrl: 'http://tts-worker:8080', timeoutMs: 5_000,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        downstreamAborted = true;
        reject(new Error('private downstream cancellation detail'));
      }, { once: true });
    })
  });
  const pending = provider.synthesize({ ...validInput(), signal: caller.signal });
  caller.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof TtsProviderError && error.code === 'provider_cancelled'
  );
  assert.equal(downstreamAborted, true);

  const oversized = createHttpTtsProvider({
    mode: 'self_hosted', baseUrl: 'http://tts-worker:8080',
    fetch: async () => jsonResponse({ audio_base64: 'A'.repeat(6_000_000) }, {
      'content-length': '6000000'
    })
  });
  await assert.rejects(
    () => oversized.synthesize(validInput()),
    (error: unknown) => (error as TtsProviderError).code === 'provider_response_too_large'
  );

  let calls = 0;
  const invalid = createHttpTtsProvider({
    mode: 'self_hosted', baseUrl: 'http://tts-worker:8080',
    fetch: async () => { calls += 1; return jsonResponse({}); }
  });
  await assert.rejects(
    () => invalid.synthesize({ ...validInput(), text: 'x'.repeat(100_001) }),
    (error: unknown) => (error as TtsProviderError).code === 'tts_text_too_large'
  );
  assert.equal(calls, 0);
});

function validInput() {
  return {
    tenant_id: 'tenant-a', interaction_id: 'interaction-a', text: 'hello',
    language: 'en-US', voice: 'neutral-a',
    audio_format: { encoding: 'pcm_s16le' as const, sample_rate_hz: 16_000 as const, channels: 1 as const },
    idempotency_key: 'tts-a'
  };
}

async function collect<T>(input: AsyncIterable<T>): Promise<T[]> {
  const output: T[] = [];
  for await (const item of input) output.push(item);
  return output;
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  });
}
