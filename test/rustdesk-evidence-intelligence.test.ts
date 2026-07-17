import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { RustDeskEvidenceIntelligenceService } from '../src/agent-runtime/collaboration/rustdesk-evidence-intelligence.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import type {
  SecureFile,
  SecureFileKind
} from '../src/agent-runtime/collaboration/secure-file-types.js';

test('clean RustDesk PDF evidence is idempotently enqueued for OCR', async () => {
  const pg = new MemoryPg();
  const file = await readyRustDeskFile(pg, {
    kind: 'file',
    detected_mime: 'application/pdf'
  });
  const service = serviceFor(pg);

  const first = await service.enqueueFile(file);
  const replay = await service.enqueueFile(file);

  assert.equal(first.status, 'enqueued');
  assert.equal(first.replayed, false);
  assert.equal(first.attachment?.secure_file_id, file.id);
  assert.equal(first.attachment?.kind, 'file');
  assert.deepEqual(first.jobs.map((job) => job.processor), ['ocr']);
  assert.equal(replay.status, 'enqueued');
  assert.equal(replay.replayed, true);
  assert.equal(replay.message?.id, first.message?.id);
  assert.equal(replay.attachment?.id, first.attachment?.id);
  assert.equal(replay.jobs[0]?.id, first.jobs[0]?.id);
  assert.equal(replay.message?.metadata.internal_processing_only, true);
  assert.equal(replay.message?.metadata.operation_id, 'transfer-1');
});

test('screen recordings enqueue both ASR and sampled-frame OCR', async () => {
  const pg = new MemoryPg();
  const file = await readyRustDeskFile(pg, {
    kind: 'screen_recording',
    detected_mime: 'video/webm',
    operation_id: 'recording-1',
    authorization_scope: 'session',
    authorization_id: 'gateway-session-1'
  });

  const result = await serviceFor(pg).enqueueFile(file);

  assert.equal(result.status, 'enqueued');
  assert.equal(result.attachment?.kind, 'screen_recording');
  assert.deepEqual(
    result.jobs.map((job) => job.processor).sort(),
    ['asr', 'video_frame_ocr']
  );
});

test('reconciliation recovers ready evidence idempotently after a missed convergence callback', async () => {
  const pg = new MemoryPg();
  const file = await readyRustDeskFile(pg, {
    kind: 'file',
    detected_mime: 'application/pdf'
  });
  const enqueued: string[] = [];
  const service = serviceFor(pg);

  const first = await service.reconcileDue({
    onEnqueued: (candidate) => { enqueued.push(candidate.id); }
  });
  const replay = await service.reconcileDue({
    onEnqueued: (candidate) => { enqueued.push(candidate.id); }
  });

  assert.deepEqual(first, {
    candidates: 1,
    enqueued: 1,
    replayed: 0,
    skipped: 0,
    failed: 0
  });
  assert.deepEqual(replay, {
    candidates: 1,
    enqueued: 0,
    replayed: 1,
    skipped: 0,
    failed: 0
  });
  assert.deepEqual(enqueued, [file.id]);
});

test('non-ready, unsupported, and unrelated files never create intelligence messages', async () => {
  const pg = new MemoryPg();
  const cleanText = await readyRustDeskFile(pg, {
    kind: 'file',
    detected_mime: 'text/plain'
  });
  const unrelated = {
    ...cleanText,
    id: 'secure-file-unrelated',
    metadata: { ...cleanText.metadata, source: 'chat_attachment' }
  };
  const quarantined = {
    ...cleanText,
    id: 'secure-file-quarantined',
    status: 'quarantined',
    threat_status: 'infected'
  } as SecureFile;
  const service = serviceFor(pg);

  assert.equal((await service.enqueueFile(cleanText)).status, 'unsupported');
  assert.equal((await service.enqueueFile(unrelated)).status, 'ignored');
  assert.equal((await service.enqueueFile(quarantined)).status, 'not_ready');
  const messages = await new CollaborationStore(pg).listMessages({
    tenant_id: cleanText.tenant_id,
    session_id: cleanText.session_id
  });
  assert.equal(messages.length, 0);
});

