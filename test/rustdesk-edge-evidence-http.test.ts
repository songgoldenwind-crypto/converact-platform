import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { SecureFileDerivativeStore } from '../src/agent-runtime/collaboration/secure-file-derivative-store.js';
import { SecureFileService } from '../src/agent-runtime/collaboration/secure-file-service.js';
import { SecureFileStore } from '../src/agent-runtime/collaboration/secure-file-store.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { createRustDeskEdgeCommandToken } from '../src/agent-runtime/collaboration/rustdesk-edge-auth.js';
import {
  RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS,
  assertRustDeskEvidenceSessionWindow
} from '../src/agent-runtime/collaboration/rustdesk-edge-evidence-http.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg } from '../src/db-pg.js';
import { LocalObjectStorage } from '../src/storage/object-storage.js';

const EDGE_SECRET = 'rustdesk-edge-evidence-http-secret-32-bytes';

test('device evidence single upload enters the shared scan gate without exposing storage internals', async (t) => {
  const fixture = await evidenceFixture(t);
  const path = `/api/ivekit/rustdesk/devices/${fixture.device.id}/evidence`;
  const content = Buffer.from('controlled RustDesk recording bytes');
  const observedAt = new Date().toISOString();
  const created = await fixture.route('POST', path, {
    native_event_id: 'native-recording-1',
    source_origin: 'rustdesk_native_event',
    external_id: fixture.session.external_id,
    operation_id: 'recording-1',
    authorization_scope: 'session',
    authorization_id: fixture.session.external_id,
    kind: 'screen_recording',
    filename: 'remote-session.webm',
    declared_mime: 'video/webm',
    upload_mode: 'single',
    expected_size_bytes: content.length,
    observed_at: observedAt,
    retention_until: '2026-08-15T00:00:00.000Z'
  }, '', { 'idempotency-key': 'recording-1' }) as {
    status: number;
    data: { file: { file_id: string; status: string; session_id: string } };
  };
  assert.equal(created.status, 201);
  assert.equal(created.data.file.status, 'initiated');
  assert.equal(created.data.file.session_id, fixture.collaborationSessionId);
  assert.doesNotMatch(JSON.stringify(created), /object_key|storage_url|upload_id|edge-token/);

  const replay = await fixture.route('POST', path, {
    native_event_id: 'native-recording-1',
    source_origin: 'rustdesk_native_event',
    external_id: fixture.session.external_id,
    operation_id: 'recording-1',
    authorization_scope: 'session',
    authorization_id: fixture.session.external_id,
    kind: 'screen_recording',
    filename: 'remote-session.webm',
    declared_mime: 'video/webm',
    upload_mode: 'single',
    expected_size_bytes: content.length,
    observed_at: observedAt,
    retention_until: '2026-08-15T00:00:00.000Z'
  }, '', { 'idempotency-key': 'recording-1' }) as {
    data: { file: { file_id: string } };
  };
  assert.equal(replay.data.file.file_id, created.data.file.file_id);

  const fileId = created.data.file.file_id;
  const uploaded = await fixture.route(
    'PUT', `${path}/${fileId}/content`, null, content,
    { 'x-content-sha256': sha256(content) }
  ) as { data: { file: { status: string; sha256: string; size_bytes: number } } };
  assert.equal(uploaded.data.file.status, 'scanning');
  assert.equal(uploaded.data.file.sha256, sha256(content));
  assert.equal(uploaded.data.file.size_bytes, content.length);

  const internal = await fixture.files.getFile(fixture.tenantId, fileId);
  assert.equal(internal.metadata.source, 'rustdesk_companion_evidence');
  assert.equal(internal.metadata.rustdesk_device_id, fixture.device.id);
  assert.equal(internal.metadata.gateway_external_id, fixture.session.external_id);
  assert.equal(internal.metadata.operation_id, 'recording-1');
  assert.equal(internal.metadata.native_event_id, 'native-recording-1');
  assert.equal(internal.metadata.authorization_scope, 'session');
  assert.equal(internal.metadata.authorization_id, fixture.session.external_id);
  const observation = await fixture.route(
    'POST',
    `/api/ivekit/rustdesk/devices/${fixture.device.id}/observations`,
    { observations: [{
      external_id: fixture.session.external_id,
      operation_id: 'recording-1',
      operation: 'record_screen',
      status: 'observed_succeeded',
      observer: 'edge_adapter',
      source_adapter: 'companion_hook',
      observed_at: new Date().toISOString(),
      evidence_security: 'ivekit_secure_file',
      evidence_refs: [{
        type: 'ivekit_secure_file',
        ref: `ivekit-secure-file://${fileId}`,
        sha256: `sha256:${sha256(content)}`
      }],
      byte_count: content.length,
      checksum_sha256: `sha256:${sha256(content)}`
    }] }
  ) as { status: number; data: { events: Array<{ metadata: Record<string, unknown> }> } };
  assert.equal(observation.status, 201);
  assert.equal(observation.data.events[0].metadata.evidence_security, 'ivekit_secure_file');
  await assert.rejects(
    () => fixture.secureFiles.download({
      tenant_id: fixture.tenantId,
      session_id: fixture.collaborationSessionId,
      secure_file_id: fileId
    }),
    /secure file is not available for download/
  );
});

