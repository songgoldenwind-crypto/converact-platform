/**
 * AI Script Generation with Deepseek
 * 
 * Generates script variants using Deepseek v4 API.
 * Includes:
 * - System prompt for script generation
 * - Context from lead profile, industry, efficacy data
 * - Fallback to templates on failure
 * - Cost tracking and token monitoring
 */

import type { DeepseekConfig, DeepseekRequest } from './integrations/deepseek-provider.js';
import { DeepseekProvider, completeViaEnvLlm } from './integrations/deepseek-provider.js';
import { isEnvLlmConfigured } from './integrations/llm-env-client.js';
import type { PromptLearningPhase } from './prompt-version-mgmt.js';
import { recordPromptUsage, versionPromptMetadata } from './prompt-version-mgmt.js';

export interface AIScriptVariant {
  key: string;
  source: string;
  content: string;
  model?: string;
  prompt_version_hash?: string;
}

export interface AIScriptGenerationContext {
  tenantId: string;
  runId: string;
  leadId?: string;
  industry: string;
  location: string;
  targetProfile: string;
  leadReason?: string;
  prospectMessage?: string;
  memoryHints?: string[];
  efficacyData?: {
    templateRate?: number;
    aiRate?: number;
    samples?: number;
  };
  previousVariants?: Array<{
    key: string;
    text: string;
    performanceRate?: number;
  }>;
  scriptAngleRefresh?: {
    avoid_generic_openers?: boolean;
    emphasize_source_evidence?: boolean;
    source?: string;
  };
  industryPlaybook?: {
    openingHooks?: string[];
    messageAngles?: Array<{ key: string; label: string; angle: string; supporting_evidence?: string }>;
    objectionPatterns?: Array<{ key: string; label: string; response_angle: string; evidence?: string }>;
  };
  scriptLessons?: string[];
  channel?: string;
  routeCorrection?: {
    routeType?: string;
    routeLabel?: string;
    reason?: string;
    improvements?: string[];
    promptLearningPhase?: PromptLearningPhase;
  };
}

export interface AIScriptResult {
  content: string;
  source: 'ai_generated';
  model: string;
  tokensUsed: number;
  costEstimate: number;
  confidence: number;
  promptVersionHash: string;
}

/**
 * Build system prompt for script generation
 * PHASE 5A: KV-Cache Optimization - Static system prompt (no dynamic values)
 * Channel-aware: adjusts style for phone / wechat / email / DM
 */
function buildScriptGenerationSystemPrompt(channel?: string): string {
  const ch = (channel || '').toLowerCase();
  if (ch === 'wechat' || ch === 'wechat_private_message' || ch === 'weixin') {
    return `You are an expert sales copywriter specializing in WeChat/WeCom private messages for B2B outreach.

Your task is to generate a concise, friendly WeChat message to a prospect.

Requirements:
1. Keep it under 200 Chinese characters — WeChat messages must be scannable on mobile
2. Open with a context-relevant greeting (not "您好" alone)
3. State why you're reaching out with a specific, personalized trigger
4. Include one clear value proposition or curiosity hook
5. End with a low-pressure question or call-to-action (e.g., "方便聊聊吗？")
6. Sound natural and warm — like a professional contact, not a spammer
7. No formal letter formatting — this is a chat message

Format your response as the message text only.
Do NOT include labels, explanations, or meta-commentary.`;
  }

  if (ch === 'email') {
    return `You are an expert sales copywriter specializing in B2B cold emails.

Your task is to generate a concise, compelling cold email opening for a salesperson.

Requirements:
1. Subject line: under 50 chars, specific and curiosity-driven
2. Body: 3-4 short paragraphs, under 150 words total
3. Start with a specific trigger reason tied to the prospect's industry
4. Include a clear value proposition
5. End with a specific, low-friction ask (e.g., "Mind if I send a quick overview?")
6. Professional but not stiff — write like a human, not a template
7. No attachments or links in the cold email

Format: First line = subject line, then blank line, then email body.
Do NOT include labels, explanations, or meta-commentary.`;
  }

  if (ch === 'platform_private_message' || ch === 'dm' || ch === 'direct_message' || ch === 'comment_reply') {
    return `You are an expert sales copywriter specializing in social media direct messages for B2B outreach.

Your task is to generate a brief, authentic DM to a prospect on a professional or social platform.

Requirements:
1. Keep it under 100 words — DMs must be instantly readable
2. Reference their content or activity if possible (shows you're not spam)
3. State one specific reason you're reaching out
4. End with a simple, non-pushy question
5. Sound like a real person, not a sales bot
6. No formal greetings — be direct but friendly

Format your response as the message text only.
Do NOT include labels, explanations, or meta-commentary.`;
  }

  // Default: phone call script
  return `You are an expert sales copywriter specializing in B2B outbound calling scripts.

Your task is to generate a concise, compelling script opening for a salesperson to use when cold calling prospects.

Requirements:
1. Keep it concise (under 30 seconds to read)
2. Start with a specific trigger reason (mention something about the prospect's industry/size)
3. Include a clear value proposition or curiosity hook
4. End with a specific, easy-to-answer question or "yes/no" checkpoint
5. Sound natural and conversational (not robotic)
6. Avoid being pushy or generic
7. Maintain consistent style and tone across variations

Format your response as a single paragraph (the actual script to read).
Do NOT include stage labels, explanations, or meta-commentary.
Just the script text itself.`;
}

