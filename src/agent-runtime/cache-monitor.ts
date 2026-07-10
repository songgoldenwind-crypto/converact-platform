/**
 * Cache Monitoring Module (PHASE 5B)
 *
 * Tracks and reports on cache performance metrics:
 * - Hit/miss rate
 * - Cache efficiency (cost savings)
 * - Eviction patterns
 * - Archive effectiveness (efficacy externalization benefit)
 *
 * Integrated into optimization_stats for long-term analysis
 */

import { all, one, run, json } from '../db.js';

export interface CacheMetrics {
  totalChecks: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  avgCacheSavings: number; // tokens saved per hit
  totalTokensSaved: number;
  archiveHitCount: number;
  archiveAccessAvg: number;
  oldestCacheEntry: string; // ISO timestamp
  youngestCacheEntry: string; // ISO timestamp
  activeCacheEntries: number;
  evictedCount: number;
  averageCacheLifetime: number; // hours
}

/**
 * Get cache performance metrics for a tenant
 */
export function getCacheMetrics(db: any, tenantId: string, lastNHours?: number): CacheMetrics {
  const hoursBack = lastNHours || 24;
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  try {
    // Get hit/miss counts
    const hitMiss = one(
      db,
      `SELECT 
        SUM(CASE WHEN metric_name = 'script_cache_hit' THEN metric_value ELSE 0 END) as hit_count,
        SUM(CASE WHEN metric_name = 'script_cache_miss' THEN metric_value ELSE 0 END) as miss_count
      FROM optimization_stats
      WHERE tenant_id = ? AND stat_type = 'cache' AND recorded_at >= ?`,
      [tenantId, since]
    );

    const hitCount = hitMiss?.hit_count || 0;
    const missCount = hitMiss?.miss_count || 0;
    const totalChecks = hitCount + missCount;
    const hitRate = totalChecks > 0 ? (hitCount / totalChecks) * 100 : 0;

    // Estimate token savings (150 tokens per AI generation, cache hit = 0 tokens)
    const avgCacheSavings = 150; // Baseline AI generation cost
    const totalTokensSaved = hitCount * avgCacheSavings;

    // Get cache state metrics
    const cacheStats = one(
      db,
      `SELECT
        COUNT(*) as cache_count,
        COUNT(CASE WHEN expires_at > CURRENT_TIMESTAMP THEN 1 END) as active_cache_count,
        AVG(hit_count) as avg_hits,
        MIN(created_at) as oldest,
        MAX(created_at) as youngest
      FROM script_cache
      WHERE tenant_id = ?`,
      [tenantId]
    );

    // Archive effectiveness
    const archiveStats = one(
      db,
      `SELECT
        COUNT(*) as archive_count,
        AVG(access_count) as avg_access_count
      FROM efficacy_archive
      WHERE tenant_id = ? AND accessed_at >= ?`,
      [tenantId, since]
    );

    // Calculate average cache lifetime (hours from creation to last hit or expiry)
    const lifetimeStats = one(
      db,
      `SELECT 
        AVG((julianday(COALESCE(last_hit_at, expires_at)) - julianday(created_at)) * 24) as avg_lifetime_hours
      FROM script_cache
      WHERE tenant_id = ? AND last_hit_at IS NOT NULL`,
      [tenantId]
    );

    return {
      totalChecks,
      hitCount,
      missCount,
      hitRate: Math.round(hitRate * 100) / 100,
      avgCacheSavings,
      totalTokensSaved,
      archiveHitCount: archiveStats?.archive_count || 0,
      archiveAccessAvg: Math.round((archiveStats?.avg_access_count || 0) * 100) / 100,
      oldestCacheEntry: cacheStats?.oldest || new Date().toISOString(),
      youngestCacheEntry: cacheStats?.youngest || new Date().toISOString(),
      activeCacheEntries: cacheStats?.active_cache_count || 0,
      evictedCount: 0, // Placeholder - would need eviction log table
      averageCacheLifetime: Math.round((lifetimeStats?.avg_lifetime_hours || 0) * 100) / 100
    };
  } catch (err) {
    console.warn('Failed to get cache metrics:', err);
    return {
      totalChecks: 0,
      hitCount: 0,
      missCount: 0,
      hitRate: 0,
      avgCacheSavings: 0,
      totalTokensSaved: 0,
      archiveHitCount: 0,
      archiveAccessAvg: 0,
      oldestCacheEntry: new Date().toISOString(),
      youngestCacheEntry: new Date().toISOString(),
      activeCacheEntries: 0,
      evictedCount: 0,
      averageCacheLifetime: 0
    };
  }
}

/**
 * Record cache metrics to optimization_stats for historical tracking
 */
