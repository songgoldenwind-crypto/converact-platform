import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import {
  SecureFileStore,
  assertSecureFileStatusTransition
} from '../src/agent-runtime/collaboration/secure-file-store.js';

const migrationPath = 'src/migrations/061_ivekit_file_security.sql';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('file security migration defines tenant-consistent durable state and forced RLS', () => {
  const sql = readFileSync(migrationPath, 'utf8');

  for (const table of [
    'collaboration_secure_files',
    'collaboration_secure_file_parts',
    'collaboration_secure_file_derivatives'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'), table);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(sql, new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'), table);
    assert.match(
      sql,
      new RegExp(
        `CREATE POLICY tenant_isolation ON ${table}[\\s\\S]*tenant_id = opc_current_tenant\\(\\)`,
        'i'
      ),
      table
    );
  }

  assert.match(sql, /UNIQUE \(tenant_id, session_id, idempotency_key\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(tenant_id, session_id, secure_file_id\)[\s\S]*REFERENCES collaboration_secure_files\(tenant_id, session_id, id\)/i
  );
  assert.match(sql, /ADD COLUMN IF NOT EXISTS secure_file_id TEXT/i);
  assert.match(sql, /opc_secure_file_status_transition_allowed/i);
  assert.match(sql, /opc_secure_file_status_guard/i);
  assert.match(sql, /next_attempt_at TIMESTAMPTZ/i);
  assert.match(sql, /opc_secure_file_worker_tenant_ids/i);
  assert.match(sql, /opc_secure_file_derivative_worker_tenant_ids/i);
  assert.match(sql, /opc_secure_file_cleanup_worker_tenant_ids/i);
  assert.match(sql, /cleanup_lease_token_hash TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_secure_files/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_secure_file_parts/i);
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON collaboration_secure_file_derivatives/i);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION opc_secure_file_status_transition_allowed\(TEXT, TEXT\) TO opc_runtime/i
  );
  assert.doesNotMatch(sql, /api_key|access_key|secret_key|password|bearer_token|provider_token/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});

test('secure file status machine permits the production path and rejects unsafe jumps', () => {
  for (const [from, to] of [
    ['initiated', 'uploading'],
    ['uploading', 'scanning'],
    ['scanning', 'processing'],
    ['scanning', 'quarantined'],
    ['processing', 'ready'],
    ['ready', 'expired'],
    ['quarantined', 'expired'],
    ['failed', 'expired']
  ] as const) {
    assert.doesNotThrow(() => assertSecureFileStatusTransition(from, to));
  }

  for (const [from, to] of [
    ['initiated', 'ready'],
    ['uploading', 'ready'],
    ['scanning', 'ready'],
    ['failed', 'uploading'],
    ['quarantined', 'processing'],
    ['quarantined', 'ready'],
    ['expired', 'ready']
  ] as const) {
    assert.throws(
      () => assertSecureFileStatusTransition(from, to),
      (error: unknown) => httpStatus(error) === 409,
      `${from} -> ${to}`
    );
  }
});

test('secure file create is idempotent and rejects payload reuse', async () => {
  const store = new SecureFileStore(new MemoryPg(), {
    now: () => new Date('2026-07-15T03:00:00.000Z')
  });
  const input = uploadInput();

  const created = await store.createUpload(input);
  const replay = await store.createUpload(input);

  assert.equal(replay.id, created.id);
  assert.equal(replay.status, 'initiated');
  await assert.rejects(
    () => store.createUpload({ ...input, payload_hash: HASH_B }),
    (error: unknown) => httpStatus(error) === 409
  );
});

test('secure file parts replay identical content and reject checksum conflicts', async () => {
  const store = new SecureFileStore(new MemoryPg(), {
    now: () => new Date('2026-07-15T03:10:00.000Z')
  });
  const file = await store.createUpload(uploadInput({ upload_mode: 'multipart' }));

  const first = await store.recordPart({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    part_number: 1,
    size_bytes: 6,
    sha256: HASH_A,
    object_key: `tenant/${file.id}/parts/1`,
    etag: 'etag-1'
  });
  const replay = await store.recordPart({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    part_number: 1,
    size_bytes: 6,
    sha256: HASH_A,
    object_key: `tenant/${file.id}/parts/1`,
    etag: 'etag-1'
  });

  assert.deepEqual(replay, first);
  assert.equal((await store.getFile(file.tenant_id, file.id)).status, 'uploading');
  await assert.rejects(
    () => store.recordPart({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      part_number: 1,
      size_bytes: 6,
      sha256: HASH_B,
      object_key: `tenant/${file.id}/parts/1-conflict`,
      etag: 'etag-conflict'
    }),
    (error: unknown) => httpStatus(error) === 409
  );
});

