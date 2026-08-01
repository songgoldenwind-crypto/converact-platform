import { resolveBrandEnv, resolveFabricEnv } from '../../config/converact-env.js';
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server
} from 'node:http';
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions
} from 'node:https';
import { randomUUID } from 'node:crypto';

import type { PgQueryable } from '../../db-pg.js';
import {
  resolvePgTenantContextForRequest,
  runWithPgTenantContextAsync,
  withPgRequestContext
} from '../../db-pg-tenant.js';
import {
  prepareConveractFabricRustDeskPlacement,
  routeCollaborationApi,
  type PreparedRustDeskSessionPlacement,
  type PreparedTinodeSessionPlacement,
  type RouteCollaborationApiOptions
} from '../collaboration/collaboration-http.js';
import {
  prepareConveractFabricChatPlacement,
  routeConveractFabricChatApi,
  type RouteConveractFabricChatApiOptions
} from './chat-http.js';
import {
  routeConveractFabricIntelligenceApi,
  type RouteConveractFabricIntelligenceApiOptions
} from './intelligence-http.js';
import {
  routeConveractFabricEventApi,
  type RouteConveractFabricEventApiOptions
} from './event-http.js';
import { createConveractFabricMediaHooks } from './media-hooks.js';
import {
  prepareConveractFabricMediaCallPlacement,
  routeConveractFabricMediaApi,
  type PreparedMediaCallPlacement,
  type RouteConveractFabricMediaApiOptions
} from './media-http.js';
import {
  prepareConveractFabricVoiceCallPlacement,
  routeConveractFabricVoiceApi,
  type PreparedVoiceCallPlacement,
  type RouteConveractFabricVoiceApiOptions
} from './voice/http.js';
import {
  routeConveractFabricIvrApi,
  type RouteConveractFabricIvrApiOptions
} from './ivr/http.js';
import {
  routeConveractFabricContactCenterApi,
  type RouteConveractFabricContactCenterApiOptions
} from './contact-center/http.js';
import { ContactCenterError } from './contact-center/errors.js';
import { PlacementError } from './placement/types.js';
import { VoiceError } from './voice/errors.js';
import {
  mapStoreFailureToVoice503,
  trustedStoreFailureRetryAfterSeconds
} from './voice/sip-foundation/admission-error.js';
import { IvrError } from './ivr/errors.js';
import {
  routeConveractFabricNotificationApi,
  type RouteConveractFabricNotificationApiOptions
} from './notifications/http.js';
import { NotificationError } from './notifications/errors.js';
import {
  routeConveractFabricAuditApi,
  type RouteConveractFabricAuditApiOptions
} from './operations/audit/http.js';
import { ConveractFabricOperationsError } from './operations/audit/errors.js';
import { ConveractFabricRateLimitError } from './operations/rate-limit/errors.js';
import {
  routeConveractFabricRetentionApi,
  type RouteConveractFabricRetentionApiOptions
} from './operations/retention/http.js';
import { ConveractFabricRetentionError } from './operations/retention/errors.js';
import {
  RecordingSpoolIntakeError,
  recordingSpoolHttpPartMaxBytes
} from './recordings/index.js';
import {
  createConveractFabricReadinessProbe,
  type ConveractFabricPlacementReadinessProbe,
  type ConveractFabricReadinessProbe
} from './operations/readiness.js';
import { runWithWsBroadcastBuffer } from '../../ws.js';

type MediaRoute = typeof routeConveractFabricMediaApi;
type ChatRoute = typeof routeConveractFabricChatApi;
type IntelligenceRoute = typeof routeConveractFabricIntelligenceApi;
type EventRoute = typeof routeConveractFabricEventApi;
type CollaborationRoute = typeof routeCollaborationApi;
type VoiceRoute = typeof routeConveractFabricVoiceApi;
type IvrRoute = typeof routeConveractFabricIvrApi;
type ContactCenterRoute = typeof routeConveractFabricContactCenterApi;
type NotificationRoute = typeof routeConveractFabricNotificationApi;
type AuditRoute = typeof routeConveractFabricAuditApi;
type RetentionRoute = typeof routeConveractFabricRetentionApi;

