import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createRustPbxCapacityRouter } from '../scripts/capacity/fixtures/rustpbx-router.js';

const token = 'capacity-router-test-token';

test('capacity Router preserves auth, reject routing, CDR and exact evidence', async (context) => {
  const server = createRustPbxCapacityRouter({ token });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/evidence`)).status, 401);

  const routes = await Promise.all(Array.from({ length: 400 }, (_, index) => fetch(`${base}/router`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pbx-key': token },
    body: JSON.stringify({
      call_id: `capacity-${index}`,
      from: 'sip:sipp@172.30.44.20',
      to: 'sip:18005550999@rustpbx',
      direction: 'inbound',
      method: 'INVITE',
      uri: 'sip:18005550999@rustpbx'
    })
  })));
  assert.equal(routes.every((response) => response.status === 200), true);
  assert.deepEqual(await routes[0]!.json(), {
    action: 'reject', status: 486, reason: 'acceptance-route'
  });

  const cdr = await fetch(`${base}/cdr`, {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=ivekit',
      'x-pbx-key': token
    },
    body: '--ivekit\r\nContent-Disposition: form-data; name="calllog.json"\r\n\r\n{}\r\n--ivekit--\r\n'
  });
  assert.equal(cdr.status, 200);

  const evidence = await fetch(`${base}/evidence`, { headers: { 'x-pbx-key': token } });
  assert.deepEqual(await evidence.json(), { router_requests: 400, cdr_requests: 1 });
});

test('capacity Router rejects malformed or oversized requests without counting them', async (context) => {
  const server = createRustPbxCapacityRouter({ token, max_body_bytes: 128 });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  const unauthorized = await fetch(`${base}/router`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  const malformed = await fetch(`${base}/router`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pbx-key': token }, body: '{}'
  });
  assert.equal(malformed.status, 422);
  const oversized = await fetch(`${base}/router`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-pbx-key': token }, body: 'x'.repeat(129)
  });
  assert.equal(oversized.status, 413);
  const evidence = await fetch(`${base}/evidence`, { headers: { 'x-pbx-key': token } });
  assert.deepEqual(await evidence.json(), { router_requests: 0, cdr_requests: 0 });
});
