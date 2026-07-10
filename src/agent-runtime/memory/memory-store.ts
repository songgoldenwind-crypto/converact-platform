import { all, id, json, one, parseJson, run } from '../../db.js';
import type { AgentDescriptor, BusinessContext, MemoryEntryRow, MemoryPack, MemorySummary, RetrievalScope } from '../context/runtime-types.js';

const ACTIVE_STATUSES = new Set(['active']);
const MEMORY_STATUSES = new Set(['active', 'stale', 'contradicted', 'superseded', 'archived']);
const SCOPE_RANK = {
  lead: 100,
  customer: 95,
  lead_acquisition_run: 88,
  campaign: 80,
  task: 76,
  call: 74,
  workflow: 72,
  workspace: 70,
  agent: 60,
  tenant: 50,
  skill: 40
};
const TYPE_RANK: Record<string, number> = {
  open_loop: 14,
  condition: 12,
  preference: 10,
  fact: 8,
  profile: 7,
  learning: 6,
  summary: 4,
  skill: 3
};

// ── New scoring engine (v2) ──────────────────────────────
const DEFAULT_SCORE_CONFIG = {
  halfLifeMs: Number(process.env.OPC_MEMORY_HALF_LIFE_DAYS || 7) * 86_400_000,
  alpha: Number(process.env.OPC_MEMORY_EFFECTIVE_AGE_ALPHA || 0.1),
  beta: Number(process.env.OPC_MEMORY_RECALL_BOOST_BETA || 2.0),
  archiveThreshold: Number(process.env.OPC_MEMORY_ARCHIVE_THRESHOLD || 0.05)
};

export interface MemoryScore {
  recency: number;
  importance: number;
  relevance: number;
  recallBoost: number;
  composite: number;
}

export function computeMemoryScore(
  entry: MemoryEntryRow,
  scopes: RetrievalScope[],
  query: string,
  config = DEFAULT_SCORE_CONFIG
): MemoryScore {
  const recency = computeRecencyScore(entry, config);
  const importance = entry.importance_score ?? 0.5;
  const relevance = computeRelevanceScore(entry, scopes, query);
  const recallBoost = Math.log1p(entry.recall_count || 0) * config.beta;
  const normalizedRecallBoost = Math.min(1.0, recallBoost / 10);
  const composite = recency * importance * relevance * (1 + normalizedRecallBoost);
  return { recency, importance, relevance, recallBoost: normalizedRecallBoost, composite };
}

export function computeRecencyScore(entry: MemoryEntryRow, config: typeof DEFAULT_SCORE_CONFIG): number {
  const anchor = entry.effective_known_at || entry.known_at || entry.occurred_at || entry.created_at || '';
  const ts = Date.parse(anchor);
  if (!ts || Number.isNaN(ts)) return 1.0;
  const ageMs = Math.max(0, Date.now() - ts);
  const effectiveAgeMs = ageMs / (1 + (entry.recall_count || 0) * config.alpha);
  return Math.max(0, Math.exp(-Math.LN2 * effectiveAgeMs / config.halfLifeMs));
}

export function computeRelevanceScore(entry: MemoryEntryRow, scopes: RetrievalScope[], query: string): number {
  const matchedScope = scopes.find((s) => entry.scope_type === s.scope_type && String(entry.scope_id || '') === String(s.scope_id || ''));
  const scopeScore = matchedScope ? (SCOPE_RANK[matchedScope.scope_type] || 10) / 100 : 0.1;
  const queryScore = scoreQuerySignals(entry, query).score / 100;
  const typeScore = TYPE_RANK[entry.memory_type] ? TYPE_RANK[entry.memory_type] / 14 : 0;
  const sourceScore = entry.evidence_object_id || (entry.source_refs || []).length ? 0.5 : 0;
  const freshnessBonus = entry.supersedes_memory_id ? 0.3 : 0;
  const raw = scopeScore * 0.3 + queryScore * 0.4 + typeScore * 0.15 + sourceScore * 0.1 + freshnessBonus * 0.05;
  return Math.min(1.0, raw);
}

interface CacheEntry {
  pack: MemoryPack;
  expiresAt: number;
}

export class MemoryStore {
  db: unknown;
  runStore: {
    audit?: (tenantId: string, action: string, objectType: string, objectId: string, metadata?: Record<string, unknown>) => void;
  } | null;
  private _packCache: Map<string, CacheEntry>;
  private _cacheTtlMs: number;

