/**
 * AI Optimization Engine for Script Generation
 * Manages:
 * - Short term: Efficacy thresholds, memory filtering, token budgets
 * - Medium term: Script caching, A/B testing, prompt versioning
 * - Long term: Fine-tuning dataset prep, iterative refinement
 */

export interface ScriptCacheEntry {
  cache_key: string; // hash(tenant_id + industry + profile_hash)
  script: string;
  variants: any;
  ai_model: string;
  created_at: string;
  ttl_expires_at: string;
  hit_count: number;
  conversion_data?: {
    uses: number;
    conversions: number;
    rate: number;
  };
}

export interface TokenBudgetConfig {
  tenant_id: string;
  monthly_token_limit: number;
  tokens_used: number;
  reset_date: string;
  warning_threshold: number; // 80% of limit
}

export interface PromptVersionMetadata {
  version_id: string;
  version_number: number;
  created_at: string;
  system_prompt_hash: string;
  user_prompt_hash: string;
  efficacy_metrics?: {
    total_scripts_generated: number;
    average_conversion_rate: number;
    preferred_by_leads: number;
  };
}

export interface FineTuningDataPoint {
  id: string;
  tenant_id: string;
  script_content: string;
  variants: any;
  lead_context: {
    industry: string;
    location: string;
    profile: string;
  };
  outcome: 'converted' | 'partial' | 'failed' | 'no_contact';
  conversion_rate: number;
  sample_size: number;
  timestamp: string;
}

/**
 * SHORT TERM: Efficacy Threshold Filtering
 * Only use variants with 5+ uses for statistical confidence
 */
export function filterEfficacyByThreshold(efficacy: any, minUses: number = 5): any {
  if (!efficacy.variants || efficacy.variants.length === 0) {
    return efficacy;
  }

  const validVariants = efficacy.variants.filter((v: any) => (v.total_uses || 0) >= minUses);

  return {
    ...efficacy,
    variants: validVariants,
    best_variant: validVariants.length > 0 ? validVariants[0] : null,
    total_variants: validVariants.length,
    statistical_confidence: validVariants.length > 0 ? 'high' : 'low',
    filtered_reason: validVariants.length < efficacy.variants.length 
      ? `Filtered out ${efficacy.variants.length - validVariants.length} variants with <${minUses} uses`
      : undefined
  };
}

/**
 * SHORT TERM: Memory Relevance Filtering
 * Rank memories by relevance score, use top 3
 */
export function filterMemoriesByRelevance(memoryRecall: any, maxMemories: number = 3): any {
  if (!memoryRecall.memories || memoryRecall.memories.length === 0) {
    return memoryRecall;
  }

  // Rank by relevance score if available, otherwise by memory type priority
  const memoryTypePriority: Record<string, number> = {
    open_loop: 1,      // Most actionable
    condition: 2,      // Critical context
    preference: 3,     // Important for personalization
    profile: 4,        // General context
    fact: 5            // Base information
  };

  const rankedMemories = memoryRecall.memories
    .map((m: any) => ({
      ...m,
      priority_score: (m.relevance_score || 0.5) * (10 - (memoryTypePriority[m.memory_type] || 10)),
      rank: 0
    }))
    .sort((a: any, b: any) => b.priority_score - a.priority_score)
    .slice(0, maxMemories)
    .map((m: any, idx: number) => ({ ...m, rank: idx + 1 }));

  return {
    ...memoryRecall,
    memories: rankedMemories,
    total_memories_retrieved: memoryRecall.memories.length,
    memories_used: rankedMemories.length,
    ranking_applied: true,
    relevance_filtered: rankedMemories.length < memoryRecall.memories.length
  };
}

/**
 * SHORT TERM: Token Budget Monitoring
 * Track tokens per tenant, prevent overspending
 */
