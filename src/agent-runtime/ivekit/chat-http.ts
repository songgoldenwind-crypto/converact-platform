import type { PgQueryable } from '../../db-pg.js';
import { resolveAuthContext } from '../../middleware/auth.js';
import {
  routeCollaborationApi,
  type RouteCollaborationApiOptions
} from '../collaboration/collaboration-http.js';
import { messageMutationWindowMs } from '../collaboration/message-state-store.js';
import { TINODE_RECEIVE_ONLY_ACCESS_MODE } from '../collaboration/chat-gateway.js';
import { CollaborationStore } from '../collaboration/collaboration-store.js';
import { createIntelligenceProviderRegistry } from '../collaboration/intelligence-provider-registry.js';
import { createPolicyTranslationProviderResolver } from '../collaboration/intelligence-provider-routing.js';
import { TranslationService } from '../collaboration/translation-service.js';
import { wsBroadcast } from '../../ws.js';
import {
  IveKitTenantEventStore,
  iveKitEventReplayEnabled
} from './tenant-event-store.js';

export interface RouteIveKitChatApiOptions extends RouteCollaborationApiOptions {
  translation?: TranslationService;
  publish?: (tenantId: string, type: string, data: unknown) => void | Promise<void>;
  eventStore?: Pick<IveKitTenantEventStore, 'append'>;
}

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

function chatCapabilities(tenantId: string, env: NodeJS.ProcessEnv = process.env) {
  const providerUrlConfigured = hasValue(env.TINODE_BASE_URL) || hasValue(env.TINODE_WS_URL);
  const apiKeyConfigured = hasValue(env.TINODE_API_KEY);
  const rootAuthConfigured = hasValue(env.TINODE_AUTH_TOKEN) || (
    hasValue(env.TINODE_BASIC_USER) && hasValue(env.TINODE_BASIC_PASSWORD)
  );
  const userProvisioningConfigured = hasValue(env.TINODE_USER_PASSWORD_SECRET);
  const clientWsConfigured = providerUrlConfigured || hasValue(env.TINODE_PUBLIC_BASE_URL) || hasValue(env.TINODE_PUBLIC_WS_URL);
  const providerConfigured = providerUrlConfigured && apiKeyConfigured && rootAuthConfigured;
  const inboundSyncConfigured = providerUrlConfigured && rootAuthConfigured &&
    String(env.OPC_TINODE_INBOUND_WORKER_ENABLED || '1').trim() !== '0';

  return {
    provider: providerUrlConfigured ? 'tinode' : 'local',
    tenant_id: tenantId,
    capabilities: {
      sessions: true,
      cursor_session_list: true,
      business_ref_lookup: true,
      binding: true,
      participants: true,
      messages: true,
      cursor_message_history: true,
      attachments: true,
      attachment_upload: true,
      attachment_upload_progress: true,
      attachment_download: true,
      attachment_processing: true,
      ocr: hasValue(env.OPC_OCR_BASE_URL),
      asr: hasValue(env.OPC_ASR_BASE_URL),
      policy_scan: true,
      policy_findings: true,
      ai_quality_review: true,
      human_review: true,
      translation: hasValue(env.OPC_TRANSLATION_BASE_URL) || hasValue(env.OPC_IVEKIT_PROVIDER_PROFILES_JSON),
      snapshot: true,
      client_plan: providerConfigured && userProvisioningConfigured && clientWsConfigured,
      provider_inbound_sync: true,
      durable_event_replay: iveKitEventReplayEnabled(env),
      durable_provider_delivery: true,
      provider_delivery_attempt_history: true,
      idempotent_message_create: true,
      message_receipts: true,
      unread_count: true,
      typing: true,
      presence: true,
      message_edit: true,
      message_soft_delete: true,
      message_mutation_audit: true,
      message_relations: true,
      message_mentions: true,
      message_reactions: true,
      message_pins: true
    },
    config: {
      provider_configured: providerConfigured,
      provider_url_configured: providerUrlConfigured,
      api_key_configured: apiKeyConfigured,
      root_auth_configured: rootAuthConfigured,
      user_provisioning_configured: userProvisioningConfigured,
      client_ws_configured: clientWsConfigured,
      inbound_sync_configured: inboundSyncConfigured,
      quality_review_configured: hasValue(env.OPC_QUALITY_REVIEW_BASE_URL),
      translation_configured: hasValue(env.OPC_TRANSLATION_BASE_URL) || hasValue(env.OPC_IVEKIT_PROVIDER_PROFILES_JSON),
      message_mutation_window_ms: messageMutationWindowMs(env),
      tinode_client_access_mode: TINODE_RECEIVE_ONLY_ACCESS_MODE
    },
    delivery_policy: {
      business_message_write_path: '/api/ivekit/chat/sessions/:session_id/messages',
      tenant_event_replay_path: '/api/ivekit/events',
      message_delivery_status_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery',
      message_delivery_retry_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id/delivery/retry',
      attachment_upload_path: '/api/ivekit/chat/sessions/:session_id/attachments/upload',
      attachment_status_path: '/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id',
      attachment_download_path: '/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/download',
      attachment_retry_path: '/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/retry',
      attachment_processing_run_path: '/api/ivekit/chat/attachment-processing/run',
      quality_review_run_path: '/api/ivekit/chat/quality-review/run',
      message_quality_review_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id/quality-review',
      message_receipts_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id/receipts',
      message_state_path: '/api/ivekit/chat/sessions/:session_id/message-state',
      typing_path: '/api/ivekit/chat/sessions/:session_id/typing',
      presence_path: '/api/ivekit/chat/sessions/:session_id/presence',
      realtime_state_path: '/api/ivekit/chat/sessions/:session_id/realtime-state',
      message_mutation_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id',
      message_mutation_history_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id/mutations',
      findings_path: '/api/ivekit/chat/sessions/:session_id/findings',
      finding_review_path: '/api/ivekit/chat/sessions/:session_id/findings/:finding_id/review',
      message_translations_path: '/api/ivekit/chat/sessions/:session_id/messages/:message_id/translations',
      attachment_translations_path: '/api/ivekit/chat/sessions/:session_id/attachments/:attachment_id/translations',
      translation_retry_path: '/api/ivekit/chat/sessions/:session_id/translations/:job_id/retry',
      translation_run_path: '/api/ivekit/chat/translation/run',
      idempotency_header: 'Idempotency-Key',
      direct_client_publish: false,
      reason: 'Business messages must pass the iveKit facade for local audit and policy scanning.'
    }
  };
}

