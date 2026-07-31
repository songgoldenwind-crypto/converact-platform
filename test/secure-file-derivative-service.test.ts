import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type {
  FileDerivativeInput,
  FileDerivativeProvider
} from '../src/agent-runtime/collaboration/file-derivative-provider.js';
import {
  FileDerivativeProviderError
} from '../src/agent-runtime/collaboration/file-derivative-provider.js';
import { SecureFileDerivativeService } from '../src/agent-runtime/collaboration/secure-file-derivative-service.js';
import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import type { SecureFile } from '../src/agent-runtime/collaboration/secure-file-types.js';
import { MemoryPg } from '../src/db-pg.js';
import { LocalObjectStorage } from '../src/storage/object-storage.js';

test('derivative service plans, produces, persists, and converges a clean image', async (t) => {
  const fixture = await derivativeFixture(t, 'tenant-derivative-service-image', 'image/png');
  const processed: string[] = [];
  const provider = controlledProvider(async () => Buffer.from('derived-image'));
  const service = new SecureFileDerivativeService({
    store: fixture.store,
    objectStorage: fixture.storage,
    provider,
    workerId: 'derivative-service-worker',
    onProcessed: ({ derivative, file }) => {
      processed.push(`${derivative.derivative_kind}:${derivative.status}:${file.status}`);
    }
  });

  const summary = await service.runDue({ tenant_id: fixture.file.tenant_id, limit: 10 });
  assert.deepEqual(summary, {
    tenants: 1,
    files_planned: 1,
    claimed: 1,
    ready: 1,
    retry_wait: 0,
    failed: 0,
    files_ready: 1,
    files_failed: 0
  });
  assert.deepEqual(processed, ['image_thumbnail:ready:ready']);
  const [job] = await fixture.store.listJobs(fixture.file.tenant_id, fixture.file.id);
  assert.equal(job?.status, 'ready');
  assert.equal((await fixture.storage.download(job!.object_key))?.toString(), 'derived-image');
  assert.equal((await new SecureFileStore(fixture.pg).getFile(
    fixture.file.tenant_id, fixture.file.id
  )).status, 'ready');
});

test('video partial success remains processing while retryable provider work waits', async (t) => {
  const fixture = await derivativeFixture(t, 'tenant-derivative-service-video', 'video/webm');
  const provider = controlledProvider(async (input) => {
    if (input.derivative_kind === 'video_transcode') {
      throw new FileDerivativeProviderError('provider unavailable', 'derivative_unavailable', true);
    }
    return Buffer.from('video-thumbnail');
  });
  const service = new SecureFileDerivativeService({
    store: fixture.store,
    objectStorage: fixture.storage,
    provider,
    workerId: 'derivative-service-worker',
    retryDelaysMs: [5_000]
  });

  const summary = await service.runDue({ tenant_id: fixture.file.tenant_id, limit: 10 });
  assert.equal(summary.ready, 1);
  assert.equal(summary.retry_wait, 1);
  assert.equal(summary.files_ready, 0);
  const jobs = await fixture.store.listJobs(fixture.file.tenant_id, fixture.file.id);
  assert.deepEqual(jobs.map((job) => [job.derivative_kind, job.status]), [
    ['video_thumbnail', 'ready'],
    ['video_transcode', 'retry_wait']
  ]);
  assert.equal((await new SecureFileStore(fixture.pg).getFile(
    fixture.file.tenant_id, fixture.file.id
  )).status, 'processing');
});

test('terminal provider failure fails the required derivative and parent file closed', async (t) => {
  const fixture = await derivativeFixture(t, 'tenant-derivative-service-failed', 'audio/wav');
  const provider = controlledProvider(async () => {
    throw new FileDerivativeProviderError('codec rejected', 'derivative_codec_failed', false);
  });
  const service = new SecureFileDerivativeService({
    store: fixture.store,
    objectStorage: fixture.storage,
    provider,
    workerId: 'derivative-service-worker'
  });

  const summary = await service.runDue({ tenant_id: fixture.file.tenant_id });
  assert.equal(summary.failed, 1);
  assert.equal(summary.files_failed, 1);
  const parent = await new SecureFileStore(fixture.pg).getFile(
    fixture.file.tenant_id, fixture.file.id
  );
  assert.equal(parent.status, 'failed');
  assert.equal(parent.failure_code, 'required_derivative_failed');
});

