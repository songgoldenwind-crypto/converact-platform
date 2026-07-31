import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { createServer } from '../src/http.js';
import { VoiceStore } from '../src/agent-runtime/voice/voice-store.js';
import { QmStore } from '../src/agent-runtime/call-center/qm/qm-store.js';
import { computeOverallScore } from '../src/agent-runtime/call-center/qm/qm-policy.js';
import { evaluateCallQuality } from '../src/agent-runtime/call-center/qm/qm-evaluator.js';
import { ConversationTurnStore } from '../src/agent-runtime/call-center/conversation-turn-store.js';
import { listenOnRandomPort } from './test-helpers.js';

import type { QmScores } from '../src/agent-runtime/call-center/qm/qm-policy.js';
import type { QmEvaluation } from '../src/agent-runtime/call-center/qm/qm-store.js';

const db = createDatabase(':memory:');
const voiceStore = new VoiceStore(db);
const turnStore = new ConversationTurnStore(db);
const qmStore = new QmStore(db);
const server = createServer(db);

let baseUrl = '';
let tenantId = '';
let sessionId = '';
const apiKey = 'dev-opc-key';

/** Auth headers for the API-key path (requireAuth needs authenticated: true). */
function authHeaders(): Record<string, string> {
  return { 'X-API-Key': apiKey, 'X-Tenant-Id': tenantId };
}