/**
 * Build user prompt for script generation
 * PHASE 5A: 
 * - Efficacy threshold filtering (≥5 uses only)
 * - Memory relevance filtering (top 3 with score)
 * - Confidence markers (helps model understand data quality)
 * - Recitation pattern (Manus): restate best variant + exploration direction
 */
function buildScriptGenerationUserPrompt(context: AIScriptGenerationContext): string {
  const parts: string[] = [];

  parts.push(`Generate a sales script opening for prospecting.`);

  if (context.targetProfile) {
    parts.push(`Target customer profile: ${context.targetProfile}`);
  }

  if (context.leadReason) {
    parts.push(`Why we're calling this lead: ${context.leadReason}`);
  }

  if (context.prospectMessage) {
    parts.push(`Prospect's own words: "${context.prospectMessage}"`);
  }

  // PHASE 5A: Memory relevance filtering - top 3 only
  if (context.memoryHints && context.memoryHints.length > 0) {
    parts.push(`Historical context from past interactions:\n- ${context.memoryHints.join('\n- ')}`);
  }

  if (context.scriptAngleRefresh) {
    const guidance: string[] = [];
    if (context.scriptAngleRefresh.avoid_generic_openers) guidance.push('avoid generic openers');
    if (context.scriptAngleRefresh.emphasize_source_evidence) guidance.push('emphasize source evidence');
    if (guidance.length) {
      parts.push(`Feedback-based script guidance: ${guidance.join(', ')}.`);
    }
  }

  if (context.industryPlaybook) {
    const pb = context.industryPlaybook;
    if (pb.openingHooks && pb.openingHooks.length > 0) {
      parts.push(`Industry playbook opening strategy:\n- ${pb.openingHooks.join('\n- ')}`);
    }
    if (pb.messageAngles && pb.messageAngles.length > 0) {
      const angleTexts = pb.messageAngles.map((a) =>
        `[${a.label}] ${a.angle}${a.supporting_evidence ? ` (why: ${a.supporting_evidence})` : ''}`
      );
      parts.push(`Industry playbook message angles:\n- ${angleTexts.join('\n- ')}`);
    }
    if (pb.objectionPatterns && pb.objectionPatterns.length > 0) {
      const objTexts = pb.objectionPatterns.map((o) =>
        `[${o.label}] ${o.response_angle}${o.evidence ? ` (why: ${o.evidence})` : ''}`
      );
      parts.push(`Industry playbook objection responses:\n- ${objTexts.join('\n- ')}`);
    }
  }

  // Script lessons from previous batch learning
  if (context.scriptLessons && context.scriptLessons.length > 0) {
    parts.push(`Lessons from previous outreach batch:\n- ${context.scriptLessons.join('\n- ')}`);
  }

  // PHASE 5A: Efficacy threshold filtering (≥5 uses) + confidence markers
  if (context.efficacyData) {
    const { templateRate = 0, aiRate = 0, samples = 0 } = context.efficacyData;
    if (samples >= 5) {
      // Mark as "confident" data point (statistically significant)
      parts.push(`Performance benchmarks from recent calls (CONFIDENT - based on ${samples} samples):\n- Template script: ${templateRate.toFixed(1)}% conversion rate\n- Previous AI script: ${aiRate.toFixed(1)}% conversion rate`);
    }
    // Variants with <5 uses are silently omitted for token efficiency
  }

  // PHASE 5A: Recitation pattern (Manus) - restate current best + direction
  if (context.previousVariants && context.previousVariants.length > 0) {
    const topVariant = context.previousVariants.sort(
      (a, b) => (b.performanceRate || 0) - (a.performanceRate || 0)
    )[0];
    
    parts.push(`CURRENT BEST VARIANT:\n"${topVariant.text}"\nPerformance: ${(topVariant.performanceRate || 0).toFixed(1)}% conversion rate\n\nGENERATION DIRECTION: Generate a fresh variation that maintains the core approach while exploring slightly different wording, tone, or hook. Ensure structural consistency with the best variant but add new energy.`);
  }

  if (context.routeCorrection) {
    const correction = context.routeCorrection;
    const improvements = Array.isArray(correction.improvements)
      ? correction.improvements.filter(Boolean)
      : [];
    parts.push([
      'ROUTE CORRECTION PRIORITY',
      `Weak route to correct: ${correction.routeLabel || correction.routeType || 'unknown'}`,
      correction.reason ? `Reason: ${correction.reason}` : '',
      improvements.length ? `Required improvements:\n- ${improvements.join('\n- ')}` : '',
      `Prompt phase to continue from: ${correction.promptLearningPhase || 'baseline'}`
    ].filter(Boolean).join('\n'));
  }

  return parts.join('\n\n');
}

