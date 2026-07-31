import { randomUUID } from 'node:crypto';

import { canonicalContactCenterPayloadHash } from './canonical.js';
import type {
  ContactCenterConfigurationRepository,
  ContactCenterConfigurationUnitOfWork
} from './configuration-ports.js';
import { ContactCenterError } from './errors.js';
import { transitionPresence } from './state-machine.js';
import type {
  ContactCenterAgent,
  ContactCenterAgentSkill,
  ContactCenterAgentSnapshot,
  ContactCenterConfigurationIdempotencyRecord,
  ContactCenterListInput,
  ContactCenterPage,
  ContactCenterPresenceState,
  ContactCenterQueue,
  ContactCenterQueueConfiguration,
  ContactCenterQueueMembership,
  ContactCenterRoutingStrategy,
  ContactCenterSkill,
  ContactCenterSkillRequirement
} from './types.js';

interface ActorInput {
  tenant_id: string;
  actor: string;
}

export class ContactCenterConfigurationService {
  readonly #unitOfWork: ContactCenterConfigurationUnitOfWork;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(
    unitOfWork: ContactCenterConfigurationUnitOfWork,
    options: { id?: () => string; now?: () => Date } = {}
  ) {
    this.#unitOfWork = unitOfWork;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async createSkill(input: ActorInput & {
    idempotency_key: string;
    name: string;
    description?: string;
    status?: ContactCenterSkill['status'];
  }): Promise<ContactCenterSkill> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const actor = identifier(input.actor, 'actor');
    const key = idempotencyKey(input.idempotency_key);
    const now = this.#timestamp();
    const skill: ContactCenterSkill = {
      id: this.#id(), tenant_id: tenantId, name: name(input.name),
      description: text(input.description ?? '', 2_000), status: status(input.status ?? 'active'),
      revision: 1, created_by: actor, updated_by: actor, created_at: now, updated_at: now
    };
    const payloadHash = canonicalContactCenterPayloadHash({
      resource_type: 'skill', name: skill.name, description: skill.description, status: skill.status
    });
    return this.#unitOfWork.run(tenantId, async (repository) => {
      await repository.lockIdempotencyKey(tenantId, key);
      const replay = await repository.findIdempotencyRecord(tenantId, key);
      if (replay) {
        assertIdempotencyRecord(replay, 'skill', payloadHash);
        return required(await repository.getSkill(tenantId, replay.resource_id), 'skill');
      }
      const created = await repository.insertSkill(skill);
      await repository.insertIdempotencyRecord({
        tenant_id: tenantId, idempotency_key: key, resource_type: 'skill',
        payload_hash: payloadHash, resource_id: created.id, created_at: now
      });
      return created;
    });
  }

  async updateSkill(input: ActorInput & {
    skill_id: string;
    expected_revision: number;
    patch: Partial<Pick<ContactCenterSkill, 'name' | 'description' | 'status'>>;
  }): Promise<ContactCenterSkill> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const current = required(await repository.getSkill(
        tenantId, identifier(input.skill_id, 'skill_id'), { for_update: true }
      ), 'skill');
      revision(current.revision, input.expected_revision);
      const patch = definedPatch(input.patch, ['name', 'description', 'status']);
      return repository.updateSkill({
        ...current, ...patch,
        name: name(patch.name ?? current.name),
        description: text(patch.description ?? current.description, 2_000),
        status: status(patch.status ?? current.status),
        revision: current.revision + 1,
        updated_by: identifier(input.actor, 'actor'), updated_at: this.#timestamp()
      }, current.revision);
    });
  }

  async listSkills(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterSkill>> {
    const query = listInput(input);
    return this.#unitOfWork.run(query.tenant_id, (repository) => repository.listSkills(query));
  }

  async getSkill(tenantId: string, skillId: string): Promise<ContactCenterSkill> {
    const tenant = identifier(tenantId, 'tenant_id');
    return this.#unitOfWork.run(tenant, async (repository) => required(
      await repository.getSkill(tenant, identifier(skillId, 'skill_id')), 'skill'
    ));
  }

  async createAgent(input: ActorInput & {
    idempotency_key: string;
    identity: string;
    display_name?: string;
    voice_extension_id?: string | null;
    voice_capacity?: number;
    metadata?: Record<string, unknown>;
    status?: ContactCenterAgent['status'];
  }): Promise<ContactCenterAgentSnapshot> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const actor = identifier(input.actor, 'actor');
    const key = idempotencyKey(input.idempotency_key);
    const now = this.#timestamp();
    const agent: ContactCenterAgent = {
      id: this.#id(), tenant_id: tenantId, identity: identity(input.identity),
      display_name: text(input.display_name ?? '', 200),
      voice_extension_id: nullableIdentifier(input.voice_extension_id, 'voice_extension_id'),
      status: status(input.status ?? 'active'),
      voice_capacity: integer(input.voice_capacity ?? 1, 1, 10, 'voice_capacity'),
      metadata: safeMetadata(input.metadata ?? {}), revision: 1,
      created_by: actor, updated_by: actor, created_at: now, updated_at: now
    };
    const presence = {
      tenant_id: tenantId, agent_id: agent.id, state: 'offline' as const,
      active_voice_count: 0, voice_capacity: agent.voice_capacity, current_call_id: null,
      idle_since: null, heartbeat_at: null, session_ref: '', revision: 1, updated_at: now
    };
    const payloadHash = canonicalContactCenterPayloadHash({
      resource_type: 'agent', identity: agent.identity, display_name: agent.display_name,
      voice_extension_id: agent.voice_extension_id, status: agent.status,
      voice_capacity: agent.voice_capacity, metadata: agent.metadata
    });
    return this.#unitOfWork.run(tenantId, async (repository) => {
      await repository.lockIdempotencyKey(tenantId, key);
      const replay = await repository.findIdempotencyRecord(tenantId, key);
      if (replay) {
        assertIdempotencyRecord(replay, 'agent', payloadHash);
        const replayedAgent = required(await repository.getAgent(tenantId, replay.resource_id), 'agent');
        return {
          agent: replayedAgent,
          presence: required(await repository.getPresence(tenantId, replayedAgent.id), 'agent_presence'),
          skills: await repository.listAgentSkills(tenantId, replayedAgent.id)
        };
      }
      const created = await repository.insertAgent(agent, presence);
      await repository.insertIdempotencyRecord({
        tenant_id: tenantId, idempotency_key: key, resource_type: 'agent',
        payload_hash: payloadHash, resource_id: created.id, created_at: now
      });
      return { agent: created, presence, skills: [] };
    });
  }

  async updateAgent(input: ActorInput & {
    agent_id: string;
    expected_revision: number;
    patch: Partial<Pick<ContactCenterAgent,
      'identity' | 'display_name' | 'voice_extension_id' | 'status' | 'voice_capacity' | 'metadata'>>;
  }): Promise<ContactCenterAgentSnapshot> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const agentId = identifier(input.agent_id, 'agent_id');
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const current = required(await repository.getAgent(tenantId, agentId, { for_update: true }), 'agent');
      const presence = required(await repository.getPresence(tenantId, agentId, { for_update: true }), 'agent_presence');
      revision(current.revision, input.expected_revision);
      const patch = definedPatch(input.patch, [
        'identity', 'display_name', 'voice_extension_id', 'status', 'voice_capacity', 'metadata'
      ]);
      const next: ContactCenterAgent = {
        ...current, ...patch,
        identity: identity(patch.identity ?? current.identity),
        display_name: text(patch.display_name ?? current.display_name, 200),
        voice_extension_id: patch.voice_extension_id === undefined
          ? current.voice_extension_id
          : nullableIdentifier(patch.voice_extension_id, 'voice_extension_id'),
        status: status(patch.status ?? current.status),
        voice_capacity: integer(patch.voice_capacity ?? current.voice_capacity, 1, 10, 'voice_capacity'),
        metadata: safeMetadata(patch.metadata ?? current.metadata),
        revision: current.revision + 1,
        updated_by: identifier(input.actor, 'actor'), updated_at: this.#timestamp()
      };
      if (next.voice_capacity < presence.active_voice_count) throw conflict('active_capacity');
      if (next.status !== 'active' && presence.active_voice_count > 0) throw conflict('agent_has_active_work');
      const updated = await repository.updateAgent(next, current.revision);
      let nextPresence = presence;
      if (next.voice_capacity !== presence.voice_capacity || next.status !== current.status) {
        const targetState = next.status === 'active' ? presence.state : 'offline';
        nextPresence = await repository.updatePresence({
          ...presence, state: targetState, voice_capacity: next.voice_capacity,
          idle_since: targetState === 'available' ? presence.idle_since : null,
          session_ref: targetState === 'offline' ? '' : presence.session_ref,
          revision: presence.revision + 1, updated_at: next.updated_at
        }, presence.revision);
      }
      return {
        agent: updated,
        presence: nextPresence,
        skills: await repository.listAgentSkills(tenantId, agentId)
      };
    });
  }

  async getAgent(tenantId: string, agentId: string): Promise<ContactCenterAgentSnapshot> {
    const tenant = identifier(tenantId, 'tenant_id');
    const id = identifier(agentId, 'agent_id');
    return this.#unitOfWork.run(tenant, async (repository) => ({
      agent: required(await repository.getAgent(tenant, id), 'agent'),
      presence: required(await repository.getPresence(tenant, id), 'agent_presence'),
      skills: await repository.listAgentSkills(tenant, id)
    }));
  }

  async getAgentByIdentity(tenantId: string, agentIdentity: string): Promise<ContactCenterAgentSnapshot> {
    const tenant = identifier(tenantId, 'tenant_id');
    const requestedIdentity = identity(agentIdentity);
    return this.#unitOfWork.run(tenant, async (repository) => {
      const agent = required(await repository.findAgentByIdentity(tenant, requestedIdentity), 'agent');
      return {
        agent,
        presence: required(await repository.getPresence(tenant, agent.id), 'agent_presence'),
        skills: await repository.listAgentSkills(tenant, agent.id)
      };
    });
  }

  async listAgents(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterAgent>> {
    const query = listInput(input);
    return this.#unitOfWork.run(query.tenant_id, (repository) => repository.listAgents(query));
  }

  async setAgentSkills(input: ActorInput & {
    agent_id: string;
    skills: ContactCenterAgentSkill[];
  }): Promise<ContactCenterAgentSkill[]> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    identifier(input.actor, 'actor');
    const agentId = identifier(input.agent_id, 'agent_id');
    const skills = normalizedAgentSkills(input.skills);
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const agent = required(await repository.getAgent(tenantId, agentId, { for_update: true }), 'agent');
      if (agent.status === 'archived') throw conflict('agent_archived');
      for (const item of skills) {
        const skill = required(await repository.getSkill(tenantId, item.skill_id), 'skill');
        if (skill.status !== 'active') throw conflict('skill_not_active');
      }
      await repository.replaceAgentSkills(tenantId, agentId, skills, this.#timestamp());
      return repository.listAgentSkills(tenantId, agentId);
    });
  }

  async updatePresence(input: ActorInput & {
    agent_id: string;
    state: 'available' | 'away' | 'offline';
    session_ref?: string;
  }): Promise<ContactCenterAgentSnapshot> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    identifier(input.actor, 'actor');
    const agentId = identifier(input.agent_id, 'agent_id');
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const agent = required(await repository.getAgent(tenantId, agentId, { for_update: true }), 'agent');
      const current = required(await repository.getPresence(tenantId, agentId, { for_update: true }), 'agent_presence');
      if (agent.status !== 'active' && input.state !== 'offline') throw conflict('agent_not_active');
      if (current.active_voice_count > 0 && input.state !== current.state) throw conflict('agent_has_active_work');
      const now = this.#timestamp();
      const nextState = presenceState(current.state, input.state);
      const presence = await repository.updatePresence({
        ...current, state: nextState,
        idle_since: nextState === 'available'
          ? (current.state === 'available' ? current.idle_since ?? now : now)
          : null,
        heartbeat_at: now,
        session_ref: input.session_ref === undefined
          ? (nextState === 'offline' ? '' : current.session_ref)
          : text(input.session_ref, 256),
        revision: current.revision + 1, updated_at: now
      }, current.revision);
      return { agent, presence, skills: await repository.listAgentSkills(tenantId, agentId) };
    });
  }

  async createQueue(input: ActorInput & {
    idempotency_key: string;
    name: string;
    routing_strategy?: ContactCenterRoutingStrategy;
    max_wait_seconds?: number;
    max_size?: number;
    callback_after_seconds?: number;
    overflow_action?: ContactCenterQueue['overflow_action'];
    overflow_queue_id?: string | null;
    overflow_target?: string;
    service_level_seconds?: number;
    status?: ContactCenterQueue['status'];
    metadata?: Record<string, unknown>;
  }): Promise<ContactCenterQueueConfiguration> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const actor = identifier(input.actor, 'actor');
    const key = idempotencyKey(input.idempotency_key);
    const now = this.#timestamp();
    const queue = validateQueue({
      id: this.#id(), tenant_id: tenantId, name: name(input.name),
      routing_strategy: routingStrategy(input.routing_strategy ?? 'longest_idle'),
      max_wait_seconds: integer(input.max_wait_seconds ?? 300, 1, 86_400, 'max_wait_seconds'),
      max_size: integer(input.max_size ?? 100, 1, 100_000, 'max_size'),
      callback_after_seconds: integer(input.callback_after_seconds ?? 120, 0, 86_400, 'callback_after_seconds'),
      overflow_action: overflowAction(input.overflow_action ?? 'none'),
      overflow_queue_id: nullableIdentifier(input.overflow_queue_id, 'overflow_queue_id'),
      overflow_target: text(input.overflow_target ?? '', 500),
      service_level_seconds: integer(input.service_level_seconds ?? 20, 1, 3_600, 'service_level_seconds'),
      status: queueStatus(input.status ?? 'active'), metadata: safeMetadata(input.metadata ?? {}),
      revision: 1, created_by: actor, updated_by: actor, created_at: now, updated_at: now
    });
    const payloadHash = canonicalContactCenterPayloadHash({
      resource_type: 'queue', name: queue.name, routing_strategy: queue.routing_strategy,
      max_wait_seconds: queue.max_wait_seconds, max_size: queue.max_size,
      callback_after_seconds: queue.callback_after_seconds,
      overflow_action: queue.overflow_action, overflow_queue_id: queue.overflow_queue_id,
      overflow_target: queue.overflow_target, service_level_seconds: queue.service_level_seconds,
      status: queue.status, metadata: queue.metadata
    });
    return this.#unitOfWork.run(tenantId, async (repository) => {
      await repository.lockIdempotencyKey(tenantId, key);
      const replay = await repository.findIdempotencyRecord(tenantId, key);
      if (replay) {
        assertIdempotencyRecord(replay, 'queue', payloadHash);
        const replayedQueue = required(await repository.getQueue(tenantId, replay.resource_id), 'queue');
        return {
          queue: replayedQueue,
          memberships: await repository.listMemberships(tenantId, replayedQueue.id),
          skill_requirements: await repository.listQueueSkillRequirements(tenantId, replayedQueue.id)
        };
      }
      if (queue.overflow_queue_id) required(
        await repository.getQueue(tenantId, queue.overflow_queue_id), 'overflow_queue'
      );
      await assertOverflowChain(repository, tenantId, queue.id, queue.overflow_queue_id);
      const created = await repository.insertQueue(queue);
      await repository.insertIdempotencyRecord({
        tenant_id: tenantId, idempotency_key: key, resource_type: 'queue',
        payload_hash: payloadHash, resource_id: created.id, created_at: now
      });
      return { queue: created, memberships: [], skill_requirements: [] };
    });
  }

  async updateQueue(input: ActorInput & {
    queue_id: string;
    expected_revision: number;
    patch: Partial<Pick<ContactCenterQueue,
      'name' | 'routing_strategy' | 'max_wait_seconds' | 'max_size' |
      'callback_after_seconds' | 'overflow_action' | 'overflow_queue_id' |
      'overflow_target' | 'service_level_seconds' | 'status' | 'metadata'>>;
  }): Promise<ContactCenterQueueConfiguration> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const queueId = identifier(input.queue_id, 'queue_id');
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const current = required(await repository.getQueue(tenantId, queueId, { for_update: true }), 'queue');
      revision(current.revision, input.expected_revision);
      const patch = definedPatch(input.patch, [
        'name', 'routing_strategy', 'max_wait_seconds', 'max_size', 'callback_after_seconds',
        'overflow_action', 'overflow_queue_id', 'overflow_target', 'service_level_seconds',
        'status', 'metadata'
      ]);
      const queue = validateQueue({
        ...current, ...patch, id: current.id, tenant_id: tenantId,
        name: name(patch.name ?? current.name),
        routing_strategy: routingStrategy(patch.routing_strategy ?? current.routing_strategy),
        max_wait_seconds: integer(patch.max_wait_seconds ?? current.max_wait_seconds, 1, 86_400, 'max_wait_seconds'),
        max_size: integer(patch.max_size ?? current.max_size, 1, 100_000, 'max_size'),
        callback_after_seconds: integer(patch.callback_after_seconds ?? current.callback_after_seconds, 0, 86_400, 'callback_after_seconds'),
        overflow_action: overflowAction(patch.overflow_action ?? current.overflow_action),
        overflow_queue_id: patch.overflow_queue_id === undefined
          ? current.overflow_queue_id
          : nullableIdentifier(patch.overflow_queue_id, 'overflow_queue_id'),
        overflow_target: text(patch.overflow_target ?? current.overflow_target, 500),
        service_level_seconds: integer(patch.service_level_seconds ?? current.service_level_seconds, 1, 3_600, 'service_level_seconds'),
        status: queueStatus(patch.status ?? current.status),
        metadata: safeMetadata(patch.metadata ?? current.metadata),
        revision: current.revision + 1,
        updated_by: identifier(input.actor, 'actor'), updated_at: this.#timestamp()
      });
      if (queue.overflow_queue_id) required(
        await repository.getQueue(tenantId, queue.overflow_queue_id), 'overflow_queue'
      );
      await assertOverflowChain(repository, tenantId, queue.id, queue.overflow_queue_id);
      const updated = await repository.updateQueue(queue, current.revision);
      return {
        queue: updated,
        memberships: await repository.listMemberships(tenantId, queueId),
        skill_requirements: await repository.listQueueSkillRequirements(tenantId, queueId)
      };
    });
  }

  async getQueue(tenantId: string, queueId: string): Promise<ContactCenterQueueConfiguration> {
    const tenant = identifier(tenantId, 'tenant_id');
    const id = identifier(queueId, 'queue_id');
    return this.#unitOfWork.run(tenant, async (repository) => ({
      queue: required(await repository.getQueue(tenant, id), 'queue'),
      memberships: await repository.listMemberships(tenant, id),
      skill_requirements: await repository.listQueueSkillRequirements(tenant, id)
    }));
  }

  async listQueues(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterQueue>> {
    const query = listInput(input);
    return this.#unitOfWork.run(query.tenant_id, (repository) => repository.listQueues(query));
  }

  async upsertMembership(input: ActorInput & {
    queue_id: string;
    agent_id: string;
    priority?: number;
    enabled?: boolean;
  }): Promise<ContactCenterQueueMembership> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    identifier(input.actor, 'actor');
    const queueId = identifier(input.queue_id, 'queue_id');
    const agentId = identifier(input.agent_id, 'agent_id');
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const queue = required(await repository.getQueue(tenantId, queueId), 'queue');
      const agent = required(await repository.getAgent(tenantId, agentId), 'agent');
      if (queue.status === 'archived') throw conflict('queue_archived');
      const enabled = input.enabled ?? true;
      if (enabled && agent.status !== 'active') throw conflict('agent_not_active');
      const now = this.#timestamp();
      const current = (await repository.listMemberships(tenantId, queueId))
        .find((membership) => membership.agent_id === agentId);
      return repository.upsertMembership(tenantId, {
        queue_id: queueId, agent_id: agentId,
        priority: integer(input.priority ?? current?.priority ?? 0, -100, 100, 'priority'),
        enabled, created_at: current?.created_at ?? now, updated_at: now
      });
    });
  }

  async removeMembership(input: ActorInput & { queue_id: string; agent_id: string }): Promise<boolean> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    identifier(input.actor, 'actor');
    return this.#unitOfWork.run(tenantId, (repository) => repository.removeMembership(
      tenantId, identifier(input.queue_id, 'queue_id'), identifier(input.agent_id, 'agent_id')
    ));
  }

  async setQueueSkillRequirements(input: ActorInput & {
    queue_id: string;
    requirements: ContactCenterSkillRequirement[];
  }): Promise<ContactCenterSkillRequirement[]> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    identifier(input.actor, 'actor');
    const queueId = identifier(input.queue_id, 'queue_id');
    const requirements = normalizedRequirements(input.requirements);
    return this.#unitOfWork.run(tenantId, async (repository) => {
      const queue = required(await repository.getQueue(tenantId, queueId, { for_update: true }), 'queue');
      if (queue.status === 'archived') throw conflict('queue_archived');
      for (const item of requirements) {
        const skill = required(await repository.getSkill(tenantId, item.skill_id), 'skill');
        if (skill.status !== 'active') throw conflict('skill_not_active');
      }
      await repository.replaceQueueSkillRequirements(tenantId, queueId, requirements, this.#timestamp());
      return repository.listQueueSkillRequirements(tenantId, queueId);
    });
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function presenceState(
  current: ContactCenterPresenceState,
  requested: 'available' | 'away' | 'offline'
): ContactCenterPresenceState {
  if (current === requested) return current;
  if (requested === 'available' && current === 'busy') return transitionPresence(current, 'release');
  if (requested === 'away' && current === 'busy') {
    return transitionPresence(transitionPresence(current, 'release'), 'away');
  }
  return transitionPresence(current, requested);
}

