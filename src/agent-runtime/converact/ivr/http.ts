import { resolveFabricEnv } from '../../../config/converact-env.js';
import type { PgQueryable } from '../../../db-pg.js';
import { wsBroadcast } from '../../../ws.js';
import { resolveAuthContext, type AuthContext } from '../../../middleware/auth.js';
import { VoiceError } from '../voice/errors.js';
import type { VoiceSecretResolver } from '../voice/ports.js';
import { EnvVoiceSecretResolver } from '../voice/secret-resolver.js';
import {
  PostgresVoiceProfileContextResolver,
  VoiceWebhookAuthenticator
} from '../voice/webhook-auth.js';
import { PostgresRustPbxStepIvrBindingResolver } from './postgres/rustpbx-step-binding.js';
import { PostgresIvrFlowStore } from './postgres/flow-store.js';
import {
  PostgresIvrSessionStepStore,
  PostgresIvrSessionStore
} from './postgres/session-store.js';
import {
  PostgresIvrFlowUnitOfWork,
  PostgresIvrResourceUnitOfWork,
  PostgresIvrSessionUnitOfWork
} from './postgres/unit-of-work.js';
import { IvrFlowService } from './flow-service.js';
import { IvrError } from './errors.js';
import {
  emitIvrSessionEvents,
  projectIvrSessionEvents,
  type IvrSessionEvent,
  type IvrSessionEventPublisher
} from './events.js';
import {
  IveKitTenantEventStore,
  iveKitEventReplayEnabled
} from '../tenant-event-store.js';
import { IvrSimulationService } from './simulation.js';
import type { IvrFlowGraph } from './graph-types.js';
import {
  RustPbxStepIvrService,
  type RustPbxStepIvrHandleInput,
  type RustPbxStepIvrHandleResult
} from './rustpbx-step-service.js';
import { IvrSessionService } from './session-service.js';
import { IvrResourceService } from './resource-service.js';

type Headers = Record<string, string | string[] | undefined>;

export interface RustPbxStepIvrHttpService {
  handle(input: RustPbxStepIvrHandleInput): Promise<RustPbxStepIvrHandleResult>;
}

export interface RouteIveKitIvrApiOptions {
  step_service?: RustPbxStepIvrHttpService;
  create_step_service?: (pg: PgQueryable, tenantId: string) => RustPbxStepIvrHttpService;
  webhook_authenticator?: Pick<VoiceWebhookAuthenticator, 'authenticate'>;
  secret_resolver?: VoiceSecretResolver;
  worker_poll_interval_ms?: number;
  module?: IvrHttpModule;
  create_module?: (pg: PgQueryable, tenantId: string) => IvrHttpModule | Promise<IvrHttpModule>;
  event_store?: Pick<IveKitTenantEventStore, 'append'>;
  publish?: IvrSessionEventPublisher;
}

export interface IvrHttpModule {
  flows: IvrFlowService;
  flow_store: PostgresIvrFlowStore;
  sessions: IvrSessionService;
  session_store: PostgresIvrSessionStore;
  step_store: PostgresIvrSessionStepStore;
  simulations: IvrSimulationService;
  resources: IvrResourceService;
}

