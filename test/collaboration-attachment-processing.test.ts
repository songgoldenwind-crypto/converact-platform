import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MemoryPg } from '../src/db-pg.js';
import {
  AttachmentProcessingService,
  type AttachmentTextProvider
} from '../src/agent-runtime/collaboration/attachment-processing.js';
import { CollaborationStore } from '../src/agent-runtime/collaboration/collaboration-store.js';
import { createHttpOcrProvider } from '../src/agent-runtime/collaboration/ocr-provider.js';
import { routeCollaborationApi } from '../src/agent-runtime/collaboration/collaboration-http.js';
import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import {
  AttachmentProcessingWorker,
  attachmentProcessingWorkerConfig
} from '../src/agent-runtime/collaboration/attachment-processing-worker.js';
import { inspectAttachmentProcessingEnv } from '../scripts/attachment-processing-preflight.js';

const API_KEY = 'attachment-processing-api-key';

test('image OCR processing persists extracted text and rescans policy', async () => {
  const pg = new MemoryPg();
  const { message, attachment } = await createAttachmentMessage(pg, {
    kind: 'image',
    contentType: 'image/png',
    storageUrl: 's3://opc-chat/contact.png'
  });
  const providerInputs: Buffer[] = [];
  const ocr: AttachmentTextProvider = {
    processor: 'ocr',
    name: 'self-hosted-ocr',
    mode: 'self_hosted',
    extract: async (input) => {
      providerInputs.push(input.content);
      return {
        text: '请加微信 led_private_001，手机号 138 0013 8000',
        confidence: 0.97,
        language: 'zh-CN',
        provider_request_id: 'ocr-request-1'
      };
    }
  };
  const service = new AttachmentProcessingService({
    pg,
    providers: { ocr },
    resolveObject: async () => ({
      status: 'readable',
      source: 's3',
      content: Buffer.from('fake-png')
    })
  });

  const jobs = await service.enqueueMessage(message);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.processor, 'ocr');
  assert.equal(jobs[0]?.status, 'pending');

  const summary = await service.runDue({ tenant_id: message.tenant_id, limit: 10 });
  assert.deepEqual(summary, { candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0 });
  assert.equal(providerInputs[0]?.toString(), 'fake-png');

  const processed = await service.getAttachment({
    tenant_id: message.tenant_id,
    attachment_id: attachment.id
  });
  assert.equal(processed?.processing_status, 'ready');
  assert.equal(processed?.ocr_text, '请加微信 led_private_001，手机号 138 0013 8000');
  assert.equal(processed?.extracted_text, processed?.ocr_text);
  assert.equal(processed?.metadata.provider_request_id, 'ocr-request-1');

  const policy = await new CollaborationStore(pg).listPolicyEvents({
    tenant_id: message.tenant_id,
    session_id: message.session_id,
    message_id: message.id
  });
  assert.equal(policy.some((event) => event.policy_type === 'phone_number'), true);
  assert.equal(policy.some((event) => event.policy_type === 'wechat'), true);
});

test('audio ASR jobs retry transient failures and become terminal at max attempts', async () => {
  const pg = new MemoryPg();
  const { message, attachment } = await createAttachmentMessage(pg, {
    kind: 'audio',
    contentType: 'audio/ogg',
    storageUrl: 's3://opc-chat/contact.ogg'
  });
  let now = new Date('2026-07-10T00:00:00.000Z');
  const asr: AttachmentTextProvider = {
    processor: 'asr',
    name: 'third-party-asr',
    mode: 'third_party',
    extract: async () => {
      throw Object.assign(new Error('provider unavailable'), {
        code: 'provider_unavailable',
        retryable: true
      });
    }
  };
  const service = new AttachmentProcessingService({
    pg,
    providers: { asr },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('audio') }),
    now: () => now,
    maxAttempts: 2,
    retryDelaysMs: [1_000]
  });
  await service.enqueueMessage(message);

  const first = await service.runDue({ tenant_id: message.tenant_id });
  assert.equal(first.retry_wait, 1);
  assert.equal((await service.getJobForAttachment({
    tenant_id: message.tenant_id,
    attachment_id: attachment.id
  }))?.status, 'retry_wait');

  now = new Date('2026-07-10T00:00:02.000Z');
  const second = await service.runDue({ tenant_id: message.tenant_id });
  assert.equal(second.failed, 1);
  assert.equal((await service.getAttachment({
    tenant_id: message.tenant_id,
    attachment_id: attachment.id
  }))?.processing_status, 'failed');
});

