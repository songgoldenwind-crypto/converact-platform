import type { PgQueryable } from '../../../db-pg.js';
import { resolveAuthContext, type AuthContext } from '../../../middleware/auth.js';
import { ContactCenterCallbackService } from './callback-service.js';
import { createPostgresContactCenterCallbackService } from './callback-runtime.js';
import { ContactCenterConfigurationService } from './configuration-service.js';
import { ContactCenterError } from './errors.js';
import { ContactCenterMonitorService } from './monitor-service.js';
import { PostgresContactCenterConfigurationUnitOfWork } from './postgres/configuration-unit-of-work.js';
import { PostgresContactCenterMonitorSource } from './postgres/monitor-source.js';
import { PostgresContactCenterUnitOfWork } from './postgres/unit-of-work.js';
import { ContactCenterQueueService } from './queue-service.js';
import type { ContactCenterSupervisorControlPort } from './ports.js';
import { UnsupportedContactCenterSupervisorControl } from './supervisor-control.js';
import { ContactCenterSupervisorService } from './supervisor-service.js';
import type {
  ContactCenterAgent,
  ContactCenterCallbackListInput,
  ContactCenterQueue,
  ContactCenterQueueEntryListInput,
  ContactCenterRoutingStrategy,
  ContactCenterSupervisorMode
} from './types.js';

type Headers = Record<string, string | string[] | undefined>;

export interface ContactCenterHttpModule {
  configuration: ContactCenterConfigurationService;
  queues: ContactCenterQueueService;
  callbacks: ContactCenterCallbackService;
  supervisor: ContactCenterSupervisorService;
  monitor: ContactCenterMonitorService;
}

export interface RouteIveKitContactCenterApiOptions {
  module?: ContactCenterHttpModule;
  create_module?: (
    pg: PgQueryable,
    tenantId: string
  ) => ContactCenterHttpModule | Promise<ContactCenterHttpModule>;
  supervisor_control?: ContactCenterSupervisorControlPort;
}

