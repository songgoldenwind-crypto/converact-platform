import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('catalog recommends stable open-source building blocks across CRM voice MCP and skills', () => {
  const db = createDatabase(':memory:');
  const harness = createHarness(db);

  const stableStack = harness.integrationCatalog.stableStackForConveract();

  assert.equal(stableStack.profile, 'lean_opc_default');
  assert.equal(stableStack.crm[0].id, 'opc-native-crm');
  assert.equal(stableStack.knowledge_base[0].id, 'opc-native-wiki');
  assert.ok(stableStack.knowledge_base_references.some((entry) => entry.id === 'llm-wiki'));
  assert.ok(stableStack.optional.crm_external.some((entry) => entry.id === 'espocrm'));
  assert.equal(stableStack.voice[0].id, 'rustpbx');
  assert.ok(stableStack.voice.some((entry) => entry.id === 'opc-native-webrtc'));
  assert.ok(stableStack.core.some((entry) => entry.id === 'rustpbx'));
  assert.ok(stableStack.core.some((entry) => entry.id === 'opc-native-webrtc'));
  assert.ok(stableStack.voice_heavy_fallbacks.some((entry) => entry.id === 'asterisk'));
  assert.ok(stableStack.mcp.some((entry) => entry.id === 'mcp-playwright'));
  assert.ok(stableStack.skills.some((entry) => entry.id === 'skill.lead_qualification'));
  assert.ok(stableStack.search.some((entry) => entry.id === 'perplexica'));
  assert.ok(stableStack.notebook.some((entry) => entry.id === 'open-notebook'));
  assert.ok(stableStack.geo_business_data.some((entry) => entry.id === 'amap-place-search'));
});

test('integration config foundation stores secret references without plaintext and checks health', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Integration Config 公司' });
  const harness = createHarness(db);

  const secret = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'secret'
    },
    'integration.secret_ref_upsert',
    {
      tenant_id: tenant.id,
      integration_id: 'rustpbx',
      secret_key: 'api_token',
      secret_value: 'rustpbx-secret-token-1234',
      env_var_name: 'RUSTPBX_API_TOKEN'
    }
  );

  assert.equal(secret.output.secret_key, 'api_token');
  assert.notEqual(secret.output.redacted_preview, 'rustpbx-secret-token-1234');
  assert.equal(secret.output.secret_fingerprint.length, 64);

  const config = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'config'
    },
    'integration.config_upsert',
    {
      tenant_id: tenant.id,
      integration_id: 'rustpbx',
      status: 'configured',
      config: {
        base_url: 'https://rustpbx.local',
        api_token: 'should-not-persist'
      },
      secret_ref_ids: [secret.output.id]
    }
  );

  assert.equal(config.output.config.api_token, '[REDACTED_CONFIG_SECRET]');
  const health = harness.integrationConfigStore.healthCheck({
    tenant_id: tenant.id,
    integration_id: 'rustpbx',
    required_secret_keys: ['api_token']
  });
  assert.equal(health.health.status, 'healthy');
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

test('integration config HTTP API supports secret refs config and health checks', async () => {
  const tenant = await post('/api/tenants', { name: 'Integration Config API 公司' });
  const secret = await post('/api/integrations/secret-refs', {
    tenant_id: tenant.id,
    integration_id: 'opc-native-webrtc',
    secret_key: 'turn_password',
    secret_value: 'turn-secret-1234',
    env_var_name: 'TURN_PASSWORD'
  });
  const config = await post('/api/integrations/configs', {
    tenant_id: tenant.id,
    integration_id: 'opc-native-webrtc',
    status: 'configured',
    config: { turn_url: 'turn:turn.local:3478', turn_password: 'do-not-store' },
    secret_ref_ids: [secret.id]
  });
  const health = await post('/api/integrations/health-check', {
    tenant_id: tenant.id,
    integration_id: 'opc-native-webrtc',
    required_secret_keys: ['turn_password']
  });

  assert.equal(config.config.turn_password, '[REDACTED_CONFIG_SECRET]');
  assert.equal(health.health.status, 'healthy');
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

async function get<T = any>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
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

test('integration recommendation playbook commits integration stack plan artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Integration Stack 公司' });
  const harness = createHarness(db);

  const result = await harness.commander.run({
    tenant_id: tenant.id,
    goal: '帮我推荐 Converact 可以融合的开源工具、CRM、呼叫、MCP 和 skills'
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.route.playbook_id, 'orchestration_agent.integration_stack_recommendation.v1');
  assert.equal(result.artifacts[0].type, 'integration_stack_plan');
  assert.ok(result.artifacts[0].payload.recommendations.crm.length > 0);
  assert.ok(result.artifacts[0].payload.adapters.some((adapter) => adapter.integration_id === 'rustpbx'));
});

