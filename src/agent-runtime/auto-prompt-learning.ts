/**
 * Automatic Prompt Learning System
 * Extracts insights from best-performing scripts and auto-adjusts prompt templates
 *
 * Process:
 * 1. Find scripts in top 10% conversion rate by route/industry
 * 2. Extract common keywords, structures, framing
 * 3. Update base prompt template with these patterns
 * 4. Test new template against old one (A/B test)
 * 5. Lock in improvement if conversion rate improves
 */

import type { JsonRecord } from './integrations/provider-runtime-types.js';
import crypto from 'crypto';
import { extractRankedAdaptivePhrases, type RankedAdaptivePhrase } from './adaptive-phrase-learning.js';

export interface LearningInsight {
  id: string;
  insight_type: 'opening_pattern' | 'closing_pattern' | 'value_prop' | 'objection_handler' | 'proof_element';
  route_type: string;
  industry: string;
  pattern_snippet: string;
  frequency_in_top_10pct: number;
  conversion_impact: number;
  confidence_score: number;
  timestamp: string;
}

export interface LearningQualityGate {
  status: 'ready' | 'insufficient_data';
  sample_count: number;
  usable_example_count: number;
  total_calls: number;
  min_usable_examples: number;
  min_total_calls: number;
  no_insight_reason: string;
}

export interface LearningInsightExtractionResult {
  insights: LearningInsight[];
  quality_gate: LearningQualityGate;
}

export interface LearningInsightOptions {
  topPercentile?: number;
  bottomPercentile?: number;
  minUsableExamples?: number;
  minTotalCalls?: number;
}

export interface PromptEvolution {
  id: string;
  base_prompt_hash: string;
  learned_prompt_hash: string;
  generation: number;
  learning_phase: string;
  applied_insights: string[];
  expected_improvement: number;
  actual_improvement?: number;
  status: 'pending' | 'testing' | 'validated' | 'rolled_back';
  created_at: string;
}

/**
 * Extract learning insights from top-performing scripts
 * Identifies what makes best scripts successful
 */
export function extractLearningInsights(
  db: any,
  route_type: string,
  industry: string,
  topPercentile: number = 10
): LearningInsight[] {
  return extractLearningInsightsWithQualityGate(db, route_type, industry, { topPercentile }).insights;
}

export function extractLearningInsightsWithQualityGate(
  db: any,
  route_type: string,
  industry: string,
  options: LearningInsightOptions = {}
): LearningInsightExtractionResult {
  const topPercentile = options.topPercentile ?? 10;
  const minUsableExamples = options.minUsableExamples ?? 1;
  const minTotalCalls = options.minTotalCalls ?? 0;
  const rows = (db as any)
    .prepare(`
      SELECT
        script_content,
        conversion_rate,
        quality_signal,
        call_outcomes
      FROM finetuning_examples
      WHERE route_type = ?
        AND json_extract(lead_profile, '$.industry') = ?
      ORDER BY conversion_rate DESC, created_at DESC
      LIMIT 100
    `)
    .all(route_type, industry) as Array<{
      script_content: string;
      conversion_rate: number;
      quality_signal: string;
      call_outcomes: string;
    }>;

  const usableRows = rows.filter((row) => row.quality_signal === 'excellent' || row.quality_signal === 'good');
  const totalCalls = usableRows.reduce((sum, row) => {
    const outcomes = parseJsonRecord(row.call_outcomes);
    const calls = Number(outcomes.total_calls || 0);
    return sum + (Number.isFinite(calls) ? calls : 0);
  }, 0);
  const noInsightReasons: string[] = [];
  if (usableRows.length < minUsableExamples) {
    noInsightReasons.push(`usable examples ${usableRows.length}/${minUsableExamples}`);
  }
  if (totalCalls < minTotalCalls) {
    noInsightReasons.push(`total calls ${totalCalls}/${minTotalCalls}`);
  }
  const baseGate = {
    sample_count: rows.length,
    usable_example_count: usableRows.length,
    total_calls: totalCalls,
    min_usable_examples: minUsableExamples,
    min_total_calls: minTotalCalls
  };
  if (noInsightReasons.length > 0) {
    return {
      insights: [],
      quality_gate: {
        ...baseGate,
        status: 'insufficient_data',
        no_insight_reason: noInsightReasons.join('; ')
      }
    };
  }

  const bottomPercentile = options.bottomPercentile ?? topPercentile;
  const topCount = Math.max(1, Math.ceil(usableRows.length * Math.max(1, Math.min(topPercentile, 100)) / 100));
  const bottomCount = Math.max(1, Math.ceil(usableRows.length * Math.max(1, Math.min(bottomPercentile, 100)) / 100));
  const topScripts = usableRows.slice(0, topCount);
  const bottomScripts = usableRows.slice(Math.max(topCount, usableRows.length - bottomCount));
  const adaptivePhrases = topScripts.length > 0 && bottomScripts.length > 0
    ? extractRankedAdaptivePhrases(
      topScripts.map((script) => script.script_content),
      bottomScripts.map((script) => script.script_content)
    )
    : [];
  const insights = adaptivePhrases.length > 0
    ? adaptivePhrases.map((phrase) => adaptivePhraseToInsight(phrase, route_type, industry))
    : extractLegacyLearningInsights(topScripts, route_type, industry);

  return {
    insights,
    quality_gate: {
      ...baseGate,
      status: 'ready',
      no_insight_reason: ''
    }
  };
}

