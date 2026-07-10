import {
  acceptTransferCommand,
  acceptIntercomCommand,
  cancelOutboundTaskCommand,
  createLiveKitRoomCommand,
  createOutboundTaskCommand,
  createVoiceAgentSpecCommand,
  declineIntercomCommand,
  deleteCallSessionCacheCommand,
  endAgentCallCommand,
  generateVoiceAgentSpecCommand,
  getCallCenterDashboardCommand,
  getCallSessionCacheCommand,
  getCallSessionDetailCommand,
  getVoiceAgentSpecCommand,
  handleAgentDispatchCommand,
  handleCallRouterCommand,
  handleLiveKitWebhookCommand,
  handleRustpbxCdrWebhook,
  heartbeatAgentSeatCommand,
  importIvrVoiceAgentSpecCommand,
  issueLiveKitTokenCommand,
  listAgentSeatsCommand,
  listConversationTurnsCommand,
  listOutboundTasksCommand,
  listVoiceAgentSpecsCommand,
  navigateCallFlowCommand,
  patchCallSessionCacheCommand,
  publishVoiceAgentSpecCommand,
  reportConversationTurnCommand,
  reportIntentCommand,
  startIntercomCommand,
  upsertAgentSeatCommand,
  updateAgentSeatStatusCommand,
  verifyOpcApiKey,
  verifyRustpbxWebhookKey
} from './agent-runtime/call-center/application.js';
import { routeQmApi } from './agent-runtime/call-center/qm/qm-http.js';
import { routeBillingApi } from './agent-runtime/call-center/billing/billing-http.js';
import { routeKnowledgeApi } from './agent-runtime/call-center/knowledge/knowledge-http.js';
import { routeWfmApi } from './agent-runtime/call-center/wfm/wfm-http.js';
import { routeWebhookApi } from './agent-runtime/call-center/webhooks/webhook-http.js';
import { routeWhiteLabelApi } from './agent-runtime/call-center/white-label/white-label-http.js';
import { routeInboundApi } from './agent-runtime/call-center/inbound/inbound-http.js';
import { routeRustpbxStepIvrApi } from './agent-runtime/ivr/ivr-step-http.js';
import { routeAgentToolsApi } from './agent-runtime/call-center/agent-tools/agent-tools-http.js';
import { routeCampaignApi } from './agent-runtime/call-center/dialer/campaign-http.js';
import { routeOmniApi } from './agent-runtime/call-center/omnichannel/omni-http.js';
import { routeSprint10Api } from './agent-runtime/call-center/analytics/sprint10-http.js';
import { routeSprint12Api } from './agent-runtime/call-center/analytics/sprint12-http.js';
import { routePhase3AgentApi } from './agent-runtime/call-center/agent-panel/phase3-agent-http.js';
import { resolveAuthContext } from './middleware/auth.js';
import type {
  CallRouterRequest,
  CreateOutboundTaskInput,
  UpsertAgentSeatInput,
  CreateVoiceAgentSpecInput,
  GenerateVoiceAgentSpecInput,
  ImportIvrVoiceAgentInput,
  ReportTurnRequest,
  ReportIntentRequest,
  AgentDispatchRequest,
  NavigateCallFlowRequest,
  AgentSeatStatus
} from './agent-runtime/call-center/types.js';

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (!value) throw Object.assign(new Error(`${key} is required`), { status: 400 });
  return value;
}

