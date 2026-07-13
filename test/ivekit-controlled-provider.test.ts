import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createControlledProviderState,
  handleControlledProviderRequest
} from '../scripts/ivekit-controlled-provider.js';

test('controlled provider implements health, OCR, ASR, quality, and translation contracts', async () => {
  const state = createControlledProviderState({ token: 'controlled-secret' });
  const unauthorized = await request(state, '/v1/translate', { text: 'private source' }, false);
  assert.equal(unauthorized.status, 401);
  assert.doesNotMatch(unauthorized.body, /controlled-secret|private source/);

  const health = await request(state, '/health', {}, false, 'GET');
  assert.deepEqual(JSON.parse(health.body), { status: 'ok', service: 'ivekit-controlled-provider' });
  for (const capability of ['ocr', 'asr']) {
    const response = await request(state, `/v1/${capability}`, { source_ref: 'ivekit://attachment/source-1' });
    const body = JSON.parse(response.body);
    assert.equal(response.status, 200);
    assert.match(body.text, new RegExp(`controlled ${capability}`));
    assert.equal(body.confidence, 0.99);
    assert.doesNotMatch(response.body, /controlled-secret/);
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
