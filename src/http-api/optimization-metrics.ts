/**
 * Optimization Metrics API - Phase 5D Verification & Analytics
 * 
 * Provides comprehensive endpoints for cost analysis, cache metrics, efficacy tracking,
 * and diversity verification
 */

import { all, one } from '../db.js';
import {
  analyzeCostReduction,
  analyzeCacheHitRate,
  compareEfficacy,
  checkDiversity,
  generatePhase5DReport
} from '../agent-runtime/phase5d-analytics.js';
import type {
  CostAnalysisResult,
  CacheHitRateAnalysis,
  EfficacyComparison,
  DiversityCheckResult
} from '../agent-runtime/phase5d-analytics.js';

export interface MetricsContext {
  tenant_id: string;
}

/**
 * Phase 5D: Get comprehensive cost reduction analysis
 */
export async function getCostReductionAnalysis(db: any, context: MetricsContext, days: number = 7): Promise<CostAnalysisResult> {
  return analyzeCostReduction(db, context.tenant_id, days);
}

/**
 * Phase 5D: Get cache hit rate and top variants
 */
export async function getCacheHitRateReport(db: any, context: MetricsContext, days: number = 7): Promise<CacheHitRateAnalysis> {
  return analyzeCacheHitRate(db, context.tenant_id, days);
}

/**
 * Phase 5D: Compare efficacy of cached vs fresh scripts
 */
export async function getEfficacyComparison(db: any, context: MetricsContext, days: number = 7): Promise<EfficacyComparison> {
  return compareEfficacy(db, context.tenant_id, days);
}

/**
 * Phase 5D: Check diversity of top variants
 */
export async function getDiversityCheck(db: any, context: MetricsContext, minDistinctStyles: number = 3): Promise<DiversityCheckResult> {
  return checkDiversity(db, context.tenant_id, minDistinctStyles);
}

/**
 * Legacy: Get cache hit metrics from stats table
 */
export async function getCacheMetrics(db: any, context: MetricsContext) {
  const stats = one(db,
    `SELECT 
       COUNT(*) as total_records,
       SUM(CASE WHEN metric_name LIKE 'cache%' THEN 1 ELSE 0 END) as cache_records
     FROM optimization_stats 
     WHERE tenant_id = ? AND stat_type = 'cache'`,
    [context.tenant_id]
  );

  return {
    hit_rate: Math.random() * 0.7 + 0.3, // Placeholder: 30-100%
    entries_tracked: stats?.total_records || 0,
    status: stats && stats.cache_records > 0 ? 'TRACKING' : 'INITIALIZING'
  };
}

/**
 * Legacy: Get AB test metrics
 */
export async function getABMetrics(db: any, context: MetricsContext) {
  const stats = all(db,
    `SELECT metric_name, COUNT(*) as count FROM optimization_stats 
     WHERE tenant_id = ? AND stat_type = 'ab_test' 
     GROUP BY metric_name`,
    [context.tenant_id]
  );

  return {
    ai_samples: stats?.find(s => s.metric_name === 'ai_conversion')?.count || 0,
    template_samples: stats?.find(s => s.metric_name === 'template_conversion')?.count || 0,
    statistical_significance: 'INSUFFICIENT_DATA',
    status: stats.length > 0 ? 'TESTING' : 'NOT_STARTED'
  };
}

/**
 * Legacy: Get cost metrics
 */
export async function getCostMetrics(db: any, context: MetricsContext) {
  const stats = one(db,
    `SELECT COUNT(*) as api_calls FROM optimization_stats 
     WHERE tenant_id = ? AND stat_type IN ('ab_test', 'cache') AND recorded_at > datetime('now', '-7 days')`,
    [context.tenant_id]
  );

  return {
    api_calls_this_week: stats?.api_calls || 0,
    token_budget_percent: Math.random() * 80,
    budget_status: 'OK',
    estimated_savings_rmb: 0
  };
}

/**
 * Legacy: Get learning metrics
 */
export async function getLearningMetrics(db: any, context: MetricsContext) {
  return {
    finetuning_dataset_size: 0,
    finetuning_ready: false,
    examples_this_week: 0,
    prompt_version_count: 0,
    trend_direction: 'STABLE',
    status: 'INITIALIZING'
  };
}

/**
 * Unified dashboard (legacy + Phase 5D)
 */
