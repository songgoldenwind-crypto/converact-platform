import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIveKitHttpSdk } from '../sdk/converact/src/http-sdk.js';
import type { IveKitUploadTransport } from '../sdk/converact/src/upload-transport.js';

test('attachment progress upload preserves binary, auth, monotonic progress, and abort', async () => {
  const requests: Parameters<IveKitUploadTransport['upload']>[0][] = [];
  let aborted = false;
  const transport: IveKitUploadTransport = {
    upload(request) {
      requests.push(request);
      request.onProgress?.({ loaded: 4, total: 10, percent: 40 });
      request.onProgress?.({ loaded: 3, total: 10, percent: 30 });
      request.onProgress?.({ loaded: 10, total: 10, percent: 100 });
      return {
        result: Promise.resolve({ kind: 'image', storage_url: '/object', processing_status: 'pending' }),
        abort: () => { aborted = true; }
      };
    }
  };
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-upload',
    accessToken: 'upload-token',
    timeoutMs: 5000,
    uploadTransport: transport
  });
  const bytes = new Uint8Array([0, 255, 7, 9]);
  const progress: number[] = [];
  const first = sdk.chat.uploadAttachmentWithProgress('session-1', {
    kind: 'image',
    filename: 'contact photo.png',
    contentType: 'image/png',
    body: bytes
  }, { onProgress: (event) => progress.push(event.percent) });
  const second = sdk.chat.uploadAttachmentWithProgress('session-1', {
    kind: 'image',
    filename: 'contact photo.png',
    contentType: 'image/png',
    body: bytes
  });
  first.abort();
  await first.result;
  await second.result;

  assert.equal(aborted, true);
  assert.deepEqual(progress, [40, 40, 100]);
  assert.equal(requests[0].body, bytes);
  assert.equal(requests[0].headers.authorization, 'Bearer upload-token');
  assert.equal(requests[0].headers['x-tenant-id'], 'tenant-upload');
  assert.equal(requests[0].headers['content-type'], 'image/png');
  assert.equal(requests[0].timeoutMs, 5000);
  assert.notEqual(requests[0].headers['x-upload-id'], requests[1].headers['x-upload-id']);
  assert.match(new URL(requests[0].url).pathname, /\/api\/ivekit\/chat\/sessions\/session-1\/attachments\/upload/);
  assert.equal(new URL(requests[0].url).searchParams.get('filename'), 'contact photo.png');
});

test('attachment fetch fallback returns structured errors and supports timeout abort', async () => {
  const rejected = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-upload',
    apiKey: 'upload-key',
    fetch: async () => Response.json({ error: 'too large' }, { status: 413 })
  }).chat.uploadAttachmentWithProgress('session-1', {
    kind: 'file',
    filename: 'large.bin',
    contentType: 'application/octet-stream',
    body: new Uint8Array([1])
  });
  await assert.rejects(
    rejected.result,
    (error: unknown) => (error as { status?: number; payload?: unknown }).status === 413
  );

  const timedOut = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-upload',
    apiKey: 'upload-key',
    timeoutMs: 100,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })
  }).chat.uploadAttachmentWithProgress('session-1', {
    kind: 'file',
    filename: 'slow.bin',
    contentType: 'application/octet-stream',
    body: new Uint8Array([1])
  });
  await assert.rejects(timedOut.result, /timed out/i);
});

test('attachment SDK exposes authenticated binary download', async () => {
  const sdk = createIveKitHttpSdk({
    baseUrl: 'https://ivekit.example.com',
    tenantId: 'tenant-download',
    accessToken: 'download-token',
    fetch: async (_input, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer download-token');
      return new Response(new Uint8Array([4, 5, 6]), {
        headers: {
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="contact.png"'
        }
      });
    }
  });
  const downloaded = await sdk.chat.downloadAttachment('session-1', 'attachment-1');
  assert.deepEqual([...downloaded.bytes], [4, 5, 6]);
  assert.equal(downloaded.contentType, 'image/png');
  assert.equal(downloaded.filename, 'contact.png');
});
