import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SecureFileDerivativeStore,
  requiredDerivativeKinds
} from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import type { SecureFile } from '../src/agent-runtime/collaboration/secure-file-types.js';
import { MemoryPg } from '../src/db-pg.js';

test('required derivative kinds are deterministic from authoritative MIME', () => {
  assert.deepEqual(requiredDerivativeKinds('image/png'), ['image_thumbnail']);
  assert.deepEqual(requiredDerivativeKinds('video/webm'), ['video_thumbnail', 'video_transcode']);
  assert.deepEqual(requiredDerivativeKinds('audio/wav'), ['audio_transcode']);
  assert.deepEqual(requiredDerivativeKinds('application/pdf'), []);
});

test('derivative jobs are idempotent, tenant scoped, and exclusively leased', async () => {
  const pg = new MemoryPg();
  const file = await processingFile(pg, 'tenant-derivative-a', 'image/png');
  const store = new SecureFileDerivativeStore(pg);
  const jobs = await store.ensureJobs({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    provider_profile_id: 'ffmpeg-primary'
  });
  assert.deepEqual(await store.ensureJobs({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    provider_profile_id: 'ffmpeg-primary'
  }), jobs);
  assert.deepEqual(jobs.map((job) => job.derivative_kind), ['image_thumbnail']);
  await assert.rejects(
    () => store.listJobs('tenant-derivative-b', file.id),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 404
  );

  const first = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker-a', limit: 1,
    lease_ms: 10_000, max_attempts: 3
  });
  assert.equal(first.length, 1);
  assert.equal((await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker-b', limit: 1,
    lease_ms: 10_000, max_attempts: 3
  })).length, 0);
  assert.doesNotMatch(JSON.stringify(first[0]?.derivative), /claim_token|lease_token_hash/);
});

test('ready derivative output converges the parent file exactly once', async () => {
  const pg = new MemoryPg();
  const file = await processingFile(pg, 'tenant-derivative-ready', 'image/png');
  const store = new SecureFileDerivativeStore(pg);
  await store.ensureJobs({ tenant_id: file.tenant_id, secure_file_id: file.id });
  const [claim] = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker', limit: 1,
    lease_ms: 10_000, max_attempts: 3
  });
  assert.ok(claim);
  const completed = await store.finishJob({
    tenant_id: file.tenant_id, secure_file_id: file.id,
    derivative_kind: claim.derivative.derivative_kind,
    worker_id: 'derivative-worker', claim_token: claim.claim_token,
    outcome: 'ready', object_key: `${file.tenant_id}/derivatives/${file.id}-thumbnail`,
    mime: 'image/jpeg', size_bytes: 13, sha256: 'a'.repeat(64),
    provider_request_id: 'request-1', provider_metadata: { engine: 'ffmpeg' }
  });
  assert.equal(completed.status, 'ready');
  assert.equal(completed.object_key.includes('thumbnail'), true);
  const converged = await store.convergeFile({ tenant_id: file.tenant_id, secure_file_id: file.id });
  assert.equal(converged.status, 'ready');
  assert.equal((await store.convergeFile({
    tenant_id: file.tenant_id, secure_file_id: file.id
  })).status, 'ready');
});

test('retry_wait can be reclaimed after its deadline and rejects a stale token', async () => {
  let now = new Date('2026-07-15T08:00:00.000Z');
  const pg = new MemoryPg();
  const file = await processingFile(pg, 'tenant-derivative-retry', 'audio/wav');
  const store = new SecureFileDerivativeStore(pg, { now: () => now });
  await store.ensureJobs({ tenant_id: file.tenant_id, secure_file_id: file.id });
  const [first] = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker-a',
    lease_ms: 5_000, max_attempts: 3
  });
  assert.ok(first);
  await store.finishJob({
    tenant_id: file.tenant_id, secure_file_id: file.id,
    derivative_kind: first.derivative.derivative_kind,
    worker_id: 'derivative-worker-a', claim_token: first.claim_token,
    outcome: 'retry_wait', error_code: 'derivative_timeout',
    next_attempt_at: '2026-07-15T08:00:06.000Z'
  });
  assert.equal((await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker-b',
    lease_ms: 5_000, max_attempts: 3
  })).length, 0);
  now = new Date('2026-07-15T08:00:07.000Z');
  const [second] = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker-b',
    lease_ms: 5_000, max_attempts: 3
  });
  assert.ok(second);
  await assert.rejects(
    () => store.finishJob({
      tenant_id: file.tenant_id, secure_file_id: file.id,
      derivative_kind: first.derivative.derivative_kind,
      worker_id: 'derivative-worker-a', claim_token: first.claim_token,
      outcome: 'failed', error_code: 'stale-worker'
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
});

test('an expired derivative lease is reclaimed after a worker crash', async () => {
  let now = new Date('2026-07-15T09:00:00.000Z');
  const pg = new MemoryPg();
  const file = await processingFile(pg, 'tenant-derivative-crash', 'image/png');
  const store = new SecureFileDerivativeStore(pg, { now: () => now });
  await store.ensureJobs({ tenant_id: file.tenant_id, secure_file_id: file.id });
  const [first] = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'crashed-worker',
    lease_ms: 5_000, max_attempts: 3
  });
  assert.ok(first);
  now = new Date('2026-07-15T09:00:06.000Z');
  const [recovered] = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'recovery-worker',
    lease_ms: 5_000, max_attempts: 3
  });
  assert.ok(recovered);
  assert.equal(recovered.derivative.attempt_count, 2);
  assert.notEqual(recovered.claim_token, first.claim_token);
});