function validateQueue(queue: ContactCenterQueue): ContactCenterQueue {
  const hasQueue = queue.overflow_action === 'queue' && Boolean(queue.overflow_queue_id) && !queue.overflow_target;
  const hasTarget = (queue.overflow_action === 'voicemail' || queue.overflow_action === 'external') &&
    !queue.overflow_queue_id && Boolean(queue.overflow_target);
  const hasNeither = (queue.overflow_action === 'none' || queue.overflow_action === 'hangup') &&
    !queue.overflow_queue_id && !queue.overflow_target;
  if (!hasQueue && !hasTarget && !hasNeither) throw conflict('invalid_overflow_configuration');
  if (hasTarget) identifier(queue.overflow_target, 'overflow_target');
  return queue;
}

async function assertOverflowChain(
  repository: ContactCenterConfigurationRepository,
  tenantId: string,
  sourceQueueId: string,
  targetQueueId: string | null
): Promise<void> {
  const seen = new Set([sourceQueueId]);
  let currentId = targetQueueId;
  for (let depth = 0; currentId && depth < 100; depth += 1) {
    if (seen.has(currentId)) throw conflict('overflow_cycle');
    seen.add(currentId);
    const queue = required(await repository.getQueue(tenantId, currentId), 'overflow_queue');
    currentId = queue.overflow_action === 'queue' ? queue.overflow_queue_id : null;
  }
  if (currentId) throw conflict('overflow_chain_too_deep');
}

