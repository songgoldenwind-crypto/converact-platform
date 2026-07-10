import { all, one, run } from '../../db.js';
import { MemoryStore, computeMemoryScore } from './memory-store.js';
import { MemoryConsolidator } from './memory-consolidator.js';
import { MemorySummarizer } from './memory-summarizer.js';
import type { MemoryEntryRow } from '../context/runtime-types.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';

interface ModelGatewayLike {
  complete: (context: JsonRecord, request: JsonRecord) => Promise<JsonRecord>;
}

// ── Score config (mirrors memory-store.ts) ───────────────────────────
const DEFAULT_SCORE_CONFIG = {
  halfLifeMs: Number(process.env.OPC_MEMORY_HALF_LIFE_DAYS || 7) * 86_400_000,
  alpha: Number(process.env.OPC_MEMORY_EFFECTIVE_AGE_ALPHA || 0.1),
  beta: Number(process.env.OPC_MEMORY_RECALL_BOOST_BETA || 2.0),
  archiveThreshold: Number(process.env.OPC_MEMORY_ARCHIVE_THRESHOLD || 0.05)
};

// ── Maintenance config ───────────────────────────────────────────────
export interface MaintenanceConfig {
  archiveThreshold: number;
  archiveMinRecallCount: number;
  archiveScanLimit: number;
  scoreConfig: typeof DEFAULT_SCORE_CONFIG;
  enableLlmSummarize: boolean;
  maxLlmGroups: number;
  modelGateway: ModelGatewayLike | null;
  purgeArchivedDays: number;
  purgeCandidateDays: number;
}

const DEFAULT_MAINTENANCE_CONFIG: MaintenanceConfig = {
  archiveThreshold: 0.05,
  archiveMinRecallCount: 5,
  archiveScanLimit: 500,
  scoreConfig: DEFAULT_SCORE_CONFIG,
  enableLlmSummarize: false,
  maxLlmGroups: 3,
  modelGateway: null,
  purgeArchivedDays: 90,
  purgeCandidateDays: 30
};

export interface MaintenanceResult {
  archived: number;
  consolidated: number;
  summarized: number;
  importanceRefreshed: number;
  recallLogsConsumed: number;
  purged: number;
  candidatesPurged: number;
  skipped?: boolean;
  skipReason?: string;
  durationMs?: number;
  error?: string;
  stageTimings?: Record<string, number>;
}

const COLD_START_DAYS = 7;

function emptyMaintenanceResult(skipped = false, skipReason?: string): MaintenanceResult {
  return {
    archived: 0,
    consolidated: 0,
    summarized: 0,
    importanceRefreshed: 0,
    recallLogsConsumed: 0,
    purged: 0,
    candidatesPurged: 0,
    skipped,
    skipReason
  };
}

// ── MemoryMaintenance ────────────────────────────────────────────────
export class MemoryMaintenance {
  db: unknown;
  memoryStore: MemoryStore;
  config: MaintenanceConfig;
  consolidator: MemoryConsolidator;
  summarizer: MemorySummarizer;
  private runningTenants: Set<string>;

  constructor(db: unknown, memoryStore: MemoryStore, config?: Partial<MaintenanceConfig>) {
    this.db = db;
    this.memoryStore = memoryStore;
    this.config = { ...DEFAULT_MAINTENANCE_CONFIG, ...config };
    this.consolidator = new MemoryConsolidator(db, memoryStore);
    this.summarizer = new MemorySummarizer(db, memoryStore, this.config.maxLlmGroups, this.config.modelGateway);
    this.runningTenants = new Set();
  }