export interface ConveractFabricRouteAdapters {
  media: MediaRoute;
  chat: ChatRoute;
  intelligence: IntelligenceRoute;
  events: EventRoute;
  voice: VoiceRoute;
  ivr: IvrRoute;
  contactCenter: ContactCenterRoute;
  notifications: NotificationRoute;
  audit: AuditRoute;
  retention: RetentionRoute;
  collaboration: CollaborationRoute;
}

export interface ConveractFabricHttpServerInput {
  db: unknown;
  pg: PgQueryable | null;
  tls?: HttpsServerOptions;
  routes?: Partial<ConveractFabricRouteAdapters>;
  mediaOptions?: RouteConveractFabricMediaApiOptions;
  chatOptions?: RouteConveractFabricChatApiOptions;
  collaborationOptions?: RouteCollaborationApiOptions;
  intelligenceOptions?: RouteConveractFabricIntelligenceApiOptions;
  eventOptions?: RouteConveractFabricEventApiOptions;
  voiceOptions?: RouteConveractFabricVoiceApiOptions;
  ivrOptions?: RouteConveractFabricIvrApiOptions;
  contactCenterOptions?: RouteConveractFabricContactCenterApiOptions;
  notificationOptions?: RouteConveractFabricNotificationApiOptions;
  auditOptions?: RouteConveractFabricAuditApiOptions;
  retentionOptions?: RouteConveractFabricRetentionApiOptions;
  readinessProbe?: ConveractFabricReadinessProbe;
  placementReadinessProbe?: ConveractFabricPlacementReadinessProbe;
}

const allowedPrefixes = [
  '/api/ivekit/media/',
  '/api/ivekit/chat/',
  '/api/ivekit/intelligence/',
  '/api/ivekit/events/',
  '/api/ivekit/voice/',
  '/api/ivekit/ivr/',
  '/api/ivekit/contact-center/',
  '/api/ivekit/notifications/',
  '/api/ivekit/audit/',
  '/api/ivekit/retention/',
  '/api/ivekit/context/',
  '/api/ivekit/rustdesk/',
  '/api/opc/rustdesk/'
];

const allowedExactPaths = new Set([
  '/health',
  '/livez',
  '/readyz',
  '/metrics',
  '/api/ivekit/events',
  '/api/ivekit/notifications',
  '/api/media/webhooks/livekit',
  '/remote/rustdesk/launch'
]);

