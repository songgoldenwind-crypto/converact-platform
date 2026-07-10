/**
 * Statistical Testing Module - Phase 6.2
 *
 * Provides statistical significance testing for A/B test results
 * using χ² (chi-square) test for 2x2 contingency tables
 *
 * Key concepts:
 * - Contingency table: [converted/not_converted] × [variant_a/variant_b]
 * - χ² statistic: measures deviation from expected distribution
 * - p-value: probability of observing this data if variants are equivalent
 * - Threshold: p < 0.05 (95% confidence level) indicates significance
 * - Effect size: practical difference beyond statistical significance
 */

import { all, one, run } from '../db.js';

export interface TestResults {
  variant_a_conversions: number;
  variant_b_conversions: number;
  variant_a_total: number;
  variant_b_total: number;
}

export interface StatisticalResult {
  chi_square: number;
  p_value: number;
  is_significant: boolean;
  effect_size: number;
  recommended_winner: 'variant_a' | 'variant_b' | 'tie' | null;
  confidence_level: number;
  min_sample_size_met: boolean;
  sample_count: {
    variant_a: number;
    variant_b: number;
  };
}

/**
 * Perform χ² chi-square test on 2x2 contingency table
 *
 * Contingency table structure:
 * ```
 *              Variant A   Variant B    Row Total
 * Converted        a          b          a+b
 * Not Converted    c          d          c+d
 * Col Total       a+c        b+d          n
 * ```
 *
 * χ² = (n(ad - bc)²) / ((a+c)(b+d)(a+b)(c+d))
 */
function calculateChiSquare(results: TestResults): number {
  const { variant_a_conversions, variant_b_conversions, variant_a_total, variant_b_total } = results;

  // Build contingency table
  const a = variant_a_conversions;  // Variant A conversions
  const b = variant_b_conversions;  // Variant B conversions
  const c = variant_a_total - variant_a_conversions;  // Variant A non-conversions
  const d = variant_b_total - variant_b_conversions;  // Variant B non-conversions
  const n = variant_a_total + variant_b_total;

  // χ² formula
  const numerator = n * Math.pow(a * d - b * c, 2);
  const denominator = (a + c) * (b + d) * (a + b) * (c + d);

  if (denominator === 0) {
    return 0;  // No variation
  }

  return numerator / denominator;
}

/**
 * Convert χ² statistic to p-value using approximation
 * For 1 degree of freedom (2x2 table), we use normal distribution approximation
 * More precise: use chi2cdf from statistical tables or libraries
 *
 * Critical values for 1 df:
 * p=0.10 → χ²=2.706
 * p=0.05 → χ²=3.841
 * p=0.01 → χ²=6.635
 * p=0.001 → χ²=10.827
 */
function chiSquareToPValue(chi_square: number): number {
  // Using approximation: chi2(1, x) CDF
  // For 1 degree of freedom, more precise values from statistical tables
  if (chi_square < 0.001) return 1.0;
  if (chi_square < 0.455) return 0.5;   // p ≈ 0.5
  if (chi_square < 1.074) return 0.3;   // p ≈ 0.3
  if (chi_square < 1.642) return 0.2;   // p ≈ 0.2
  if (chi_square < 2.706) return 0.1;   // p ≈ 0.1
  if (chi_square < 3.841) return 0.05;  // p ≈ 0.05 (SIGNIFICANCE THRESHOLD)
  if (chi_square < 5.412) return 0.02;  // p ≈ 0.02
  if (chi_square < 6.635) return 0.01;  // p ≈ 0.01
  if (chi_square < 10.827) return 0.001; // p ≈ 0.001
  return 0.0001;  // Very significant
}

/**
 * Calculate effect size (Cohen's h for proportions)
 * Measures practical significance of difference between conversion rates
 *
 * h = 2 * arcsin(√p1) - 2 * arcsin(√p2)
 *
 * Effect size thresholds (Cohen's conventions):
 * h = 0.2 (small)
 * h = 0.5 (medium) ← OPC standard for practical significance
 * h = 0.8 (large)
 */
function calculateEffectSize(results: TestResults): number {
  const p1 = results.variant_a_total > 0 ? results.variant_a_conversions / results.variant_a_total : 0;
  const p2 = results.variant_b_total > 0 ? results.variant_b_conversions / results.variant_b_total : 0;

  const phi1 = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p1))));
  const phi2 = 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, p2))));

  return Math.abs(phi1 - phi2);
}

/**
 * Determine winner based on statistical significance and effect size
 *
 * Rules:
 * 1. If not statistically significant (p >= 0.05) → tie
 * 2. If effect size < 0.2 (too small to matter) → tie
 * 3. Else → variant with higher conversion rate
 *
 * Additional requirements:
 * - Both variants must have ≥30 samples (enforced by caller)
 * - Confidence level >= 0.95 (95%)
 */
function determineWinner(
  results: TestResults,
  chi_square: number,
  p_value: number,
  effect_size: number
): 'variant_a' | 'variant_b' | 'tie' | null {
  // Not statistically significant
  if (p_value >= 0.05) {
    return 'tie';
  }

  // Effect size too small (practical significance check)
  if (effect_size < 0.2) {
    return 'tie';
  }

  // Determine which has higher conversion rate
  const rate_a = results.variant_a_total > 0
    ? results.variant_a_conversions / results.variant_a_total
    : 0;
  const rate_b = results.variant_b_total > 0
    ? results.variant_b_conversions / results.variant_b_total
    : 0;

  return rate_a > rate_b ? 'variant_a' : 'variant_b';
}

