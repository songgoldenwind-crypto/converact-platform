import { type DeepseekProvider } from '../integrations/deepseek-provider.js';
import {
  chatCompletionsWithFallback,
  isEnvLlmConfigured
} from '../integrations/llm-env-client.js';
import type {
  GenerateVoiceAgentSpecInput,
  VoiceAgentSpecCompliance,
  VoiceAgentSpecLanguage,
  VoiceAgentSpecRuntime
} from './types.js';

const ALLOWED_TOOLS = new Set([
  'check_intent',
  'transfer_human',
  'schedule_callback',
  'send_material'
]);

export interface GeneratedVoiceAgentSpecPayload {
  goal: string;
  language: VoiceAgentSpecLanguage;
  tools: string[];
  compliance: VoiceAgentSpecCompliance;
  runtime: VoiceAgentSpecRuntime;
  nodes: [];
}

export function parseJsonFromLlm(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  return JSON.parse(candidate);
}

export function validateGeneratedVoiceAgentPayload(raw: unknown): GeneratedVoiceAgentSpecPayload {
  const data = raw as Record<string, unknown>;
  const runtime = (data.runtime || {}) as Record<string, unknown>;
  const systemPrompt = String(runtime.system_prompt || '').trim();
  const greeting = String(runtime.greeting || '').trim();
  if (!systemPrompt || systemPrompt.length < 30) {
    throw new Error('runtime.system_prompt is too short');
  }
  if (!greeting || greeting.length < 8) {
    throw new Error('runtime.greeting is too short');
  }

  const tools = Array.isArray(data.tools)
    ? data.tools.map(String).filter((tool) => ALLOWED_TOOLS.has(tool))
    : [];
  if (!tools.length) {
    throw new Error('at least one valid tool is required');
  }

  const language = String(data.language || 'zh') as VoiceAgentSpecLanguage;
  if (!['zh', 'en', 'ja'].includes(language)) {
    throw new Error('invalid language');
  }

  const compliance = (data.compliance || {}) as VoiceAgentSpecCompliance;
  return {
    goal: String(data.goal || '').trim(),
    language,
    tools,
    compliance: {
      ai_disclosure: String(compliance.ai_disclosure || '本次为 AI 智能外呼服务'),
      forbidden_topics: Array.isArray(compliance.forbidden_topics)
        ? compliance.forbidden_topics.map(String)
        : []
    },
    runtime: {
      system_prompt: systemPrompt,
      greeting,
      transfer_message: String(runtime.transfer_message || '好的，正在为您转接人工客服，请稍候。'),
      end_message: String(runtime.end_message || '感谢您的时间，再见。')
    },
    nodes: []
  };
}

function buildGeneratorSystemPrompt(language: VoiceAgentSpecLanguage): string {
  const langLabel = language === 'zh' ? '简体中文' : language === 'ja' ? '日语' : '英语';
  return `你是呼叫中心 Voice Agent 配置生成器。根据用户提供的业务描述，输出一份 VoiceAgentSpec JSON（仅 JSON，无 markdown 说明）。

语言：${langLabel}
可用 tools（只能从下列选择）：check_intent, transfer_human, schedule_callback, send_material

JSON 结构：
{
  "goal": "一句话业务目标",
  "language": "${language}",
  "tools": ["check_intent", "transfer_human", "schedule_callback"],
  "compliance": {
    "ai_disclosure": "AI外呼合规披露语",
    "forbidden_topics": ["禁止话题"]
  },
  "runtime": {
    "system_prompt": "Agent 行为指令，含何时调用各 tool",
    "greeting": "电话开场白，需包含 AI 披露",
    "transfer_message": "转人工时播报",
    "end_message": "结束语"
  },
  "nodes": []
}

要求：
1. system_prompt 清晰、可执行，单次回复不超过 3 句话
2. greeting 自然口语化，适合电话外呼
3. 外呼场景需合规披露 AI 身份
4. 只输出 JSON`;
}

function buildGeneratorUserPrompt(input: GenerateVoiceAgentSpecInput): string {
  const lines = [
    `业务目标：${input.goal}`,
    input.industry ? `行业：${input.industry}` : null,
    input.brand_name ? `品牌/公司：${input.brand_name}` : null,
    input.tone ? `语气：${input.tone}` : null,
    input.faq ? `FAQ/产品要点：\n${input.faq}` : null,
    input.extra_instructions ? `补充要求：\n${input.extra_instructions}` : null
  ].filter(Boolean);
  return lines.join('\n');
}