export async function routeIveKitContactCenterApi(
  pg: PgQueryable | null,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  _rawBody: string | Buffer = '',
  headers: Headers = {},
  options: RouteIveKitContactCenterApiOptions = {}
): Promise<unknown | undefined> {
  const routePath = path.split('?')[0];
  if (!routePath.startsWith('/api/ivekit/contact-center/')) return undefined;
  const context = requireContactCenterAuth(headers);
  rejectTenantOverride(context.tenantId, url, body);

  if (routePath === '/api/ivekit/contact-center/capabilities' && method === 'GET') {
    return { data: {
      api_version: 'v1', tenant_id: context.tenantId,
      capabilities: {
        agents: true, skills: true, presence: true, queues: true,
        memberships: true, skill_requirements: true, acd_routing: true,
        queue_entries: true,
        callbacks: true, overflow: true, queue_monitor: true,
        supervisor: supervisorAvailable(options.supervisor_control)
      }
    } };
  }

  const module = await resolveModule(pg, context.tenantId, options);

  if (routePath === '/api/ivekit/contact-center/monitor' && method === 'GET') {
    return { data: await module.monitor.snapshot({ tenant_id: context.tenantId }) };
  }

  if (routePath === '/api/ivekit/contact-center/supervisor/actions' && method === 'POST') {
    requireAdmin(context);
    const input = record(body);
    const action = requiredString(input.action);
    if (action === 'start') return { status: 201, data: await module.supervisor.start({
      tenant_id: context.tenantId,
      call_id: requiredString(input.call_id),
      target_agent_id: requiredString(input.target_agent_id),
      supervisor_identity: context.userId,
      mode: requiredString(input.mode) as ContactCenterSupervisorMode,
      authorization_ref: requiredString(input.authorization_ref),
      idempotency_key: idempotencyKey(headers)
    }) };
    if (action === 'end') return { data: await module.supervisor.end({
      tenant_id: context.tenantId,
      session_id: requiredString(input.session_id),
      supervisor_identity: context.userId,
      ...(input.reason === undefined ? {} : { reason: requiredString(input.reason) })
    }) };
    throw validation();
  }

  if (routePath === '/api/ivekit/contact-center/callbacks') {
    if (method === 'GET') return { data: await module.callbacks.list(callbackListInput(context.tenantId, url)) };
    if (method === 'POST') {
      requireOperator(context);
      const input = record(body);
      const address = record(input.address);
      return { status: 201, data: await module.callbacks.request({
        tenant_id: context.tenantId,
        queue_entry_id: requiredString(input.queue_entry_id),
        source_call_id: requiredString(input.source_call_id),
        address: {
          kind: requiredString(address.kind) as 'e164' | 'extension' | 'sip_uri',
          value: requiredString(address.value)
        },
        ...(input.scheduled_for === undefined
          ? {} : { scheduled_for: requiredString(input.scheduled_for) }),
        ...(input.max_attempts === undefined
          ? {} : { max_attempts: requiredInteger(input.max_attempts, 1, 20) }),
        actor: context.userId,
        idempotency_key: idempotencyKey(headers)
      }) };
    }
  }

  const callbackMatch = routePath.match(
    /^\/api\/ivekit\/contact-center\/callbacks\/([^/]+)(?:\/(cancel))?$/
  );
  if (callbackMatch) {
    const callbackId = decodeSegment(callbackMatch[1]!);
    const action = callbackMatch[2] || '';
    if (!action && method === 'GET') return {
      data: await module.callbacks.get(context.tenantId, callbackId)
    };
    if (action === 'cancel' && method === 'POST') {
      requireOperator(context);
      const input = record(body);
      return { data: await module.callbacks.cancel({
        tenant_id: context.tenantId,
        callback_id: callbackId,
        actor: context.userId,
        ...(input.reason === undefined ? {} : { reason: requiredString(input.reason) })
      }) };
    }
  }

  if (routePath === '/api/ivekit/contact-center/skills') {
    if (method === 'GET') return { data: await module.configuration.listSkills(
      listInput(context.tenantId, url)
    ) };
    if (method === 'POST') {
      requireAdmin(context);
      const input = record(body);
      return { status: 201, data: await module.configuration.createSkill({
        tenant_id: context.tenantId, actor: context.userId,
        idempotency_key: idempotencyKey(headers),
        name: requiredString(input.name), description: optionalString(input.description),
        ...(input.status === undefined ? {} : { status: input.status as ContactCenterAgent['status'] })
      }) };
    }
  }

  const skillMatch = routePath.match(/^\/api\/ivekit\/contact-center\/skills\/([^/]+)$/);
  if (skillMatch) {
    const skillId = decodeSegment(skillMatch[1]!);
    if (method === 'GET') return { data: await module.configuration.getSkill(context.tenantId, skillId) };
    if (method === 'PATCH') {
      requireAdmin(context);
      const input = record(body);
      return { data: await module.configuration.updateSkill({
        tenant_id: context.tenantId, actor: context.userId, skill_id: skillId,
        expected_revision: revision(input.revision), patch: record(input.patch) as never
      }) };
    }
  }

  if (routePath === '/api/ivekit/contact-center/agents') {
    if (method === 'GET') return { data: await module.configuration.listAgents(
      listInput(context.tenantId, url)
    ) };
    if (method === 'POST') {
      requireAdmin(context);
      const input = record(body);
      return { status: 201, data: await module.configuration.createAgent({
        tenant_id: context.tenantId, actor: context.userId,
        idempotency_key: idempotencyKey(headers),
        identity: requiredString(input.identity), display_name: optionalString(input.display_name),
        voice_extension_id: optionalNullableString(input.voice_extension_id),
        voice_capacity: optionalInteger(input.voice_capacity, 1, 10),
        metadata: optionalRecord(input.metadata),
        ...(input.status === undefined ? {} : { status: input.status as ContactCenterAgent['status'] })
      }) };
    }
  }

  const agentMatch = routePath.match(
    /^\/api\/ivekit\/contact-center\/agents\/([^/]+)(?:\/(presence|skills))?$/
  );
  if (agentMatch) {
    const agentId = decodeSegment(agentMatch[1]!);
    const action = agentMatch[2] || '';
    if (!action && method === 'GET') return {
      data: await module.configuration.getAgent(context.tenantId, agentId)
    };
    if (!action && method === 'PATCH') {
      requireAdmin(context);
      const input = record(body);
      return { data: await module.configuration.updateAgent({
        tenant_id: context.tenantId, actor: context.userId, agent_id: agentId,
        expected_revision: revision(input.revision), patch: record(input.patch) as never
      }) };
    }
    if (action === 'presence' && method === 'POST') {
      await requireSelfOrAdmin(context, module, agentId);
      const input = record(body);
      return { data: await module.configuration.updatePresence({
        tenant_id: context.tenantId, actor: context.userId, agent_id: agentId,
        state: requiredString(input.state) as 'available' | 'away' | 'offline',
        ...(input.session_ref === undefined ? {} : { session_ref: optionalString(input.session_ref) })
      }) };
    }
    if (action === 'skills' && method === 'GET') return {
      data: { items: (await module.configuration.getAgent(context.tenantId, agentId)).skills }
    };
    if (action === 'skills' && method === 'PUT') {
      requireAdmin(context);
      const input = record(body);
      return { data: { items: await module.configuration.setAgentSkills({
        tenant_id: context.tenantId, actor: context.userId, agent_id: agentId,
        skills: array(input.skills) as never
      }) } };
    }
  }

  if (routePath === '/api/ivekit/contact-center/queues') {
    if (method === 'GET') return { data: await module.configuration.listQueues(
      listInput(context.tenantId, url)
    ) };
    if (method === 'POST') {
      requireAdmin(context);
      const input = record(body);
      return { status: 201, data: await module.configuration.createQueue({
        tenant_id: context.tenantId, actor: context.userId, name: requiredString(input.name),
        idempotency_key: idempotencyKey(headers),
        routing_strategy: optionalString(input.routing_strategy) as ContactCenterRoutingStrategy || undefined,
        max_wait_seconds: optionalInteger(input.max_wait_seconds, 1, 86_400),
        max_size: optionalInteger(input.max_size, 1, 100_000),
        callback_after_seconds: optionalInteger(input.callback_after_seconds, 0, 86_400),
        overflow_action: optionalString(input.overflow_action) as ContactCenterQueue['overflow_action'] || undefined,
        overflow_queue_id: optionalNullableString(input.overflow_queue_id),
        overflow_target: optionalString(input.overflow_target),
        service_level_seconds: optionalInteger(input.service_level_seconds, 1, 3_600),
        metadata: optionalRecord(input.metadata),
        ...(input.status === undefined ? {} : { status: input.status as ContactCenterQueue['status'] })
      }) };
    }
  }

  const queueMatch = routePath.match(
    /^\/api\/ivekit\/contact-center\/queues\/([^/]+)(?:\/(memberships|skill-requirements|entries))?(?:\/([^/]+))?$/
  );
  if (queueMatch) {
    const queueId = decodeSegment(queueMatch[1]!);
    const action = queueMatch[2] || '';
    const childId = queueMatch[3] ? decodeSegment(queueMatch[3]) : '';
    if (!action && !childId && method === 'GET') return {
      data: await module.configuration.getQueue(context.tenantId, queueId)
    };
    if (!action && !childId && method === 'PATCH') {
      requireAdmin(context);
      const input = record(body);
      return { data: await module.configuration.updateQueue({
        tenant_id: context.tenantId, actor: context.userId, queue_id: queueId,
        expected_revision: revision(input.revision), patch: record(input.patch) as never
      }) };
    }
    if (action === 'memberships' && !childId && method === 'GET') return {
      data: { items: (await module.configuration.getQueue(context.tenantId, queueId)).memberships }
    };
    if (action === 'memberships' && !childId && method === 'POST') {
      requireAdmin(context);
      const input = record(body);
      return { data: await module.configuration.upsertMembership({
        tenant_id: context.tenantId, actor: context.userId, queue_id: queueId,
        agent_id: requiredString(input.agent_id),
        priority: optionalInteger(input.priority, -100, 100),
        enabled: optionalBoolean(input.enabled)
      }) };
    }
    if (action === 'memberships' && childId && method === 'DELETE') {
      requireAdmin(context);
      return { data: { removed: await module.configuration.removeMembership({
        tenant_id: context.tenantId, actor: context.userId,
        queue_id: queueId, agent_id: childId
      }) } };
    }
    if (action === 'skill-requirements' && !childId && method === 'GET') return {
      data: { items: (await module.configuration.getQueue(context.tenantId, queueId)).skill_requirements }
    };
    if (action === 'skill-requirements' && !childId && method === 'PUT') {
      requireAdmin(context);
      const input = record(body);
      return { data: { items: await module.configuration.setQueueSkillRequirements({
        tenant_id: context.tenantId, actor: context.userId, queue_id: queueId,
        requirements: array(input.requirements) as never
      }) } };
    }
    if (action === 'entries' && !childId && method === 'GET') return {
      data: await module.queues.listQueueEntries(queueEntryListInput(context.tenantId, queueId, url))
    };
  }

  if (routePath === '/api/ivekit/contact-center/routing/assignments' && method === 'POST') {
    requireOperator(context);
    const input = record(body);
    const result = await module.queues.offerNext({
      tenant_id: context.tenantId, queue_id: requiredString(input.queue_id),
      idempotency_key: idempotencyKey(headers),
      offer_ttl_seconds: requiredInteger(input.offer_ttl_seconds, 1, 300)
    });
    return { status: result ? 201 : 204, ...(result ? { data: result } : {}) };
  }

  const assignmentMatch = routePath.match(
    /^\/api\/ivekit\/contact-center\/assignments\/([^/]+)\/(accept|reject|connect|complete)$/
  );
  if (assignmentMatch && method === 'POST') {
    requireOperator(context);
    const assignmentId = decodeSegment(assignmentMatch[1]!);
    const action = assignmentMatch[2]!;
    const input = record(body);
    const agentId = await actionAgentId(module, context, input);
    if (action === 'accept') return { data: await module.queues.acceptOffer({
      tenant_id: context.tenantId, assignment_id: assignmentId, agent_id: agentId
    }) };
    if (action === 'reject') return { data: await module.queues.rejectOffer({
      tenant_id: context.tenantId, assignment_id: assignmentId, agent_id: agentId,
      reason: optionalString(input.reason)
    }) };
    if (action === 'connect') return { data: await module.queues.connectAssignment({
      tenant_id: context.tenantId, assignment_id: assignmentId, agent_id: agentId
    }) };
    return { data: await module.queues.completeAssignment({
      tenant_id: context.tenantId, assignment_id: assignmentId, agent_id: agentId
    }) };
  }

  return undefined;
}