  constructor(
    db: unknown,
    runStore: {
      audit?: (tenantId: string, action: string, objectType: string, objectId: string, metadata?: Record<string, unknown>) => void;
    } | null = null,
    cacheTtlMs = 5000
  ) {
    this.db = db;
    this.runStore = runStore;
    this._packCache = new Map();
    this._cacheTtlMs = cacheTtlMs;
  }

  write(input: {
    tenant_id: string;
    scope_type?: string;
    scope_id?: string;
    memory_type?: string;
    content: string;
    entity_key?: string;
    fact_key?: string;
    evidence_object_type?: string;
    evidence_object_id?: string;
    evidence_refs?: unknown[];
    source_refs?: unknown[];
    confidence?: number;
    status?: string;
    occurred_at?: string | null;
    known_at?: string | null;
    valid_from?: string | null;
    valid_to?: string | null;
    supersedes_memory_id?: string | null;
    superseded_by_memory_id?: string | null;
    contradiction_group_id?: string;
    protected?: number;
    summary_parent_id?: string | null;
    effective_known_at?: string | null;
    importance_score?: number;
    metadata?: Record<string, unknown>;
  }): MemoryEntryRow | null {
    const firstEvidence = Array.isArray(input.evidence_refs) ? input.evidence_refs[0] as Record<string, unknown> | undefined : undefined;
    const entry = {
      id: id('mem'),
      tenant_id: input.tenant_id,
      scope_type: input.scope_type || 'tenant',
      scope_id: input.scope_id || '',
      memory_type: input.memory_type || 'fact',
      content: input.content,
      entity_key: input.entity_key || inferEntityKey(input.scope_type || 'tenant', input.scope_id || '', input.content),
      fact_key: input.fact_key || inferFactKey(input.memory_type || 'fact', input.content),
      evidence_object_type: input.evidence_object_type || String(firstEvidence?.object_type || ''),
      evidence_object_id: input.evidence_object_id || String(firstEvidence?.object_id || ''),
      source_refs: input.source_refs || input.evidence_refs || [],
      confidence: input.confidence ?? 1,
      status: input.status || 'active',
      occurred_at: input.occurred_at || null,
      known_at: input.known_at || null,
      valid_from: input.valid_from || input.occurred_at || null,
      valid_to: input.valid_to || null,
      supersedes_memory_id: input.supersedes_memory_id || null,
      superseded_by_memory_id: input.superseded_by_memory_id || null,
      contradiction_group_id: input.contradiction_group_id || '',
      protected: input.protected ?? (input.memory_type === 'preference' || input.memory_type === 'condition' ? 1 : 0),
      summary_parent_id: input.summary_parent_id || '',
      effective_known_at: input.effective_known_at || input.known_at || input.occurred_at || new Date().toISOString(),
      importance_score: input.importance_score ?? 0.5,
      metadata: input.metadata || {}
    };
    if (!MEMORY_STATUSES.has(entry.status)) throw new Error(`unsupported memory status: ${entry.status}`);
    run(
      this.db,
      `INSERT INTO memory_entries
        (id, tenant_id, scope_type, scope_id, memory_type, content, entity_key, fact_key,
         evidence_object_type, evidence_object_id, source_refs, confidence, status,
         occurred_at, known_at, valid_from, valid_to, supersedes_memory_id, superseded_by_memory_id,
         contradiction_group_id, protected, summary_parent_id, effective_known_at, importance_score, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.tenant_id,
        entry.scope_type,
        entry.scope_id,
        entry.memory_type,
        entry.content,
        entry.entity_key,
        entry.fact_key,
        entry.evidence_object_type,
        entry.evidence_object_id,
        json(entry.source_refs),
        entry.confidence,
        entry.status,
        entry.occurred_at,
        entry.known_at,
        entry.valid_from,
        entry.valid_to,
        entry.supersedes_memory_id,
        entry.superseded_by_memory_id,
        entry.contradiction_group_id,
        entry.protected,
        entry.summary_parent_id,
        entry.effective_known_at,
        entry.importance_score,
        json(entry.metadata)
      ]
    );
    this.runStore?.audit(entry.tenant_id, 'memory.write', 'memory_entry', entry.id, {
      scope_type: entry.scope_type,
      memory_type: entry.memory_type
    });
    this.invalidatePackCache(entry.tenant_id);
    return this.get(entry.tenant_id, entry.id);
  }

  get(tenantId: string, memoryId: string): MemoryEntryRow | null {
    const row = one(this.db, 'SELECT * FROM memory_entries WHERE tenant_id = ? AND id = ?', [tenantId, memoryId]);
    return row ? decodeMemory(row) : null;
  }

  updateStatus(tenantId: string, memoryId: string, status: string, metadata: Record<string, unknown> = {}): MemoryEntryRow | null {
    if (!MEMORY_STATUSES.has(status)) throw new Error(`unsupported memory status: ${status}`);
    const memory = this.get(tenantId, memoryId);
    if (!memory) throw new Error(`memory not found: ${memoryId}`);
    run(
      this.db,
      `UPDATE memory_entries
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [status, tenantId, memoryId]
    );
    this.runStore?.audit(tenantId, `memory.${status}`, 'memory_entry', memoryId, metadata);
    this.invalidatePackCache(tenantId);
    return this.get(tenantId, memoryId);
  }

