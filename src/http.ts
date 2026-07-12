import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as dbRun } from './db.js';
import type { PgQueryable } from './db-pg.js';
import { routeAuthApi } from './auth-http.js';
import {
  auditCallCenterAction,
  getComplianceSettings,
  routeComplianceApi
} from './agent-runtime/call-center/compliance/index.js';
import { createHarness } from './agent-runtime/index.js';
import { routeCallCenterApi } from './call-center-http.js';
import { routeIvrApi } from './agent-runtime/ivr/ivr-http.js';
import { routeAudioLibraryApi } from './agent-runtime/ivr/audio-library-http.js';
import { routeIvrSettingsApi } from './agent-runtime/ivr/ivr-settings-http.js';
import { executeTool, toolContext, requiredQuery, queryInput } from './http-api/_helpers.js';
import { routePlatformApi } from './http-api/platform-http.js';
import { routeIntegrationsApi } from './http-api/integrations-http.js';
import { routeWikiApi } from './http-api/wiki-http.js';
import { routeGeoApi } from './http-api/geo-http.js';
import { routeMemoryApi } from './http-api/memory-http.js';
import { routeVoiceApi } from './http-api/voice-http.js';
import { routeMediaApi } from './agent-runtime/livekit/media-http.js';
import { routeCollaborationApi } from './agent-runtime/collaboration/collaboration-http.js';
import { routeIveKitChatApi } from './agent-runtime/ivekit/chat-http.js';
import { routeIveKitMediaApi } from './agent-runtime/ivekit/media-http.js';
import {
  markMediaRecordingEvidenceDeleted,
  recordMediaRecordingEvidence
} from './agent-runtime/media-recording-evidence.js';
import { resolveRecordingObjectContent } from './agent-runtime/media-recording-object.js';
import {
  resolvePgTenantContextForRequest,
  runWithPgTenantContextAsync,
  withPgRequestContext
} from './db-pg-tenant.js';
import { verifyWeComWebhookSignature, parseWeComXmlBody } from './agent-runtime/channels/adapters/wecom-adapter.js';
import { RunStore } from './agent-runtime/stores/run-store.js';
// Lead-acquisition application imports removed (module archived).

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const consolePagePaths = new Set([
  '/',
  '/today',
  '/result',
  '/recipes',
  '/results',
  '/workbench',
  '/pipeline',
  '/tools',
  '/customers',
  '/review',
  '/campaign',
  '/call-center',
  '/timeline',
  '/demo-flow',
  '/support',
  '/resources'
]);

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

