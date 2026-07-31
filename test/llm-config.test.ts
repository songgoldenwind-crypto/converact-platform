import { resolveConveractEnv } from '../src/config/converact-env.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readPrimaryLlmConfig, readFallbackLlmConfig } from '../src/agent-runtime/integrations/llm-config.js';

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = resolveConveractEnv(process.env, key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('primary only reads LLM_API_KEY — not DEEPSEEK_API_KEY', () => {
  setEnv('LLM_API_KEY', 'Qwen3.6-27B');
  setEnv('LLM_BASE_URL', 'http://218.75.43.210:9997/v1');
  setEnv('LLM_MODEL', 'Qwen3.6-27B');
  setEnv('DEEPSEEK_API_KEY', 'sk-should-not-be-primary');
  const cfg = readPrimaryLlmConfig();
  assert.equal(cfg?.apiKey, 'Qwen3.6-27B');
});

test('primary null when LLM_API_KEY missing even if DEEPSEEK set', () => {
  setEnv('LLM_API_KEY', undefined);
  setEnv('DEEPSEEK_API_KEY', 'sk-ds');
  assert.equal(readPrimaryLlmConfig(), null);
});

test('fallback reads DEEPSEEK_API_KEY only', () => {
  setEnv('DEEPSEEK_API_KEY', 'sk-test');
  setEnv('DEEPSEEK_API_BASE', 'https://api.deepseek.com/v1');
  const cfg = readFallbackLlmConfig();
  assert.equal(cfg?.model, 'deepseek-chat');
  assert.equal(cfg?.apiKey, 'sk-test');
});

test('primary null when LLM_BASE_URL missing', () => {
  setEnv('LLM_API_KEY', 'Qwen3.6-27B');
  setEnv('LLM_BASE_URL', undefined);
  assert.equal(readPrimaryLlmConfig(), null);
});