  updateImportance(tenantId: string, memoryId: string, importanceScore: number): MemoryEntryRow | null {
    const memory = this.get(tenantId, memoryId);
    if (!memory) throw new Error(`memory not found: ${memoryId}`);
    run(
      this.db,
      `UPDATE memory_entries
       SET importance_score = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [importanceScore, tenantId, memoryId]
    );
    this.runStore?.audit(tenantId, 'memory.importance_updated', 'memory_entry', memoryId, {
      old_score: memory.importance_score,
      new_score: importanceScore
    });
    this.invalidatePackCache(tenantId);
    return this.get(tenantId, memoryId);
  }

  updateSummaryParent(tenantId: string, memoryId: string, summaryParentId: string): MemoryEntryRow | null {
    const memory = this.get(tenantId, memoryId);
    if (!memory) throw new Error(`memory not found: ${memoryId}`);
    run(
      this.db,
      `UPDATE memory_entries
       SET summary_parent_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [summaryParentId, tenantId, memoryId]
    );
    this.invalidatePackCache(tenantId);
    return this.get(tenantId, memoryId);
  }

  supersede(tenantId: string, oldMemoryId: string, newMemoryId: string, reason = 'newer memory approved'): MemoryEntryRow | null {
    const oldMemory = this.get(tenantId, oldMemoryId);
    const newMemory = this.get(tenantId, newMemoryId);
    if (!oldMemory) throw new Error(`memory not found: ${oldMemoryId}`);
    if (!newMemory) throw new Error(`new memory not found: ${newMemoryId}`);
    run(
      this.db,
      `UPDATE memory_entries
       SET status = 'superseded',
           superseded_by_memory_id = ?,
           contradiction_group_id = CASE WHEN contradiction_group_id = '' THEN ? ELSE contradiction_group_id END,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [newMemoryId, newMemory.contradiction_group_id || oldMemory.contradiction_group_id || id('memgrp'), tenantId, oldMemoryId]
    );
    this.runStore?.audit(tenantId, 'memory.superseded', 'memory_entry', oldMemoryId, {
      superseded_by_memory_id: newMemoryId,
      reason
    });
    this.invalidatePackCache(tenantId);
    return this.get(tenantId, oldMemoryId);
  }

  search({
    tenant_id,
    scope_type = null,
    scope_id = null,
    memory_type = null,
    status = 'active',
    limit = 20
  }: {
    tenant_id: string;
    scope_type?: string | null;
    scope_id?: string | null;
    memory_type?: string | null;
    status?: string | null;
    limit?: number;
  }): MemoryEntryRow[] {
    const conditions = [`tenant_id = ?`];
    const params: Array<string | number> = [tenant_id];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (scope_type) {
      conditions.push('scope_type = ?');
      params.push(scope_type);
    }
    if (scope_id !== null && scope_id !== undefined) {
      conditions.push('scope_id = ?');
      params.push(scope_id);
    }
    if (memory_type) {
      conditions.push('memory_type = ?');
      params.push(memory_type);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM memory_entries
       WHERE ${conditions.join(' AND ')}
         ORDER BY importance_score DESC, effective_known_at DESC
       LIMIT ?`,
       params
      ).map(decodeMemory);
  }