test('unconfigured processor leaves durable jobs pending for later provider configuration', async () => {
  const pg = new MemoryPg();
  const { message, attachment } = await createAttachmentMessage(pg, {
    kind: 'image',
    contentType: 'image/jpeg',
    storageUrl: 's3://opc-chat/later.jpg'
  });
  const service = new AttachmentProcessingService({ pg, providers: {} });
  await service.enqueueMessage(message);

  const summary = await service.runDue({ tenant_id: message.tenant_id });
  assert.deepEqual(summary, { candidates: 1, claimed: 0, succeeded: 0, retry_wait: 0, failed: 0 });
  assert.equal((await service.getJobForAttachment({
    tenant_id: message.tenant_id,
    attachment_id: attachment.id
  }))?.status, 'pending');
});

test('post-processing notification failures do not corrupt a committed extraction', async () => {
  const pg = new MemoryPg();
  const { message, attachment } = await createAttachmentMessage(pg, {
    kind: 'image',
    contentType: 'image/png',
    storageUrl: 's3://opc-chat/notification.png'
  });
  const service = new AttachmentProcessingService({
    pg,
    providers: {
      ocr: {
        processor: 'ocr',
        name: 'notification-test-ocr',
        mode: 'self_hosted',
        extract: async () => ({ text: '联系电话 13800138000' })
      }
    },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('image') }),
    onProcessed: async () => {
      throw new Error('websocket unavailable');
    }
  });
  await service.enqueueMessage(message);

  const summary = await service.runDue({ tenant_id: message.tenant_id });
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 0);
  assert.equal((await service.getAttachment({
    tenant_id: message.tenant_id,
    attachment_id: attachment.id
  }))?.processing_status, 'ready');
  assert.equal((await service.getJobForAttachment({
    tenant_id: message.tenant_id,
    attachment_id: attachment.id
  }))?.status, 'succeeded');
});

test('unconfigured ASR jobs cannot starve configured OCR work at the batch limit', async () => {
  const pg = new MemoryPg();
  const tenantId = 'tenant_processor_fairness';
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: 'order-fairness' }
  });
  const audio = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer',
    message_type: 'file',
    body: '',
    attachments: [{
      kind: 'audio',
      storage_url: 's3://opc-chat/oldest.ogg',
      processing_status: 'pending'
    }]
  });
  const image = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer',
    message_type: 'image',
    body: '',
    attachments: [{
      kind: 'image',
      storage_url: 's3://opc-chat/newer.png',
      processing_status: 'pending'
    }]
  });
  const service = new AttachmentProcessingService({
    pg,
    providers: {
      ocr: {
        processor: 'ocr',
        name: 'configured-ocr',
        mode: 'self_hosted',
        extract: async () => ({ text: '联系电话 13700001111' })
      }
    },
    resolveObject: async () => ({ status: 'readable', content: Buffer.from('object') })
  });
  await service.enqueueMessage(audio);
  await service.enqueueMessage(image);

  const summary = await service.runDue({ tenant_id: tenantId, limit: 1 });
  assert.equal(summary.claimed, 1);
  assert.equal(summary.succeeded, 1);
  assert.equal((await service.getAttachment({
    tenant_id: tenantId,
    attachment_id: image.attachments[0]!.id
  }))?.processing_status, 'ready');
  assert.equal((await service.getJobForAttachment({
    tenant_id: tenantId,
    attachment_id: audio.attachments[0]!.id
  }))?.status, 'pending');
});