export async function routeIveKitIvrApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  _url: URL,
  body: unknown,
  rawBody: string | Buffer = '',
  headers: Headers = {},
  options: RouteIveKitIvrApiOptions = {}
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/ivekit/ivr/')) return undefined;
  const match = path.match(
    /^\/api\/ivekit\/ivr\/provider-webhooks\/rustpbx\/([^/]+)\/step$/
  );
  if (match && method === 'POST') {
    return routeStepWebhook(pg, match[1]!, body, rawBody, headers, options);
  }
  if (match) return undefined;
  const ctx = requireIvrAuth(headers);
  rejectTenantOverride(ctx.tenantId, _url, body);
  const module = options.module ?? await options.create_module?.(requiredPg(pg), ctx.tenantId)
    ?? createPostgresIvrHttpModule(requiredPg(pg));
  const segments = path.split('/').filter(Boolean);

  const resourceResult = await routeResources(method, path, segments, body, ctx, module);
  if (resourceResult !== undefined) return resourceResult;

  if (path === '/api/ivekit/ivr/flows') {
    if (method === 'GET') return { data: { items: await module.flow_store.listFlows(ctx.tenantId) } };
    if (method === 'POST') {
      requireAdmin(ctx);
      const input = record(body);
      return { status: 201, data: await module.flows.createFlow({
        tenant_id: ctx.tenantId, actor: ctx.userId,
        name: stringValue(input.name), graph: graphValue(input.graph),
        metadata: optionalRecord(input.metadata)
      }) };
    }
  }
  const flowId = segments[4] ? decodeSegment(segments[4]) : '';
  if (segments.length === 5 && segments[3] === 'flows') {
    if (method === 'GET') return { data: required(await module.flow_store.getFlow(ctx.tenantId, flowId)) };
    if (method === 'PATCH') {
      requireAdmin(ctx);
      const input = record(body);
      return { data: await module.flows.updateDraft({
        tenant_id: ctx.tenantId, actor: ctx.userId, flow_id: flowId,
        expected_revision: positiveInteger(input.expected_revision),
        ...(input.name === undefined ? {} : { name: stringValue(input.name) }),
        ...(input.graph === undefined ? {} : { graph: graphValue(input.graph) }),
        ...(input.metadata === undefined ? {} : { metadata: record(input.metadata) })
      }) };
    }
  }
  if (segments.length === 6 && segments[3] === 'flows') {
    const action = segments[5];
    if (action === 'versions' && method === 'GET') {
      return { data: { items: await module.flow_store.listVersions(ctx.tenantId, flowId) } };
    }
    if (action === 'validate' && method === 'POST') {
      return { data: await module.flows.validate({ tenant_id: ctx.tenantId, flow_id: flowId }) };
    }
    if (action === 'publish' && method === 'POST') {
      requireAdmin(ctx);
      const input = record(body);
      return { data: await module.flows.publish({
        tenant_id: ctx.tenantId, actor: ctx.userId, flow_id: flowId,
        expected_draft_revision: positiveInteger(input.expected_draft_revision),
        idempotency_key: idempotencyKey(headers)
      }) };
    }
    if (action === 'rollback' && method === 'POST') {
      requireAdmin(ctx);
      const input = record(body);
      return { data: await module.flows.rollback({
        tenant_id: ctx.tenantId, actor: ctx.userId, flow_id: flowId,
        expected_draft_revision: positiveInteger(input.expected_draft_revision),
        source_version: positiveInteger(input.source_version),
        idempotency_key: idempotencyKey(headers)
      }) };
    }
  }
  if (path === '/api/ivekit/ivr/simulations' && method === 'POST') {
    const input = record(body);
    return { data: await module.simulations.simulate({
      tenant_id: ctx.tenantId, flow_id: stringValue(input.flow_id),
      flow_version: optionalPositiveInteger(input.flow_version),
      variables: optionalRecord(input.variables),
      started_at: optionalString(input.started_at),
      script: input.script as never,
      max_actions: optionalPositiveInteger(input.max_actions),
      max_steps: optionalPositiveInteger(input.max_steps)
    }) };
  }
  if (path === '/api/ivekit/ivr/sessions') {
    requireOperator(ctx);
    if (method === 'GET') return { data: { items: await module.session_store.list(
      ctx.tenantId, listLimit(_url)
    ) } };
    if (method === 'POST') {
      const input = record(body);
      const result = await module.sessions.startSession({
        tenant_id: ctx.tenantId, call_id: stringValue(input.call_id),
        flow_id: stringValue(input.flow_id), flow_version: optionalPositiveInteger(input.flow_version),
        variables: optionalRecord(input.variables), trace_id: optionalString(input.trace_id)
      });
      const events = projectIvrSessionEvents(result, { started: !result.replayed });
      return sessionResponse(requiredPg(pg), options, result.replayed ? 200 : 201, result, events);
    }
  }
  const sessionId = segments[4] ? decodeSegment(segments[4]) : '';
  if (segments[3] === 'sessions' && segments.length === 5 && method === 'GET') {
    requireOperator(ctx);
    const session = required(await module.session_store.get(ctx.tenantId, sessionId));
    return { data: { session, steps: await module.step_store.list(ctx.tenantId, sessionId) } };
  }
  if (segments[3] === 'sessions' && segments[5] === 'advance' && method === 'POST') {
    requireOperator(ctx);
    const input = record(body);
    const result = await module.sessions.advance({
      tenant_id: ctx.tenantId, session_id: sessionId,
      event_sequence: nonNegativeInteger(input.event_sequence),
      action_revision: nonNegativeInteger(input.action_revision),
      event: record(input.event) as never
    });
    return sessionResponse(requiredPg(pg), options, 200, result, projectIvrSessionEvents(result));
  }
  return undefined;
}