function adaptivePhraseToInsight(
  phrase: RankedAdaptivePhrase,
  routeType: string,
  industry: string
): LearningInsight {
  return {
    id: `insight_${crypto.randomUUID()}`,
    insight_type: classifyAdaptiveInsightType(phrase.phrase),
    route_type: routeType,
    industry,
    pattern_snippet: phrase.phrase,
    frequency_in_top_10pct: phrase.top_frequency_pct,
    conversion_impact: phrase.chi_square / 10,
    confidence_score: Math.min(phrase.chi_square / 20, 1),
    timestamp: new Date().toISOString()
  };
}

function classifyAdaptiveInsightType(phrase: string): LearningInsight['insight_type'] {
  if (/(\d|%|case|proof|proven|verified|data|customer|revenue|roi|result|案例|证明|客户|数据|超过)/i.test(phrase)) {
    return 'proof_element';
  }
  return 'value_prop';
}

function extractLegacyLearningInsights(
  topScripts: Array<{ script_content: string; conversion_rate: number }>,
  routeType: string,
  industry: string
): LearningInsight[] {
  const insights: LearningInsight[] = [];
  const patterns: Record<string, number> = {};
  topScripts.forEach((script) => {
    const content = script.script_content;
    const impact = script.conversion_rate;
    const opening = content.split('\n')[0]?.substring(0, 30) || '';
    if (opening) patterns[`opening_pattern:${opening}`] = (patterns[`opening_pattern:${opening}`] || 0) + impact;
    const lines = content.split('\n');
    const closing = lines[lines.length - 1]?.substring(0, 30) || '';
    if (closing) patterns[`closing_pattern:${closing}`] = (patterns[`closing_pattern:${closing}`] || 0) + impact;
    ['保证', '结果', '快速', '简单', '省时', 'ROI', '成本', '增长'].forEach((keyword) => {
      if (content.includes(keyword)) patterns[`value_prop:${keyword}`] = (patterns[`value_prop:${keyword}`] || 0) + impact;
    });
    ['已', '证明', '客户', '案例', '数据', '测试', '超过'].forEach((keyword) => {
      if (content.includes(keyword)) patterns[`proof_element:${keyword}`] = (patterns[`proof_element:${keyword}`] || 0) + impact;
    });
  });
  const totalScripts = topScripts.length;
  Object.entries(patterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([pattern, score]) => {
      const [patternType, ...contentParts] = pattern.split(':');
      const content = contentParts.join(':');
      const frequency = topScripts.filter((script) => script.script_content.includes(content)).length;
      insights.push({
        id: `insight_${crypto.randomUUID()}`,
        insight_type: patternType as LearningInsight['insight_type'],
        route_type: routeType,
        industry,
        pattern_snippet: content,
        frequency_in_top_10pct: totalScripts > 0 ? (frequency / totalScripts) * 100 : 0,
        conversion_impact: totalScripts > 0 ? score / totalScripts : 0,
        confidence_score: Math.min(frequency / 3, 1),
        timestamp: new Date().toISOString()
      });
    });
  return insights;
}

function parseJsonRecord(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : {};
  } catch {
    return {};
  }
}

/**
 * Apply learning insights to update system prompt
 * Modifies base prompt to emphasize learned patterns
 */
