import type { LlmEndpointConfig } from './llm-config.js';

export type LlmTier = 'primary' | 'fallback';

export interface LlmCompletionResult {
  text: string;
  llmTier: LlmTier;
  model: string;
  warnings: string[];
}

export interface LlmCompletionRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
  extraBody?: Record<string, unknown>;
}

/** Map thrown LLM/generator errors to an HTTP status (statusCode or status from completeOnce). */
export function httpStatusFromError(err: unknown, defaultStatus = 502): number {
  if (err && typeof err === 'object') {
    const e = err as { statusCode?: number; status?: number };
    if (typeof e.statusCode === 'number') return e.statusCode;
    if (typeof e.status === 'number') return e.status;
  }
  return defaultStatus;
}

export function isLlmTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: number }).status;
  // 401/403 = 配置错误，不 silent fallback
  if (typeof status === 'number') return status >= 500 || status === 429;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('abort')
  );
}

export function extractAssistantText(data: {
  choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
}): string {
  const message = data.choices?.[0]?.message;
  const content = message?.content?.trim();
  if (content) return content;
  const reasoning = message?.reasoning?.trim();
  if (reasoning) {
    console.warn('[llm] assistant content empty but reasoning present — treat as bad response');
  }
  throw new Error('empty LLM assistant content');
}

export async function completeOnce(
  config: LlmEndpointConfig,
  request: LlmCompletionRequest
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const body = JSON.stringify({
      model: config.model,
      messages: request.messages,
      max_tokens: request.max_tokens ?? config.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      stream: false,
      ...config.extraBody,
      ...request.extraBody,
    });

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(
        `LLM API error: ${response.status} ${response.statusText} - ${errorText}`
      ) as Error & { status?: number; statusCode?: number };
      err.status = response.status;
      err.statusCode = response.status;
      throw err;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning?: string | null } }>;
    };
    return extractAssistantText(data);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`LLM API timeout after ${config.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function completeWithLlmFallback(
  request: LlmCompletionRequest,
  configs: { primary: LlmEndpointConfig | null; fallback: LlmEndpointConfig | null }
): Promise<LlmCompletionResult> {
  if (process.env.DISABLE_AI_SCRIPT_GENERATION === 'true') {
    throw new Error('AI generation disabled (DISABLE_AI_SCRIPT_GENERATION=true)');
  }
  const warnings: string[] = [];
  if (configs.primary) {
    try {
      const text = await completeOnce(configs.primary, request);
      return { text, llmTier: 'primary', model: configs.primary.model, warnings };
    } catch (err) {
      if (!isLlmTransportError(err) || !configs.fallback) throw err;
      warnings.push(
        `Primary LLM (${configs.primary.model}) unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
      console.warn('[llm] primary failed, falling back:', warnings[0]);
    }
  }
  if (!configs.fallback) {
    throw new Error('No LLM available: set LLM_API_KEY+LLM_BASE_URL and/or DEEPSEEK_API_KEY');
  }
  const text = await completeOnce(configs.fallback, request);
  return { text, llmTier: 'fallback', model: configs.fallback.model, warnings };
}