test('generic HTTP OCR adapter sends multipart bytes and normalizes provider output', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = createHttpOcrProvider({
    mode: 'third_party',
    baseUrl: 'https://ocr.example.test/',
    token: 'ocr-secret',
    timeoutMs: 5_000,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        text: '二维码内容 13900001111',
        confidence: 0.88,
        language: 'zh',
        request_id: 'provider-ocr-1'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.extract({
    attachment_id: 'attachment-1',
    tenant_id: 'tenant-1',
    session_id: 'session-1',
    message_id: 'message-1',
    filename: 'qr.png',
    content_type: 'image/png',
    storage_url: 's3://bucket/qr.png',
    content: Buffer.from('png')
  });

  assert.equal(requests[0]?.url, 'https://ocr.example.test/v1/ocr');
  assert.equal(new Headers(requests[0]?.init?.headers).get('authorization'), 'Bearer ocr-secret');
  assert.equal(requests[0]?.init?.body instanceof FormData, true);
  assert.equal(result.text, '二维码内容 13900001111');
  assert.equal(result.provider_request_id, 'provider-ocr-1');
});

test('collaboration attachment upload enforces size and returns a pending processable descriptor', async () => {
  const previous = snapshotEnv(['OPC_API_KEY', 'OPC_UPLOAD_DIR', 'OPC_COLLABORATION_ATTACHMENT_MAX_BYTES']);
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'opc-attachment-upload-'));
  process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES = '16';
  try {
    const pg = new MemoryPg();
    const store = new CollaborationStore(pg);
    const session = await store.openSession({
      tenant_id: 'tenant-attachment-upload',
      business_ref: {
        tenant_id: 'tenant-attachment-upload',
        type: 'service_order',
        id: 'order-upload'
      }
    });
    const path = `/api/collaboration/sessions/${session.id}/attachments/upload?kind=image&filename=contact.png`;
    const result = await routeCollaborationApi(
      pg,
      'POST',
      path,
      new URL(`http://localhost${path}`),
      null,
      Buffer.from('image-bytes'),
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-upload',
        'content-type': 'image/png'
      }
    ) as { status: number; data: Record<string, unknown> };

    assert.equal(result.status, 201);
    assert.equal(result.data.kind, 'image');
    assert.equal(result.data.processing_status, 'pending');
    assert.equal(result.data.content_type, 'image/png');
    assert.equal(result.data.size_bytes, 11);
    assert.match(String(result.data.checksum), /^sha256:/);
    assert.match(String(result.data.storage_url), /^\/api\/ivekit\/chat\/objects\//);
    assert.doesNotMatch(String(result.data.storage_url), /call-center|MinIO|S3_/i);

    const oversized = await routeCollaborationApi(
      pg,
      'POST',
      path,
      new URL(`http://localhost${path}`),
      null,
      Buffer.alloc(17),
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-upload',
        'content-type': 'image/png'
      }
    ) as { status: number; data: Record<string, unknown> };
    assert.equal(oversized.status, 413);

    const ocr: AttachmentTextProvider = {
      processor: 'ocr',
      name: 'http-test-ocr',
      mode: 'self_hosted',
      extract: async () => ({ text: '图片联系电话 13900001111' })
    };
    const messagePath = `/api/collaboration/sessions/${session.id}/messages`;
    const messageResult = await routeCollaborationApi(
      pg,
      'POST',
      messagePath,
      new URL(`http://localhost${messagePath}`),
      {
        sender_identity: 'customer-upload',
        attachments: [result.data]
      },
      '',
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-upload'
      },
      { attachmentProcessing: { providers: { ocr } } }
    ) as {
      status: number;
      data: {
        message: { attachments: Array<{ id: string }> };
        attachment_processing_jobs: Array<{ status: string; processor: string }>;
      };
    };
    assert.equal(messageResult.status, 201);
    assert.equal(messageResult.data.attachment_processing_jobs[0]?.status, 'pending');
    assert.equal(messageResult.data.attachment_processing_jobs[0]?.processor, 'ocr');

    const runPath = '/api/collaboration/attachment-processing/run';
    const runResult = await routeCollaborationApi(
      pg,
      'POST',
      runPath,
      new URL(`http://localhost${runPath}`),
      { limit: 5 },
      '',
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-upload'
      },
      { attachmentProcessing: { providers: { ocr } } }
    ) as { data: { succeeded: number } };
    assert.equal(runResult.data.succeeded, 1);

    const attachmentId = messageResult.data.message.attachments[0]?.id;
    assert.ok(attachmentId);
    const statusPath = `/api/collaboration/sessions/${session.id}/attachments/${attachmentId}`;
    const statusResult = await routeCollaborationApi(
      pg,
      'GET',
      statusPath,
      new URL(`http://localhost${statusPath}`),
      null,
      '',
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-upload'
      },
      { attachmentProcessing: { providers: { ocr } } }
    ) as {
      data: {
        attachment: { processing_status: string; ocr_text: string };
        job: { status: string };
      };
    };
    assert.equal(statusResult.data.attachment.processing_status, 'ready');
    assert.equal(statusResult.data.attachment.ocr_text, '图片联系电话 13900001111');
    assert.equal(statusResult.data.job.status, 'succeeded');

    const downloadPath = `/api/ivekit/chat/sessions/${session.id}/attachments/${attachmentId}/download`;
    const downloaded = await routeIveKitChatApi(
      pg,
      'GET',
      downloadPath,
      new URL(`http://localhost${downloadPath}`),
      null,
      '',
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-upload'
      }
    ) as { contentType: string; data: Buffer; headers: Record<string, string> };
    assert.equal(downloaded.contentType, 'image/png');
    assert.deepEqual(downloaded.data, Buffer.from('image-bytes'));
    assert.match(downloaded.headers['content-disposition'], /contact\.png/);

    const foreignDownload = await routeIveKitChatApi(
      pg,
      'GET',
      downloadPath,
      new URL(`http://localhost${downloadPath}`),
      null,
      '',
      {
        'x-api-key': API_KEY,
        'x-tenant-id': 'tenant-attachment-foreign'
      }
    ) as { status: number };
    assert.equal(foreignDownload.status, 404);
  } finally {
    restoreEnv(previous);
  }
});

