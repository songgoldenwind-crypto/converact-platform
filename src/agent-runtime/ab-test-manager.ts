/**
 * Phase 6: A/B Testing Framework - Core Manager
 * 
 * Manages A/B test lifecycle:
 * 1. Test creation (variant_a vs variant_b)
 * 2. 50/50 automatic assignment to users
 * 3. Outcome recording (converted/no_answer/rejected)
 * 4. Statistical analysis preparation
 */

import { all, one, run } from '../db.js';
import * as crypto from 'crypto';

export interface ABTestConfig {
  id: string;
  tenant_id: string;
  test_name?: string;
  variant_a_id: string;
  variant_b_id: string;
  status: 'active' | 'completed' | 'failed' | 'paused';
  min_sample_size: number;
  confidence_level: number;
  created_at: string;
  completed_at?: string;
  p_value?: number;
  winner?: 'variant_a' | 'variant_b' | 'tie';
}

export interface ScriptVariant {
  id: string;
  tenant_id: string;
  content: string;
  variant_source: 'ai_generated' | 'template' | 'user_custom';
  source?: 'ai_generated' | 'template' | 'user_custom';
  prompt_version: string;
  style_classification?: string;
  avg_conversion_rate?: number;
  efficacy_conversion_rate?: number;
  sample_count: number;
  created_at: string;
  deprecated_at?: string;
}

export interface ABTestOutcome {
  id: string;
  ab_test_id: string;
  run_id: string;
  assigned_variant: string;
  outcome: 'connected' | 'converted' | 'no_answer' | 'rejected' | 'not_converted';
  created_at: string;
}

export interface ABTestStats {
  test_id: string;
  variant_a: {
    name: string;
    sample_count: number;
    conversions: number;
    conversion_rate: number;
  };
  variant_b: {
    name: string;
    sample_count: number;
    conversions: number;
    conversion_rate: number;
  };
  total_samples: number;
  status: string;
  ready_for_analysis: boolean;
}

export class ABTestManager {
  constructor(private db: any) {}

  /**
   * Create a new A/B test
   */
  async createABTest(
    tenant_id: string,
    variant_a_id: string,
    variant_b_id: string,
    test_name?: string
  ): Promise<ABTestConfig> {
    const test_id = `ab-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    // Verify both variants belong to this tenant
    const variantA = all(this.db,
      'SELECT * FROM script_variants WHERE id = ? AND tenant_id = ?',
      [variant_a_id, tenant_id]
    );
    const variantB = all(this.db,
      'SELECT * FROM script_variants WHERE id = ? AND tenant_id = ?',
      [variant_b_id, tenant_id]
    );

    if (!variantA.length || !variantB.length) {
      throw new Error(
        `Invalid variants: A=${variantA.length > 0} B=${variantB.length > 0}`
      );
    }

    run(this.db, `
      INSERT INTO ab_tests (
        id, tenant_id, test_name, variant_a_id, variant_b_id,
        status, min_sample_size, confidence_level, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      test_id,
      tenant_id,
      test_name || `Test ${test_id.slice(0, 8)}`,
      variant_a_id,
      variant_b_id,
      'active',
      30,
      0.95,
      now
    ]);

