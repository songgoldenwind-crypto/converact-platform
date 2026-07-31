/**
 * A/B Testing Framework for Script Generation
 * Compares Deepseek AI-generated scripts vs industry template scripts
 * Automatically tracks outcomes and promotes winning variant
 * 
 * Strategy:
 * - 70% of runs use AI-generated scripts
 * - 30% of runs use template scripts
 * - Track conversion rates separately
 * - Automatically promote better performer to default after sufficient sample
 */

import type { JsonRecord } from './integrations/provider-runtime-types.js';
import crypto from 'crypto';

export interface ABTestAssignment {
  test_id: string;
  run_id: string;
  tenant_id: string;
  variant: 'ai_generated' | 'template';
  assigned_at: string;
  script_content: string;
  deterministic_seed: string;
}

export interface ABTestResult {
  test_id: string;
  run_id: string;
  assignment_variant: 'ai_generated' | 'template';
  call_count: number;
  conversions: number;
  conversion_rate: number;
  recorded_at: string;
}

export interface ABTestStats {
  ai_vs_template: {
    ai_generated: {
      total_scripts: number;
      total_calls: number;
      conversions: number;
      conversion_rate: number;
      statistical_confidence: string;
    };
    template: {
      total_scripts: number;
      total_calls: number;
      conversions: number;
      conversion_rate: number;
      statistical_confidence: string;
    };
    winner: 'ai_generated' | 'template' | 'tied' | 'insufficient';
    confidence_level: number;
  };
}

/**
 * Deterministically assign variant based on run_id
 * Ensures reproducibility: same run_id always gets same variant across calls
 * 70/30 split: 70% AI, 30% template
 */
export function assignABVariant(
  run_id: string,
  tenant_id: string
): 'ai_generated' | 'template' {
  // Create deterministic seed from run_id
  const seed = crypto
    .createHash('md5')
    .update(`${tenant_id}:${run_id}`)
    .digest('hex');

  // Use first byte of hash to determine variant
  const seedValue = parseInt(seed.substring(0, 2), 16) % 100;

  // 70% AI, 30% template
  return seedValue < 70 ? 'ai_generated' : 'template';
}

/**
 * Record A/B test result from a completed call/task
 * Increment conversion counter if this lead/task resulted in positive outcome
 */
export function recordABResult(
  db: any,
  run_id: string,
  variant: 'ai_generated' | 'template',
  didConvert: boolean
): boolean {
  try {
    // Find or create test record
    const existingQuery = `
      SELECT id FROM ab_test_results 
      WHERE run_id = ? AND assignment_variant = ?
      LIMIT 1
    `;
    const existing = (db as any).prepare(existingQuery).get(run_id, variant);

    if (existing) {
      // Update existing result
      const updateQuery = `
        UPDATE ab_test_results
        SET 
          call_count = call_count + 1,
          conversions = conversions + ?,
          conversion_rate = (conversions + ?) / (call_count + 1),
          recorded_at = datetime('now')
        WHERE run_id = ? AND assignment_variant = ?
      `;
      const convertValue = didConvert ? 1 : 0;
      (db as any).prepare(updateQuery).run(convertValue, convertValue, run_id, variant);
    } else {
      // Create new result
      const insertQuery = `
        INSERT INTO ab_test_results 
        (test_id, run_id, assignment_variant, call_count, conversions, conversion_rate, recorded_at)
        VALUES (?, ?, ?, 1, ?, ?, datetime('now'))
      `;
      const testId = `abt_${crypto.randomUUID()}`;
      const convertValue = didConvert ? 1 : 0;
      (db as any)
        .prepare(insertQuery)
        .run(testId, run_id, variant, convertValue, didConvert ? 1 : 0);
    }

    return true;
  } catch (e) {
    console.debug('AB test result recording failed:', (e as Error).message);
    return false;
  }
}

/**
 * Get comprehensive A/B test statistics
 * Determines if one variant is statistically significantly better
 */
