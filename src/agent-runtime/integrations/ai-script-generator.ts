/**
 * AI-powered script generation using Deepseek v4
 * Replaces hard-coded buildLeadScriptVariants with intelligent AI generation
 */

import { chatCompletionsWithFallback, isEnvLlmConfigured } from './llm-env-client.js';

export interface AIScriptContext {
  tenant_id: string;
  run_id: string;
  industry?: string;
  goal?: string;
  location?: string;
  target_customer_profile?: string;
  lead_id?: string;
  lead_name?: string;
  lead_contact_info?: string;
  lead_score_reason?: string;
  prospect_message?: string;
  memory_lines?: string[];
  p21_efficacy?: Array<{
    variant_key: string;
    conversion_rate: number;
    total_uses: number;
    sample_size_note: string;
  }>;
  script_angle_refresh?: {
    avoid_generic_openers?: boolean;
    emphasize_source_evidence?: boolean;
    source?: string;
  };
  language?: string;
}

export interface AIScriptResult {
  opening: string;
  discovery_question: string;
  value_prop: string;
  objection_handler: string;
  next_step: string;
  variants: Array<{
    variant_key: string;
    opening: string;
    discovery_question: string;
    value_prop: string;
  }>;
  metadata: {
    model_used: string;
    tokens_used?: number;
    generated_at: string;
    reason?: string;
  };
}

/**
 * Generate script and variants using Deepseek AI
 * Falls back to hard-coded template if AI is unavailable
 */
export async function generateScriptWithAI(
  context: AIScriptContext,
  fallbackTemplate?: any
): Promise<AIScriptResult> {
  if (!isEnvLlmConfigured()) {
    return generateScriptFromTemplate(context, fallbackTemplate);
  }

  try {
    return await generateScriptWithEnvLlm(context);
  } catch (error) {
    console.warn(`AI script generation failed: ${error instanceof Error ? error.message : String(error)}. Using template fallback.`);
    return generateScriptFromTemplate(context, fallbackTemplate);
  }
}

async function generateScriptWithEnvLlm(context: AIScriptContext): Promise<AIScriptResult> {
  const systemPrompt = buildSystemPrompt(context);
  const userPrompt = buildUserPrompt(context);

  const result = await chatCompletionsWithFallback({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1500
  });

  const parsed = parseScriptResponse(result.text, context);

  return {
    ...parsed,
    metadata: {
      model_used: result.model,
      generated_at: new Date().toISOString()
    }
  };
}

function buildSystemPrompt(context: AIScriptContext): string {
  return `You are an expert sales script generator for one-person companies and small teams. Your task is to create compelling outreach scripts that convert leads into appointments or next-step conversations.

Your scripts should:
1. Be direct and confident, not salesy
2. Focus on the customer's problem first, not your solution
3. Include a clear next step
4. Respect the customer's time (keep under 30 seconds for initial pitch)
5. Use the customer's language and context
6. Include variations for different personality types or objection handlers

Output format: Return a JSON object with this exact structure:
{
  "opening": "The hook that gets attention",
  "discovery_question": "A question to understand their specific situation",
  "value_prop": "How you solve their core problem",
  "objection_handler": "Response to 'I'm not interested' or 'Let me think about it'",
  "next_step": "Clear call to action",
  "variants": [
    {"variant_key": "aggressive", "opening": "...", "discovery_question": "...", "value_prop": "...", },
    {"variant_key": "consultative", "opening": "...", "discovery_question": "...", "value_prop": "..."}
  ]
}

Language: ${context.language || 'Chinese (Mandarin)'}.
Always maintain professional but approachable tone.`;
}