test('attachment processing migration defines durable jobs, extraction fields, and tenant RLS', () => {
  const migration = readFileSync('src/migrations/027_collaboration_attachment_processing.sql', 'utf8');
  assert.match(migration, /collaboration_attachment_processing_jobs/);
  assert.match(migration, /ocr_text/);
  assert.match(migration, /asr_text/);
  assert.match(migration, /extracted_text/);
  assert.match(migration, /lease_until/);
  assert.match(migration, /retry_wait/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
});

test('attachment worker enables only with a configured provider and validates runtime bounds', () => {
  assert.equal(attachmentProcessingWorkerConfig({}).enabled, false);
  const config = attachmentProcessingWorkerConfig({
    OPC_OCR_BASE_URL: 'http://ocr.internal:8080',
    OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED: '1',
    OPC_ATTACHMENT_PROCESSING_INTERVAL_MS: '2500',
    OPC_ATTACHMENT_PROCESSING_BATCH_SIZE: '12',
    OPC_ATTACHMENT_PROCESSING_MAX_ATTEMPTS: '4',
    OPC_ATTACHMENT_PROCESSING_CLAIM_LEASE_MS: '45000',
    OPC_ATTACHMENT_PROCESSING_RETRY_DELAYS_MS: '1000,5000'
  });
  assert.deepEqual(config, {
    enabled: true,
    intervalMs: 2500,
    batchSize: 12,
    maxAttempts: 4,
    claimLeaseMs: 45000,
    retryDelaysMs: [1000, 5000]
  });
  assert.throws(
    () => attachmentProcessingWorkerConfig({
      OPC_OCR_BASE_URL: 'http://ocr.internal',
      OPC_ATTACHMENT_PROCESSING_BATCH_SIZE: '0'
    }),
    /BATCH_SIZE/
  );
});

test('attachment worker coalesces concurrent runs and stops cleanly', async () => {
  let resolveRun!: (value: { candidates: number; claimed: number; succeeded: number; retry_wait: number; failed: number }) => void;
  let calls = 0;
  const worker = new AttachmentProcessingWorker({
    config: {
      enabled: true,
      intervalMs: 60_000,
      batchSize: 10,
      maxAttempts: 3,
      claimLeaseMs: 60_000,
      retryDelaysMs: [1_000]
    },
    runBatch: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    }
  });
  const first = worker.runOnce();
  const second = worker.runOnce();
  assert.equal(first, second);
  resolveRun({ candidates: 1, claimed: 1, succeeded: 1, retry_wait: 0, failed: 0 });
  await first;
  assert.equal(calls, 1);
  await worker.stop();
});

