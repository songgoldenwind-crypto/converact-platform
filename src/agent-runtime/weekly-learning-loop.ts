import { all, run } from '../db.js';
import { compareEfficacyForTenant } from './ai-template-comparator.js';
import {
  buildNextIterationSystemPrompt,
  generateOptimizedPrompt,
  getBestPromptVersion,
  getPromptOptimizationHistory,
  savePromptVersion,
} from './prompt-optimizer.js';

export interface WeeklyLearningResult {
  tenantId: string;
  executedAt: string;
  testsAnalyzed: number;
  promptGenerated: boolean;
  recommendedSource: 'ai_generated' | 'template' | 'hybrid';
  dominantStyle: string;
  promptVersionNumber: number | null;
  expectedImpact: number;
  recommendations: string[];
}

function recordLearningStat(
  db: any,
  tenantId: string,
  metricName: string,
  metricValue: number,
  note?: string,
  context?: Record<string, unknown>
): void {
  run(
    db,
    `INSERT INTO optimization_stats (
      id, tenant_id, stat_type, metric_name, metric_value, note, context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      `learning_${metricName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      'learning',
      metricName,
      metricValue,
      note || null,
      context ? JSON.stringify(context) : null,
    ]
  );
}

export function generateWeeklyLearningRecommendations(
  testsAnalyzed: number,
  recommendedSource: 'ai_generated' | 'template' | 'hybrid',
  dominantStyle: string,
  expectedImpact: number
): string[] {
  const recommendations: string[] = [];

  if (testsAnalyzed === 0) {
    return [
      'No completed A/B tests available yet. Keep collecting call outcomes before optimizing prompts.',
    ];
  }

  recommendations.push(`Prioritize ${recommendedSource} generation strategy next week.`);

  if (dominantStyle !== 'neutral' && dominantStyle !== 'unknown') {
    recommendations.push(`Lean into ${dominantStyle} style patterns in the next script round.`);
  }

  if (expectedImpact >= 0.1) {
    recommendations.push('Expected lift is high enough to promote this prompt version broadly.');
  } else if (expectedImpact >= 0.05) {
    recommendations.push('Expected lift is moderate; roll this prompt out to the next A/B batch.');
  } else {
    recommendations.push('Signal is weak; keep the new prompt in controlled testing before full rollout.');
  }

  return recommendations;
}

export function runWeeklyLearningCycle(
  db: any,
  tenantId: string,
  basePrompt: string
): WeeklyLearningResult {
  const executedAt = new Date().toISOString();
  const comparison = compareEfficacyForTenant(db, tenantId);
  const currentBest = getBestPromptVersion(db);
  const currentVersionNumber = currentBest?.versionNumber ?? 0;

  const nextVersion = generateOptimizedPrompt(db, currentVersionNumber, tenantId);
  const optimizedPrompt = buildNextIterationSystemPrompt(db, basePrompt, nextVersion);
  const savedVersion = savePromptVersion(db, nextVersion, optimizedPrompt);

  const recommendations = generateWeeklyLearningRecommendations(
    comparison.statsSummary.totalTestsAnalyzed,
    comparison.recommendedSourceForNextRound,
    comparison.dominantStyle,
    nextVersion.expectedImpact
  );

  recordLearningStat(
    db,
    tenantId,
    'weekly_learning_tests_analyzed',
    comparison.statsSummary.totalTestsAnalyzed,
    'Weekly learning loop analyzed completed A/B tests',
    {
      dominantStyle: comparison.dominantStyle,
      recommendedSource: comparison.recommendedSourceForNextRound,
    }
  );
  recordLearningStat(
    db,
    tenantId,
    'weekly_learning_prompt_version',
    savedVersion.versionNumber,
    'Generated next prompt version from weekly learning loop',
    {
      promptHash: savedVersion.promptHash,
      expectedImpact: savedVersion.expectedImpact,
    }
  );
  recordLearningStat(
    db,
    tenantId,
    'weekly_learning_expected_impact_pct',
    Number((savedVersion.expectedImpact * 100).toFixed(2)),
    'Expected prompt improvement percentage',
    {
      recommendationCount: recommendations.length,
    }
  );

  return {
    tenantId,
    executedAt,
    testsAnalyzed: comparison.statsSummary.totalTestsAnalyzed,
    promptGenerated: true,
    recommendedSource: comparison.recommendedSourceForNextRound,
    dominantStyle: comparison.dominantStyle,
    promptVersionNumber: savedVersion.versionNumber,
    expectedImpact: savedVersion.expectedImpact,
    recommendations,
  };
}

export function runWeeklyLearningForAllTenants(
  db: any,
  basePrompt: string
): WeeklyLearningResult[] {
  const tenants = all(db, `SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at ASC`);
  return tenants.map((tenant: any) => runWeeklyLearningCycle(db, tenant.id, basePrompt));
}

export function getWeeklyLearningSummary(db: any, tenantId: string): {
  historyTrend: 'improving' | 'stable' | 'declining';
  latestPromptVersion: number | null;
  latestExpectedImpact: number;
  recentLearningRuns: number;
} {
  const history = getPromptOptimizationHistory(db);
  const latestVersion = history.versions[history.versions.length - 1] || null;
  const recentLearningRuns = all(
    db,
    `SELECT id
     FROM optimization_stats
     WHERE tenant_id = ?
       AND stat_type = 'learning'
       AND metric_name = 'weekly_learning_prompt_version'
     ORDER BY recorded_at DESC
     LIMIT 10`,
    [tenantId]
  ).length;

  return {
    historyTrend: history.trend,
    latestPromptVersion: latestVersion?.versionNumber ?? null,
    latestExpectedImpact: latestVersion ? Math.max(0, latestVersion.improvedBy / 100) : 0,
    recentLearningRuns,
  };
}
