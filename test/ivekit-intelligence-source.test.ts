import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { createIntelligenceProviderRegistry } from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import { createPolicyAttachmentProviderResolver } from '../src/agent-runtime/collaboration/intelligence-provider-routing.js';
import { IntelligenceSourceService } from '../src/agent-runtime/collaboration/intelligence-source-service.js';
import { RemoteAssistanceStore } from '../src/agent-runtime/collaboration/remote-assistance-store.js';
import type { EgressRecord } from '../src/agent-runtime/livekit/types.js';
import { routeIveKitIntelligenceApi } from '../src/agent-runtime/ivekit/intelligence-http.js';

test('media recording import creates one system message, attachment, ASR job, and idempotent source link', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant-source-media';
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-source-media' }
  });
  const registry = createIntelligenceProviderRegistry({
    OPC_ASR_BASE_URL: 'http://asr-worker:8080'
  });
  const service = new IntelligenceSourceService({
    pg,
    registry,
    resolveProvider: createPolicyAttachmentProviderResolver({ pg, registry }),
    getMediaRecording: (id) => id === 'recording-media-1' ? mediaRecording({
      id,
      tenant_id: tenantId,
      business_ref_type: 'service_order',
      business_ref_id: 'order-source-media'
    }) : null
  });

  const created = await service.importSource({
    tenant_id: tenantId,
    session_id: session.id,
    source_type: 'media_recording',
    source_ref_id: 'recording-media-1',
    actor_identity: 'admin-source',
    idempotency_key: 'source-import-media-1'
  });
  assert.equal(created.replayed, false);
  assert.equal(created.source.source_type, 'media_recording');
  assert.equal(created.source.status, 'pending');
  assert.equal(created.attachment.kind, 'screen_recording');
  assert.equal(created.attachment.storage_url, 's3://recordings/tenant/media-1.webm');
  assert.equal(created.job?.processor, 'asr');
  assert.equal(created.job?.provider_profile_id, 'legacy-asr');

  const replayed = await service.importSource({
    tenant_id: tenantId,
    session_id: session.id,
    source_type: 'media_recording',
    source_ref_id: 'recording-media-1',
    actor_identity: 'admin-source',
    idempotency_key: 'source-import-media-1'
  });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.source.id, created.source.id);
  assert.equal(replayed.message.id, created.message.id);
  assert.equal((await store.listMessages({
    tenant_id: tenantId,
    session_id: session.id
  })).length, 1);

  await assert.rejects(
    () => service.importSource({
      tenant_id: tenantId,
      session_id: session.id,
      source_type: 'media_recording',
      source_ref_id: 'recording-media-other',
      actor_identity: 'admin-source',
      idempotency_key: 'source-import-media-1'
    }),
    (error: unknown) => Number((error as { status?: unknown }).status) === 409
  );
});

test('recording import rejects cross-tenant, wrong business ref, active, deleted, and missing objects', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant-source-reject';
  const session = await new CollaborationStore(pg).openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-source-reject' }
  });
  const registry = createIntelligenceProviderRegistry({});
  const records = new Map([
    ['foreign', mediaRecording({ id: 'foreign', tenant_id: 'other-tenant' })],
    ['wrong-ref', mediaRecording({ id: 'wrong-ref', tenant_id: tenantId, business_ref_id: 'other-order' })],
    ['active', mediaRecording({ id: 'active', tenant_id: tenantId, status: 'recording' })],
    ['deleted', mediaRecording({ id: 'deleted', tenant_id: tenantId, status: 'deleted' })],
    ['missing-url', mediaRecording({ id: 'missing-url', tenant_id: tenantId, storage_url: '' })]
  ]);
  const service = new IntelligenceSourceService({
    pg,
    registry,
    getMediaRecording: (id) => records.get(id) || null
  });

  for (const sourceRefId of ['foreign', 'wrong-ref', 'active', 'deleted', 'missing-url', 'not-found']) {
    await assert.rejects(
      () => service.importSource({
        tenant_id: tenantId,
        session_id: session.id,
        source_type: 'media_recording',
        source_ref_id: sourceRefId,
        actor_identity: 'admin-source',
        idempotency_key: `reject-${sourceRefId}`
      }),
      (error: unknown) => [404, 409, 422].includes(Number((error as { status?: unknown }).status)),
      sourceRefId
    );
  }
});

