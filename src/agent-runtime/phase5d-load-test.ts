import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../db.js';

export interface Phase5DCacheLoadTestOptions {
  dbPath?: string;
  tenantId?: string;
  entryCount?: number;
  batchSize?: number;
  readCount?: number;
  expiryRatio?: number;
  keepDatabase?: boolean;
}

export interface Phase5DCacheLoadTestResult {
  dbPath: string;
  tenantId: string;
  entryCount: number;
  batchSize: number;
  readCount: number;
  expiredSeedCount: number;
  insertedEntries: number;
  activeEntriesAfterCleanup: number;
  evictedExpiredEntries: number;
  insertDurationMs: number;
  readDurationMs: number;
  cleanupDurationMs: number;
  insertThroughputPerSecond: number;
  readThroughputPerSecond: number;
  observedReadHitRate: number;
  readLatencyP50Ms: number;
  readLatencyP95Ms: number;
  databaseSizeBytes: number;
  recommendations: string[];
}

const DEFAULT_ENTRY_COUNT = 1_000_000;
const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_READ_COUNT = 200_000;
const DEFAULT_EXPIRY_RATIO = 0.1;
const MAX_LATENCY_SAMPLES = 5_000;

function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function round(value: number, digits: number = 2): number {
  const base = 10 ** digits;
  return Math.round((value || 0) * base) / base;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[index], 3);
}

function buildScriptContent(index: number): string {
  return `Opening ${index}: We found a timely demand signal, a source-backed reason to call now, and one concise proof point for follow-up.`;
}

function buildCacheKey(index: number): string {
  return `phase5d-cache-${index}`;
}

function createTempDbPath(): { dbPath: string; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), 'opc-phase5d-loadtest-'));
  return {
    dbPath: join(tempDir, 'cache-load-test.sqlite'),
    tempDir
  };
}

