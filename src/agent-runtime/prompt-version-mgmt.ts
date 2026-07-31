/**
 * Prompt Version Management & Tracking
 * Versions all system/user prompts, tracks their conversion rates
 * Automatically promotes high-performing prompt versions
 * 
 * Workflow:
 * 1. Hash each prompt used
 * 2. Track which script version it produced
 * 3. When script is used in calls, track outcomes
 * 4. Calculate conversion rate per prompt version
 * 5. Use top 3 performing versions with weighted probability
 */

import crypto from 'crypto';
import type { JsonRecord } from './integrations/provider-runtime-types.js';

export type PromptLearningPhase = 'baseline' | 'optimized' | 'refined';

export interface PromptVersion {
  version_id: string;
  version_hash: string;
  system_prompt: string;
  user_prompt: string;
  created_at: string;
  industry_specific?: string;
  learning_phase?: PromptLearningPhase;
}

export interface PromptVersionEfficacy {
  version_hash: string;
  total_scripts_generated: number;
  total_calls: number;
  conversions: number;
  conversion_rate: number;
  last_updated: string;
  promoted: boolean;
}

export interface PromptPromotionAssessment {
  version_hash: string;
  from_phase: PromptLearningPhase;
  current_phase: PromptLearningPhase;
  next_phase: PromptLearningPhase | null;
  status: 'observing' | 'ready_to_promote' | 'promoted' | 'steady';
  total_calls: number;
  conversions: number;
  conversion_rate: number;
  conversion_rate_pct: number;
  remaining_calls: number;
  remaining_conversions: number;
  remaining_rate_pct: number;
  promoted: boolean;
  rules: string[];
  summary: string;
  next_action: string;
}

const PROMOTION_RULES: Record<'baseline' | 'optimized', {
  next_phase: PromptLearningPhase;
  min_calls: number;
  min_conversions: number;
  min_rate: number;
}> = {
  baseline: {
    next_phase: 'optimized',
    min_calls: 5,
    min_conversions: 2,
    min_rate: 0.25
  },
  optimized: {
    next_phase: 'refined',
    min_calls: 10,
    min_conversions: 4,
    min_rate: 0.35
  }
};

function normalizeLearningPhase(phase: unknown): PromptLearningPhase {
  return phase === 'optimized' || phase === 'refined' ? phase : 'baseline';
}

function promptPhaseLabel(phase: PromptLearningPhase | null | undefined): string {
  return {
    baseline: '基线',
    optimized: '优化',
    refined: '精修'
  }[phase || 'baseline'] || '基线';
}

function promptRatePct(rate: number): number {
  return Math.round(Math.max(0, rate) * 1000) / 10;
}

/**
 * Generate deterministic hash of prompt content
 * Same prompt content always produces same hash
 */
