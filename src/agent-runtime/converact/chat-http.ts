import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import { withPgTenant } from '../../db-pg-tenant.js';
import { resolveAuthContext } from '../../middleware/auth.js';
import { createObjectStorage } from '../../storage/object-storage.js';
import {
  routeCollaborationApi,
  type PreparedTinodeSessionPlacement,
  type RouteCollaborationApiOptions
} from '../collaboration/collaboration-http.js';
import { tinodeApiKeysDistinct } from '../collaboration/tinode-env.js';
import { messageMutationWindowMs } from '../collaboration/message-state-store.js';
import { TINODE_RECEIVE_ONLY_ACCESS_MODE } from '../collaboration/chat-gateway.js';
import { CollaborationStore } from '../collaboration/collaboration-store.js';
import { SecureFileDerivativeStore } from '../collaboration/secure-file-derivative-store.js';
import { SecureFileService } from '../collaboration/secure-file-service.js';
import { SecureFileStore } from '../collaboration/secure-file-store.js';
import {
  TinodeOperationsService
} from '../collaboration/tinode-operations.js';
import { observeTinodeOperations } from '../collaboration/tinode-metrics.js';
import type {
  SecureFileKind,
  SecureFileUploadMode
} from '../collaboration/secure-file-types.js';
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
  secureFiles?: SecureFileService;
  publish?: (tenantId: string, type: string, data: unknown) => void | Promise<void>;
  eventStore?: Pick<IveKitTenantEventStore, 'append'>;
  tinodeOperations?: Pick<
    TinodeOperationsService,
    'snapshot' | 'listDeadLetters' | 'replayDeadLetter'
  > & Partial<Pick<
    TinodeOperationsService,
    'listMutationDeadLetters' | 'replayMutationDeadLetter'
  >>;
}

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function prepareIveKitChatPlacement(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitChatApiOptions,
  pg: PgQueryable | null
): Promise<PreparedTinodeSessionPlacement | null> {
  if (!options.tinodePlacement || method !== 'POST') return null;
  const match = path.split('?')[0].match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/(bind|client-plan|messages|participants)$/
  );
  if (!match) return null;
  const ctx = requireAuth(headers);
  if (!pg) throw Object.assign(new Error('PostgreSQL is required for Tinode placement'), { status: 503 });
  const sessionId = decodeURIComponent(match[1]);
  const existing = await withPgTenant(pg, ctx.tenantId, (scopedPg) =>
    options.tinodePlacement!.hasPlacement(scopedPg, {
      tenant_id: ctx.tenantId,
      interaction_id: sessionId
    })
  );
  return {
    tenant_id: ctx.tenantId,
    session_id: sessionId,
    reservation: existing
      ? null
      : await options.tinodePlacement.reserve({
          tenant_id: ctx.tenantId,
          interaction_id: sessionId,
          routing_partition_key: sessionId,
          idempotency_key: `tinode-session:${sessionId}`
        }),
    persisted: false
  };
}

