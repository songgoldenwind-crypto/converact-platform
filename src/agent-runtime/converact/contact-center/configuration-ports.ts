import type {
  ContactCenterAgent,
  ContactCenterAgentPresence,
  ContactCenterAgentSkill,
  ContactCenterConfigurationIdempotencyRecord,
  ContactCenterListInput,
  ContactCenterPage,
  ContactCenterQueue,
  ContactCenterQueueMembership,
  ContactCenterSkill,
  ContactCenterSkillRequirement
} from './types.js';

export interface ContactCenterConfigurationRepository {
  lockIdempotencyKey(tenantId: string, key: string): Promise<void>;
  findIdempotencyRecord(
    tenantId: string,
    key: string
  ): Promise<ContactCenterConfigurationIdempotencyRecord | null>;
  insertIdempotencyRecord(
    record: ContactCenterConfigurationIdempotencyRecord
  ): Promise<ContactCenterConfigurationIdempotencyRecord>;
  insertSkill(skill: ContactCenterSkill): Promise<ContactCenterSkill>;
  getSkill(tenantId: string, skillId: string, options?: { for_update?: boolean }): Promise<ContactCenterSkill | null>;
  updateSkill(skill: ContactCenterSkill, expectedRevision: number): Promise<ContactCenterSkill>;
  listSkills(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterSkill>>;
  insertAgent(agent: ContactCenterAgent, presence: ContactCenterAgentPresence): Promise<ContactCenterAgent>;
  getAgent(tenantId: string, agentId: string, options?: { for_update?: boolean }): Promise<ContactCenterAgent | null>;
  findAgentByIdentity(tenantId: string, identity: string): Promise<ContactCenterAgent | null>;
  updateAgent(agent: ContactCenterAgent, expectedRevision: number): Promise<ContactCenterAgent>;
  listAgents(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterAgent>>;
  getPresence(tenantId: string, agentId: string, options?: { for_update?: boolean }): Promise<ContactCenterAgentPresence | null>;
  updatePresence(presence: ContactCenterAgentPresence, expectedRevision: number): Promise<ContactCenterAgentPresence>;
  listAgentSkills(tenantId: string, agentId: string): Promise<ContactCenterAgentSkill[]>;
  replaceAgentSkills(tenantId: string, agentId: string, skills: ContactCenterAgentSkill[], now: string): Promise<void>;
  insertQueue(queue: ContactCenterQueue): Promise<ContactCenterQueue>;
  getQueue(tenantId: string, queueId: string, options?: { for_update?: boolean }): Promise<ContactCenterQueue | null>;
  updateQueue(queue: ContactCenterQueue, expectedRevision: number): Promise<ContactCenterQueue>;
  listQueues(input: ContactCenterListInput): Promise<ContactCenterPage<ContactCenterQueue>>;
  listMemberships(tenantId: string, queueId: string): Promise<ContactCenterQueueMembership[]>;
  upsertMembership(tenantId: string, membership: ContactCenterQueueMembership): Promise<ContactCenterQueueMembership>;
  removeMembership(tenantId: string, queueId: string, agentId: string): Promise<boolean>;
  listQueueSkillRequirements(tenantId: string, queueId: string): Promise<ContactCenterSkillRequirement[]>;
  replaceQueueSkillRequirements(
    tenantId: string,
    queueId: string,
    requirements: ContactCenterSkillRequirement[],
    now: string
  ): Promise<void>;
}

export interface ContactCenterConfigurationUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (repository: ContactCenterConfigurationRepository) => Promise<T>
  ): Promise<T>;
}
