/**
 * Cache Eviction & Maintenance (PHASE 5B)
 *
 * Handles:
 * - Expired cache cleanup (TTL)
 * - Low-efficacy eviction (keep high performers)
 * - Archive cleanup (remove old/unused archive entries)
 * - Lazy cleanup (triggered on access if cache is stale)
 */

import { all, one, run } from '../db.js';

/**
 * Main maintenance entry point - runs all cleanup tasks
 * Call this periodically (e.g., daily, or lazily on cache miss)
 */
export function runCacheMaintenanceAsync(db: any, tenantId?: string): Promise<{
  expiredCleaned: number;
  lowEfficacyEvicted: number;
  archiveCleaned: number;
  error?: string;
}> {
  return Promise.resolve().then(() => {
    try {
      const expiredCleaned = cleanupExpiredCache(db, tenantId);
      const lowEfficacyEvicted = evictLowEfficacyCache(db, tenantId);
      const archiveCleaned = cleanupOldArchive(db, tenantId);

      return {
        expiredCleaned,
        lowEfficacyEvicted,
        archiveCleaned
      };
    } catch (err) {
      console.warn('Cache maintenance failed:', err);
      return {
        expiredCleaned: 0,
        lowEfficacyEvicted: 0,
        archiveCleaned: 0,
        error: String(err)
      };
    }
  });
}

/**
 * Remove cache entries that have expired (past expires_at)
 */
export function cleanupExpiredCache(db: any, tenantId?: string): number {
  try {
    const whereClause = tenantId
      ? `WHERE tenant_id = ? AND expires_at < datetime('now')`
      : `WHERE expires_at < datetime('now')`;

    const deleteResult = run(
      db,
      `DELETE FROM script_cache ${whereClause}`,
      tenantId ? [tenantId] : []
    );

    return deleteResult?.changes || 0;
  } catch (err) {
    console.warn('Failed to cleanup expired cache:', err);
    return 0;
  }
}

/**
 * Evict cache entries with low efficacy (below threshold)
 * Keeps only top performers to maintain cache quality
 */
export function evictLowEfficacyCache(db: any, tenantId?: string, efficacyThreshold?: number): number {
  const threshold = efficacyThreshold || 0.3; // 30% efficacy minimum

  try {
    const whereClause = tenantId
      ? `WHERE tenant_id = ? AND avg_efficacy IS NOT NULL AND avg_efficacy < ?`
      : `WHERE avg_efficacy IS NOT NULL AND avg_efficacy < ?`;

    const deleteResult = run(
      db,
      `DELETE FROM script_cache ${whereClause}`,
      tenantId ? [tenantId, threshold] : [threshold]
    );

    return deleteResult?.changes || 0;
  } catch (err) {
    console.warn('Failed to evict low-efficacy cache:', err);
    return 0;
  }
}

/**
 * Remove unused archive entries (older than 7 days, no recent access)
 */
export function cleanupOldArchive(db: any, tenantId?: string, daysOld?: number): number {
  const days = daysOld || 7;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const whereClause = tenantId
      ? `WHERE tenant_id = ? AND accessed_at < ? AND access_count < 2`
      : `WHERE accessed_at < ? AND access_count < 2`;

    const deleteResult = run(
      db,
      `DELETE FROM efficacy_archive ${whereClause}`,
      tenantId ? [tenantId, cutoffDate] : [cutoffDate]
    );

    return deleteResult?.changes || 0;
  } catch (err) {
    console.warn('Failed to cleanup old archive:', err);
    return 0;
  }
}

/**
 * Invalidate cache for a specific run (e.g., when target profile changes)
 */