async function routeStepWebhook(
  pg: PgQueryable | null,
  profileSegment: string,
  body: unknown,
  rawBody: string | Buffer,
  headers: Headers,
  options: RouteIveKitIvrApiOptions
): Promise<unknown> {
  const required = requiredPg(pg);
  const profileId = decodeSegment(profileSegment);
  const authenticator = options.webhook_authenticator ?? new VoiceWebhookAuthenticator({
    context_resolver: new PostgresVoiceProfileContextResolver(required),
    secret_resolver: options.secret_resolver ?? configuredSecretResolver()
  });
  const authenticated = await authenticator.authenticate({
    profile_id: profileId, raw_body: rawBody, headers
  });
  if (authenticated.adapter !== 'rustpbx' || authenticated.profile_id !== profileId) {
    throw new VoiceError({ code: 'webhook_auth_failed', status: 401 });
  }
  const service = options.step_service
    ?? options.create_step_service?.(required, authenticated.tenant_id)
    ?? new RustPbxStepIvrService({
      sessions: new IvrSessionService({
        unit_of_work: new PostgresIvrSessionUnitOfWork(required)
      }),
      bindings: new PostgresRustPbxStepIvrBindingResolver(required),
      worker_poll_interval_ms: options.worker_poll_interval_ms
    });
  const result = await service.handle({
    tenant_id: authenticated.tenant_id,
    profile_id: authenticated.profile_id,
    request: body
  });
  return {
    data: result.action_node,
    headers: {
      'x-ivekit-ivr-session-id': result.session_id,
      'x-ivekit-ivr-session-state': result.session_state,
      'x-ivekit-ivr-replayed': String(result.replayed),
      'x-ivekit-ivr-event-sequence': String(result.event_sequence),
      'x-ivekit-ivr-action-revision': String(result.action_revision)
    },
    ...(result.events?.length ? {
      afterCommit: () => publishSessionEvents(required, options, result.events!)
    } : {})
  };
}

function sessionResponse(
  pg: PgQueryable,
  options: RouteIveKitIvrApiOptions,
  status: number,
  data: unknown,
  events: IvrSessionEvent[]
): Record<string, unknown> {
  return {
    status,
    data,
    ...(events.length ? { afterCommit: () => publishSessionEvents(pg, options, events) } : {})
  };
}

async function publishSessionEvents(
  pg: PgQueryable,
  options: RouteIveKitIvrApiOptions,
  events: readonly IvrSessionEvent[]
): Promise<void> {
  const store = options.event_store ?? (
    iveKitEventReplayEnabled() ? new IveKitTenantEventStore(pg) : null
  );
  const publish = options.publish ?? wsBroadcast;
  await emitIvrSessionEvents(events, async (tenantId, type, data) => {
    if (store) await store.append({ tenant_id: tenantId, type, data });
    await Promise.resolve(publish(tenantId, type, data));
  });
}

export function createPostgresIvrHttpModule(pg: PgQueryable): IvrHttpModule {
  const flowStore = new PostgresIvrFlowStore(pg);
  return {
    flows: new IvrFlowService({ unit_of_work: new PostgresIvrFlowUnitOfWork(pg) }),
    flow_store: flowStore,
    sessions: new IvrSessionService({ unit_of_work: new PostgresIvrSessionUnitOfWork(pg) }),
    session_store: new PostgresIvrSessionStore(pg),
    step_store: new PostgresIvrSessionStepStore(pg),
    simulations: new IvrSimulationService({ flows: flowStore }),
    resources: new IvrResourceService({ unit_of_work: new PostgresIvrResourceUnitOfWork(pg) })
  };
}