function normalizedAgentSkills(value: unknown): ContactCenterAgentSkill[] {
  if (!Array.isArray(value) || value.length > 100) throw validation('skills');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw validation('skills');
    const input = item as Record<string, unknown>;
    const skill = {
      skill_id: identifier(input.skill_id, 'skill_id'),
      proficiency: integer(input.proficiency, 1, 100, 'proficiency')
    };
    if (ids.has(skill.skill_id)) throw validation('skills');
    ids.add(skill.skill_id);
    return skill;
  }).sort((left, right) => left.skill_id.localeCompare(right.skill_id));
}

function normalizedRequirements(value: unknown): ContactCenterSkillRequirement[] {
  if (!Array.isArray(value) || value.length > 100) throw validation('requirements');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw validation('requirements');
    const input = item as Record<string, unknown>;
    const requirement = {
      skill_id: identifier(input.skill_id, 'skill_id'),
      minimum_proficiency: integer(input.minimum_proficiency, 1, 100, 'minimum_proficiency')
    };
    if (ids.has(requirement.skill_id)) throw validation('requirements');
    ids.add(requirement.skill_id);
    return requirement;
  }).sort((left, right) => left.skill_id.localeCompare(right.skill_id));
}

function listInput(input: ContactCenterListInput): ContactCenterListInput {
  const statusFilter = input.status === undefined ? undefined : status(input.status);
  return {
    tenant_id: identifier(input.tenant_id, 'tenant_id'),
    limit: integer(input.limit ?? 50, 1, 200, 'limit'),
    ...(input.cursor ? { cursor: text(input.cursor, 2_000) } : {}),
    ...(statusFilter ? { status: statusFilter } : {})
  };
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('metadata');
  canonicalContactCenterPayloadHash(value);
  let nodes = 0;
  const inspect = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 500 || depth > 8) throw validation('metadata');
    if (typeof entry === 'string' && entry.length > 4_096) throw validation('metadata');
    if (Array.isArray(entry)) {
      for (const item of entry) inspect(item, depth + 1);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
      if (/secret|password|authorization|credential|private[_-]?key|access[_-]?token/i.test(key)) {
        throw validation('metadata');
      }
      inspect(item, depth + 1);
    }
  };
  inspect(value, 0);
  return structuredClone(value as Record<string, unknown>);
}

