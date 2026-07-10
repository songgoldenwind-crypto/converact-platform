import type { MemoryEntryRow } from '../context/runtime-types.js';
import { MemoryStore } from './memory-store.js';

// ── Types ────────────────────────────────────────────────────────────
interface ConsolidatedGroup {
  canonical_memory_id: string;
  supporting_memory_ids: string[];
  entity_key: string;
  memory_type: string;
}

// ── Token helpers ────────────────────────────────────────────────────
function tokenize(value: string): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (!tokensA.size || !tokensB.size) return 0;
  const intersection = new Set([...tokensA].filter((x) => tokensB.has(x)));
  return intersection.size / Math.max(tokensA.size, tokensB.size);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

// ── MemoryConsolidator ───────────────────────────────────────────────
export class MemoryConsolidator {
  db: unknown;
  memoryStore: MemoryStore;

  constructor(db: unknown, memoryStore: MemoryStore) {
    this.db = db;
    this.memoryStore = memoryStore;
  }

  /** Run full consolidation cycle: dedupe → group → canonicalize */
  run(tenantId: string): number {
    const entries = this.memoryStore.search({
      tenant_id: tenantId,
      status: 'active',
      limit: 500
    });

    // Level 1: exact dedupe (entity_key + fact_key)
    const exactDeduped = this.exactDedupe(entries);

    // Level 2: approximate dedupe (token overlap > 0.85)
    const approxDeduped = this.approximateDedupe(exactDeduped);

    // Level 3: build consolidated groups by entity_key:memory_type
    const groups = this.buildConsolidatedGroups(approxDeduped, tenantId);

    return groups.length;
  }

  /** Level 1: exact dedupe by entity_key + fact_key */
  private exactDedupe(entries: MemoryEntryRow[]): MemoryEntryRow[] {
    const seen = new Map<string, MemoryEntryRow>();
    for (const entry of entries) {
      const key = `${entry.entity_key}:${entry.fact_key}`;
      const existing = seen.get(key);
      if (!existing || (entry.confidence ?? 0) > (existing.confidence ?? 0)) {
        seen.set(key, entry);
      }
    }
    return Array.from(seen.values());
  }

  /** Level 2: approximate dedupe by token overlap > 0.85 */
  private approximateDedupe(entries: MemoryEntryRow[]): MemoryEntryRow[] {
    const result: MemoryEntryRow[] = [];
    for (const entry of entries) {
      const isDuplicate = result.some((existing) =>
        tokenOverlap(entry.content, existing.content) > 0.85
      );
      if (!isDuplicate) result.push(entry);
    }
    return result;
  }

  /** Level 3: group by entity_key:memory_type, pick canonical by importance_score */
  private buildConsolidatedGroups(entries: MemoryEntryRow[], tenantId: string): ConsolidatedGroup[] {
    const byEntityAndType = groupBy(entries, (e) => `${e.entity_key}:${e.memory_type}`);
    const groups: ConsolidatedGroup[] = [];

    for (const [groupKey, groupEntries] of Object.entries(byEntityAndType)) {
      if (groupEntries.length <= 1) continue;

      const lastColon = groupKey.lastIndexOf(':');
      const entityKey = lastColon > 0 ? groupKey.substring(0, lastColon) : groupKey;
      const memoryType = lastColon > 0 ? groupKey.substring(lastColon + 1) : '';

      // Sort by importance_score (primary), confidence (fallback)
      const sorted = groupEntries.sort((a, b) =>
        (b.importance_score ?? 0.5) - (a.importance_score ?? 0.5)
        || (b.confidence ?? 0) - (a.confidence ?? 0)
      );
      const canonical = sorted[0];
      const supporting = sorted.slice(1);

      groups.push({
        canonical_memory_id: canonical.id,
        supporting_memory_ids: supporting.map((e) => e.id),
        entity_key: entityKey,
        memory_type: memoryType
      });

      // Archive supporting memories and set summary_parent_id
      for (const sup of supporting) {
        this.memoryStore.updateStatus(tenantId, sup.id, 'archived', {
          reason: 'consolidated_into_group',
          canonical_memory_id: canonical.id
        });
        this.memoryStore.updateSummaryParent(tenantId, sup.id, canonical.id);
      }

      // Bump canonical importance_score by 0.1 (capped at 1.0)
      this.memoryStore.updateImportance(
        tenantId,
        canonical.id,
        Math.min(1.0, (canonical.importance_score ?? 0.5) + 0.1)
      );
    }

    return groups;
  }
}
