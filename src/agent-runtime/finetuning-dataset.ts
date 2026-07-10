/**
 * Fine-tuning Dataset Preparation for Deepseek
 * Collects verified best-performing scripts paired with outcomes
 * Goal: Build 500+ high-quality training examples for model fine-tuning
 * 
 * Selection criteria:
 * - Scripts with 100% conversion rate over 5+ calls
 * - OR scripts with >80% conversion rate over 10+ calls
 * - Paired with exact lead profile, industry, disposition
 * - Includes failed examples (for learning what NOT to do)
 */

import crypto from 'crypto';
import type { JsonRecord } from './integrations/provider-runtime-types.js';

export interface FineTuningExample {
  id: string;
  script_variant_id: string;
  script_content: string;
  lead_profile: {
    industry: string;
    location: string;
    company_size?: string;
    target_profile?: string;
  };
  call_outcomes: {
    total_calls: number;
    conversions: number;
    conversion_rate: number;
    disposition_distribution: Record<string, number>;
  };
  quality_signal: 'excellent' | 'good' | 'fair' | 'poor';
  timestamp: string;
  route_type?: string;
}

export interface FineTuningDataset {
  total_examples: number;
  excellent: number;
  good: number;
  fair: number;
  poor: number;
  avg_conversion_rate: number;
  industries_covered: string[];
  ready_for_training: boolean;
}

/**
 * Determine quality signal for a script based on outcomes
 * Used to filter examples suitable for fine-tuning
 */
export function classifyExampleQuality(
  total_calls: number,
  conversions: number
): 'excellent' | 'good' | 'fair' | 'poor' {
  const rate = total_calls > 0 ? conversions / total_calls : 0;

  // Excellent: 100% over 5+ calls or >90% over 10+ calls
  if ((rate === 1.0 && total_calls >= 5) || (rate >= 0.9 && total_calls >= 10)) {
    return 'excellent';
  }

  // Good: 80-99% over 5+ calls
  if (rate >= 0.8 && total_calls >= 5) {
    return 'good';
  }

  // Fair: 60-79% over 3+ calls
  if (rate >= 0.6 && total_calls >= 3) {
    return 'fair';
  }

  // Poor: Below 60%
  return 'poor';
}

/**
 * Create a fine-tuning example from a script variant with verified outcomes
 * Called after sufficient calls have completed on a script variant
 */
export function createFineTuningDataPoint(
  script_id: string,
  script_content: string,
  lead_profile: JsonRecord,
  call_stats: {
    total_calls: number;
    conversions: number;
    dispositions: Record<string, number>;
  },
  routeType?: string
): FineTuningExample | null {
  const quality = classifyExampleQuality(call_stats.total_calls, call_stats.conversions);

  // Only include good, fair, or excellent examples
  if (quality === 'poor') {
    return null;
  }

  return {
    id: `ftex_${crypto.randomUUID()}`,
    script_variant_id: script_id,
    script_content,
    lead_profile: {
      industry: (lead_profile.industry as string) || 'general',
      location: (lead_profile.location as string) || 'default',
      company_size: (lead_profile.company_size as string),
      target_profile: (lead_profile.target_profile as string)
    },
    call_outcomes: {
      total_calls: call_stats.total_calls,
      conversions: call_stats.conversions,
      conversion_rate: call_stats.total_calls > 0 ? call_stats.conversions / call_stats.total_calls : 0,
      disposition_distribution: call_stats.dispositions
    },
    quality_signal: quality,
    timestamp: new Date().toISOString(),
    route_type: routeType
  };
}

/**
 * Persist fine-tuning example to database
 * Returns true if successfully stored
 */
export function storeFineTuningExample(db: any, example: FineTuningExample): boolean {
  try {
    const query = `
      INSERT INTO finetuning_examples 
      (id, script_variant_id, script_content, lead_profile, conversion_rate, quality_signal, call_outcomes, route_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `;

    (db as any)
      .prepare(query)
      .run(
        example.id,
        example.script_variant_id,
        example.script_content,
        JSON.stringify(example.lead_profile),
        example.call_outcomes.conversion_rate,
        example.quality_signal,
        JSON.stringify(example.call_outcomes),
        example.route_type || ''
      );

    return true;
  } catch (e) {
    console.debug('Fine-tuning example storage failed:', (e as Error).message);
    return false;
  }
}

/**
 * Get fine-tuning dataset statistics
 * Returns readiness for actual fine-tuning process
 */