test('reconciliation marks unsupported evidence so it cannot starve later candidates', async () => {
  const pg = new MemoryPg();
  const unsupported = await readyRustDeskFile(pg, {
    kind: 'file',
    detected_mime: 'text/plain'
  });
  const service = serviceFor(pg);

  assert.deepEqual(await service.reconcileDue({ limit: 1 }), {
    candidates: 1,
    enqueued: 0,
    replayed: 0,
    skipped: 1,
    failed: 0
  });
  const remaining = await new SecureFileStore(pg)
    .listRustDeskEvidenceIntelligenceCandidates({ limit: 100 });
  assert.equal(remaining.some((file) => file.id === unsupported.id), false);

  const supported = await readyRustDeskFile(pg, {
    kind: 'file',
    detected_mime: 'application/pdf',
    operation_id: 'transfer-after-unsupported'
  });
  assert.deepEqual(await service.reconcileDue({ limit: 1 }), {
    candidates: 1,
    enqueued: 1,
    replayed: 0,
    skipped: 0,
    failed: 0
  });
  const messages = await new CollaborationStore(pg).listMessages({
    tenant_id: supported.tenant_id,
    session_id: supported.session_id
  });
  assert.equal(messages.some((message) =>
    message.attachments.some((attachment) => attachment.secure_file_id === supported.id)
  ), true);
});

function serviceFor(pg: MemoryPg): RustDeskEvidenceIntelligenceService {
  return new RustDeskEvidenceIntelligenceService({
    pg,
    resolveProvider: async ({ processor }) => ({
      enabled: true,
      automatic: true,
      profile_id: `test-${processor}`,
      provider: null,
      error_code: 'provider_unavailable'
    })
  });
}

async function readyRustDeskFile(
  pg: MemoryPg,
  input: {
    kind: SecureFileKind;
    detected_mime: string;
    operation_id?: string;
    authorization_scope?: 'operation' | 'session';
    authorization_id?: string;
  }
): Promise<SecureFile> {
  const tenantId = 'tenant-rustdesk-intelligence';
  const sessions = new CollaborationStore(pg);
  const existing = await sessions.listByBusinessRef({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'support_ticket', id: 'ticket-1' }
  });
  const session = existing[0] || await sessions.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'support_ticket', id: 'ticket-1' }
  });
  const files = new SecureFileStore(pg);
  const operationId = input.operation_id || 'transfer-1';
  const authorizationScope = input.authorization_scope || 'operation';
  const authorizationId = input.authorization_id || operationId;
  const created = await files.createUpload({
    tenant_id: tenantId,
    session_id: session.id,
    created_by: 'rustdesk-edge-1',
    kind: input.kind,
    filename: input.kind === 'screen_recording' ? 'recording.webm' : 'evidence.bin',
    declared_mime: input.detected_mime,
    upload_mode: 'single',
    expected_size_bytes: 4,
    idempotency_key: `rustdesk-intelligence-${input.kind}-${input.detected_mime}`,
    payload_hash: 'a'.repeat(64),
    metadata: {
      source: 'rustdesk_companion_evidence',
      source_origin: 'rustdesk_native_event',
      native_event_id: `native-${operationId}`,
      gateway_external_id: 'gateway-session-1',
      operation_id: operationId,
      authorization_scope: authorizationScope,
      authorization_id: authorizationId,
      observed_at: '2026-07-16T08:00:00.000Z',
      ...(authorizationScope === 'operation'
        ? { direction: 'download', control_version: 2 }
        : {})
    }
  });
  await files.beginUpload({ tenant_id: tenantId, secure_file_id: created.id });
  await files.completeUpload({
    tenant_id: tenantId,
    secure_file_id: created.id,
    size_bytes: 4,
    sha256: 'b'.repeat(64),
    object_key: `${tenantId}/secure-files/${created.id}`
  });
  await files.transitionStatus({
    tenant_id: tenantId,
    secure_file_id: created.id,
    from_status: 'scanning',
    to_status: 'processing',
    threat_status: 'clean',
    detected_mime: input.detected_mime,
    mime_conflict: false
  });
  return files.transitionStatus({
    tenant_id: tenantId,
    secure_file_id: created.id,
    from_status: 'processing',
    to_status: 'ready'
  });
}