test('secure file complete is idempotent, validates totals, and is tenant scoped', async () => {
  const store = new SecureFileStore(new MemoryPg(), {
    now: () => new Date('2026-07-15T03:20:00.000Z')
  });
  const file = await store.createUpload(uploadInput({ upload_mode: 'multipart' }));
  await store.recordPart({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    part_number: 1,
    size_bytes: 6,
    sha256: HASH_A,
    object_key: `tenant/${file.id}/parts/1`,
    etag: 'etag-1'
  });

  await assert.rejects(
    () => store.completeUpload({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      size_bytes: 5,
      sha256: HASH_A,
      object_key: `tenant/${file.id}/original`
    }),
    (error: unknown) => httpStatus(error) === 409
  );

  const completed = await store.completeUpload({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    size_bytes: 6,
    sha256: HASH_A,
    object_key: `tenant/${file.id}/original`
  });
  const replay = await store.completeUpload({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    size_bytes: 6,
    sha256: HASH_A,
    object_key: `tenant/${file.id}/original`
  });

  assert.equal(completed.status, 'scanning');
  assert.deepEqual(replay, completed);
  await assert.rejects(
    () => store.completeUpload({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      size_bytes: 6,
      sha256: HASH_B,
      object_key: `tenant/${file.id}/original`
    }),
    (error: unknown) => httpStatus(error) === 409
  );
  await assert.rejects(
    () => store.getFile('tenant-other', file.id),
    (error: unknown) => httpStatus(error) === 404
  );
});

test('quarantined secure files are terminal and cannot enter downstream processing', async () => {
  const store = new SecureFileStore(new MemoryPg(), {
    now: () => new Date('2026-07-15T03:30:00.000Z')
  });
  const file = await store.createUpload(uploadInput({ upload_mode: 'single' }));
  await store.beginUpload({ tenant_id: file.tenant_id, secure_file_id: file.id });
  await store.completeUpload({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    size_bytes: 6,
    sha256: HASH_A,
    object_key: `tenant/${file.id}/original`
  });
  const quarantined = await store.transitionStatus({
    tenant_id: file.tenant_id,
    secure_file_id: file.id,
    from_status: 'scanning',
    to_status: 'quarantined',
    threat_status: 'infected',
    failure_code: 'malware_detected'
  });

  assert.equal(quarantined.status, 'quarantined');
  assert.equal(quarantined.threat_status, 'infected');
  await assert.rejects(
    () => store.transitionStatus({
      tenant_id: file.tenant_id,
      secure_file_id: file.id,
      from_status: 'quarantined',
      to_status: 'processing',
      threat_status: 'clean'
    }),
    (error: unknown) => httpStatus(error) === 409
  );
});