export function generateFallbackVoiceAgentSpec(
  input: GenerateVoiceAgentSpecInput
): GeneratedVoiceAgentSpecPayload {
  const language = input.language || 'zh';
  const industry = input.industry || '通用';
  const brand = input.brand_name || '我们';
  const goal = input.goal.trim();
  const disclosure = '本次为 AI 智能外呼服务';

  if (language === 'zh') {
    return validateGeneratedVoiceAgentPayload({
      goal,
      language: 'zh',
      tools: ['check_intent', 'transfer_human', 'schedule_callback', 'send_material'],
      compliance: {
        ai_disclosure: disclosure,
        forbidden_topics: ['政治', '宗教']
      },
      runtime: {
        system_prompt: `你是${brand}的${industry}行业外呼 AI 客服。目标：${goal}。

规则：
1. 使用简洁普通话，每次回复不超过 3 句
2. 先确认客户是否方便接听，再介绍来意
3. 客户表示兴趣时调用 check_intent
4. 意向高或客户要求人工时调用 transfer_human
5. 客户忙碌时调用 schedule_callback
6. 需要发资料时调用 send_material
7. 通话开始须说明${disclosure}`,
        greeting: `您好，我是${brand}的智能客服助手。${disclosure}。请问您现在方便接听吗？我想和您简要介绍一下：${goal}。`,
        transfer_message: '好的，正在为您转接人工客服，请稍候。',
        end_message: '感谢您的时间，祝您生活愉快，再见。'
      },
      nodes: []
    });
  }

  return validateGeneratedVoiceAgentPayload({
    goal,
    language,
    tools: ['check_intent', 'transfer_human', 'schedule_callback'],
    compliance: { ai_disclosure: 'This is an AI outbound call.', forbidden_topics: [] },
    runtime: {
      system_prompt: `You are a voice AI agent for ${brand} (${industry}). Goal: ${goal}. Keep replies under 3 sentences. Use check_intent when interest is shown; transfer_human when requested.`,
      greeting: `Hello, this is ${brand}'s AI assistant. This is an AI outbound call. Do you have a moment to talk about ${goal}?`,
      transfer_message: 'Connecting you to a human agent, please hold.',
      end_message: 'Thank you for your time. Goodbye.'
    },
    nodes: []
  });
}

async function generateWithLlm(input: GenerateVoiceAgentSpecInput): Promise<GeneratedVoiceAgentSpecPayload> {
  const language = input.language || 'zh';
  const result = await chatCompletionsWithFallback({
    messages: [
      { role: 'system', content: buildGeneratorSystemPrompt(language) },
      { role: 'user', content: buildGeneratorUserPrompt(input) }
    ],
    temperature: 0.4,
    max_tokens: 2000
  });
  const parsed = parseJsonFromLlm(result.text);
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const payload = validateGeneratedVoiceAgentPayload({
    ...record,
    goal: record.goal || input.goal,
    language: record.language || language
  });
  if (!payload.goal) payload.goal = input.goal;
  return payload;
}

async function generateWithLlmProvider(
  input: GenerateVoiceAgentSpecInput,
  provider: DeepseekProvider
): Promise<GeneratedVoiceAgentSpecPayload> {
  const language = input.language || 'zh';
  const response = await provider.complete({
    messages: [
      { role: 'system', content: buildGeneratorSystemPrompt(language) },
      { role: 'user', content: buildGeneratorUserPrompt(input) }
    ],
    temperature: 0.4,
    max_tokens: 2000
  });
  const text = provider.extractText(response);
  const parsed = parseJsonFromLlm(text);
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const payload = validateGeneratedVoiceAgentPayload({
    ...record,
    goal: record.goal || input.goal,
    language: record.language || language
  });
  if (!payload.goal) payload.goal = input.goal;
  return payload;
}

export async function generateVoiceAgentSpec(
  input: GenerateVoiceAgentSpecInput,
  options: { provider?: DeepseekProvider | null } = {}
): Promise<{ payload: GeneratedVoiceAgentSpecPayload; source: 'llm' | 'template' }> {
  if (!input.tenant_id || !input.goal?.trim()) {
    throw Object.assign(new Error('tenant_id and goal are required'), { status: 400 });
  }

  const useProvider = options.provider !== undefined ? options.provider : null;
  const useEnvLlm = useProvider === null && isEnvLlmConfigured();

  if (useProvider) {
    try {
      const payload = await generateWithLlmProvider(input, useProvider);
      return { payload, source: 'llm' };
    } catch (error) {
      console.warn('[voice-agent-generator] LLM failed, using template fallback:', error);
    }
  } else if (useEnvLlm) {
    try {
      const payload = await generateWithLlm(input);
      return { payload, source: 'llm' };
    } catch (error) {
      console.warn('[voice-agent-generator] LLM failed, using template fallback:', error);
    }
  }

  return {
    payload: generateFallbackVoiceAgentSpec(input),
    source: 'template'
  };
}
