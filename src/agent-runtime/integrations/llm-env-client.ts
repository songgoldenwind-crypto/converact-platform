import { completeWithLlmFallback, type LlmCompletionResult } from './llm-provider.js';
import { readPrimaryLlmConfig, readFallbackLlmConfig } from './llm-config.js';

export type LlmChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function isEnvLlmConfigured(): boolean {
  if (process.env.DISABLE_AI_SCRIPT_GENERATION === 'true') return false;
  return readPrimaryLlmConfig() !== null || readFallbackLlmConfig() !== null;
}

export async function chatCompletionsWithFallback(opts: {
  messages: LlmChatMessage[];
  temperature?: number;
  max_tokens?: number;
  extraBody?: Record<string, unknown>;
}): Promise<LlmCompletionResult> {
  const primary = readPrimaryLlmConfig();
  const fallback = readFallbackLlmConfig();
  return completeWithLlmFallback(
    {
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.max_tokens,
      extraBody: opts.extraBody,
    },
    { primary, fallback }
  );
}
