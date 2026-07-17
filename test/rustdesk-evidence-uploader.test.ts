import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  RustDeskEvidenceUploader,
  createRustDeskEvidenceUploaderConfigFromEnv
} from '../scripts/rustdesk-evidence-uploader.js';

const DEVICE_TOKEN = 'device-bound-evidence-uploader-token-material-123456';

test('evidence uploader sends selected content through secure-file and emits a bound observation', async () => {
  const fixture = uploaderFixture();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/evidence')) {
      return jsonResponse(201, { file: {
        file_id: 'sfile-recording-1', upload_mode: 'single', status: 'initiated',
        part_size_bytes: 0
      } });
    }
    if (init?.method === 'PUT' && url.endsWith('/content')) {
      return jsonResponse(200, { file: {
        file_id: 'sfile-recording-1', upload_mode: 'single', status: 'scanning',
        size_bytes: fixture.payload.length, sha256: fixture.sha256
      } });
    }
    return jsonResponse(500, { error: 'unexpected request' });
  };
  const uploader = await RustDeskEvidenceUploader.open(fixture.config, fetchImpl);
  const result = await uploader.pollOnce('rdesk-device-1');
  assert.deepEqual(result, { ingested: 1, uploaded: 1, deadLettered: 0 });
  assert.equal(requests.length, 2);
  assert.equal((requests[0].init?.headers as Record<string, string>)['x-rustdesk-edge-token'], DEVICE_TOKEN);
  assert.equal((requests[0].init?.headers as Record<string, string>)['idempotency-key'].startsWith('rdevid_'), true);
  const createBody = JSON.parse(String(requests[0].init?.body));
  assert.equal(createBody.external_id, 'rdgw-evidence-1');
  assert.equal(createBody.operation_id, 'recording-evidence-1');
  assert.equal(createBody.native_event_id, 'native-recording-evidence-1');
  assert.equal(createBody.authorization_scope, 'session');
  assert.equal(createBody.authorization_id, 'rdgw-evidence-1');
  assert.equal(createBody.source_origin, 'rustdesk_native_event');
  assert.equal(createBody.interaction_id, 'remote-session-evidence-1');
  assert.equal(createBody.reservation_id, 'reservation-evidence-1');
  assert.equal(createBody.owner_epoch, '111');
  assert.equal(createBody.upload_mode, 'single');
  assert.equal(createBody.expected_size_bytes, fixture.payload.length);
  assert.equal(Buffer.isBuffer(requests[1].init?.body), true);

  const observations = readdirSync(fixture.observationDirectory).filter((name) => name.endsWith('.json'));
  assert.equal(observations.length, 1);
  const observation = JSON.parse(readFileSync(join(fixture.observationDirectory, observations[0]), 'utf8'));
  assert.equal(observation.operation, 'record_screen');
  assert.equal(observation.provider_operation_id, 'native-recording-evidence-1');
  assert.equal(observation.evidence_security, 'ivekit_secure_file');
  assert.equal(observation.byte_count, fixture.payload.length);
  assert.equal(observation.evidence_refs[0].ref, 'ivekit-secure-file://sfile-recording-1');
  assert.equal(observation.interaction_id, 'remote-session-evidence-1');
  assert.equal(observation.reservation_id, 'reservation-evidence-1');
  assert.equal(observation.owner_epoch, '111');
  const rawState = readFileSync(join(fixture.spoolDirectory, 'records.json'), 'utf8');
  assert.doesNotMatch(rawState, /device-bound-evidence-uploader-token|\\Users\\|\/Users\//);
  assert.equal((await uploader.listRecords())[0].state, 'uploaded');
  await uploader.close();
});