test('integration tools are available through tool registry without side effects', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Catalog Tool 公司' });
  const harness = createHarness(db);

  const result = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'catalog'
    },
    'integration.catalog_search',
    { category: 'voice', capability: 'lightweight_voice', min_stability: 80 }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.output[0].id, 'rustpbx');
  assert.ok(result.output.every((entry) => entry.default_risk_level === 'R3'));
});

test('provider registry inventory merges catalog adapter config and snapshots', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Provider Registry 公司' });
  const harness = createHarness(db);

  const secret = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'provider-secret'
    },
    'integration.secret_ref_upsert',
    {
      tenant_id: tenant.id,
      integration_id: 'rustpbx',
      secret_key: 'api_token',
      secret_value: 'provider-secret-token-1234',
      env_var_name: 'RUSTPBX_API_TOKEN'
    }
  );
  await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'provider-config'
    },
    'integration.config_upsert',
    {
      tenant_id: tenant.id,
      integration_id: 'rustpbx',
      status: 'configured',
      config: { base_url: 'https://rustpbx.local' },
      secret_ref_ids: [secret.output.id]
    }
  );

  const inventoryBeforeSnapshot = harness.providerRegistryStore.listInventory({
    tenant_id: tenant.id,
    category: 'voice'
  });
  const rustpbxBeforeSnapshot = inventoryBeforeSnapshot.find((entry) => entry.integration_id === 'rustpbx');

  assert.equal(rustpbxBeforeSnapshot.configured, true);
  assert.equal(rustpbxBeforeSnapshot.health_status, 'configured');
  assert.equal(rustpbxBeforeSnapshot.adapter_type, 'voice_adapter');

  const snapshot = await harness.providerRegistryStore.snapshotHealth({
    tenant_id: tenant.id,
    integration_id: 'rustpbx',
    required_secret_keys: ['api_token']
  });
  assert.equal(snapshot.integration_id, 'rustpbx');

  const inventoryAfterSnapshot = harness.providerRegistryStore.listInventory({
    tenant_id: tenant.id,
    category: 'voice'
  });
  const rustpbxAfterSnapshot = inventoryAfterSnapshot.find((entry) => entry.integration_id === 'rustpbx');
  assert.equal(rustpbxAfterSnapshot.latest_health_snapshot_id, snapshot.id);
});

test('provider selection prefers selectable configured candidates and can honor preferred fallback', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Provider Select 公司' });
  const harness = createHarness(db);

  const voiceSelection = harness.providerRegistryStore.selectProvider({
    tenant_id: tenant.id,
    category: 'voice'
  });
  assert.equal(voiceSelection.selected.integration_id, 'opc-native-webrtc');

  const lightweightVoiceSelection = harness.providerRegistryStore.selectProvider({
    tenant_id: tenant.id,
    category: 'voice',
    capability: 'lightweight_voice'
  });
  assert.equal(lightweightVoiceSelection.selected.integration_id, 'rustpbx');

  const overrideSelection = harness.providerRegistryStore.selectProvider({
    tenant_id: tenant.id,
    category: 'voice',
    preferred_ids: ['rustpbx'],
    allow_fallback: true
  });
  assert.equal(overrideSelection.selected.integration_id, 'rustpbx');
});

