import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SecureFileCleanupService } from '../src/agent-runtime/collaboration/secure-file-cleanup-service.js';
import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { LocalObjectStorage, type ObjectStorage } from '../src/storage/object-storage.js';

test('cleanup dry-run reports bounded candidates without claiming, deleting, or mutating', async (t) => {
  const fixture = await retainedImageFixture(t, 'tenant-cleanup-dry-run');
  const service = new SecureFileCleanupService({
    store: fixture.files,
    derivativeStore: fixture.derivatives,
    objectStorage: fixture.storage,
    workerId: 'cleanup-worker'
  });

  const result = await service.run({
    tenant_id: fixture.tenantId,
    dry_run: true,
    limit: 10
  });
  assert.deepEqual(result, {
    dry_run: true,
    candidates: 1,
    claimed: 0,
    expired: 0,
    retry_wait: 0,
    objects_deleted: 0,
    objects_missing: 0,
    items: [{
      secure_file_id: fixture.fileId,
      prior_status: 'ready',
      outcome: 'would_expire',
      object_count: 2,
      cleanup_attempt_count: 0,
      error_code: ''
    }]
  });
  assert.ok(await fixture.storage.download(fixture.sourceKey));
  assert.ok(await fixture.storage.download(fixture.derivativeKey));
  assert.equal((await fixture.files.getFile(fixture.tenantId, fixture.fileId)).status, 'ready');
  await assert.rejects(
    () => service.run({ tenant_id: fixture.tenantId, dry_run: false, confirm: false }),
    /confirm=true is required/
  );
});

test('confirmed cleanup removes source and derivative objects before expiring state', async (t) => {
  const fixture = await retainedImageFixture(t, 'tenant-cleanup-confirmed');
  const processed: string[] = [];
  const service = new SecureFileCleanupService({
    store: fixture.files,
    derivativeStore: fixture.derivatives,
    objectStorage: fixture.storage,
    workerId: 'cleanup-worker',
    onProcessed: ({ file, outcome }) => {
      processed.push(`${file.id}:${outcome}`);
    }
  });

  const result = await service.run({
    tenant_id: fixture.tenantId,
    dry_run: false,
    confirm: true
  });
  assert.equal(result.expired, 1);
  assert.equal(result.retry_wait, 0);
  assert.equal(result.objects_deleted, 2);
  assert.equal(await fixture.storage.download(fixture.sourceKey), null);
  assert.equal(await fixture.storage.download(fixture.derivativeKey), null);
  assert.equal((await fixture.files.getFile(fixture.tenantId, fixture.fileId)).status, 'expired');
  assert.equal((await fixture.derivatives.listJobs(fixture.tenantId, fixture.fileId))[0]?.status, 'expired');
  assert.deepEqual(processed, [`${fixture.fileId}:expired`]);
  assert.doesNotMatch(JSON.stringify(result), /sourceKey|derivativeKey|secure-file-derivatives/);
});

test('partial object deletion is compensating and resumes after retry deadline', async (t) => {
  let now = new Date('2026-07-15T12:00:00.000Z');
  const fixture = await retainedImageFixture(t, 'tenant-cleanup-retry', { now: () => now });
  let failedOnce = false;
  const flaky: ObjectStorage = {
    ...fixture.storage,
    upload: fixture.storage.upload.bind(fixture.storage),
    download: fixture.storage.download.bind(fixture.storage),
    head: fixture.storage.head.bind(fixture.storage),
    initiateMultipart: fixture.storage.initiateMultipart.bind(fixture.storage),
    uploadPart: fixture.storage.uploadPart.bind(fixture.storage),
    completeMultipart: fixture.storage.completeMultipart.bind(fixture.storage),
    abortMultipart: fixture.storage.abortMultipart.bind(fixture.storage),
    async delete(key) {
      if (key === fixture.derivativeKey && !failedOnce) {
        failedOnce = true;
        throw Object.assign(new Error('private storage details'), {
          status: 503,
          code: 'storage_unavailable'
        });
      }
      return fixture.storage.delete(key);
    }
  };
  const service = new SecureFileCleanupService({
    store: fixture.files,
    derivativeStore: fixture.derivatives,
    objectStorage: flaky,
    workerId: 'cleanup-worker',
    now: () => now,
    retryDelayMs: 60_000
  });

  const first = await service.run({
    tenant_id: fixture.tenantId, dry_run: false, confirm: true
  });
  assert.equal(first.retry_wait, 1);
  assert.equal(first.objects_deleted, 1);
  assert.equal((await fixture.files.getFile(fixture.tenantId, fixture.fileId)).status, 'ready');
  assert.equal(await fixture.storage.download(fixture.sourceKey), null);
  assert.ok(await fixture.storage.download(fixture.derivativeKey));
  assert.doesNotMatch(JSON.stringify(first), /private storage details/i);

  assert.equal((await service.run({
    tenant_id: fixture.tenantId, dry_run: false, confirm: true
  })).claimed, 0);
  now = new Date('2026-07-15T12:01:01.000Z');
  const second = await service.run({
    tenant_id: fixture.tenantId, dry_run: false, confirm: true
  });
  assert.equal(second.expired, 1);
  assert.equal(second.objects_missing, 1);
  assert.equal(second.objects_deleted, 1);
  assert.equal((await fixture.files.getFile(fixture.tenantId, fixture.fileId)).status, 'expired');
});