test('device evidence supports multipart resume and rejects device, session, and local-path drift', async (t) => {
  const fixture = await evidenceFixture(t);
  const path = `/api/ivekit/rustdesk/devices/${fixture.device.id}/evidence`;
  const created = await fixture.route('POST', path, {
    native_event_id: 'native-file-transfer-1',
    source_origin: 'rustdesk_native_event',
    external_id: fixture.session.external_id,
    operation_id: 'file-transfer-1',
    authorization_scope: 'operation',
    authorization_id: 'rdop-file-transfer-1',
    kind: 'file',
    filename: 'diagnostic.bin',
    declared_mime: 'application/octet-stream',
    upload_mode: 'multipart',
    expected_size_bytes: 6,
    part_size_bytes: 3,
    observed_at: new Date().toISOString(),
    direction: 'upload',
    control_version: 3
  }, '', { 'idempotency-key': 'file-transfer-1' }) as {
    data: { file: { file_id: string } };
  };
  const fileId = created.data.file.file_id;
  for (const [part, value] of [[1, 'abc'], [2, 'def']] as const) {
    const content = Buffer.from(value);
    await fixture.route('PUT', `${path}/${fileId}/parts/${part}`, null, content, {
      'x-content-sha256': sha256(content)
    });
  }
  const parts = await fixture.route('GET', `${path}/${fileId}/parts`, null) as {
    data: { parts: Array<{ part_number: number; status: string }> };
  };
  assert.deepEqual(parts.data.parts.map((part) => [part.part_number, part.status]), [
    [1, 'uploaded'], [2, 'uploaded']
  ]);
  const completed = await fixture.route('POST', `${path}/${fileId}/complete`, {
    size_bytes: 6,
    sha256: sha256('abcdef')
  }) as { data: { file: { status: string } } };
  assert.equal(completed.data.file.status, 'scanning');

  const nativeObservation = await fixture.route(
    'POST',
    `/api/ivekit/rustdesk/devices/${fixture.device.id}/observations`,
    { observations: [{
      external_id: fixture.session.external_id,
      operation_id: 'native-transfer-2',
      operation: 'transfer_file',
      status: 'observed_succeeded',
      observer: 'native_client',
      source_adapter: 'rustdesk_log',
      observed_at: new Date().toISOString(),
      evidence_security: 'native_unscanned',
      direction: 'upload',
      evidence_refs: [{
        type: 'native_log',
        ref: 'evidence://rustdesk/native-transfer-2',
        sha256: `sha256:${'a'.repeat(64)}`
      }]
    }] }
  ) as { data: { events: Array<{ metadata: Record<string, unknown> }> } };
  assert.equal(nativeObservation.data.events[0].metadata.evidence_security, 'native_unscanned');

  await assert.rejects(
    () => fixture.route('POST', path, {
      native_event_id: 'native-file-unauthorized',
      source_origin: 'rustdesk_native_event',
      external_id: fixture.session.external_id,
      operation_id: 'file-transfer-1',
      authorization_scope: 'operation',
      authorization_id: 'rdop-wrong-operation',
      kind: 'file',
      filename: 'unauthorized.bin',
      upload_mode: 'single',
      expected_size_bytes: 1,
      observed_at: new Date().toISOString(),
      direction: 'upload',
      control_version: 3
    }, '', { 'idempotency-key': 'unauthorized-operation' }),
    /authorized file transfer start event is required/
  );

  await assert.rejects(
    () => fixture.route('POST', path, {
      native_event_id: 'native-unsafe-path',
      source_origin: 'rustdesk_native_event',
      external_id: fixture.session.external_id,
      operation_id: 'unsafe-path',
      authorization_scope: 'operation',
      authorization_id: 'rdop-unsafe-path',
      kind: 'file',
      filename: 'safe.bin',
      local_path: 'C:\\Users\\customer\\secret.bin',
      upload_mode: 'single',
      expected_size_bytes: 1,
      observed_at: new Date().toISOString(),
      direction: 'upload',
      control_version: 3
    }, '', { 'idempotency-key': 'unsafe-path' }),
    /unsupported RustDesk evidence field: local_path/
  );

  const wrongToken = fixture.edgeToken('999999999');
  assert.deepEqual(
    await fixture.route('GET', `${path}/${fileId}`, null, '', {}, wrongToken),
    { status: 404, data: { error: 'rustdesk device not found' } }
  );

  const ended = (await fixture.sessions.endSession({
    external_id: fixture.session.external_id,
    actor_identity: 'customer-ended'
  }))!;
  const finalized = await fixture.route('POST', path, {
    native_event_id: 'native-finalized-after-end',
    source_origin: 'rustdesk_native_event',
    external_id: fixture.session.external_id,
    operation_id: 'recording-1',
    authorization_scope: 'session',
    authorization_id: fixture.session.external_id,
    kind: 'screen_recording',
    filename: 'finalized-after-end.webm',
    upload_mode: 'single',
    expected_size_bytes: 1,
    observed_at: ended.ended_at
  }, '', { 'idempotency-key': 'finalized-after-end' }) as { status: number };
  assert.equal(finalized.status, 201);

  const flushedAfterEnd = await fixture.route('POST', path, {
    native_event_id: 'native-after-end',
    source_origin: 'rustdesk_native_event',
    external_id: fixture.session.external_id,
    operation_id: 'recording-1',
    authorization_scope: 'session',
    authorization_id: fixture.session.external_id,
    kind: 'screen_recording',
    filename: 'after-end.webm',
    upload_mode: 'single',
    expected_size_bytes: 1,
    observed_at: new Date(Date.parse(ended.ended_at!) + 1).toISOString()
  }, '', { 'idempotency-key': 'after-end' }) as { status: number };
  assert.equal(flushedAfterEnd.status, 201);

  assert.throws(
    () => assertRustDeskEvidenceSessionWindow(
      ended,
      ended.ended_at!,
      Date.parse(ended.ended_at!) + RUSTDESK_EVIDENCE_FINALIZATION_GRACE_MS + 1
    ),
    /RustDesk evidence finalization grace period has expired/
  );
});

