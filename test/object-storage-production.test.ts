import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  LocalObjectStorage,
  S3ObjectStorage,
  createObjectStorage
} from '../src/storage/object-storage.js';

test('object storage factory honors the supplied environment without mutating process env', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-object-storage-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = createObjectStorage({ CONVERACT_UPLOAD_DIR: root });
  const s3 = createObjectStorage({
    MINIO_ENDPOINT: 'http://minio.internal:9000',
    MINIO_BUCKET: 'secure-files',
    MINIO_ACCESS_KEY: 'access',
    MINIO_SECRET_KEY: 'secret'
  });

  assert.ok(local instanceof LocalObjectStorage);
  assert.equal(local.rootDir, root);
  assert.ok(s3 instanceof S3ObjectStorage);
});

test('object storage factory rejects local fallback when shared storage is required', () => {
  assert.throws(
    () => createObjectStorage({ CONVERACT_OBJECT_STORAGE_REQUIRED: '1' }),
    /shared object storage is required/i
  );
  assert.doesNotThrow(() => createObjectStorage({
    CONVERACT_OBJECT_STORAGE_REQUIRED: '1',
    S3_BUCKET: 'ivekit-production'
  }));
});

test('local object storage gives same-name files unique opaque keys', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-object-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new LocalObjectStorage(root);

  const first = await storage.upload({
    tenantId: 'tenant-a', filename: 'same-name.pdf', body: Buffer.from('first'),
    contentType: 'application/pdf', keyPrefix: 'secure-files'
  });
  const second = await storage.upload({
    tenantId: 'tenant-a', filename: 'same-name.pdf', body: Buffer.from('second'),
    contentType: 'application/pdf', keyPrefix: 'secure-files'
  });

  assert.notEqual(first.key, second.key);
  assert.match(first.key, /^tenant-a\/secure-files\/[a-zA-Z0-9_-]+$/);
  assert.doesNotMatch(first.key, /same-name|\.pdf/i);
  assert.equal((await storage.download(first.key))?.toString(), 'first');
  assert.equal((await storage.download(second.key))?.toString(), 'second');
  assert.deepEqual(await storage.head(first.key), {
    key: first.key,
    size_bytes: 5,
    etag: sha256('first')
  });
});

test('local object storage rejects a duplicate explicit resource without overwriting', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-object-storage-resource-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new LocalObjectStorage(root);
  const input = {
    tenantId: 'tenant-resource', filename: 'ignored.txt', body: Buffer.from('original'),
    contentType: 'text/plain', keyPrefix: 'secure-files', resourceId: 'sfile-123'
  };

  const uploaded = await storage.upload(input);
  await assert.rejects(
    () => storage.upload({ ...input, body: Buffer.from('replacement') }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  assert.equal((await storage.download(uploaded.key))?.toString(), 'original');
});

test('local multipart upload is resumable, checks parts, and completes idempotently', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-object-storage-multipart-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new LocalObjectStorage(root);
  const initiated = await storage.initiateMultipart({
    tenantId: 'tenant-multipart', keyPrefix: 'secure-files', resourceId: 'sfile-multipart',
    contentType: 'application/octet-stream'
  });

  const first = await storage.uploadPart({
    ...initiated, part_number: 1, body: Buffer.from('hello '), sha256: sha256('hello ')
  });
  assert.deepEqual(await storage.uploadPart({
    ...initiated, part_number: 1, body: Buffer.from('hello '), sha256: sha256('hello ')
  }), first);
  await assert.rejects(
    () => storage.uploadPart({
      ...initiated, part_number: 1, body: Buffer.from('HELLO '), sha256: sha256('HELLO ')
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  const second = await storage.uploadPart({
    ...initiated, part_number: 2, body: Buffer.from('world'), sha256: sha256('world')
  });

  const completed = await storage.completeMultipart({
    ...initiated,
    parts: [
      { part_number: 1, etag: first.etag },
      { part_number: 2, etag: second.etag }
    ],
    size_bytes: 11,
    sha256: sha256('hello world')
  });
  assert.equal((await storage.download(completed.key))?.toString(), 'hello world');
  assert.deepEqual(await storage.completeMultipart({
    ...initiated,
    parts: [
      { part_number: 1, etag: first.etag },
      { part_number: 2, etag: second.etag }
    ],
    size_bytes: 11,
    sha256: sha256('hello world')
  }), completed);
});

test('local multipart completion rejects wrong totals and abort removes temporary parts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-object-storage-abort-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new LocalObjectStorage(root);
  const initiated = await storage.initiateMultipart({
    tenantId: 'tenant-abort', keyPrefix: 'secure-files', resourceId: 'sfile-abort',
    contentType: 'application/octet-stream'
  });
  const part = await storage.uploadPart({
    ...initiated, part_number: 1, body: Buffer.from('partial'), sha256: sha256('partial')
  });

  await assert.rejects(
    () => storage.completeMultipart({
      ...initiated, parts: [{ part_number: 1, etag: part.etag }],
      size_bytes: 6, sha256: sha256('partial')
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
  assert.equal(await storage.abortMultipart(initiated), 'aborted');
  assert.equal(await storage.abortMultipart(initiated), 'not_found');
  await assert.rejects(
    () => storage.uploadPart({
      ...initiated, part_number: 2, body: Buffer.from('later'), sha256: sha256('later')
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 404
  );
  assert.equal(await storage.head(initiated.key), null);
});

test('local object delete is bounded and idempotent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-object-storage-delete-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const storage = new LocalObjectStorage(root);
  const uploaded = await storage.upload({
    tenantId: 'tenant-delete', filename: 'delete.bin', body: Buffer.from('delete'),
    contentType: 'application/octet-stream', keyPrefix: 'secure-files'
  });

  assert.equal(await storage.delete(uploaded.key), 'deleted');
  assert.equal(await storage.delete(uploaded.key), 'not_found');
  assert.equal(await storage.download(uploaded.key), null);
  await assert.rejects(
    () => storage.delete('../outside'),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 400
  );
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