export function applyInsightsToPrompt(
  baseSystemPrompt: string,
  insights: LearningInsight[]
): string {
  if (insights.length === 0) {
    return baseSystemPrompt;
  }

  let updatedPrompt = baseSystemPrompt;

  // Group insights by type
  const byType: Record<string, LearningInsight[]> = {};
  insights.forEach((insight) => {
    if (!byType[insight.insight_type]) {
      byType[insight.insight_type] = [];
    }
    byType[insight.insight_type].push(insight);
  });

  // Apply opening insights
  if (byType['opening_pattern']) {
    const openingPatterns = byType['opening_pattern']
      .slice(0, 3)
      .map((i) => i.pattern_snippet)
      .join(', ');
    updatedPrompt += `\n\n## 基于数据的开场优化\n根据历史数据，以下开场方式效果最佳：${openingPatterns}`;
  }

  // Apply value prop insights
  if (byType['value_prop']) {
    const valueProps = byType['value_prop']
      .slice(0, 3)
      .map((i) => i.pattern_snippet)
      .join(', ');
    updatedPrompt += `\n\n## 高效价值传递\n重点强调：${valueProps}`;
  }

  // Apply proof insights
  if (byType['proof_element']) {
    const proofElements = byType['proof_element']
      .slice(0, 3)
      .map((i) => i.pattern_snippet)
      .join(', ');
    updatedPrompt += `\n\n## 可信度提升要素\n在脚本中融入：${proofElements}`;
  }

  return updatedPrompt;
}

/**
 * Track prompt evolution and A/B test results
 */
export function createPromptEvolution(
  db: any,
  basePromptHash: string,
  learnedPromptHash: string,
  appliedInsights: LearningInsight[]
): boolean {
  try {
    const query = `
      INSERT INTO prompt_evolution
      (id, base_prompt_hash, learned_prompt_hash, generation, learning_phase, applied_insights, expected_improvement, status, created_at)
      VALUES (?, ?, ?, 1, 'auto_learning', ?, ?, 'testing', datetime('now'))
    `;

    const expectedImprovement =
      appliedInsights.reduce((sum, i) => sum + i.conversion_impact, 0) / Math.max(appliedInsights.length, 1);

    (db as any)
      .prepare(query)
      .run(
        `evo_${crypto.randomUUID()}`,
        basePromptHash,
        learnedPromptHash,
        JSON.stringify(appliedInsights.map((i) => i.id)),
        expectedImprovement
      );

    return true;
  } catch (e) {
    console.debug('Prompt evolution tracking failed:', (e as Error).message);
    return false;
  }
}

/**
 * Promote successful learned prompt to new baseline
 */
export function promoteLearnedPrompt(db: any, evolutionId: string): boolean {
  try {
    const query = `
      UPDATE prompt_evolution
      SET status = 'validated'
      WHERE id = ?
    `;

    (db as any).prepare(query).run(evolutionId);
    return true;
  } catch (e) {
    console.debug('Prompt promotion failed:', (e as Error).message);
    return false;
  }
}

/**
 * Get learning performance metrics
 * Tracks how much auto-learning has improved overall conversion rates
 */
export function getLearningMetrics(db: any): {
  total_insights_extracted: number;
  insights_applied: number;
  avg_improvement_per_insight: number;
  validated_evolutions: number;
  current_baseline_improvement: number;
} {
  try {
    const insightCountQuery = `
      SELECT COUNT(*) as count FROM learning_insights
    `;
    const totalInsights = ((db as any).prepare(insightCountQuery).get() as { count: number }).count || 0;

    const appliedQuery = `
      SELECT COUNT(*) as count FROM prompt_evolution WHERE status = 'validated'
    `;
    const appliedCount = ((db as any).prepare(appliedQuery).get() as { count: number }).count || 0;

    const improvementQuery = `
      SELECT AVG(actual_improvement) as avg_imp FROM prompt_evolution WHERE actual_improvement IS NOT NULL
    `;
    const improvementResult = (db as any).prepare(improvementQuery).get() as { avg_imp: number };
    const avgImprovement = (improvementResult.avg_imp || 0) * 100; // Convert to percentage

    return {
      total_insights_extracted: totalInsights,
      insights_applied: appliedCount,
      avg_improvement_per_insight: totalInsights > 0 ? avgImprovement / Math.max(totalInsights, 1) : 0,
      validated_evolutions: appliedCount,
      current_baseline_improvement: avgImprovement
    };
  } catch (e) {
    console.debug('Learning metrics retrieval failed:', (e as Error).message);
    return {
      total_insights_extracted: 0,
      insights_applied: 0,
      avg_improvement_per_insight: 0,
      validated_evolutions: 0,
      current_baseline_improvement: 0
    };
  }
}