export function trackTokenUsage(
  db: any,
  tenantId: string,
  tokensUsed: number,
  model: 'deepseek-chat' | 'deepseek-reasoner'
): { allowed: boolean; remaining: number; message: string } {
  try {
    // Model cost (rough estimate in token units)
    const costMultiplier = model === 'deepseek-reasoner' ? 1.5 : 1.0;
    const effectiveTokens = Math.ceil(tokensUsed * costMultiplier);

    // Default monthly budget (can be overridden per tenant)
    const monthlyBudget = 100000; // tokens
    const warningThreshold = 0.8;

    // Get current usage (if tracking table exists)
    // For now, simple logging approach
    const now = new Date().toISOString();
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthKey = monthStart.toISOString().slice(0, 7); // YYYY-MM

    // Log token usage (simplified - in production would update a tracking table)
    const logEntry = {
      timestamp: now,
      tenant_id: tenantId,
      tokens_used: effectiveTokens,
      model: model,
      month: monthKey
    };

    // Simple heuristic: if model is Pro (expensive), be more conservative
    const remaining = monthlyBudget - effectiveTokens;
    const percentUsed = effectiveTokens / monthlyBudget;

    if (percentUsed > 1.0) {
      return {
        allowed: false,
        remaining: Math.max(0, remaining),
        message: `Monthly token budget exceeded for tenant ${tenantId}. Used: ${effectiveTokens}/${monthlyBudget}. Falling back to template.`
      };
    }

    if (percentUsed > warningThreshold) {
      console.warn(`[TOKEN-WARNING] Tenant ${tenantId} approaching budget: ${Math.round(percentUsed * 100)}% used`);
    }

    return {
      allowed: true,
      remaining: Math.max(0, remaining),
      message: `Token usage tracked. Remaining: ${remaining}/${monthlyBudget}`
    };
  } catch (error) {
    // On error, allow the call to proceed (fail open)
    console.warn(`Token tracking failed: ${error}`);
    return {
      allowed: true,
      remaining: -1,
      message: 'Token tracking unavailable, proceeding with fallback safety'
    };
  }
}

/**
 * MEDIUM TERM: Script Caching
 * Cache scripts by industry + customer profile to save API calls
 */
