import { all, id, json, one, parseJson, run } from '../../db.js';
import { inferEntityKey, inferFactKey } from './memory-store.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface MemoryStoreWriter {
  write: (input: JsonRecord) => JsonRecord;
  findActiveConflicts?: (input: JsonRecord) => JsonRecord[];
  supersede?: (tenantId: string, oldMemoryId: string, newMemoryId: string, reason?: string) => JsonRecord | null;
}

interface TranscriptReader {
  get: (tenantId: string, entryId: string) => JsonRecord | null;
}

export class MemoryPromoter {
  db: unknown;
  memoryStore: MemoryStoreWriter;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, memoryStore: MemoryStoreWriter, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.memoryStore = memoryStore;
    this.runStore = runStore;
  }

  propose(input: JsonRecord): JsonRecord | null {
    const candidate = {
      id: id('memcand'),
      tenant_id: input.tenant_id,
      scope_type: input.scope_type || 'tenant',
      scope_id: input.scope_id || '',
      memory_type: input.memory_type || 'fact',
      content: input.content,
      entity_key: input.entity_key || inferEntityKey(input.scope_type || 'tenant', input.scope_id || '', String(input.content || '')),
      fact_key: input.fact_key || inferFactKey(input.memory_type || 'fact', String(input.content || '')),
      evidence_refs: input.evidence_refs || [],
      source_refs: input.source_refs || input.evidence_refs || [],
      confidence: input.confidence ?? 0.5,
      status: 'candidate',
      source: input.source || 'agent_proposed',
      occurred_at: input.occurred_at || null,
      known_at: input.known_at || null,
      valid_from: input.valid_from || input.occurred_at || null,
      valid_to: input.valid_to || null,
      metadata: input.metadata || {}
    };
    if (!candidate.content) throw new Error('memory candidate content is required');
    run(
      this.db,
      `INSERT INTO memory_candidates
        (id, tenant_id, scope_type, scope_id, memory_type, content, entity_key, fact_key,
         evidence_refs, source_refs, confidence, status, source, occurred_at, known_at, valid_from, valid_to, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        candidate.id,
        candidate.tenant_id,
        candidate.scope_type,
        candidate.scope_id,
        candidate.memory_type,
        candidate.content,
        candidate.entity_key,
        candidate.fact_key,
        json(candidate.evidence_refs),
        json(candidate.source_refs),
        candidate.confidence,
        candidate.status,
        candidate.source,
        candidate.occurred_at,
        candidate.known_at,
        candidate.valid_from,
        candidate.valid_to,
        json(candidate.metadata)
      ]
    );
    this.runStore?.audit(candidate.tenant_id, 'memory_candidate.proposed', 'memory_candidate', candidate.id, {
      scope_type: candidate.scope_type,
      memory_type: candidate.memory_type
    });
    return this.get(candidate.tenant_id, candidate.id);
  }

  approve(tenantId: string, candidateId: string): JsonRecord {
    const candidate = this.get(tenantId, candidateId);
    if (!candidate) throw new Error(`memory candidate not found: ${candidateId}`);
    if (candidate.status !== 'candidate') throw new Error(`memory candidate is not pending: ${candidate.status}`);
    const evidence = candidate.evidence_refs[0] || {};
    const conflicts = (this.memoryStore.findActiveConflicts?.({
      tenant_id: candidate.tenant_id,
      scope_type: candidate.scope_type,
      scope_id: candidate.scope_id,
      memory_type: candidate.memory_type,
      entity_key: candidate.entity_key,
      fact_key: candidate.fact_key
    }) || []).filter((memory) => normalizeForCompare(memory.content) !== normalizeForCompare(candidate.content));
    const contradictionGroupId = conflicts[0]?.contradiction_group_id || (conflicts.length ? id('memgrp') : '');
    const memory = this.memoryStore.write({
      tenant_id: candidate.tenant_id,
      scope_type: candidate.scope_type,
      scope_id: candidate.scope_id,
      memory_type: candidate.memory_type,
      content: candidate.content,
      entity_key: candidate.entity_key,
      fact_key: candidate.fact_key,
      evidence_object_type: evidence.object_type || 'transcript_entry',
      evidence_object_id: evidence.object_id || '',
      source_refs: candidate.source_refs?.length ? candidate.source_refs : candidate.evidence_refs,
      confidence: candidate.confidence,
      status: 'active',
      occurred_at: candidate.occurred_at || null,
      known_at: candidate.known_at || null,
      valid_from: candidate.valid_from || candidate.occurred_at || null,
      valid_to: candidate.valid_to || null,
      supersedes_memory_id: conflicts[0]?.id || null,
      contradiction_group_id: contradictionGroupId,
      metadata: {
        ...(candidate.metadata || {}),
        approved_candidate_id: candidate.id,
        superseded_memory_ids: conflicts.map((conflict) => conflict.id)
      }
    });
    for (const conflict of conflicts) {
      this.memoryStore.supersede?.(tenantId, conflict.id, memory.id, 'new approved memory supersedes same fact key');
    }
    const superseded = conflicts.map((conflict) => ({
      ...conflict,
      status: 'superseded',
      superseded_by_memory_id: memory.id
    }));
    run(
      this.db,
      `UPDATE memory_candidates
       SET status = 'approved', updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [tenantId, candidateId]
    );
    this.runStore?.audit(tenantId, 'memory_candidate.approved', 'memory_candidate', candidateId, {
      memory_id: memory.id,
      superseded_memory_ids: conflicts.map((conflict) => conflict.id)
    });
    return { candidate: this.get(tenantId, candidateId), memory, superseded };
  }

  reject(tenantId: string, candidateId: string): JsonRecord | null {
    run(
      this.db,
      `UPDATE memory_candidates
       SET status = 'rejected', updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ? AND status = 'candidate'`,
      [tenantId, candidateId]
    );
    return this.get(tenantId, candidateId);
  }

  extractFromTranscript(input: JsonRecord, transcriptStore: TranscriptReader): Array<JsonRecord | null> {
    const entry = transcriptStore.get(input.tenant_id, input.transcript_entry_id);
    if (!entry) throw new Error(`transcript entry not found: ${input.transcript_entry_id}`);
    const text = flattenContent(entry.content_redacted);
    const extracted = extractMemoryStatements(text);
    return extracted.map((statement) =>
      this.propose({
        tenant_id: input.tenant_id,
        scope_type: input.scope_type || inferScope(entry, input).scope_type,
        scope_id: input.scope_id ?? inferScope(entry, input).scope_id,
        memory_type: statement.memory_type,
        content: statement.content,
        confidence: statement.confidence,
        evidence_refs: [{ object_type: 'transcript_entry', object_id: entry.id }],
        source: input.source || 'deterministic_transcript'
      })
    );
  }

  get(tenantId: string, candidateId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM memory_candidates WHERE tenant_id = ? AND id = ?', [tenantId, candidateId]);
    return row ? decodeCandidate(row) : null;
  }

  listCandidates(tenantId: string, status = 'candidate'): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM memory_candidates
       WHERE tenant_id = ? AND status = ?
       ORDER BY confidence DESC, created_at DESC`,
      [tenantId, status]
    ).map(decodeCandidate);
  }
}

function inferScope(entry: JsonRecord, input: JsonRecord): { scope_type: string; scope_id: string } {
  const ref = entry.business_object_refs?.[0];
  if (ref?.object_type && ref?.object_id) return { scope_type: ref.object_type, scope_id: ref.object_id };
  if (input.default_scope_type || input.default_scope_id) {
    return { scope_type: input.default_scope_type || 'tenant', scope_id: input.default_scope_id || '' };
  }
  return { scope_type: 'tenant', scope_id: '' };
}

function flattenContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return Object.values(value)
    .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
    .join('\n');
}

function extractMemoryStatements(text: unknown): JsonRecord[] {
  const normalized = String(text || '').trim();
  if (!normalized) return [];
  const candidates: JsonRecord[] = [];
  const preference = matchFirst(normalized, [
    /(?:记住|以后|后续|今后|统一|偏好|希望|请用|都用)(.{4,160})/i,
    /(?:remember|prefer|always use|from now on)(.{4,160})/i
  ]);
  if (preference) {
    candidates.push({
      memory_type: 'preference',
      content: normalizeStatement(preference),
      confidence: 0.9
    });
  }

  const fact = matchFirst(normalized, [
    /(?:事实是|公司是|客户是|产品是|规则是)(.{4,180})/i,
    /(?:fact:|the fact is|customer is|company is|product is)(.{4,180})/i
  ]);
  if (fact) {
    candidates.push({
      memory_type: 'fact',
      content: normalizeStatement(fact),
      confidence: 0.82
    });
  }
  const condition = matchFirst(normalized, [
    /(?:长期目标是|长期条件是|约束是|必须|不能|只要|只能|默认要)(.{4,180})/i,
    /(?:long-term goal is|constraint is|must|never|always)(.{4,180})/i
  ]);
  if (condition) {
    candidates.push({
      memory_type: 'condition',
      content: normalizeStatement(condition),
      confidence: 0.86
    });
  }

  const openLoop = matchFirst(normalized, [
    /(?:待|下次|稍后|回拨|还没|需要继续|后面再)(.{4,180})/i,
    /(?:follow up|next time|pending|unresolved|call back)(.{4,180})/i
  ]);
  if (openLoop) {
    candidates.push({
      memory_type: 'open_loop',
      content: normalizeStatement(openLoop),
      confidence: 0.84
    });
  }
  return dedupeStatements(candidates);
}

function matchFirst(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return '';
}

function normalizeStatement(value: unknown): string {
  return String(value)
    .replace(/[。.!！?？].*$/s, '')
    .trim();
}

function dedupeStatements(statements: JsonRecord[]): JsonRecord[] {
  const seen = new Set();
  return statements.filter((statement) => {
    const key = `${statement.memory_type}:${statement.content}`;
    if (!statement.content || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function decodeCandidate(row: JsonRecord): JsonRecord {
  return {
    ...row,
    evidence_refs: parseJson(String(row.evidence_refs || '[]'), []),
    source_refs: parseJson(String(row.source_refs || '[]'), []),
    metadata: parseJson(String(row.metadata || '{}'), {})
  };
}

function normalizeForCompare(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