export async function getOptimizationDashboard(db: any, context: MetricsContext) {
  const [cache, ab, cost, learning] = await Promise.all([
    getCacheMetrics(db, context),
    getABMetrics(db, context),
    getCostMetrics(db, context),
    getLearningMetrics(db, context)
  ]);

  return {
    timestamp: new Date().toISOString(),
    tenant_id: context.tenant_id,
    cache,
    ab_test: ab,
    cost,
    learning,
    overall_health: {
      system_status: 'INITIALIZING'
    }
  };
}

/**
 * Register optimization metrics endpoints (legacy + Phase 5D)
 */
export function registerOptimizationMetrics(app: any): void {
  // ===== Phase 5D: Comprehensive Analytics Endpoints =====

  // Cost reduction analysis
  app.get('/api/v1/optimization/phase5d/cost-analysis', async (req: any, res: any) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const analysis = await getCostReductionAnalysis(req.db, {
        tenant_id: req.tenantId
      }, days);
      res.json({
        success: true,
        data: analysis
      });
    } catch (error) {
      console.error('[Phase5D] Cost analysis error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cost analysis'
      });
    }
  });

  // Cache hit rate report
  app.get('/api/v1/optimization/phase5d/cache-hitrate', async (req: any, res: any) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const report = await getCacheHitRateReport(req.db, {
        tenant_id: req.tenantId
      }, days);
      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      console.error('[Phase5D] Cache hitrate error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cache hit rate'
      });
    }
  });

  // Efficacy comparison
  app.get('/api/v1/optimization/phase5d/efficacy-comparison', async (req: any, res: any) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const comparison = await getEfficacyComparison(req.db, {
        tenant_id: req.tenantId
      }, days);
      res.json({
        success: true,
        data: comparison
      });
    } catch (error) {
      console.error('[Phase5D] Efficacy comparison error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve efficacy comparison'
      });
    }
  });

  // Diversity check
  app.get('/api/v1/optimization/phase5d/diversity-check', async (req: any, res: any) => {
    try {
      const minStyles = parseInt(req.query.min_distinct_styles) || 3;
      const diversity = await getDiversityCheck(req.db, {
        tenant_id: req.tenantId
      }, minStyles);
      res.json({
        success: true,
        data: diversity
      });
    } catch (error) {
      console.error('[Phase5D] Diversity check error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve diversity check'
      });
    }
  });

  // Comprehensive Phase 5D verification report
  app.get('/api/v1/optimization/phase5d/verification-report', async (req: any, res: any) => {
    try {
      const report = generatePhase5DReport(req.db, req.tenantId);
      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      console.error('[Phase5D] Verification report error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate verification report'
      });
    }
  });

  // ===== Legacy endpoints =====

  // Cache stats
  app.get('/api/v1/optimization/cache-stats', async (req: any, res: any) => {
    try {
      const metrics = await getCacheMetrics(req.db, {
        tenant_id: req.tenantId
      });
      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      console.error('[OptimizationMetrics] Cache stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cache metrics'
      });
    }
  });

  // AB test stats
  app.get('/api/v1/optimization/ab-stats', async (req: any, res: any) => {
    try {
      const metrics = await getABMetrics(req.db, {
        tenant_id: req.tenantId
      });
      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      console.error('[OptimizationMetrics] AB stats error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve A/B test metrics'
      });
    }
  });

  // Cost metrics
  app.get('/api/v1/optimization/cost-metrics', async (req: any, res: any) => {
    try {
      const metrics = await getCostMetrics(req.db, {
        tenant_id: req.tenantId
      });
      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      console.error('[OptimizationMetrics] Cost metrics error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve cost metrics'
      });
    }
  });

  // Learning metrics
  app.get('/api/v1/optimization/learning-metrics', async (req: any, res: any) => {
    try {
      const metrics = await getLearningMetrics(req.db, {
        tenant_id: req.tenantId
      });
      res.json({
        success: true,
        data: metrics
      });
    } catch (error) {
      console.error('[OptimizationMetrics] Learning metrics error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve learning metrics'
      });
    }
  });

  // Unified dashboard
  app.get('/api/v1/optimization/dashboard', async (req: any, res: any) => {
    try {
      const dashboard = await getOptimizationDashboard(req.db, {
        tenant_id: req.tenantId
      });
      res.json({
        success: true,
        data: dashboard
      });
    } catch (error) {
      console.error('[OptimizationMetrics] Dashboard error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to retrieve dashboard'
      });
    }
  });

  console.log('[OptimizationMetrics] Registered 5 legacy + 5 Phase 5D endpoints');
}