test('evidence uploader resumes multipart after a transient part failure without changing identity', async () => {
  const fixture = uploaderFixture({
    payload: Buffer.from('abcdef'),
    singleUploadMaxBytes: 3,
    partSizeBytes: 3,
    manifest: {
      kind: 'file',
      operation_id: 'file-evidence-1',
      native_event_id: 'native-file-evidence-1',
      authorization_scope: 'operation',
      authorization_id: 'rdop-file-evidence-1',
      filename: 'diagnostic.bin',
      declared_mime: 'application/octet-stream',
      direction: 'upload',
      control_version: 7
    }
  });
  let partOneAttempts = 0;
  const createKeys: string[] = [];
  const uploadedParts = new Set<number>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/evidence')) {
      createKeys.push((init.headers as Record<string, string>)['idempotency-key']);
      return jsonResponse(201, { file: {
        file_id: 'sfile-file-1', upload_mode: 'multipart', status: 'uploading', part_size_bytes: 3
      } });
    }
    if (init?.method === 'GET' && url.endsWith('/parts')) {
      return jsonResponse(200, { parts: [...uploadedParts].map((part_number) => ({
        part_number, status: 'uploaded'
      })) });
    }
    const part = Number(url.match(/\/parts\/(\d+)$/)?.[1] || 0);
    if (init?.method === 'PUT' && part) {
      if (part === 1 && partOneAttempts++ === 0) return jsonResponse(503, { error: 'temporary' });
      uploadedParts.add(part);
      return jsonResponse(200, { part: { part_number: part, status: 'uploaded' } });
    }
    if (init?.method === 'POST' && url.endsWith('/complete')) {
      return jsonResponse(200, { file: {
        file_id: 'sfile-file-1', status: 'scanning', size_bytes: 6, sha256: fixture.sha256
      } });
    }
    return jsonResponse(500, { error: 'unexpected request' });
  };
  let uploader = await RustDeskEvidenceUploader.open(fixture.config, fetchImpl);

  assert.deepEqual(await uploader.pollOnce('rdesk-device-1'), {
    ingested: 1, uploaded: 0, deadLettered: 0
  });
  await uploader.close();
  uploader = await RustDeskEvidenceUploader.open(fixture.config, fetchImpl);
  assert.deepEqual(await uploader.pollOnce('rdesk-device-1'), {
    ingested: 0, uploaded: 1, deadLettered: 0
  });
  assert.equal(createKeys.length, 1);
  assert.deepEqual([...uploadedParts], [1, 2]);
  const observationName = readdirSync(fixture.observationDirectory).find((name) => name.endsWith('.json'))!;
  const observation = JSON.parse(readFileSync(join(fixture.observationDirectory, observationName), 'utf8'));
  assert.equal(observation.operation, 'transfer_file');
  assert.equal(observation.provider_operation_id, 'native-file-evidence-1');
  assert.equal(observation.direction, 'upload');
  assert.equal(observation.control_version, 7);
  await uploader.close();
});

test('evidence uploader quarantines unsafe manifests without retaining local paths or tokens', async () => {
  const fixture = uploaderFixture();
  unlinkSync(join(fixture.inputDirectory, 'evidence-1.json'));
  unlinkSync(join(fixture.inputDirectory, 'capture.payload'));
  writeFileSync(join(fixture.inputDirectory, 'unsafe.json'), JSON.stringify({
    schema_version: 1,
    native_event_id: 'native-unsafe-evidence',
    source_origin: 'rustdesk_native_event',
    external_id: 'rdgw-evidence-1',
    operation_id: 'unsafe-evidence',
    authorization_scope: 'operation',
    authorization_id: 'rdop-unsafe-evidence',
    kind: 'file',
    payload_filename: 'capture.payload',
    filename: 'capture.bin',
    local_path: 'C:\\Users\\customer\\secret.bin'
  }));
  const uploader = await RustDeskEvidenceUploader.open(fixture.config, async () => {
    throw new Error('network must not be called');
  });
  const result = await uploader.pollOnce('rdesk-device-1');
  assert.equal(result.ingested, 0);
  const quarantined = readdirSync(join(fixture.inputDirectory, 'quarantine'));
  assert.equal(quarantined.length, 1);
  const raw = readFileSync(join(fixture.inputDirectory, 'quarantine', quarantined[0]), 'utf8');
  assert.match(raw, /invalid_schema/);
  assert.doesNotMatch(raw, /customer|device-bound-evidence-uploader-token/);
  await uploader.close();
});