export function createConveractFabricHttpServer(input: ConveractFabricHttpServerInput): Server {
  if (input.tls &&
      (input.tls.requestCert !== true || input.tls.rejectUnauthorized !== true)) {
    throw new Error('Converact Fabric internal TLS must require an authorized client certificate');
  }
  const routes: ConveractFabricRouteAdapters = {
    media: input.routes?.media || routeConveractFabricMediaApi,
    chat: input.routes?.chat || routeConveractFabricChatApi,
    intelligence: input.routes?.intelligence || routeConveractFabricIntelligenceApi,
    events: input.routes?.events || routeConveractFabricEventApi,
    voice: input.routes?.voice || routeConveractFabricVoiceApi,
    ivr: input.routes?.ivr || routeConveractFabricIvrApi,
    contactCenter: input.routes?.contactCenter || routeConveractFabricContactCenterApi,
    notifications: input.routes?.notifications || routeConveractFabricNotificationApi,
    audit: input.routes?.audit || routeConveractFabricAuditApi,
    retention: input.routes?.retention || routeConveractFabricRetentionApi,
    collaboration: input.routes?.collaboration || routeCollaborationApi
  };
  const mediaOptions = input.mediaOptions || (input.pg
    ? createConveractFabricMediaHooks({ db: input.db, pg: input.pg })
    : {});
  const readiness = input.readinessProbe || createConveractFabricReadinessProbe({
    pg: input.pg,
    instanceId: resolveFabricEnv(process.env, 'INSTANCE_ID'),
    placementProbe: input.placementReadinessProbe
  });

  const requestListener: RequestListener = async (request, response) => {
    const requestId = requestIdentifier(request.headers);
    response.setHeader('x-request-id', requestId);
    let requestPath = '/';
    let preparedMediaCallPlacement: PreparedMediaCallPlacement | null = null;
    let preparedMediaCallPlacementCommitted = false;
    let preparedVoiceCallPlacement: PreparedVoiceCallPlacement | null = null;
    let preparedVoiceCallPlacementCommitted = false;
    let preparedTinodePlacement: PreparedTinodeSessionPlacement | null = null;
    let preparedTinodePlacementCommitted = false;
    let preparedRustDeskPlacement: PreparedRustDeskSessionPlacement | null = null;
    let preparedRustDeskPlacementCommitted = false;
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      const path = url.pathname;
      requestPath = path;
      if (!isAllowedConveractFabricPath(path)) {
        sendJson(response, 404, { error: { message: 'not found', status: 404 } });
        return;
      }
      const origin = requestHeader(request.headers, 'origin');
      if (origin) {
        if (!allowedCorsOrigins().has(origin)) {
          sendJson(response, 403, { error: { message: 'origin not allowed', status: 403 } });
          return;
        }
        setCorsHeaders(response, origin);
      }
      if (request.method === 'OPTIONS') {
        if (!origin) {
          sendJson(response, 400, { error: { message: 'origin is required', status: 400 } });
          return;
        }
        response.writeHead(204);
        response.end();
        return;
      }
      if (path === '/livez' && request.method === 'GET') {
        sendJson(response, 200, { status: 'alive' });
        return;
      }
      if ((path === '/health' || path === '/readyz') && request.method === 'GET') {
        const state = await readiness.probe();
        sendJson(response, state.status === 'ready' ? 200 : 503, state);
        return;
      }
      if (path === '/metrics' && request.method === 'GET') {
        const { metricsRegistry } = await import('../../metrics.js');
        send(response, 200, await metricsRegistry.metrics(), metricsRegistry.contentType);
        return;
      }

      const method = request.method || 'GET';
      const isAttachmentUpload = method === 'POST' &&
        /^\/api\/ivekit\/chat\/sessions\/[^/]+\/attachments\/upload$/.test(path);
      const isSecureFileUpload = method === 'PUT' && (
        /^\/api\/ivekit\/chat\/sessions\/[^/]+\/files\/[^/]+\/content$/.test(path) ||
        /^\/api\/ivekit\/chat\/sessions\/[^/]+\/files\/[^/]+\/parts\/\d+$/.test(path)
      );
      const isRustDeskEvidenceUpload = method === 'PUT' && (
        /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/evidence\/[^/]+\/content$/.test(path) ||
        /^\/api\/ivekit\/rustdesk\/devices\/[^/]+\/evidence\/[^/]+\/parts\/\d+$/.test(path)
      );
      const isRecordingSpoolPartUpload = method === 'PUT' &&
        /^\/api\/ivekit\/voice\/providers\/[^/]+\/recording-spool\/segments\/[^/]+\/parts\/\d+$/.test(path);
      const isLiveKitWebhook = method === 'POST' &&
        (path === '/api/ivekit/media/webhooks/livekit' || path === '/api/media/webhooks/livekit');
      const rawBody = isAttachmentUpload || isSecureFileUpload || isRustDeskEvidenceUpload ||
        isRecordingSpoolPartUpload
        ? await readBuffer(
            request,
            isRecordingSpoolPartUpload
              ? recordingSpoolHttpPartMaxBytes()
              : isSecureFileUpload || isRustDeskEvidenceUpload
                ? secureFileUploadMaxBytes()
                : collaborationAttachmentMaxBytes()
          )
        : await readText(request, converactFabricHttpBodyMaxBytes());
      const body = isAttachmentUpload || isSecureFileUpload || isRustDeskEvidenceUpload ||
        isRecordingSpoolPartUpload
        ? null
        : isLiveKitWebhook
          ? rawBody
          : parseJsonBody(rawBody);
      const headers = {
        ...request.headers,
        'x-opc-request-id': requestId,
        'x-opc-source-ip': request.socket.remoteAddress || ''
      };
      const tenantContext = isVoiceProviderWebhook(method, path)
        ? {}
        : resolvePgTenantContextForRequest(path, headers, { url, body });
      const mediaPath = path === '/api/media/webhooks/livekit'
        ? '/api/ivekit/media/webhooks/livekit'
        : path;
      const mediaUrl = mediaPath === path ? url : new URL(mediaPath, url);
      preparedMediaCallPlacement = await prepareConveractFabricMediaCallPlacement(
        method,
        mediaPath,
        body,
        headers,
        mediaOptions
      );
      preparedTinodePlacement = await prepareConveractFabricChatPlacement(
        method,
        path,
        headers,
        input.chatOptions || {},
        input.pg
      );
      preparedRustDeskPlacement = await prepareConveractFabricRustDeskPlacement(
        method,
        path,
        body,
        headers,
        input.collaborationOptions || {},
        input.pg
      );
      preparedVoiceCallPlacement = await prepareConveractFabricVoiceCallPlacement(
        method,
        path,
        body,
        headers,
        input.voiceOptions || {},
        input.pg,
        rawBody
      );
      const dispatch = async (pg: PgQueryable | null) => {
        const voiceResult = path.startsWith('/api/ivekit/voice/')
          ? await routes.voice(pg, method, path, url, body, rawBody, headers, {
              ...input.voiceOptions,
              ...(preparedVoiceCallPlacement
                ? { prepared_call_placement: preparedVoiceCallPlacement }
                : {})
            })
          : undefined;
        const ivrResult = path.startsWith('/api/ivekit/ivr/')
          ? await routes.ivr(pg, method, path, url, body, rawBody, headers, input.ivrOptions)
          : undefined;
        const contactCenterResult = path.startsWith('/api/ivekit/contact-center/')
          ? await routes.contactCenter(
            pg, method, path, url, body, rawBody, headers, input.contactCenterOptions
          )
          : undefined;
        const notificationResult = path === '/api/ivekit/notifications'
          || path.startsWith('/api/ivekit/notifications/')
          ? await routes.notifications(
            pg, method, path, url, body, headers, input.notificationOptions
          )
          : undefined;
        const auditResult = path.startsWith('/api/ivekit/audit/')
          ? await routes.audit(pg, method, path, url, headers, input.auditOptions)
          : undefined;
        const retentionResult = path.startsWith('/api/ivekit/retention/')
          ? await routes.retention(pg, method, path, url, body, headers, input.retentionOptions)
          : undefined;
        return await routes.media(input.db, method, mediaPath, mediaUrl, body, rawBody, headers, {
          ...mediaOptions,
          ...(preparedMediaCallPlacement
            ? { preparedMediaCallPlacement }
            : {}),
          ...(pg ? { pg } : {})
        })
        ?? await routes.events(pg, method, path, url, headers, body, input.eventOptions)
        ?? await routes.intelligence(pg, method, path, url, body, headers, {
          db: input.db,
          ...input.intelligenceOptions
        })
        ?? await routes.chat(pg, method, path, url, body, rawBody, headers, {
          db: input.db,
          ...input.chatOptions,
          ...(preparedTinodePlacement
            ? { preparedTinodePlacement }
            : {})
        })
        ?? auditResult
        ?? retentionResult
        ?? notificationResult
        ?? contactCenterResult
        ?? ivrResult
        ?? voiceResult
        ?? await routes.collaboration(pg, method, path, url, body, rawBody, headers, {
          db: input.db,
          ...input.collaborationOptions,
          ...(preparedRustDeskPlacement
            ? { preparedRustDeskPlacement }
            : {})
        });
      };
      const buffered = await runWithWsBroadcastBuffer(() =>
        runWithPgTenantContextAsync(tenantContext, () =>
          input.pg
            ? withPgRequestContext(input.pg, tenantContext, (scopedPg) => dispatch(scopedPg))
            : dispatch(null)
        )
      );
      const result = buffered.result;

      if (result === undefined) {
        await releasePreparedMediaCallPlacement(
          mediaOptions,
          preparedMediaCallPlacement
        );
        await releasePreparedVoiceCallPlacement(
          input.voiceOptions,
          preparedVoiceCallPlacement
        );
        await releasePreparedTinodePlacement(
          input.chatOptions,
          preparedTinodePlacement
        );
        await releasePreparedRustDeskPlacement(
          input.collaborationOptions,
          preparedRustDeskPlacement
        );
        preparedMediaCallPlacement = null;
        preparedVoiceCallPlacement = null;
        preparedTinodePlacement = null;
        preparedRustDeskPlacement = null;
        if (isStructuredControlPath(path)) {
          sendJson(response, 404, voiceErrorEnvelope('not_found', false, requestId));
        } else {
          sendJson(response, 404, { error: { message: 'not found', status: 404 } });
        }
        return;
      }
      if (preparedTinodePlacement?.reservation &&
          !preparedTinodePlacement.persisted) {
        await releasePreparedTinodePlacement(
          input.chatOptions,
          preparedTinodePlacement
        );
        preparedTinodePlacement = null;
      }
      if (preparedRustDeskPlacement?.reservation &&
          !preparedRustDeskPlacement.persisted) {
        await releasePreparedRustDeskPlacement(
          input.collaborationOptions,
          preparedRustDeskPlacement
        );
        preparedRustDeskPlacement = null;
      }
      preparedMediaCallPlacementCommitted = true;
      preparedVoiceCallPlacementCommitted = true;
      preparedTinodePlacementCommitted = true;
      preparedRustDeskPlacementCommitted = true;
      await buffered.flush();
      await runAfterCommit(result);
      const output = result as Record<string, unknown>;
      if (typeof output.html === 'string') {
        send(response, 200, output.html, 'text/html; charset=utf-8');
        return;
      }
      if (typeof output.contentType === 'string') {
        await send(
          response,
          Number.isInteger(output.status) ? Number(output.status) : 200,
          output.data,
          output.contentType,
          isHeaderRecord(output.headers) ? output.headers : {}
        );
        return;
      }
      sendJson(
        response,
        Number.isInteger(output.status) ? Number(output.status) : 200,
        output.data ?? output,
        isHeaderRecord(output.headers) ? output.headers : {}
      );
    } catch (error) {
      if (preparedMediaCallPlacement && !preparedMediaCallPlacementCommitted) {
        await releasePreparedMediaCallPlacement(
          mediaOptions,
          preparedMediaCallPlacement
        ).catch((releaseError) => {
          console.error(
            '[converact] failed to release media placement after request failure:',
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          );
        });
      }
      if (preparedVoiceCallPlacement && !preparedVoiceCallPlacementCommitted) {
        await releasePreparedVoiceCallPlacement(
          input.voiceOptions,
          preparedVoiceCallPlacement
        ).catch((releaseError) => {
          console.error(
            '[converact] failed to release voice placement after request failure:',
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          );
        });
      }
      if (preparedTinodePlacement && !preparedTinodePlacementCommitted) {
        await releasePreparedTinodePlacement(
          input.chatOptions,
          preparedTinodePlacement
        ).catch((releaseError) => {
          console.error(
            '[converact] failed to release Tinode placement after request failure:',
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          );
        });
      }
      if (preparedRustDeskPlacement && !preparedRustDeskPlacementCommitted) {
        await releasePreparedRustDeskPlacement(
          input.collaborationOptions,
          preparedRustDeskPlacement
        ).catch((releaseError) => {
          console.error(
            '[converact] failed to release RustDesk placement after request failure:',
            releaseError instanceof Error ? releaseError.message : String(releaseError)
          );
        });
      }
      const storeFailure = mapStoreFailureToVoice503(error);
      const responseError = storeFailure ?? error;
      const status = Number((responseError as { status?: number }).status || 500);
      if (isStructuredControlPath(requestPath)) {
        const domainError = responseError instanceof VoiceError ||
          responseError instanceof IvrError ||
          responseError instanceof ContactCenterError ||
          responseError instanceof NotificationError ||
          responseError instanceof ConveractFabricOperationsError ||
          responseError instanceof ConveractFabricRateLimitError ||
          responseError instanceof ConveractFabricRetentionError ||
          responseError instanceof RecordingSpoolIntakeError ||
          responseError instanceof PlacementError
            ? responseError : null;
        const code = domainError?.code ?? (status >= 500 ? 'internal_error' : httpVoiceErrorCode(status));
        const storeRetryAfter =
          trustedStoreFailureRetryAfterSeconds(domainError);
        sendJson(
          response,
          status,
          voiceErrorEnvelope(
            code,
            domainError?.retryable === true,
            requestId,
            structuredErrorDetails(domainError)
          ),
          error instanceof ConveractFabricRateLimitError
            ? { 'retry-after': error.retry_after_seconds }
            : storeRetryAfter !== null
              ? { 'retry-after': storeRetryAfter }
              : {}
        );
        return;
      }
      sendJson(response, status, {
        error: {
          message: status === 500 ? 'internal server error' : (error as Error).message,
          status
        }
      });
    }
  };
  return input.tls
    ? createHttpsServer(input.tls, requestListener)
    : createHttpServer(requestListener);
}