test('device evidence context exposes only device-bound authorized native operations', async (t) => {
  const fixture = await evidenceFixture(t);
  const path = `/api/ivekit/rustdesk/devices/${fixture.device.id}/evidence-context`;

  const response = await fixture.route('GET', path, null) as {
    data: {
      schema_version: number;
      device_id: string;
      rustdesk_id: string;
      expires_at: string;
      bindings: Array<Record<string, unknown>>;
    };
  };

  assert.equal(response.data.schema_version, 1);
  assert.equal(response.data.device_id, fixture.device.id);
  assert.equal(response.data.rustdesk_id, fixture.device.rustdesk_id);
  assert.ok(Date.parse(response.data.expires_at) > Date.now());
  assert.deepEqual(
    response.data.bindings.map((binding) => ({
      kind: binding.kind,
      external_id: binding.external_id,
      controller_rustdesk_id: binding.controller_rustdesk_id,
      operation_id: binding.operation_id,
      authorization_scope: binding.authorization_scope,
      authorization_id: binding.authorization_id,
      direction: binding.direction,
      control_version: binding.control_version,
      file_name: binding.file_name
    })),
    [
      {
        kind: 'screen_recording',
        external_id: fixture.session.external_id,
        controller_rustdesk_id: '135792468',
        operation_id: 'recording-1',
        authorization_scope: 'session',
        authorization_id: fixture.session.external_id,
        direction: undefined,
        control_version: undefined,
        file_name: undefined
      },
      {
        kind: 'file',
        external_id: fixture.session.external_id,
        controller_rustdesk_id: '135792468',
        operation_id: 'file-transfer-1',
        authorization_scope: 'operation',
        authorization_id: 'rdop-file-transfer-1',
        direction: 'upload',
        control_version: 3,
        file_name: 'transfer.bin'
      }
    ]
  );

  const wrongToken = fixture.edgeToken('999999999');
  assert.deepEqual(
    await fixture.route('GET', path, null, '', {}, wrongToken),
    { status: 404, data: { error: 'rustdesk device not found' } }
  );
});

