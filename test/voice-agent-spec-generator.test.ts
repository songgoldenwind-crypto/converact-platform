import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateFallbackVoiceAgentSpec,
  parseJsonFromLlm,
  validateGeneratedVoiceAgentPayload
} from '../src/agent-runtime/call-center/voice-agent-spec-generator.js';

test('parseJsonFromLlm extracts fenced JSON', () => {
  const raw = parseJsonFromLlm('```json\n{"goal":"test","language":"zh","tools":["check_intent"],"compliance":{},"runtime":{"system_prompt":"' + 'x'.repeat(40) + '","greeting":"你好，这是测试开场白"},"nodes":[]}\n```');
  assert.equal((raw as any).goal, 'test');
});

test('validateGeneratedVoiceAgentPayload rejects short greeting', () => {
  assert.throws(() =>
    validateGeneratedVoiceAgentPayload({
      goal: 'x',
      language: 'zh',
      tools: ['check_intent'],
      compliance: {},
      runtime: { system_prompt: 'a'.repeat(40), greeting: 'hi' },
      nodes: []
    })
  );
});

test('generateFallbackVoiceAgentSpec produces Chinese outbound spec', () => {
  const payload = generateFallbackVoiceAgentSpec({
    tenant_id: 't1',
    goal: '预约房产内访',
    industry: '房产',
    brand_name: '安居客',
    language: 'zh'
  });
  assert.equal(payload.language, 'zh');
  assert.ok(payload.runtime.greeting.includes('安居客'));
  assert.ok(payload.tools.includes('transfer_human'));
  assert.ok(payload.compliance.ai_disclosure);
});