/**
 * Generate script with env LLM stack (primary + fallback)
 */
export async function generateScriptWithAIFromEnv(
  context: AIScriptGenerationContext
): Promise<AIScriptResult> {
  const systemPrompt = buildScriptGenerationSystemPrompt(context.channel);
  const userPrompt = buildScriptGenerationUserPrompt(context);
  const promptVersion = versionPromptMetadata(
    systemPrompt,
    userPrompt,
    context.industry,
    context.routeCorrection?.promptLearningPhase
  );

  const response = await completeViaEnvLlm({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 300,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error('No response from LLM');
  }

  const content = response.choices[0].message.content.trim();
  const promptTokens = response.usage?.prompt_tokens || 0;
  const completionTokens = response.usage?.completion_tokens || 0;
  const costEstimate = (promptTokens * 0.14 + completionTokens * 0.28) / 1000000;

  return {
    content,
    source: 'ai_generated',
    model: response.model,
    tokensUsed: response.usage?.total_tokens || 0,
    costEstimate,
    confidence: 0.85,
    promptVersionHash: promptVersion.version_hash,
  };
}

/**
 * Generate script with Deepseek
 */
export async function generateScriptWithAI(
  config: DeepseekConfig,
  context: AIScriptGenerationContext
): Promise<AIScriptResult> {
  const provider = new DeepseekProvider({
    ...config,
    model: config.model || 'deepseek-chat', // Flash by default for speed/cost
    temperature: 0.7,
    maxTokens: 300, // Script is short
    timeout: 10000, // 10s timeout
  });

  const systemPrompt = buildScriptGenerationSystemPrompt(context.channel);
  const userPrompt = buildScriptGenerationUserPrompt(context);
  const promptVersion = versionPromptMetadata(
    systemPrompt,
    userPrompt,
    context.industry,
    context.routeCorrection?.promptLearningPhase
  );

  const request: DeepseekRequest = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 300,
  };

  try {
    const response = await provider.complete(request);

    if (!response.choices || response.choices.length === 0) {
      throw new Error('No response from Deepseek API');
    }

    const content = response.choices[0].message.content.trim();

    // Estimate cost (based on token counts)
    const promptTokens = response.usage?.prompt_tokens || 0;
    const completionTokens = response.usage?.completion_tokens || 0;
    // Flash pricing: $0.14/1M prompt, $0.28/1M completion (approximate)
    const costEstimate = (promptTokens * 0.14 + completionTokens * 0.28) / 1000000;

    return {
      content,
      source: 'ai_generated',
      model: response.model,
      tokensUsed: response.usage?.total_tokens || 0,
      costEstimate,
      confidence: 0.85, // AI scripts generally have high confidence
      promptVersionHash: promptVersion.version_hash,
    };
  } catch (error) {
    console.error('Deepseek script generation failed:', error);
    throw new Error(`Failed to generate script with AI: ${error.message}`);
  }
}