test('an idempotent existing derivative object is reused but conflicting bytes fail closed', async (t) => {
  const matching = await derivativeFixture(t, 'tenant-derivative-service-replay', 'image/png');
  await matching.storage.upload({
    tenantId: matching.file.tenant_id,
    filename: 'thumbnail.jpg',
    body: Buffer.from('same-derived-output'),
    contentType: 'image/jpeg',
    keyPrefix: 'secure-file-derivatives',
    resourceId: `${matching.file.id}-image_thumbnail`
  });
  const replayService = new SecureFileDerivativeService({
    store: matching.store,
    objectStorage: matching.storage,
    provider: controlledProvider(async () => Buffer.from('same-derived-output')),
    workerId: 'derivative-service-worker'
  });
  assert.equal((await replayService.runDue({ tenant_id: matching.file.tenant_id })).ready, 1);

  const conflicting = await derivativeFixture(t, 'tenant-derivative-service-conflict', 'image/png');
  await conflicting.storage.upload({
    tenantId: conflicting.file.tenant_id,
    filename: 'thumbnail.jpg',
    body: Buffer.from('different-existing-output'),
    contentType: 'image/jpeg',
    keyPrefix: 'secure-file-derivatives',
    resourceId: `${conflicting.file.id}-image_thumbnail`
  });
  const conflictService = new SecureFileDerivativeService({
    store: conflicting.store,
    objectStorage: conflicting.storage,
    provider: controlledProvider(async () => Buffer.from('new-derived-output')),
    workerId: 'derivative-service-worker'
  });
  const result = await conflictService.runDue({ tenant_id: conflicting.file.tenant_id });
  assert.equal(result.failed, 1);
  const [conflictJob] = await conflicting.store.listJobs(
    conflicting.file.tenant_id, conflicting.file.id
  );
  assert.equal(conflictJob?.error_code, 'derivative_output_conflict');
});

test('source checksum mismatch fails before provider invocation', async (t) => {
  const fixture = await derivativeFixture(
    t, 'tenant-derivative-service-source-checksum', 'image/png', { recordedSha256: 'f'.repeat(64) }
  );
  let invocations = 0;
  const service = new SecureFileDerivativeService({
    store: fixture.store,
    objectStorage: fixture.storage,
    provider: controlledProvider(async () => {
      invocations += 1;
      return Buffer.from('must-not-run');
    }),
    workerId: 'derivative-service-worker'
  });
  const summary = await service.runDue({ tenant_id: fixture.file.tenant_id });
  assert.equal(invocations, 0);
  assert.equal(summary.failed, 1);
  const [job] = await fixture.store.listJobs(fixture.file.tenant_id, fixture.file.id);
  assert.equal(job?.error_code, 'source_checksum_mismatch');
});

test('documents with no derivative requirement become ready without invoking a provider', async (t) => {
  const fixture = await derivativeFixture(t, 'tenant-derivative-service-document', 'application/pdf');
  let invocations = 0;
  const converged: string[] = [];
  const service = new SecureFileDerivativeService({
    store: fixture.store,
    objectStorage: fixture.storage,
    provider: controlledProvider(async () => {
      invocations += 1;
      return Buffer.from('must-not-run');
    }),
    workerId: 'derivative-service-worker',
    onFileConverged: (file) => {
      converged.push(`${file.id}:${file.status}`);
    }
  });
  const summary = await service.runDue({ tenant_id: fixture.file.tenant_id });
  assert.equal(invocations, 0);
  assert.equal(summary.claimed, 0);
  assert.equal(summary.files_ready, 1);
  assert.deepEqual(converged, [`${fixture.file.id}:ready`]);
});

function controlledProvider(
  derive: (input: FileDerivativeInput) => Promise<Buffer>
): FileDerivativeProvider {
  return {
    name: 'controlled-derivative-provider',
    mode: 'self_hosted',
    async derive(input) {
      const content = await derive(input);
      const output = input.derivative_kind === 'video_transcode'
        ? { mime: 'video/mp4', extension: '.mp4' }
        : input.derivative_kind === 'audio_transcode'
          ? { mime: 'audio/ogg', extension: '.ogg' }
          : { mime: 'image/jpeg', extension: '.jpg' };
      return { content, ...output, metadata: { engine: 'controlled' } };
    }
  };
}

async function derivativeFixture(
  t: { after(fn: () => void): void },
  tenantId: string,
  detectedMime: string,
  options: { recordedSha256?: string } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'ivekit-derivative-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pg = new MemoryPg();
  const storage = new LocalObjectStorage(root);
  const files = new SecureFileStore(pg);
  const content = Buffer.from('safe-source-bytes');
  const created = await files.createUpload({
    tenant_id: tenantId,
    session_id: `session-${tenantId}`,
    created_by: 'derivative-service-test',
    kind: detectedMime.startsWith('image/') ? 'image'
      : detectedMime.startsWith('video/') ? 'video'
        : detectedMime.startsWith('audio/') ? 'audio' : 'file',
    filename: 'source.bin',
    declared_mime: detectedMime,
    upload_mode: 'single',
    expected_size_bytes: content.length,
    idempotency_key: `upload-${tenantId}`,
    payload_hash: sha256(`payload-${tenantId}`)
  });
  await files.beginUpload({ tenant_id: tenantId, secure_file_id: created.id });
  const uploaded = await storage.upload({
    tenantId,
    filename: 'source.bin',
    body: content,
    contentType: detectedMime,
    keyPrefix: 'secure-files',
    resourceId: created.id
  });
  await files.completeUpload({
    tenant_id: tenantId,
    secure_file_id: created.id,
    size_bytes: content.length,
    sha256: options.recordedSha256 || sha256(content),
    object_key: uploaded.key
  });
  const file = await files.transitionStatus({
    tenant_id: tenantId,
    secure_file_id: created.id,
    from_status: 'scanning',
    to_status: 'processing',
    threat_status: 'clean',
    detected_mime: detectedMime,
    mime_conflict: false
  });
  return { pg, storage, file, store: new SecureFileDerivativeStore(pg) };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
