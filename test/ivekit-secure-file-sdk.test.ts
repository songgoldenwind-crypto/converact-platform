import assert from 'node:assert/strict';
import test from 'node:test';

import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';

test('iveKit SDK maps the complete secure file resume workflow', async () => {
  const calls: Array<{
    method: string;
    path: string;
    headers: Headers;
    body: Uint8Array | string | null;
  }> = [];
  const responses: unknown[] = [
    { file: { file_id: 'file-1', status: 'initiated' } },
    { part: { part_number: 1, status: 'uploaded' } },
    { parts: [{ part_number: 1, status: 'uploaded' }] },
    { file: { file_id: 'file-1', status: 'scanning' } },
    { file: { file_id: 'file-1', status: 'scanning' } },
    new Uint8Array([1, 2, 3]),
    { file: { file_id: 'file-2', status: 'expired' } }
  ];
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-secure-sdk',
    apiKey: 'secure-sdk-key',
    fetch: async (input, init = {}) => {
      const body = typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? init.body
          : null;
      calls.push({
        method: init.method || 'GET',
        path: new URL(String(input)).pathname,
        headers: new Headers(init.headers),
        body
      });
      const response = responses.shift();
      assert.ok(response);
      if (response instanceof Uint8Array) {
        return new Response(response, {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="contract.pdf"'
          }
        });
      }
      return Response.json(response);
    }
  });

  const created = await sdk.chat.createSecureFile('session/1', {
    kind: 'file', filename: 'contract.pdf', declared_mime: 'application/pdf',
    upload_mode: 'multipart', expected_size_bytes: 3, part_size_bytes: 3
  }, { idempotencyKey: 'create-file-1' });
  assert.equal(created.file_id, 'file-1');
  await sdk.chat.uploadSecureFilePart(
    'session/1', 'file-1', 1, new Uint8Array([1, 2, 3]), 'a'.repeat(64)
  );
  await sdk.chat.listSecureFileParts('session/1', 'file-1');
  await sdk.chat.completeSecureFile('session/1', 'file-1', {
    size_bytes: 3, sha256: 'b'.repeat(64)
  });
  await sdk.chat.getSecureFile('session/1', 'file-1');
  const downloaded = await sdk.chat.downloadSecureFile('session/1', 'file-1');
  assert.equal(downloaded.filename, 'contract.pdf');
  await sdk.chat.abortSecureFile('session/1', 'file-2');

  assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/ivekit/chat/sessions/session%2F1/files',
    'PUT /api/ivekit/chat/sessions/session%2F1/files/file-1/parts/1',
    'GET /api/ivekit/chat/sessions/session%2F1/files/file-1/parts',
    'POST /api/ivekit/chat/sessions/session%2F1/files/file-1/complete',
    'GET /api/ivekit/chat/sessions/session%2F1/files/file-1',
    'GET /api/ivekit/chat/sessions/session%2F1/files/file-1/download',
    'DELETE /api/ivekit/chat/sessions/session%2F1/files/file-2'
  ]);
  assert.equal(calls[0]?.headers.get('idempotency-key'), 'create-file-1');
  assert.equal(calls[1]?.headers.get('x-content-sha256'), 'a'.repeat(64));
  assert.deepEqual([...(calls[1]?.body as Uint8Array)], [1, 2, 3]);
});
