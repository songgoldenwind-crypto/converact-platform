import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import test from 'node:test';

import {
  createControlledProviderState,
  handleControlledProviderRequest,
  startControlledIntelligenceProvider
} from '../scripts/ivekit-controlled-provider.js';
import { createHttpAttachmentTextProvider } from '../src/agent-runtime/collaboration/attachment-text-provider.js';

test('controlled provider implements health, OCR, ASR, quality, and translation contracts', async () => {
  const state = createControlledProviderState({ token: 'controlled-secret' });
  const unauthorized = await request(state, '/v1/translate', { text: 'private source' }, false);
  assert.equal(unauthorized.status, 401);
  assert.doesNotMatch(unauthorized.body, /controlled-secret|private source/);

  const health = await request(state, '/health', {}, false, 'GET');
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', service: 'ivekit-controlled-provider' });
  for (const capability of ['ocr', 'asr']) {
    const response = await request(state, `/v1/${capability}`, {
      source_ref: 'ivekit://attachment/source-1',
      media_mode: capability === 'ocr' ? 'video_frame_sampling' : 'text'
    });
    const body = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.match(body.text, new RegExp(`controlled ${capability}`));
    assert.equal(body.confidence, 0.99);
    assert.doesNotMatch(response.body, /controlled-secret/);
    if (capability === 'ocr') {
      assert.deepEqual(body.observations.map((item: Record<string, unknown>) => [
        item.type, item.symbology, item.frame_timestamp_ms
      ]), [
        ['qr_code', 'QR_CODE', 2_000],
        ['barcode', 'CODE_128', 4_000]
      ]);
    }
  }

  const quality = await request(state, '/v1/quality-review', { content_hash: 'hash-1' });
  assert.equal(JSON.parse(quality.body).findings[0].policy_type, 'controlled_contact_exchange');

  const translation = await request(state, '/v1/translate', {
    source_ref: 'ivekit://message/message-1', text: 'hello', source_language: 'auto', target_language: 'zh-CN'
  });
  assert.equal(JSON.parse(translation.body).translated_text, '[zh-CN] hello');
  assert.equal(JSON.parse(translation.body).detected_language, 'en-US');
});

test('controlled provider deterministically selects timeout, transient, terminal, invalid, and oversized responses', async () => {
  const state = createControlledProviderState();
  const cases = [
    ['timeout', 200, 65_000],
    ['rate_limited', 429, 0],
    ['transient_failure', 503, 0],
    ['terminal_failure', 422, 0],
    ['invalid_json', 200, 0],
    ['oversized_response', 200, 0]
  ] as const;
  for (const [mode, status, delayMs] of cases) {
    state.mode = mode;
    const response = await request(state, '/v1/translate', { text: 'private source', target_language: 'en-US' });
    assert.equal(response.status, status, mode);
    assert.equal(response.delay_ms, delayMs, mode);
    if (mode === 'invalid_json') assert.throws(() => JSON.parse(response.body));
    if (mode === 'oversized_response') assert.ok(Buffer.byteLength(response.body) > 1_048_576);
    assert.doesNotMatch(response.body.slice(0, 2_000), /private source/);
  }
});

test('controlled provider exposes an oversized observation fixture', async () => {
  const state = createControlledProviderState({ mode: 'oversized_observations' });
  const response = await request(state, '/v1/ocr', { media_mode: 'video_frame_sampling' });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).observations.length, 501);
});

test('controlled provider serves the real multipart video OCR boundary', async () => {
  const port = await unusedLocalPort();
  const state = createControlledProviderState({
    token: 'http-provider-secret',
    controlToken: 'http-control-secret'
  });
  const running = startControlledIntelligenceProvider({ port, state });
  if (!running.server.address()) await once(running.server, 'listening');
  const baseUrl = `http://127.0.0.1:${port}`;
  const provider = createHttpAttachmentTextProvider({
    processor: 'ocr',
    mode: 'self_hosted',
    baseUrl,
    endpoint: '/v1/ocr',
    token: 'http-provider-secret',
    timeoutMs: 5_000
  });
  const input = {
    attachment_id: 'http-video-attachment',
    tenant_id: 'http-video-tenant',
    session_id: 'http-video-session',
    message_id: 'http-video-message',
    filename: 'screen.webm',
    content_type: 'video/webm',
    source_ref: 'ivekit://attachment/http-video-attachment',
    content: Buffer.from('controlled-video-bytes'),
    media_mode: 'video_frame_sampling' as const,
    frame_interval_ms: 2_000,
    max_frames: 120
  };
  try {
    const result = await provider.extract(input);
    assert.deepEqual(result.observations?.map((observation) => [
      observation.type,
      observation.symbology,
      observation.frame_timestamp_ms
    ]), [
      ['qr_code', 'QR_CODE', 2_000],
      ['barcode', 'CODE_128', 4_000]
    ]);

    const control = await fetch(`${baseUrl}/__control/mode`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer http-control-secret',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ mode: 'oversized_observations' })
    });
    assert.equal(control.status, 200);
    await assert.rejects(
      () => provider.extract(input),
      (error: any) => error?.code === 'provider_invalid_response' && error?.retryable === false
    );
  } finally {
    await running.close();
  }
});

test('controlled provider mode changes require the control token and package script is exposed', async () => {
  const state = createControlledProviderState({ controlToken: 'control-secret' });
  const denied = await handleControlledProviderRequest({
    method: 'POST', path: '/__control/mode', headers: {}, body: { mode: 'terminal_failure' }
  }, state);
  assert.equal(denied.status, 401);
  const changed = await handleControlledProviderRequest({
    method: 'POST', path: '/__control/mode', headers: { authorization: 'Bearer control-secret' },
    body: { mode: 'terminal_failure' }
  }, state);
  assert.equal(changed.status, 200);
  assert.equal(state.mode, 'terminal_failure');

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['ivekit:controlled-provider'], 'tsx scripts/ivekit-controlled-provider.ts');
});

async function request(
  state: ReturnType<typeof createControlledProviderState>,
  path: string,
  body: Record<string, unknown>,
  authenticated = true,
  method = 'POST'
) {
  return handleControlledProviderRequest({
    method,
    path,
    headers: authenticated && state.token ? { authorization: `Bearer ${state.token}` } : {},
    body
  }, state);
}

async function unusedLocalPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