test('tenant provider policies overlay provider selection by use case', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Provider Policy 公司' });
  const harness = createHarness(db);

  const policy = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'provider-policy'
    },
    'integration.provider_policy_upsert',
    {
      tenant_id: tenant.id,
      policy_id: 'outbound-call-lightweight',
      name: 'Outbound lightweight call routing',
      use_case: 'outbound_call',
      category: 'voice',
      preferred_integration_ids: ['rustpbx'],
      blocked_integration_ids: ['opc-native-webrtc'],
      allow_fallback: true
    }
  );
  assert.equal(policy.output.policy_id, 'outbound-call-lightweight');

  const selected = harness.providerRegistryStore.selectProvider({
    tenant_id: tenant.id,
    category: 'voice',
    use_case: 'outbound_call'
  });

  assert.equal(selected.selected.integration_id, 'rustpbx');
  assert.equal(selected.policy_overlay.policy_id, 'outbound-call-lightweight');
  assert.ok(selected.candidates.every((candidate) => candidate.integration_id !== 'opc-native-webrtc'));

  const defaultVoice = harness.providerRegistryStore.selectProvider({
    tenant_id: tenant.id,
    category: 'voice'
  });
  assert.equal(defaultVoice.selected.integration_id, 'opc-native-webrtc');
});

test('context builder injects tenant provider routing hints for relevant agent toolsets', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Provider Context 公司' });
  const harness = createHarness(db);

  await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'provider-policy-voice'
    },
    'integration.provider_policy_upsert',
    {
      tenant_id: tenant.id,
      policy_id: 'outbound-call-lightweight',
      name: 'Outbound lightweight call routing',
      use_case: 'outbound_call',
      category: 'voice',
      preferred_integration_ids: ['rustpbx'],
      blocked_integration_ids: ['opc-native-webrtc'],
      allow_fallback: true
    }
  );
  await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'provider-policy-search'
    },
    'integration.provider_policy_upsert',
    {
      tenant_id: tenant.id,
      policy_id: 'search-discovery',
      name: 'Search discovery routing',
      use_case: 'lead_discovery',
      category: 'ai_search',
      preferred_integration_ids: ['perplexica'],
      allow_fallback: true
    }
  );
  await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'provider-policy-model'
    },
    'integration.provider_policy_upsert',
    {
      tenant_id: tenant.id,
      policy_id: 'model-planning',
      name: 'Commander planning model routing',
      use_case: 'commander_plan',
      category: 'model_provider',
      capability: 'chat_completion',
      preferred_integration_ids: ['openai-compatible'],
      allow_fallback: true
    }
  );

  const contextPack = harness.contextBuilder.build({
    tenantId: tenant.id,
    workspaceId: 'default',
    userId: 'admin_user',
    agent: harness.agentRegistry.getManifest('orchestration_agent'),
    playbook: harness.agentRegistry.getPlaybook('orchestration_agent.growth_loop_intake.v1'),
    goal: '检查 provider 上下文注入',
    businessContext: {}
  });

  const inventorySummary = contextPack.providerPack.inventory_summary as Array<{ category: string }>;
  const routingHints = contextPack.providerPack.routing_hints as Array<{
    hint_id: string;
    selected_integration_id: string | null;
    policy_id: string | null;
  }>;

  assert.deepEqual(
    inventorySummary.map((entry) => entry.category).sort(),
    ['ai_search', 'geo_business_data', 'model_provider', 'notebook_workspace', 'voice']
  );
  assert.equal(contextPack.providerPack.active_policies.length, 3);

  const defaultVoiceHint = routingHints.find((hint) => hint.hint_id === 'voice.default');
  const outboundVoiceHint = routingHints.find((hint) => hint.hint_id === 'voice.outbound_call');
  const discoveryHint = routingHints.find((hint) => hint.hint_id === 'search.lead_discovery');
  const geoDiscoveryHint = routingHints.find((hint) => hint.hint_id === 'geo.place_discovery');
  const commanderModelHint = routingHints.find((hint) => hint.hint_id === 'model.commander_plan');
  const geoOutreachModelHint = routingHints.find((hint) => hint.hint_id === 'model.geo_outreach');
  assert.ok(defaultVoiceHint);
  assert.ok(outboundVoiceHint);
  assert.ok(discoveryHint);
  assert.ok(geoDiscoveryHint);
  assert.ok(commanderModelHint);
  assert.ok(geoOutreachModelHint);

  assert.equal(defaultVoiceHint.selected_integration_id, 'opc-native-webrtc');
  assert.equal(defaultVoiceHint.policy_id, null);
  assert.equal(outboundVoiceHint.selected_integration_id, 'rustpbx');
  assert.equal(outboundVoiceHint.policy_id, 'outbound-call-lightweight');
  assert.equal(discoveryHint.selected_integration_id, 'perplexica');
  assert.equal(discoveryHint.policy_id, 'search-discovery');
  assert.equal(geoDiscoveryHint.selected_integration_id, 'amap-place-search');
  assert.equal(geoDiscoveryHint.policy_id, null);
  assert.equal(commanderModelHint.selected_integration_id, 'openai-compatible');
  assert.equal(commanderModelHint.policy_id, 'model-planning');
  assert.equal(geoOutreachModelHint.selected_integration_id, 'openai-compatible');
});