function definedPatch<T extends object, K extends keyof T>(value: Partial<T>, keys: readonly K[]): Partial<Pick<T, K>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('patch');
  const output: Partial<Pick<T, K>> = {};
  for (const key of keys) if (value[key] !== undefined) output[key] = value[key];
  return output;
}

function required<T>(value: T | null, resource: string): T {
  if (!value) throw new ContactCenterError({ code: 'not_found', status: 404, details: { resource } });
  return value;
}

function assertIdempotencyRecord(
  record: ContactCenterConfigurationIdempotencyRecord,
  resourceType: ContactCenterConfigurationIdempotencyRecord['resource_type'],
  payloadHash: string
): void {
  if (record.resource_type !== resourceType || record.payload_hash !== payloadHash) {
    throw new ContactCenterError({ code: 'idempotency_conflict', status: 409 });
  }
}

function idempotencyKey(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(output)) throw validation('idempotency_key');
  return output;
}

function revision(actual: number, expected: number): void {
  if (!Number.isInteger(expected) || expected < 1) throw validation('expected_revision');
  if (actual !== expected) throw new ContactCenterError({ code: 'revision_conflict', details: { expected, actual } });
}

function identifier(value: unknown, field: string): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) throw validation(field);
  return output;
}

function nullableIdentifier(value: unknown, field: string): string | null {
  return value === undefined || value === null || value === '' ? null : identifier(value, field);
}