export async function routeIveKitChatApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  rawBody: string | Buffer = '',
  headers: Record<string, string | string[] | undefined> = {},
  options: RouteIveKitChatApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/chat')) return undefined;

  if (routePath === '/api/ivekit/chat/capabilities' && method === 'GET') {
    const ctx = requireAuth(headers);
    return { data: chatCapabilities(ctx.tenantId) };
  }

  if (routePath === '/api/ivekit/chat/translation/run' && method === 'POST') {
    const ctx = requireAuth(headers);
    if (ctx.role !== 'system') throw Object.assign(new Error('system role is required'), { status: 403 });
    if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
    const input = bodyRecord(body);
    const limit = input.limit == null ? undefined : Number(input.limit);
    return { data: await translationService(pg, options).runDue({ tenant_id: ctx.tenantId, limit }) };
  }

  const translationRetryMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/translations\/([^/]+)\/retry$/
  );
  if (translationRetryMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
    const sessionId = decodeURIComponent(translationRetryMatch[1]);
    await requireSessionMember(pg, ctx, sessionId);
    const job = await translationService(pg, options).retryJob({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      job_id: decodeURIComponent(translationRetryMatch[2])
    });
    const event = {
      job_id: job.id,
      session_id: job.session_id,
      message_id: job.message_id,
      source_type: job.source_type,
      source_ref_id: job.source_ref_id,
      target_language: job.target_language,
      status: job.status,
      retry: true
    };
    return {
      data: { job: projectTranslationJob(job) },
      afterCommit: () => publishChatEvent(
        pg, options, ctx.tenantId, 'collaboration.translation.queued', event
      )
    };
  }

  const translationMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/(messages|attachments)\/([^/]+)\/translations$/
  );
  if (translationMatch && (method === 'GET' || method === 'POST')) {
    const ctx = requireAuth(headers);
    if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
    const sessionId = decodeURIComponent(translationMatch[1]);
    await requireSessionMember(pg, ctx, sessionId);
    const sourceType = translationMatch[2] === 'messages' ? 'message' as const : 'attachment' as const;
    const sourceRefId = decodeURIComponent(translationMatch[3]);
    const service = translationService(pg, options);
    if (method === 'GET') {
      const history = url.searchParams.get('history') === '1';
      if (history && !['system', 'owner', 'admin'].includes(ctx.role)) {
        throw Object.assign(new Error('translation history requires admin role'), { status: 403 });
      }
      return { data: await service.listTranslations({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        source_type: sourceType,
        source_ref_id: sourceRefId,
        target_language: url.searchParams.get('target_language') || undefined,
        history
      }) };
    }
    const idempotencyKey = headerValue(headers, 'idempotency-key').trim();
    if (!idempotencyKey) throw Object.assign(new Error('Idempotency-Key is required'), { status: 400 });
    const input = bodyRecord(body);
    const requested = await service.requestTranslation({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      source_type: sourceType,
      source_ref_id: sourceRefId,
      source_language: input.source_language ? String(input.source_language) : undefined,
      target_language: String(input.target_language || ''),
      idempotency_key: idempotencyKey
    });
    const event = {
      job_id: requested.job.id,
      session_id: requested.job.session_id,
      message_id: requested.job.message_id,
      source_type: requested.job.source_type,
      source_ref_id: requested.job.source_ref_id,
      target_language: requested.job.target_language,
      status: requested.job.status,
      replayed: requested.replayed
    };
    return {
      status: requested.replayed ? 200 : 201,
      data: { job: projectTranslationJob(requested.job), replayed: requested.replayed },
      afterCommit: () => publishChatEvent(
        pg, options, ctx.tenantId, 'collaboration.translation.queued', event
      )
    };
  }

  const collaborationPath = collaborationPathForIveKitChat(routePath);
  if (!collaborationPath) return undefined;
  const collaborationUrl = new URL(url.toString());
  collaborationUrl.pathname = collaborationPath;
  return routeCollaborationApi(
    pg,
    method,
    collaborationPath,
    collaborationUrl,
    body,
    rawBody,
    headers,
    options
  );
}