test('provider inventory and health snapshot HTTP APIs expose tenant provider runtime state', async () => {
  const tenant = await post('/api/tenants', { name: 'Provider HTTP API 公司' });
  const secret = await post('/api/integrations/secret-refs', {
    tenant_id: tenant.id,
    user_id: 'user_test',
    integration_id: 'rustpbx',
    secret_key: 'api_token',
    secret_value: 'provider-secret-http-1234',
    env_var_name: 'RUSTPBX_API_TOKEN'
  });
  await post('/api/integrations/configs', {
    tenant_id: tenant.id,
    user_id: 'user_test',
    integration_id: 'rustpbx',
    status: 'configured',
    config: { base_url: 'https://rustpbx.local' },
    secret_ref_ids: [secret.id]
  });

  const inventory = await get(`/api/integrations/providers?tenant_id=${encodeURIComponent(tenant.id)}&category=voice&user_id=user_test`);
  const select = await post('/api/integrations/providers/select', {
    tenant_id: tenant.id,
    user_id: 'user_test',
    category: 'voice',
    capability: 'lightweight_voice'
  });
  const snapshot = await post('/api/integrations/providers/health-snapshot', {
    tenant_id: tenant.id,
    user_id: 'user_test',
    integration_id: 'rustpbx',
    required_secret_keys: ['api_token']
  });
  const snapshots = await get(
    `/api/integrations/providers/health-snapshots?tenant_id=${encodeURIComponent(tenant.id)}&integration_id=rustpbx&user_id=user_test`
  );

  assert.ok(inventory.some((entry) => entry.integration_id === 'rustpbx'));
  assert.equal(select.selected.integration_id, 'rustpbx');
  assert.equal(snapshot.integration_id, 'rustpbx');
  assert.equal(snapshots[0].id, snapshot.id);
});

test('provider policy HTTP APIs manage tenant routing overlays', async () => {
  const tenant = await post('/api/tenants', { name: 'Provider Policy HTTP 公司' });
  const policy = await post('/api/integrations/provider-policies', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    policy_id: 'search-discovery',
    name: 'Search discovery routing',
    use_case: 'lead_discovery',
    category: 'ai_search',
    preferred_integration_ids: ['perplexica'],
    allow_fallback: true
  });
  const policies = await get(
    `/api/integrations/provider-policies?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user&use_case=lead_discovery`
  );
  const selected = await post('/api/integrations/providers/select', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    category: 'ai_search',
    use_case: 'lead_discovery'
  });

  assert.equal(policy.policy_id, 'search-discovery');
  assert.equal(policies.length, 1);
  assert.equal(selected.selected.integration_id, 'perplexica');
  assert.equal(selected.policy_overlay.policy_id, 'search-discovery');
});