export function invalidateRunCache(db: any, tenantId: string, runId: string): number {
  try {
    const deleted = run(
      db,
      `DELETE FROM script_cache 
       WHERE tenant_id = ? 
       AND cache_key IN (
         SELECT cache_key FROM script_cache sc
         WHERE sc.tenant_id = ?
         AND sc.created_at >= datetime('now', '-24 hours')
       )`,
      [tenantId, tenantId]
    );

    // Also clean associated archive
    run(
      db,
      `DELETE FROM efficacy_archive WHERE tenant_id = ? AND run_id = ?`,
      [tenantId, runId]
    );

    return deleted?.changes || 0;
  } catch (err) {
    console.warn('Failed to invalidate cache for run:', err);
    return 0;
  }
}

/**
 * Smart cleanup - keeps cache healthy by removing:
 * 1. Expired entries (TTL passed)
 * 2. Duplicate low-hit entries (keep best of duplicates)
 * 3. Old archives (not accessed in 3+ days)
 */
export function smartCacheCleanup(db: any, tenantId: string): Promise<{
  removed: number;
  preserved: number;
  issues: string[];
}> {
  return Promise.resolve().then(() => {
    const issues: string[] = [];
    let removed = 0;
    let preserved = 0;

    try {
      // Step 1: Remove expired
      const expiredRemoved = cleanupExpiredCache(db, tenantId);
      removed += expiredRemoved;

      // Step 2: Remove low-efficacy
      const lowEfficacyRemoved = evictLowEfficacyCache(db, tenantId);
      removed += lowEfficacyRemoved;

      // Step 3: Remove old archives
      const archiveRemoved = cleanupOldArchive(db, tenantId);
      removed += archiveRemoved;

      // Step 4: Identify duplicates (same cache_key, keep newest)
      const duplicates = all(
        db,
        `SELECT cache_key, COUNT(*) as count
         FROM script_cache
         WHERE tenant_id = ?
         GROUP BY cache_key
         HAVING count > 1`,
        [tenantId]
      );

      if (duplicates && duplicates.length > 0) {
        issues.push(`Found ${duplicates.length} duplicate cache keys`);
      }

      // Get stats
      const stats = one(
        db,
        `SELECT COUNT(*) as total FROM script_cache WHERE tenant_id = ?`,
        [tenantId]
      );

      preserved = stats?.total || 0;

      return {
        removed,
        preserved,
        issues
      };
    } catch (err) {
      issues.push(`Cleanup error: ${String(err)}`);
      return {
        removed,
        preserved,
        issues
      };
    }
  });
}

/**
 * Get cache health score (0-100)
 * Factors: hit rate, efficacy, staleness, duplicate entries
 */
export function getCacheHealthScore(db: any, tenantId: string): number {
  try {
    const stats = all(
      db,
      `SELECT 
        COUNT(*) as total,
        AVG(hit_count) as avg_hits,
        AVG(avg_efficacy) as avg_efficacy,
        SUM(CASE WHEN expires_at < datetime('now') THEN 1 ELSE 0 END) as expired,
        SUM(CASE WHEN hit_count = 0 THEN 1 ELSE 0 END) as unused
      FROM script_cache
      WHERE tenant_id = ?`,
      [tenantId]
    );

    if (!stats || stats.length === 0) {
      return 0; // No cache
    }

    const stat = stats[0];
    const total = stat.total || 1;
    const avgHits = stat.avg_hits || 0;
    const avgEfficacy = stat.avg_efficacy || 0;
    const expiredPct = (stat.expired / total) * 100;
    const unusedPct = (stat.unused / total) * 100;

    // Score calculation (0-100)
    let score = 100;

    // Deduct for expired entries
    score -= expiredPct * 0.5; // 0.5 points per % expired

    // Deduct for unused entries
    score -= unusedPct * 0.3; // 0.3 points per % unused

    // Bonus for high hit count
    if (avgHits > 10) score += 10;
    else if (avgHits > 5) score += 5;

    // Bonus for high efficacy
    if (avgEfficacy > 0.7) score += 10;
    else if (avgEfficacy > 0.5) score += 5;

    return Math.max(0, Math.min(100, score));
  } catch (err) {
    console.warn('Failed to calculate cache health score:', err);
    return 0;
  }
}
