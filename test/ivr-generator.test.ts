import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { FEW_SHOT_M1 } from '../src/agent-runtime/ivr/ivr-generator-seeds.js';
import {
  generateIvrFromCsv,
  generateIvrFromText,
} from '../src/agent-runtime/ivr/ivr-generator.js';

const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(saved)) delete saved[k];
});

function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function mockLlmResponse(content: string) {
  return mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

test('M1-shaped LLM output passes publish gate after auto-complete', async () => {
  setEnv('LLM_API_KEY', 'test-key');
  setEnv('LLM_BASE_URL', 'http://primary/v1');
  setEnv('LLM_MODEL', 'Qwen3.6-27B');
  setEnv('DEEPSEEK_API_KEY', undefined);

  const fetchMock = mockLlmResponse(FEW_SHOT_M1);
  try {
    const result = await generateIvrFromText('两段欢迎语，按1转销售队列');
    assert.equal(result.publishReady, true);
    assert.equal(result.llmTier, 'primary');
    assert.equal(result.model, 'Qwen3.6-27B');
    assert.ok(result.warnings.some((w) => w.includes('auto-complete')));
    assert.ok(result.graph.nodes.some((n) => n.id === 'menu1_timeout'));
    const playContents = result.graph.nodes.find((n) => n.type === 'play')?.data.contents;
    assert.equal(Array.isArray(playContents) ? playContents.length : 0, 2);
  } finally {
    fetchMock.mock.restore();
  }
});

test('both LLMs fail — rejects without template fallback', async () => {
  setEnv('LLM_API_KEY', 'test-key');
  setEnv('LLM_BASE_URL', 'http://primary/v1');
  setEnv('DEEPSEEK_API_KEY', 'sk-fallback');
  setEnv('DEEPSEEK_API_BASE', 'http://fallback/v1');

  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response('unavailable', { status: 503 })
  );
  try {
    await assert.rejects(
      () => generateIvrFromText('任意描述'),
      /503/
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test('invalid graph from LLM returns 422 — no silent template', async () => {
  setEnv('LLM_API_KEY', 'test-key');
  setEnv('LLM_BASE_URL', 'http://primary/v1');

  const invalidGraph = JSON.stringify({
    version: 1,
    entryNodeId: 'start',
    variables: [],
    nodes: [
      { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
      {
        id: 'menu1',
        type: 'menu',
        name: '主菜单',
        position: { x: 200, y: 0 },
        data: {
          prompt: [{ playType: 'tts', text: '按1或2' }],
          options: [
            { digit: '1', label: 'A', routeType: 'node', routeTarget: 't1' },
            { digit: '2', label: 'B', routeType: 'node', routeTarget: 't2' },
          ],
          timeoutSec: 10,
          maxRetries: 1,
        },
      },
      {
        id: 't1',
        type: 'transfer',
        name: 'A',
        position: { x: 400, y: 0 },
        data: { targetType: 'queue', targetValue: 'a' },
      },
    ],
    edges: [
      { id: 'e0', source: 'start', target: 'menu1', sourceHandle: 'out' },
      { id: 'e1', source: 'menu1', target: 't1', sourceHandle: 'digit_1' },
    ],
  });

  const fetchMock = mockLlmResponse(invalidGraph);
  try {
    await assert.rejects(
      async () => {
        try {
          await generateIvrFromText('坏图');
        } catch (err) {
          assert.equal((err as Error & { statusCode?: number }).statusCode, 422);
          assert.match((err as Error).message, /not publish-ready/);
          throw err;
        }
      },
      /not publish-ready/
    );
  } finally {
    fetchMock.mock.restore();
  }
});

test('empty CSV throws 400', async () => {
  await assert.rejects(
    async () => {
      try {
        await generateIvrFromCsv('digit,description\n');
      } catch (err) {
        assert.equal((err as Error & { statusCode?: number }).statusCode, 400);
        throw err;
      }
    },
    /No valid rows in CSV/
  );
});

test('CSV path uses same publish gate as text', async () => {
  setEnv('LLM_API_KEY', 'test-key');
  setEnv('LLM_BASE_URL', 'http://primary/v1');

  const fetchMock = mockLlmResponse(FEW_SHOT_M1);
  try {
    const result = await generateIvrFromCsv('digit,description,target\n1,销售,sales');
    assert.equal(result.publishReady, true);
    assert.equal(result.llmTier, 'primary');
  } finally {
    fetchMock.mock.restore();
  }
});