test('live Perplexica adapter resolves runtime secrets and executes tenant search queries', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Perplexica Live 公司' });
  const harness = createHarness(db);
  const seenRequests = [];
  const previousToken = process.env.PERPLEXICA_TEST_TOKEN;
  process.env.PERPLEXICA_TEST_TOKEN = 'perplexica-live-token';

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/api/search/query') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        summary: 'Live Perplexica summary',
        citations: [
          {
            id: 'external-clue',
            title: 'External clue result',
            url: 'https://provider.example.com/clue',
            snippet: `Live discovery for ${body.query}`
          }
        ],
        results: [{ title: 'Provider result 1' }]
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
      baseToolContext(tenant.id, 'perplexica-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'perplexica',
        secret_key: 'api_token',
        secret_value: 'perplexica-live-token',
        env_var_name: 'PERPLEXICA_TEST_TOKEN'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'perplexica-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'perplexica',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          health_path: '/api/health',
          auth_secret_key: 'api_token'
        },
        secret_ref_ids: [secret.output.id]
      }
    );

    const snapshot = await harness.providerRegistryStore.snapshotHealth({
      tenant_id: tenant.id,
      integration_id: 'perplexica',
      required_secret_keys: ['api_token']
    });
    assert.equal(snapshot.status, 'healthy');

    const result = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'perplexica-search', { userId: 'user_test' }),
      'search.query',
      {
        tenant_id: tenant.id,
        query: 'call center clue search'
      }
    );

    assert.equal(result.output.provider_selection.selected.integration_id, 'perplexica');
    assert.equal(result.output.provider_execution_mode, 'live_provider');
    assert.equal(result.output.summary, 'Live Perplexica summary');
    assert.equal(result.output.citations[0].title, 'External clue result');
    assert.equal(seenRequests.find((entry) => entry.url === '/api/search/query').headers.authorization, 'Bearer perplexica-live-token');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousToken == null) delete process.env.PERPLEXICA_TEST_TOKEN;
    else process.env.PERPLEXICA_TEST_TOKEN = previousToken;
  }
});

test('research search foundation selects Perplexica and creates cited search artifacts', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Research Search 公司' });
  const harness = createHarness(db);

  const source = harness.wikiStore.ingestSource({
    tenant_id: tenant.id,
    title: 'Competitive clue deck',
    uri: 'https://example.com/competitive-clues',
    content_text: 'Call center teams can use AI search clues, CRM context, and cited competitor evidence for faster follow-up.'
  });
  harness.wikiStore.upsertPage({
    tenant_id: tenant.id,
    title: 'Competitive clue workflow',
    slug: 'competitive-clue-workflow',
    category: 'research',
    summary: 'How tenant teams should gather competitor clues with citations.',
    content_markdown: '# Competitive clue workflow\n\nUse cited clue search and CRM context for follow-up.',
    source_ids: [source.id]
  });

  const session = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'search-session'
    },
    'search.session_upsert',
    {
      tenant_id: tenant.id,
      session_id: 'clue-hunt',
      name: '线索搜索',
      provider_integration_id: 'perplexica',
      domain_filters: ['example.com']
    }
  );
  assert.equal(session.output.session_id, 'clue-hunt');

  const result = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'search-query'
    },
    'search.query',
    {
      tenant_id: tenant.id,
      session_id: 'clue-hunt',
      query: 'call center clue crm citations'
    }
  );

  assert.equal(result.output.provider_selection.selected.integration_id, 'perplexica');
  assert.equal(result.output.run.session_id, 'clue-hunt');
  assert.ok(result.output.citations.length > 0);
  assert.equal(result.output.artifact.type, 'search_query_result');
});