  /** Main entry: execute full maintenance cycle */
  async runMaintenanceCycle(tenantId: string): Promise<MaintenanceResult> {
    if (this.runningTenants.has(tenantId)) {
      return emptyMaintenanceResult(true, 'concurrent_guard');
    }
    this.runningTenants.add(tenantId);

    const startedAt = performance.now();
    const stageTimings: Record<string, number> = {};
    try {
      const result: MaintenanceResult = emptyMaintenanceResult(false);

      // 0. Consume recall logs and update recall_count (must run before archive/importance)
      const t0 = performance.now();
      const beforeTs = new Date().toISOString();
      result.recallLogsConsumed = batchIncrementRecallCount(this.db, tenantId, beforeTs);
      stageTimings.recall_logs = performance.now() - t0;

      // 0.5. Refresh importance_score for all active memories (using fresh recall_count)
      const t1 = performance.now();
      result.importanceRefreshed = await this.refreshImportanceScores(tenantId);
      stageTimings.importance_refresh = performance.now() - t1;

      // 1. Archive (skip during system cold-start period)
      const t2 = performance.now();
      const inColdStart = isSystemInColdStart(this.db, tenantId);
      if (!inColdStart) {
        result.archived = await this.archiveStaleMemories(tenantId);
      }
      stageTimings.archive = performance.now() - t2;

      // 2. Consolidation (run even during cold-start)
      const t3 = performance.now();
      result.consolidated = await this.consolidateMemories(tenantId);
      stageTimings.consolidation = performance.now() - t3;

      // 3. Optional LLM Summary (only when backlog is severe)
      const t4 = performance.now();
      if (this.config.enableLlmSummarize) {
        result.summarized = await this.llmSummarize(tenantId);
      }
      stageTimings.summarize = performance.now() - t4;

      // 4. Purge old archived memories (hard delete)
      const t5 = performance.now();
      result.purged = await this.purgeOldArchived(tenantId);
      stageTimings.purge_archived = performance.now() - t5;

      // 5. Purge old rejected/expired candidates
      const t6 = performance.now();
      result.candidatesPurged = await this.purgeOldCandidates(tenantId);
      stageTimings.purge_candidates = performance.now() - t6;

      result.durationMs = Math.round(performance.now() - startedAt);
      result.stageTimings = stageTimings;
      return result;
    } catch (err) {
      return {
        ...emptyMaintenanceResult(false),
        durationMs: Math.round(performance.now() - startedAt),
        stageTimings,
        error: err instanceof Error ? err.message : String(err)
      };
    } finally {
      this.runningTenants.delete(tenantId);
    }
  }

  /** 0.5. Refresh importance_score for all active memories (batch SQL update) */
  private async refreshImportanceScores(tenantId: string): Promise<number> {
    const entries = this.memoryStore.search({
      tenant_id: tenantId,
      status: 'active',
      limit: this.config.archiveScanLimit
    });

    const updates: Array<{ id: string; score: number }> = [];
    for (const entry of entries) {
      const newScore = computeImportanceScore(entry);
      if (Math.abs(newScore - (entry.importance_score ?? 0.5)) > 0.01) {
        updates.push({ id: entry.id, score: newScore });
      }
    }

    if (!updates.length) return 0;

    // Batch update using parameterized CASE for SQLite efficiency
    const caseClauses = updates.map(() => 'WHEN ? THEN ?').join(' ');
    const idPlaceholders = updates.map(() => '?').join(',');
    run(
      this.db,
      `UPDATE memory_entries
       SET importance_score = CASE id ${caseClauses} ELSE importance_score END,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id IN (${idPlaceholders})`,
      [
        ...updates.flatMap((u) => [u.id, Number(u.score.toFixed(4))]),
        tenantId,
        ...updates.map((u) => u.id)
      ]
    );
    this.memoryStore.invalidatePackCache(tenantId);

    // Audit each updated entry
    for (const u of updates) {
      this.memoryStore.runStore?.audit?.(tenantId, 'memory.importance_updated', 'memory_entry', u.id, {
        new_score: u.score
      });
    }

    return updates.length;
  }

  /** 1. Archive memories with composite score below threshold */
  private async archiveStaleMemories(tenantId: string): Promise<number> {
    const threshold = this.config.archiveThreshold;
    const minRecallCount = this.config.archiveMinRecallCount;

    const entries = this.memoryStore.search({
      tenant_id: tenantId,
      status: 'active',
      limit: this.config.archiveScanLimit
    });

    let archived = 0;
    for (const entry of entries) {
      // Exemption: protected flag
      if (entry.protected === 1) continue;

      const score = computeMemoryScore(entry, [], '', this.config.scoreConfig);

      if (score.composite < threshold && (entry.recall_count || 0) < minRecallCount) {
        this.memoryStore.updateStatus(tenantId, entry.id, 'archived', {
          reason: 'composite_below_threshold',
          composite_score: score.composite,
          recall_count: entry.recall_count,
          importance_score: entry.importance_score
        });
        archived++;
      }
    }
    return archived;
  }

  /** 2. Consolidation: dedupe + structured references */
  private async consolidateMemories(tenantId: string): Promise<number> {
    return this.consolidator.run(tenantId);
  }

  /** 3. LLM Summary: only when backlog is severe */
  private async llmSummarize(tenantId: string): Promise<number> {
    return this.summarizer.run(tenantId);
  }

