/**
 * Phase 6.3: AI vs Template Efficacy Comparison
 * 
 * Analyzes patterns in winning AB test variants to understand:
 * 1. Which scripts win (AI-generated vs template-based)
 * 2. What characteristics make winners
 * 3. How to improve prompts based on empirical data
 * 
 * Output: Data for prompt optimization (Phase 6.4) and fine-tuning (Phase 7)
 */

import type { DatabaseSync as Database } from 'node:sqlite';

interface WinnerCharacteristics {
  scriptId: string;
  variantId: string;
  source: 'ai_generated' | 'template';
  conversionRate: number;
  sampleSize: number;
  styleClassification: string;
  keyPhrases: string[];
  tokenCount: number;
  efficacyScore: number;
  effectSize: number;
}

interface ComparisonResult {
  aiAverageConversionRate: number;
  templateAverageConversionRate: number;
  aiWinPercentage: number;
  templateWinPercentage: number;
  dominantStyle: string;
  recommendedSourceForNextRound: 'ai_generated' | 'template' | 'hybrid';
  winnerCharacteristics: WinnerCharacteristics[];
  statsSummary: {
    totalTestsAnalyzed: number;
    testsWithSignificance: number;
    testsWithTie: number;
  };
}

function getVariantSource(row: any, suffix: 'a' | 'b'): 'ai_generated' | 'template' | 'user_custom' | null {
  return (row[`source_${suffix}`] || row[`variant_source_${suffix}`] || null) as
    | 'ai_generated'
    | 'template'
    | 'user_custom'
    | null;
}

/**
 * Classify script style (linguistic/structural patterns)
 */