test('live Open Notebook adapter executes notebook query and audio overview drafts', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Open Notebook Live 公司' });
  const harness = createHarness(db);

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/api/notebook/query') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        notebook_id: body.notebook_id,
        answer: 'Live notebook answer',
        citations: [
          {
            id: 'live-nb-citation',
            title: 'Notebook provider citation',
            url: 'https://provider.example.com/notebook',
            snippet: `Notebook answer for ${body.query}`
          }
        ]
      }));
      return;
    }
    if (req.url === '/api/notebook/audio-overview') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        notebook_id: body.notebook_id,
        citations: [
          {
            id: 'live-audio-citation',
            title: 'Audio provider citation',
            url: 'https://provider.example.com/audio',
            snippet: `Audio focus ${body.focus}`
          }
        ],
        script_outline: {
          title: 'Live audio outline',
          focus: body.focus,
          segments: ['Intro', 'Findings', 'Actions'],
          source_titles: ['Audio provider citation']
        }
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'open-notebook-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'open-notebook',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          health_path: '/api/health'
        }
      }
    );

    const source = harness.wikiStore.ingestSource({
      tenant_id: tenant.id,
      title: 'Voice routing notes',
      uri: 'https://example.com/voice-routing',
      content_text: 'RustPBX and WebRTC provide a lightweight tenant-scoped call and browser voice foundation.'
    });
    const page = harness.wikiStore.upsertPage({
      tenant_id: tenant.id,
      title: 'Voice routing foundation',
      slug: 'voice-routing-foundation',
      category: 'voice',
      summary: 'How RustPBX and WebRTC fit the foundation.',
      content_markdown: '# Voice routing foundation\n\nRustPBX pairs with WebRTC for lightweight call flows.',
      source_ids: [source.id]
    });
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'notebook-upsert-live', { agentId: 'knowledge_agent' }),
      'notebook.upsert',
      {
        tenant_id: tenant.id,
        notebook_id: 'voice-research-live',
        title: 'Voice research live',
        provider_integration_id: 'open-notebook'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'notebook-attach-live', { agentId: 'knowledge_agent' }),
      'notebook.attach_source',
      {
        tenant_id: tenant.id,
        notebook_id: 'voice-research-live',
        ref_type: 'page',
        ref_id: page.id
      }
    );

    const query = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'notebook-query-live', { agentId: 'knowledge_agent' }),
      'notebook.query_cited',
      {
        tenant_id: tenant.id,
        notebook_id: 'voice-research-live',
        query: 'rustpbx webrtc routing'
      }
    );
    const audio = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'notebook-audio-live', { agentId: 'knowledge_agent' }),
      'notebook.generate_audio_overview_draft',
      {
        tenant_id: tenant.id,
        notebook_id: 'voice-research-live',
        focus: 'voice foundation'
      }
    );

    assert.equal(query.output.provider_execution_mode, 'live_provider');
    assert.equal(query.output.answer, 'Live notebook answer');
    assert.equal(query.output.citations[0].title, 'Notebook provider citation');
    assert.equal(audio.output.provider_execution_mode, 'live_provider');
    assert.equal(audio.output.script_outline.title, 'Live audio outline');
    assert.equal(audio.output.artifact.type, 'notebook_audio_overview_draft');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
  }
});

test('notebook foundation attaches tenant sources and creates cited notebook outputs', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Notebook 公司' });
  const harness = createHarness(db);

  const source = harness.wikiStore.ingestSource({
    tenant_id: tenant.id,
    title: 'Voice routing notes',
    uri: 'https://example.com/voice-routing',
    content_text: 'RustPBX and WebRTC provide a lightweight tenant-scoped call and browser voice foundation.'
  });
  const page = harness.wikiStore.upsertPage({
    tenant_id: tenant.id,
    title: 'Voice routing foundation',
    slug: 'voice-routing-foundation',
    category: 'voice',
    summary: 'How RustPBX and WebRTC fit the foundation.',
    content_markdown: '# Voice routing foundation\n\nRustPBX pairs with WebRTC for lightweight call flows.',
    source_ids: [source.id]
  });

  const notebook = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'notebook-upsert'
    },
    'notebook.upsert',
    {
      tenant_id: tenant.id,
      notebook_id: 'voice-research',
      title: 'Voice research notebook',
      provider_integration_id: 'open-notebook'
    }
  );
  assert.equal(notebook.output.notebook_id, 'voice-research');

  const attached = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'notebook-attach'
    },
    'notebook.attach_source',
    {
      tenant_id: tenant.id,
      notebook_id: 'voice-research',
      ref_type: 'page',
      ref_id: page.id
    }
  );
  assert.equal(attached.output.source_refs.length, 1);

  const query = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'notebook-query'
    },
    'notebook.query_cited',
    {
      tenant_id: tenant.id,
      notebook_id: 'voice-research',
      query: 'RustPBX WebRTC foundation'
    }
  );
  assert.equal(query.output.provider_selection.selected.integration_id, 'open-notebook');
  assert.equal(query.output.run.notebook_id, 'voice-research');
  assert.ok(query.output.citations.length > 0);

  const audio = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'knowledge_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'notebook-audio'
    },
    'notebook.generate_audio_overview_draft',
    {
      tenant_id: tenant.id,
      notebook_id: 'voice-research',
      focus: 'voice foundation'
    }
  );
  assert.equal(audio.output.artifact.type, 'notebook_audio_overview_draft');
});