test('all required video derivatives gate ready and a terminal partial failure fails closed', async () => {
  const pg = new MemoryPg();
  const file = await processingFile(pg, 'tenant-derivative-video', 'video/webm');
  const store = new SecureFileDerivativeStore(pg);
  const jobs = await store.ensureJobs({ tenant_id: file.tenant_id, secure_file_id: file.id });
  assert.equal(jobs.length, 2);
  const claims = await store.claimJobs({
    tenant_id: file.tenant_id, worker_id: 'derivative-worker', limit: 2,
    lease_ms: 10_000, max_attempts: 3
  });
  const thumbnail = claims.find((claim) => claim.derivative.derivative_kind === 'video_thumbnail');
  const transcode = claims.find((claim) => claim.derivative.derivative_kind === 'video_transcode');
  assert.ok(thumbnail);
  assert.ok(transcode);
  await store.finishJob({
    tenant_id: file.tenant_id, secure_file_id: file.id,
    derivative_kind: 'video_thumbnail', worker_id: 'derivative-worker',
    claim_token: thumbnail.claim_token, outcome: 'ready',
    object_key: `${file.tenant_id}/derivatives/video-thumbnail`, mime: 'image/jpeg',
    size_bytes: 10, sha256: 'b'.repeat(64)
  });
  assert.equal((await store.convergeFile({
    tenant_id: file.tenant_id, secure_file_id: file.id
  })).status, 'processing');
  await store.finishJob({
    tenant_id: file.tenant_id, secure_file_id: file.id,
    derivative_kind: 'video_transcode', worker_id: 'derivative-worker',
    claim_token: transcode.claim_token, outcome: 'failed', error_code: 'derivative_codec_failed'
  });
  const failed = await store.convergeFile({ tenant_id: file.tenant_id, secure_file_id: file.id });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure_code, 'required_derivative_failed');
});

test('files with no required derivative become ready without a synthetic job', async () => {
  const pg = new MemoryPg();
  const file = await processingFile(pg, 'tenant-derivative-document', 'application/pdf');
  const store = new SecureFileDerivativeStore(pg);
  assert.deepEqual(await store.ensureJobs({
    tenant_id: file.tenant_id, secure_file_id: file.id
  }), []);
  assert.equal((await store.convergeFile({
    tenant_id: file.tenant_id, secure_file_id: file.id
  })).status, 'ready');
});

async function processingFile(pg: MemoryPg, tenantId: string, detectedMime: string): Promise<SecureFile> {
  const files = new SecureFileStore(pg);
  const created = await files.createUpload({
    tenant_id: tenantId,
    session_id: `session-${tenantId}`,
    created_by: 'derivative-test',
    kind: detectedMime.startsWith('image/') ? 'image'
      : detectedMime.startsWith('video/') ? 'video'
        : detectedMime.startsWith('audio/') ? 'audio' : 'file',
    filename: 'source.bin',
    declared_mime: detectedMime,
    upload_mode: 'single',
    expected_size_bytes: 4,
    idempotency_key: `upload-${tenantId}`,
    payload_hash: 'f'.repeat(64)
  });
  await files.beginUpload({ tenant_id: tenantId, secure_file_id: created.id });
  await files.completeUpload({
    tenant_id: tenantId, secure_file_id: created.id,
    size_bytes: 4, sha256: 'e'.repeat(64), object_key: `${tenantId}/secure-files/${created.id}`
  });
  return files.transitionStatus({
    tenant_id: tenantId, secure_file_id: created.id,
    from_status: 'scanning', to_status: 'processing', threat_status: 'clean',
    detected_mime: detectedMime, mime_conflict: false
  });
}