async function releasePreparedMediaCallPlacement(
  options: RouteConveractFabricMediaApiOptions,
  prepared: PreparedMediaCallPlacement | null
): Promise<void> {
  if (!prepared || !options.placement) return;
  await options.placement.releaseUncommitted(prepared.reservation);
}

async function releasePreparedVoiceCallPlacement(
  options: RouteConveractFabricVoiceApiOptions | undefined,
  prepared: PreparedVoiceCallPlacement | null
): Promise<void> {
  if (!options?.placement || !prepared?.reservation) return;
  await options.placement.releaseUncommitted(prepared.reservation);
}

async function releasePreparedTinodePlacement(
  options: RouteConveractFabricChatApiOptions | undefined,
  prepared: PreparedTinodeSessionPlacement | null
): Promise<void> {
  if (!options?.tinodePlacement || !prepared?.reservation || prepared.persisted) return;
  await options.tinodePlacement.releaseUncommitted(prepared.reservation);
}

async function releasePreparedRustDeskPlacement(
  options: RouteCollaborationApiOptions | undefined,
  prepared: PreparedRustDeskSessionPlacement | null
): Promise<void> {
  if (!options?.rustdeskPlacement || !prepared?.reservation || prepared.persisted) return;
  await options.rustdeskPlacement.releaseUncommitted(prepared.reservation);
}