test('evidence uploader compacts legacy terminal history before restart limits are exceeded', async () => {
  const fixture = uploaderFixture({ maxTerminalRecords: 25 });
  mkdirSync(fixture.spoolDirectory, { recursive: true });
  const timestamp = '2026-07-10T12:00:00.000Z';
  const records = Array.from({ length: 10_001 }, (_, index) => ({
    id: `rdevid_legacy_${index}`,
    state: index % 2 === 0 ? 'uploaded' : 'dead_letter',
    payload_sha256: createHash('sha256').update(String(index)).digest('hex'),
    size_bytes: 1,
    upload_mode: 'single',
    attempt_count: 1,
    created_at: timestamp,
    updated_at: new Date(Date.parse(timestamp) + index).toISOString(),
    ...(index % 2 === 0
      ? { uploaded_at: new Date(Date.parse(timestamp) + index).toISOString() }
      : { dead_lettered_at: new Date(Date.parse(timestamp) + index).toISOString() })
  }));
  writeFileSync(
    join(fixture.spoolDirectory, 'records.json'),
    `${JSON.stringify({ version: 1, records })}\n`,
    { mode: 0o600 }
  );

  let uploader = await RustDeskEvidenceUploader.open(fixture.config, async () => {
    throw new Error('network must not be called');
  });
  assert.equal((await uploader.listRecords()).length, 25);
  await uploader.close();

  uploader = await RustDeskEvidenceUploader.open(fixture.config, async () => {
    throw new Error('network must not be called');
  });
  assert.equal((await uploader.listRecords()).length, 25);
  await uploader.close();
});

test('evidence uploader removes expired dead-letter payloads before compacting their state', async () => {
  let nowMs = Date.parse('2026-07-16T08:00:00.000Z');
  const fixture = uploaderFixture({
    now: () => new Date(nowMs),
    deadLetterRetentionMs: 1_000
  });
  const payloadPath = join(fixture.inputDirectory, 'capture.payload');
  const uploader = await RustDeskEvidenceUploader.open(
    fixture.config,
    async () => jsonResponse(409, { error: 'authorization ended' })
  );

  assert.deepEqual(await uploader.pollOnce('rdesk-device-1'), {
    ingested: 1,
    uploaded: 0,
    deadLettered: 1
  });
  assert.equal(existsSync(payloadPath), true);
  assert.equal((await uploader.listRecords())[0]?.state, 'dead_letter');

  nowMs += 1_001;
  await uploader.pollOnce('rdesk-device-1');
  assert.equal(existsSync(payloadPath), false);
  assert.deepEqual(await uploader.listRecords(), []);
  await uploader.close();
});

test('evidence uploader tracks and retries local payload cleanup after remote upload succeeds', async () => {
  const fixture = uploaderFixture();
  const payloadPath = join(fixture.inputDirectory, 'capture.payload');
  let requestCount = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    requestCount += 1;
    const url = String(input);
    if (init?.method === 'POST' && url.endsWith('/evidence')) {
      return jsonResponse(201, { file: {
        file_id: 'sfile-cleanup-retry-1', upload_mode: 'single', status: 'initiated',
        part_size_bytes: 0
      } });
    }
    if (init?.method === 'PUT' && url.endsWith('/content')) {
      return jsonResponse(200, { file: {
        file_id: 'sfile-cleanup-retry-1', upload_mode: 'single', status: 'scanning',
        size_bytes: fixture.payload.length, sha256: fixture.sha256
      } });
    }
    return jsonResponse(500, { error: 'unexpected request' });
  };
  let cleanupAttempts = 0;
  const dependencies = {
    async removePayload(path: string) {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) {
        throw Object.assign(new Error('payload is still locked'), { code: 'EBUSY' });
      }
      unlinkSync(path);
    }
  };

  let uploader = await RustDeskEvidenceUploader.open(fixture.config, fetchImpl, dependencies);
  assert.deepEqual(await uploader.pollOnce('rdesk-device-1'), {
    ingested: 1,
    uploaded: 0,
    deadLettered: 0
  });
  assert.equal(existsSync(payloadPath), true);
  assert.equal((await uploader.listRecords())[0]?.state, 'uploaded');
  assert.ok((await uploader.listRecords())[0]?.manifest);
  await uploader.close();

  uploader = await RustDeskEvidenceUploader.open(fixture.config, fetchImpl, dependencies);
  assert.deepEqual(await uploader.pollOnce('rdesk-device-1'), {
    ingested: 0,
    uploaded: 1,
    deadLettered: 0
  });
  assert.equal(requestCount, 2);
  assert.equal(existsSync(payloadPath), false);
  assert.equal((await uploader.listRecords())[0]?.manifest, undefined);
  await uploader.close();
});

