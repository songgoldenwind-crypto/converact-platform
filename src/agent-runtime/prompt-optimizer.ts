/**
 * Phase 6.4: Automatic Prompt Optimization
 * 
 * Generates improved prompts based on:
 * 1. Winning variant characteristics (from Phase 6.3)
 * 2. Historical efficacy patterns
 * 3. A/B test results
 * 
 * Output: New prompt version that incorporates learnings from winners
 */

import type { DatabaseSync as Database } from 'node:sqlite';
import { compareEfficacyForTenant, getSourceEfficacyInsights } from './ai-template-comparator.js';

export interface PromptVersion {
  versionNumber: number;
  promptHash: string;
  createdAt: string;
  basedOnComparison: {
    dominantStyle: string;
    recommendedSource: 'ai_generated' | 'template' | 'hybrid';
    aiWinPercentage: number;
  };
  keyImprovements: string[];
  expectedImpact: number; // Estimated conversion rate improvement (0-1)
}

/**
 * Generate an optimized prompt based on efficacy comparison
 * This is the core of the optimization loop
 */
export function generateOptimizedPrompt(
  db: Database,
  currentPromptVersion: number,
  tenantId?: string
): PromptVersion {
  const comparison = compareEfficacyForTenant(db, tenantId);
  const aiInsights = getSourceEfficacyInsights(db, 'ai_generated', tenantId);
  const templateInsights = getSourceEfficacyInsights(db, 'template', tenantId);

  const keyImprovements: string[] = [];
  let expectedImpact = 0.05; // Base 5% improvement

  // Improvement 1: Learn dominant style
  if (comparison.dominantStyle !== 'neutral') {
    keyImprovements.push(`Incorporate ${comparison.dominantStyle} language patterns (winner characteristic)`);
    expectedImpact += 0.02; // 2% boost
  }

  // Improvement 2: Learn from source-specific patterns
  if (comparison.aiWinPercentage > 55) {
    keyImprovements.push('Favor AI-generated creativity over templates');
    const topAiStyle = aiInsights.topStyles[0]?.style || 'neutral';
    if (topAiStyle && topAiStyle !== 'neutral') {
      keyImprovements.push(`Use ${topAiStyle} tone consistently`);
    }
    expectedImpact += 0.03;
  } else if (comparison.templateWinPercentage > 55) {
    keyImprovements.push('Leverage template structure for reliability');
    expectedImpact += 0.02;
  }

  // Improvement 3: Incorporate winning phrases
  const topPhrases = [...aiInsights.commonPhrases, ...templateInsights.commonPhrases]
    .slice(0, 3);
  
  if (topPhrases.length > 0) {
    keyImprovements.push(`Integrate proven phrases: ${topPhrases.join(', ')}`);
    expectedImpact += 0.02;
  }

  // Improvement 4: Sample size guidance
  if (comparison.statsSummary.testsWithSignificance > 5) {
    keyImprovements.push('Based on statistically significant data (5+ tests)');
    expectedImpact += 0.01; // Confidence bonus
  }

  // Generate prompt hash from improvements
  const promptHash = generatePromptHash(comparison, keyImprovements);

  return {
    versionNumber: currentPromptVersion + 1,
    promptHash,
    createdAt: new Date().toISOString(),
    basedOnComparison: {
      dominantStyle: comparison.dominantStyle,
      recommendedSource: comparison.recommendedSourceForNextRound,
      aiWinPercentage: comparison.aiWinPercentage,
    },
    keyImprovements,
    expectedImpact: Math.min(expectedImpact, 0.15), // Cap at 15% improvement
  };
}

/**
 * Generate unique hash for prompt to track versions
 */
export function generatePromptHash(comparison: any, improvements: string[]): string {
  const content = JSON.stringify({
    style: comparison.dominantStyle,
    source: comparison.recommendedSourceForNextRound,
    improvements: improvements.sort(),
  });
  
  // Simple hash for tracking (not cryptographic)
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  return `v${Math.abs(hash).toString(36).substring(0, 8)}`;
}

/**
 * Store prompt version history for tracking
 */