async function routeResources(
  method: string,
  path: string,
  segments: string[],
  body: unknown,
  context: AuthContext,
  module: IvrHttpModule
): Promise<unknown | undefined> {
  if (path === '/api/ivekit/ivr/settings') {
    if (method === 'GET') return { data: await module.resources.getSettings(context.tenantId) };
    if (method === 'PATCH') {
      requireAdmin(context);
      return { data: await module.resources.updateSettings(resourceInput(body, context) as never) };
    }
    return undefined;
  }
  const collections = new Set(['audio-assets', 'time-groups', 'region-groups', 'ring-groups']);
  const collection = segments[3] ?? '';
  if (!collections.has(collection)) return undefined;
  if (segments.length === 4) {
    if (method === 'GET') {
      if (collection === 'audio-assets') return { data: { items: await module.resources.listAudioAssets(context.tenantId) } };
      if (collection === 'time-groups') return { data: { items: await module.resources.listTimeGroups(context.tenantId) } };
      if (collection === 'region-groups') return { data: { items: await module.resources.listRegionGroups(context.tenantId) } };
      return { data: { items: await module.resources.listRingGroups(context.tenantId) } };
    }
    if (method === 'POST') {
      requireAdmin(context);
      const input = resourceInput(body, context);
      if (collection === 'audio-assets') return { status: 201, data: await module.resources.createAudioAsset(input as never) };
      if (collection === 'time-groups') return { status: 201, data: await module.resources.createTimeGroup(input as never) };
      if (collection === 'region-groups') return { status: 201, data: await module.resources.createRegionGroup(input as never) };
      return { status: 201, data: await module.resources.createRingGroup(input as never) };
    }
    return undefined;
  }
  if (segments.length !== 5) return undefined;
  const id = decodeSegment(segments[4]!);
  if (method === 'GET') {
    if (collection === 'audio-assets') return { data: await module.resources.getAudioAsset(context.tenantId, id) };
    if (collection === 'time-groups') return { data: await module.resources.getTimeGroup(context.tenantId, id) };
    if (collection === 'region-groups') return { data: await module.resources.getRegionGroup(context.tenantId, id) };
    return { data: await module.resources.getRingGroup(context.tenantId, id) };
  }
  if (method === 'PATCH') {
    requireAdmin(context);
    const input = { ...resourceInput(body, context), id };
    if (collection === 'audio-assets') return { data: await module.resources.updateAudioAsset(input as never) };
    if (collection === 'time-groups') return { data: await module.resources.updateTimeGroup(input as never) };
    if (collection === 'region-groups') return { data: await module.resources.updateRegionGroup(input as never) };
    return { data: await module.resources.updateRingGroup(input as never) };
  }
  return undefined;
}

function resourceInput(body: unknown, context: AuthContext): Record<string, unknown> {
  return { ...record(body), tenant_id: context.tenantId, actor: context.userId };
}

function requireIvrAuth(headers: Headers): AuthContext {
  let context: AuthContext;
  try { context = resolveAuthContext(headers); } catch {
    throw new IvrError({ code: 'validation_failed', status: 401 });
  }
  if (!context.authenticated || !context.tenantId || !context.userId
    || (context.role === 'system' && context.tenantId === 'system')) {
    throw new IvrError({ code: 'validation_failed', status: 401 });
  }
  return context;
}

function requireAdmin(context: AuthContext): void {
  if (!['owner', 'admin', 'system'].includes(context.role)) {
    throw new IvrError({ code: 'capability_unavailable', status: 403 });
  }
}

function requireOperator(context: AuthContext): void {
  if (context.role === 'viewer') throw new IvrError({ code: 'capability_unavailable', status: 403 });
}

function rejectTenantOverride(tenantId: string, url: URL, body: unknown): void {
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const queryTenant = url.searchParams.get('tenant_id') ?? '';
  const bodyTenant = typeof input.tenant_id === 'string' ? input.tenant_id.trim() : '';
  if ((queryTenant && queryTenant !== tenantId) || (bodyTenant && bodyTenant !== tenantId)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : record(value);
}

function graphValue(value: unknown): IvrFlowGraph {
  return record(value) as unknown as IvrFlowGraph;
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : stringValue(value);
}

function positiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return Number(value);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : positiveInteger(value);
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return Number(value);
}

function idempotencyKey(headers: Headers): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'idempotency-key') continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  throw new IvrError({ code: 'validation_failed', status: 422 });
}

function listLimit(url: URL): number {
  const value = url.searchParams.get('limit');
  if (!value) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return parsed;
}

function required<T>(value: T | null): T {
  if (value === null) throw new IvrError({ code: 'not_found', status: 404 });
  return value;
}

function configuredSecretResolver(): VoiceSecretResolver {
  const configured = String(resolveFabricEnv(process.env, 'VOICE_WEBHOOK_SECRET_ENV_NAMES') || '')
    .split(',').map((value) => value.trim()).filter((value) => /^[A-Z][A-Z0-9_]*$/.test(value));
  const names = [...new Set([
    'RUSTPBX_WEBHOOK_HMAC', 'RUSTPBX_WEBHOOK_SERVICE_KEY',
    'CONVERACT_FABRIC_VOICE_WEBHOOK_HMAC', 'CONVERACT_FABRIC_VOICE_WEBHOOK_SERVICE_KEY',
    ...configured
  ])];
  return new EnvVoiceSecretResolver({
    allowlist: { webhook_hmac: names, webhook_service_key: names }
  });
}

function requiredPg(pg: PgQueryable | null): PgQueryable {
  if (!pg) throw new VoiceError({ code: 'provider_unavailable', retryable: true, status: 503 });
  return pg;
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(decoded)) throw new Error();
    return decoded;
  } catch {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
}
