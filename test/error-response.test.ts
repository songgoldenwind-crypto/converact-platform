import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createServer } from '../src/http.js';
import { listenOnRandomPort } from './test-helpers.js';

const db = createDatabase(':memory:');
const server = createServer(db);
let baseUrl = '';

before(async () => {
  process.env.OPC_API_KEY = 'test-key';
  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('500 error includes an error_id for log correlation', async () => {
  // Trigger a genuine 500: answer a non-existent voice session → internal throw.
  const res = await fetch(`${baseUrl}/api/voice/sessions/nonexistent-session-id/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'test-key' },
    body: JSON.stringify({})
  });
  const data = (await res.json()) as { error: { message: string; status: number; error_id?: string } };
  assert.equal(res.status, 500, 'should trigger 500');
  // 500 must NOT leak the real message (security), but MUST include
  // an error_id so devs can correlate with server logs.
  assert.equal(data.error.message, 'internal server error',
    '500 must not leak internal error message');
  assert.ok(data.error.error_id, '500 must include error_id for log correlation');
  assert.match(String(data.error.error_id), /^err_[a-z0-9]{8,}$/,
    'error_id should be a traceable identifier');
});

test('400 error includes real message (no error_id needed)', async () => {
  const res = await fetch(`${baseUrl}/api/livekit/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'test-key' },
    body: JSON.stringify({})
  });
  const data = (await res.json()) as { error: { message: string; status: number; error_id?: string } };
  assert.equal(res.status, 400);
  assert.ok(data.error.message.length > 0, '400 should have real message');
  // 400 is expected client error — no error_id
  assert.equal(data.error.error_id, undefined);
});