function collaborationPathForIveKitChat(routePath: string): string {
  if (routePath === '/api/ivekit/chat/sessions') {
    return '/api/collaboration/sessions';
  }
  if (routePath === '/api/ivekit/chat/sessions/by-ref') {
    return '/api/collaboration/sessions/by-ref';
  }
  if (routePath === '/api/ivekit/chat/attachment-processing/run') {
    return '/api/collaboration/attachment-processing/run';
  }
  if (routePath === '/api/ivekit/chat/quality-review/run') {
    return '/api/collaboration/quality-review/run';
  }
  if (routePath.startsWith('/api/ivekit/chat/objects/')) {
    return `/api/collaboration/ivekit-objects/${routePath.slice('/api/ivekit/chat/objects/'.length)}`;
  }

  const qualityReviewMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/quality-review$/
  );
  if (qualityReviewMatch) {
    return `/api/collaboration/sessions/${qualityReviewMatch[1]}/messages/${qualityReviewMatch[2]}/quality-review`;
  }

  const receiptMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/receipts$/
  );
  if (receiptMatch) {
    return `/api/collaboration/sessions/${receiptMatch[1]}/messages/${receiptMatch[2]}/receipts`;
  }

  const mutationHistoryMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/mutations$/
  );
  if (mutationHistoryMatch) {
    return `/api/collaboration/sessions/${mutationHistoryMatch[1]}/messages/${mutationHistoryMatch[2]}/mutations`;
  }

  const reactionMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/
  );
  if (reactionMatch) {
    const suffix = reactionMatch[3] ? `/${reactionMatch[3]}` : '';
    return `/api/collaboration/sessions/${reactionMatch[1]}/messages/${reactionMatch[2]}/reactions${suffix}`;
  }

  const pinMatch = routePath.match(/^\/api\/ivekit\/chat\/sessions\/([^/]+)\/pins(?:\/([^/]+))?$/);
  if (pinMatch) {
    const suffix = pinMatch[2] ? `/${pinMatch[2]}` : '';
    return `/api/collaboration/sessions/${pinMatch[1]}/pins${suffix}`;
  }

  const messageMutationMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/messages\/([^/]+)$/
  );
  if (messageMutationMatch) {
    return `/api/collaboration/sessions/${messageMutationMatch[1]}/messages/${messageMutationMatch[2]}`;
  }

  const messageStateMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/message-state$/
  );
  if (messageStateMatch) {
    return `/api/collaboration/sessions/${messageStateMatch[1]}/message-state`;
  }

  const realtimeStateMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/(typing|presence|realtime-state)$/
  );
  if (realtimeStateMatch) {
    return `/api/collaboration/sessions/${realtimeStateMatch[1]}/${realtimeStateMatch[2]}`;
  }

  const attachmentRetryMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/attachments\/([^/]+)\/retry$/
  );
  if (attachmentRetryMatch) {
    return `/api/collaboration/sessions/${attachmentRetryMatch[1]}/attachments/${attachmentRetryMatch[2]}/retry`;
  }

  const attachmentDownloadMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/attachments\/([^/]+)\/download$/
  );
  if (attachmentDownloadMatch) {
    return `/api/collaboration/sessions/${attachmentDownloadMatch[1]}/attachments/${attachmentDownloadMatch[2]}/download`;
  }

  const findingReviewMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/findings\/([^/]+)\/review$/
  );
  if (findingReviewMatch) {
    return `/api/collaboration/sessions/${findingReviewMatch[1]}/findings/${findingReviewMatch[2]}/review`;
  }

  const findingMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/findings(?:\/([^/]+))?$/
  );
  if (findingMatch) {
    const suffix = findingMatch[2] ? `/${findingMatch[2]}` : '';
    return `/api/collaboration/sessions/${findingMatch[1]}/findings${suffix}`;
  }

  const attachmentMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/attachments\/([^/]+)$/
  );
  if (attachmentMatch) {
    return `/api/collaboration/sessions/${attachmentMatch[1]}/attachments/${attachmentMatch[2]}`;
  }

  const deliveryMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/messages\/([^/]+)\/delivery(?:\/(retry))?$/
  );
  if (deliveryMatch) {
    const suffix = deliveryMatch[3] ? '/retry' : '';
    return `/api/collaboration/sessions/${deliveryMatch[1]}/messages/${deliveryMatch[2]}/delivery${suffix}`;
  }

  const match = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/(bind|client-plan|snapshot|messages|participants|close)(?:\/(leave))?$/
  );
  if (!match) return '';
  const sessionId = match[1];
  const section = match[2];
  const action = match[3] || '';

  if (section === 'bind' && !action) {
    return `/api/collaboration/sessions/${sessionId}/chat/bind`;
  }
  if (section === 'client-plan' && !action) {
    return `/api/collaboration/sessions/${sessionId}/chat/client-plan`;
  }
  if (section === 'snapshot' && !action) {
    return `/api/collaboration/sessions/${sessionId}/chat`;
  }
  if (section === 'messages' && !action) {
    return `/api/collaboration/sessions/${sessionId}/messages`;
  }
  if (section === 'participants' && !action) {
    return `/api/collaboration/sessions/${sessionId}/participants`;
  }
  if (section === 'participants' && action === 'leave') {
    return `/api/collaboration/sessions/${sessionId}/participants/leave`;
  }
  if (section === 'close' && !action) {
    return `/api/collaboration/sessions/${sessionId}/close`;
  }
  return '';
}