function chatCapabilities(tenantId: string, env: NodeJS.ProcessEnv = process.env) {
  const providerUrlConfigured = hasValue(env.TINODE_BASE_URL) || hasValue(env.TINODE_WS_URL);
  const apiKeyConfigured = hasValue(env.TINODE_API_KEY);
  const rootApiKeyConfigured = hasValue(env.TINODE_ROOT_API_KEY);
  const apiKeysDistinct = tinodeApiKeysDistinct(env);
  const rootAuthConfigured = hasValue(env.TINODE_AUTH_TOKEN) || (
    hasValue(env.TINODE_BASIC_USER) && hasValue(env.TINODE_BASIC_PASSWORD)
  );
  const userProvisioningConfigured = hasValue(env.TINODE_USER_PASSWORD_SECRET);
  const clientWsConfigured = providerUrlConfigured || hasValue(env.TINODE_PUBLIC_BASE_URL) || hasValue(env.TINODE_PUBLIC_WS_URL);
  const providerConfigured = providerUrlConfigured && apiKeyConfigured && rootApiKeyConfigured &&
    apiKeysDistinct && rootAuthConfigured;
  const inboundSyncConfigured = providerUrlConfigured && rootApiKeyConfigured &&
    apiKeysDistinct && rootAuthConfigured &&
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
      secure_files: true,
      secure_file_single_upload: true,
      secure_file_multipart_upload: true,
      secure_file_resume: true,
      secure_file_scan_gate: true,
      attachment_processing: true,
      visual_observations: true,
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
      provider_operations: true,
      provider_dead_letter_replay: true,
      provider_file_security_gate: true,
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
      root_api_key_configured: rootApiKeyConfigured,
      api_keys_distinct: apiKeysDistinct,
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
      secure_file_create_path: '/api/ivekit/chat/sessions/:session_id/files',
      secure_file_content_path: '/api/ivekit/chat/sessions/:session_id/files/:file_id/content',
      secure_file_part_path: '/api/ivekit/chat/sessions/:session_id/files/:file_id/parts/:part_number',
      secure_file_parts_path: '/api/ivekit/chat/sessions/:session_id/files/:file_id/parts',
      secure_file_complete_path: '/api/ivekit/chat/sessions/:session_id/files/:file_id/complete',
      secure_file_status_path: '/api/ivekit/chat/sessions/:session_id/files/:file_id',
      secure_file_download_path: '/api/ivekit/chat/sessions/:session_id/files/:file_id/download',
      tinode_operations_path: '/api/ivekit/chat/operations/tinode',
      tinode_dead_letters_path: '/api/ivekit/chat/operations/tinode/dead-letters',
      tinode_dead_letter_replay_path: '/api/ivekit/chat/operations/tinode/dead-letters/:dead_letter_id/replay',
      tinode_mutation_dead_letters_path: '/api/ivekit/chat/operations/tinode/mutation-dead-letters',
      tinode_mutation_dead_letter_replay_path: '/api/ivekit/chat/operations/tinode/mutation-dead-letters/:outbox_id/replay',
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

  const tinodeOperationsResult = await routeTinodeOperationsApi(
    pg, method, routePath, url, body, headers, options
  );
  if (tinodeOperationsResult !== undefined) return tinodeOperationsResult;

  const secureFileResult = await routeSecureFileApi(
    pg, method, routePath, body, rawBody, headers, options
  );
  if (secureFileResult !== undefined) return secureFileResult;

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
      const translations = await service.listTranslations({
        tenant_id: ctx.tenantId,
        session_id: sessionId,
        source_type: sourceType,
        source_ref_id: sourceRefId,
        target_language: url.searchParams.get('target_language') || undefined,
        history
      });
      return { data: {
        items: translations.items,
        jobs: translations.jobs.map(projectTranslationJob)
      } };
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
  const collaborationOptions: RouteIveKitChatApiOptions = pg
    ? {
        ...options,
        secureFiles: secureFileService(pg, options),
        secureAttachmentsRequired: true
      }
    : options;
  const result = await routeCollaborationApi(
    pg,
    method,
    collaborationPath,
    collaborationUrl,
    body,
    rawBody,
    headers,
    collaborationOptions
  );
  return withTinodePlacementAfterCommit(result, collaborationOptions);
}

function withTinodePlacementAfterCommit(
  result: unknown | undefined,
  options: RouteIveKitChatApiOptions
): unknown | undefined {
  const prepared = options.preparedTinodePlacement;
  if (!result || typeof result !== 'object' ||
      !prepared?.persisted ||
      !options.tinodePlacement) {
    return result;
  }
  const current = (result as { afterCommit?: unknown }).afterCommit;
  return {
    ...(result as Record<string, unknown>),
    afterCommit: async () => {
      if (typeof current === 'function') await current();
      await options.tinodePlacement!.reconcileOne({
        tenant_id: prepared.tenant_id,
        interaction_id: prepared.session_id,
        worker_id: options.placementWorkerId || 'tinode-http'
      });
    }
  };
}

