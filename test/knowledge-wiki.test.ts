import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('knowledge agent ingests immutable sources and maintains wiki index', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Knowledge Wiki 公司' });
  const harness = createHarness(db);

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'knowledge_agent.ingest_source.v1',
    goal: '把产品定位资料入知识库',
    title: 'Converact 产品定位',
    content: 'Converact 是一人公司的增长操作系统。核心包括获客、CRM、知识库和自动化。',
    source_type: 'note',
    category: 'product',
    tags: ['converact', 'positioning'],
    summary: 'Converact 是一人公司的增长操作系统。'
  });

  assert.equal(result.agent_run.status, 'completed');
  assert.equal(result.artifacts[0].type, 'knowledge_ingest_result');
  assert.equal(result.step_outputs.ingest_source.page.category, 'product');
  assert.match(result.step_outputs.build_index.content_markdown, /Converact 产品定位/);

  const query = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'query'
    },
    'wiki.query',
    {
      tenant_id: tenant.id,
      query: '知识库 增长操作系统'
    }
  );

  assert.equal(query.output.results[0].title, 'Converact 产品定位');
});

test('wiki lint reports missing source pages without mutating content', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Wiki Lint 公司' });
  const harness = createHarness(db);

  const page = harness.wikiStore.upsertPage({
    tenant_id: tenant.id,
    title: '未绑定来源的 SOP',
    category: 'sop',
    summary: '这个页面暂时没有来源。',
    content_markdown: '# 未绑定来源的 SOP\n\n待补来源。'
  });
  const lint = harness.wikiStore.lint({ tenant_id: tenant.id });

  assert.equal(page.source_ids.length, 0);
  assert.equal(lint.missing_source_pages[0].slug, '未绑定来源的-sop');
  assert.equal(harness.wikiStore.getPage(tenant.id, page.id).version, 1);
});

test('wiki store keeps tenant query isolation', () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Wiki Tenant A' });
  const otherTenant = createTenant(db, { name: 'Wiki Tenant B' });
  const harness = createHarness(db);

  harness.wikiStore.upsertPage({
    tenant_id: otherTenant.id,
    title: 'Other Tenant Secret',
    summary: '不能被另一个租户查到。',
    content_markdown: '# Other Tenant Secret\n\nprivate'
  });

  const query = harness.wikiStore.query({
    tenant_id: tenant.id,
    query: 'Secret'
  });

  assert.deepEqual(query.results, []);
});

test('wiki model synthesis creates draft artifacts without mutating active pages', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Wiki Synthesis 公司' });
  const harness = createHarness(db);
  const source = harness.wikiStore.ingestSource({
    tenant_id: tenant.id,
    title: '销售 SOP 原始资料',
    content: '一人公司销售 SOP：先识别高意向线索，再创建跟进任务，外呼必须审批。',
    source_type: 'note'
  });
  const page = harness.wikiStore.upsertPage({
    tenant_id: tenant.id,
    title: '销售 SOP',
    category: 'sop',
    summary: '旧版销售 SOP。',
    content_markdown: '# 销售 SOP\n\n旧版内容。',
    source_ids: [source.id]
  });

  const synthesized = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'synthesize'
    },
    'wiki.synthesize_page_draft',
    {
      tenant_id: tenant.id,
      title: '销售 SOP',
      page_id: page.id,
      source_ids: [source.id],
      category: 'sop'
    }
  );

  assert.equal(synthesized.output.artifact.type, 'wiki_page_draft');
  assert.equal(synthesized.output.artifact.status, 'draft');
  assert.match(synthesized.output.draft.content_markdown, /dry-run/);
  assert.equal(harness.wikiStore.getPage(tenant.id, page.id).version, 1);

  const diff = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'diff'
    },
    'wiki.propose_page_diff',
    {
      tenant_id: tenant.id,
      page_id: page.id,
      change_request: '补充外呼审批约束'
    }
  );

  assert.equal(diff.output.artifact.type, 'wiki_page_diff');
  assert.equal(diff.output.proposal.current_version, 1);
  assert.equal(harness.wikiStore.getPage(tenant.id, page.id).version, 1);
});

test('wiki contradiction detection creates a review artifact without mutating pages', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Wiki Contradiction 公司' });
  const harness = createHarness(db);
  const pageA = harness.wikiStore.upsertPage({
    tenant_id: tenant.id,
    title: '外呼规则 A',
    category: 'voice',
    summary: '外呼必须审批。',
    content_markdown: '# 外呼规则 A\n\n所有 RustPBX 外呼必须经过人工审批。'
  });
  const pageB = harness.wikiStore.upsertPage({
    tenant_id: tenant.id,
    title: '外呼规则 B',
    category: 'voice',
    summary: '高意向线索可自动外呼。',
    content_markdown: '# 外呼规则 B\n\n高意向线索可以自动外呼，不需要审批。'
  });

  const review = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'contradictions'
    },
    'wiki.detect_contradictions',
    {
      tenant_id: tenant.id,
      category: 'voice',
      focus: '外呼审批规则'
    }
  );

  assert.equal(review.output.artifact.type, 'wiki_contradiction_review');
  assert.equal(review.output.review.status, 'needs_review');
  assert.equal(review.output.review.page_count, 2);
  assert.equal(harness.wikiStore.getPage(tenant.id, pageA.id).version, 1);
  assert.equal(harness.wikiStore.getPage(tenant.id, pageB.id).version, 1);
});