export async function generateScriptVariantsWithAIFromEnv(
  db: any,
  context: AIScriptGenerationContext,
  templateFallback: { opening: string; variants: string[] }
): Promise<AIScriptVariant[]> {
  const variants: AIScriptVariant[] = [];

  try {
    const aiResult = await generateScriptWithAIFromEnv(context);
    const systemPrompt = buildScriptGenerationSystemPrompt(context.channel);
    const userPrompt = buildScriptGenerationUserPrompt(context);
    recordPromptUsage(
      db,
      context.runId,
      versionPromptMetadata(
        systemPrompt,
        userPrompt,
        context.industry,
        context.routeCorrection?.promptLearningPhase
      )
    );
    variants.push({
      key: 'ai_opening',
      source: 'ai_generated',
      content: aiResult.content,
      model: aiResult.model,
      prompt_version_hash: aiResult.promptVersionHash,
    });

    recordTokenUsage(db, context.tenantId, {
      model: aiResult.model,
      tokensUsed: aiResult.tokensUsed,
      costEstimate: aiResult.costEstimate,
      source: 'script_generation',
      success: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('AI script generation failed, falling back to template:', message);

    recordTokenUsage(db, context.tenantId, {
      model: 'env-llm',
      tokensUsed: 0,
      costEstimate: 0,
      source: 'script_generation',
      success: false,
      errorReason: message,
    });

    if (templateFallback.opening) {
      variants.push({
        key: 'template_opening',
        source: 'template',
        content: templateFallback.opening,
      });
    }
  }

  if (templateFallback.opening && !variants.some((v) => v.source === 'template')) {
    variants.push({
      key: 'template_opening',
      source: 'template',
      content: templateFallback.opening,
    });
  }

  return variants;
}

/**
 * Generate script variants (AI + template fallback)
 */
export async function generateScriptVariantsWithAI(
  db: any,
  config: DeepseekConfig,
  context: AIScriptGenerationContext,
  templateFallback: { opening: string; variants: string[] }
): Promise<AIScriptVariant[]> {
  const variants: AIScriptVariant[] = [];

  try {
    // Try AI generation
    const aiResult = await generateScriptWithAI(config, context);
    const systemPrompt = buildScriptGenerationSystemPrompt(context.channel);
    const userPrompt = buildScriptGenerationUserPrompt(context);
    recordPromptUsage(
      db,
      context.runId,
      versionPromptMetadata(
        systemPrompt,
        userPrompt,
        context.industry,
        context.routeCorrection?.promptLearningPhase
      )
    );
    variants.push({
      key: 'ai_opening',
      source: 'ai_generated',
      content: aiResult.content,
      model: aiResult.model,
      prompt_version_hash: aiResult.promptVersionHash,
    });

    // Log token usage for cost monitoring
    recordTokenUsage(db, context.tenantId, {
      model: aiResult.model,
      tokensUsed: aiResult.tokensUsed,
      costEstimate: aiResult.costEstimate,
      source: 'script_generation',
      success: true,
    });
  } catch (error) {
    console.warn('AI script generation failed, falling back to template:', error.message);

    // Log failure
    recordTokenUsage(db, context.tenantId, {
      model: config.model || 'deepseek-chat',
      tokensUsed: 0,
      costEstimate: 0,
      source: 'script_generation',
      success: false,
      errorReason: error.message,
    });

    // Fall back to template
    if (templateFallback.opening) {
      variants.push({
        key: 'template_opening',
        source: 'template',
        content: templateFallback.opening,
      });
    }
  }

  // Always include template as variant B for A/B testing
  if (templateFallback.opening && !variants.some((v) => v.source === 'template')) {
    variants.push({
      key: 'template_opening',
      source: 'template',
      content: templateFallback.opening,
    });
  }

  return variants;
}

/**
 * Record token usage for cost monitoring
 */
function recordTokenUsage(
  db: any,
  tenantId: string,
  usage: {
    model: string;
    tokensUsed: number;
    costEstimate: number;
    source: string;
    success: boolean;
    errorReason?: string;
  }
): void {
  try {
    // Insert into optimization_stats for monitoring
    const statId = `token-usage-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    db.prepare(
      `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value, recorded_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
      statId,
      tenantId,
      'cost',
      `${usage.source}_tokens_${usage.success ? 'success' : 'failed'}`,
      usage.tokensUsed
    );

    // Track cost
    db.prepare(
      `INSERT INTO optimization_stats (id, tenant_id, stat_type, metric_name, metric_value, recorded_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
      `cost-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      tenantId,
      'cost',
      `model_api_cost_usd`,
      usage.costEstimate
    );
  } catch (err) {
    console.warn('Failed to record token usage:', err);
    // Non-blocking - don't fail if monitoring fails
  }
}

/**
 * Generate scripts with AI enabled (uses environment config)
 * Convenience function for service layer
 */
export async function generateScriptsWithAIFromEnv(
  db: any,
  context: AIScriptGenerationContext,
  templateFallback: { opening: string; variants: string[] }
): Promise<AIScriptVariant[]> {
  if (!isEnvLlmConfigured()) {
    return [
      {
        key: 'template_opening',
        source: 'template',
        content: templateFallback.opening,
      },
    ];
  }

  return generateScriptVariantsWithAIFromEnv(db, context, templateFallback);
}