export async function routeCallCenterApi(
  db: unknown,
  harness: { voiceStore?: unknown },
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const rawBodyText: string = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const phase3Result = await routePhase3AgentApi(db, method, path, url, body, rawBody, headers);
  if (phase3Result !== undefined) return phase3Result;

  const inboundResult = await routeInboundApi(db, method, path, body, headers);
  if (inboundResult !== undefined) return inboundResult;

  const agentToolsResult = await routeAgentToolsApi(db, method, path, url, body, headers);
  if (agentToolsResult !== undefined) return agentToolsResult;

  const campaignResult = await routeCampaignApi(db, method, path, url, body, headers);
  if (campaignResult !== undefined) return campaignResult;

  const omniResult = await routeOmniApi(db, method, path, url, body, headers);
  if (omniResult !== undefined) return omniResult;

  const sprint10Result = await routeSprint10Api(db, method, path, url, body, headers);
  if (sprint10Result !== undefined) return sprint10Result;

  const sprint12Result = await routeSprint12Api(db, method, path, url, body, headers, rawBody);
  if (sprint12Result !== undefined) return sprint12Result;

  const stepIvrResult = await routeRustpbxStepIvrApi(db, method, path, body, headers);
  if (stepIvrResult !== undefined) return stepIvrResult;

  if (path === '/api/call-router' && method === 'POST') {
    verifyRustpbxWebhookKey(headers);
    return await handleCallRouterCommand(db, harness as any, body as CallRouterRequest);
  }

  if (path === '/api/webhooks/rustpbx-cdr' && method === 'POST') {
    verifyRustpbxWebhookKey(headers);
    // Webhook body is loosely typed JSON from RustPBX; narrow at command boundary.
    return handleRustpbxCdrWebhook(db, harness as any, body as Record<string, unknown>);
  }

  if (path === '/api/webhooks/voicemail-recording' && method === 'POST') {
    verifyRustpbxWebhookKey(headers);
    const { ingestVoicemailCommand } = await import('./agent-runtime/call-center/application.js');
    return ingestVoicemailCommand(db, body as Record<string, unknown>);
  }

  if (path === '/api/webhooks/livekit' && method === 'POST') {
    const authHeader = String(headers.authorization || headers.Authorization || '');
    return handleLiveKitWebhookCommand(db, rawBodyText, authHeader || undefined);
  }

  if (path === '/api/livekit/rooms' && method === 'POST') {
    verifyOpcApiKey(headers);
    return createLiveKitRoomCommand(db, body as { tenant_id: string; purpose: 'ai_outbound' | 'video_service' | 'screen_share' | 'conference' | 'pstn_bridge'; call_session_id?: string; metadata?: Record<string, unknown>; room_name?: string });
  }

  if (path === '/api/livekit/token' && method === 'GET') {
    verifyOpcApiKey(headers);
    return issueLiveKitTokenCommand(db, {
      room_name: requiredQuery(url, 'room_name'),
      identity: requiredQuery(url, 'identity'),
      role: (url.searchParams.get('role') || 'customer') as 'agent' | 'customer',
      tenant_id: url.searchParams.get('tenant_id') || undefined
    });
  }

  if (path === '/api/livekit/agent-dispatch' && method === 'POST') {
    verifyOpcApiKey(headers);
    return handleAgentDispatchCommand(db, harness as any, body as AgentDispatchRequest);
  }

  const turnsMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/turns$/);
  if (turnsMatch && method === 'POST') {
    verifyOpcApiKey(headers);
    return reportConversationTurnCommand(db, turnsMatch[1], body as ReportTurnRequest);
  }
  if (turnsMatch && method === 'GET') {
    return listConversationTurnsCommand(db, turnsMatch[1]);
  }

  const callDetailMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)$/);
  if (callDetailMatch && method === 'GET') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.tenantId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    return getCallSessionDetailCommand(db, ctx.tenantId, callDetailMatch[1]);
  }

  const acceptTransferMatch = path.match(/^\/api\/call-center\/transfers\/([^/]+)\/accept$/);
  if (acceptTransferMatch && method === 'POST') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    const input = body as { seat_id?: string };
    if (!input.seat_id) {
      return { status: 400, data: { error: 'seat_id is required' } };
    }
    return acceptTransferCommand(
      db,
      ctx.tenantId,
      input.seat_id,
      acceptTransferMatch[1],
      ctx.userId
    );
  }

  // --- Agent-to-agent intercom (internal seat-to-seat calls) ---
  if (path === '/api/call-center/intercom/start' && method === 'POST') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    const input = body as { from_seat_id?: string; target_seat_id?: string; media?: 'voice' | 'video' };
    if (!input.from_seat_id || !input.target_seat_id) {
      return { status: 400, data: { error: 'from_seat_id and target_seat_id are required' } };
    }
    return startIntercomCommand(db, ctx.tenantId, ctx.userId, {
      from_seat_id: input.from_seat_id,
      target_seat_id: input.target_seat_id,
      media: input.media
    });
  }

  if (path === '/api/call-center/intercom/accept' && method === 'POST') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    const input = body as { room_name?: string; seat_id?: string };
    if (!input.room_name || !input.seat_id) {
      return { status: 400, data: { error: 'room_name and seat_id are required' } };
    }
    return acceptIntercomCommand(db, ctx.tenantId, ctx.userId, {
      room_name: input.room_name,
      seat_id: input.seat_id
    });
  }

  if (path === '/api/call-center/intercom/decline' && method === 'POST') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    const input = body as {
      room_name?: string;
      from_user_id?: string;
      target_user_id?: string;
      reason?: 'declined' | 'cancelled' | 'timeout';
    };
    if (!input.room_name) {
      return { status: 400, data: { error: 'room_name is required' } };
    }
    return declineIntercomCommand(db, ctx.tenantId, ctx.userId, {
      room_name: input.room_name,
      from_user_id: input.from_user_id,
      target_user_id: input.target_user_id,
      reason: input.reason
    });
  }

  const endCallMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/end$/);
  if (endCallMatch && method === 'POST') {
    const ctx = resolveAuthContext(headers);
    if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
      throw Object.assign(new Error('authentication required'), { status: 401 });
    }
    const input = body as { seat_id?: string; disposition?: string };
    if (!input.seat_id) {
      return { status: 400, data: { error: 'seat_id is required' } };
    }
    return endAgentCallCommand(
      db,
      ctx.tenantId,
      input.seat_id,
      endCallMatch[1],
      ctx.userId,
      { disposition: input.disposition }
    );
  }

  const intentMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/intent$/);
  if (intentMatch && method === 'POST') {
    verifyOpcApiKey(headers);
    return reportIntentCommand(db, harness as any, intentMatch[1], body as ReportIntentRequest);
  }

  const sessionCacheMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/session-cache$/);
  if (sessionCacheMatch && method === 'GET') {
    verifyOpcApiKey(headers);
    return getCallSessionCacheCommand(sessionCacheMatch[1]);
  }
  if (sessionCacheMatch && method === 'PATCH') {
    verifyOpcApiKey(headers);
    return patchCallSessionCacheCommand(sessionCacheMatch[1], body as Record<string, unknown>);
  }
  if (sessionCacheMatch && method === 'DELETE') {
    verifyOpcApiKey(headers);
    return deleteCallSessionCacheCommand(sessionCacheMatch[1]);
  }

  if (path === '/api/call-center/outbound-tasks' && method === 'GET') {
    return listOutboundTasksCommand(
      db,
      requiredQuery(url, 'tenant_id'),
      url.searchParams.get('status')
    );
  }

  if (path === '/api/call-center/outbound-tasks' && method === 'POST') {
    const input = body as Record<string, unknown>;
    // Normalize: accept 'phone' as alias for 'phone_number'
    return createOutboundTaskCommand(db, {
      ...input,
      phone_number: (input.phone_number as string) || (input.phone as string) || ''
    } as CreateOutboundTaskInput);
  }

  const cancelMatch = path.match(/^\/api\/call-center\/outbound-tasks\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    return cancelOutboundTaskCommand(db, cancelMatch[1]);
  }

  if (path === '/api/call-center/seats' && method === 'GET') {
    return listAgentSeatsCommand(db, requiredQuery(url, 'tenant_id'));
  }

  if (path === '/api/call-center/seats' && method === 'POST') {
    return upsertAgentSeatCommand(db, body as UpsertAgentSeatInput);
  }

  const seatStatusMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/status$/);
  if (seatStatusMatch && method === 'PUT') {
    return updateAgentSeatStatusCommand(
      db,
      requiredQuery(url, 'tenant_id'),
      seatStatusMatch[1],
      body as { status: AgentSeatStatus; call_session_id?: string | null }
    );
  }

  const seatHeartbeatMatch = path.match(/^\/api\/call-center\/seats\/([^/]+)\/heartbeat$/);
  if (seatHeartbeatMatch && method === 'POST') {
    return heartbeatAgentSeatCommand(db, requiredQuery(url, 'tenant_id'), seatHeartbeatMatch[1]);
  }

  if (path === '/api/call-center/dashboard' && method === 'GET') {
    return getCallCenterDashboardCommand(db, requiredQuery(url, 'tenant_id'));
  }

  if (path === '/api/voice-agents/specs' && method === 'GET') {
    return listVoiceAgentSpecsCommand(
      db,
      requiredQuery(url, 'tenant_id'),
      url.searchParams.get('status')
    );
  }

  if (path === '/api/voice-agents/specs' && method === 'POST') {
    return createVoiceAgentSpecCommand(db, body as CreateVoiceAgentSpecInput);
  }

  if (path === '/api/voice-agents/generate' && method === 'POST') {
    verifyOpcApiKey(headers);
    return generateVoiceAgentSpecCommand(db, body as GenerateVoiceAgentSpecInput);
  }

  if (path === '/api/voice-agents/import-ivr' && method === 'POST') {
    verifyOpcApiKey(headers);
    return importIvrVoiceAgentSpecCommand(db, body as ImportIvrVoiceAgentInput);
  }

  const navigateMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/navigate$/);
  if (navigateMatch && method === 'POST') {
    verifyOpcApiKey(headers);
    return navigateCallFlowCommand(db, harness as any, navigateMatch[1], body as NavigateCallFlowRequest);
  }

  const specMatch = path.match(/^\/api\/voice-agents\/specs\/([^/]+)$/);
  if (specMatch && method === 'GET') {
    return getVoiceAgentSpecCommand(db, specMatch[1], url.searchParams.get('tenant_id'));
  }

  const publishMatch = path.match(/^\/api\/voice-agents\/specs\/([^/]+)\/publish$/);
  if (publishMatch && method === 'POST') {
    verifyOpcApiKey(headers);
    return publishVoiceAgentSpecCommand(db, publishMatch[1], requiredQuery(url, 'tenant_id'));
  }

  const qmResult = await routeQmApi(db, method, path, url, body, headers);
  if (qmResult !== undefined) return qmResult;

  const billingResult = await routeBillingApi(db, method, path, url, body, rawBodyText, headers);
  if (billingResult !== undefined) return billingResult;

  const knowledgeResult = await routeKnowledgeApi(db, method, path, url, body, headers);
  if (knowledgeResult !== undefined) return knowledgeResult;

  const wfmResult = await routeWfmApi(db, method, path, url, body, headers);
  if (wfmResult !== undefined) return wfmResult;

  const webhookResult = await routeWebhookApi(db, method, path, url, body, headers);
  if (webhookResult !== undefined) return webhookResult;

  const whiteLabelResult = routeWhiteLabelApi(db, method, path, url, body, headers);
  if (whiteLabelResult !== undefined) return whiteLabelResult;

  return undefined;
}