async function routeTinodeOperationsApi(
  pg: PgQueryable | null,
  method: string,
  routePath: string,
  url: URL,
  _body: unknown,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitChatApiOptions
): Promise<unknown | undefined> {
  const root = '/api/ivekit/chat/operations/tinode';
  if (!routePath.startsWith(root)) return undefined;
  const ctx = requireAuth(headers);
  if (!['system', 'owner', 'admin'].includes(ctx.role)) {
    throw Object.assign(new Error('Tinode operations require admin role'), { status: 403 });
  }
  if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
  const service = options.tinodeOperations || new TinodeOperationsService({ pg });

  if (routePath === root && method === 'GET') {
    const snapshot = await service.snapshot(ctx.tenantId);
    observeTinodeOperations(snapshot);
    return { data: snapshot };
  }
  if (routePath === `${root}/dead-letters` && method === 'GET') {
    const rawState = url.searchParams.get('state') || 'open';
    if (!['open', 'resolved', 'all'].includes(rawState)) {
      throw Object.assign(new Error('dead-letter state is invalid'), { status: 400 });
    }
    const limit = optionalPositiveInteger(url.searchParams.get('limit'), 'limit');
    return {
      data: {
        items: await service.listDeadLetters({
          tenant_id: ctx.tenantId,
          state: rawState as 'open' | 'resolved' | 'all',
          limit
        })
      }
    };
  }
  if (routePath === `${root}/mutation-dead-letters` && method === 'GET') {
    if (!service.listMutationDeadLetters) {
      throw Object.assign(new Error('Tinode mutation operations are unavailable'), { status: 503 });
    }
    const limit = optionalPositiveInteger(url.searchParams.get('limit'), 'limit');
    return {
      data: {
        items: await service.listMutationDeadLetters({ tenant_id: ctx.tenantId, limit })
      }
    };
  }
  const replayMatch = routePath.match(
    /^\/api\/ivekit\/chat\/operations\/tinode\/dead-letters\/([^/]+)\/replay$/
  );
  if (replayMatch && method === 'POST') {
    const idempotencyKey = headerValue(headers, 'idempotency-key').trim();
    if (!idempotencyKey) {
      throw Object.assign(new Error('Idempotency-Key is required'), { status: 400 });
    }
    const result = await service.replayDeadLetter({
      tenant_id: ctx.tenantId,
      dead_letter_id: decodeURIComponent(replayMatch[1]),
      requested_by: ctx.userId || ctx.role,
      idempotency_key: idempotencyKey
    });
    return {
      status: result.replayed ? 200 : 202,
      data: result,
      afterCommit: () => publishChatEvent(
        pg,
        options,
        ctx.tenantId,
        'collaboration.tinode.dead_letter.replay_requested',
        {
          dead_letter_id: result.dead_letter.id,
          event_id: result.dead_letter.event_id,
          replay_id: result.replay_id,
          replayed: result.replayed
        }
      )
    };
  }
  const mutationReplayMatch = routePath.match(
    /^\/api\/ivekit\/chat\/operations\/tinode\/mutation-dead-letters\/([^/]+)\/replay$/
  );
  if (mutationReplayMatch && method === 'POST') {
    if (!service.replayMutationDeadLetter) {
      throw Object.assign(new Error('Tinode mutation operations are unavailable'), { status: 503 });
    }
    const idempotencyKey = headerValue(headers, 'idempotency-key').trim();
    if (!idempotencyKey) {
      throw Object.assign(new Error('Idempotency-Key is required'), { status: 400 });
    }
    const result = await service.replayMutationDeadLetter({
      tenant_id: ctx.tenantId,
      outbox_id: decodeURIComponent(mutationReplayMatch[1]),
      requested_by: ctx.userId || ctx.role,
      idempotency_key: idempotencyKey
    });
    return {
      status: result.replayed ? 200 : 202,
      data: result,
      afterCommit: () => publishChatEvent(
        pg,
        options,
        ctx.tenantId,
        'collaboration.tinode.mutation_dead_letter.replay_requested',
        {
          outbox_id: result.dead_letter.id,
          mutation_id: result.dead_letter.mutation_id,
          replay_id: result.replay_id,
          replayed: result.replayed
        }
      )
    };
  }
  return { status: 405, data: { error: 'method not allowed' } };
}