export function createPostgresContactCenterHttpModule(
  pg: PgQueryable,
  options: { supervisor_control?: ContactCenterSupervisorControlPort } = {}
): ContactCenterHttpModule {
  const unitOfWork = new PostgresContactCenterUnitOfWork(pg);
  return {
    configuration: new ContactCenterConfigurationService(
      new PostgresContactCenterConfigurationUnitOfWork(pg)
    ),
    queues: new ContactCenterQueueService(unitOfWork),
    callbacks: createPostgresContactCenterCallbackService(pg),
    monitor: new ContactCenterMonitorService(new PostgresContactCenterMonitorSource(pg)),
    supervisor: new ContactCenterSupervisorService({
      unit_of_work: unitOfWork,
      control: options.supervisor_control ?? new UnsupportedContactCenterSupervisorControl()
    })
  };
}

async function resolveModule(
  pg: PgQueryable | null,
  tenantId: string,
  options: RouteIveKitContactCenterApiOptions
): Promise<ContactCenterHttpModule> {
  if (options.module) return options.module;
  if (!pg) throw new ContactCenterError({ code: 'conflict', status: 503, details: { reason: 'postgres_unavailable' } });
  return await options.create_module?.(pg, tenantId) ?? createPostgresContactCenterHttpModule(pg, {
    ...(options.supervisor_control ? { supervisor_control: options.supervisor_control } : {})
  });
}