  retrieve(input: {
    tenant_id: string;
    query?: string;
    scopes?: RetrievalScope[];
    memory_type?: string | null;
    status?: string;
    scan_limit?: number;
    limit?: number;
  }): {
    tenant_id: string;
    query: string;
    scopes: RetrievalScope[];
    memories: MemorySummary[];
  } {
    const query = input.query || '';
    const scopes = dedupeScopes(input.scopes || []);
    const scanLimit = input.scan_limit || 200;
    const resultLimit = input.limit || 20;

    // Fast path: use SQL scope filter when scopes are provided (avoids JS-level scan)
    // If query is non-empty, add SQL content LIKE pre-filter for text-heavy tenants
    const candidates = scopes.length
      ? this._retrieveScoped(input.tenant_id, scopes, input.memory_type || null, input.status || 'active', scanLimit, query)
      : this._searchWithQueryFilter({
          tenant_id: input.tenant_id,
          memory_type: input.memory_type || null,
          status: input.status || 'active',
          limit: scanLimit,
          query
        });

    const ranked = candidates
      .filter((entry) => ACTIVE_STATUSES.has(entry.status))
      .filter((entry) => scopeMatches(entry, scopes))
      .map((entry) => {
        const ranking = rankMemory(entry, scopes, query);
        return { ...entry, rank_score: ranking.score, rank_reason: ranking.reason, recall_path: ranking.path };
      })
      .sort((a, b) => b.rank_score - a.rank_score || b.effective_known_at?.localeCompare(a.effective_known_at || '') || b.created_at.localeCompare(a.created_at))
      .slice(0, resultLimit);

    return {
      tenant_id: input.tenant_id,
      query,
      scopes,
      memories: ranked.map(toMemorySummary)
    };
  }

  /** SQL-level scoped retrieval: pushes scope matching to the database */
  private _retrieveScoped(
    tenantId: string,
    scopes: RetrievalScope[],
    memoryType: string | null,
    status: string,
    limit: number,
    query = ''
  ): MemoryEntryRow[] {
    const scopeConditions = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    const conditions = [`tenant_id = ?`, `status = ?`, `(${scopeConditions})`];
    const params: Array<string | number> = [tenantId, status];
    for (const scope of scopes) {
      params.push(scope.scope_type, scope.scope_id || '');
    }
    if (memoryType) {
      conditions.push('memory_type = ?');
      params.push(memoryType);
    }
    const tokens = tokenize(query);
    if (tokens.length) {
      conditions.push(`(${tokens.map(() => 'LOWER(content) LIKE ? OR LOWER(entity_key) LIKE ? OR LOWER(fact_key) LIKE ?').join(' OR ')})`);
      for (const token of tokens) params.push(`%${token}%`, `%${token}%`, `%${token}%`);
    }
    params.push(limit);

    return all(
      this.db,
      `SELECT * FROM memory_entries
       WHERE ${conditions.join(' AND ')}
       ORDER BY importance_score DESC, effective_known_at DESC
       LIMIT ?`,
      params
    ).map(decodeMemory);
  }

  /** SQL-level search with optional content/entity/fact LIKE pre-filter for text-heavy tenants */
  private _searchWithQueryFilter(input: {
    tenant_id: string;
    memory_type: string | null;
    status: string;
    limit: number;
    query: string;
  }): MemoryEntryRow[] {
    const conditions = ['tenant_id = ?', 'status = ?'];
    const params: Array<string | number> = [input.tenant_id, input.status];
    if (input.memory_type) {
      conditions.push('memory_type = ?');
      params.push(input.memory_type);
    }
    const tokens = tokenize(input.query);
    if (tokens.length) {
      conditions.push(`(${tokens.map(() => 'LOWER(content) LIKE ? OR LOWER(entity_key) LIKE ? OR LOWER(fact_key) LIKE ?').join(' OR ')})`);
      for (const token of tokens) params.push(`%${token}%`, `%${token}%`, `%${token}%`);
    }
    params.push(input.limit);

    return all(
      this.db,
      `SELECT * FROM memory_entries
       WHERE ${conditions.join(' AND ')}
       ORDER BY importance_score DESC, effective_known_at DESC
       LIMIT ?`,
      params
    ).map(decodeMemory);
  }

