import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { TenantSkillStore } from '../src/agent-runtime/skills/tenant-skill-store.js';
import type { IntegrationCatalogLike, IntegrationCatalogEntry } from '../src/agent-runtime/integrations/provider-runtime-types.js';

/** Minimal in-memory catalog mock for testing. */
function createMockCatalog(entries: Record<string, IntegrationCatalogEntry> = {}): IntegrationCatalogLike {
  return {
    list: () => Object.values(entries),
    get: (id: string) => entries[id] || null,
    register: () => {},
    findByIntegration: () => []
  } as unknown as IntegrationCatalogLike;
}

const MOCK_SKILL: IntegrationCatalogEntry = {
  id: 'skill.lead_qualification',
  name: 'Lead Qualification',
  source_type: 'skill',
  recommended_use: 'Qualify inbound leads',
  category: 'skill',
  stability_score: 1,
  adapter_status: 'active',
  capabilities: [],
  config_required: false
};

let db: ReturnType<typeof createDatabase>;
let store: TenantSkillStore;
let tenantId: string;

function setup() {
  db = createDatabase(':memory:');
  store = new TenantSkillStore({ db, integrationCatalog: createMockCatalog({ 'skill.lead_qualification': MOCK_SKILL }) });
  tenantId = createTenant(db, { name: 'Skill Test' }).id;
}

test('upsertSkill creates a tenant skill', () => {
  setup();
  const skill = store.upsertSkill({
    tenant_id: tenantId,
    skill_id: 'custom-skill-1',
    name: 'My Custom Skill',
    description: 'A test skill',
    applicable_agents: ['orchestration_agent'],
    inputs: [{ key: 'lead_id', type: 'string' }],
    steps: [{ action: 'lookup' }],
    quality_checks: [{ check: 'has_name' }]
  });
  assert.ok(skill.id);
  assert.equal(skill.skill_id, 'custom-skill-1');
  assert.equal(skill.name, 'My Custom Skill');
  assert.equal(skill.status, 'draft');
  assert.deepEqual(skill.applicable_agents, ['orchestration_agent']);
  assert.equal(skill.inputs.length, 1);
});

test('upsertSkill updates existing (ON CONFLICT)', () => {
  setup();
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'upsert-1', name: 'Original' });
  const updated = store.upsertSkill({ tenant_id: tenantId, skill_id: 'upsert-1', name: 'Updated', status: 'active' });
  assert.equal(updated.name, 'Updated');
  assert.equal(updated.status, 'active');
});

test('upsertSkill infers applicable_agents from source skill', () => {
  setup();
  const skill = store.upsertSkill({
    tenant_id: tenantId,
    source_skill_id: 'skill.lead_qualification',
    name: 'From Source'
  });
  // inferApplicableAgents returns ['orchestration_agent', 'crm_agent'] for lead_qualification
  assert.deepEqual(skill.applicable_agents, ['orchestration_agent', 'crm_agent']);
  assert.equal(skill.source_skill_id, 'skill.lead_qualification');
});

test('upsertSkill rejects non-skill source catalog entry', () => {
  setup();
  const catalog = createMockCatalog({
    'integration.x': { ...MOCK_SKILL, id: 'integration.x', source_type: 'integration' }
  });
  const badStore = new TenantSkillStore({ db, integrationCatalog: catalog });
  assert.throws(
    () => badStore.upsertSkill({ tenant_id: tenantId, source_skill_id: 'integration.x', name: 'X' }),
    /must reference a catalog skill entry/
  );
});

test('upsertSkill validates required fields', () => {
  setup();
  // tenant_id is the only hard-required field — skill_id auto-generates,
  // name falls back to skill_id, so only tenant_id='' throws
  assert.throws(() => store.upsertSkill({ tenant_id: '', skill_id: 's', name: 'N' }), /tenant_id/);
  // Verify auto-generation: empty skill_id produces a default
  const auto = store.upsertSkill({ tenant_id: tenantId, skill_id: '', name: 'Auto' });
  assert.match(auto.skill_id, /^skill\./);
});

test('getSkill returns null for non-existent', () => {
  setup();
  assert.equal(store.getSkill(tenantId, 'default', 'nope'), null);
});