async function retainedImageFixture(
  t: { after(fn: () => void): void },
  tenantId: string,
  options: { now?: () => Date } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'converact-cleanup-service-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pg = new MemoryPg();
  const storage = new LocalObjectStorage(root);
  const now = options.now || (() => new Date('2026-07-15T12:00:00.000Z'));
  const files = new SecureFileStore(pg, { now });
  const derivatives = new SecureFileDerivativeStore(pg, { now });
  const source = Buffer.from('cleanup-source');
  const created = await files.createUpload({
    tenant_id: tenantId,
    session_id: `session-${tenantId}`,
    created_by: 'cleanup-test',
    kind: 'image',
    filename: 'cleanup.png',
    declared_mime: 'image/png',
    upload_mode: 'single',
    expected_size_bytes: source.length,
    idempotency_key: `cleanup-${tenantId}`,
    payload_hash: sha256(`payload-${tenantId}`),
    retention_until: '2026-07-15T11:00:00.000Z'
  });
  await files.beginUpload({ tenant_id: tenantId, secure_file_id: created.id });
  const uploaded = await storage.upload({
    tenantId, filename: 'cleanup.png', body: source, contentType: 'image/png',
    keyPrefix: 'secure-files', resourceId: created.id
  });
  await files.completeUpload({
    tenant_id: tenantId, secure_file_id: created.id,
    size_bytes: source.length, sha256: sha256(source), object_key: uploaded.key
  });
  await files.transitionStatus({
    tenant_id: tenantId, secure_file_id: created.id,
    from_status: 'scanning', to_status: 'processing', threat_status: 'clean',
    detected_mime: 'image/png'
  });
  await derivatives.ensureJobs({ tenant_id: tenantId, secure_file_id: created.id });
  const [claim] = await derivatives.claimJobs({
    tenant_id: tenantId, worker_id: 'derivative-worker', lease_ms: 10_000
  });
  assert.ok(claim);
  const derivativeContent = Buffer.from('cleanup-thumbnail');
  const derivativeUploaded = await storage.upload({
    tenantId, filename: 'thumbnail.jpg', body: derivativeContent, contentType: 'image/jpeg',
    keyPrefix: 'secure-file-derivatives', resourceId: `${created.id}-image_thumbnail`
  });
  await derivatives.finishJob({
    tenant_id: tenantId, secure_file_id: created.id,
    derivative_kind: 'image_thumbnail', worker_id: 'derivative-worker',
    claim_token: claim.claim_token, outcome: 'ready',
    object_key: derivativeUploaded.key, mime: 'image/jpeg',
    size_bytes: derivativeContent.length, sha256: sha256(derivativeContent)
  });
  await derivatives.convergeFile({ tenant_id: tenantId, secure_file_id: created.id });
  return {
    tenantId,
    fileId: created.id,
    sourceKey: uploaded.key,
    derivativeKey: derivativeUploaded.key,
    files,
    derivatives,
    storage
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