  buildPack({
    tenantId,
    workspaceId = 'default',
    agent = null,
    businessContext = {}
  }: {
    tenantId: string;
    workspaceId?: string;
    agent?: AgentDescriptor | null;
    businessContext?: BusinessContext;
  }): MemoryPack {
    const cacheKey = `pack:${tenantId}:${workspaceId}:${agent?.agent_id || ''}:${JSON.stringify(businessContext)}`;
    const cached = this._packCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.pack;
    }

    const scopes = buildRetrievalScopes({ workspaceId, agentId: agent?.agent_id, businessContext });
    const ranked = this.retrieve({ tenant_id: tenantId, scopes, limit: 30 }).memories;
    const skills = this.retrieve({
      tenant_id: tenantId,
      scopes: [{ scope_type: 'skill', scope_id: '' }],
      limit: 5
    }).memories;

    // Drill-down: for summary memories, fetch supporting archived children
    const facts = ranked.filter((entry) => ['fact', 'preference', 'summary'].includes(entry.memory_type));
    const summaryIds = facts.filter((entry) => entry.memory_type === 'summary').map((entry) => entry.id);
    const drillDownMap = this._buildDrillDownMap(tenantId, summaryIds);

    const pack: MemoryPack = {
      facts: facts.map((entry) => ({
        ...entry,
        drill_down_memories: entry.memory_type === 'summary' ? (drillDownMap.get(entry.id) || []) : undefined
      })),
      learnings: ranked.filter((entry) => entry.memory_type === 'learning'),
      skills,
      conditions: ranked.filter((entry) => entry.memory_type === 'condition'),
      openLoops: ranked.filter((entry) => entry.memory_type === 'open_loop'),
      profiles: ranked.filter((entry) => entry.memory_type === 'profile')
    };

    this._packCache.set(cacheKey, { pack, expiresAt: Date.now() + this._cacheTtlMs });
    return pack;
  }

  /** Invalidate pack cache for a tenant */
  invalidatePackCache(tenantId?: string): void {
    if (!tenantId) {
      this._packCache.clear();
      return;
    }
    const prefix = `pack:${tenantId}:`;
    for (const key of this._packCache.keys()) {
      if (key.startsWith(prefix)) this._packCache.delete(key);
    }
  }

  /** Build drill-down map: summary_id -> supporting archived memories */
  private _buildDrillDownMap(tenantId: string, summaryIds: string[]): Map<string, MemorySummary[]> {
    if (!summaryIds.length) return new Map();
    const placeholders = summaryIds.map(() => '?').join(',');
    const rows = all(
      this.db,
      `SELECT * FROM memory_entries
       WHERE tenant_id = ? AND status = 'archived' AND summary_parent_id IN (${placeholders})
       ORDER BY confidence DESC, created_at DESC`,
      [tenantId, ...summaryIds]
    );
    const map = new Map<string, MemorySummary[]>();
    for (const row of rows) {
      const entry = decodeMemory(row);
      const parentId = entry.summary_parent_id;
      if (!parentId) continue;
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId)!.push(toMemorySummary(entry));
    }
    return map;
  }

  findActiveConflicts(input: {
    tenant_id: string;
    scope_type: string;
    scope_id?: string;
    memory_type?: string;
    entity_key?: string;
    fact_key?: string;
    exclude_memory_id?: string;
  }): MemoryEntryRow[] {
    const conditions = ['tenant_id = ?', 'status = ?', 'scope_type = ?', 'scope_id = ?'];
    const params: Array<string | number> = [input.tenant_id, 'active', input.scope_type, input.scope_id || ''];
    if (input.entity_key) {
      conditions.push('entity_key = ?');
      params.push(input.entity_key);
    }
    if (input.fact_key) {
      conditions.push('fact_key = ?');
      params.push(input.fact_key);
    }
    if (!input.fact_key && input.memory_type) {
      conditions.push('memory_type = ?');
      params.push(input.memory_type);
    }
    if (input.exclude_memory_id) {
      conditions.push('id != ?');
      params.push(input.exclude_memory_id);
    }
    return all(
      this.db,
      `SELECT * FROM memory_entries WHERE ${conditions.join(' AND ')} ORDER BY confidence DESC, created_at DESC`,
      params
    ).map(decodeMemory);
  }

  synthesizeProfile(input: {
    tenant_id: string;
    scope_type?: string;
    scope_id?: string;
    source_memory_ids?: string[];
    actor_id?: string;
  }): MemoryEntryRow | null {
    const scopeType = input.scope_type || 'tenant';
    const scopeId = input.scope_id || '';
    const memories = this.search({
      tenant_id: input.tenant_id,
      scope_type: scopeType,
      scope_id: scopeId,
      status: 'active',
      limit: 200
    }).filter((memory) => memory.memory_type !== 'profile');
    if (!memories.length) throw new Error('profile synthesis requires active source memories');
    const selectedIds = new Set(input.source_memory_ids || []);
    const sources = selectedIds.size ? memories.filter((memory) => selectedIds.has(memory.id)) : memories;
    if (!sources.length) throw new Error('profile synthesis source memories were not found');
    const content = buildProfileContent(scopeType, scopeId, sources);
    const existingProfiles = this.search({
      tenant_id: input.tenant_id,
      scope_type: scopeType,
      scope_id: scopeId,
      memory_type: 'profile',
      status: 'active',
      limit: 20
    });
    const profile = this.write({
      tenant_id: input.tenant_id,
      scope_type: scopeType,
      scope_id: scopeId,
      memory_type: 'profile',
      content,
      entity_key: inferEntityKey(scopeType, scopeId, content),
      fact_key: `profile:${scopeType}`,
      confidence: average(sources.map((memory) => Number(memory.confidence || 0))) || 0.8,
      source_refs: sources.map((memory) => ({ object_type: 'memory_entry', object_id: memory.id })),
      supersedes_memory_id: existingProfiles[0]?.id || null,
      metadata: {
        source_memory_ids: sources.map((memory) => memory.id),
        synthesized_by: input.actor_id || 'system'
      }
    });
    for (const oldProfile of existingProfiles) {
      this.supersede(input.tenant_id, oldProfile.id, profile?.id || '', 'profile resynthesized');
    }
    return profile;
  }
}