async function routeSecureFileApi(
  pg: PgQueryable | null,
  method: string,
  routePath: string,
  body: unknown,
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>,
  options: RouteIveKitChatApiOptions
): Promise<unknown | undefined> {
  const filesPrefix = /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files(?:\/|$)/;
  const prefixMatch = routePath.match(filesPrefix);
  if (!prefixMatch) return undefined;
  const ctx = requireAuth(headers);
  if (!pg) throw Object.assign(new Error('PostgreSQL is required'), { status: 503 });
  const sessionId = decodeURIComponent(prefixMatch[1]);
  await requireSessionMember(pg, ctx, sessionId);
  const service = secureFileService(pg, options);

  const collectionMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files$/
  );
  if (collectionMatch && method === 'POST') {
    const idempotencyKey = headerValue(headers, 'idempotency-key').trim();
    if (!idempotencyKey) {
      throw Object.assign(new Error('Idempotency-Key is required'), { status: 400 });
    }
    const input = bodyRecord(body);
    const file = await service.createUpload({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      created_by: ctx.userId || 'system',
      kind: String(input.kind || '') as SecureFileKind,
      filename: String(input.filename || ''),
      declared_mime: input.declared_mime == null ? undefined : String(input.declared_mime),
      upload_mode: String(input.upload_mode || '') as SecureFileUploadMode,
      expected_size_bytes: Number(input.expected_size_bytes),
      part_size_bytes: input.part_size_bytes == null ? undefined : Number(input.part_size_bytes),
      idempotency_key: idempotencyKey,
      payload_hash: createHash('sha256').update(stableJson(input)).digest('hex'),
      retention_until: optionalString(input.retention_until),
      expires_at: optionalString(input.expires_at),
      metadata: input.metadata == null ? undefined : bodyRecord(input.metadata)
    });
    return secureFileMutationResult(
      pg, options, ctx.tenantId, 'collaboration.secure_file.created', file, 201
    );
  }

  const partMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files\/([^/]+)\/parts\/(\d+)$/
  );
  if (partMatch && method === 'PUT') {
    const fileId = decodeURIComponent(partMatch[2]);
    const part = await service.uploadPart({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: fileId,
      part_number: Number(partMatch[3]),
      content: binaryBody(rawBody),
      sha256: requiredChecksumHeader(headers)
    });
    return {
      data: { part },
      afterCommit: () => publishChatEvent(
        pg,
        options,
        ctx.tenantId,
        'collaboration.secure_file.part_uploaded',
        { session_id: sessionId, file_id: fileId, part }
      )
    };
  }

  const partsMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files\/([^/]+)\/parts$/
  );
  if (partsMatch && method === 'GET') {
    const parts = await service.listParts({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: decodeURIComponent(partsMatch[2])
    });
    return { data: { parts } };
  }

  const contentMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files\/([^/]+)\/content$/
  );
  if (contentMatch && method === 'PUT') {
    const file = await service.uploadContent({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: decodeURIComponent(contentMatch[2]),
      content: binaryBody(rawBody),
      sha256: requiredChecksumHeader(headers)
    });
    return secureFileMutationResult(
      pg, options, ctx.tenantId, 'collaboration.secure_file.uploaded', file
    );
  }

  const completeMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files\/([^/]+)\/complete$/
  );
  if (completeMatch && method === 'POST') {
    const input = bodyRecord(body);
    const file = await service.completeUpload({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: decodeURIComponent(completeMatch[2]),
      size_bytes: Number(input.size_bytes),
      sha256: String(input.sha256 || '')
    });
    return secureFileMutationResult(
      pg, options, ctx.tenantId, 'collaboration.secure_file.uploaded', file
    );
  }

  const downloadMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files\/([^/]+)\/download$/
  );
  if (downloadMatch && method === 'GET') {
    const downloaded = await service.download({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: decodeURIComponent(downloadMatch[2])
    });
    return {
      contentType: downloaded.content_type,
      headers: {
        'content-disposition': `attachment; filename="${safeDownloadFilename(downloaded.filename)}"`,
        'x-content-sha256': downloaded.sha256
      },
      data: downloaded.content
    };
  }

  const fileMatch = routePath.match(
    /^\/api\/ivekit\/chat\/sessions\/([^/]+)\/files\/([^/]+)$/
  );
  if (fileMatch && method === 'GET') {
    const file = await service.getFile({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: decodeURIComponent(fileMatch[2])
    });
    return { data: { file } };
  }
  if (fileMatch && method === 'DELETE') {
    const file = await service.abortUpload({
      tenant_id: ctx.tenantId,
      session_id: sessionId,
      secure_file_id: decodeURIComponent(fileMatch[2])
    });
    return secureFileMutationResult(
      pg, options, ctx.tenantId, 'collaboration.secure_file.aborted', file
    );
  }
  return { status: 405, data: { error: 'method not allowed' } };
}

function secureFileService(
  pg: PgQueryable,
  options: RouteIveKitChatApiOptions
): SecureFileService {
  return options.secureFiles || new SecureFileService({
    files: new SecureFileStore(pg),
    derivatives: new SecureFileDerivativeStore(pg),
    storage: createObjectStorage()
  });
}

function secureFileMutationResult(
  pg: PgQueryable,
  options: RouteIveKitChatApiOptions,
  tenantId: string,
  eventType: string,
  file: Awaited<ReturnType<SecureFileService['getFile']>>,
  status = 200
): Record<string, unknown> {
  return {
    status,
    data: { file },
    afterCommit: () => publishChatEvent(pg, options, tenantId, eventType, file)
  };
}

function requiredChecksumHeader(
  headers: Record<string, string | string[] | undefined>
): string {
  const value = headerValue(headers, 'x-content-sha256').trim();
  if (!value) throw Object.assign(new Error('X-Content-SHA256 is required'), { status: 400 });
  return value;
}

function binaryBody(value: string | Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw Object.assign(new Error('binary request body is required'), { status: 400 });
  }
  return value;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return String(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(object[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function safeDownloadFilename(value: string): string {
  const filename = String(value || 'download.bin').split(/[\\/]/).pop() || 'download.bin';
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download.bin';
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

function optionalPositiveInteger(value: string | null, field: string): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error(`${field} must be a positive integer`), { status: 400 });
  }
  return parsed;
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