test('wiki model tools use tenant-routed live model provider when configured', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Wiki Live Model 公司' });
  const harness = createHarness(db);
  const previousKey = process.env.OPENAI_COMPATIBLE_WIKI_KEY;
  process.env.OPENAI_COMPATIBLE_WIKI_KEY = 'wiki-model-key';
  const seenRequests = [];

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { role: 'assistant', content: 'Live wiki draft body' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 }
    }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const secret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'wiki-model-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        secret_key: 'api_key',
        secret_value: 'wiki-model-key',
        env_var_name: 'OPENAI_COMPATIBLE_WIKI_KEY'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'wiki-model-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          auth_secret_key: 'api_key',
          default_model: 'wiki-default-model'
        },
        secret_ref_ids: [secret.output.id]
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'wiki-model-policy'),
      'integration.provider_policy_upsert',
      {
        tenant_id: tenant.id,
        policy_id: 'wiki-synthesis-model',
        name: 'Wiki synthesis model',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'wiki.synthesize_page_draft',
        preferred_integration_ids: ['openai-compatible'],
        allow_fallback: true
      }
    );

    const source = harness.wikiStore.ingestSource({
      tenant_id: tenant.id,
      title: '交付手册',
      content: '交付前需要校验租户配置和审批状态。',
      source_type: 'note'
    });
    const page = harness.wikiStore.upsertPage({
      tenant_id: tenant.id,
      title: '交付流程',
      category: 'sop',
      summary: '旧版交付流程。',
      content_markdown: '# 交付流程\n\n旧版。',
      source_ids: [source.id]
    });

    const synthesized = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'wiki-live-synthesize', { agentId: 'knowledge_agent', userId: 'user_test' }),
      'wiki.synthesize_page_draft',
      {
        tenant_id: tenant.id,
        title: '交付流程',
        page_id: page.id,
        source_ids: [source.id],
        category: 'sop'
      }
    );

    assert.equal(synthesized.output.model_call.provider, 'openai-compatible');
    assert.match(synthesized.output.draft.content_markdown, /Live wiki draft body/);
    assert.equal(seenRequests[0].body.model, 'wiki-default-model');
    assert.equal(seenRequests[0].headers.authorization, 'Bearer wiki-model-key');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousKey == null) delete process.env.OPENAI_COMPATIBLE_WIKI_KEY;
    else process.env.OPENAI_COMPATIBLE_WIKI_KEY = previousKey;
  }
});

const apiDb = createDatabase(':memory:');
const apiServer = createServer(apiDb);
let baseUrl = '';

before(async () => {
  const port = await listenOnRandomPort(apiServer);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolve) => apiServer.close(resolve));
});

test('knowledge wiki HTTP API ingests, queries, lints and returns index', async () => {
  const tenant = await post('/api/tenants', { name: 'Knowledge API 公司' });
  const ingest = await post('/api/knowledge/sources', {
    tenant_id: tenant.id,
    title: '客户 FAQ',
    content: '客户常问：是否支持 RustPBX 外呼？答案：支持，但外呼必须审批。',
    source_type: 'faq',
    category: 'faq',
    summary: 'RustPBX 外呼支持但必须审批。'
  });

  assert.equal(ingest.source.title, '客户 FAQ');
  assert.equal(ingest.page.category, 'faq');

  await post('/api/wiki/index/build', { tenant_id: tenant.id });
  const index = await get(`/api/wiki/index?tenant_id=${tenant.id}`);
  assert.match(index.content_markdown, /客户 FAQ/);

  const query = await post('/api/wiki/query', {
    tenant_id: tenant.id,
    query: 'RustPBX 外呼 审批'
  });
  assert.equal(query.results[0].title, '客户 FAQ');

  const lint = await post('/api/wiki/lint', { tenant_id: tenant.id });
  assert.equal(lint.page_count, 1);

  const synth = await post('/api/wiki/synthesize', {
    tenant_id: tenant.id,
    title: '客户 FAQ',
    page_id: ingest.page.id,
    source_ids: [ingest.source.id],
    category: 'faq'
  });
  assert.equal(synth.artifact.type, 'wiki_page_draft');

  const contradictions = await post('/api/wiki/contradictions', {
    tenant_id: tenant.id,
    category: 'faq',
    focus: 'RustPBX 外呼审批'
  });
  assert.equal(contradictions.artifact.type, 'wiki_contradiction_review');
});

async function post<T = any>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

function baseToolContext(tenantId, stepId, overrides = {}) {
  return {
    tenantId,
    workspaceId: 'default',
    userId: 'admin_user',
    agentId: 'orchestration_agent',
    workflowRunId: null,
    agentRunId: null,
    playbookId: 'manual',
    stepId,
    ...overrides
  };
}

async function readJsonBody(req: AsyncIterable<Uint8Array | string>): Promise<any> {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}