function uploaderFixture(overrides: {
  payload?: Buffer;
  singleUploadMaxBytes?: number;
  partSizeBytes?: number;
  maxTerminalRecords?: number;
  deadLetterRetentionMs?: number;
  now?: () => Date;
  manifest?: Record<string, unknown>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rustdesk-evidence-uploader-'));
  const inputDirectory = join(root, 'evidence-inbox');
  const spoolDirectory = join(root, 'evidence-spool');
  const observationDirectory = join(root, 'observation-inbox');
  const tokenFile = join(root, 'edge-token');
  const payload = overrides.payload || Buffer.from('selected recording bytes');
  writeFileSync(tokenFile, `${DEVICE_TOKEN}\n`, { mode: 0o600 });
  const config = {
    ...createRustDeskEvidenceUploaderConfigFromEnv({
      OPC_RUSTDESK_EDGE_BASE_URL: 'https://ivekit.example.com',
      OPC_RUSTDESK_EDGE_DEVICE_TOKEN_FILE: tokenFile,
      OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR: inputDirectory,
      OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR: spoolDirectory,
      OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR: observationDirectory,
      OPC_RUSTDESK_EDGE_EVIDENCE_SINGLE_UPLOAD_MAX_BYTES: String(overrides.singleUploadMaxBytes || 1024),
      OPC_RUSTDESK_EDGE_EVIDENCE_PART_SIZE_BYTES: String(overrides.partSizeBytes || 3)
    }),
    retryDelayMs: 0,
    ...(overrides.deadLetterRetentionMs === undefined
      ? {}
      : { deadLetterRetentionMs: overrides.deadLetterRetentionMs }),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.maxTerminalRecords === undefined
      ? {}
      : { maxTerminalRecords: overrides.maxTerminalRecords })
  };
  writeFileSync(join(root, 'capture.payload'), payload);
  writeFileSync(join(root, 'manifest.tmp'), JSON.stringify({
    schema_version: 1,
    native_event_id: 'native-recording-evidence-1',
    source_origin: 'rustdesk_native_event',
    external_id: 'rdgw-evidence-1',
    operation_id: 'recording-evidence-1',
    authorization_scope: 'session',
    authorization_id: 'rdgw-evidence-1',
    interaction_id: 'remote-session-evidence-1',
    reservation_id: 'reservation-evidence-1',
    owner_epoch: '111',
    kind: 'screen_recording',
    payload_filename: 'capture.payload',
    filename: 'remote-session.webm',
    declared_mime: 'video/webm',
    observed_at: new Date().toISOString(),
    ...overrides.manifest
  }));
  // Input payloads and manifests are delivered by atomic rename into the managed inbox.
  mkdirSync(inputDirectory, { recursive: true });
  renameSync(join(root, 'capture.payload'), join(inputDirectory, 'capture.payload'));
  renameSync(join(root, 'manifest.tmp'), join(inputDirectory, 'evidence-1.json'));
  const sha256 = createHash('sha256').update(payload).digest('hex');
  return { config, inputDirectory, spoolDirectory, observationDirectory, payload, sha256 };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