  /** 4. Hard-delete archived memories older than purgeArchivedDays */
  private async purgeOldArchived(tenantId: string): Promise<number> {
    const days = this.config.purgeArchivedDays;
    if (!days || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = run(
      this.db,
      `DELETE FROM memory_entries
       WHERE tenant_id = ? AND status = 'archived' AND updated_at < ?`,
      [tenantId, cutoff]
    );
    return result.changes || 0;
  }

  /** 5. Hard-delete stale candidates (rejected or >30 days old) */
  private async purgeOldCandidates(tenantId: string): Promise<number> {
    const days = this.config.purgeCandidateDays;
    if (!days || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = run(
      this.db,
      `DELETE FROM memory_candidates
       WHERE tenant_id = ? AND (status = 'rejected' OR created_at < ?)`,
      [tenantId, cutoff]
    );
    return result.changes || 0;
  }
}

// ── Cold-start check (per-tenant) ────────────────────────────────────
function isSystemInColdStart(db: unknown, tenantId: string): boolean {
  const key = `first_maintenance_at:${tenantId}`;
  const row = one(db, `SELECT value FROM system_config WHERE key = ?`, [key]);
  if (!row) {
    run(db,
      `INSERT INTO system_config (key, value) VALUES (?, ?)`,
      [key, new Date().toISOString()]
    );
    return true;
  }
  const days = (Date.now() - Date.parse(row.value)) / 86_400_000;
  return days < COLD_START_DAYS;
}

// ── Batch consume recall logs ────────────────────────────────────────
function batchIncrementRecallCount(db: unknown, tenantId: string, beforeTimestamp: string): number {
  const logs = all(db,
    `SELECT memory_id, COUNT(*) as cnt
     FROM memory_recall_logs
     WHERE tenant_id = ? AND recalled_at < ?
     GROUP BY memory_id`,
    [tenantId, beforeTimestamp]
  );

  if (!logs.length) {
    run(db, `DELETE FROM memory_recall_logs WHERE tenant_id = ? AND recalled_at < ?`, [tenantId, beforeTimestamp]);
    return 0;
  }

  // Single parameterized UPDATE with CASE for all memory_ids
  const caseClauses = logs.map(() => 'WHEN ? THEN recall_count + ?').join(' ');
  const idPlaceholders = logs.map(() => '?').join(',');
  const now = new Date().toISOString();

  run(db,
    `UPDATE memory_entries
     SET recall_count = CASE id ${caseClauses} ELSE recall_count END,
         last_recalled_at = ?
     WHERE tenant_id = ? AND id IN (${idPlaceholders})`,
    [
      ...logs.flatMap((log) => [log.memory_id, log.cnt]),
      now,
      tenantId,
      ...logs.map((log) => log.memory_id)
    ]
  );

  const consumed = logs.reduce((sum, log) => sum + log.cnt, 0);

  run(db,
    `DELETE FROM memory_recall_logs WHERE tenant_id = ? AND recalled_at < ?`,
    [tenantId, beforeTimestamp]
  );

  return consumed;
}

// ── Importance score computation ─────────────────────────────────────
function computeImportanceScore(entry: MemoryEntryRow): number {
  const confidence = entry.confidence ?? 0.5;
  const recallBoost = Math.log1p(entry.recall_count || 0) / 10;
  const lifespanFactor = computeLifespanFactor(entry);
  const retrievalSuccess = computeRetrievalSuccess(entry);
  const lengthFactor = computeContentLengthFactor(entry.content);

  return Math.min(1.0,
    confidence * 0.35 +
    recallBoost * 0.2 +
    lifespanFactor * 0.2 +
    retrievalSuccess * 0.2 +
    lengthFactor * 0.05
  );
}

function computeContentLengthFactor(content: string): number {
  const len = String(content || '').length;
  if (len >= 20 && len <= 200) return 1.0;
  if (len < 10) return 0.5;
  if (len > 500) return 0.7;
  return 0.85;
}

function computeLifespanFactor(entry: MemoryEntryRow): number {
  const created = Date.parse(entry.created_at || '');
  if (!created) return 0;
  const ageDays = (Date.now() - created) / 86_400_000;
  return Math.min(1.0, Math.log1p(ageDays) / Math.log1p(365));
}

function computeRetrievalSuccess(entry: MemoryEntryRow): number {
  return Math.min(1.0, Math.log1p(entry.recall_count || 0) / Math.log1p(50));
}
