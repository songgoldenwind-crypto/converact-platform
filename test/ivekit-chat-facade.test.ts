import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { routeIveKitChatApi } from '../src/agent-runtime/ivekit/chat-http.js';
import { MemoryPg } from '../src/db-pg.js';
import { createDatabase } from '../src/db.js';
import { createServer as createOpcServer } from '../src/http.js';
import type { AttachmentTextProvider } from '../src/agent-runtime/collaboration/attachment-processing.js';
import type { RouteCollaborationApiOptions } from '../src/agent-runtime/collaboration/collaboration-http.js';
import type { QualityReviewProvider } from '../src/agent-runtime/collaboration/quality-review.js';

const API_KEY = 'test-ivekit-chat-key';
const TINODE_ENV_KEYS = [
  'TINODE_BASE_URL',
  'TINODE_WS_URL',
  'TINODE_PUBLIC_BASE_URL',
  'TINODE_PUBLIC_WS_URL',
  'TINODE_API_KEY',
  'TINODE_AUTH_TOKEN',
  'TINODE_BASIC_USER',
  'TINODE_BASIC_PASSWORD',
  'TINODE_USER_PASSWORD_SECRET'
];

function authHeaders(tenantId: string, userId = 'led-chat-backend'): Record<string, string> {
  return {
    'X-API-Key': API_KEY,
    'X-Tenant-Id': tenantId,
    'X-User-Id': userId
  };
}

