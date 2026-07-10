/**
 * Deepseek v4 API Provider
 *
 * Supports OpenAI-compatible chat completions (DeepSeek and other models).
 * For env-based primary+fallback LLM stack, prefer completeViaEnvLlm().
 */

import { readFallbackLlmConfig, readPrimaryLlmConfig } from './llm-config.js';
import { completeWithLlmFallback } from './llm-provider.js';

export interface DeepseekConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  extraBody?: Record<string, unknown>;
}

export interface DeepseekRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
}

export interface DeepseekResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class DeepseekProvider {
  apiKey: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  timeout: number;
  extraBody?: Record<string, unknown>;

  constructor(config: DeepseekConfig) {
    if (!config.apiKey) {
      throw new Error('Deepseek API key is required');
    }
    this.apiKey = config.apiKey;
    this.model = config.model || 'deepseek-chat';
    this.baseUrl = config.baseUrl || 'https://api.deepseek.com/beta';
    this.temperature = config.temperature ?? 0.7;
    this.maxTokens = config.maxTokens || 2000;
    this.timeout = config.timeout || 30000;
    this.extraBody = config.extraBody;
  }

  async complete(request: DeepseekRequest): Promise<DeepseekResponse> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    };

    const body = JSON.stringify({
      model: this.model,
      messages: request.messages,
      temperature: request.temperature ?? this.temperature,
      max_tokens: request.max_tokens ?? this.maxTokens,
      stream: false,
      ...(this.extraBody ?? {}),
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(
          `Deepseek API error: ${response.status} ${response.statusText} - ${errorData}`
        );
      }

      const data = (await response.json()) as DeepseekResponse;
      return data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Deepseek API timeout after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  extractText(response: DeepseekResponse): string {
    if (!response.choices || response.choices.length === 0) {
      throw new Error('No choices in Deepseek response');
    }
    return response.choices[0].message.content;
  }

  /**
   * Helper: Use Flash model (fast, cost-effective)
   * Good for: script variants, simple analysis
   */
  withFlash(): DeepseekProvider {
    return new DeepseekProvider({
      apiKey: this.apiKey,
      model: 'deepseek-chat',
      baseUrl: this.baseUrl,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      timeout: this.timeout,
      extraBody: this.extraBody,
    });
  }

  /**
   * Helper: Use Pro model (reasoning, complex analysis)
   * Good for: efficacy analysis, strategy decisions
   */
  withPro(): DeepseekProvider {
    return new DeepseekProvider({
      apiKey: this.apiKey,
      model: 'deepseek-reasoner',
      baseUrl: this.baseUrl,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      timeout: this.timeout,
      extraBody: this.extraBody,
    });
  }
}

/** @deprecated Prefer completeWithLlmFallback from llm-provider.js for new code. */
export async function completeViaEnvLlm(request: DeepseekRequest): Promise<DeepseekResponse> {
  const result = await completeWithLlmFallback(
    {
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
    },
    { primary: readPrimaryLlmConfig(), fallback: readFallbackLlmConfig() }
  );
  return {
    id: 'env-llm',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Create a Deepseek provider from environment (fallback config only).
 * Prefer completeViaEnvLlm() for production primary+fallback LLM stack.
 * Retained for tests and direct provider injection.
 */
export function createDeepseekFromEnv(): DeepseekProvider | null {
  if (process.env.DISABLE_AI_SCRIPT_GENERATION === 'true') {
    return null;
  }

  const fallback = readFallbackLlmConfig();
  if (fallback) {
    return new DeepseekProvider({
      apiKey: fallback.apiKey,
      model: fallback.model,
      baseUrl: fallback.baseUrl,
      maxTokens: fallback.maxTokens,
      timeout: fallback.timeoutMs,
      extraBody: fallback.extraBody,
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('No Deepseek API key found in env (DEEPSEEK_API_KEY or OPENAI_API_KEY)');
    return null;
  }

  return new DeepseekProvider({
    apiKey,
    model: process.env.DEEPSEEK_MODEL === 'pro' ? 'deepseek-reasoner' : 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com/beta',
    maxTokens: process.env.DEEPSEEK_MAX_TOKENS ? parseInt(process.env.DEEPSEEK_MAX_TOKENS) : 2000,
    timeout: process.env.DEEPSEEK_TIMEOUT_MS
      ? parseInt(process.env.DEEPSEEK_TIMEOUT_MS)
      : process.env.DEEPSEEK_TIMEOUT
        ? parseInt(process.env.DEEPSEEK_TIMEOUT)
        : 30000,
  });
}