function identity(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(output)) throw validation('identity');
  return output;
}

function name(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!output || output.length > 200) throw validation('name');
  return output;
}

function text(value: unknown, maximum: number): string {
  const output = String(value ?? '').trim();
  if (output.length > maximum) throw validation('text');
  return output;
}

function integer(value: unknown, minimum: number, maximum: number, field: string): number {
  const output = Number(value);
  if (!Number.isInteger(output) || output < minimum || output > maximum) throw validation(field);
  return output;
}

function status(value: unknown): ContactCenterAgent['status'] {
  if (value !== 'active' && value !== 'disabled' && value !== 'archived') throw validation('status');
  return value;
}

function queueStatus(value: unknown): ContactCenterQueue['status'] {
  return status(value);
}

function routingStrategy(value: unknown): ContactCenterRoutingStrategy {
  if (!['longest_idle', 'least_calls', 'round_robin', 'skill_priority'].includes(String(value))) {
    throw validation('routing_strategy');
  }
  return value as ContactCenterRoutingStrategy;
}

function overflowAction(value: unknown): ContactCenterQueue['overflow_action'] {
  if (!['none', 'queue', 'voicemail', 'hangup', 'external'].includes(String(value))) {
    throw validation('overflow_action');
  }
  return value as ContactCenterQueue['overflow_action'];
}

function validation(field: string): ContactCenterError {
  return new ContactCenterError({ code: 'validation_failed', status: 422, details: { field } });
}

function conflict(reason: string): ContactCenterError {
  return new ContactCenterError({ code: 'conflict', details: { reason } });
}