export function classifyScriptStyle(scriptContent: string): string {
  const lowerContent = scriptContent.toLowerCase();
  
  // Count characteristic phrases
  const aggressivePatterns = /\b(immediate|urgent|limited|exclusive|act now|don't miss|today only)\b/gi;
  const consultativePatterns = /\b(understand|help|explore|discuss|consider|would you|let's|how might)\b/gi;
  const professionalPatterns = /\b(professional|confidential|expertise|proven|results|efficient)\b/gi;
  const casualPatterns = /\b(hey|cool|awesome|totally|just|you know|like)\b/gi;
  
  const aggressiveCount = (lowerContent.match(aggressivePatterns) || []).length;
  const consultativeCount = (lowerContent.match(consultativePatterns) || []).length;
  const professionalCount = (lowerContent.match(professionalPatterns) || []).length;
  const casualCount = (lowerContent.match(casualPatterns) || []).length;
  
  const scores = [
    { style: 'aggressive', score: aggressiveCount },
    { style: 'consultative', score: consultativeCount },
    { style: 'professional', score: professionalCount },
    { style: 'casual', score: casualCount },
  ];
  
  const dominant = scores.reduce((max, current) => 
    current.score > max.score ? current : max
  );
  
  return dominant.score > 0 ? dominant.style : 'neutral';
}

/**
 * Extract key phrases from script (up to 5 most distinctive)
 */
export function extractKeyPhrases(scriptContent: string): string[] {
  const words = scriptContent
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3);
  
  // Simple TF-IDF style (most repeated meaningful phrases)
  const phraseFreq = new Map<string, number>();
  
  for (let i = 0; i < words.length - 1; i++) {
    const phrase = `${words[i]} ${words[i + 1]}`;
    phraseFreq.set(phrase, (phraseFreq.get(phrase) || 0) + 1);
  }
  
  return Array.from(phraseFreq.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);
}

/**
 * Detect winner characteristics from a completed AB test
 */
export function detectWinnerCharacteristics(
  db: Database,
  testId: string,
  tenantId: string
): WinnerCharacteristics | null {
  const test = db.prepare(`
    SELECT 
      at.id,
      at.winner,
      at.variant_a_id,
      at.variant_b_id,
      at.status,
      sv_a.content AS content_a,
      sv_a.source AS source_a,
      sv_a.variant_source AS variant_source_a,
      sv_b.content AS content_b,
      sv_b.source AS source_b,
      sv_b.variant_source AS variant_source_b
    FROM ab_tests at
    LEFT JOIN script_variants sv_a ON at.variant_a_id = sv_a.id
    LEFT JOIN script_variants sv_b ON at.variant_b_id = sv_b.id
    WHERE at.id = ?
  `).get(testId) as any;

  if (!test || test.status !== 'completed' || !test.winner || test.winner === 'tie') {
    return null;
  }

  // Determine which variant won
  const isWinnerA = test.winner === 'variant_a';
  const winnerVariantId = isWinnerA ? test.variant_a_id : test.variant_b_id;
  const winnerVariantSlot = isWinnerA ? 'variant_a' : 'variant_b';
  const winnerContent = isWinnerA ? test.content_a : test.content_b;
  const winnerSource = isWinnerA ? getVariantSource(test, 'a') : getVariantSource(test, 'b');

  // Get conversion rates from outcomes
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'converted' THEN 1 ELSE 0 END) as conversions
    FROM ab_test_outcomes
    WHERE COALESCE(test_id, ab_test_id) = ?
      AND (assigned_variant = ? OR assigned_variant = ?)
  `).get(testId, winnerVariantId, winnerVariantSlot) as any;

  const conversionRate = stats.total > 0 ? stats.conversions / stats.total : 0;

  // Get effect size from ab_tests p_value
  const testResult = db.prepare(`
    SELECT p_value FROM ab_tests WHERE id = ?
  `).get(testId) as any;

  return {
    scriptId: testId,
    variantId: winnerVariantId,
    source: winnerSource === 'ai_generated' ? 'ai_generated' : 'template',
    conversionRate,
    sampleSize: stats.total,
    styleClassification: classifyScriptStyle(winnerContent),
    keyPhrases: extractKeyPhrases(winnerContent),
    tokenCount: Math.ceil(winnerContent.split(/\s+/).length * 1.3), // Rough estimate
    efficacyScore: conversionRate,
    effectSize: testResult?.p_value ? 1 - testResult.p_value : 0,
  };
}

/**
 * Compare AI-generated vs template efficacy across all completed tests
 */
export function compareEfficacy(db: Database): ComparisonResult {
  return compareEfficacyForTenant(db);
}

export function compareEfficacyForTenant(db: Database, tenantId?: string): ComparisonResult {
  // Get all completed tests with results
  const completedTests = db.prepare(`
    SELECT 
      at.id,
      at.winner,
      at.variant_a_id,
      at.variant_b_id,
      at.tenant_id,
      sv_a.source AS source_a,
      sv_a.variant_source AS variant_source_a,
      sv_b.source AS source_b,
      sv_b.variant_source AS variant_source_b
    FROM ab_tests at
    LEFT JOIN script_variants sv_a ON at.variant_a_id = sv_a.id
    LEFT JOIN script_variants sv_b ON at.variant_b_id = sv_b.id
    WHERE at.status = 'completed'
      AND at.winner IS NOT NULL
      AND (? IS NULL OR at.tenant_id = ?)
  `).all(tenantId ?? null, tenantId ?? null) as any[];

  if (completedTests.length === 0) {
    return {
      aiAverageConversionRate: 0,
      templateAverageConversionRate: 0,
      aiWinPercentage: 0,
      templateWinPercentage: 0,
      dominantStyle: 'unknown',
      recommendedSourceForNextRound: 'hybrid',
      winnerCharacteristics: [],
      statsSummary: {
        totalTestsAnalyzed: 0,
        testsWithSignificance: 0,
        testsWithTie: 0,
      },
    };
  }

  const winnerCharacteristics: WinnerCharacteristics[] = [];
  let aiWins = 0;
  let templateWins = 0;
  let aiTotalConversion = 0;
  let templateTotalConversion = 0;
  let aiSamples = 0;
  let templateSamples = 0;

  for (const test of completedTests) {
    if (test.winner === 'tie') continue;
    
    const characteristics = detectWinnerCharacteristics(db, test.id, test.tenant_id);
    
    if (characteristics) {
      winnerCharacteristics.push(characteristics);
      
      if (characteristics.source === 'ai_generated') {
        aiWins++;
        aiTotalConversion += characteristics.conversionRate * characteristics.sampleSize;
        aiSamples += characteristics.sampleSize;
      } else {
        templateWins++;
        templateTotalConversion += characteristics.conversionRate * characteristics.sampleSize;
        templateSamples += characteristics.sampleSize;
      }
    }
  }

  const totalWins = aiWins + templateWins;
  const aiAverageConversion = aiSamples > 0 ? aiTotalConversion / aiSamples : 0;
  const templateAverageConversion = templateSamples > 0 ? templateTotalConversion / templateSamples : 0;

  // Classify dominant style
  const styleFreq = new Map<string, number>();
  for (const char of winnerCharacteristics) {
    styleFreq.set(char.styleClassification, (styleFreq.get(char.styleClassification) || 0) + 1);
  }
  
  const dominantStyle = Array.from(styleFreq.entries())
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

  // Recommendation logic
  let recommendedSource: 'ai_generated' | 'template' | 'hybrid';
  if (aiAverageConversion > templateAverageConversion * 1.05) {
    recommendedSource = 'ai_generated';
  } else if (templateAverageConversion > aiAverageConversion * 1.05) {
    recommendedSource = 'template';
  } else {
    recommendedSource = 'hybrid';
  }

  return {
    aiAverageConversionRate: aiAverageConversion,
    templateAverageConversionRate: templateAverageConversion,
    aiWinPercentage: totalWins > 0 ? (aiWins / totalWins) * 100 : 0,
    templateWinPercentage: totalWins > 0 ? (templateWins / totalWins) * 100 : 0,
    dominantStyle,
    recommendedSourceForNextRound: recommendedSource,
    winnerCharacteristics,
    statsSummary: {
      totalTestsAnalyzed: completedTests.length,
      testsWithSignificance: totalWins,
      testsWithTie: completedTests.length - totalWins,
    },
  };
}

/**
 * Get efficacy insights for a specific source (AI or template)
 */
export function getSourceEfficacyInsights(
  db: Database,
  source: 'ai_generated' | 'template',
  tenantId?: string
): {
  averageConversionRate: number;
  topStyles: Array<{ style: string; count: number }>;
  commonPhrases: string[];
  recommendedStyle: string;
} {
  const completedTests = db.prepare(`
    SELECT 
      at.id,
      at.winner,
      at.variant_a_id,
      at.variant_b_id,
      at.tenant_id,
      sv_a.source AS source_a,
      sv_a.variant_source AS variant_source_a,
      sv_b.source AS source_b,
      sv_b.variant_source AS variant_source_b
    FROM ab_tests at
    LEFT JOIN script_variants sv_a ON at.variant_a_id = sv_a.id
    LEFT JOIN script_variants sv_b ON at.variant_b_id = sv_b.id
    WHERE at.status = 'completed'
      AND at.winner IS NOT NULL
      AND (? IS NULL OR at.tenant_id = ?)
  `).all(tenantId ?? null, tenantId ?? null) as any[];

  const sourceWinners = [];
  for (const test of completedTests) {
    if (test.winner === 'tie') continue;
    
    const isWinnerA = test.winner === 'variant_a';
    const winnerSource = isWinnerA ? getVariantSource(test, 'a') : getVariantSource(test, 'b');
    
    if (winnerSource === source) {
      const characteristics = detectWinnerCharacteristics(db, test.id, test.tenant_id);
      if (characteristics) {
        sourceWinners.push(characteristics);
      }
    }
  }

  if (sourceWinners.length === 0) {
    return {
      averageConversionRate: 0,
      topStyles: [],
      commonPhrases: [],
      recommendedStyle: 'neutral',
    };
  }

  const avgConversion = sourceWinners.reduce((sum, c) => sum + c.conversionRate, 0) / sourceWinners.length;
  
  // Get top styles
  const styleFreq = new Map<string, number>();
  const phraseFreq = new Map<string, number>();
  
  for (const char of sourceWinners) {
    styleFreq.set(char.styleClassification, (styleFreq.get(char.styleClassification) || 0) + 1);
    for (const phrase of char.keyPhrases) {
      phraseFreq.set(phrase, (phraseFreq.get(phrase) || 0) + 1);
    }
  }

  const topStyles = Array.from(styleFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([style, count]) => ({ style, count }));

  const commonPhrases = Array.from(phraseFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([phrase]) => phrase);

  const recommendedStyle = topStyles[0]?.style || 'neutral';

  return {
    averageConversionRate: avgConversion,
    topStyles,
    commonPhrases,
    recommendedStyle,
  };
}