test('tenant skill foundation supports candidate review activation and context injection', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Tenant Skill 公司' });
  const harness = createHarness(db);

  const candidate = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'skill-candidate'
    },
    'skill.candidate_propose',
    {
      tenant_id: tenant.id,
      proposed_skill_id: 'tenant.followup_sop',
      name: '租户高意向三步跟进',
      description: '适用于高意向线索的 3 步 SOP。',
      applicable_agents: ['crm_agent'],
      inputs: ['lead_profile'],
      steps: ['check intent', 'create task', 'queue call approval'],
      quality_checks: ['sla', 'tone']
    }
  );
  assert.equal(candidate.output.status, 'candidate');

  const reviewed = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'skill-review'
    },
    'skill.candidate_review',
    {
      tenant_id: tenant.id,
      candidate_id: candidate.output.id,
      decision: 'approve'
    }
  );
  assert.equal(reviewed.output.skill.status, 'active');

  const skills = harness.tenantSkillStore.listSkills({ tenant_id: tenant.id, status: 'active' });
  assert.equal(skills.length, 1);

  const contextPack = harness.contextBuilder.build({
    tenantId: tenant.id,
    workspaceId: 'default',
    userId: 'user_test',
    agent: harness.agentRegistry.getManifest('crm_agent'),
    playbook: harness.agentRegistry.getPlaybook('crm_agent.create_followup_task.v1'),
    goal: '给线索创建 followup',
    businessContext: {}
  });
  const skillPack = contextPack.skillPack as Array<{ skill_id: string }>;
  assert.equal(contextPack.skillPack.length, 1);
  assert.equal(skillPack[0].skill_id, 'tenant.followup_sop');
});

test('tenant MCP foundation registers tenant-scoped servers and health snapshots', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Tenant MCP 公司' });
  const otherTenant = createTenant(db, { name: 'Tenant MCP Other 公司' });
  const harness = createHarness(db);

  const server = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'mcp-upsert'
    },
    'mcp.server_upsert',
    {
      tenant_id: tenant.id,
      server_id: 'browser-primary',
      integration_id: 'mcp-playwright',
      name: 'Browser MCP',
      transport: 'http',
      endpoint: 'http://mcp.local/playwright',
      toolsets: ['integration', 'knowledge'],
      capabilities: ['browser_automation', 'screenshots'],
      status: 'active'
    }
  );
  assert.equal(server.output.server_id, 'browser-primary');

  await harness.toolExecutor.execute(
    {
      tenantId: otherTenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'mcp-upsert-other'
    },
    'mcp.server_upsert',
    {
      tenant_id: otherTenant.id,
      server_id: 'browser-other',
      integration_id: 'mcp-playwright',
      name: 'Other Browser MCP',
      transport: 'http',
      endpoint: 'http://mcp.local/other',
      capabilities: ['browser_automation'],
      status: 'active'
    }
  );

  const health = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'admin_user',
      agentId: 'orchestration_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'mcp-health'
    },
    'mcp.server_health_check',
    {
      tenant_id: tenant.id,
      server_id: 'browser-primary'
    }
  );
  assert.equal(health.output.server.health_status, 'healthy');

  const servers = harness.mcpServerStore.listServers({ tenant_id: tenant.id });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].server_id, 'browser-primary');

  const selected = harness.mcpServerStore.selectServer({
    tenant_id: tenant.id,
    capability: 'browser_automation'
  });
  assert.equal(selected.selected.server_id, 'browser-primary');
  assert.equal(harness.mcpServerStore.listSnapshots({ tenant_id: tenant.id }).length, 1);
});

test('tenant skill and MCP HTTP APIs stay tenant-scoped', async () => {
  const tenant = await post('/api/tenants', { name: 'Tenant Scope API 公司' });
  const otherTenant = await post('/api/tenants', { name: 'Tenant Scope API Other 公司' });

  const candidate = await post('/api/skills/candidates', {
    tenant_id: tenant.id,
    user_id: 'user_test',
    proposed_skill_id: 'tenant.weekly_review_plus',
    name: '租户周报 SOP',
    applicable_agents: ['analytics_agent'],
    steps: ['collect metrics', 'review funnel']
  });
  const reviewed = await post(`/api/skills/candidates/${candidate.id}/review`, {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    decision: 'approve'
  });
  const skills = await get(`/api/skills?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user&status=active`);
  const otherSkills = await get(`/api/skills?tenant_id=${encodeURIComponent(otherTenant.id)}&user_id=admin_user&status=active`);

  await post('/api/mcp/servers', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    server_id: 'github-primary',
    integration_id: 'mcp-github',
    name: 'GitHub MCP',
    transport: 'http',
    endpoint: 'http://mcp.local/github',
    capabilities: ['repository', 'issues'],
    status: 'active'
  });
  const mcpHealth = await post('/api/mcp/servers/github-primary/health-check', {
    tenant_id: tenant.id,
    user_id: 'admin_user'
  });
  const mcpServers = await get(`/api/mcp/servers?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user`);
  const otherMcpServers = await get(`/api/mcp/servers?tenant_id=${encodeURIComponent(otherTenant.id)}&user_id=admin_user`);

  assert.equal(reviewed.skill.skill_id, 'tenant.weekly_review_plus');
  assert.equal(skills.length, 1);
  assert.equal(otherSkills.length, 0);
  assert.equal(mcpHealth.server.server_id, 'github-primary');
  assert.equal(mcpServers.length, 1);
  assert.equal(otherMcpServers.length, 0);
});

