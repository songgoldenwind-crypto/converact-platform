/**
 * Script Cache Manager (PHASE 5B)
 * 
 * Handles script generation caching to achieve 65-75% cost reduction via:
 * 1. Cache key generation from (industry, target_profile_hash)
 * 2. Cache hit/miss logic with TTL expiration (24h)
 * 3. Efficacy data externalization (Manus Pattern 3)
 * 4. Cache eviction and invalidation strategies
 * 
 * Expected improvement: 65-75% cost reduction from caching + 20-30% from externalization
 */

import { all, id, one, run, json } from '../db.js';
import crypto from 'crypto';

export interface CacheCheckResult {
  hit: boolean;
  cacheKey: string;
  script?: string;
  model?: string;
  source?: string;
  cacheId?: string;
  cachedAt?: string;
}

export interface CacheWriteInput {
  tenantId: string;
  industry: string;
  location?: string;
  targetProfile: string;
  scriptContent: string;
  variantSource: 'ai_generated' | 'template';
  model?: string;
  ttlHours?: number;
}

export interface CacheWriteResult {
  cacheId: string;
  cacheKey: string;
  cachedAt: string;
}

export interface EfficacyArchiveInput {
  tenantId: string;
  runId: string;
  efficacyData: Record<string, any>;
}

/**
 * Generate cache key from industry and target profile
 */
export function generateCacheKey(industry: string, targetProfile: string, location?: string): string {
  const combined = `${industry}|${location || ''}|${targetProfile}`.toLowerCase();
  return crypto.createHash('md5').update(combined).digest('hex');
}

/**
 * Generate profile hash for deduplication
 */
export function generateProfileHash(targetProfile: string): string {
  return crypto.createHash('sha256').update(targetProfile).digest('hex');
}

/**
 * Check if cached script is available
 */
export function checkScriptCache(
  db: any,
  tenantId: string,
  industry: string,
  targetProfile: string,
  location?: string
): CacheCheckResult {
  const cacheKey = generateCacheKey(industry, targetProfile, location);
  
  // Query cache with expiration check
  const cached = one(
    db,
    `SELECT id, script_content, model, variant_source, created_at 
     FROM script_cache 
     WHERE tenant_id = ? AND cache_key = ? AND expires_at > CURRENT_TIMESTAMP
     ORDER BY hit_count DESC
     LIMIT 1`,
    [tenantId, cacheKey]
  );

  if (cached) {
    // Update hit count and timestamp (non-blocking async would be better in production)
    run(
      db,
      `UPDATE script_cache 
       SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP 
       WHERE id = ?`,
      [cached.id]
    );

    return {
      hit: true,
      cacheKey,
      script: cached.script_content,
      model: cached.model,
      source: cached.variant_source,
      cacheId: cached.id,
      cachedAt: cached.created_at,
    };
  }

  return { hit: false, cacheKey };
}

/**
 * Write script to cache
 */