test('remote recording evidence imports by stable ID and never accepts caller storage URLs', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant-source-remote';
  const businessRef = { tenant_id: tenantId, type: 'service_order', id: 'order-source-remote' } as const;
  const session = await new CollaborationStore(pg).openSession({ tenant_id: tenantId, business_ref: businessRef });
  const evidence = await new RemoteAssistanceStore(pg).recordEvidence({
    tenant_id: tenantId,
    business_ref: businessRef,
    session_id: 'remote-session-1',
    kind: 'screen_recording',
    storage_url: 's3://recordings/tenant/remote-1.webm',
    checksum: 'sha256:remote-recording',
    created_by: 'remote-agent'
  });
  const registry = createIntelligenceProviderRegistry({});
  const service = new IntelligenceSourceService({ pg, registry });

  const imported = await service.importSource({
    tenant_id: tenantId,
    session_id: session.id,
    source_type: 'remote_recording',
    source_ref_id: evidence.id,
    actor_identity: 'admin-source',
    idempotency_key: 'source-import-remote-1'
  });
  assert.equal(imported.source.source_ref_id, evidence.id);
  assert.equal(imported.attachment.storage_url, evidence.storage_url);
  assert.equal(imported.job?.status, 'pending');
  assert.equal(imported.job?.error_code, 'provider_unavailable');

  await assert.rejects(
    () => service.importSource({
      tenant_id: tenantId,
      session_id: session.id,
      source_type: 'remote_recording',
      source_ref_id: 'https://caller.example/recording.webm',
      actor_identity: 'admin-source',
      idempotency_key: 'source-import-arbitrary-url'
    }),
    /source_ref_id is invalid/i
  );

  const previousApiKey = process.env.OPC_API_KEY;
  process.env.OPC_API_KEY = 'source-api-key';
  try {
    const path = `/api/ivekit/intelligence/sessions/${session.id}/sources`;
    await assert.rejects(
      () => routeIveKitIntelligenceApi(
        pg,
        'POST',
        path,
        new URL(`http://localhost${path}`),
        {
          source_type: 'remote_recording',
          source_ref_id: evidence.id,
          storage_url: 'https://caller.example/forbidden.webm'
        },
        {
          'x-api-key': 'source-api-key',
          'x-tenant-id': tenantId,
          'x-user-id': 'source-admin',
          'idempotency-key': 'source-route-invalid'
        },
        { registry, source: service }
      ),
      /unsupported intelligence source field: storage_url/i
    );
    const routed = await routeIveKitIntelligenceApi(
      pg,
      'POST',
      path,
      new URL(`http://localhost${path}`),
      { source_type: 'remote_recording', source_ref_id: evidence.id },
      {
        'x-api-key': 'source-api-key',
        'x-tenant-id': tenantId,
        'x-user-id': 'source-admin',
        'idempotency-key': 'source-route-replay'
      },
      { registry, source: service, publish: () => undefined }
    ) as { status: number; data: unknown; afterCommit: () => Promise<void> };
    assert.equal(routed.status, 200);
    assert.doesNotMatch(JSON.stringify(routed.data), /s3:\/\/|caller\.example|storage_url/i);
    assert.doesNotMatch(JSON.stringify(routed.data), /idempotency_key|request_hash|source-import-remote-1/i);
    await routed.afterCommit();
    assert.equal((await new CollaborationStore(pg).listMessages({
      tenant_id: tenantId,
      session_id: session.id
    })).length, 1);
  } finally {
    if (previousApiKey === undefined) delete process.env.OPC_API_KEY;
    else process.env.OPC_API_KEY = previousApiKey;
  }
});

function mediaRecording(overrides: Partial<EgressRecord> = {}): EgressRecord {
  return {
    id: 'recording-default',
    tenant_id: 'tenant-source-reject',
    call_session_id: 'call-1',
    media_call_id: 'media-call-1',
    room_name: 'room-1',
    business_ref_type: 'service_order',
    business_ref_id: 'order-source-reject',
    business_ref: null,
    source: 'livekit_egress',
    format: 'webm',
    storage_url: 's3://recordings/tenant/media-1.webm',
    duration_ms: 10_000,
    file_size_bytes: 1024,
    has_video: 1,
    egress_id: 'egress-1',
    status: 'completed',
    retention_until: '2099-01-01T00:00:00.000Z',
    object_status: 'readable',
    object_checked_at: null,
    failure_code: '',
    completed_at: '2026-07-13T00:00:00.000Z',
    deleted_at: null,
    updated_at: '2026-07-13T00:00:00.000Z',
    created_at: '2026-07-13T00:00:00.000Z',
    ...overrides
  };
}