function toMemorySummary(entry: MemoryEntryRow): MemorySummary {
  return {
    id: entry.id,
    scope_type: entry.scope_type,
    scope_id: entry.scope_id,
    memory_type: entry.memory_type,
    content: entry.content,
    entity_key: entry.entity_key || '',
    fact_key: entry.fact_key || '',
    confidence: entry.confidence,
    status: entry.status,
    rank_score: entry.rank_score ?? null,
    rank_reason: entry.rank_reason || '',
    recall_path: entry.recall_path || [],
    evidence: entry.evidence_object_type
      ? { object_type: entry.evidence_object_type, object_id: entry.evidence_object_id }
      : null,
    source_refs: entry.source_refs || [],
    temporal: {
      occurred_at: entry.occurred_at || null,
      known_at: entry.known_at || null,
      valid_from: entry.valid_from || null,
      valid_to: entry.valid_to || null
    },
    lineage: {
      supersedes_memory_id: entry.supersedes_memory_id || null,
      superseded_by_memory_id: entry.superseded_by_memory_id || null,
      contradiction_group_id: entry.contradiction_group_id || ''
    }
  };
}

export function buildRetrievalScopes({
  workspaceId = 'default',
  agentId = '',
  businessContext = {}
}: {
  workspaceId?: string;
  agentId?: string;
  businessContext?: BusinessContext;
} = {}): RetrievalScope[] {
  const scopes: RetrievalScope[] = [{ scope_type: 'tenant', scope_id: '' }];
  if (workspaceId) scopes.push({ scope_type: 'workspace', scope_id: workspaceId });
  if (agentId) scopes.push({ scope_type: 'agent', scope_id: agentId });
  if (businessContext.campaign_id) scopes.push({ scope_type: 'campaign', scope_id: businessContext.campaign_id });
  if (businessContext.customer_id) scopes.push({ scope_type: 'customer', scope_id: businessContext.customer_id });
  if (businessContext.lead_id) scopes.push({ scope_type: 'lead', scope_id: businessContext.lead_id });
  if (businessContext.object_type && businessContext.object_id) {
    scopes.push({ scope_type: businessContext.object_type, scope_id: businessContext.object_id });
  }
  return dedupeScopes(scopes);
}