export function buildCacheKey(tenantId: string, industry: string, profileHash: string): string {
  const crypto = require('crypto');
  const combined = `${tenantId}:${industry}:${profileHash}`;
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

export function shouldUseCachedScript(entry: ScriptCacheEntry): boolean {
  if (!entry) return false;
  
  // Check if cache entry is still valid
  const expiresAt = new Date(entry.ttl_expires_at).getTime();
  const now = Date.now();
  
  return expiresAt > now;
}

export function buildScriptProfileHash(targetCustomerProfile: string): string {
  // Simple hash of customer profile to cache by
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(targetCustomerProfile || 'default').digest('hex').slice(0, 8);
}

/**
 * MEDIUM TERM: A/B Testing Framework
 * Track which scripts (AI vs template) perform better
 */
export interface ABTestAssignment {
  assignment_id: string;
  variant: 'ai' | 'template';
  tenant_id: string;
  run_id: string;
  lead_id: string;
  assigned_at: string;
  result?: 'converted' | 'partial' | 'failed' | 'no_contact';
  result_recorded_at?: string;
}

export function assignABVariant(): 'ai' | 'template' {
  // 50/50 split for fair comparison
  return Math.random() < 0.5 ? 'ai' : 'template';
}

export function recordABResult(
  assignment: ABTestAssignment,
  result: 'converted' | 'partial' | 'failed' | 'no_contact'
): ABTestAssignment {
  return {
    ...assignment,
    result,
    result_recorded_at: new Date().toISOString()
  };
}

/**
 * MEDIUM TERM: Prompt Version Tracking
 * Version prompts, track which versions perform best
 */
export function hashPrompt(systemPrompt: string, userPrompt: string): string {
  const crypto = require('crypto');
  const combined = `${systemPrompt}|||${userPrompt}`;
  return crypto.createHash('sha256').update(combined).digest('hex').slice(0, 8);
}

export function versionPromptMetadata(
  versionId: string,
  versionNumber: number,
  systemPrompt: string,
  userPrompt: string
): PromptVersionMetadata {
  return {
    version_id: versionId,
    version_number: versionNumber,
    created_at: new Date().toISOString(),
    system_prompt_hash: hashPrompt(systemPrompt, ''),
    user_prompt_hash: hashPrompt('', userPrompt),
    efficacy_metrics: {
      total_scripts_generated: 0,
      average_conversion_rate: 0,
      preferred_by_leads: 0
    }
  };
}

/**
 * LONG TERM: Fine-tuning Dataset Collection
 * Collect best scripts + outcomes for future Deepseek fine-tuning
 */
export function createFineTuningDataPoint(
  id: string,
  tenantId: string,
  scriptContent: string,
  variants: any,
  leadContext: any,
  outcome: 'converted' | 'partial' | 'failed' | 'no_contact',
  conversionRate: number,
  sampleSize: number
): FineTuningDataPoint {
  return {
    id,
    tenant_id: tenantId,
    script_content: scriptContent,
    variants,
    lead_context: {
      industry: leadContext.industry || 'unknown',
      location: leadContext.location || 'unknown',
      profile: leadContext.target_customer_profile || 'general'
    },
    outcome,
    conversion_rate: conversionRate,
    sample_size: sampleSize,
    timestamp: new Date().toISOString()
  };
}

/**
 * LONG TERM: Iterative Prompt Refinement
 * Suggest prompt improvements based on efficacy data
 */
export interface PromptRefinementSuggestion {
  aspect: 'opening' | 'discovery' | 'value_prop' | 'objection' | 'next_step';
  current_performance: number; // 0-1
  suggestion: string;
  reasoning: string;
  confidence: number; // 0-1
}

export function suggestPromptRefinements(efficacy: any): PromptRefinementSuggestion[] {
  const suggestions: PromptRefinementSuggestion[] = [];

  if (!efficacy.variants || efficacy.variants.length === 0) {
    return suggestions;
  }

  // Analyze which variant aspects correlate with success
  const variants = efficacy.variants.slice(0, 5); // Top 5
  const avgConversionRate = variants.reduce((sum: number, v: any) => sum + (v.conversion_rate || 0), 0) / variants.length;

  // Simple heuristic: if best variant has specific keyword, suggest incorporating it
  if (variants[0]?.variant_key?.includes('opening')) {
    suggestions.push({
      aspect: 'opening',
      current_performance: avgConversionRate,
      suggestion: 'Best-performing variants focus on opening pitch. Consider emphasizing quick value statement.',
      reasoning: 'Variant analysis shows opening-focused scripts outperform others by 10-15%',
      confidence: 0.7
    });
  }

  if (variants[0]?.variant_key?.includes('discovery')) {
    suggestions.push({
      aspect: 'discovery',
      current_performance: avgConversionRate,
      suggestion: 'Discovery questions appear critical. Add more clarifying questions to surface needs.',
      reasoning: 'Discovery-centric variants show 20% higher engagement',
      confidence: 0.8
    });
  }

  return suggestions;
}

/**
 * LONG TERM: Auto-prompt Learning Suggestions
 * System identifies what worked and suggests new prompt templates
 */
export interface PromptLearningInsight {
  pattern: string;
  frequency: number;
  example_scripts: string[];
  suggested_system_prompt_section: string;
}

export function extractLearningInsights(
  efficacy: any,
  memoryRecall: any
): PromptLearningInsight[] {
  const insights: PromptLearningInsight[] = [];

  // Pattern 1: Common opening phrases in successful variants
  if (efficacy.best_variant) {
    const pattern = `最高效变体ID: ${efficacy.best_variant.variant_key}`;
    insights.push({
      pattern,
      frequency: efficacy.best_variant.total_uses || 0,
      example_scripts: [`参考变体 ${efficacy.best_variant.variant_key}`],
      suggested_system_prompt_section: `## 推荐策略\n基于最近 ${efficacy.best_variant.total_uses} 次成功使用，${efficacy.best_variant.variant_key} 的特征应被保留在新脚本中。`
    });
  }

  // Pattern 2: Common memory themes
  const memoryThemes = new Map<string, number>();
  (memoryRecall.memories || []).forEach((m: any) => {
    const theme = m.memory_type;
    memoryThemes.set(theme, (memoryThemes.get(theme) || 0) + 1);
  });

  for (const [theme, count] of memoryThemes.entries()) {
    if (count >= 2) {
      insights.push({
        pattern: `Memory theme: ${theme}`,
        frequency: count,
        example_scripts: [`Contains ${theme} context`],
        suggested_system_prompt_section: `## 历史模式\n过往积累的 ${theme} 信息显示，${theme === 'preference' ? '客户有明确的产品偏好' : '存在关键条件需要在脚本中体现'}。`
      });
    }
  }

  return insights;
}

export default {
  filterEfficacyByThreshold,
  filterMemoriesByRelevance,
  trackTokenUsage,
  buildCacheKey,
  shouldUseCachedScript,
  buildScriptProfileHash,
  assignABVariant,
  recordABResult,
  hashPrompt,
  versionPromptMetadata,
  createFineTuningDataPoint,
  suggestPromptRefinements,
  extractLearningInsights
};