test('listSkills filters by status and applicable_agent', () => {
  setup();
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'a', name: 'A', status: 'active', applicable_agents: ['crm_agent'] });
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'b', name: 'B', status: 'draft', applicable_agents: ['orchestration_agent'] });
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'c', name: 'C', status: 'active', applicable_agents: ['orchestration_agent'] });

  const active = store.listSkills({ tenant_id: tenantId, status: 'active' });
  assert.equal(active.length, 2);
  const forOrch = store.listSkills({ tenant_id: tenantId, applicable_agent: 'orchestration_agent' });
  assert.equal(forOrch.length, 2); // B (draft) + C (active) both have orchestration_agent
});

test('proposeCandidate creates a candidate', () => {
  setup();
  const candidate = store.proposeCandidate({
    tenant_id: tenantId,
    proposed_skill_id: 'proposed-1',
    name: 'Proposed Skill',
    evidence: { reason: 'seen in production' }
  });
  assert.ok(candidate.id);
  assert.equal(candidate.proposed_skill_id, 'proposed-1');
  assert.equal(candidate.status, 'candidate');
  assert.deepEqual(candidate.evidence, { reason: 'seen in production' });
});

test('reviewCandidate approve activates a skill', () => {
  setup();
  const candidate = store.proposeCandidate({
    tenant_id: tenantId,
    proposed_skill_id: 'to-approve',
    name: 'To Approve'
  });
  const result = store.reviewCandidate({
    tenant_id: tenantId,
    candidate_id: candidate.id,
    decision: 'approve',
    actor_id: 'admin-1'
  });
  assert.equal(result.candidate.status, 'approved');
  assert.ok(result.skill);
  assert.equal(result.skill.skill_id, 'to-approve');
  assert.equal(result.skill.status, 'active');
  // The activated skill should be retrievable via getSkill
  const found = store.getSkill(tenantId, 'default', 'to-approve');
  assert.ok(found);
});

test('reviewCandidate reject does not activate a skill', () => {
  setup();
  const candidate = store.proposeCandidate({
    tenant_id: tenantId,
    proposed_skill_id: 'to-reject',
    name: 'To Reject'
  });
  const result = store.reviewCandidate({
    tenant_id: tenantId,
    candidate_id: candidate.id,
    decision: 'reject'
  });
  assert.equal(result.candidate.status, 'rejected');
  assert.equal(result.skill, null);
  // No skill should have been created
  assert.equal(store.getSkill(tenantId, 'default', 'to-reject'), null);
});

test('reviewCandidate throws on non-existent candidate', () => {
  setup();
  assert.throws(
    () => store.reviewCandidate({ tenant_id: tenantId, candidate_id: 'fake', decision: 'approve' }),
    /skill candidate not found/
  );
});

test('reviewCandidate throws on invalid decision', () => {
  setup();
  const candidate = store.proposeCandidate({ tenant_id: tenantId, proposed_skill_id: 'x', name: 'X' });
  assert.throws(
    () => store.reviewCandidate({ tenant_id: tenantId, candidate_id: candidate.id, decision: 'maybe' }),
    /decision must be approve or reject/
  );
});

test('listCandidates filters by status', () => {
  setup();
  store.proposeCandidate({ tenant_id: tenantId, proposed_skill_id: 'c1', name: 'C1' });
  const c2 = store.proposeCandidate({ tenant_id: tenantId, proposed_skill_id: 'c2', name: 'C2' });
  store.reviewCandidate({ tenant_id: tenantId, candidate_id: c2.id, decision: 'approve' });

  const pending = store.listCandidates({ tenant_id: tenantId, status: 'candidate' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].proposed_skill_id, 'c1');

  const approved = store.listCandidates({ tenant_id: tenantId, status: 'approved' });
  assert.equal(approved.length, 1);
  assert.equal(approved[0].proposed_skill_id, 'c2');
});

test('buildPack returns active skills for a specific agent', () => {
  setup();
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'pack-1', name: 'Pack1', status: 'active', applicable_agents: ['orchestration_agent'] });
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'pack-2', name: 'Pack2', status: 'draft', applicable_agents: ['orchestration_agent'] });
  store.upsertSkill({ tenant_id: tenantId, skill_id: 'pack-3', name: 'Pack3', status: 'active', applicable_agents: ['crm_agent'] });

  const pack = store.buildPack({ tenantId, agentId: 'orchestration_agent' });
  assert.equal(pack.length, 1);
  assert.equal(pack[0].skill_id, 'pack-1');
  // Pack items should have the expected shape
  assert.ok(pack[0].name);
  assert.ok(pack[0].inputs);
});