function hasValue(value: string | undefined): boolean {
  return Boolean(String(value || '').trim());
}

function translationService(pg: PgQueryable, options: RouteIveKitChatApiOptions): TranslationService {
  if (options.translation) return options.translation;
  const registry = createIntelligenceProviderRegistry();
  return new TranslationService({
    pg,
    resolveProvider: createPolicyTranslationProviderResolver({ pg, registry })
  });
}

async function requireSessionMember(
  pg: PgQueryable,
  ctx: ReturnType<typeof requireAuth>,
  sessionId: string
): Promise<void> {
  const store = new CollaborationStore(pg);
  const session = await store.getSession(sessionId);
  if (!session || session.tenant_id !== ctx.tenantId) {
    throw Object.assign(new Error('collaboration session not found'), { status: 404 });
  }
  if (ctx.role === 'system') return;
  const participants = await store.listParticipants({ tenant_id: ctx.tenantId, session_id: sessionId });
  if (!participants.some((participant) => participant.identity === ctx.userId && !participant.left_at)) {
    throw Object.assign(new Error('collaboration session not found'), { status: 404 });
  }
}

function projectTranslationJob(job: Awaited<ReturnType<TranslationService['getJob']>>): Record<string, unknown> | null {
  if (!job) return null;
  const { idempotency_key: _key, payload_hash: _payload, error_message: _message,
    output_metadata: _metadata, ...safe } = job;
  return safe;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON object body is required'), { status: 400 });
  }
  return value as Record<string, unknown>;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = Array.isArray(entry?.[1]) ? entry?.[1][0] : entry?.[1];
  return String(value || '');
}

async function publishChatEvent(
  pg: PgQueryable,
  options: RouteIveKitChatApiOptions,
  tenantId: string,
  type: string,
  data: unknown
): Promise<void> {
  const eventStore = options.eventStore || (
    iveKitEventReplayEnabled() ? new IveKitTenantEventStore(pg) : null
  );
  if (eventStore) await eventStore.append({ tenant_id: tenantId, type, data });
  await Promise.resolve((options.publish || wsBroadcast)(tenantId, type, data));
}