test('production server starts and stops the attachment processing worker', () => {
  const server = readFileSync('src/server.ts', 'utf8');
  const application = readFileSync('src/agent-runtime/ivekit/application.ts', 'utf8');
  assert.match(server, /startIveKitApplication/);
  assert.match(server, /await iveKitApplication\.stop\(\)/);
  assert.match(application, /startAttachmentProcessingWorker/);
  assert.match(application, /collaboration\.attachment\.processed/);
});

test('main HTTP server treats collaboration attachments as size-bounded binary uploads', () => {
  const http = readFileSync('src/http.ts', 'utf8');
  assert.match(http, /sessions\\\/\[\^\/\]\+\\\/attachments\\\/upload/);
  assert.match(http, /readBuffer\(req, binaryUploadMaxBytes/);
  assert.match(http, /attachment upload exceeds configured size limit/);
});

test('attachment processing preflight validates provider, Postgres, storage, and masks tokens', () => {
  const missing = inspectAttachmentProcessingEnv({});
  assert.equal(missing.ready, false);
  assert.equal(missing.issues.some((issue) => issue.includes('OCR or ASR provider')), true);
  assert.equal(missing.issues.some((issue) => issue.includes('DATABASE_URL')), true);

  const configured = inspectAttachmentProcessingEnv({
    DATABASE_URL: 'postgres://opc:secret@postgres:5432/opc',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_BUCKET: 'recordings',
    MINIO_ACCESS_KEY: 'minio-user',
    MINIO_SECRET_KEY: 'minio-secret',
    OPC_OCR_PROVIDER_MODE: 'third_party',
    OPC_OCR_BASE_URL: 'https://ocr.example.test',
    OPC_OCR_TOKEN: 'ocr-super-secret',
    OPC_OCR_TIMEOUT_MS: '10000',
    OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED: '1'
  });
  assert.equal(configured.ready, true);
  const serialized = JSON.stringify(configured);
  assert.doesNotMatch(serialized, /ocr-super-secret|minio-secret|postgres:\/\/opc:secret/);
  assert.match(serialized, /\[configured\]/);
});

test('attachment processing deployment surfaces expose every provider and worker setting', () => {
  const sources = [
    readFileSync('.env.example', 'utf8'),
    readFileSync('infra/env.example', 'utf8'),
    readFileSync('docker-compose.callcenter.yml', 'utf8'),
    readFileSync('infra/docker-compose.production.yml', 'utf8'),
    readFileSync('infra/k8s/values.yaml', 'utf8'),
    readFileSync('infra/k8s/templates/opc-deployment.yaml', 'utf8')
  ];
  for (const source of sources) {
    assert.match(source, /OPC_OCR_BASE_URL|ocrBaseUrl/);
    assert.match(source, /OPC_ASR_BASE_URL|asrBaseUrl/);
    assert.match(source, /OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED|worker:\s*\n\s*enabled/);
    assert.match(source, /OPC_COLLABORATION_ATTACHMENT_MAX_BYTES|attachmentMaxBytes/);
  }
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts['attachment:deployment-preflight'], 'tsx scripts/attachment-processing-preflight.ts');
});

async function createAttachmentMessage(
  pg: MemoryPg,
  input: { kind: 'image' | 'audio'; contentType: string; storageUrl: string }
) {
  const tenantId = `tenant_${input.kind}_processing`;
  const store = new CollaborationStore(pg);
  const session = await store.openSession({
    tenant_id: tenantId,
    business_ref: { tenant_id: tenantId, type: 'service_order', id: `order-${input.kind}` }
  });
  const message = await store.postMessage({
    tenant_id: tenantId,
    session_id: session.id,
    sender_identity: 'customer-1',
    message_type: input.kind === 'image' ? 'image' : 'file',
    body: '',
    attachments: [{
      kind: input.kind,
      storage_url: input.storageUrl,
      filename: input.kind === 'image' ? 'contact.png' : 'contact.ogg',
      content_type: input.contentType,
      size_bytes: 5,
      checksum: 'sha256:test',
      processing_status: 'pending'
    }]
  });
  const attachment = message.attachments[0];
  assert.ok(attachment);
  return { message, attachment };
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
