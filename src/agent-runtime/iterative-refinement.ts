/**
 * Iterative Refinement Engine
 * Analyzes efficacy trends and automatically suggests prompt improvements
 *
 * Weekly process:
 * 1. Analyze conversion rates by route type and industry
 * 2. Detect weak routes (conversion_rate < 60%)
 * 3. Extract patterns from best-performing scripts
 * 4. Suggest prompt refinements to emphasize what worked
 * 5. Generate new prompt variants
 */

import type { JsonRecord } from './integrations/provider-runtime-types.js';
import { extractRankedAdaptivePhrases } from './adaptive-phrase-learning.js';

export interface RefinementSuggestion {
  id: string;
  current_conversion_rate: number;
  target_conversion_rate: number;
  weak_areas: string[];
  suggested_improvements: string[];
  supporting_evidence: string[];
  implementation_priority: 'high' | 'medium' | 'low';
  estimated_impact: number; // percentage point improvement
}

export interface RouteTrendAnalysis {
  route_type: string;
  period: string;
  total_scripts: number;
  total_calls: number;
  conversions: number;
  conversion_rate: number;
  trend: 'improving' | 'stable' | 'declining';
  confidence: number;
  weak_signals?: string[];
}

export interface PromptRefinementPlan {
  id: string;
  analysis_date: string;
  route_type: string;
  current_rate: number;
  target_rate: number;
  refinement_focus: string;
  prompt_adjustments: string[];
  test_sample_size: number;
  expected_success_rate: number;
}

/**
 * Analyze conversion rate trends for each route type
 * Identifies which routes need improvement
 */
export function analyzeRouteConversionTrends(db: any, lookbackDays: number = 14): RouteTrendAnalysis[] {
  const query = `
    SELECT
      COALESCE(NULLIF(route_type, ''), 'general') as route_type,
      DATE(created_at) as period,
      COUNT(*) as script_count,
      SUM(COALESCE(json_extract(call_outcomes, '$.total_calls'), 0)) as total_calls,
      SUM(COALESCE(json_extract(call_outcomes, '$.conversions'), 0)) as total_conversions,
      AVG(COALESCE(conversion_rate, 0)) as avg_rate
    FROM finetuning_examples
    WHERE created_at > datetime('now', '-' || ? || ' days')
      AND quality_signal IN ('excellent', 'good', 'fair')
    GROUP BY route_type, DATE(created_at)
    ORDER BY period DESC, route_type
  `;

  const rows = (db as any)
    .prepare(query)
    .all(lookbackDays) as Array<{
    route_type: string;
    period: string;
    script_count: number;
    total_calls: number;
    total_conversions: number;
    avg_rate: number;
  }>;

  const routeData: Record<string, Array<{
    date: string;
    rate: number;
    scriptCount: number;
    totalCalls: number;
    conversions: number;
  }>> = {};

  rows.forEach((row) => {
    if (!routeData[row.route_type]) {
      routeData[row.route_type] = [];
    }
    routeData[row.route_type].push({
      date: row.period,
      rate: row.avg_rate || 0,
      scriptCount: row.script_count || 0,
      totalCalls: row.total_calls || 0,
      conversions: row.total_conversions || 0
    });
  });

  const trends: RouteTrendAnalysis[] = [];

  Object.entries(routeData).forEach(([routeType, dataPoints]) => {
    if (dataPoints.length < 2) return;

    dataPoints.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const oldRate = dataPoints[0].rate;
    const newRate = dataPoints[dataPoints.length - 1].rate;
    const diff = newRate - oldRate;

    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (diff > 0.05) trend = 'improving';
    if (diff < -0.05) trend = 'declining';

    const confidence = Math.min(dataPoints.length / 7, 1.0);

    const weakSignals: string[] = [];
    if (newRate < 0.6) weakSignals.push('Low conversion rate (<60%)');
    if (trend === 'declining') weakSignals.push('Declining trend detected');
    if (newRate < oldRate - 0.1) weakSignals.push('Recent sharp drop (>10pp)');

    trends.push({
      route_type: routeType,
      period: `${dataPoints[0].date} to ${dataPoints[dataPoints.length - 1].date}`,
      total_scripts: dataPoints.reduce((sum, point) => sum + point.scriptCount, 0),
      total_calls: dataPoints.reduce((sum, point) => sum + point.totalCalls, 0),
      conversions: dataPoints.reduce((sum, point) => sum + point.conversions, 0),
      conversion_rate: newRate,
      trend,
      confidence,
      weak_signals: weakSignals
    });
  });

  return trends;
}

/**
 * Extract patterns from best-performing scripts
 * Identifies common phrases, structures, opening tactics
 */