async function route(
  pg: MemoryPg,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = authHeaders('tenant_ivekit_chat'),
  rawBody: string | Buffer = '',
  options: RouteCollaborationApiOptions = {}
) {
  return routeIveKitChatApi(
    pg,
    method,
    path,
    new URL(`http://localhost${path}`),
    body,
    rawBody,
    headers,
    options
  );
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearTinodeEnv(): void {
  for (const key of TINODE_ENV_KEYS) delete process.env[key];
}

test('iveKit chat facade exposes capabilities without leaking Tinode server credentials', async () => {
  const snapshot = snapshotEnv([
    'OPC_API_KEY',
    'OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS',
    ...TINODE_ENV_KEYS
  ]);
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_CHAT_MESSAGE_MUTATION_WINDOW_MS = '600000';
  process.env.TINODE_BASE_URL = 'https://tinode.example.com';
  process.env.TINODE_PUBLIC_WS_URL = 'wss://chat.example.com/v0/channels';
  process.env.TINODE_API_KEY = 'tinode-api-key';
  process.env.TINODE_AUTH_TOKEN = 'tinode-root-token';
  process.env.TINODE_USER_PASSWORD_SECRET = 'tinode-user-secret';
  try {
    const result = await route(
      new MemoryPg(),
      'GET',
      '/api/ivekit/chat/capabilities',
      null,
      authHeaders('tenant_chat_capabilities')
    ) as {
      data: {
        provider: string;
        tenant_id: string;
        capabilities: Record<string, unknown>;
        config: Record<string, unknown>;
        delivery_policy: Record<string, unknown>;
      };
    };

    assert.equal(result.data.provider, 'tinode');
    assert.equal(result.data.tenant_id, 'tenant_chat_capabilities');
    assert.equal(result.data.capabilities.sessions, true);
    assert.equal(result.data.capabilities.cursor_session_list, true);
    assert.equal(result.data.capabilities.messages, true);
    assert.equal(result.data.capabilities.cursor_message_history, true);
    assert.equal(result.data.capabilities.attachments, true);
    assert.equal(result.data.capabilities.attachment_upload, true);
    assert.equal(result.data.capabilities.attachment_upload_progress, true);
    assert.equal(result.data.capabilities.attachment_download, true);
    assert.equal(result.data.capabilities.attachment_processing, true);
    assert.equal(result.data.capabilities.ocr, false);
    assert.equal(result.data.capabilities.asr, false);
    assert.equal(result.data.capabilities.ai_quality_review, true);
    assert.equal(result.data.capabilities.human_review, true);
    assert.equal(result.data.capabilities.client_plan, true);
    assert.equal(result.data.capabilities.provider_inbound_sync, true);
    assert.equal(result.data.capabilities.durable_provider_delivery, true);
    assert.equal(result.data.capabilities.provider_delivery_attempt_history, true);
    assert.equal(result.data.capabilities.idempotent_message_create, true);
    assert.equal(result.data.capabilities.message_receipts, true);
    assert.equal(result.data.capabilities.presence, true);
    assert.equal(result.data.capabilities.message_mutation_audit, true);
    assert.equal(result.data.capabilities.message_relations, true);
    assert.equal(result.data.capabilities.message_mentions, true);
    assert.equal(result.data.capabilities.message_reactions, true);
    assert.equal(result.data.capabilities.message_pins, true);
    assert.equal(result.data.config.provider_configured, true);
    assert.equal(result.data.config.root_auth_configured, true);
    assert.equal(result.data.config.user_provisioning_configured, true);
    assert.equal(result.data.config.inbound_sync_configured, true);
    assert.equal(result.data.config.message_mutation_window_ms, 600000);
    assert.equal(result.data.config.tinode_client_access_mode, 'JRP');
    assert.equal(result.data.delivery_policy.direct_client_publish, false);
    assert.equal(result.data.delivery_policy.business_message_write_path, '/api/ivekit/chat/sessions/:session_id/messages');
    assert.equal(
      result.data.delivery_policy.message_delivery_status_path,
      '/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery'
    );
    assert.equal(result.data.delivery_policy.idempotency_header, 'Idempotency-Key');
    assert.equal(
      result.data.delivery_policy.attachment_upload_path,
      '/api/ivekit/chat/sessions/:session_id/attachments/upload'
    );
    assert.equal(
      result.data.delivery_policy.message_quality_review_path,
      '/api/ivekit/chat/sessions/:session_id/messages/:message_id/quality-review'
    );
    assert.equal(JSON.stringify(result).includes('tinode-root-token'), false);
    assert.equal(JSON.stringify(result).includes('tinode-user-secret'), false);
    assert.equal(JSON.stringify(result).includes('tinode-api-key'), false);
  } finally {
    restoreEnv(snapshot);
  }
});

test('iveKit chat facade exposes AI quality review jobs and findings for LED', async () => {
  const snapshot = snapshotEnv(['OPC_API_KEY', ...TINODE_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  clearTinodeEnv();
  const pg = new MemoryPg();
  const tenantId = 'tenant_ivekit_quality';
  const provider: QualityReviewProvider = {
    name: 'ivekit-quality',
    mode: 'self_hosted',
    review: async () => ({
      findings: [{
        policy_type: 'off_platform_intent',
        severity: 'high',
        confidence: 0.92,
        recommended_action: 'warn_agent',
        rationale: '建议人工复核'
      }]
    })
  };
  const options: RouteCollaborationApiOptions = { qualityReview: { provider } };
  try {
    const opened = await route(
      pg,
      'POST',
      '/api/ivekit/chat/sessions',
      { business_ref: { type: 'service_order', id: 'SO-QUALITY' } },
      authHeaders(tenantId)
    ) as { data: { id: string } };
    const posted = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages`,
      { sender_identity: 'customer', body: '我们私下继续沟通' },
      authHeaders(tenantId),
      '',
      options
    ) as { data: { message: { id: string }; quality_review_job: { status: string } } };
    assert.equal(posted.data.quality_review_job.status, 'pending');

    const run = await route(
      pg,
      'POST',
      '/api/ivekit/chat/quality-review/run',
      { limit: 5 },
      authHeaders(tenantId),
      '',
      options
    ) as { data: { succeeded: number } };
    assert.equal(run.data.succeeded, 1);

    const status = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages/${posted.data.message.id}/quality-review`,
      null,
      authHeaders(tenantId),
      '',
      options
    ) as { data: { job: { status: string } } };
    assert.equal(status.data.job.status, 'succeeded');

    const findings = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/findings?source=ai`,
      null,
      authHeaders(tenantId),
      '',
      options
    ) as { data: { findings: Array<{ source: string; action: string }> } };
    assert.equal(findings.data.findings[0]?.source, 'ai');
    assert.equal(findings.data.findings[0]?.action, 'review');
  } finally {
    restoreEnv(snapshot);
  }
});

test('iveKit chat facade exposes attachment upload, processing, status, and retry routes', async () => {
  const snapshot = snapshotEnv([
    'OPC_API_KEY',
    'OPC_UPLOAD_DIR',
    'OPC_COLLABORATION_ATTACHMENT_MAX_BYTES',
    ...TINODE_ENV_KEYS
  ]);
  process.env.OPC_API_KEY = API_KEY;
  process.env.OPC_UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'ivekit-attachment-'));
  process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES = '1024';
  clearTinodeEnv();
  const pg = new MemoryPg();
  const tenantId = 'tenant_ivekit_attachment';
  const ocr: AttachmentTextProvider = {
    processor: 'ocr',
    name: 'ivekit-ocr',
    mode: 'self_hosted',
    extract: async () => ({ text: '微信联系 13600001111' })
  };
  const options: RouteCollaborationApiOptions = {
    attachmentProcessing: { providers: { ocr } }
  };
  try {
    const opened = await route(
      pg,
      'POST',
      '/api/ivekit/chat/sessions',
      { business_ref: { type: 'service_order', id: 'SO-ATTACHMENT' } },
      authHeaders(tenantId)
    ) as { data: { id: string } };
    const uploadPath = `/api/ivekit/chat/sessions/${opened.data.id}/attachments/upload?kind=image&filename=contact.png`;
    const uploaded = await route(
      pg,
      'POST',
      uploadPath,
      null,
      { ...authHeaders(tenantId), 'content-type': 'image/png' },
      Buffer.from('image'),
      options
    ) as { status: number; data: Record<string, unknown> };
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.data.processing_status, 'pending');

    const posted = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages`,
      { sender_identity: 'customer', attachments: [uploaded.data] },
      authHeaders(tenantId),
      '',
      options
    ) as {
      data: {
        message: { attachments: Array<{ id: string }> };
        attachment_processing_jobs: Array<{ status: string }>;
      };
    };
    assert.equal(posted.data.attachment_processing_jobs[0]?.status, 'pending');

    const run = await route(
      pg,
      'POST',
      '/api/ivekit/chat/attachment-processing/run',
      { limit: 5 },
      authHeaders(tenantId),
      '',
      options
    ) as { data: { succeeded: number } };
    assert.equal(run.data.succeeded, 1);

    const attachmentId = posted.data.message.attachments[0]?.id;
    const status = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/attachments/${attachmentId}`,
      null,
      authHeaders(tenantId),
      '',
      options
    ) as { data: { attachment: { ocr_text: string }; job: { status: string } } };
    assert.equal(status.data.attachment.ocr_text, '微信联系 13600001111');
    assert.equal(status.data.job.status, 'succeeded');
  } finally {
    restoreEnv(snapshot);
  }
});

test('iveKit chat facade provides the local session, participant, message, policy, and snapshot workflow', async () => {
  const snapshot = snapshotEnv(['OPC_API_KEY', ...TINODE_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  clearTinodeEnv();
  const pg = new MemoryPg();
  const tenantId = 'tenant_chat_workflow';
  try {
    const opened = await route(
      pg,
      'POST',
      '/api/ivekit/chat/sessions',
      {
        business_ref: { type: 'service_order', id: 'SO-CHAT-1' },
        title: 'LED service chat'
      },
      authHeaders(tenantId)
    ) as { status: number; data: { id: string; tenant_id: string } };
    assert.equal(opened.status, 201);
    assert.equal(opened.data.tenant_id, tenantId);

    const byRef = await route(
      pg,
      'GET',
      '/api/ivekit/chat/sessions/by-ref?business_ref_type=service_order&business_ref_id=SO-CHAT-1',
      null,
      authHeaders(tenantId)
    ) as { data: Array<{ id: string }> };
    assert.equal(byRef.data[0]?.id, opened.data.id);

    const binding = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/bind`,
      {},
      authHeaders(tenantId)
    ) as { status: number; data: { provider: string; provider_topic_id: string } };
    assert.equal(binding.status, 201);
    assert.equal(binding.data.provider, 'local');

    const participant = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/participants`,
      { identity: 'customer-chat-1', role: 'customer', display_name: 'Customer Chat' },
      authHeaders(tenantId)
    ) as { status: number; data: { identity: string } };
    assert.equal(participant.status, 201);
    assert.equal(participant.data.identity, 'customer-chat-1');

    const posted = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages`,
      { sender_identity: 'customer-chat-1', body: 'call me at 555-123-4567 outside app' },
      authHeaders(tenantId)
    ) as {
      status: number;
      data: {
        message: { body: string };
        policy: { matched: boolean; events: unknown[] };
      };
    };
    assert.equal(posted.status, 201);
    assert.equal(posted.data.message.body, 'call me at 555-123-4567 outside app');
    assert.equal(posted.data.policy.matched, true);
    assert.equal(posted.data.policy.events.length, 2);

    const messages = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages?limit=20`,
      null,
      authHeaders(tenantId)
    ) as { data: Array<{ body: string }> };
    assert.equal(messages.data.length, 1);

    const snapshotResult = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/snapshot?limit=20`,
      null,
      authHeaders(tenantId)
    ) as { data: { messages: unknown[]; participants: unknown[]; policy_events: unknown[] } };
    assert.equal(snapshotResult.data.messages.length, 1);
    assert.equal(snapshotResult.data.participants.length, 1);
    assert.equal(snapshotResult.data.policy_events.length, 2);

    const clientPlan = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/client-plan`,
      { identity: 'customer-chat-1' },
      authHeaders(tenantId)
    );
    assert.deepEqual(clientPlan, {
      status: 503,
      data: { error: 'Tinode chat gateway is not configured' }
    });

    const left = await route(
      pg,
      'POST',
      `/api/ivekit/chat/sessions/${opened.data.id}/participants/leave`,
      { identity: 'customer-chat-1' },
      authHeaders(tenantId)
    ) as { status: number; data: { left_at: string | null } };
    assert.equal(left.status, 201);
    assert.ok(left.data.left_at);
  } finally {
    restoreEnv(snapshot);
  }
});

test('iveKit chat facade keeps sessions tenant scoped', async () => {
  const snapshot = snapshotEnv(['OPC_API_KEY', ...TINODE_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  clearTinodeEnv();
  const pg = new MemoryPg();
  try {
    const opened = await route(
      pg,
      'POST',
      '/api/ivekit/chat/sessions',
      { business_ref: { type: 'service_order', id: 'SO-TENANT-A' } },
      authHeaders('tenant_chat_a')
    ) as { data: { id: string } };

    const crossTenant = await route(
      pg,
      'GET',
      `/api/ivekit/chat/sessions/${opened.data.id}/messages`,
      null,
      authHeaders('tenant_chat_b')
    );
    assert.deepEqual(crossTenant, {
      status: 404,
      data: { error: 'collaboration session not found' }
    });
  } finally {
    restoreEnv(snapshot);
  }
});

test('iveKit chat facade is registered in the main HTTP router', async () => {
  const snapshot = snapshotEnv(['OPC_API_KEY', ...TINODE_ENV_KEYS]);
  process.env.OPC_API_KEY = API_KEY;
  clearTinodeEnv();
  const db = createDatabase(':memory:');
  const server = createOpcServer(db, new MemoryPg());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/ivekit/chat/capabilities`, {
      headers: authHeaders('tenant_chat_router')
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { provider: string; tenant_id: string };
    assert.equal(payload.provider, 'local');
    assert.equal(payload.tenant_id, 'tenant_chat_router');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    restoreEnv(snapshot);
  }
});