export function getABTestStats(db: any): ABTestStats {
  try {
    const statsQuery = `
      SELECT 
        assignment_variant,
        COUNT(*) as total_records,
        SUM(call_count) as total_calls,
        SUM(conversions) as total_conversions,
        AVG(conversion_rate) as avg_rate
      FROM ab_test_results
      WHERE recorded_at > datetime('now', '-30 days')
      GROUP BY assignment_variant
    `;

    const results = (db as any).prepare(statsQuery).all() as Array<{
      assignment_variant: string;
      total_records: number;
      total_calls: number;
      total_conversions: number;
      avg_rate: number;
    }>;

    const aiStats = results.find((r) => r.assignment_variant === 'ai_generated') || {
      total_records: 0,
      total_calls: 0,
      total_conversions: 0,
      avg_rate: 0
    };

    const templateStats = results.find((r) => r.assignment_variant === 'template') || {
      total_records: 0,
      total_calls: 0,
      total_conversions: 0,
      avg_rate: 0
    };

    // Determine statistical confidence (need ≥30 samples per variant for >80% confidence)
    const aiConfidence = aiStats.total_calls >= 30 ? 'high' : aiStats.total_calls >= 10 ? 'medium' : 'low';
    const templateConfidence =
      templateStats.total_calls >= 30 ? 'high' : templateStats.total_calls >= 10 ? 'medium' : 'low';

    // Determine winner
    let winner: 'ai_generated' | 'template' | 'tied' | 'insufficient' = 'insufficient';
    let confidenceLevel = 0;

    if (aiStats.total_calls >= 30 && templateStats.total_calls >= 30) {
      // Both have sufficient sample
      const aiRate = aiStats.total_conversions / aiStats.total_calls;
      const templateRate = templateStats.total_conversions / templateStats.total_calls;
      const diff = Math.abs(aiRate - templateRate);

      if (diff > 0.15) {
        // >15 percentage point difference = significant
        winner = aiRate > templateRate ? 'ai_generated' : 'template';
        confidenceLevel = 0.95;
      } else if (diff > 0.08) {
        // 8-15 pp difference = moderate
        winner = aiRate > templateRate ? 'ai_generated' : 'template';
        confidenceLevel = 0.80;
      } else {
        // <8 pp difference = tied
        winner = 'tied';
        confidenceLevel = 0.5;
      }
    } else if (aiStats.total_calls >= 30 || templateStats.total_calls >= 30) {
      // Only one has sufficient sample
      winner = 'insufficient';
      confidenceLevel = 0.5;
    }

    return {
      ai_vs_template: {
        ai_generated: {
          total_scripts: aiStats.total_records || 0,
          total_calls: aiStats.total_calls || 0,
          conversions: aiStats.total_conversions || 0,
          conversion_rate: aiStats.total_calls ? aiStats.total_conversions / aiStats.total_calls : 0,
          statistical_confidence: aiConfidence
        },
        template: {
          total_scripts: templateStats.total_records || 0,
          total_calls: templateStats.total_calls || 0,
          conversions: templateStats.total_conversions || 0,
          conversion_rate: templateStats.total_calls ? templateStats.total_conversions / templateStats.total_calls : 0,
          statistical_confidence: templateConfidence
        },
        winner,
        confidence_level: confidenceLevel
      }
    };
  } catch (e) {
    console.debug('AB test stats retrieval failed:', (e as Error).message);
    return {
      ai_vs_template: {
        ai_generated: { total_scripts: 0, total_calls: 0, conversions: 0, conversion_rate: 0, statistical_confidence: 'low' },
        template: { total_scripts: 0, total_calls: 0, conversions: 0, conversion_rate: 0, statistical_confidence: 'low' },
        winner: 'insufficient',
        confidence_level: 0
      }
    };
  }
}

/**
 * Determine if we should use AI or template based on current test stats
 * If a clear winner emerges, bias toward it
 * Otherwise maintain 70/30 split
 */
export function shouldUseAIGeneratedScript(db: any, run_id: string, tenant_id: string): boolean {
  // Start with deterministic assignment
  let variant = assignABVariant(run_id, tenant_id);

  // Check if test has shown a clear winner
  const stats = getABTestStats(db);
  if (stats.ai_vs_template.confidence_level >= 0.8) {
    // Winner is clear with high confidence
    if (stats.ai_vs_template.winner === 'ai_generated') {
      // AI is winning, increase bias to 90% AI
      return Math.random() < 0.9;
    } else if (stats.ai_vs_template.winner === 'template') {
      // Template is winning, increase bias to 90% template
      return Math.random() < 0.1;
    }
    // If tied, keep 70/30
  }

  // Return original assignment
  return variant === 'ai_generated';
}