test('cleanup claims are exclusive, retryable, and expire abandoned multipart state', async () => {
  let now = new Date('2026-07-15T08:00:00.000Z');
  const store = new SecureFileStore(new MemoryPg(), { now: () => now });
  const created = await store.createUpload({
    ...uploadInput(),
    tenant_id: 'tenant-cleanup',
    session_id: 'session-cleanup',
    idempotency_key: 'cleanup-upload',
    payload_hash: HASH_B
  });
  await store.recordPart({
    tenant_id: 'tenant-cleanup', secure_file_id: created.id, part_number: 1,
    size_bytes: 4, sha256: HASH_A,
    object_key: `tenant-cleanup/${created.id}/parts/1`, etag: 'cleanup-part'
  });
  now = new Date('2026-07-15T10:00:00.000Z');
  assert.deepEqual(await store.discoverCleanupTenantIds({ upload_stale_ms: 60 * 60_000 }), [
    'tenant-cleanup'
  ]);
  assert.equal((await store.listCleanupCandidates({
    tenant_id: 'tenant-cleanup', upload_stale_ms: 60 * 60_000
  })).length, 1);
  const [claim] = await store.claimCleanupJobs({
    tenant_id: 'tenant-cleanup', worker_id: 'cleanup-worker-a',
    upload_stale_ms: 60 * 60_000, lease_ms: 10_000
  });
  assert.ok(claim);
  assert.doesNotMatch(JSON.stringify(claim.file), /cleanup_lease|cleanup_worker|cleanup_attempt/);
  assert.equal((await store.claimCleanupJobs({
    tenant_id: 'tenant-cleanup', worker_id: 'cleanup-worker-b',
    upload_stale_ms: 60 * 60_000, lease_ms: 10_000
  })).length, 0);
  await store.finishCleanupJob({
    tenant_id: 'tenant-cleanup', secure_file_id: created.id,
    worker_id: 'cleanup-worker-a', claim_token: claim.claim_token,
    outcome: 'retry_wait', error_code: 'storage_unavailable',
    next_attempt_at: '2026-07-15T10:01:00.000Z'
  });
  assert.equal((await store.claimCleanupJobs({
    tenant_id: 'tenant-cleanup', worker_id: 'cleanup-worker-b',
    upload_stale_ms: 60 * 60_000, lease_ms: 10_000
  })).length, 0);
  now = new Date('2026-07-15T10:01:01.000Z');
  const [retry] = await store.claimCleanupJobs({
    tenant_id: 'tenant-cleanup', worker_id: 'cleanup-worker-b',
    upload_stale_ms: 60 * 60_000, lease_ms: 10_000
  });
  assert.ok(retry);
  const expired = await store.finishCleanupJob({
    tenant_id: 'tenant-cleanup', secure_file_id: created.id,
    worker_id: 'cleanup-worker-b', claim_token: retry.claim_token,
    outcome: 'expired'
  });
  assert.equal(expired.status, 'expired');
  assert.equal((await store.listParts('tenant-cleanup', created.id))[0]?.status, 'aborted');
});

test('retention cleanup can expire quarantined files without allowing downstream reuse', async () => {
  const store = new SecureFileStore(new MemoryPg(), {
    now: () => new Date('2026-07-15T12:00:00.000Z')
  });
  const created = await store.createUpload({
    ...uploadInput(),
    tenant_id: 'tenant-quarantine-cleanup',
    session_id: 'session-quarantine-cleanup',
    idempotency_key: 'quarantine-cleanup',
    payload_hash: HASH_B,
    retention_until: '2026-07-15T11:00:00.000Z'
  });
  await store.recordPart({
    tenant_id: created.tenant_id, secure_file_id: created.id, part_number: 1,
    size_bytes: created.expected_size_bytes, sha256: HASH_A,
    object_key: `${created.tenant_id}/${created.id}/parts/1`, etag: 'quarantine-cleanup'
  });
  await store.completeUpload({
    tenant_id: created.tenant_id, secure_file_id: created.id,
    size_bytes: created.expected_size_bytes, sha256: HASH_A,
    object_key: `${created.tenant_id}/${created.id}/original`
  });
  await store.transitionStatus({
    tenant_id: created.tenant_id, secure_file_id: created.id,
    from_status: 'scanning', to_status: 'quarantined', threat_status: 'infected',
    detected_mime: 'application/pdf', failure_code: 'malware_detected'
  });
  const [claim] = await store.claimCleanupJobs({
    tenant_id: created.tenant_id, worker_id: 'cleanup-worker', upload_stale_ms: 60_000
  });
  assert.ok(claim);
  const expired = await store.finishCleanupJob({
    tenant_id: created.tenant_id, secure_file_id: created.id,
    worker_id: 'cleanup-worker', claim_token: claim.claim_token, outcome: 'expired'
  });
  assert.equal(expired.status, 'expired');
  assert.throws(
    () => assertSecureFileStatusTransition(expired.status, 'processing'),
    (error: unknown) => httpStatus(error) === 409
  );
});

function uploadInput(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-secure-file',
    session_id: 'session-secure-file',
    created_by: 'agent-1',
    kind: 'file' as const,
    filename: 'same-name.pdf',
    declared_mime: 'application/pdf',
    upload_mode: 'multipart' as const,
    expected_size_bytes: 6,
    part_size_bytes: 6,
    idempotency_key: 'upload-1',
    payload_hash: HASH_A,
    ...overrides
  };
}

function httpStatus(error: unknown): number {
  return Number((error as { status?: unknown })?.status || 0);
}