export function hashPrompt(system_prompt: string, user_prompt: string): string {
  const combined = `${system_prompt}||${user_prompt}`;
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Create version metadata for a prompt
 * Called when a new prompt variant is first used
 */
export function versionPromptMetadata(
  system_prompt: string,
  user_prompt: string,
  industryContext?: string,
  learningPhase?: 'baseline' | 'optimized' | 'refined'
): PromptVersion {
  const versionHash = hashPrompt(system_prompt, user_prompt);

  return {
    version_id: `promptv_${crypto.randomUUID()}`,
    version_hash: versionHash,
    system_prompt,
    user_prompt,
    created_at: new Date().toISOString(),
    industry_specific: industryContext,
    learning_phase: learningPhase || 'baseline'
  };
}

/**
 * Record that a prompt version was used to generate a script
 * Called immediately after script generation
 */
export function recordPromptUsage(db: any, run_id: string, version: PromptVersion): boolean {
  try {
    // Find or create prompt version record
    const existingQuery = `
      SELECT version_hash FROM prompt_versions 
      WHERE version_hash = ?
      LIMIT 1
    `;
    const existing = (db as any).prepare(existingQuery).get(version.version_hash);

    if (!existing) {
      // First time seeing this prompt, insert it
      const insertQuery = `
        INSERT INTO prompt_versions 
        (version_id, version_hash, system_prompt, user_prompt, created_at, industry_specific, learning_phase)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      (db as any)
        .prepare(insertQuery)
        .run(
          version.version_id,
          version.version_hash,
          version.system_prompt,
          version.user_prompt,
          version.created_at,
          version.industry_specific || '',
          version.learning_phase || 'baseline'
        );
    }

    // Create usage record linking run to prompt version
    const usageQuery = `
      INSERT INTO prompt_usage_log (run_id, version_hash, used_at)
      VALUES (?, ?, datetime('now'))
    `;
    (db as any).prepare(usageQuery).run(run_id, version.version_hash);

    (db as any).prepare(`
      INSERT INTO prompt_version_efficacy
      (version_hash, total_scripts_generated, total_calls, conversions, conversion_rate, last_updated, promoted)
      VALUES (?, 1, 0, 0, 0, datetime('now'), 0)
      ON CONFLICT(version_hash) DO UPDATE SET
        total_scripts_generated = total_scripts_generated + 1,
        last_updated = datetime('now')
    `).run(version.version_hash);

    applyPromptPromotionRules(db, version.version_hash);

    return true;
  } catch (e) {
    console.debug('Prompt usage recording failed:', (e as Error).message);
    return false;
  }
}

/**
 * Update efficacy metrics for a prompt version based on call outcomes
 * Called after call completion with conversion result
 */
export function recordPromptEfficacy(db: any, run_id: string, didConvert: boolean): boolean {
  try {
    // Find the prompt version used in this run
    const versionQuery = `
      SELECT version_hash FROM prompt_usage_log 
      WHERE run_id = ?
      ORDER BY used_at DESC
      LIMIT 1
    `;
    const versionRec = (db as any).prepare(versionQuery).get(run_id) as { version_hash: string } | undefined;

    if (!versionRec) {
      return false;
    }

    // Update efficacy record
    const existingEfficacyQuery = `
      SELECT version_hash FROM prompt_version_efficacy 
      WHERE version_hash = ?
      LIMIT 1
    `;
    const existing = (db as any).prepare(existingEfficacyQuery).get(versionRec.version_hash);

    const convertValue = didConvert ? 1 : 0;

    if (existing) {
      // Update existing efficacy
      const updateQuery = `
        UPDATE prompt_version_efficacy
        SET 
          total_calls = total_calls + 1,
          conversions = conversions + ?,
          conversion_rate = (conversions + ?) / (total_calls + 1),
          last_updated = datetime('now')
        WHERE version_hash = ?
      `;
      (db as any).prepare(updateQuery).run(convertValue, convertValue, versionRec.version_hash);
    } else {
      // Create new efficacy record
      const insertQuery = `
        INSERT INTO prompt_version_efficacy 
        (version_hash, total_scripts_generated, total_calls, conversions, conversion_rate, last_updated)
        VALUES (?, 0, 1, ?, ?, datetime('now'))
      `;
      (db as any)
        .prepare(insertQuery)
        .run(versionRec.version_hash, convertValue, didConvert ? 1 : 0);
    }

    applyPromptPromotionRules(db, versionRec.version_hash);

    return true;
  } catch (e) {
    console.debug('Prompt efficacy recording failed:', (e as Error).message);
    return false;
  }
}

export function getPromptPromotionAssessment(db: any, version_hash: string): PromptPromotionAssessment | null {
  try {
    const promptVersion = (db as any).prepare(`
      SELECT version_hash, learning_phase
      FROM prompt_versions
      WHERE version_hash = ?
      LIMIT 1
    `).get(version_hash) as { version_hash: string; learning_phase?: PromptLearningPhase } | undefined;

    if (!promptVersion) return null;

    const efficacy = (db as any).prepare(`
      SELECT total_calls, conversions, conversion_rate, promoted
      FROM prompt_version_efficacy
      WHERE version_hash = ?
      LIMIT 1
    `).get(version_hash) as {
      total_calls?: number;
      conversions?: number;
      conversion_rate?: number;
      promoted?: number;
    } | undefined;

    const fromPhase = normalizeLearningPhase(promptVersion.learning_phase);
    const currentPhase = fromPhase;
    const totalCalls = Math.max(0, Number(efficacy?.total_calls || 0) || 0);
    const conversions = Math.max(0, Number(efficacy?.conversions || 0) || 0);
    const conversionRate = Math.max(0, Number(efficacy?.conversion_rate || 0) || 0);
    const conversionRatePct = promptRatePct(conversionRate);
    const promoted = Boolean(Number(efficacy?.promoted || 0));
    const rule = fromPhase === 'refined' ? null : PROMOTION_RULES[fromPhase];

    if (!rule) {
      return {
        version_hash,
        from_phase: fromPhase,
        current_phase: currentPhase,
        next_phase: null,
        status: 'steady',
        total_calls: totalCalls,
        conversions,
        conversion_rate: conversionRate,
        conversion_rate_pct: conversionRatePct,
        remaining_calls: 0,
        remaining_conversions: 0,
        remaining_rate_pct: 0,
        promoted,
        rules: ['已处于精修阶段，后续只看是否持续稳定。'],
        summary: '当前 prompt 已处于精修阶段，不再继续自动升版。',
        next_action: '继续看真实回写，确认这版精修 prompt 是否还能稳定复用。'
      };
    }

    const remainingCalls = Math.max(0, rule.min_calls - totalCalls);
    const remainingConversions = Math.max(0, rule.min_conversions - conversions);
    const remainingRatePct = Math.max(0, promptRatePct(rule.min_rate - conversionRate));
    const eligible = totalCalls >= rule.min_calls
      && conversions >= rule.min_conversions
      && conversionRate >= rule.min_rate;
    const status = eligible
      ? 'ready_to_promote'
      : promoted && fromPhase !== 'baseline'
        ? 'promoted'
        : 'observing';
    const rules = [
      `至少 ${rule.min_calls} 次真实结果回写`,
      `至少 ${rule.min_conversions} 次正向结果`,
      `整体转化达到 ${promptRatePct(rule.min_rate)}%`
    ];

    let summary = '';
    let nextAction = '';
    if (status === 'ready_to_promote') {
      summary = `当前 prompt 已累计 ${totalCalls} 次结果回写，转化 ${conversionRatePct}%，达到从${promptPhaseLabel(fromPhase)}升到${promptPhaseLabel(rule.next_phase)}的门槛。`;
      nextAction = `下一轮可直接沿 ${promptPhaseLabel(rule.next_phase)} prompt 继续打，并观察是否还能稳住当前转化。`;
    } else if (status === 'promoted') {
      summary = `当前 prompt 已升到${promptPhaseLabel(fromPhase)}阶段，本轮继续沿这版表达跑真实回写。`;
      nextAction = `先继续用这版 ${promptPhaseLabel(fromPhase)} prompt 打今天队列，再决定是否继续升到${promptPhaseLabel(rule.next_phase)}。`;
    } else {
      const gaps = [
        remainingCalls > 0 ? `还差 ${remainingCalls} 次结果回写` : '',
        remainingConversions > 0 ? `还差 ${remainingConversions} 次正向结果` : '',
        remainingRatePct > 0 ? `还差 ${remainingRatePct}% 转化` : ''
      ].filter(Boolean);
      summary = totalCalls > 0
        ? `当前 prompt 已有 ${totalCalls} 次结果回写，转化 ${conversionRatePct}%，离升到${promptPhaseLabel(rule.next_phase)}还${gaps.join('、')}。`
        : `当前 prompt 还在观察期，后续达到 ${promptPhaseLabel(rule.next_phase)}门槛后再自动升版。`;
      nextAction = gaps.length
        ? `先继续沿当前 prompt 跑真实回写，优先把${gaps.join('、')}补齐。`
        : `先继续沿当前 prompt 跑真实回写，确认它能稳定达到升版门槛。`;
    }

    return {
      version_hash,
      from_phase: fromPhase,
      current_phase: currentPhase,
      next_phase: rule.next_phase,
      status,
      total_calls: totalCalls,
      conversions,
      conversion_rate: conversionRate,
      conversion_rate_pct: conversionRatePct,
      remaining_calls: remainingCalls,
      remaining_conversions: remainingConversions,
      remaining_rate_pct: remainingRatePct,
      promoted,
      rules,
      summary,
      next_action: nextAction
    };
  } catch (e) {
    console.debug('Prompt promotion assessment failed:', (e as Error).message);
    return null;
  }
}

export function applyPromptPromotionRules(db: any, version_hash: string): PromptPromotionAssessment | null {
  const assessment = getPromptPromotionAssessment(db, version_hash);
  if (!assessment) return null;
  if (assessment.status !== 'ready_to_promote' || !assessment.next_phase) {
    return assessment;
  }

  try {
    (db as any).prepare(`
      UPDATE prompt_versions
      SET learning_phase = ?
      WHERE version_hash = ?
    `).run(assessment.next_phase, version_hash);

    (db as any).prepare(`
      UPDATE prompt_version_efficacy
      SET promoted = 1, last_updated = datetime('now')
      WHERE version_hash = ?
    `).run(version_hash);

    return {
      ...assessment,
      current_phase: assessment.next_phase,
      status: 'promoted',
      promoted: true,
      summary: `当前 prompt 已从${promptPhaseLabel(assessment.from_phase)}升到${promptPhaseLabel(assessment.next_phase)}阶段，可直接沿这版继续打。`,
      next_action: `下一轮继续沿 ${promptPhaseLabel(assessment.next_phase)} prompt 推进，并确认升版后的表达还能保持稳定。`
    };
  } catch (e) {
    console.debug('Prompt promotion writeback failed:', (e as Error).message);
    return assessment;
  }
}

/**
 * Get top N performing prompt versions
 * Returns ranked by conversion rate with sufficient sample size
 */
export function getTopPerformingPrompts(db: any, minSamples: number = 3, limit: number = 3): PromptVersionEfficacy[] {
  try {
    const query = `
      SELECT 
        pve.version_hash,
        pve.total_scripts_generated,
        pve.total_calls,
        pve.conversions,
        pve.conversion_rate,
        pve.last_updated,
        pve.promoted
      FROM prompt_version_efficacy pve
      WHERE pve.total_calls >= ?
      ORDER BY pve.conversion_rate DESC, pve.total_calls DESC
      LIMIT ?
    `;

    const results = (db as any)
      .prepare(query)
      .all(minSamples, limit) as PromptVersionEfficacy[];

    return results || [];
  } catch (e) {
    console.debug('Top prompts retrieval failed:', (e as Error).message);
    return [];
  }
}

/**
 * Select a prompt version for next script generation
 * Uses weighted probability: top performer gets 50%, runner-up 30%, third 20%
 */
export function selectPromptVersionWithWeighting(
  topPrompts: PromptVersionEfficacy[]
): string | null {
  if (!topPrompts || topPrompts.length === 0) {
    return null;
  }

  // Weighted selection
  const rand = Math.random();

  if (topPrompts.length >= 3) {
    // All three available: 50/30/20
    if (rand < 0.5) return topPrompts[0].version_hash;
    if (rand < 0.8) return topPrompts[1].version_hash;
    return topPrompts[2].version_hash;
  }

  if (topPrompts.length === 2) {
    // Two available: 60/40
    if (rand < 0.6) return topPrompts[0].version_hash;
    return topPrompts[1].version_hash;
  }

  // One available: always use it
  return topPrompts[0].version_hash;
}

/**
 * Get a specific prompt version by hash
 * Returns null if not found
 */
export function getPromptVersionByHash(db: any, version_hash: string): PromptVersion | null {
  try {
    const query = `
      SELECT version_id, version_hash, system_prompt, user_prompt, created_at, industry_specific, learning_phase
      FROM prompt_versions 
      WHERE version_hash = ?
      LIMIT 1
    `;

    const result = (db as any).prepare(query).get(version_hash) as PromptVersion | undefined;
    return result || null;
  } catch (e) {
    console.debug('Prompt version retrieval failed:', (e as Error).message);
    return null;
  }
}

/**
 * Get statistics on all prompt versions
 * Used for reporting and decision-making
 */
export function getPromptVersionStats(db: any): {
  total_versions: number;
  active_versions: number;
  avg_conversion_rate: number;
  top_version_rate: number;
  bottom_version_rate: number;
} {
  try {
    const countQuery = 'SELECT COUNT(*) as count FROM prompt_versions';
    const totalCount = ((db as any).prepare(countQuery).get() as { count: number }).count || 0;

    const activeQuery = 'SELECT COUNT(*) as count FROM prompt_versions WHERE created_at > datetime("now", "-30 days")';
    const activeCount = ((db as any).prepare(activeQuery).get() as { count: number }).count || 0;

    const statsQuery = `
      SELECT 
        AVG(conversion_rate) as avg_rate,
        MAX(conversion_rate) as max_rate,
        MIN(conversion_rate) as min_rate
      FROM prompt_version_efficacy
      WHERE total_calls >= 3
    `;

    const stats = (db as any).prepare(statsQuery).get() as {
      avg_rate: number;
      max_rate: number;
      min_rate: number;
    };

    return {
      total_versions: totalCount,
      active_versions: activeCount,
      avg_conversion_rate: stats.avg_rate || 0,
      top_version_rate: stats.max_rate || 0,
      bottom_version_rate: stats.min_rate || 0
    };
  } catch (e) {
    console.debug('Prompt version stats failed:', (e as Error).message);
    return {
      total_versions: 0,
      active_versions: 0,
      avg_conversion_rate: 0,
      top_version_rate: 0,
      bottom_version_rate: 0
    };
  }
}