export function writeScriptCache(db: any, input: CacheWriteInput): CacheWriteResult | null {
  const { tenantId, industry, location, targetProfile, scriptContent, variantSource, model, ttlHours = 24 } = input;
  const cacheKey = generateCacheKey(industry, targetProfile, location);
  const profileHash = generateProfileHash(targetProfile);
  const cachedAt = new Date().toISOString();
  
  // Calculate expiration time
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + ttlHours);

  try {
    // Check if already exists
      const existing = one(
        db,
        `SELECT id FROM script_cache WHERE tenant_id = ? AND cache_key = ?`,
        [tenantId, cacheKey]
      );

      if (existing) {
      // Update existing
      run(
        db,
        `UPDATE script_cache 
         SET script_content = ?, variant_source = ?, model = ?, 
             expires_at = ?, hit_count = 0, created_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND cache_key = ?`,
        [
          scriptContent,
          variantSource,
           model || null,
           expiresAt.toISOString(),
           tenantId,
           cacheKey
         ]
       );
       return {
         cacheId: String(existing.id || ''),
         cacheKey,
         cachedAt
       };
     } else {
       const cacheId = id('cache');
       // Insert new
       run(
         db,
         `INSERT INTO script_cache 
          (id, tenant_id, cache_key, industry, target_profile_hash, script_content, variant_source, model, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
         [
           cacheId,
           tenantId,
           cacheKey,
           industry,
           profileHash,
           scriptContent,
          variantSource,
          model || null,
           expiresAt.toISOString(),
         ]
       );
       return {
         cacheId,
         cacheKey,
         cachedAt
       };
     }
  } catch (err) {
    console.warn('Script cache write failed:', err);
    // Non-blocking - don't interrupt main flow
  }
  return null;
}

/**
 * Archive efficacy data for externalization (Manus Pattern 3)
 * 
 * Instead of passing 50+ tokens of efficacy data inline,
 * store in separate table and reference by hash (5 tokens)
 */
export function archiveEfficacyData(db: any, input: EfficacyArchiveInput): string {
  const { tenantId, runId, efficacyData } = input;
  
  const dataJson = JSON.stringify(efficacyData);
  const dataHash = crypto.createHash('sha256').update(dataJson).digest('hex').substring(0, 16);
  
  try {
    // Check if this hash already exists
    const existing = one(
      db,
      `SELECT id FROM efficacy_archive WHERE efficacy_data_hash = ? AND tenant_id = ?`,
      [dataHash, tenantId]
    );

    if (existing) {
      // Just update access tracking
      run(
        db,
        `UPDATE efficacy_archive 
         SET access_count = access_count + 1, accessed_at = CURRENT_TIMESTAMP
         WHERE efficacy_data_hash = ? AND tenant_id = ?`,
        [dataHash, tenantId]
      );
    } else {
      // Insert new record
      run(
        db,
        `INSERT INTO efficacy_archive 
         (id, tenant_id, run_id, efficacy_data_hash, data_json)
         VALUES (?, ?, ?, ?, ?)`,
        [
          id('arch'),
          tenantId,
          runId,
          dataHash,
          dataJson,
        ]
      );
    }
    
    return dataHash;
  } catch (err) {
    console.warn('Efficacy archive write failed:', err);
    return '';
  }
}

/**
 * Retrieve archived efficacy data by hash
 */
export function getArchivedEfficacyData(db: any, tenantId: string, dataHash: string): Record<string, any> | null {
  try {
    const result = one(
      db,
      `SELECT data_json FROM efficacy_archive 
       WHERE tenant_id = ? AND efficacy_data_hash = ?`,
      [tenantId, dataHash]
    );
    
    if (result) {
      // Update access count
      run(
        db,
        `UPDATE efficacy_archive 
         SET access_count = access_count + 1, accessed_at = CURRENT_TIMESTAMP 
         WHERE efficacy_data_hash = ?`,
        [dataHash]
      );
      
      return JSON.parse(result.data_json);
    }
  } catch (err) {
    console.warn('Efficacy archive retrieval failed:', err);
  }
  
  return null;
}

/**
 * Evict expired cache entries
 */
export function evictExpiredCache(db: any, tenantId?: string): number {
  try {
    const result = run(
      db,
      `DELETE FROM script_cache 
       WHERE expires_at < CURRENT_TIMESTAMP 
       ${tenantId ? 'AND tenant_id = ?' : ''}`,
      tenantId ? [tenantId] : []
    );
    
    return result.changes || 0;
  } catch (err) {
    console.warn('Cache eviction failed:', err);
    return 0;
  }
}

/**
 * Evict a specific cache entry by id.
 */
export function evictCacheEntry(db: any, tenantId: string, cacheId: string): boolean {
  try {
    const result = run(
      db,
      `DELETE FROM script_cache
       WHERE tenant_id = ? AND id = ?`,
      [tenantId, cacheId]
    );

    return Number(result.changes || 0) > 0;
  } catch (err) {
    console.warn('Specific cache eviction failed:', err);
    return false;
  }
}

/**
 * Evict low-efficacy cache entries (keep only top performers)
 */
export function evictLowEfficacyCache(db: any, tenantId: string, efficacyThreshold: number = 0.3): number {
  try {
    const result = run(
      db,
      `DELETE FROM script_cache 
       WHERE tenant_id = ? 
       AND avg_efficacy IS NOT NULL 
       AND avg_efficacy < ?`,
      [tenantId, efficacyThreshold]
    );
    
    return result.changes || 0;
  } catch (err) {
    console.warn('Low efficacy eviction failed:', err);
    return 0;
  }
}

/**
 * Update cache efficacy score based on variant performance
 */
export function updateCacheEfficacy(db: any, cacheId: string, efficacy: number): void {
  try {
    run(
      db,
      `UPDATE script_cache 
       SET avg_efficacy = CASE
         WHEN avg_efficacy IS NULL THEN ?
         ELSE (avg_efficacy * 0.7 + ? * 0.3)
       END
       WHERE id = ?`,
      [efficacy, efficacy, cacheId]
    );
  } catch (err) {
    console.warn('Cache efficacy update failed:', err);
  }
}

/**
 * Invalidate cache for specific run (e.g., when target profile changes)
 */
export function invalidateRunCache(db: any, tenantId: string, industry: string, targetProfile?: string, location?: string): number {
  try {
    let query = `DELETE FROM script_cache 
                  WHERE tenant_id = ? AND industry = ?`;
    const params: any[] = [tenantId, industry];

    if (targetProfile && location !== undefined) {
      query += ` AND cache_key = ?`;
      params.push(generateCacheKey(industry, targetProfile, location));
    } else if (targetProfile) {
      const profileHash = generateProfileHash(targetProfile);
      query += ` AND target_profile_hash = ?`;
      params.push(profileHash);
    }
    
    const result = run(db, query, params);
    return result.changes || 0;
  } catch (err) {
    console.warn('Cache invalidation failed:', err);
    return 0;
  }
}

/**
 * Get cache statistics for monitoring
 */
export function getCacheStats(db: any, tenantId: string): Record<string, any> {
  try {
    const stats = one(
      db,
      `SELECT 
         COUNT(*) as total_entries,
         SUM(hit_count) as total_hits,
         COUNT(CASE WHEN expires_at < CURRENT_TIMESTAMP THEN 1 END) as expired_entries,
         AVG(avg_efficacy) as avg_efficacy_score,
         MAX(last_hit_at) as most_recent_hit
       FROM script_cache 
       WHERE tenant_id = ?`,
      [tenantId]
    );
    
    return stats || { total_entries: 0, total_hits: 0, expired_entries: 0 };
  } catch (err) {
    console.warn('Cache stats retrieval failed:', err);
    return { error: err.message };
  }
}

/**
 * Clean up old archive entries (not accessed recently)
 */
export function cleanupOldArchive(db: any, tenantId?: string, daysOld?: number): number {
  const days = daysOld || 7;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  try {
    const whereClause = tenantId
      ? `WHERE tenant_id = ? AND accessed_at < ? AND access_count < 2`
      : `WHERE accessed_at < ? AND access_count < 2`;

    const params: any[] = tenantId ? [tenantId, cutoffDate] : [cutoffDate];
    
    const result = run(
      db,
      `DELETE FROM efficacy_archive ${whereClause}`,
      params
    );

    return result.changes || 0;
  } catch (err) {
    console.warn('Failed to cleanup old archive:', err);
    return 0;
  }
}