export function recordCacheMetrics(db: any, tenantId: string, metrics: CacheMetrics): void {
  try {
    // Record hit rate as percentage
    if (metrics.totalChecks > 0) {
      run(
        db,
        `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`,
        [tenantId, 'cache', 'hit_rate_pct', metrics.hitRate]
      );

      // Record token savings
      run(
        db,
        `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`,
        [tenantId, 'cache', 'tokens_saved_total', metrics.totalTokensSaved]
      );

      // Record cache size
      run(
        db,
        `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value)
         VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`,
        [tenantId, 'cache', 'active_cache_entries', Math.floor(metrics.totalChecks)]
      );

      // Record archive effectiveness
      if (metrics.archiveHitCount > 0) {
        run(
          db,
          `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`,
          [tenantId, 'cache', 'archive_entries', metrics.archiveHitCount]
        );
      }
    }
  } catch (err) {
    console.warn('Failed to record cache metrics:', err);
  }
}

/**
 * Get top performing cache entries (by hit count)
 */
export function getTopCacheEntries(db: any, tenantId: string, limit?: number): Array<any> {
  const topN = limit || 10;
  try {
    return all(
      db,
      `SELECT 
        cache_key, industry, hit_count, avg_efficacy, 
        created_at, last_hit_at, expires_at
      FROM script_cache
      WHERE tenant_id = ?
      ORDER BY hit_count DESC
      LIMIT ?`,
      [tenantId, topN]
    );
  } catch (err) {
    console.warn('Failed to get top cache entries:', err);
    return [];
  }
}

/**
 * Get cache efficiency report by industry
 */
export function getCacheEfficiencyByIndustry(db: any, tenantId: string): Array<any> {
  try {
    return all(
      db,
      `SELECT 
        industry,
        COUNT(*) as cache_count,
        AVG(hit_count) as avg_hits,
        AVG(avg_efficacy) as avg_efficacy,
        SUM(CASE WHEN hit_count > 0 THEN 1 ELSE 0 END) as active_entries
      FROM script_cache
      WHERE tenant_id = ?
      GROUP BY industry
      ORDER BY avg_hits DESC`,
      [tenantId]
    );
  } catch (err) {
    console.warn('Failed to get cache efficiency by industry:', err);
    return [];
  }
}

/**
 * Export cache metrics to JSON for dashboard/reporting
 */
export function exportCacheReport(db: any, tenantId: string, lastNHours?: number): Record<string, any> {
  const metrics = getCacheMetrics(db, tenantId, lastNHours);
  const topEntries = getTopCacheEntries(db, tenantId, 5);
  const byIndustry = getCacheEfficiencyByIndustry(db, tenantId);

  return {
    reportGeneratedAt: new Date().toISOString(),
    period: {
      hours: lastNHours || 24,
      since: new Date(Date.now() - (lastNHours || 24) * 60 * 60 * 1000).toISOString()
    },
    metrics,
    topCacheEntries: topEntries,
    efficiencyByIndustry: byIndustry,
    recommendations: generateCacheRecommendations(metrics, byIndustry)
  };
}

/**
 * Generate actionable recommendations based on cache performance
 */
function generateCacheRecommendations(metrics: CacheMetrics, byIndustry: Array<any>): Array<string> {
  const recommendations: string[] = [];

  // Hit rate recommendations
  if (metrics.hitRate < 30) {
    recommendations.push(
      'Low cache hit rate (<30%). Consider increasing TTL or expanding cache profile hash scope.'
    );
  } else if (metrics.hitRate > 80) {
    recommendations.push('Excellent cache hit rate (>80%). Monitor for stale cache entries.');
  }

  // Token savings recommendations
  if (metrics.totalTokensSaved < 1000) {
    recommendations.push(
      'Cache is not providing significant token savings. Verify cache is properly integrated.'
    );
  }

  // Archive effectiveness
  if (metrics.archiveHitCount > 0 && metrics.archiveAccessAvg < 1) {
    recommendations.push(
      'Archive entries created but rarely accessed. Consider adjusting archive thresholds.'
    );
  }

  // Industry-specific recommendations
  const lowPerformingIndustries = byIndustry.filter((ind) => (ind.avg_hits || 0) < 2);
  if (lowPerformingIndustries.length > 0) {
    const industries = lowPerformingIndustries.map((ind) => ind.industry).join(', ');
    recommendations.push(`Low cache performance for industries: ${industries}. Tune cache strategy.`);
  }

  // Cache lifetime recommendations
  if (metrics.averageCacheLifetime < 4) {
    recommendations.push(
      'Short average cache lifetime. Consider increasing TTL from 24h or reducing eviction frequency.'
    );
  }

  return recommendations;
}