export function createServer(db, pg: PgQueryable | null = null) {
  const harness = createHarness(db);
  return createHttpServer(async (req, res) => {
    const _reqStart = Date.now();
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const path = url.pathname;

      // Prometheus metrics endpoint — no auth, plain text format.
      if (path === '/metrics') {
        const { metricsRegistry } = await import('./metrics.js');
        res.writeHead(200, { 'Content-Type': metricsRegistry.contentType });
        res.end(await metricsRegistry.metrics());
        return;
      }

      const isBinaryUpload =
        req.method === 'POST' &&
        (path === '/api/call-center/screen-recordings/upload' ||
          /^\/api\/collaboration\/remote-assistance\/[^/]+\/evidence\/upload$/.test(path) ||
          /^\/api\/collaboration\/sessions\/[^/]+\/attachments\/upload$/.test(path) ||
          /^\/api\/ivekit\/chat\/sessions\/[^/]+\/attachments\/upload$/.test(path));
      const binaryUploadMaxBytes = /\/sessions\/[^/]+\/attachments\/upload$/.test(path)
        ? collaborationAttachmentMaxBytes()
        : undefined;
      const rawBody = isBinaryUpload
        ? await readBuffer(req, binaryUploadMaxBytes)
        : path.startsWith('/api/webhooks/') || path === '/api/call-router' || path === '/api/media/webhooks/livekit'
          ? await readText(req)
          : '';
      const body = isBinaryUpload
        ? null
        : rawBody
          ? (path === '/api/webhooks/wecom' || path === '/api/webhooks/livekit' || path === '/api/media/webhooks/livekit'
            ? rawBody
            : safeJsonParse(rawBody))
          : await readJsonRequest(req);
      const pgTenantCtx = resolvePgTenantContextForRequest(path, req.headers, { url, body });
      const result = await runWithPgTenantContextAsync(pgTenantCtx, () => {
        if (!pg) return route(db, harness, null, req.method, url, body, rawBody, req.headers);
        return withPgRequestContext(pg, pgTenantCtx, (scopedPg) =>
          route(db, harness, scopedPg, req.method, url, body, rawBody, req.headers)
        );
      });

      await runAfterCommit(result);

      if (result?.sse && typeof result.attach === 'function') {
        result.attach(res);
        return;
      }

      if (result?.html) {
        send(res, 200, result.html, 'text/html; charset=utf-8');
        return;
      }

      if (result?.staticPath) {
        sendStatic(res, result.staticPath);
        return;
      }

      if (result?.contentType) {
        const payload = result.data;
        await send(
          res,
          Number.isInteger(result?.status) ? result.status : 200,
          payload,
          result.contentType,
          isHeaderRecord(result.headers) ? result.headers : {}
        );
        return;
      }

      sendJson(
        res,
        Number.isInteger(result?.status) ? result.status : 200,
        result?.data ?? result,
        isHeaderRecord(result?.headers) ? result.headers : {}
      );
    } catch (error) {
      const status = error.status || 500;
      if (status === 500) {
        const errorId = `err_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        console.error(`[500] ${errorId}`, error);
        sendJson(res, 500, {
          error: {
            message: 'internal server error',
            status: 500,
            error_id: errorId
          }
        });
      } else {
        sendJson(res, status, {
          error: {
            message: error.message,
            status
          }
        });
      }
    }
    // Record HTTP metrics (outside try/catch so both success and error are captured).
    const { recordHttpRequest } = await import('./metrics.js');
    recordHttpRequest(req.method || 'GET', req.url || '/', res.statusCode || 200, (Date.now() - _reqStart) / 1000);
  });
}

async function runAfterCommit(result: unknown): Promise<void> {
  if (!result || typeof result !== 'object') return;
  const callback = (result as { afterCommit?: unknown }).afterCommit;
  if (typeof callback !== 'function') return;
  try {
    await callback();
  } catch (error) {
    console.error('[http] post-commit event failed', error);
  }
}

async function route(db, harness, pg: PgQueryable | null, method, url, body, rawBody: string | Buffer = '', headers = {}) {
  const path = url.pathname;

  if (method === 'GET' && consolePagePaths.has(path)) return { staticPath: join(publicDir, 'index.html') };
  if (method === 'GET' && path.startsWith('/assets/')) return { staticPath: join(publicDir, normalize(path)) };
  if (method === 'GET' && path === '/livekit-test.html') return { staticPath: join(publicDir, 'livekit-test.html') };
  if (method === 'GET' && path === '/livekit-test') return { staticPath: join(publicDir, 'livekit-test.html') };
  if (method === 'GET' && path === '/widget/opc-chat.js') {
    return { staticPath: join(publicDir, 'widget/opc-chat-widget.js') };
  }
  if (method === 'GET' && path === '/openapi/call-center-v1.json') {
    return { staticPath: join(publicDir, 'openapi/call-center-v1.json') };
  }
  if (method === 'GET' && path === '/docs/api') {
    return { staticPath: join(publicDir, 'docs/api.html') };
  }

  if (method === 'GET' && path === '/health') return { ok: true, postgres: Boolean(pg) };

  const authResult = await routeAuthApi(pg, db, method, path, url, body, headers);
  if (authResult !== undefined) return authResult;

  const complianceResult = await routeComplianceApi(db, pg, method, path, url, body, headers);
  if (complianceResult !== undefined) return complianceResult;

  if (path === '/api/webhooks/wecom') {
    return handleWeComWebhook(harness, method, url, body);
  }

  const callCenterResult = await routeCallCenterApi(db, harness, method, path, url, body, rawBody, headers);
  if (callCenterResult !== undefined) return callCenterResult;

  const iveKitMediaResult = await routeIveKitMediaApi(db, method, path, url, body, rawBody, headers, {
    pg: pg || undefined,
    onRecordingStarted: pg
      ? (recording, context) => recordMediaRecordingEvidence(pg, recording, context)
      : undefined,
    onRecordingAudit: (event) => recordMediaAudit(db, event),
    resolveRecordingRetentionDays: (tenantId) => getComplianceSettings(db, tenantId).recording_retention_days,
    onRecordingDeleted: pg
      ? (recording, context) => markMediaRecordingEvidenceDeleted(pg, recording, {
          deletedBy: context.actorId,
          deletionSource: context.source
        })
      : undefined
  });
  if (iveKitMediaResult !== undefined) return iveKitMediaResult;

  const iveKitChatResult = await routeIveKitChatApi(pg, method, path, url, body, rawBody, headers, { db });
  if (iveKitChatResult !== undefined) return iveKitChatResult;

  const mediaResult = await routeMediaApi(db, method, path, url, body, rawBody, headers, {
    onRecordingStarted: pg
      ? (recording, context) => recordMediaRecordingEvidence(pg, recording, context)
      : undefined,
    onRecordingCompleted: pg
      ? (recording, context) =>
        recordMediaRecordingEvidence(pg, recording, {
          ...context,
          resolveContent: resolveRecordingObjectContent
        })
      : undefined,
    onRecordingAudit: (event) => recordMediaAudit(db, event),
    resolveRecordingRetentionDays: (tenantId) => getComplianceSettings(db, tenantId).recording_retention_days,
    onRecordingDeleted: pg
      ? (recording, context) => markMediaRecordingEvidenceDeleted(pg, recording, {
          deletedBy: context.actorId,
          deletionSource: context.source
        })
      : undefined
  });
  if (mediaResult !== undefined) return mediaResult;

  const collaborationResult = await routeCollaborationApi(pg, method, path, url, body, rawBody, headers, { db });
  if (collaborationResult !== undefined) return collaborationResult;

  const ivrResult = await routeIvrApi(db, method, path, url, body, headers);
  if (ivrResult !== undefined) return ivrResult;

  const audioLibResult = routeAudioLibraryApi(db, method, path, url, body, headers);
  if (audioLibResult !== undefined) return audioLibResult;

  const ivrSettingsResult = routeIvrSettingsApi(db, method, path, url, body, headers);
  if (ivrSettingsResult !== undefined) return ivrSettingsResult;

  const platformResult = await routePlatformApi(db, harness, method, path, url, body, headers);
  if (platformResult !== undefined) return platformResult;

  const integrationsResult = await routeIntegrationsApi(harness, method, path, url, body, headers);
  if (integrationsResult !== undefined) return integrationsResult;

  const wikiResult = await routeWikiApi(harness, method, path, url, body, headers);
  if (wikiResult !== undefined) return wikiResult;


  const geoResult = await routeGeoApi(db, harness, method, path, url, body, headers);
  if (geoResult !== undefined) return geoResult;


  const memoryResult = await routeMemoryApi(harness, method, path, url, body, headers);
  if (memoryResult !== undefined) return memoryResult;


  const voiceResult = await routeVoiceApi(db, harness, method, path, url, body, headers);
  if (voiceResult !== undefined) return voiceResult;

  if (path === '/api/admin/operations/overview' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        timeout_ms: Number(url.searchParams.get('timeout_ms') || 300)
      },
      url.searchParams.get('agent_id') || 'ops_agent',
      'admin.tenant_operations_overview'
    );
  }

  const p1AdminOverviewTools = new Map([
    ['/api/admin/provider-routing/ops-overview', 'admin.provider_routing_ops_overview'],
    ['/api/admin/crm-sync/mapping-overview', 'admin.crm_sync_mapping_overview'],
    ['/api/admin/notebook-knowledge/ops-overview', 'admin.notebook_knowledge_ops_overview'],
    ['/api/admin/billing-quota/ops-overview', 'admin.billing_quota_ops_overview'],
    ['/api/admin/quality-contracts/ops-overview', 'admin.quality_contract_ops_overview'],
    ['/api/admin/p1-foundation/overview', 'admin.p1_foundation_overview']
  ]);
  if (method === 'GET' && p1AdminOverviewTools.has(path)) {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default'
      },
      url.searchParams.get('agent_id') || 'ops_agent',
      p1AdminOverviewTools.get(path) as string
    );
  }

  const approvalDecisionMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (approvalDecisionMatch && method === 'POST') {
    return harness.approvalQueue.decide(body.tenant_id || requiredQuery(url, 'tenant_id'), approvalDecisionMatch[1], body.decision, body.actor_id || 'user');
  }

  const workflowResumeMatch = path.match(/^\/api\/workflows\/([^/]+)\/resume-after-approval$/);
  if (workflowResumeMatch && method === 'POST') {
    return harness.dagEngine.resumeAfterApproval({
      ...body,
      tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'),
      workflow_run_id: workflowResumeMatch[1]
    });
  }

  const resumeToolCallMatch = path.match(/^\/api\/tool-calls\/([^/]+)\/resume$/);
  if (resumeToolCallMatch && method === 'POST') {
    const resumed = await harness.toolExecutor.resumeApproved(
      {
        tenantId: body.tenant_id || requiredQuery(url, 'tenant_id'),
        workspaceId: body.workspace_id || 'default',
        userId: body.user_id || 'user',
        agentId: body.agent_id || 'orchestration_agent',
        workflowRunId: body.workflow_run_id || null,
        agentRunId: body.agent_run_id || null,
        playbookId: body.playbook_id || 'manual',
        stepId: body.step_id || 'resume'
      },
      resumeToolCallMatch[1]
    );
    return resumed;
  }

  if (path === '/api/side-effects' && method === 'GET') {
    const tenantId = requiredQuery(url, 'tenant_id');
    const workflowRunId = url.searchParams.get('workflow_run_id');
    const toolCallId = url.searchParams.get('tool_call_id');
    if (workflowRunId) return harness.sideEffectTracker.listForWorkflow(tenantId, workflowRunId);
    if (toolCallId) return harness.sideEffectTracker.listForToolCall(tenantId, toolCallId);
    const error = new Error('workflow_run_id or tool_call_id is required');
    error.status = 400;
    throw error;
  }

  const requireCompensationMatch = path.match(/^\/api\/side-effects\/([^/]+)\/require-compensation$/);
  if (requireCompensationMatch && method === 'POST') {
    return harness.sideEffectTracker.requireCompensation(
      body.tenant_id || requiredQuery(url, 'tenant_id'),
      requireCompensationMatch[1],
      body.reason
    );
  }

  const markCompensatedMatch = path.match(/^\/api\/side-effects\/([^/]+)\/mark-compensated$/);
  if (markCompensatedMatch && method === 'POST') {
    return harness.sideEffectTracker.markCompensated(
      body.tenant_id || requiredQuery(url, 'tenant_id'),
      markCompensatedMatch[1],
      body.details || {}
    );
  }

  const error = new Error('route not found');
  error.status = 404;
  throw error;
}

export async function readJsonRequest(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400, body: raw.slice(0, 200) });
  }
}

function sendStatic(res, path) {
  const safePath = normalize(path);
  if (!safePath.startsWith(publicDir)) {
    sendJson(res, 403, { error: { message: 'forbidden', status: 403 } });
    return;
  }
  const body = readFileSync(safePath);
  send(res, 200, body, contentTypes[extname(path)] || 'application/octet-stream');
}

type HttpResponseHeaders = Record<string, string | number | readonly string[]>;

function sendJson(res, status, data, extraHeaders: HttpResponseHeaders = {}) {
  send(res, status, JSON.stringify(data, null, 2), 'application/json; charset=utf-8', extraHeaders);
}

async function send(res, status, body, contentType, extraHeaders: HttpResponseHeaders = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...extraHeaders,
    'content-type': contentType
  });
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
    res.end(body);
    return;
  }
  try {
    for await (const chunk of body) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}

function isHeaderRecord(value: unknown): value is HttpResponseHeaders {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(
    (header) => typeof header === 'string' || typeof header === 'number' || (
      Array.isArray(header) && header.every((item) => typeof item === 'string')
    )
  );
}

function recordMediaAudit(db, event) {
  const {
    tenant_id,
    actor_id,
    action,
    recording_id,
    ...metadata
  } = event;
  auditCallCenterAction(db, {
    tenant_id,
    actor_id,
    action,
    object_type: 'media_recording',
    object_id: recording_id,
    metadata
  });
}

async function readText(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return '';
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBuffer(req, maxBytes = Number.POSITIVE_INFINITY) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('attachment upload exceeds configured size limit'), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function collaborationAttachmentMaxBytes() {
  const value = Number(process.env.OPC_COLLABORATION_ATTACHMENT_MAX_BYTES || 26_214_400);
  if (!Number.isInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new Error('OPC_COLLABORATION_ATTACHMENT_MAX_BYTES is invalid');
  }
  return value;
}

function safeJsonParse(text: string | Buffer) {
  const raw = typeof text === 'string' ? text : text.toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function handleWeComWebhook(harness, method, url, body) {
  const token = process.env.OPC_WECOM_WEBHOOK_TOKEN || '';
  const signature = url.searchParams.get('msg_signature') || url.searchParams.get('signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  const tenantId = url.searchParams.get('tenant_id') || '';

  if (method === 'GET') {
    const echoStr = url.searchParams.get('echostr') || '';
    if (!token || !verifyWeComWebhookSignature(token, signature, timestamp, nonce, echoStr)) {
      const error = new Error('invalid signature');
      error.status = 403;
      throw error;
    }
    return { status: 200, data: echoStr, contentType: 'text/plain; charset=utf-8' };
  }

  if (!token || !verifyWeComWebhookSignature(token, signature, timestamp, nonce)) {
    const error = new Error('invalid signature');
    error.status = 403;
    throw error;
  }

  const xml = typeof body === 'string' ? parseWeComXmlBody(body) : {};
  const normalized = await harness.channelAdapterRegistry.normalizeInbound('wechat', {
    xml,
    tenant_id: tenantId,
    signature_verified: true
  });

  return { status: 200, data: { received: true, message: normalized } };
}
