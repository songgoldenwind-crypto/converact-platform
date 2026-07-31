export interface LlmEndpointConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  extraBody?: Record<string, unknown>;
}

export function parseLlmExtraBody(): Record<string, unknown> {
  const raw = process.env.LLM_EXTRA_BODY;
  if (!raw) return { chat_template_kwargs: { enable_thinking: false } };
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { chat_template_kwargs: { enable_thinking: false } };
  }
}

/** Primary = self-hosted 27B. Requires BOTH LLM_API_KEY and LLM_BASE_URL. */
export function readPrimaryLlmConfig(): LlmEndpointConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL;
  if (!apiKey || !baseUrl) return null;
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/$/, ''),
    model: process.env.LLM_MODEL || 'Qwen3.6-27B',
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 8192),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000),
    extraBody: parseLlmExtraBody(),
  };
}

/** Fallback = DeepSeek. Requires DEEPSEEK_API_KEY. */
export function readFallbackLlmConfig(): LlmEndpointConfig | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    model:
      process.env.DEEPSEEK_MODEL === 'pro'
        ? 'deepseek-reasoner'
        : process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    maxTokens: Number(process.env.DEEPSEEK_MAX_TOKENS || 8192),
    timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000),
    extraBody: parseLlmExtraBody(),
  };
}