export function getFineTuningDatasetStats(db: any): FineTuningDataset {
  try {
    const countQuery = `
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN quality_signal = 'excellent' THEN 1 ELSE 0 END) as excellent_count,
        SUM(CASE WHEN quality_signal = 'good' THEN 1 ELSE 0 END) as good_count,
        SUM(CASE WHEN quality_signal = 'fair' THEN 1 ELSE 0 END) as fair_count,
        SUM(CASE WHEN quality_signal = 'poor' THEN 1 ELSE 0 END) as poor_count,
        AVG(conversion_rate) as avg_rate
      FROM finetuning_examples
    `;

    const counts = (db as any).prepare(countQuery).get() as {
      total: number;
      excellent_count: number;
      good_count: number;
      fair_count: number;
      poor_count: number;
      avg_rate: number;
    };

    // Get industry diversity
    const industryQuery = `
      SELECT DISTINCT json_extract(lead_profile, '$.industry') as industry
      FROM finetuning_examples
      WHERE quality_signal IN ('excellent', 'good', 'fair')
    `;

    const industries = (db as any)
      .prepare(industryQuery)
      .all() as Array<{ industry: string }>;

    const totalUsable = (counts.excellent_count || 0) + (counts.good_count || 0) + (counts.fair_count || 0);
    const ready = totalUsable >= 500; // Target: 500 high-quality examples

    return {
      total_examples: counts.total || 0,
      excellent: counts.excellent_count || 0,
      good: counts.good_count || 0,
      fair: counts.fair_count || 0,
      poor: counts.poor_count || 0,
      avg_conversion_rate: counts.avg_rate || 0,
      industries_covered: industries.map((i) => i.industry).filter(Boolean) as string[],
      ready_for_training: ready
    };
  } catch (e) {
    console.debug('Fine-tuning stats retrieval failed:', (e as Error).message);
    return {
      total_examples: 0,
      excellent: 0,
      good: 0,
      fair: 0,
      poor: 0,
      avg_conversion_rate: 0,
      industries_covered: [],
      ready_for_training: false
    };
  }
}

/**
 * Export fine-tuning dataset in JSONL format for model training
 * One example per line in JSON format
 */
export function exportFineTuningDataset(db: any, minQuality: 'fair' | 'good' | 'excellent' = 'fair'): string {
  try {
    const qualityLevels: Record<string, number> = {
      excellent: 3,
      good: 2,
      fair: 1,
      poor: 0
    };

    const minLevel = qualityLevels[minQuality];

    const query = `
      SELECT 
        script_content,
        lead_profile,
        conversion_rate,
        quality_signal,
        call_outcomes,
        route_type
      FROM finetuning_examples
      WHERE quality_signal IN (
        ${minQuality === 'excellent' ? "'excellent'" : minQuality === 'good' ? "'excellent', 'good'" : "'excellent', 'good', 'fair'"}
      )
      ORDER BY conversion_rate DESC, created_at DESC
    `;

    const examples = (db as any).prepare(query).all() as Array<{
      script_content: string;
      lead_profile: string;
      conversion_rate: number;
      quality_signal: string;
      call_outcomes: string;
      route_type: string;
    }>;

    // Format as JSONL (one JSON object per line)
    const jsonl = examples
      .map((ex) => {
        const profile = JSON.parse(ex.lead_profile);
        const outcomes = JSON.parse(ex.call_outcomes);

        return JSON.stringify({
          instruction: `Based on the lead profile and desired outcome, generate an effective sales script.`,
          input: `
Lead Profile:
- Industry: ${profile.industry}
- Location: ${profile.location}
- Target: ${profile.target_profile || 'general'}
- Company Size: ${profile.company_size || 'unknown'}

Desired Outcome: High conversion rate (${(ex.conversion_rate * 100).toFixed(0)}% achieved)
Route Type: ${ex.route_type || 'general'}
          `.trim(),
          output: ex.script_content,
          quality: ex.quality_signal,
          conversion_rate: ex.conversion_rate,
          sample_size: outcomes.total_calls
        });
      })
      .join('\n');

    return jsonl;
  } catch (e) {
    console.debug('Fine-tuning dataset export failed:', (e as Error).message);
    return '';
  }
}

/**
 * Clean up old/poor-quality examples to keep dataset focused
 * Run weekly as maintenance to stay under db limits
 */
export function pruneFineTuningDataset(db: any, keepDays: number = 90): number {
  try {
    // Delete poor quality examples older than retention window
    const deleteQuery = `
      DELETE FROM finetuning_examples
      WHERE (quality_signal = 'poor' OR created_at < datetime('now', '-' || ? || ' days'))
      AND created_at NOT IN (
        SELECT created_at FROM finetuning_examples 
        WHERE quality_signal IN ('excellent', 'good')
        ORDER BY conversion_rate DESC
        LIMIT 500
      )
    `;

    const result = (db as any).prepare(deleteQuery).run(keepDays);
    return (result as any).changes || 0;
  } catch (e) {
    console.debug('Fine-tuning dataset pruning failed:', (e as Error).message);
    return 0;
  }
}