test('device evidence creation is fenced by the gateway placement owner', async (t) => {
  const owner = {
    interaction_id: 'remote-session-evidence-owner-1',
    reservation_id: 'reservation-evidence-owner-1',
    owner_epoch: '71'
  };
  const fixture = await evidenceFixture(t, owner);
  const path = `/api/ivekit/rustdesk/devices/${fixture.device.id}/evidence`;
  const base = {
    native_event_id: 'native-recording-owner-1',
    source_origin: 'rustdesk_native_event',
    external_id: fixture.session.external_id,
    operation_id: 'recording-1',
    authorization_scope: 'session',
    authorization_id: fixture.session.external_id,
    kind: 'screen_recording',
    filename: 'owner-recording.webm',
    upload_mode: 'single',
    expected_size_bytes: 1,
    observed_at: new Date().toISOString(),
    ...owner
  };

  await assert.rejects(
    () => fixture.route(
      'POST',
      path,
      { ...base, owner_epoch: '72' },
      '',
      { 'idempotency-key': 'owner-recording-stale' }
    ),
    /rustdesk_owner_binding_mismatch/
  );
  const accepted = await fixture.route(
    'POST',
    path,
    base,
    '',
    { 'idempotency-key': 'owner-recording-current' }
  ) as { status: number; data: { file: { file_id: string } } };
  assert.equal(accepted.status, 201);
  await fixture.sessions.updatePlacementOwner({
    tenant_id: fixture.tenantId,
    external_id: fixture.session.external_id,
    interaction_id: owner.interaction_id,
    reservation_id: 'reservation-evidence-owner-2',
    owner_epoch: '72'
  });
  await assert.rejects(
    () => fixture.route(
      'PUT',
      `${path}/${accepted.data.file.file_id}/content`,
      null,
      Buffer.from('x'),
      { 'x-content-sha256': sha256('x') }
    ),
    /rustdesk_owner_binding_mismatch/
  );
});

async function evidenceFixture(
  t: { after(fn: () => void): void },
  owner?: {
    interaction_id: string;
    reservation_id: string;
    owner_epoch: string;
  }
) {
  const previous = process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET;
  process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = EDGE_SECRET;
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-edge-evidence-'));
  t.after(() => {
    if (previous === undefined) delete process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET;
    else process.env.OPC_RUSTDESK_EDGE_TOKEN_SECRET = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const pg = new MemoryPg();
  const tenantId = 'tenant_edge_evidence';
  const collaborationSessionId = 'collaboration-edge-evidence-1';
  const devices = new RustDeskDeviceStore(pg);
  const device = await devices.registerDevice({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'led_device', id: 'LED-EVIDENCE-1' },
    rustdesk_id: '246813579',
    display_name: 'LED evidence target'
  });
  const sessions = new RustDeskGatewaySessionStore(pg);
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: { type: 'device', id: device.rustdesk_id },
    permissions: ['view_screen', 'record_screen', 'transfer_file'],
    actor_identity: 'agent-evidence-owner',
    launch_url: 'https://ivekit.example.com/rustdesk/evidence-session',
    metadata: {
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id,
      controller_rustdesk_id: '135792468',
      collaboration_session_id: collaborationSessionId,
      ...(owner
        ? {
            remote_session_id: owner.interaction_id,
            ivekit_reservation_id: owner.reservation_id,
            ivekit_owner_epoch: owner.owner_epoch
          }
        : {})
    }
  });
  await sessions.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.recording.started',
    actor_identity: 'agent-evidence-owner',
    metadata: {
      recording_id: 'recording-1',
      evidence_type: 'screen_recording'
    }
  });
  await sessions.appendAuditEvent({
    external_id: session.external_id,
    event_type: 'remote.rustdesk.file_transfer.started',
    actor_identity: 'agent-evidence-owner',
    metadata: {
      transfer_id: 'file-transfer-1',
      direction: 'upload',
      file_name: 'transfer.bin',
      operation_grant_id: 'rdop-file-transfer-1',
      control_version: 3
    }
  });
  const files = new SecureFileStore(pg);
  const secureFiles = new SecureFileService({
    files,
    derivatives: new SecureFileDerivativeStore(pg),
    storage: new LocalObjectStorage(root)
  });
  const token = edgeToken(tenantId, device.rustdesk_id);
  return {
    pg,
    tenantId,
    collaborationSessionId,
    device,
    session,
    sessions,
    files,
    secureFiles,
    edgeToken: (rustdeskId = device.rustdesk_id) => edgeToken(tenantId, rustdeskId),
    route: (
      method: string,
      path: string,
      body: unknown,
      rawBody: string | Buffer = '',
      extraHeaders: Record<string, string> = {},
      overrideToken = token
    ) => routeCollaborationApi(
      pg, method, path, new URL(`http://localhost${path}`), body, rawBody,
      { 'x-rustdesk-edge-token': overrideToken, ...extraHeaders },
      { secureFiles }
    )
  };
}

function edgeToken(tenantId: string, rustdeskId: string): string {
  return createRustDeskEdgeCommandToken({
    tenant_id: tenantId,
    rustdesk_id: rustdeskId,
    edge_instance_id: 'windows-edge-evidence-01',
    issued_at: '2026-07-15T00:00:00.000Z',
    expires_at: '2099-07-15T00:00:00.000Z'
  }, EDGE_SECRET);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