export function runPhase5DCacheLoadTest(options: Phase5DCacheLoadTestOptions = {}): Phase5DCacheLoadTestResult {
  const entryCount = Math.max(1, Math.floor(options.entryCount ?? DEFAULT_ENTRY_COUNT));
  const batchSize = Math.max(100, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
  const readCount = Math.max(100, Math.floor(options.readCount ?? DEFAULT_READ_COUNT));
  const expiryRatio = Math.min(0.5, Math.max(0, options.expiryRatio ?? DEFAULT_EXPIRY_RATIO));
  const expiredSeedCount = Math.min(entryCount - 1, Math.floor(entryCount * expiryRatio));
  const tenantId = options.tenantId || 'phase5d-load-test';
  const keepDatabase = Boolean(options.keepDatabase);
  const tempDb = options.dbPath ? null : createTempDbPath();
  const dbPath = options.dbPath || tempDb!.dbPath;
  const db = createDatabase(dbPath);

  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      PRAGMA foreign_keys = ON;
    `);
    db.prepare(`INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)`).run(tenantId, 'Phase 5D Load Test Tenant');
    db.prepare(`DELETE FROM script_cache WHERE tenant_id = ?`).run(tenantId);

    const insertStatement = db.prepare(`
      INSERT OR REPLACE INTO script_cache (
        id, tenant_id, cache_key, industry, target_profile_hash,
        script_content, variant_source, model, expires_at, hit_count, last_hit_at, avg_efficacy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const expiredAt = toSqliteDateTime(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const activeAt = toSqliteDateTime(new Date(Date.now() + 72 * 60 * 60 * 1000));

    const insertStarted = process.hrtime.bigint();
    for (let batchStart = 0; batchStart < entryCount; batchStart += batchSize) {
      const batchEnd = Math.min(entryCount, batchStart + batchSize);
      db.exec('BEGIN');
      try {
        for (let index = batchStart; index < batchEnd; index += 1) {
          const isExpiredSeed = index < expiredSeedCount;
          const hitCount = isExpiredSeed ? 0 : (index % 25);
          const lastHitAt = hitCount > 0 ? toSqliteDateTime(new Date(Date.now() - (index % 6) * 60 * 60 * 1000)) : null;
          insertStatement.run(
            `phase5d-cache-row-${index}`,
            tenantId,
            buildCacheKey(index),
            index % 2 === 0 ? 'finance' : 'local-service',
            `profile-${index % 1000}`,
            buildScriptContent(index),
            index % 7 === 0 ? 'template' : 'ai_generated',
            index % 7 === 0 ? 'template' : 'deepseek-v4',
            isExpiredSeed ? expiredAt : activeAt,
            hitCount,
            lastHitAt,
            round(0.55 + ((index % 40) / 100), 4)
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    const insertDurationMs = Number(process.hrtime.bigint() - insertStarted) / 1_000_000;

    const selectStatement = db.prepare(`
      SELECT id
      FROM script_cache
      WHERE tenant_id = ? AND cache_key = ? AND expires_at > CURRENT_TIMESTAMP
      LIMIT 1
    `);

    const activeSeedSpan = Math.max(1, entryCount - expiredSeedCount);
    const hitReadsTarget = Math.floor(readCount * 0.8);
    const sampleEvery = Math.max(1, Math.floor(readCount / MAX_LATENCY_SAMPLES));
    const latencySamples: number[] = [];
    let observedHits = 0;
    let observedMisses = 0;
    const readStarted = process.hrtime.bigint();
    for (let index = 0; index < readCount; index += 1) {
      const cacheKey = index < hitReadsTarget
        ? buildCacheKey(expiredSeedCount + (index % activeSeedSpan))
        : `phase5d-miss-${index}`;
      const readStart = process.hrtime.bigint();
      const row = selectStatement.get(tenantId, cacheKey);
      const readLatencyMs = Number(process.hrtime.bigint() - readStart) / 1_000_000;
      if (index % sampleEvery === 0) latencySamples.push(readLatencyMs);
      if (row) {
        observedHits += 1;
      } else {
        observedMisses += 1;
      }
    }
    const readDurationMs = Number(process.hrtime.bigint() - readStarted) / 1_000_000;

    const cleanupStarted = process.hrtime.bigint();
    const cleanup = db.prepare(`DELETE FROM script_cache WHERE tenant_id = ? AND expires_at <= CURRENT_TIMESTAMP`).run(tenantId);
    const cleanupDurationMs = Number(process.hrtime.bigint() - cleanupStarted) / 1_000_000;
    const activeEntriesAfterCleanup = Number(
      db.prepare(`SELECT COUNT(*) as count FROM script_cache WHERE tenant_id = ? AND expires_at > CURRENT_TIMESTAMP`).get(tenantId)?.count || 0
    );
    const databaseSizeBytes = statSync(dbPath).size;
    const insertThroughputPerSecond = entryCount / Math.max(insertDurationMs / 1000, 0.001);
    const readThroughputPerSecond = readCount / Math.max(readDurationMs / 1000, 0.001);
    const observedReadHitRate = readCount > 0 ? (observedHits / readCount) * 100 : 0;
    const recommendations: string[] = [];

    if (insertThroughputPerSecond < 20_000) {
      recommendations.push('Insert throughput is below 20k rows/sec. Consider larger batches or a slimmer cache payload before running the full 1M-entry job repeatedly.');
    }
    if (readThroughputPerSecond < 10_000) {
      recommendations.push('Read throughput is below 10k lookups/sec. Review hot-path indexes and consider pre-warming the highest-priority source packs.');
    }
    if (cleanupDurationMs > 5_000) {
      recommendations.push('Expired-entry cleanup is taking noticeable time. Prefer incremental cleanup windows instead of one large sweep during active calling hours.');
    }
    if (!recommendations.length) {
      recommendations.push('Cache insert, lookup, and expiry cleanup all stayed within the expected Phase 5D range for this run.');
    }

    return {
      dbPath,
      tenantId,
      entryCount,
      batchSize,
      readCount,
      expiredSeedCount,
      insertedEntries: entryCount,
      activeEntriesAfterCleanup,
      evictedExpiredEntries: Number(cleanup.changes || 0),
      insertDurationMs: round(insertDurationMs, 2),
      readDurationMs: round(readDurationMs, 2),
      cleanupDurationMs: round(cleanupDurationMs, 2),
      insertThroughputPerSecond: round(insertThroughputPerSecond, 2),
      readThroughputPerSecond: round(readThroughputPerSecond, 2),
      observedReadHitRate: round(observedReadHitRate, 2),
      readLatencyP50Ms: percentile(latencySamples, 50),
      readLatencyP95Ms: percentile(latencySamples, 95),
      databaseSizeBytes,
      recommendations
    };
  } finally {
    db.close();
    if (!keepDatabase && tempDb?.tempDir) {
      rmSync(tempDb.tempDir, { recursive: true, force: true });
    }
  }
}