before(async () => {
  process.env.CONVERACT_API_KEY = apiKey;
  const tenant = createTenant(db, { name: 'QM Test' });
  tenantId = tenant.id;
  const session = voiceStore.createCallSession({
    tenant_id: tenantId,
    provider: 'rustpbx',
    direction: 'outbound',
    status: 'completed',
    phone: '+8613800138000'
  });
  sessionId = session.id;

  turnStore.appendTurn(sessionId, { role: 'ai', content: '您好，我是 AI 助手，请问有什么可以帮您？' });
  turnStore.appendTurn(sessionId, { role: 'customer', content: '我想了解你们的套餐' });
  turnStore.appendTurn(sessionId, { role: 'ai', content: '我们有基础版和专业版两个套餐，您更关注哪方面的功能？' });

  const port = await listenOnRandomPort(server);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('QmStore CRUD', () => {
  test('creates and retrieves evaluation', () => {
    const scores: QmScores = {
      politeness: 0.9,
      compliance: 0.8,
      problem_resolution: 0.7,
      upsell_effectiveness: 0.6,
      script_adherence: 0.85
    };

    const evaluation = qmStore.createEvaluation({
      tenant_id: tenantId,
      call_session_id: sessionId,
      scores,
      violations: ['未做AI披露'],
      summary: '整体表现良好',
      recommendation: '建议在开场白中加入AI披露',
      overall_score: 0.77
    });

    assert.ok(evaluation.id.startsWith('qmeval_'));
    assert.equal(evaluation.tenant_id, tenantId);
    assert.equal(evaluation.call_session_id, sessionId);
    assert.equal(evaluation.evaluator, 'llm');
    assert.deepEqual(evaluation.scores, scores);
    assert.deepEqual(evaluation.violations, ['未做AI披露']);

    const fetched = qmStore.getEvaluation(evaluation.id);
    assert.ok(fetched);
    assert.equal(fetched.id, evaluation.id);
    assert.deepEqual(fetched.scores, scores);

    const bySession = qmStore.getEvaluationBySession(sessionId);
    assert.ok(bySession);
    assert.equal(bySession.id, evaluation.id);
  });

  test('dashboard returns aggregate stats', () => {
    const secondSession = voiceStore.createCallSession({
      tenant_id: tenantId,
      provider: 'rustpbx',
      direction: 'inbound',
      status: 'completed',
      phone: '+8613900139000'
    });

    const thirdSession = voiceStore.createCallSession({
      tenant_id: tenantId,
      provider: 'rustpbx',
      direction: 'inbound',
      status: 'completed',
      phone: '+8613900139001'
    });

    qmStore.createEvaluation({
      tenant_id: tenantId,
      call_session_id: secondSession.id,
      scores: { politeness: 0.9, compliance: 0.9, problem_resolution: 0.9, upsell_effectiveness: 0.9, script_adherence: 0.9 },
      summary: '优秀',
      overall_score: 0.9
    });

    qmStore.createEvaluation({
      tenant_id: tenantId,
      call_session_id: thirdSession.id,
      scores: { politeness: 0.3, compliance: 0.2, problem_resolution: 0.4, upsell_effectiveness: 0.1, script_adherence: 0.2 },
      violations: ['未做AI披露', '承诺无法兑现的优惠'],
      summary: '表现较差',
      overall_score: 0.25
    });

    const dashboard = qmStore.getDashboard(tenantId);
    assert.equal(dashboard.total_evaluations, 3);
    assert.ok(dashboard.average_score > 0);
    assert.ok(dashboard.violation_count >= 2);
    assert.ok(dashboard.score_distribution.length > 0);
    assert.ok(dashboard.recent_low_scores.length >= 1);
  });
});

describe('computeOverallScore', () => {
  test('applies weights correctly', () => {
    const scores: QmScores = {
      politeness: 1.0,
      compliance: 1.0,
      problem_resolution: 1.0,
      upsell_effectiveness: 1.0,
      script_adherence: 1.0
    };
    const result = computeOverallScore(scores);
    assert.ok(Math.abs(result - 1.0) < 0.001);

    const zeros: QmScores = {
      politeness: 0,
      compliance: 0,
      problem_resolution: 0,
      upsell_effectiveness: 0,
      script_adherence: 0
    };
    assert.equal(computeOverallScore(zeros), 0);

    const custom: QmScores = {
      politeness: 0.8,
      compliance: 0.6,
      problem_resolution: 0.7,
      upsell_effectiveness: 0.5,
      script_adherence: 0.9
    };
    const customWeights = {
      politeness: 0.5,
      compliance: 0.1,
      problem_resolution: 0.1,
      upsell_effectiveness: 0.1,
      script_adherence: 0.2
    };
    const expected = 0.8 * 0.5 + 0.6 * 0.1 + 0.7 * 0.1 + 0.5 * 0.1 + 0.9 * 0.2;
    assert.ok(Math.abs(computeOverallScore(custom, customWeights) - expected) < 0.001);
  });
});

describe('evaluateCallQuality', () => {
  test('with mock LLM returns valid scores', async () => {
    const mockResponse = {
      scores: { politeness: 0.85, compliance: 0.9, problem_resolution: 0.7, upsell_effectiveness: 0.6, script_adherence: 0.8 },
      violations: ['未确认客户需求'],
      summary: '表现良好但需改进追售',
      recommendation: '建议在推荐方案前先确认客户需求'
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(mockResponse) } }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    try {
      const result = await evaluateCallQuality('测试通话内容', {
        deps: { apiKey: 'test-key', baseUrl: 'http://localhost:9999', model: 'test' }
      });

      assert.equal(result.scores.politeness, 0.85);
      assert.equal(result.scores.compliance, 0.9);
      assert.deepEqual(result.violations, ['未确认客户需求']);
      assert.equal(result.summary, '表现良好但需改进追售');
      assert.ok(result.overall_score > 0 && result.overall_score <= 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns fallback on LLM failure', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('Internal Error', { status: 500 });

    try {
      const result = await evaluateCallQuality('测试通话内容', {
        deps: { apiKey: 'test-key', baseUrl: 'http://localhost:9999', model: 'test' }
      });

      assert.equal(result.scores.politeness, 0.5);
      assert.equal(result.scores.compliance, 0.5);
      assert.ok(result.summary.includes('失败'));
      assert.equal(result.overall_score, 0.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('QM HTTP API', () => {
  test('POST /api/qm/evaluate creates evaluation from conversation turns', async () => {
    const evalSession = voiceStore.createCallSession({
      tenant_id: tenantId,
      provider: 'rustpbx',
      direction: 'outbound',
      status: 'completed',
      phone: '+8613800138001'
    });

    turnStore.appendTurn(evalSession.id, { role: 'ai', content: '您好，我是AI智能助手' });
    turnStore.appendTurn(evalSession.id, { role: 'customer', content: '你好' });

    const mockResponse = {
      scores: { politeness: 0.95, compliance: 0.9, problem_resolution: 0.8, upsell_effectiveness: 0.7, script_adherence: 0.85 },
      violations: [],
      summary: '表现优秀',
      recommendation: '继续保持'
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (urlStr.includes('deepseek') || urlStr.includes('localhost:9999')) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(mockResponse) } }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return originalFetch(input, init);
    };

    try {
      process.env.DEEPSEEK_API_KEY = 'test-key';
      process.env.DEEPSEEK_BASE_URL = 'http://localhost:9999';

      const response = await fetch(`${baseUrl}/api/qm/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ tenant_id: tenantId, call_session_id: evalSession.id })
      });

      const data = (await response.json()) as QmEvaluation;
      assert.equal(response.status, 201);
      assert.ok(data.id.startsWith('qmeval_'));
      assert.equal(data.call_session_id, evalSession.id);
      assert.equal(data.scores.politeness, 0.95);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.DEEPSEEK_BASE_URL;
    }
  });

  test('GET /api/qm/dashboard returns dashboard stats', async () => {
    const response = await fetch(`${baseUrl}/api/qm/dashboard`, { headers: authHeaders() });
    const data = (await response.json()) as { total_evaluations: number; overall_average: number };
    assert.equal(response.status, 200);
    assert.ok(data.total_evaluations >= 3);
    assert.ok(data.overall_average > 0);
  });

  test('GET /api/qm/evaluations lists evaluations', async () => {
    const response = await fetch(`${baseUrl}/api/qm/evaluations?limit=10`, { headers: authHeaders() });
    const data = (await response.json()) as QmEvaluation[];
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(data));
    assert.ok(data.length >= 1);
  });
});
