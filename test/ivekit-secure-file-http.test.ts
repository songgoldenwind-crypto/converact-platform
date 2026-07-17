import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileService } from '../src/agent-runtime/collaboration/secure-file-service.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import {
  routeIveKitChatApi,
  type RouteIveKitChatApiOptions
} from '../src/agent-runtime/ivekit/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';
import { LocalObjectStorage } from '../src/storage/object-storage.js';

const API_KEY = 'ivekit-secure-file-http-key';

test('secure file HTTP facade enforces scan-gated single upload and emits safe events', async (t) => {
  const fixture = await httpFixture(t, 'tenant-secure-http-single');
  const body = Buffer.from('%PDF secure API upload');
  const events: Array<{ type: string; data: unknown }> = [];
  fixture.options.publish = (_tenantId, type, data) => {
    events.push({ type, data });
  };
  const path = `/api/ivekit/chat/sessions/${fixture.sessionId}/files`;
  const created = await fixture.route('POST', path, {
    kind: 'file', filename: 'contract.pdf', declared_mime: 'application/pdf',
    upload_mode: 'single', expected_size_bytes: body.length
  }, '', { 'idempotency-key': 'secure-file-single' }) as {
    status: number;
    data: { file: { file_id: string; status: string } };
    afterCommit?: () => Promise<void>;
  };
  assert.equal(created.status, 201);
  assert.equal(created.data.file.status, 'initiated');
  assert.doesNotMatch(JSON.stringify(created.data), /object_key|upload_id|storage_url|metadata/);
  await created.afterCommit?.();

  const fileId = created.data.file.file_id;
  const upload = await fixture.route(
    'PUT', `${path}/${fileId}/content`, null, body,
    { 'x-content-sha256': sha256(body) }
  ) as {
    data: { file: { status: string } };
    afterCommit?: () => Promise<void>;
  };
  assert.equal(upload.data.file.status, 'scanning');
  await upload.afterCommit?.();

  await assert.rejects(
    () => fixture.route('GET', `${path}/${fileId}/download`, null),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  await fixture.files.transitionStatus({
    tenant_id: fixture.tenantId, secure_file_id: fileId,
    from_status: 'scanning', to_status: 'processing', threat_status: 'clean',
    detected_mime: 'application/pdf'
  });
  await fixture.files.transitionStatus({
    tenant_id: fixture.tenantId, secure_file_id: fileId,
    from_status: 'processing', to_status: 'ready'
  });
  const downloaded = await fixture.route('GET', `${path}/${fileId}/download`, null) as {
    contentType: string;
    data: Buffer;
    headers: Record<string, string>;
  };
  assert.equal(downloaded.contentType, 'application/pdf');
  assert.deepEqual(downloaded.data, body);
  assert.match(downloaded.headers['content-disposition'], /contract\.pdf/);
  assert.deepEqual(events.map((event) => event.type), [
    'collaboration.secure_file.created',
    'collaboration.secure_file.uploaded'
  ]);
  assert.doesNotMatch(JSON.stringify(events), /object_key|upload_id|storage_url|metadata/);
});

test('secure file HTTP facade supports multipart resume, completion, and abort', async (t) => {
  const fixture = await httpFixture(t, 'tenant-secure-http-multipart');
  const path = `/api/ivekit/chat/sessions/${fixture.sessionId}/files`;
  const created = await fixture.route('POST', path, {
    kind: 'file', filename: 'resume.txt', declared_mime: 'text/plain',
    upload_mode: 'multipart', expected_size_bytes: 6, part_size_bytes: 3
  }, '', { 'idempotency-key': 'secure-file-multipart' }) as {
    data: { file: { file_id: string } };
  };
  const fileId = created.data.file.file_id;
  for (const [partNumber, value] of [[1, 'abc'], [2, 'def']] as const) {
    const content = Buffer.from(value);
    await fixture.route(
      'PUT', `${path}/${fileId}/parts/${partNumber}`, null, content,
      { 'x-content-sha256': sha256(content) }
    );
  }
  const parts = await fixture.route('GET', `${path}/${fileId}/parts`, null) as {
    data: { parts: Array<{ part_number: number; status: string }> };
  };
  assert.deepEqual(parts.data.parts.map((part) => [part.part_number, part.status]), [
    [1, 'uploaded'], [2, 'uploaded']
  ]);
  const completed = await fixture.route('POST', `${path}/${fileId}/complete`, {
    size_bytes: 6, sha256: sha256('abcdef')
  }) as { data: { file: { status: string } } };
  assert.equal(completed.data.file.status, 'scanning');

  const abortCreated = await fixture.route('POST', path, {
    kind: 'video', filename: 'partial.webm', declared_mime: 'video/webm',
    upload_mode: 'multipart', expected_size_bytes: 3, part_size_bytes: 3
  }, '', { 'idempotency-key': 'secure-file-abort' }) as {
    data: { file: { file_id: string } };
  };
  const abortId = abortCreated.data.file.file_id;
  const aborted = await fixture.route('DELETE', `${path}/${abortId}`, null) as {
    data: { file: { status: string } };
  };
  assert.equal(aborted.data.file.status, 'expired');
});

test('Tinode message attachment binding rejects unsafe files and projects ready files', async (t) => {
  const fixture = await httpFixture(t, 'tenant-secure-http-binding');
  const filesPath = `/api/ivekit/chat/sessions/${fixture.sessionId}/files`;
  const content = Buffer.from('safe attachment bytes');
  const created = await fixture.route('POST', filesPath, {
    kind: 'file', filename: 'evidence.bin', declared_mime: 'application/octet-stream',
    upload_mode: 'single', expected_size_bytes: content.length
  }, '', { 'idempotency-key': 'secure-file-binding' }) as {
    data: { file: { file_id: string } };
  };
  const fileId = created.data.file.file_id;
  await fixture.route(
    'PUT', `${filesPath}/${fileId}/content`, null, content,
    { 'x-content-sha256': sha256(content) }
  );
  const messagePath = `/api/ivekit/chat/sessions/${fixture.sessionId}/messages`;
  await assert.rejects(
    () => fixture.route('POST', messagePath, {
      sender_identity: 'secure-file-user',
      attachments: [{ secure_file_id: fileId }]
    }, '', { 'idempotency-key': 'message-before-scan' }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  await fixture.files.transitionStatus({
    tenant_id: fixture.tenantId, secure_file_id: fileId,
    from_status: 'scanning', to_status: 'processing', threat_status: 'clean',
    detected_mime: 'application/octet-stream'
  });
  await fixture.files.transitionStatus({
    tenant_id: fixture.tenantId, secure_file_id: fileId,
    from_status: 'processing', to_status: 'ready'
  });
  const posted = await fixture.route('POST', messagePath, {
    sender_identity: 'secure-file-user',
    attachments: [{ secure_file_id: fileId }]
  }, '', { 'idempotency-key': 'message-after-scan' }) as {
    data: { message: { attachments: Array<{ id: string; secure_file_id: string }> } };
  };
  const attachment = posted.data.message.attachments[0];
  assert.equal(attachment?.secure_file_id, fileId);
  const downloaded = await fixture.route(
    'GET',
    `/api/ivekit/chat/sessions/${fixture.sessionId}/attachments/${attachment?.id}/download`,
    null
  ) as { data: Buffer };
  assert.deepEqual(downloaded.data, content);
});

async function httpFixture(
  t: { after(fn: () => void): void },
  tenantId: string
) {
  const previousKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = API_KEY;
  const root = mkdtempSync(join(tmpdir(), 'ivekit-secure-file-http-'));
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  });
  const pg = new MemoryPg();
  const files = new SecureFileStore(pg);
  const options: RouteIveKitChatApiOptions = {
    secureFiles: new SecureFileService({
      files,
      derivatives: new SecureFileDerivativeStore(pg),
      storage: new LocalObjectStorage(root)
    })
  };
  const headers = {
    'x-api-key': API_KEY,
    'x-tenant-id': tenantId,
    'x-user-id': 'secure-file-user'
  };
  const invoke = (
    method: string,
    path: string,
    body: unknown,
    rawBody: string | Buffer = '',
    extraHeaders: Record<string, string> = {}
  ) => routeIveKitChatApi(
    pg, method, path, new URL(`http://localhost${path}`), body, rawBody,
    { ...headers, ...extraHeaders }, options
  );
  const opened = await invoke('POST', '/api/ivekit/chat/sessions', {
    business_ref: { type: 'test', id: `ref-${tenantId}` }
  }) as { data: { id: string } };
  return {
    tenantId,
    sessionId: opened.data.id,
    files,
    options,
    route: invoke
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
