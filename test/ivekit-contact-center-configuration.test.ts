import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContactCenterConfigurationService,
  ContactCenterError,
  type ContactCenterAgent,
  type ContactCenterAgentPresence,
  type ContactCenterAgentSkill,
  type ContactCenterConfigurationRepository,
  type ContactCenterConfigurationIdempotencyRecord,
  type ContactCenterConfigurationUnitOfWork,
  type ContactCenterListInput,
  type ContactCenterPage,
  type ContactCenterQueue,
  type ContactCenterQueueMembership,
  type ContactCenterSkill,
  type ContactCenterSkillRequirement
} from '../src/agent-runtime/converact/contact-center/index.js';

test('Contact Center configuration creates an agent with durable offline presence', async () => {
  const fixture = setup();
  const created = await fixture.service.createAgent({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'agent-create-a',
    identity: 'agent@example.test',
    display_name: 'Agent A', voice_capacity: 2, metadata: { team: 'support' }
  });
  assert.equal(created.agent.identity, 'agent@example.test');
  assert.equal(created.presence.state, 'offline');
  assert.equal(created.presence.voice_capacity, 2);
  assert.equal(created.agent.created_by, 'admin-a');
  assert.deepEqual(await fixture.service.getAgent('tenant-a', created.agent.id), created);
  assert.deepEqual(await fixture.service.createAgent({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'agent-create-a',
    identity: 'agent@example.test', display_name: 'Agent A', voice_capacity: 2,
    metadata: { team: 'support' }
  }), created);
  assert.equal(fixture.repository.agents.size, 1);

  await assert.rejects(
    () => fixture.service.createAgent({
      tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'agent-create-a',
      identity: 'changed-agent'
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'idempotency_conflict'
  );

  await assert.rejects(
    () => fixture.service.createAgent({
      tenant_id: 'tenant-a', actor: 'admin-a', identity: 'unsafe-agent',
      idempotency_key: 'unsafe-agent-create',
      metadata: { access_token: 'must-not-persist' }
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );
});

test('Contact Center configuration protects active capacity and presence transitions', async () => {
  const fixture = setup();
  const created = await fixture.service.createAgent({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'agent-create-a',
    identity: 'agent-a', voice_capacity: 2
  });
  const available = await fixture.service.updatePresence({
    tenant_id: 'tenant-a', actor: 'agent-a', agent_id: created.agent.id,
    state: 'available', session_ref: 'browser-session-a'
  });
  assert.equal(available.presence.state, 'available');
  assert.equal(available.presence.idle_since, fixture.now.toISOString());

  const stored = fixture.repository.presences.get(created.agent.id)!;
  fixture.repository.presences.set(created.agent.id, {
    ...stored, state: 'busy', active_voice_count: 2, revision: stored.revision + 1
  });
  await assert.rejects(
    () => fixture.service.updateAgent({
      tenant_id: 'tenant-a', actor: 'admin-a', agent_id: created.agent.id,
      expected_revision: created.agent.revision, patch: { voice_capacity: 1 }
    }),
    (error: unknown) => error instanceof ContactCenterError && error.details.reason === 'active_capacity'
  );
  await assert.rejects(
    () => fixture.service.updatePresence({
      tenant_id: 'tenant-a', actor: 'agent-a', agent_id: created.agent.id, state: 'offline'
    }),
    (error: unknown) => error instanceof ContactCenterError && error.details.reason === 'agent_has_active_work'
  );

  fixture.repository.presences.set(created.agent.id, {
    ...fixture.repository.presences.get(created.agent.id)!, active_voice_count: 0
  });
  const disabled = await fixture.service.updateAgent({
    tenant_id: 'tenant-a', actor: 'admin-a', agent_id: created.agent.id,
    expected_revision: created.agent.revision, patch: { status: 'disabled', voice_capacity: 1 }
  });
  assert.equal(disabled.agent.status, 'disabled');
  assert.equal(disabled.presence.state, 'offline');
  assert.equal(disabled.presence.voice_capacity, 1);
});

test('Contact Center configuration replaces validated agent skills', async () => {
  const fixture = setup();
  const agent = await fixture.service.createAgent({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'agent-create-a', identity: 'agent-a'
  });
  const sales = await fixture.service.createSkill({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'skill-create-sales', name: 'Sales'
  });
  const support = await fixture.service.createSkill({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'skill-create-support', name: 'Support'
  });
  const skills = await fixture.service.setAgentSkills({
    tenant_id: 'tenant-a', actor: 'admin-a', agent_id: agent.agent.id,
    skills: [
      { skill_id: support.id, proficiency: 80 },
      { skill_id: sales.id, proficiency: 95 }
    ]
  });
  assert.deepEqual(skills, [
    { skill_id: sales.id, proficiency: 95 },
    { skill_id: support.id, proficiency: 80 }
  ]);
  await assert.rejects(
    () => fixture.service.setAgentSkills({
      tenant_id: 'tenant-a', actor: 'admin-a', agent_id: agent.agent.id,
      skills: [{ skill_id: sales.id, proficiency: 90 }, { skill_id: sales.id, proficiency: 80 }]
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'validation_failed'
  );
});

test('Contact Center configuration manages queues, memberships, and skill requirements', async () => {
  const fixture = setup();
  const overflow = await fixture.service.createQueue({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'queue-create-overflow', name: 'Overflow'
  });
  const queue = await fixture.service.createQueue({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'queue-create-support',
    name: 'Support', routing_strategy: 'skill_priority',
    overflow_action: 'queue', overflow_queue_id: overflow.queue.id
  });
  const agent = await fixture.service.createAgent({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'agent-create-a', identity: 'agent-a'
  });
  const skill = await fixture.service.createSkill({
    tenant_id: 'tenant-a', actor: 'admin-a', idempotency_key: 'skill-create-support', name: 'Support'
  });
  const membership = await fixture.service.upsertMembership({
    tenant_id: 'tenant-a', actor: 'admin-a', queue_id: queue.queue.id,
    agent_id: agent.agent.id, priority: 7
  });
  assert.equal(membership.priority, 7);
  assert.deepEqual(await fixture.service.setQueueSkillRequirements({
    tenant_id: 'tenant-a', actor: 'admin-a', queue_id: queue.queue.id,
    requirements: [{ skill_id: skill.id, minimum_proficiency: 75 }]
  }), [{ skill_id: skill.id, minimum_proficiency: 75 }]);
  const snapshot = await fixture.service.getQueue('tenant-a', queue.queue.id);
  assert.equal(snapshot.memberships.length, 1);
  assert.equal(snapshot.skill_requirements.length, 1);

  await assert.rejects(
    () => fixture.service.updateQueue({
      tenant_id: 'tenant-a', actor: 'admin-a', queue_id: queue.queue.id,
      expected_revision: queue.queue.revision + 1, patch: { max_size: 200 }
    }),
    (error: unknown) => error instanceof ContactCenterError && error.code === 'revision_conflict'
  );
  await assert.rejects(
    () => fixture.service.updateQueue({
      tenant_id: 'tenant-a', actor: 'admin-a', queue_id: queue.queue.id,
      expected_revision: queue.queue.revision,
      patch: { overflow_action: 'queue', overflow_queue_id: queue.queue.id }
    }),
    (error: unknown) => error instanceof ContactCenterError && error.details.reason === 'overflow_cycle'
  );
  await assert.rejects(
    () => fixture.service.updateQueue({
      tenant_id: 'tenant-a', actor: 'admin-a', queue_id: overflow.queue.id,
      expected_revision: overflow.queue.revision,
      patch: { overflow_action: 'queue', overflow_queue_id: queue.queue.id }
    }),
    (error: unknown) => error instanceof ContactCenterError && error.details.reason === 'overflow_cycle'
  );
});

class MemoryConfigurationRepository implements ContactCenterConfigurationRepository {
  readonly idempotencyRecords = new Map<string, ContactCenterConfigurationIdempotencyRecord>();
  readonly skills = new Map<string, ContactCenterSkill>();
  readonly agents = new Map<string, ContactCenterAgent>();
  readonly presences = new Map<string, ContactCenterAgentPresence>();
  readonly agentSkills = new Map<string, ContactCenterAgentSkill[]>();
  readonly queues = new Map<string, ContactCenterQueue>();
  readonly memberships = new Map<string, ContactCenterQueueMembership>();
  readonly requirements = new Map<string, ContactCenterSkillRequirement[]>();

  async lockIdempotencyKey() {}
  async findIdempotencyRecord(_tenant: string, key: string) {
    return clone(this.idempotencyRecords.get(key) ?? null);
  }
  async insertIdempotencyRecord(value: ContactCenterConfigurationIdempotencyRecord) {
    this.idempotencyRecords.set(value.idempotency_key, clone(value));
    return clone(value);
  }

  async insertSkill(value: ContactCenterSkill) { this.skills.set(value.id, clone(value)); return clone(value); }
  async getSkill(_tenant: string, id: string) { return clone(this.skills.get(id) ?? null); }
  async updateSkill(value: ContactCenterSkill) { this.skills.set(value.id, clone(value)); return clone(value); }
  async listSkills(input: ContactCenterListInput) { return page([...this.skills.values()], input); }
  async insertAgent(value: ContactCenterAgent, presence: ContactCenterAgentPresence) {
    this.agents.set(value.id, clone(value));
    this.presences.set(value.id, clone(presence));
    return clone(value);
  }
  async getAgent(_tenant: string, id: string) { return clone(this.agents.get(id) ?? null); }
  async findAgentByIdentity(_tenant: string, identity: string) {
    return clone([...this.agents.values()].find((agent) => agent.identity === identity) ?? null);
  }
  async updateAgent(value: ContactCenterAgent) { this.agents.set(value.id, clone(value)); return clone(value); }
  async listAgents(input: ContactCenterListInput) { return page([...this.agents.values()], input); }
  async getPresence(_tenant: string, id: string) { return clone(this.presences.get(id) ?? null); }
  async updatePresence(value: ContactCenterAgentPresence) {
    this.presences.set(value.agent_id, clone(value));
    return clone(value);
  }
  async listAgentSkills(_tenant: string, id: string) { return clone(this.agentSkills.get(id) ?? []); }
  async replaceAgentSkills(_tenant: string, id: string, skills: ContactCenterAgentSkill[]) {
    this.agentSkills.set(id, clone(skills));
  }
  async insertQueue(value: ContactCenterQueue) { this.queues.set(value.id, clone(value)); return clone(value); }
  async getQueue(_tenant: string, id: string) { return clone(this.queues.get(id) ?? null); }
  async updateQueue(value: ContactCenterQueue) { this.queues.set(value.id, clone(value)); return clone(value); }
  async listQueues(input: ContactCenterListInput) { return page([...this.queues.values()], input); }
  async listMemberships(_tenant: string, queueId: string) {
    return clone([...this.memberships.values()].filter((value) => value.queue_id === queueId));
  }
  async upsertMembership(_tenant: string, value: ContactCenterQueueMembership) {
    this.memberships.set(`${value.queue_id}:${value.agent_id}`, clone(value));
    return clone(value);
  }
  async removeMembership(_tenant: string, queueId: string, agentId: string) {
    return this.memberships.delete(`${queueId}:${agentId}`);
  }
  async listQueueSkillRequirements(_tenant: string, queueId: string) {
    return clone(this.requirements.get(queueId) ?? []);
  }
  async replaceQueueSkillRequirements(
    _tenant: string,
    queueId: string,
    requirements: ContactCenterSkillRequirement[]
  ) {
    this.requirements.set(queueId, clone(requirements));
  }
}

function setup() {
  const repository = new MemoryConfigurationRepository();
  const unitOfWork: ContactCenterConfigurationUnitOfWork = {
    run: async (_tenantId, operation) => operation(repository)
  };
  let id = 0;
  const fixture = {
    now: new Date('2026-07-13T08:00:00.000Z'),
    repository,
    service: null as unknown as ContactCenterConfigurationService
  };
  fixture.service = new ContactCenterConfigurationService(unitOfWork, {
    id: () => `id-${++id}`,
    now: () => fixture.now
  });
  return fixture;
}

function page<T extends { status: string }>(items: T[], input: ContactCenterListInput): ContactCenterPage<T> {
  const filtered = input.status ? items.filter((item) => item.status === input.status) : items;
  return { items: clone(filtered.slice(0, input.limit ?? 50)), next_cursor: null };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
