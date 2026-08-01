import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import {
  SecureFileScanService
} from '../src/agent-runtime/collaboration/secure-file-scan-service.js';
import {
  ControlledFileThreatScanner,
  FileThreatScannerError,
  type FileThreatScanner
} from '../src/agent-runtime/collaboration/file-threat-scanner.js';
import { LocalObjectStorage } from '../src/storage/object-storage.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

test('scan service verifies MIME and moves clean files into processing', async (t) => {
  const harness = scanHarness(t);
  const pending = await harness.pendingFile(pngFixture(), 'image/png');
  const service = new SecureFileScanService({
    store: harness.store,
    objectStorage: harness.storage,
    scanner: new ControlledFileThreatScanner(),
    now: harness.now,
    workerId: 'scan-worker-clean'
  });

  const summary = await service.runDue({ tenant_id: pending.tenant_id, limit: 10 });
  const file = await harness.store.getFile(pending.tenant_id, pending.id);

  assert.deepEqual(summary, {
    candidates: 1, claimed: 1, clean: 1, quarantined: 0, retry_wait: 0, failed: 0
  });
  assert.equal(file.status, 'processing');
  assert.equal(file.threat_status, 'clean');
  assert.equal(file.detected_mime, 'image/png');
  assert.equal(file.mime_conflict, false);
  assert.equal(file.worker_id, '');
  assert.equal(file.lease_until, null);
});

test('MIME conflict quarantines before scanner invocation by default', async (t) => {
  const harness = scanHarness(t);
  const pending = await harness.pendingFile(pngFixture(), 'application/pdf');
  let scans = 0;
  const scanner: FileThreatScanner = {
    name: 'must-not-run', mode: 'controlled',
    async scan() { scans += 1; return { status: 'clean', engine: 'test', metadata: {} }; }
  };
  const service = new SecureFileScanService({
    store: harness.store, objectStorage: harness.storage, scanner,
    now: harness.now, workerId: 'scan-worker-conflict'
  });

  await service.runDue({ tenant_id: pending.tenant_id });
  const file = await harness.store.getFile(pending.tenant_id, pending.id);
  assert.equal(scans, 0);
  assert.equal(file.status, 'quarantined');
  assert.equal(file.threat_status, 'error');
  assert.equal(file.failure_code, 'mime_conflict');
  assert.equal(file.detected_mime, 'image/png');
});

test('infected files are terminally quarantined without plaintext evidence', async (t) => {
  const harness = scanHarness(t);
  const pending = await harness.pendingFile(
    Buffer.concat([pngFixture(), Buffer.from(EICAR)]),
    'image/png'
  );
  const service = new SecureFileScanService({
    store: harness.store, objectStorage: harness.storage,
    scanner: new ControlledFileThreatScanner(), now: harness.now,
    workerId: 'scan-worker-infected'
  });

  const summary = await service.runDue({ tenant_id: pending.tenant_id });
  const file = await harness.store.getFile(pending.tenant_id, pending.id);
  assert.equal(summary.quarantined, 1);
  assert.equal(file.status, 'quarantined');
  assert.equal(file.threat_status, 'infected');
  assert.equal(file.failure_code, 'eicar_test_signature');
  assert.doesNotMatch(JSON.stringify(file), /STANDARD-ANTIVIRUS|X5O!/i);
});

test('retryable scanner errors wait, recover, and never expose provider details', async (t) => {
  const harness = scanHarness(t);
  const pending = await harness.pendingFile(pngFixture(), 'image/png');
  let attempts = 0;
  const scanner: FileThreatScanner = {
    name: 'flaky-scanner', mode: 'self_hosted',
    async scan() {
      attempts += 1;
      if (attempts === 1) {
        throw new FileThreatScannerError('private scanner address and token', 'scanner_timeout', true);
      }
      return { status: 'clean', engine: 'flaky', metadata: {} };
    }
  };
  const service = new SecureFileScanService({
    store: harness.store, objectStorage: harness.storage, scanner,
    now: harness.now, workerId: 'scan-worker-retry', retryDelaysMs: [1_000], maxAttempts: 2
  });

  const first = await service.runDue({ tenant_id: pending.tenant_id });
  let file = await harness.store.getFile(pending.tenant_id, pending.id);
  assert.equal(first.retry_wait, 1);
  assert.equal(file.status, 'scanning');
  assert.equal(file.threat_status, 'pending');
  assert.equal(file.failure_code, 'scanner_timeout');
  assert.equal(file.next_attempt_at, '2026-07-15T04:00:01.000Z');
  assert.doesNotMatch(JSON.stringify(file), /private scanner|token/i);

  assert.equal((await service.runDue({ tenant_id: pending.tenant_id })).claimed, 0);
  harness.advance(1_001);
  const second = await service.runDue({ tenant_id: pending.tenant_id });
  file = await harness.store.getFile(pending.tenant_id, pending.id);
  assert.equal(second.clean, 1);
  assert.equal(file.status, 'processing');
  assert.equal(file.scan_attempt_count, 2);
});