test('search and notebook HTTP APIs stay tenant-scoped', async () => {
  const tenant = await post('/api/tenants', { name: 'Search Notebook API 公司' });
  const otherTenant = await post('/api/tenants', { name: 'Search Notebook API Other 公司' });

  const source = await post('/api/knowledge/sources', {
    tenant_id: tenant.id,
    title: 'Lead clue page',
    content_text: 'AI clue search helps prioritize leads and cited follow-up insights.'
  });

  await post('/api/search/sessions', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    session_id: 'lead-clues',
    name: 'Lead clues',
    provider_integration_id: 'perplexica'
  });
  const searchSessions = await get(`/api/search/sessions?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user`);
  const otherSearchSessions = await get(`/api/search/sessions?tenant_id=${encodeURIComponent(otherTenant.id)}&user_id=admin_user`);
  const searchResult = await post('/api/search/query', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    session_id: 'lead-clues',
    query: 'AI clue search leads'
  });

  await post('/api/notebooks', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    notebook_id: 'lead-notebook',
    title: 'Lead research notebook',
    provider_integration_id: 'open-notebook'
  });
  await post('/api/notebooks/lead-notebook/sources', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    ref_type: 'source',
    ref_id: source.source.id
  });
  const notebooks = await get(`/api/notebooks?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user`);
  const otherNotebooks = await get(`/api/notebooks?tenant_id=${encodeURIComponent(otherTenant.id)}&user_id=admin_user`);
  const notebookResult = await post('/api/notebooks/lead-notebook/query', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    query: 'prioritize leads'
  });

  assert.equal(searchSessions.length, 1);
  assert.equal(otherSearchSessions.length, 0);
  assert.equal(searchResult.provider_selection.selected.integration_id, 'perplexica');
  assert.equal(notebooks.length, 1);
  assert.equal(otherNotebooks.length, 0);
  assert.equal(notebookResult.provider_selection.selected.integration_id, 'open-notebook');
});

test('artifact review HTTP APIs list and review tenant artifacts', async () => {
  const tenant = await post('/api/tenants', { name: 'Artifact Review API 公司' });
  const otherTenant = await post('/api/tenants', { name: 'Artifact Review API Other 公司' });

  await post('/api/search/sessions', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    session_id: 'artifact-search',
    name: 'Artifact search',
    provider_integration_id: 'perplexica'
  });
  const searchResult = await post('/api/search/query', {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    session_id: 'artifact-search',
    query: 'artifact review citations'
  });

  const artifacts = await get(`/api/artifacts?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user&type=search_query_result`);
  const otherArtifacts = await get(`/api/artifacts?tenant_id=${encodeURIComponent(otherTenant.id)}&user_id=admin_user&type=search_query_result`);
  const reviewed = await post(`/api/artifacts/${searchResult.artifact.id}/review`, {
    tenant_id: tenant.id,
    user_id: 'admin_user',
    decision: 'approve',
    review_notes: 'Approved search result'
  });
  const reviews = await get(`/api/artifacts/${encodeURIComponent(searchResult.artifact.id)}/reviews?tenant_id=${encodeURIComponent(tenant.id)}&user_id=admin_user`);

  assert.equal(artifacts.length, 1);
  assert.equal(otherArtifacts.length, 0);
  assert.equal(reviewed.artifact.status, 'approved');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].decision, 'approve');
});