function buildUserPrompt(context: AIScriptContext): string {
  const lines: string[] = [];

  lines.push('Generate a sales script for this situation:\n');

  if (context.industry) lines.push(`Industry/Service: ${context.industry}`);
  if (context.goal) lines.push(`Campaign Goal: ${context.goal}`);
  if (context.target_customer_profile) lines.push(`Target Customer: ${context.target_customer_profile}`);
  if (context.location) lines.push(`Location/Region: ${context.location} (必须在脚本中提及)`);

  if (context.lead_name || context.lead_contact_info) {
    lines.push(`\nLead Information:`);
    if (context.lead_name) lines.push(`  Name: ${context.lead_name}`);
    if (context.lead_contact_info) lines.push(`  Contact: ${context.lead_contact_info}`);
    if (context.lead_score_reason) lines.push(`  Why we're calling: ${context.lead_score_reason}`);
    if (context.prospect_message) lines.push(`  Prospect's own words: "${context.prospect_message}"`);
  }

  if (context.memory_lines && context.memory_lines.length > 0) {
    lines.push(`\nContext from memory:`);
    context.memory_lines.forEach((line) => lines.push(`  • ${line}`));
  }

  if (context.script_angle_refresh) {
    const guidance: string[] = [];
    if (context.script_angle_refresh.avoid_generic_openers) guidance.push('avoid generic openers');
    if (context.script_angle_refresh.emphasize_source_evidence) guidance.push('emphasize source evidence');
    if (guidance.length) {
      lines.push(`\nFeedback-based script guidance: ${guidance.join(', ')}.`);
    }
  }

  if (context.p21_efficacy && context.p21_efficacy.length > 0) {
    lines.push(`\nPast performance data (what worked):`);
    context.p21_efficacy
      .sort((a, b) => (b.conversion_rate || 0) - (a.conversion_rate || 0))
      .slice(0, 3)
      .forEach((item) => {
        lines.push(`  • ${item.variant_key}: ${Math.round((item.conversion_rate || 0) * 100)}% conversion (${item.total_uses} attempts)`);
      });
    lines.push('Incorporate insights from high-performing variants into the script.\n');
  }

  lines.push(`
IMPORTANT: Your script MUST:
1. Include the specific location/region (if provided): ${context.location}
2. Reference specific industry keywords or pain points
3. Be natural and conversational, not salesy
4. Include specific product/service mentions where possible

Create 2-3 script variants to test:
1. "aggressive": Direct, benefit-focused opening
2. "consultative": Question-first, discovery-focused
${context.p21_efficacy && context.p21_efficacy.length > 0 ? '3. "optimized": Based on historical best performer' : ''}

Return valid JSON only, no additional text.`);

  return lines.join('\n');
}

function parseScriptResponse(text: string, context: AIScriptContext): AIScriptResult {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      opening: parsed.opening || '',
      discovery_question: parsed.discovery_question || '',
      value_prop: parsed.value_prop || '',
      objection_handler: parsed.objection_handler || '',
      next_step: parsed.next_step || '',
      variants: Array.isArray(parsed.variants) ? parsed.variants : [],
      metadata: {
        model_used: 'deepseek-ai',
        generated_at: new Date().toISOString(),
        reason: 'Generated by AI from context'
      }
    };
  } catch (error) {
    console.warn(`Failed to parse AI response: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error('Failed to parse script from AI response');
  }
}

/**
 * Fallback: Generate script from template when AI is unavailable
 */
function generateScriptFromTemplate(context: AIScriptContext, template?: any): AIScriptResult {
  const t = template || {
    industry: context.industry || '目标行业',
    discovery_questions: ['您现在最想解决的问题是什么？'],
    value_props: ['我们可以帮您做一个轻量诊断。'],
    objections: ['如果客户说以后再说，先确认合适回访时间。']
  };

  return {
    opening: `您好，我是做${t.industry || '相关服务'}的，看到您可能在${context.location || '当前区域'}有相关需求，想用 30 秒确认是否值得继续聊。`,
    discovery_question: t.discovery_questions?.[0] || '您现在最想解决什么问题？',
    value_prop: t.value_props?.[0] || '我们可以帮您做一个轻量诊断。',
    objection_handler: t.objections?.[0] || '如果客户说以后再说，先确认回访时间。',
    next_step: '如果合适，我帮您约一个 15 分钟沟通；如果现在不方便，我按您方便的时间回拨。',
    variants: [
      {
        variant_key: 'direct',
        opening: `您好，我是做${t.industry}的，${context.lead_score_reason || '看到您可能需要相关服务'}。`,
        discovery_question: t.discovery_questions?.[0] || '您现在最想解决什么？',
        value_prop: t.value_props?.[0] || '我们可以先给您一个初步判断。'
      },
      {
        variant_key: 'consultative',
        opening: `您好，请问您现在主要在处理什么${t.industry || '相关'}的事情？`,
        discovery_question: t.discovery_questions?.[0] || '能简单说一下现在的情况吗？',
        value_prop: t.value_props?.[0] || '我或许能帮上忙。'
      }
    ],
    metadata: {
      model_used: 'template-fallback',
      generated_at: new Date().toISOString(),
      reason: 'No AI provider available, using hard-coded template'
    }
  };
}