function scopeMatches(entry: MemoryEntryRow, scopes: RetrievalScope[]): boolean {
  if (!scopes.length) return true;
  return scopes.some((scope) => entry.scope_type === scope.scope_type && String(entry.scope_id || '') === String(scope.scope_id || ''));
}

function rankMemory(entry: MemoryEntryRow, scopes: RetrievalScope[], query = ''): { score: number; reason: string; path: string[] } {
  const matchedScope = scopes.find((scope) => entry.scope_type === scope.scope_type && String(entry.scope_id || '') === String(scope.scope_id || ''));
  const scopeScore = SCOPE_RANK[matchedScope?.scope_type || entry.scope_type] || 10;
  const confidenceScore = Number(entry.confidence || 0) * 20;
  const importanceScore = (entry.importance_score ?? 0.5) * 20;
  const typeScore = TYPE_RANK[entry.memory_type] || 2;
  const querySignals = scoreQuerySignals(entry, query);
  const temporalScore = scoreTemporal(entry);
  const sourceScore = entry.evidence_object_id || (entry.source_refs || []).length ? 5 : 0;
  const lifecycleScore = entry.supersedes_memory_id ? 4 : 0;
  const score = scopeScore + confidenceScore + importanceScore + typeScore + querySignals.score + temporalScore + sourceScore + lifecycleScore;
  const path = [
    matchedScope ? `scope:${matchedScope.scope_type}` : 'scope:global',
    entry.entity_key ? 'entity' : '',
    entry.fact_key ? 'fact-key' : '',
    entry.memory_type ? `type:${entry.memory_type}` : '',
    querySignals.path,
    temporalScore ? 'temporal' : '',
    sourceScore ? 'source' : '',
    lifecycleScore ? 'lineage' : '',
    'rerank'
  ].filter(Boolean);
  const reason = [
    matchedScope ? `${matchedScope.scope_type}:${matchedScope.scope_id || 'default'} matched` : 'global scan',
    `confidence=${entry.confidence}`,
    `importance=${entry.importance_score}`,
    `type=${entry.memory_type}`,
    querySignals.reason,
    temporalScore ? `temporal_boost=${temporalScore}` : '',
    sourceScore ? 'has_source' : '',
    lifecycleScore ? 'supersedes_prior' : ''
  ].filter(Boolean).join('; ');
  return { score, reason, path };
}