function supervisorAvailable(control: ContactCenterSupervisorControlPort | undefined): boolean {
  return Boolean(control && (['monitor', 'whisper', 'barge'] as const).some((mode) =>
    control.supports(mode)
  ));
}

async function requireSelfOrAdmin(
  context: AuthContext,
  module: ContactCenterHttpModule,
  agentId: string
): Promise<void> {
  if (['owner', 'admin', 'system'].includes(context.role)) return;
  const agent = await module.configuration.getAgent(context.tenantId, agentId);
  if (agent.agent.identity !== context.userId) {
    throw new ContactCenterError({ code: 'not_found', status: 404 });
  }
}

async function actionAgentId(
  module: ContactCenterHttpModule,
  context: AuthContext,
  body: Record<string, unknown>
): Promise<string> {
  if (['owner', 'admin', 'system'].includes(context.role) && body.agent_id !== undefined) {
    return (await module.configuration.getAgent(
      context.tenantId, requiredString(body.agent_id)
    )).agent.id;
  }
  return (await module.configuration.getAgentByIdentity(
    context.tenantId, context.userId
  )).agent.id;
}

function requireContactCenterAuth(headers: Headers): AuthContext {
  let context: AuthContext;
  try { context = resolveAuthContext(headers); } catch {
    throw new ContactCenterError({ code: 'validation_failed', status: 401 });
  }
  if (!context.authenticated || !context.tenantId || !context.userId ||
    (context.role === 'system' && context.tenantId === 'system')) {
    throw new ContactCenterError({ code: 'validation_failed', status: 401 });
  }
  return context;
}

