import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';
import { all } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('model gateway routes calls through dry-run adapter and records usage', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Model Gateway 测试公司' });
  const harness = createHarness(db);
  const seen = [];

  harness.hookManager.on('before_model_call', (payload) => {
    seen.push(`before:${payload.request.provider}:${payload.request.model}`);
  });
  harness.hookManager.on('after_model_call', (payload) => {
    seen.push(`after:${payload.modelCall.status}`);
  });

  const result = await harness.modelGateway.complete(
    {
      tenantId: tenant.id,
      userId: 'user_test',
      workflowRunId: null,
      agentRunId: null
    },
    {
      purpose: 'playbook_planning',
      messages: [
        { role: 'system', content: 'You are a dry-run planner.' },
        { role: 'user', content: 'Plan a simple OPC growth workflow.' }
      ]
    }
  );

  assert.equal(result.status, 'success');
  assert.match(result.output.content, /^\[dry-run:dry-run-v1]/);
  assert.deepEqual(seen, ['before:dry_run:dry-run-v1', 'after:success']);

  const calls = all(db, 'SELECT * FROM model_calls WHERE tenant_id = ?', [tenant.id]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'dry_run');
  assert.equal(calls[0].model, 'dry-run-v1');
  assert.equal(calls[0].status, 'success');
});

test('model gateway executes live OpenAI-compatible provider with tenant BYOK secret refs', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Live Model Provider 公司' });
  const harness = createHarness(db);
  const previousKey = process.env.OPENAI_COMPATIBLE_TEST_KEY;
  process.env.OPENAI_COMPATIBLE_TEST_KEY = 'model-live-key';
  const seenRequests = [];

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'Live model answer' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const secret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'model-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        secret_key: 'api_key',
        secret_value: 'model-live-key',
        env_var_name: 'OPENAI_COMPATIBLE_TEST_KEY'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'model-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          auth_secret_key: 'api_key'
        },
        secret_ref_ids: [secret.output.id]
      }
    );

    const result = await harness.modelGateway.complete(
      {
        tenantId: tenant.id,
        workspaceId: 'default',
        userId: 'user_test'
      },
      {
        provider: 'openai-compatible',
        model: 'tenant-model',
        purpose: 'summary',
        messages: [{ role: 'user', content: 'Summarize this.' }]
      }
    );

    assert.equal(result.status, 'success');
    assert.equal(result.output.content, 'Live model answer');
    assert.equal(result.output.usage.total_tokens, 16);
    assert.equal(seenRequests[0].headers.authorization, 'Bearer model-live-key');
    assert.equal(seenRequests[0].body.model, 'tenant-model');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousKey == null) delete process.env.OPENAI_COMPATIBLE_TEST_KEY;
    else process.env.OPENAI_COMPATIBLE_TEST_KEY = previousKey;
  }
});

test('model gateway falls back when configured live model provider fails', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Model Fallback 公司' });
  const harness = createHarness(db);

  const providerServer = createHttpServer(async (_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'provider unavailable' }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'model-config-fallback'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        status: 'configured',
        config: { base_url: providerBaseUrl }
      }
    );
    const result = await harness.modelGateway.complete(
      { tenantId: tenant.id, userId: 'user_test' },
      {
        provider: 'openai-compatible',
        model: 'tenant-model',
        fallback_provider: 'dry_run',
        fallback_model: 'dry-run-v1',
        prompt: 'Fallback please'
      }
    );

    assert.equal(result.status, 'success');
    assert.equal(result.output.provider, 'dry_run');
    const calls = all(db, 'SELECT status, provider FROM model_calls WHERE tenant_id = ? ORDER BY created_at ASC', [tenant.id]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].status, 'failed');
    assert.equal(calls[1].provider, 'dry_run');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('model gateway can auto-route through tenant model provider selection', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Model Auto Routing 公司' });
  const harness = createHarness(db);
  const previousKey = process.env.OPENAI_COMPATIBLE_AUTO_KEY;
  process.env.OPENAI_COMPATIBLE_AUTO_KEY = 'model-auto-key';
  const seenRequests = [];

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { role: 'assistant', content: 'Auto routed answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 }
    }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const secret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'model-auto-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        secret_key: 'api_key',
        secret_value: 'model-auto-key',
        env_var_name: 'OPENAI_COMPATIBLE_AUTO_KEY'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'model-auto-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'openai-compatible',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          auth_secret_key: 'api_key',
          default_model: 'tenant-default-model'
        },
        secret_ref_ids: [secret.output.id]
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'model-auto-policy'),
      'integration.provider_policy_upsert',
      {
        tenant_id: tenant.id,
        policy_id: 'wiki-model-routing',
        name: 'Wiki model routing',
        category: 'model_provider',
        capability: 'chat_completion',
        use_case: 'wiki.synthesize_page_draft',
        preferred_integration_ids: ['openai-compatible'],
        allow_fallback: true
      }
    );

    const result = await harness.modelGateway.complete(
      {
        tenantId: tenant.id,
        workspaceId: 'default',
        userId: 'user_test'
      },
      {
        provider: 'tenant_default',
        purpose: 'wiki.synthesize_page_draft',
        prompt: 'Summarize wiki updates.',
        fallback_provider: 'dry_run'
      }
    );

    assert.equal(result.status, 'success');
    assert.equal(result.output.provider, 'openai-compatible');
    assert.equal(result.output.model, 'tenant-default-model');
    assert.equal(seenRequests[0].body.model, 'tenant-default-model');
    assert.equal(seenRequests[0].headers.authorization, 'Bearer model-auto-key');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousKey == null) delete process.env.OPENAI_COMPATIBLE_AUTO_KEY;
    else process.env.OPENAI_COMPATIBLE_AUTO_KEY = previousKey;
  }
});

function baseToolContext(tenantId, stepId) {
  return {
    tenantId,
    workspaceId: 'default',
    userId: 'admin_user',
    agentId: 'orchestration_agent',
    workflowRunId: null,
    agentRunId: null,
    playbookId: 'manual',
    stepId
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
