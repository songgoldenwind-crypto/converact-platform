import { all, id, json, one, parseJson, run } from '../../db.js';
import type { IntegrationCatalogEntry, IntegrationCatalogLike, JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface TenantSkillStoreOptions {
  db: unknown;
  integrationCatalog: IntegrationCatalogLike;
  runStore?: AuditStoreLike | null;
}

export class TenantSkillStore {
  db: unknown;
  integrationCatalog: IntegrationCatalogLike;
  runStore: AuditStoreLike | null;

  constructor({ db, integrationCatalog, runStore = null }: TenantSkillStoreOptions) {
    this.db = db;
    this.integrationCatalog = integrationCatalog;
    this.runStore = runStore;
  }

  upsertSkill(input: JsonRecord): JsonRecord {
    const normalized = normalizeSkillInput(this.integrationCatalog, input);
    run(
      this.db,
      `INSERT INTO tenant_skills
        (id, tenant_id, workspace_id, skill_id, source_skill_id, name, description, applicable_agents, inputs, steps, quality_checks, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, skill_id) DO UPDATE SET
         source_skill_id = excluded.source_skill_id,
         name = excluded.name,
         description = excluded.description,
         applicable_agents = excluded.applicable_agents,
         inputs = excluded.inputs,
         steps = excluded.steps,
         quality_checks = excluded.quality_checks,
         status = excluded.status,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        normalized.id,
        normalized.tenant_id,
        normalized.workspace_id,
        normalized.skill_id,
        normalized.source_skill_id,
        normalized.name,
        normalized.description,
        json(normalized.applicable_agents),
        json(normalized.inputs),
        json(normalized.steps),
        json(normalized.quality_checks),
        normalized.status,
        normalized.created_by,
        normalized.updated_by
      ]
    );
    const skill = this.getSkill(normalized.tenant_id, normalized.workspace_id, normalized.skill_id);
    this.runStore?.audit?.(normalized.tenant_id, 'skill.tenant_upserted', 'tenant_skill', skill.id, {
      skill_id: skill.skill_id,
      status: skill.status,
      source_skill_id: skill.source_skill_id
    }, normalized.updated_by);
    return skill;
  }

  getSkill(tenantId: string, workspaceId: string, skillId: string): JsonRecord | null {
    const row = one(
      this.db,
      'SELECT * FROM tenant_skills WHERE tenant_id = ? AND workspace_id = ? AND skill_id = ?',
      [tenantId, workspaceId, skillId]
    );
    return row ? decodeSkill(row) : null;
  }

  listSkills({ tenant_id, workspace_id = 'default', status = null, applicable_agent = null }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_skills WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`,
      params
    )
      .map(decodeSkill)
      .filter((skill) => !applicable_agent || skill.applicable_agents.includes(applicable_agent));
  }

  proposeCandidate(input: JsonRecord): JsonRecord | null {
    const normalized = normalizeSkillInput(this.integrationCatalog, input, {
      skill_id: input.proposed_skill_id || input.skill_id
    });
    const candidate = {
      id: id('skillcand'),
      tenant_id: normalized.tenant_id,
      workspace_id: normalized.workspace_id,
      proposed_skill_id: normalized.skill_id,
      source_skill_id: normalized.source_skill_id,
      name: normalized.name,
      description: normalized.description,
      applicable_agents: normalized.applicable_agents,
      inputs: normalized.inputs,
      steps: normalized.steps,
      quality_checks: normalized.quality_checks,
      evidence: input.evidence || {},
      status: 'candidate',
      proposed_by: input.proposed_by || input.actor_id || 'system'
    };
    run(
      this.db,
      `INSERT INTO tenant_skill_candidates
        (id, tenant_id, workspace_id, proposed_skill_id, source_skill_id, name, description, applicable_agents, inputs, steps, quality_checks, evidence, status, proposed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidate.id,
        candidate.tenant_id,
        candidate.workspace_id,
        candidate.proposed_skill_id,
        candidate.source_skill_id,
        candidate.name,
        candidate.description,
        json(candidate.applicable_agents),
        json(candidate.inputs),
        json(candidate.steps),
        json(candidate.quality_checks),
        json(candidate.evidence),
        candidate.status,
        candidate.proposed_by
      ]
    );
    this.runStore?.audit?.(candidate.tenant_id, 'skill.candidate_proposed', 'tenant_skill_candidate', candidate.id, {
      proposed_skill_id: candidate.proposed_skill_id,
      source_skill_id: candidate.source_skill_id
    }, candidate.proposed_by);
    return this.getCandidate(candidate.tenant_id, candidate.id);
  }

  getCandidate(tenantId: string, candidateId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM tenant_skill_candidates WHERE tenant_id = ? AND id = ?', [tenantId, candidateId]);
    return row ? decodeCandidate(row) : null;
  }

  listCandidates({ tenant_id, workspace_id = 'default', status = 'candidate' }: JsonRecord): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM tenant_skill_candidates
       WHERE tenant_id = ? AND workspace_id = ? AND status = ?
       ORDER BY created_at DESC`,
      [tenant_id, workspace_id, status]
    ).map(decodeCandidate);
  }

  reviewCandidate({ tenant_id, candidate_id, decision, actor_id = 'system', activate_status = 'active' }: JsonRecord): JsonRecord {
    const candidate = this.getCandidate(tenant_id, candidate_id);
    if (!candidate) throw new Error(`skill candidate not found: ${candidate_id}`);
    if (!['approve', 'reject'].includes(decision)) throw new Error('decision must be approve or reject');
    const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
    run(
      this.db,
      `UPDATE tenant_skill_candidates
       SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [nextStatus, actor_id, tenant_id, candidate_id]
    );
    let skill = null;
    if (decision === 'approve') {
      skill = this.upsertSkill({
        tenant_id,
        workspace_id: candidate.workspace_id,
        skill_id: candidate.proposed_skill_id,
        source_skill_id: candidate.source_skill_id,
        name: candidate.name,
        description: candidate.description,
        applicable_agents: candidate.applicable_agents,
        inputs: candidate.inputs,
        steps: candidate.steps,
        quality_checks: candidate.quality_checks,
        status: activate_status,
        created_by: candidate.proposed_by,
        updated_by: actor_id
      });
    }
    this.runStore?.audit?.(tenant_id, `skill.candidate_${nextStatus}`, 'tenant_skill_candidate', candidate_id, {
      decision,
      activated_skill_id: skill?.skill_id || null
    }, actor_id);
    return { candidate: this.getCandidate(tenant_id, candidate_id), skill };
  }

  buildPack({ tenantId, workspaceId = 'default', agentId }: JsonRecord): JsonRecord[] {
    return this.listSkills({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      status: 'active',
      applicable_agent: agentId
    }).map((skill) => ({
      skill_id: skill.skill_id,
      name: skill.name,
      description: skill.description,
      source_skill_id: skill.source_skill_id,
      inputs: skill.inputs,
      quality_checks: skill.quality_checks
    }));
  }
}

function normalizeSkillInput(integrationCatalog: IntegrationCatalogLike, input: JsonRecord, overrides: JsonRecord = {}): JsonRecord {
  const workspaceId = input.workspace_id || 'default';
  const sourceSkillId = input.source_skill_id || '';
  const sourceSkill = sourceSkillId ? integrationCatalog.get(sourceSkillId) : null;
  if (sourceSkill && sourceSkill.source_type !== 'skill') {
    throw new Error(`source skill must reference a catalog skill entry: ${sourceSkillId}`);
  }
  const skillId = overrides.skill_id || input.skill_id || sourceSkillId || `skill.${Date.now()}`;
  const skill = {
    id: input.id || id('tskill'),
    tenant_id: input.tenant_id,
    workspace_id: workspaceId,
    skill_id: skillId,
    source_skill_id: sourceSkillId,
    name: input.name || sourceSkill?.name || skillId,
    description: input.description || sourceSkill?.recommended_use || '',
    applicable_agents: input.applicable_agents || inferApplicableAgents(sourceSkill, input.applicable_agents),
    inputs: input.inputs || [],
    steps: input.steps || [],
    quality_checks: input.quality_checks || [],
    status: input.status || 'draft',
    created_by: input.created_by || input.actor_id || 'system',
    updated_by: input.updated_by || input.actor_id || 'system'
  };
  if (!skill.tenant_id) throw new Error('tenant_id is required');
  if (!skill.skill_id) throw new Error('skill_id is required');
  if (!skill.name) throw new Error('skill name is required');
  return skill;
}

function inferApplicableAgents(sourceSkill: IntegrationCatalogEntry | null, explicit: string[] | null | undefined): string[] {
  if (explicit) return explicit;
  if (!sourceSkill) return [];
  if (sourceSkill.id === 'skill.lead_qualification') return ['orchestration_agent', 'crm_agent'];
  if (sourceSkill.id === 'skill.crm_followup') return ['crm_agent', 'orchestration_agent'];
  if (sourceSkill.id === 'skill.weekly_review') return ['analytics_agent', 'orchestration_agent'];
  return [];
}

function decodeSkill(row: JsonRecord): JsonRecord {
  return {
    ...row,
    applicable_agents: parseJson(row.applicable_agents, []),
    inputs: parseJson(row.inputs, []),
    steps: parseJson(row.steps, []),
    quality_checks: parseJson(row.quality_checks, [])
  };
}

function decodeCandidate(row: JsonRecord): JsonRecord {
  return {
    ...row,
    applicable_agents: parseJson(row.applicable_agents, []),
    inputs: parseJson(row.inputs, []),
    steps: parseJson(row.steps, []),
    quality_checks: parseJson(row.quality_checks, []),
    evidence: parseJson(row.evidence)
  };
}