function requireAdmin(context: AuthContext): void {
  if (!['owner', 'admin', 'system'].includes(context.role)) {
    throw new ContactCenterError({ code: 'conflict', status: 403, details: { reason: 'forbidden' } });
  }
}

function requireOperator(context: AuthContext): void {
  if (context.role === 'viewer') {
    throw new ContactCenterError({ code: 'conflict', status: 403, details: { reason: 'forbidden' } });
  }
}

function rejectTenantOverride(tenantId: string, url: URL, body: unknown): void {
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const queryTenant = url.searchParams.get('tenant_id') ?? '';
  const bodyTenant = typeof input.tenant_id === 'string' ? input.tenant_id.trim() : '';
  if ((queryTenant && queryTenant !== tenantId) || (bodyTenant && bodyTenant !== tenantId)) {
    throw validation();
  }
}

function listInput(tenantId: string, url: URL): {
  tenant_id: string;
  limit: number;
  cursor?: string;
  status?: string;
} {
  const limit = optionalInteger(url.searchParams.get('limit') || undefined, 1, 200) ?? 50;
  const cursor = url.searchParams.get('cursor') || '';
  if (cursor.length > 2_000 || /[\u0000-\u001f\u007f]/.test(cursor)) throw validation();
  const status = url.searchParams.get('status') || '';
  return {
    tenant_id: tenantId, limit,
    ...(cursor ? { cursor } : {}),
    ...(status ? { status } : {})
  };
}

function queueEntryListInput(
  tenantId: string,
  queueId: string,
  url: URL
): ContactCenterQueueEntryListInput {
  const input = listInput(tenantId, url);
  const state = url.searchParams.get('state') || '';
  return {
    tenant_id: tenantId,
    queue_id: queueId,
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(state ? { state: state as ContactCenterQueueEntryListInput['state'] } : {})
  };
}

function callbackListInput(
  tenantId: string,
  url: URL
): ContactCenterCallbackListInput {
  const input = listInput(tenantId, url);
  const queueId = url.searchParams.get('queue_id') || '';
  const state = url.searchParams.get('state') || '';
  return {
    tenant_id: tenantId,
    limit: input.limit,
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(queueId ? { queue_id: queueId } : {}),
    ...(state ? { state: state as ContactCenterCallbackListInput['state'] } : {})
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw validation();
  return value;
}

function requiredString(value: unknown): string {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output || output.length > 2_000 || /[\u0000-\u001f\u007f]/.test(output)) throw validation();
  return output;
}

function optionalString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 2_000 || /[\u0000-\u001f\u007f]/.test(value)) throw validation();
  return value.trim();
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return requiredString(value);
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : record(value);
}

function requiredInteger(value: unknown, minimum: number, maximum: number): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) throw validation();
  return output;
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : requiredInteger(value, minimum, maximum);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw validation();
  return value;
}

function revision(value: unknown): number {
  return requiredInteger(value, 1, Number.MAX_SAFE_INTEGER);
}

function idempotencyKey(headers: Headers): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'idempotency-key');
  const value = Array.isArray(entry?.[1]) ? entry?.[1][0] : entry?.[1];
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(value)) throw validation();
  return value;
}

function decodeSegment(value: string): string {
  try { return requiredString(decodeURIComponent(value)); } catch { throw validation(); }
}

function validation(): ContactCenterError {
  return new ContactCenterError({ code: 'validation_failed', status: 422 });
}
