import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  deleteRecordingObject,
  resolveRecordingObjectContent,
  resolveRecordingObjectStream
} from '../src/agent-runtime/media-recording-object.js';

test('recording object resolver reads file urls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converact-recording-object-'));
  try {
    const filePath = join(dir, 'recording.mp4');
    const body = Buffer.from('recording-object-body');
    await writeFile(filePath, body);

    const result = await resolveRecordingObjectContent({
      storage_url: pathToFileURL(filePath).toString()
    });

    assert.equal(result.status, 'readable');
    assert.equal(result.source, 'file');
    assert.deepEqual(result.content, body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recording object resolver rejects files above the bounded export size before reading them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converact-recording-object-limit-'));
  try {
    const filePath = join(dir, 'oversized.mp4');
    await writeFile(filePath, Buffer.alloc(5));
    await assert.rejects(
      () => resolveRecordingObjectContent(
        { storage_url: pathToFileURL(filePath).toString() },
        { maxBytes: 4 }
      ),
      (error: any) => error.status === 413 && /export limit/i.test(error.message)
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recording export streams HTTP chunks and aborts once the bounded limit is crossed', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('abc'));
      controller.enqueue(Buffer.from('de'));
    },
    cancel() { cancelled = true; }
  });
  const result = await resolveRecordingObjectStream(
    { storage_url: 'https://recordings.example/stream.mp4' },
    { maxBytes: 4, fetch: async () => new Response(body, { status: 200 }) }
  );
  assert.equal(result.status, 'readable');
  assert.ok(result.stream);
  await assert.rejects(
    async () => { for await (const _chunk of result.stream!) { /* consume */ } },
    (error: any) => error.status === 413 && /export limit/i.test(error.message)
  );
  assert.equal(cancelled, true);
});

test('recording object resolver reports forbidden http objects without content', async () => {
  const result = await resolveRecordingObjectContent(
    {
      storage_url: 'https://recordings.example/tenant/recording.mp4'
    },
    {
      fetch: async () => new Response('forbidden', { status: 403 })
    }
  );

  assert.equal(result.status, 'forbidden');
  assert.equal(result.source, 'http');
  assert.equal(result.content, undefined);
  assert.equal(result.error, 'http_403');
});

test('recording object resolver aborts stalled HTTP reads', async () => {
  const result = await resolveRecordingObjectContent(
    { storage_url: 'https://recordings.example/stalled.mp4' },
    {
      httpTimeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })
    }
  );

  assert.equal(result.status, 'fetch_failed');
  assert.equal(result.error, 'http_fetch_timeout');
});

test('recording object resolver blocks cross-bucket S3 access in production', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousBucket = process.env.S3_BUCKET;
  process.env.NODE_ENV = 'production';
  process.env.S3_BUCKET = 'allowed-recordings';
  try {
    const resolved = await resolveRecordingObjectContent({
      storage_url: 's3://other-tenant-bucket/object.mp4'
    });
    assert.equal(resolved.status, 'forbidden');
    assert.equal(resolved.error, 's3_bucket_not_allowed');

    const deleted = await deleteRecordingObject({
      storage_url: 's3://other-tenant-bucket/object.mp4'
    });
    assert.equal(deleted.status, 'delete_failed');
    assert.equal(deleted.error, 's3_bucket_not_allowed');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousBucket === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = previousBucket;
  }
});

test('recording object resolver blocks arbitrary production file paths', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRoot = process.env.CONVERACT_RECORDING_OBJECT_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'converact-recording-object-blocked-'));
  const filePath = join(dir, 'recording.mp4');
  await writeFile(filePath, 'blocked production file');
  process.env.NODE_ENV = 'production';
  delete process.env.CONVERACT_RECORDING_OBJECT_DIR;

  try {
    const result = await resolveRecordingObjectContent({
      storage_url: pathToFileURL(filePath).toString()
    });

    assert.equal(result.status, 'forbidden');
    assert.equal(result.error, 'local_path_not_allowed');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousRoot === undefined) delete process.env.CONVERACT_RECORDING_OBJECT_DIR;
    else process.env.CONVERACT_RECORDING_OBJECT_DIR = previousRoot;
    await rm(dir, { recursive: true, force: true });
  }
});

test('recording object resolver and cleanup allow files under the configured production root', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousRoot = process.env.CONVERACT_RECORDING_OBJECT_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'converact-recording-object-root-'));
  const filePath = join(dir, 'recording.ogg');
  const body = Buffer.from('configured recording object');
  await writeFile(filePath, body);
  process.env.NODE_ENV = 'production';
  process.env.CONVERACT_RECORDING_OBJECT_DIR = dir;

  try {
    const resolved = await resolveRecordingObjectContent({
      storage_url: pathToFileURL(filePath).toString()
    });
    assert.equal(resolved.status, 'readable');
    assert.deepEqual(resolved.content, body);

    const deleted = await deleteRecordingObject({
      storage_url: pathToFileURL(filePath).toString()
    });
    assert.equal(deleted.status, 'deleted');
    await assert.rejects(() => access(filePath), /ENOENT/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousRoot === undefined) delete process.env.CONVERACT_RECORDING_OBJECT_DIR;
    else process.env.CONVERACT_RECORDING_OBJECT_DIR = previousRoot;
    await rm(dir, { recursive: true, force: true });
  }
});