export function extractPatternsFromTopScripts(db: any, limit: number = 50): Record<string, any> {
  const query = `
    SELECT
      script_content,
      conversion_rate,
      COALESCE(NULLIF(route_type, ''), 'general') as route_type
    FROM finetuning_examples
    WHERE conversion_rate >= 0.8
      AND quality_signal IN ('excellent', 'good')
      AND COALESCE(json_extract(call_outcomes, '$.total_calls'), 0) >= 5
    ORDER BY conversion_rate DESC, created_at DESC
    LIMIT ?
  `;

  const scripts = (db as any)
    .prepare(query)
    .all(limit) as Array<{
    script_content: string;
    conversion_rate: number;
    route_type: string;
  }>;
  const comparisonScripts = (db as any)
    .prepare(`
      SELECT
        script_content,
        conversion_rate
      FROM finetuning_examples
      WHERE quality_signal IN ('excellent', 'good', 'fair')
        AND COALESCE(json_extract(call_outcomes, '$.total_calls'), 0) >= 5
      ORDER BY conversion_rate ASC, created_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      script_content: string;
      conversion_rate: number;
    }>;

  const patterns = {
    common_openings: [] as string[],
    common_closing: [] as string[],
    high_engagement_phrases: [] as string[],
    route_patterns: {} as Record<string, string[]>
  };

  scripts.forEach((script) => {
    if (!script.script_content) return;

    const lines = script.script_content.split('\n');

    if (lines.length > 0) {
      patterns.common_openings.push(lines[0].substring(0, 50));
    }

    if (lines.length > 0) {
      patterns.common_closing.push(lines[lines.length - 1].substring(0, 50));
    }

    const legacyValueIndicators = ['证明', '确保', '保证', '已', '超过', '结果', 'ROI', '成本'];
    legacyValueIndicators.forEach((indicator) => {
      if (script.script_content.includes(indicator)) {
        patterns.high_engagement_phrases.push(indicator);
      }
    });

    if (script.route_type) {
      if (!patterns.route_patterns[script.route_type]) {
        patterns.route_patterns[script.route_type] = [];
      }
      patterns.route_patterns[script.route_type].push(script.script_content.substring(0, 100));
    }
  });

  const adaptivePhrases = extractRankedAdaptivePhrases(
    scripts.map((script) => script.script_content),
    comparisonScripts
      .slice(0, Math.max(1, scripts.length))
      .map((script) => script.script_content),
    { maxPhrases: 8 }
  ).map((phrase) => phrase.phrase);
  if (adaptivePhrases.length > 0) {
    patterns.high_engagement_phrases = adaptivePhrases;
  } else {
    patterns.high_engagement_phrases = Array.from(new Set(patterns.high_engagement_phrases));
  }

  return patterns;
}

/**
 * Generate prompt refinement suggestions based on trends and patterns
 */
export function generateRefinementSuggestions(
  trends: RouteTrendAnalysis[],
  patterns: Record<string, any>
): RefinementSuggestion[] {
  const suggestions: RefinementSuggestion[] = [];

  trends.forEach((trend) => {
    if (trend.conversion_rate < 0.75 && trend.weak_signals && trend.weak_signals.length > 0) {
      const weakAreas: string[] = [];
      const improvements: string[] = [];
      let estimatedImpact = 0;

      // Specific suggestions based on weak signals
      if (trend.weak_signals.includes('Low conversion rate (<60%)')) {
        weakAreas.push('Opening effectiveness');
        improvements.push('Add social proof / case study reference upfront');
        improvements.push('Emphasize time-to-value or immediate benefit');
        improvements.push('Reduce perceived risk with guarantee or trial');
        estimatedImpact += 10;
      }

      if (trend.weak_signals.includes('Declining trend detected')) {
        weakAreas.push('Message fatigue');
        improvements.push('Introduce new opening variation');
        improvements.push('Update value props with fresh data/numbers');
        improvements.push('Test different call times or outreach channels');
        estimatedImpact += 8;
      }

      if (
        patterns.high_engagement_phrases &&
        patterns.high_engagement_phrases.length > 0
      ) {
        weakAreas.push('Evidence/credibility');
        improvements.push(`Integrate: ${patterns.high_engagement_phrases.slice(0, 2).join(', ')}`);
        estimatedImpact += 5;
      }

      if (improvements.length > 0) {
        suggestions.push({
          id: `refine_${trend.route_type}_${Date.now()}`,
          current_conversion_rate: trend.conversion_rate,
          target_conversion_rate: Math.min(trend.conversion_rate + (estimatedImpact / 100), 0.95),
          weak_areas: weakAreas,
          suggested_improvements: improvements,
          supporting_evidence: trend.weak_signals || [],
          implementation_priority: trend.conversion_rate < 0.5 ? 'high' : 'medium',
          estimated_impact: estimatedImpact
        });
      }
    }
  });

  return suggestions;
}

/**
 * Create actionable refinement plan for prompt updates
 */
export function createRefinementPlan(
  route_type: string,
  suggestion: RefinementSuggestion,
  currentPromptContent: string
): PromptRefinementPlan {
  return {
    id: `plan_${route_type}_${Date.now()}`,
    analysis_date: new Date().toISOString(),
    route_type,
    current_rate: suggestion.current_conversion_rate,
    target_rate: suggestion.target_conversion_rate,
    refinement_focus: suggestion.weak_areas[0] || 'general improvement',
    prompt_adjustments: suggestion.suggested_improvements,
    test_sample_size: suggestion.implementation_priority === 'high' ? 10 : 20,
    expected_success_rate: suggestion.target_conversion_rate
  };
}

/**
 * Store refinement suggestion for audit/tracking
 */
export function storeRefinementSuggestion(db: any, suggestion: RefinementSuggestion): boolean {
  try {
    const query = `
      INSERT INTO refinement_suggestions
      (id, current_rate, target_rate, weak_areas, improvements, priority, estimated_impact, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `;

    (db as any)
      .prepare(query)
      .run(
        suggestion.id,
        suggestion.current_conversion_rate,
        suggestion.target_conversion_rate,
        JSON.stringify(suggestion.weak_areas),
        JSON.stringify(suggestion.suggested_improvements),
        suggestion.implementation_priority,
        suggestion.estimated_impact
      );

    return true;
  } catch (e) {
    console.debug('Refinement suggestion storage failed:', (e as Error).message);
    return false;
  }
}