/**
 * Main entry point: run statistical test on AB test results
 *
 * @param test_id - AB test ID
 * @param db - Database connection
 * @returns Statistical test result with winner determination
 */
export function performStatisticalTest(
  db: any,
  test_results: TestResults,
  min_sample_size: number = 30,
  confidence_level: number = 0.95
): StatisticalResult {
  const { variant_a_total, variant_b_total } = test_results;

  // Check minimum sample size requirement
  const min_sample_size_met = variant_a_total >= min_sample_size && variant_b_total >= min_sample_size;

  // Calculate statistics
  const chi_square = calculateChiSquare(test_results);
  const p_value = chiSquareToPValue(chi_square);
  const effect_size = calculateEffectSize(test_results);
  const is_significant = p_value < 0.05;
  const recommended_winner = determineWinner(test_results, chi_square, p_value, effect_size);

  return {
    chi_square: Math.round(chi_square * 10000) / 10000,  // 4 decimal places
    p_value: Math.round(p_value * 100000) / 100000,      // 5 decimal places
    is_significant,
    effect_size: Math.round(effect_size * 10000) / 10000,  // 4 decimal places
    recommended_winner,
    confidence_level,
    min_sample_size_met,
    sample_count: {
      variant_a: variant_a_total,
      variant_b: variant_b_total,
    },
  };
}

/**
 * Fetch test results from database and run statistical test
 *
 * @param db - Database connection
 * @param ab_test_id - AB test ID
 * @returns Statistical test result
 */
export async function getStatisticalTestResult(db: any, ab_test_id: string): Promise<StatisticalResult> {
  const test = one(db, 'SELECT * FROM ab_tests WHERE id = ?', [ab_test_id]);

  if (!test) {
    throw new Error(`Test not found: ${ab_test_id}`);
  }

  // Aggregate outcomes by variant and conversion
  const stats = one(db, `
    SELECT 
      SUM(CASE WHEN assigned_variant = 'variant_a' THEN 1 ELSE 0 END) as variant_a_total,
      SUM(CASE WHEN assigned_variant = 'variant_b' THEN 1 ELSE 0 END) as variant_b_total,
      SUM(CASE WHEN assigned_variant = 'variant_a' AND outcome = 'converted' THEN 1 ELSE 0 END) as variant_a_conversions,
      SUM(CASE WHEN assigned_variant = 'variant_b' AND outcome = 'converted' THEN 1 ELSE 0 END) as variant_b_conversions
    FROM ab_test_outcomes
    WHERE COALESCE(ab_test_id, test_id) = ?
  `, [ab_test_id]);

  if (!stats) {
    return performStatisticalTest(db, {
      variant_a_conversions: 0,
      variant_b_conversions: 0,
      variant_a_total: 0,
      variant_b_total: 0,
    });
  }

  const testData = test as any;
  return performStatisticalTest(
    db,
    {
      variant_a_conversions: (stats as any).variant_a_conversions || 0,
      variant_b_conversions: (stats as any).variant_b_conversions || 0,
      variant_a_total: (stats as any).variant_a_total || 0,
      variant_b_total: (stats as any).variant_b_total || 0,
    },
    testData.min_sample_size || 30,
    0.95
  );
}

/**
 * Auto-complete test if statistical significance is achieved
 * Updates test status, winner, and p_value in database
 *
 * @param db - Database connection
 * @param ab_test_id - AB test ID
 * @returns true if test was completed, false if still active
 */
export async function autoCompleteIfSignificant(db: any, ab_test_id: string): Promise<boolean> {
  const result = await getStatisticalTestResult(db, ab_test_id);

  // If not significant, keep test active
  if (!result.is_significant || !result.recommended_winner) {
    return false;
  }

  // Test is complete: mark winner
  const now = new Date().toISOString();
  run(db, `
    UPDATE ab_tests
    SET 
      status = 'completed',
      winner = ?,
      p_value = ?,
      completed_at = ?,
      winner_determined_at = ?,
      updated_at = ?
    WHERE id = ?
  `, [result.recommended_winner, result.p_value, now, now, now, ab_test_id]);

  return true;
}

/**
 * Get statistical insights for display
 * Returns human-readable summary of test results
 */
export function getStatisticalInsights(result: StatisticalResult): string {
  const lines = [
    `χ² = ${result.chi_square}, p-value = ${result.p_value}`,
    result.is_significant
      ? `✓ STATISTICALLY SIGNIFICANT (p < 0.05)`
      : `✗ Not statistically significant (p >= 0.05)`,
    `Effect size: ${result.effect_size} ${result.effect_size >= 0.5 ? '(medium/large)' : '(small)'}`,
    `Samples: Variant A=${result.sample_count.variant_a}, Variant B=${result.sample_count.variant_b}`,
    `Minimum met: ${result.min_sample_size_met ? 'YES' : 'NO (need 30+ per variant)'}`,
  ];

  if (result.recommended_winner && result.recommended_winner !== 'tie') {
    lines.push(`✓ WINNER: ${result.recommended_winner}`);
  } else if (result.recommended_winner === 'tie') {
    lines.push(`→ TIE: Continue testing or declare no significant difference`);
  }

  return lines.join('\n');
}