test('object checksum mismatch fails closed before scanner invocation', async (t) => {
  const harness = scanHarness(t);
  const pending = await harness.pendingFile(pngFixture(), 'image/png', { recordedSha256: 'f'.repeat(64) });
  let scans = 0;
  const scanner: FileThreatScanner = {
    name: 'must-not-run', mode: 'controlled',
    async scan() { scans += 1; return { status: 'clean', engine: 'test', metadata: {} }; }
  };
  const service = new SecureFileScanService({
    store: harness.store, objectStorage: harness.storage, scanner,
    now: harness.now, workerId: 'scan-worker-checksum', maxAttempts: 1
  });

  const summary = await service.runDue({ tenant_id: pending.tenant_id });
  const file = await harness.store.getFile(pending.tenant_id, pending.id);
  assert.equal(scans, 0);
  assert.equal(summary.failed, 1);
  assert.equal(file.status, 'failed');
  assert.equal(file.failure_code, 'object_checksum_mismatch');
});

test('scan claims are exclusive and an expired lease can be recovered', async (t) => {
  const harness = scanHarness(t);
  const pending = await harness.pendingFile(pngFixture(), 'image/png');
  const first = await harness.store.claimScanJobs({
    tenant_id: pending.tenant_id, worker_id: 'worker-one', limit: 1,
    lease_ms: 5_000, max_attempts: 3
  });
  const competing = await harness.store.claimScanJobs({
    tenant_id: pending.tenant_id, worker_id: 'worker-two', limit: 1,
    lease_ms: 5_000, max_attempts: 3
  });
  assert.equal(first.length, 1);
  assert.equal(competing.length, 0);

  harness.advance(5_001);
  const recovered = await harness.store.claimScanJobs({
    tenant_id: pending.tenant_id, worker_id: 'worker-two', limit: 1,
    lease_ms: 5_000, max_attempts: 3
  });
  assert.equal(recovered.length, 1);
  assert.notEqual(recovered[0].claim_token, first[0].claim_token);
  assert.equal(recovered[0].file.scan_attempt_count, 2);

  await assert.rejects(
    () => harness.store.finishScanJob({
      tenant_id: pending.tenant_id, secure_file_id: pending.id,
      worker_id: 'worker-one', claim_token: first[0].claim_token,
      outcome: 'clean', detected_mime: 'image/png', mime_conflict: false
    }),
    (error: unknown) => Number((error as { status?: unknown })?.status || 0) === 409
  );
});

function scanHarness(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'converact-secure-file-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = new Date('2026-07-15T04:00:00.000Z');
  const pg = new MemoryPg();
  const store = new SecureFileStore(pg, { now: () => clock });
  const storage = new LocalObjectStorage(root);
  let sequence = 0;
  return {
    store,
    storage,
    now: () => clock,
    advance(ms: number) { clock = new Date(clock.getTime() + ms); },
    async pendingFile(
      content: Buffer,
      declaredMime: string,
      options: { recordedSha256?: string } = {}
    ) {
      sequence += 1;
      const created = await store.createUpload({
        tenant_id: 'tenant-scan', session_id: 'session-scan', created_by: 'agent-scan',
        kind: 'file', filename: `scan-${sequence}.bin`, declared_mime: declaredMime,
        upload_mode: 'single', expected_size_bytes: content.length,
        idempotency_key: `scan-upload-${sequence}`, payload_hash: sha256(`payload-${sequence}`)
      });
      const uploaded = await storage.upload({
        tenantId: created.tenant_id, filename: created.filename, body: content,
        contentType: declaredMime, keyPrefix: 'secure-files', resourceId: created.id
      });
      await store.beginUpload({ tenant_id: created.tenant_id, secure_file_id: created.id });
      return store.completeUpload({
        tenant_id: created.tenant_id, secure_file_id: created.id,
        size_bytes: content.length,
        sha256: options.recordedSha256 || sha256(content),
        object_key: uploaded.key
      });
    }
  };
}

function pngFixture(): Buffer {
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    Buffer.alloc(256)
  ]);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
