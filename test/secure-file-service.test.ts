import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileService } from '../src/agent-runtime/collaboration/secure-file-service.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { LocalObjectStorage } from '../src/storage/object-storage.js';

test('multipart service reserves checksums, resumes parts, and completes idempotently', async (t) => {
  const fixture = serviceFixture(t);
  const created = await fixture.service.createUpload({
    tenant_id: 'tenant-file-service',
    session_id: 'session-file-service',
    created_by: 'user-file-service',
    kind: 'file',
    filename: 'contract.pdf',
    declared_mime: 'application/pdf',
    upload_mode: 'multipart',
    expected_size_bytes: 11,
    part_size_bytes: 6,
    idempotency_key: 'multipart-create',
    payload_hash: sha256('multipart-create-payload')
  });
  const replay = await fixture.service.createUpload({
    tenant_id: 'tenant-file-service',
    session_id: 'session-file-service',
    created_by: 'user-file-service',
    kind: 'file',
    filename: 'contract.pdf',
    declared_mime: 'application/pdf',
    upload_mode: 'multipart',
    expected_size_bytes: 11,
    part_size_bytes: 6,
    idempotency_key: 'multipart-create',
    payload_hash: sha256('multipart-create-payload')
  });
  assert.equal(replay.file_id, created.file_id);
  assert.doesNotMatch(JSON.stringify(created), /object_key|upload_id|storage_url|metadata/);

  const firstBody = Buffer.from('hello ');
  const secondBody = Buffer.from('world');
  const first = await fixture.service.uploadPart({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id, part_number: 1,
    content: firstBody, sha256: sha256(firstBody)
  });
  assert.deepEqual(await fixture.service.uploadPart({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id, part_number: 1,
    content: firstBody, sha256: sha256(firstBody)
  }), first);
  await assert.rejects(
    () => fixture.service.uploadPart({
      tenant_id: 'tenant-file-service', session_id: 'session-file-service',
      secure_file_id: created.file_id, part_number: 1,
      content: Buffer.from('HELLO '), sha256: sha256('HELLO ')
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  await fixture.service.uploadPart({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id, part_number: 2,
    content: secondBody, sha256: sha256(secondBody)
  });
  assert.deepEqual((await fixture.service.listParts({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id
  })).map((part) => [part.part_number, part.status]), [[1, 'uploaded'], [2, 'uploaded']]);

  const completed = await fixture.service.completeUpload({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id, size_bytes: 11, sha256: sha256('hello world')
  });
  assert.equal(completed.status, 'scanning');
  assert.equal((await fixture.service.completeUpload({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id, size_bytes: 11, sha256: sha256('hello world')
  })).status, 'scanning');
  await assert.rejects(
    () => fixture.service.download({
      tenant_id: 'tenant-file-service', session_id: 'session-file-service',
      secure_file_id: created.file_id
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  await fixture.files.transitionStatus({
    tenant_id: 'tenant-file-service', secure_file_id: created.file_id,
    from_status: 'scanning', to_status: 'processing', threat_status: 'clean',
    detected_mime: 'application/pdf'
  });
  await fixture.files.transitionStatus({
    tenant_id: 'tenant-file-service', secure_file_id: created.file_id,
    from_status: 'processing', to_status: 'ready'
  });
  const downloaded = await fixture.service.download({
    tenant_id: 'tenant-file-service', session_id: 'session-file-service',
    secure_file_id: created.file_id
  });
  assert.equal(downloaded.content.toString(), 'hello world');
  assert.equal(downloaded.content_type, 'application/pdf');
});

test('single upload verifies checksum and enters the same scan gate', async (t) => {
  const fixture = serviceFixture(t);
  const body = Buffer.from('%PDF controlled single upload');
  const created = await fixture.service.createUpload({
    tenant_id: 'tenant-single-service', session_id: 'session-single-service',
    created_by: 'user-single-service', kind: 'file', filename: 'single.pdf',
    declared_mime: 'application/pdf', upload_mode: 'single',
    expected_size_bytes: body.length, idempotency_key: 'single-create',
    payload_hash: sha256('single-create-payload')
  });
  await assert.rejects(
    () => fixture.service.uploadContent({
      tenant_id: 'tenant-single-service', session_id: 'session-single-service',
      secure_file_id: created.file_id, content: body, sha256: 'f'.repeat(64)
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 400
  );
  const uploaded = await fixture.service.uploadContent({
    tenant_id: 'tenant-single-service', session_id: 'session-single-service',
    secure_file_id: created.file_id, content: body, sha256: sha256(body)
  });
  assert.equal(uploaded.status, 'scanning');
  assert.equal(uploaded.received_size_bytes, body.length);
});

test('abort removes multipart state, expires the upload, and remains idempotent', async (t) => {
  const fixture = serviceFixture(t);
  const created = await fixture.service.createUpload({
    tenant_id: 'tenant-abort-service', session_id: 'session-abort-service',
    created_by: 'user-abort-service', kind: 'video', filename: 'partial.webm',
    declared_mime: 'video/webm', upload_mode: 'multipart',
    expected_size_bytes: 10, part_size_bytes: 5,
    idempotency_key: 'abort-create', payload_hash: sha256('abort-create-payload')
  });
  await fixture.service.uploadPart({
    tenant_id: 'tenant-abort-service', session_id: 'session-abort-service',
    secure_file_id: created.file_id, part_number: 1,
    content: Buffer.from('12345'), sha256: sha256('12345')
  });
  const aborted = await fixture.service.abortUpload({
    tenant_id: 'tenant-abort-service', session_id: 'session-abort-service',
    secure_file_id: created.file_id
  });
  assert.equal(aborted.status, 'expired');
  assert.equal((await fixture.service.abortUpload({
    tenant_id: 'tenant-abort-service', session_id: 'session-abort-service',
    secure_file_id: created.file_id
  })).status, 'expired');
  assert.equal((await fixture.service.listParts({
    tenant_id: 'tenant-abort-service', session_id: 'session-abort-service',
    secure_file_id: created.file_id
  }))[0]?.status, 'aborted');
});

function serviceFixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'converact-secure-file-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pg = new MemoryPg();
  const files = new SecureFileStore(pg);
  const derivatives = new SecureFileDerivativeStore(pg);
  const storage = new LocalObjectStorage(root);
  return {
    files,
    service: new SecureFileService({ files, derivatives, storage })
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