function isVoiceProviderWebhook(method: string, path: string): boolean {
  return (method === 'POST'
      && (/^\/api\/ivekit\/voice\/providers\/[^/]+\/(router|inbound-admission|events|cdrs)$/.test(path)
        || /^\/api\/ivekit\/ivr\/provider-webhooks\/rustpbx\/[^/]+\/step$/.test(path)))
    || (['GET', 'POST', 'PUT'].includes(method)
      && (/^\/api\/ivekit\/voice\/providers\/[^/]+\/recording-spool\/segments(?:\/.*)?$/.test(path)
        || /^\/api\/ivekit\/voice\/providers\/[^/]+\/recording-spool\/recordings\/[^/]+\/complete$/.test(path)));
}

function isStructuredControlPath(path: string): boolean {
  return path.startsWith('/api/ivekit/voice/') || path.startsWith('/api/ivekit/ivr/') ||
    path.startsWith('/api/ivekit/contact-center/') || path === '/api/ivekit/notifications' ||
    path.startsWith('/api/ivekit/notifications/') || path.startsWith('/api/ivekit/audit/') ||
    path.startsWith('/api/ivekit/retention/') ||
    path.startsWith('/api/ivekit/events/webhook-subscriptions');
}

function requestIdentifier(headers: Record<string, string | string[] | undefined>): string {
  const provided = requestHeader(headers, 'x-request-id');
  return provided && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(provided)
    ? provided
    : randomUUID();
}