export function savePromptVersion(
  db: Database,
  version: PromptVersion,
  promptText: string
): PromptVersion {
  const existing = db.prepare(`
    SELECT
      version_number,
      COALESCE(prompt_hash, version_hash) AS prompt_hash,
      created_at,
      dominant_style,
      recommended_source,
      expected_improvement
    FROM prompt_versions
    WHERE prompt_hash = ? OR version_hash = ?
    LIMIT 1
  `).get(version.promptHash, version.promptHash) as any;

  if (existing) {
    return {
      versionNumber: existing.version_number,
      promptHash: existing.prompt_hash,
      createdAt: existing.created_at,
      basedOnComparison: {
        dominantStyle: existing.dominant_style || version.basedOnComparison.dominantStyle,
        recommendedSource: existing.recommended_source || version.basedOnComparison.recommendedSource,
        aiWinPercentage: version.basedOnComparison.aiWinPercentage,
      },
      keyImprovements: version.keyImprovements,
      expectedImpact: existing.expected_improvement ?? version.expectedImpact,
    };
  }

  db.prepare(`
    INSERT INTO prompt_versions (
      version_number,
      version_id,
      version_hash,
      prompt_hash,
      system_prompt,
      user_prompt,
      prompt_text,
      dominant_style,
      learning_phase,
      recommended_source,
      expected_improvement,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    version.versionNumber,
    `prompt-version-${version.versionNumber}`,
    version.promptHash,
    version.promptHash,
    promptText,
    '',
    promptText,
    version.basedOnComparison.dominantStyle,
    'optimized',
    version.basedOnComparison.recommendedSource,
    version.expectedImpact,
    version.createdAt
  );

  return version;
}

/**
 * Get best performing prompt version
 */
export function getBestPromptVersion(db: Database): PromptVersion | null {
  // Get latest prompt version (highest version_number)
  const result = db.prepare(`
    SELECT 
      version_number,
      prompt_hash,
      created_at,
      dominant_style,
      recommended_source,
      expected_improvement
    FROM prompt_versions
    ORDER BY version_number DESC
    LIMIT 1
  `).get() as any;

  if (!result) return null;

  return {
    versionNumber: result.version_number,
    promptHash: result.prompt_hash,
    createdAt: result.created_at,
    basedOnComparison: {
      dominantStyle: result.dominant_style,
      recommendedSource: result.recommended_source,
      aiWinPercentage: 0, // Not available in this context
    },
    keyImprovements: [],
    expectedImpact: result.expected_improvement,
  };
}

/**
 * Generate next iteration prompt incorporating learnings
 * This is used as the system prompt for the next round of script generation
 */
export function buildNextIterationSystemPrompt(
  db: Database,
  basePrompt: string,
  version: PromptVersion
): string {
  const improvements = version.keyImprovements;
  
  let enhancedPrompt = basePrompt;
  
  // Add style guidance
  if (version.basedOnComparison.dominantStyle !== 'neutral') {
    enhancedPrompt += `\n\nScript Style Guidance: Use ${version.basedOnComparison.dominantStyle} language and tone based on winning variants.`;
  }
  
  // Add source preference
  if (version.basedOnComparison.recommendedSource === 'ai_generated') {
    enhancedPrompt += '\n\nGeneration Strategy: Prioritize creative, AI-generated approaches over rigid templates.';
  } else if (version.basedOnComparison.recommendedSource === 'template') {
    enhancedPrompt += '\n\nGeneration Strategy: Follow proven template structures for reliability.';
  } else {
    enhancedPrompt += '\n\nGeneration Strategy: Combine AI creativity with template structure for balanced approach.';
  }
  
  // Add key improvements as constraints
  if (improvements.length > 0) {
    enhancedPrompt += '\n\nKey Improvements to Incorporate:';
    improvements.forEach((imp, i) => {
      enhancedPrompt += `\n${i + 1}. ${imp}`;
    });
  }
  
  // Add expectation
  enhancedPrompt += `\n\nExpected Improvement: ${(version.expectedImpact * 100).toFixed(1)}% conversion rate increase.`;
  
  return enhancedPrompt;
}

/**
 * Get prompt optimization history and trends
 */
export function getPromptOptimizationHistory(db: Database): {
  versions: Array<{
    versionNumber: number;
    promptHash: string;
    createdAt: string;
    improvedBy: number; // Percentage improvement vs previous
  }>;
  trend: 'improving' | 'stable' | 'declining';
  recommendAction: string;
} {
  const versions = db.prepare(`
    SELECT 
      version_number,
      prompt_hash,
      created_at,
      expected_improvement
    FROM prompt_versions
    ORDER BY version_number ASC
  `).all() as any[];

  if (versions.length === 0) {
    return {
      versions: [],
      trend: 'stable',
      recommendAction: 'Start with baseline prompt. Run A/B tests to establish baseline.',
    };
  }

  const versionHistory = versions.map((v, i) => ({
    versionNumber: v.version_number,
    promptHash: v.prompt_hash,
    createdAt: v.created_at,
    improvedBy: i === 0 ? 0 : (v.expected_improvement - (versions[i - 1]?.expected_improvement || 0)) * 100,
  }));

  // Calculate trend
  let improvementCount = 0;
  let declineCount = 0;
  
  for (let i = 1; i < versionHistory.length; i++) {
    if (versionHistory[i].improvedBy > 0) {
      improvementCount++;
    } else if (versionHistory[i].improvedBy < 0) {
      declineCount++;
    }
  }

  let trend: 'improving' | 'stable' | 'declining' = 'stable';
  if (improvementCount > declineCount) {
    trend = 'improving';
  } else if (declineCount > improvementCount) {
    trend = 'declining';
  }

  let recommendAction = '';
  if (trend === 'improving') {
    recommendAction = `Continue optimizing. Latest version shows ${versionHistory[versionHistory.length - 1]?.improvedBy?.toFixed(1) || 0}% improvement.`;
  } else if (trend === 'declining') {
    recommendAction = 'Optimization plateau reached. Consider manual prompt redesign or new A/B testing approach.';
  } else {
    recommendAction = 'Optimization stable. Run larger A/B tests to detect meaningful improvements.';
  }

  return {
    versions: versionHistory,
    trend,
    recommendAction,
  };
}
