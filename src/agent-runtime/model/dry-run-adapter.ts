import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export interface DryRunModelAdapterOptions {
  provider?: string;
  model?: string;
}

export class DryRunModelAdapter {
  provider: string;
  model: string;

  constructor({ provider = 'dry_run', model = 'dry-run-v1' }: DryRunModelAdapterOptions = {}) {
    this.provider = provider;
    this.model = model;
  }

  async complete(request: JsonRecord): Promise<JsonRecord> {
    const promptText = normalizePrompt(request);
    const content = `[dry-run:${this.model}] ${promptText.slice(0, 160)}`;
    return {
      provider: this.provider,
      model: request.model || this.model,
      content,
      structured_output: request.response_schema ? { dry_run: true, content } : null,
      usage: {
        input_tokens: estimateTokens(promptText),
        output_tokens: estimateTokens(content),
        total_tokens: estimateTokens(promptText) + estimateTokens(content)
      },
      cost: {
        amount: 0,
        currency: 'USD'
      }
    };
  }
}

function normalizePrompt(request: JsonRecord): string {
  if (request.prompt) return String(request.prompt);
  if (Array.isArray(request.messages)) return request.messages.map((message) => `${message.role}: ${message.content}`).join('\n');
  return JSON.stringify(request.input || {});
}

function estimateTokens(text: unknown): number {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}