    return {
      id: test_id,
      tenant_id,
      test_name: test_name || `Test ${test_id.slice(0, 8)}`,
      variant_a_id,
      variant_b_id,
      status: 'active',
      min_sample_size: 30,
      confidence_level: 0.95,
      created_at: now,
    };
  }

  /**
   * Assign a variant to a user (50/50 Bernoulli)
   */
  assignVariant(test_id: string): 'variant_a' | 'variant_b' {
    // Bernoulli random assignment
    return Math.random() < 0.5 ? 'variant_a' : 'variant_b';
  }

  /**
   * Record the outcome for a test result
   */
  async recordOutcome(
    ab_test_id: string,
    run_id: string,
    assigned_variant: 'variant_a' | 'variant_b',
    outcome: 'connected' | 'converted' | 'no_answer' | 'rejected'
  ): Promise<ABTestOutcome> {
    const outcome_id = `outcome-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    run(this.db, `
      INSERT INTO ab_test_outcomes (
        id, ab_test_id, test_id, run_id, assigned_variant, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [outcome_id, ab_test_id, ab_test_id, run_id, assigned_variant, outcome, now]);

    return {
      id: outcome_id,
      ab_test_id,
      run_id,
      assigned_variant,
      outcome,
      created_at: now,
    };
  }

  /**
   * Get current stats for a test
   */
  async getTestStats(test_id: string): Promise<ABTestStats> {
    const test = one(this.db,
      'SELECT * FROM ab_tests WHERE id = ?',
      [test_id]
    );

    if (!test) {
      throw new Error(`Test not found: ${test_id}`);
    }

    const testData = test as ABTestConfig;

    // Count outcomes by variant and success
    const outcomes = all(this.db, `
      SELECT 
        assigned_variant,
        outcome,
        COUNT(*) as count
      FROM ab_test_outcomes
      WHERE COALESCE(ab_test_id, test_id) = ?
      GROUP BY assigned_variant, outcome
    `, [test_id]);

    // Build stats
    const variantAStats = {
      name: `Variant A (${testData.variant_a_id.slice(0, 8)})`,
      sample_count: 0,
      conversions: 0,
      conversion_rate: 0,
    };

    const variantBStats = {
      name: `Variant B (${testData.variant_b_id.slice(0, 8)})`,
      sample_count: 0,
      conversions: 0,
      conversion_rate: 0,
    };

    for (const row of outcomes) {
      const stats =
        row.assigned_variant === 'variant_a' ? variantAStats : variantBStats;
      stats.sample_count += row.count;
      if (row.outcome === 'converted') {
        stats.conversions += row.count;
      }
    }

    // Calculate conversion rates
    if (variantAStats.sample_count > 0) {
      variantAStats.conversion_rate =
        variantAStats.conversions / variantAStats.sample_count;
    }
    if (variantBStats.sample_count > 0) {
      variantBStats.conversion_rate =
        variantBStats.conversions / variantBStats.sample_count;
    }

    const total_samples = variantAStats.sample_count + variantBStats.sample_count;
    const ready_for_analysis =
      total_samples >= testData.min_sample_size &&
      variantAStats.sample_count >= testData.min_sample_size &&
      variantBStats.sample_count >= testData.min_sample_size;

    return {
      test_id,
      variant_a: variantAStats,
      variant_b: variantBStats,
      total_samples,
      status: testData.status,
      ready_for_analysis,
    };
  }

  /**
   * Find active A/B test for a tenant
   */
  async findActiveTest(tenant_id: string): Promise<ABTestConfig | null> {
    const result = one(this.db, `
      SELECT * FROM ab_tests
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `, [tenant_id]);

    return result ? (result as ABTestConfig) : null;
  }

  /**
   * Create a script variant
   */
  async createVariant(
    tenant_id: string,
    content: string,
    variant_source: 'ai_generated' | 'template' | 'user_custom',
    prompt_version: string = 'v1',
    style_classification?: string
  ): Promise<ScriptVariant> {
    const variant_id = `variant-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    run(this.db, `
      INSERT INTO script_variants (
        id, tenant_id, content, variant_source, source, prompt_version,
        style_classification, created_at, sample_count, avg_conversion_rate, efficacy_conversion_rate
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      variant_id,
      tenant_id,
      content,
      variant_source,
      variant_source,
      prompt_version,
      style_classification || 'standard',
      now,
      0,
      0,
      0
    ]);

    return {
      id: variant_id,
      tenant_id,
      content,
      variant_source,
      source: variant_source,
      prompt_version,
      style_classification: style_classification || 'standard',
      avg_conversion_rate: 0,
      efficacy_conversion_rate: 0,
      sample_count: 0,
      created_at: now,
    };
  }

  /**
   * Get or create script variants from existing scripts
   */
  async ensureVariantsExist(
    tenant_id: string,
    script_content_a: string,
    script_content_b: string
  ): Promise<{ variant_a: ScriptVariant; variant_b: ScriptVariant }> {
    // Check if variants already exist for this tenant
    const existing = all(this.db, `
      SELECT id, content FROM script_variants 
      WHERE tenant_id = ? AND COALESCE(source, variant_source) = 'ai_generated'
      ORDER BY created_at DESC
      LIMIT 2
    `, [tenant_id]);

    if (existing.length >= 2) {
      // Use existing variants
      const variant_a = one(this.db,
        'SELECT * FROM script_variants WHERE id = ?',
        [(existing[0] as any).id]
      );
      const variant_b = one(this.db,
        'SELECT * FROM script_variants WHERE id = ?',
        [(existing[1] as any).id]
      );
      return {
        variant_a: variant_a as ScriptVariant,
        variant_b: variant_b as ScriptVariant,
      };
    }

    // Create new variants
    const variant_a = await this.createVariant(
      tenant_id,
      script_content_a,
      'ai_generated',
      'v1'
    );
    const variant_b = await this.createVariant(
      tenant_id,
      script_content_b,
      'ai_generated',
      'v1'
    );

    return { variant_a, variant_b };
  }

  /**
   * Update variant conversion rate based on outcomes
   */
  async updateVariantStats(variant_id: string): Promise<void> {
    // Find which variant slot this ID occupies (variant_a or variant_b) in tests
    const tests = all(this.db, `
      SELECT id, variant_a_id, variant_b_id FROM ab_tests
      WHERE variant_a_id = ? OR variant_b_id = ?
    `, [variant_id, variant_id]);

    let total = 0;
    let conversions = 0;

    for (const test of tests) {
      // Determine if this variant_id is variant_a or variant_b in this test
      const assigned_variant = (test as any).variant_a_id === variant_id ? 'variant_a' : 'variant_b';
      
      // Get outcomes for this variant in this test
      const outcomes = all(this.db, `
        SELECT outcome, COUNT(*) as count
        FROM ab_test_outcomes
        WHERE COALESCE(ab_test_id, test_id) = ?
          AND (assigned_variant = ? OR assigned_variant = ?)
        GROUP BY outcome
      `, [(test as any).id, assigned_variant, variant_id]);

      for (const row of outcomes) {
        const count = row.count;
        total += count;
        if (row.outcome === 'converted') {
          conversions += count;
        }
      }
    }

    if (total > 0) {
      const conversion_rate = conversions / total;
      run(this.db, `
        UPDATE script_variants
        SET avg_conversion_rate = ?, efficacy_conversion_rate = ?, sample_count = ?
        WHERE id = ?
      `, [conversion_rate, conversion_rate, total, variant_id]);
    }
  }

  /**
   * Mark a test as completed
   */
  async completeTest(
    test_id: string,
    winner: 'variant_a' | 'variant_b' | 'tie',
    p_value: number
  ): Promise<void> {
    const now = new Date().toISOString();
    run(this.db, `
      UPDATE ab_tests
      SET status = 'completed', winner = ?, p_value = ?, completed_at = ?
      WHERE id = ?
    `, [winner, p_value, now, test_id]);
  }
}

// Global manager instance
let manager: ABTestManager | null = null;

export function getABTestManager(db?: any): ABTestManager {
  if (!manager && db) {
    manager = new ABTestManager(db);
  }
  if (!manager) {
    throw new Error('ABTestManager not initialized');
  }
  return manager;
}

export function initializeABTestManager(db: any): void {
  manager = new ABTestManager(db);
}