function dedupeScopes(scopes: RetrievalScope[]): RetrievalScope[] {
  const seen = new Set();
  return scopes.filter((scope) => {
    if (!scope.scope_type) return false;
    const key = `${scope.scope_type}:${scope.scope_id || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decodeMemory(row: Record<string, unknown>): MemoryEntryRow {
  return {
    ...(row as unknown as MemoryEntryRow),
    source_refs: parseJson(String(row.source_refs || '[]'), []),
    metadata: parseJson(String(row.metadata || '{}'), {}),
    confidence: Number(row.confidence || 0),
    recall_count: Number(row.recall_count || 0),
    importance_score: Number(row.importance_score ?? 0.5),
    protected: Number(row.protected ?? 0),
    summary_parent_id: String(row.summary_parent_id || ''),
    effective_known_at: row.effective_known_at ? String(row.effective_known_at) : null
  };
}

function scoreQuerySignals(entry: MemoryEntryRow, query: string): { score: number; reason: string; path: string } {
  const tokens = tokenize(query);
  if (!tokens.length) return { score: 0, reason: '', path: '' };
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const contentTokens = tokenize(entry.content);
  const entityTokens = tokenize(entry.entity_key);
  const factTokens = tokenize(entry.fact_key);
  const typeTokens = tokenize(entry.memory_type);
  const contentExact = tokens.filter((token) => contentTokens.includes(token)).length;
  const contentNgram = tokens.filter((token) => contentTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))).length - contentExact;
  const entityExact = tokens.filter((token) => entityTokens.includes(token)).length;
  const factExact = tokens.filter((token) => factTokens.includes(token)).length;
  const typeExact = tokens.filter((token) => typeTokens.includes(token)).length;
  const entityPhrase = structuredKeyMatches(entry.entity_key, normalizedQuery);
  const factPhrase = structuredKeyMatches(entry.fact_key, normalizedQuery);
  const score = Math.max(0,
    contentExact * 10 +
    Math.max(0, contentNgram) * 3 +
    entityExact * 12 +
    factExact * 8 +
    typeExact * 5 +
    (entityPhrase ? 12 : 0) +
    (factPhrase ? 8 : 0)
  );
  const parts: string[] = [];
  if (contentExact) parts.push(`query_exact=${contentExact}`);
  if (contentNgram > 0) parts.push(`query_ngram=${contentNgram}`);
  if (entityExact) parts.push(`entity_match=${entityExact}`);
  if (factExact) parts.push(`fact_match=${factExact}`);
  if (entityPhrase) parts.push('entity_phrase=1');
  if (factPhrase) parts.push('fact_phrase=1');
  if (typeExact) parts.push(`type_match=${typeExact}`);
  return {
    score,
    reason: parts.length ? parts.join(', ') : 'query_no_match',
    path: score ? 'query' : ''
  };
}

function structuredKeyMatches(value: string, normalizedQuery: string): boolean {
  if (normalizedQuery.length < 2) return false;
  const normalizedValue = String(value || '').trim().toLowerCase();
  return normalizedValue === normalizedQuery || normalizedValue.split(':').includes(normalizedQuery);
}

function scoreTemporal(entry: MemoryEntryRow): number {
  const anchor = entry.known_at || entry.occurred_at || entry.updated_at || entry.created_at || '';
  const timestamp = Date.parse(anchor);
  if (!timestamp || Number.isNaN(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  if (ageDays <= 7) return 6;
  if (ageDays <= 30) return 4;
  if (ageDays <= 90) return 2;
  return 0;
}

function tokenize(value: string): string[] {
  const raw = String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const expanded = new Set<string>();
  for (const token of raw) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)) {
      // Bigram CJK tokens so long Chinese phrases still match memory substrings
      for (let i = 0; i < token.length - 1; i++) {
        expanded.add(token.slice(i, i + 2));
      }
    } else {
      expanded.add(token);
    }
  }
  return Array.from(expanded);
}

export function inferEntityKey(scopeType: string, scopeId: string, content: string): string {
  if (scopeId) return `${scopeType}:${scopeId}`;
  const normalized = normalizeKey(content).slice(0, 48);
  return normalized ? `${scopeType}:${normalized}` : scopeType;
}

export function inferFactKey(memoryType: string, content: string): string {
  const normalized = normalizeKey(content);
  const prefix = memoryType === 'preference'
    ? 'preference'
    : memoryType === 'condition'
      ? 'condition'
      : memoryType === 'open_loop'
        ? 'open_loop'
        : memoryType === 'profile'
          ? 'profile'
          : 'fact';
  const subject = normalized
    .replace(/^(用户|客户|线索|公司|规则|事实|偏好|以后|后续|记住)/, '')
    .slice(0, 64);
  return `${prefix}:${subject || normalized.slice(0, 64) || 'general'}`;
}

function normalizeKey(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function buildProfileContent(scopeType: string, scopeId: string, memories: MemoryEntryRow[]): string {
  const grouped = {
    preference: memories.filter((memory) => memory.memory_type === 'preference').slice(0, 5),
    condition: memories.filter((memory) => memory.memory_type === 'condition').slice(0, 5),
    fact: memories.filter((memory) => memory.memory_type === 'fact').slice(0, 5),
    open_loop: memories.filter((memory) => memory.memory_type === 'open_loop').slice(0, 5),
    learning: memories.filter((memory) => memory.memory_type === 'learning').slice(0, 5)
  };
  const lines = [`${scopeType}:${scopeId || 'default'} 的长期记忆画像。`];
  if (grouped.preference.length) lines.push(`稳定偏好：${grouped.preference.map((memory) => memory.content).join('；')}`);
  if (grouped.condition.length) lines.push(`长期条件：${grouped.condition.map((memory) => memory.content).join('；')}`);
  if (grouped.fact.length) lines.push(`关键事实：${grouped.fact.map((memory) => memory.content).join('；')}`);
  if (grouped.open_loop.length) lines.push(`未完成线索：${grouped.open_loop.map((memory) => memory.content).join('；')}`);
  if (grouped.learning.length) lines.push(`经验沉淀：${grouped.learning.map((memory) => memory.content).join('；')}`);
  return lines.join('\n');
}

function average(values: number[]): number {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
}