function voiceErrorEnvelope(
  code: string,
  retryable: boolean,
  requestId: string,
  details: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    error: {
      code,
      message: voiceErrorMessage(code),
      retryable,
      request_id: requestId,
      details
    }
  };
}

function structuredErrorDetails(error: unknown): Readonly<Record<string, unknown>> {
  if (!(error instanceof PlacementError)) return {};
  const allowed = new Set([
    'cell_id',
    'owner_node_id',
    'reservation_id',
    'attempted_cells',
    'last_error_code'
  ]);
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(error.details)) {
    if (!allowed.has(key)) continue;
    if (typeof value === 'string' && value.length <= 255) {
      output[key] = value;
    } else if (Array.isArray(value) && value.length <= 32 &&
        value.every((item) => typeof item === 'string' && item.length <= 255)) {
      output[key] = [...value];
    }
  }
  return output;
}

function voiceErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    invalid_call_transition: 'voice call transition is not allowed',
    terminal_call_state: 'voice call is already terminal',
    invalid_address: 'voice address is invalid',
    validation_failed: 'voice request validation failed',
    not_found: 'voice resource was not found',
    revision_conflict: 'voice resource revision changed',
    idempotency_conflict: 'voice idempotency key conflicts with an existing request',
    capability_unavailable: 'voice capability is unavailable',
    provider_auth_failed: 'voice provider authentication failed',
    provider_unavailable: 'voice provider is unavailable',
    provider_timeout: 'voice provider result is uncertain',
    protocol_mismatch: 'voice provider protocol response is invalid',
    compliance_denied: 'voice compliance policy denied the request',
    webhook_auth_failed: 'voice provider webhook authentication failed',
    secret_ref_invalid: 'voice secret reference is invalid',
    secret_unavailable: 'voice secret is unavailable',
    invalid_delivery_transition: 'notification delivery transition is not allowed',
    terminal_delivery_state: 'notification delivery is already terminal',
    lease_lost: 'notification delivery lease was lost',
    provider_rejected: 'notification provider rejected the request',
    provider_result_unknown: 'notification provider result is uncertain',
    quota_exhausted: 'notification provider quota is exhausted',
    rate_limited: 'notification request is rate limited',
    audit_append_failed: 'audit service is unavailable',
    invalid_stored_event: 'audit history contains an invalid event',
    retention_lease_lost: 'retention worker lease was lost',
    retention_handler_unavailable: 'retention handler is unavailable',
    invalid_retention_result: 'retention worker returned an invalid result',
    invalid_queue_entry_transition: 'contact center queue entry transition is not allowed',
    invalid_assignment_transition: 'contact center assignment transition is not allowed',
    invalid_presence_transition: 'contact center presence transition is not allowed',
    invalid_supervisor_transition: 'contact center supervisor transition is not allowed',
    capacity_exhausted: 'contact center queue or agent capacity is exhausted',
    conflict: 'contact center resource conflicts with current state',
    placement_state_conflict: 'voice placement conflicts with current owner state',
    placement_idempotency_conflict: 'voice placement idempotency key conflicts with an existing owner',
    placement_unavailable: 'voice placement is unavailable',
    placement_capacity_exhausted: 'voice placement capacity is exhausted',
    internal_error: 'internal server error'
  };
  return messages[code] || 'voice request failed';
}

function httpVoiceErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'webhook_auth_failed';
  if (status === 404) return 'not_found';
  if (status === 409) return 'revision_conflict';
  return 'validation_failed';
}

async function runAfterCommit(result: unknown): Promise<void> {
  if (!result || typeof result !== 'object') return;
  const callback = (result as { afterCommit?: unknown }).afterCommit;
  if (typeof callback !== 'function') return;
  try {
    await callback();
  } catch (error) {
    console.error('[converact] post-commit event failed', error);
  }
}

function isAllowedConveractFabricPath(path: string): boolean {
  return allowedExactPaths.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix));
}

async function readBuffer(
  request: import('node:http').IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('attachment upload exceeds configured size limit'), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readText(
  request: import('node:http').IncomingMessage,
  maxBytes: number
): Promise<string> {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method || '')) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('request body exceeds configured size limit'), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJsonBody(value: string | Buffer): unknown {
  const raw = typeof value === 'string' ? value : value.toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

function converactFabricHttpBodyMaxBytes(): number {
  const value = Number(resolveFabricEnv(process.env, 'HTTP_BODY_MAX_BYTES') || 1_048_576);
  if (!Number.isInteger(value) || value < 1 || value > 26_214_400) {
    throw new Error('CONVERACT_FABRIC_HTTP_BODY_MAX_BYTES is invalid');
  }
  return value;
}

function collaborationAttachmentMaxBytes(): number {
  const value = Number(resolveBrandEnv(process.env, 'COLLABORATION_ATTACHMENT_MAX_BYTES') || 26_214_400);
  if (!Number.isInteger(value) || value < 1 || value > 1_073_741_824) {
    throw new Error('CONVERACT_COLLABORATION_ATTACHMENT_MAX_BYTES is invalid');
  }
  return value;
}

function secureFileUploadMaxBytes(): number {
  const value = Number(resolveBrandEnv(process.env, 'SECURE_FILE_UPLOAD_MAX_BYTES') || 64 * 1024 * 1024);
  if (!Number.isInteger(value) || value < 1 || value > 512 * 1024 * 1024) {
    throw new Error('CONVERACT_SECURE_FILE_UPLOAD_MAX_BYTES is invalid');
  }
  return value;
}

function allowedCorsOrigins(): Set<string> {
  return new Set(
    String(resolveFabricEnv(process.env, 'ALLOWED_ORIGINS') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function requestHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string {
  const value = headers[name.toLowerCase()];
  return String(Array.isArray(value) ? value[0] || '' : value || '').trim();
}

function setCorsHeaders(response: import('node:http').ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,idempotency-key,x-api-key,x-content-sha256,x-tenant-id,x-upload-id,x-user-id'
  );
  response.setHeader(
    'access-control-expose-headers',
    'content-disposition,content-type,retry-after,x-content-sha256'
  );
  response.setHeader('access-control-max-age', '600');
  response.setHeader('vary', 'Origin');
}

function sendJson(
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown,
  headers: Record<string, string | number | readonly string[]> = {}
): void {
  send(response, status, JSON.stringify(data), 'application/json; charset=utf-8', headers);
}

async function send(
  response: import('node:http').ServerResponse,
  status: number,
  data: unknown,
  contentType: string,
  headers: Record<string, string | number | readonly string[]> = {}
): Promise<void> {
  response.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
    'content-type': contentType
  });
  if (!isAsyncIterable(data)) {
    response.end(data as string | Buffer | Uint8Array);
    return;
  }
  try {
    for await (const chunk of data) {
      if (!response.write(chunk)) {
        await new Promise<void>((resolve) => response.once('drain', resolve));
      }
    }
    response.end();
  } catch (error) {
    response.destroy(error as Error);
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return Boolean(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function isHeaderRecord(value: unknown): value is Record<string, string | number | readonly string[]> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(
    (header) => typeof header === 'string' || typeof header === 'number' || (
      Array.isArray(header) && header.every((item) => typeof item === 'string')
    )
  );
}
