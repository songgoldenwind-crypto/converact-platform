import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { test } from 'node:test';

import { all } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/services.js';
import { expectSuccess, listenOnRandomPort } from './test-helpers.js';

test('geo foundation generates place insight and outreach draft artifacts through playbook runtime', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Geo Playbook 公司' });
  const harness = createHarness(db);

  const session = await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'session'),
    'geo.session_upsert',
    {
      tenant_id: tenant.id,
      name: 'Shenzhen call-center leads',
      business_type: 'call_center',
      city: 'Shenzhen',
      search_query: 'call center shenzhen'
    }
  );
  const place = await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'place'),
    'geo.place_upsert',
    {
      tenant_id: tenant.id,
      session_id: session.output.session_id,
      name: 'Shenzhen Service Hub',
      business_type: 'call_center',
      city: 'Shenzhen',
      address: 'Nanshan District',
      phone: '+86 755 1234 5678',
      rating: 4.1,
      review_count: 23
    }
  );

  await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'review-1'),
    'geo.review_ingest',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Alice',
      rating: 2,
      content: '客户抱怨接通慢，而且下班后留言经常没人跟进。'
    }
  );
  await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'review-2'),
    'geo.review_ingest',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Bob',
      rating: 3,
      content: '服务态度还可以，但回访排期混乱，反复确认时间。'
    }
  );

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.prepare_local_outreach.v1',
    goal: '给这个本地商家准备个性化触达',
    place_id: place.output.id,
    product_offer: 'AI呼叫中心质检与漏接来电自动回拨方案',
    offer_summary: '帮助线索回访更及时、质检更稳定、减少人工排班波动。',
    channel: 'email'
  });

  assert.equal(result.agent_run.status, 'completed');
  assert.equal(result.workflow_run.status, 'completed');
  assert.equal(result.step_outputs.extract_pain_signals.insight.place_id, place.output.id);
  assert.ok(result.step_outputs.extract_pain_signals.insight.pain_signals.length >= 1);
  assert.equal(result.step_outputs.generate_outreach_draft.draft.place_id, place.output.id);
  assert.equal(result.step_outputs.generate_outreach_draft.draft.channel, 'email');
  assert.equal(result.step_outputs.generate_outreach_draft.draft.insight_id, result.step_outputs.extract_pain_signals.insight.id);
  assert.deepEqual(
    result.artifacts.map((artifact) => artifact.type).sort(),
    ['geo_outreach_draft', 'geo_place_insight']
  );

  const persistedDrafts = all(db, 'SELECT * FROM tenant_geo_outreach_drafts WHERE tenant_id = ?', [tenant.id]);
  assert.equal(persistedDrafts.length, 1);
});

test('geo live provider foundation discovers places and imports reviews through configured adapter', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Geo Live Provider 公司' });
  const harness = createHarness(db);
  const previousKey = process.env.AMAP_TEST_KEY;
  process.env.AMAP_TEST_KEY = 'geo-live-key';
  const seenRequests = [];

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/api/places/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        places: [
          {
            id: 'amap-place-1',
            name: 'Shenzhen Service Hub',
            type: 'call_center',
            address: 'Nanshan District',
            city: 'Shenzhen',
            phone: '+86 755 1234 5678',
            rating: 4.5,
            review_count: 31,
            location: { lat: 22.5431, lng: 113.9345 }
          },
          {
            id: 'amap-place-2',
            name: 'Baoan CX Center',
            type: 'call_center',
            address: 'Baoan District',
            city: 'Shenzhen',
            rating: 4.0,
            review_count: 18,
            location: { lat: 22.555, lng: 113.883 }
          }
        ]
      }));
      return;
    }
    if (req.url === '/api/reviews/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        reviews: [
          {
            id: 'review-1',
            author: 'Alice',
            rating: 2,
            text: '客户抱怨夜间热线接通慢，留言转化效率低。',
            date: '2026-04-01T10:00:00.000Z'
          },
          {
            id: 'review-2',
            author: 'Bob',
            rating: 3,
            text: '高峰时段回访安排混乱，人工排班压力大。',
            date: '2026-04-02T10:00:00.000Z'
          }
        ]
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const secret = expectSuccess(await harness.toolExecutor.execute(
      toolContext(tenant.id, 'orchestration_agent', 'geo-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'amap-place-search',
        secret_key: 'api_key',
        secret_value: 'geo-live-key',
        env_var_name: 'AMAP_TEST_KEY'
      }
    ));
    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'orchestration_agent', 'geo-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'amap-place-search',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          health_path: '/api/health',
          auth_secret_key: 'api_key',
          auth_header_name: 'x-api-key',
          auth_scheme: 'none'
        },
        secret_ref_ids: [secret.output.id]
      }
    );

    const discovery = await harness.runtime.runPlaybook({
      tenant_id: tenant.id,
      workspace_id: 'default',
      user_id: 'geo_user',
      playbook_id: 'geo_agent.discover_local_businesses.v1',
      goal: '发现深圳呼叫中心线索',
      query: 'call center',
      business_type: 'call_center',
      city: 'Shenzhen',
      limit: 5
    });

    assert.equal(discovery.agent_run.status, 'completed');
    assert.equal(discovery.step_outputs.discover_places.provider_execution_mode, 'live_provider');
    assert.equal(discovery.step_outputs.discover_places.places.length, 2);
    assert.ok(discovery.artifacts.some((artifact) => artifact.type === 'geo_place_discovery_result'));
    assert.equal(seenRequests.find((entry) => entry.url === '/api/places/search').headers['x-api-key'], 'geo-live-key');

    const imported = await harness.runtime.runPlaybook({
      tenant_id: tenant.id,
      workspace_id: 'default',
      user_id: 'geo_user',
      playbook_id: 'geo_agent.import_place_reviews.v1',
      goal: '导入单个商家的评论',
      place_id: discovery.step_outputs.discover_places.places[0].id,
      limit: 10
    });

    assert.equal(imported.agent_run.status, 'completed');
    assert.equal(imported.step_outputs.import_reviews.provider_execution_mode, 'live_provider');
    assert.equal(imported.step_outputs.import_reviews.reviews.length, 2);
    assert.ok(imported.artifacts.some((artifact) => artifact.type === 'geo_review_import_result'));
    assert.equal(harness.geoStore.listReviews({ tenant_id: tenant.id, place_id: discovery.step_outputs.discover_places.places[0].id }).length, 2);
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousKey == null) delete process.env.AMAP_TEST_KEY;
    else process.env.AMAP_TEST_KEY = previousKey;
  }
});

test('geo HTTP APIs expose tenant-scoped sessions places reviews insights and drafts', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo HTTP 公司' });
    const session = await post(baseUrl, '/api/geo/sessions', {
      tenant_id: tenant.id,
      name: 'Shanghai clinic outreach',
      business_type: 'clinic',
      city: 'Shanghai'
    });
    const place = await post(baseUrl, '/api/geo/places', {
      tenant_id: tenant.id,
      session_id: session.session_id,
      name: 'Pudong Care Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      address: 'Pudong New Area',
      rating: 4.3
    });
    await post(baseUrl, '/api/geo/reviews', {
      tenant_id: tenant.id,
      place_id: place.id,
      author_name: 'Patient A',
      rating: 2,
      content: '预约确认太慢，电话经常要打第二次。'
    });

    const insight = await post(baseUrl, '/api/geo/insights/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      offer_context: '提升电话预约跟进效率'
    });
    const draft = await post(baseUrl, '/api/geo/outreach-drafts/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      product_offer: '诊所预约回访自动化与通话质检',
      channel: 'whatsapp'
    });

    const sessions = await get(baseUrl, `/api/geo/sessions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const places = await get(baseUrl, `/api/geo/places?tenant_id=${encodeURIComponent(tenant.id)}&session_id=${encodeURIComponent(session.session_id)}`);
    const reviews = await get(baseUrl, `/api/geo/reviews?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(place.id)}`);
    const insights = await get(baseUrl, `/api/geo/insights?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(place.id)}`);
    const drafts = await get(baseUrl, `/api/geo/outreach-drafts?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(place.id)}`);

    assert.equal(sessions.length, 1);
    assert.equal(places.length, 1);
    assert.equal(reviews.length, 1);
    assert.equal(insights.length, 1);
    assert.equal(drafts.length, 1);
    assert.equal(insight.insight.place_id, place.id);
    assert.equal(draft.draft.channel, 'whatsapp');
    assert.equal(drafts[0].artifact_id != null, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing foundation builds territory coverage handoff packets through playbook runtime', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Geo Routing 公司' });
  const harness = createHarness(db);

  const place = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'routing-place'),
    'geo.place_upsert',
    {
      tenant_id: tenant.id,
      name: 'Shanghai Clinic Hub',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      rating: 4.2
    }
  ));
  await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'routing-review'),
    'geo.review_ingest',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Patient A',
      rating: 2,
      content: '电话预约确认太慢，夜间热线没有及时跟进。'
    }
  );
  const insight = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'routing-insight'),
    'geo.extract_place_pain_signals',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      offer_context: '诊所预约回访自动化'
    }
  ));
  const draft = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'routing-draft'),
    'geo.generate_outreach_draft',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      insight_id: insight.output.insight.id,
      product_offer: '诊所预约回访自动化',
      channel: 'call_script'
    }
  ));

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'shanghai-clinic',
    name: 'Shanghai Clinic Territory',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic',
    queue_route_id: 'geo-shanghai',
    voice_route_id: 'east-voice',
    default_owner_user_id: 'rep_east'
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'shanghai-clinic',
    coverage_id: 'rep-east',
    owner_user_id: 'rep_east',
    owner_name: 'East Rep',
    channel: 'call_script',
    voice_route_id: 'east-voice',
    queue_route_id: 'geo-shanghai',
    priority_weight: 120,
    daily_capacity: 20,
    active_assignments: 3
  });

  const routed = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.route_place_followup.v1',
    goal: '把 geo 线索交给呼叫团队跟进',
    place_id: place.output.id,
    insight_id: insight.output.insight.id,
    draft_id: draft.output.draft.id,
    channel: 'call_script'
  });

  assert.equal(routed.agent_run.status, 'completed');
  assert.equal(routed.step_outputs.generate_handoff_packet.territory.territory_id, 'shanghai-clinic');
  assert.equal(routed.step_outputs.generate_handoff_packet.rep_coverage.coverage_id, 'rep-east');
  assert.equal(routed.step_outputs.generate_handoff_packet.handoff.recommended_next_action, 'queue_voice_followup');
  assert.equal(routed.step_outputs.generate_handoff_packet.handoff.voice_route_id, 'east-voice');
  assert.ok(routed.artifacts.some((artifact) => artifact.type === 'geo_handoff_packet'));

  const handoffs = harness.geoRoutingStore.listHandoffs({ tenant_id: tenant.id });
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].payload.crm_task.owner_user_id, 'rep_east');
});

test('geo handoff execution creates CRM work and queues approval-gated voice follow-up through the harness', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Geo Execute 公司' });
  const harness = createHarness(db);

  const place = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'execute-place'),
    'geo.place_upsert',
    {
      tenant_id: tenant.id,
      name: 'Shanghai Execute Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      phone: '+86 21 5555 8888',
      rating: 4.5
    }
  ));
  await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'execute-review'),
    'geo.review_ingest',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Patient A',
      rating: 2,
      content: '电话预约确认太慢，回访排队很混乱。'
    }
  );
  const insight = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'execute-insight'),
    'geo.extract_place_pain_signals',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      offer_context: '诊所预约回访自动化'
    }
  ));
  const draft = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'execute-draft'),
    'geo.generate_outreach_draft',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      insight_id: insight.output.insight.id,
      product_offer: '诊所预约回访自动化',
      channel: 'call_script'
    }
  ));

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'shanghai-execute',
    name: 'Shanghai Execute Territory',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic',
    queue_route_id: 'geo-execute',
    voice_route_id: 'execute-voice',
    default_owner_user_id: 'rep_execute'
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'shanghai-execute',
    coverage_id: 'rep-execute',
    owner_user_id: 'rep_execute',
    owner_name: 'Execute Rep',
    channel: 'call_script',
    voice_route_id: 'execute-voice',
    queue_route_id: 'geo-execute',
    priority_weight: 130,
    daily_capacity: 20,
    active_assignments: 3
  });

  const routed = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.route_place_followup.v1',
    goal: '给呼叫团队准备交接',
    place_id: place.output.id,
    insight_id: insight.output.insight.id,
    draft_id: draft.output.draft.id,
    channel: 'call_script'
  });
  const executed = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.execute_handoff_followup.v1',
    goal: '执行交接',
    handoff_id: routed.step_outputs.generate_handoff_packet.handoff.id
  });

  assert.equal(executed.agent_run.status, 'completed');
  assert.equal(executed.step_outputs.execute_handoff_packet.execution.crm_task.status, 'success');
  assert.equal(executed.step_outputs.execute_handoff_packet.execution.voice_followup.status, 'blocked_pending_approval');
  assert.ok(executed.artifacts.some((artifact) => artifact.type === 'geo_handoff_execution'));

  const tasks = all(db, 'SELECT * FROM tasks WHERE tenant_id = ?', [tenant.id]);
  const approvals = all(db, 'SELECT * FROM approval_requests WHERE tenant_id = ?', [tenant.id]);
  const handoffs = harness.geoRoutingStore.listHandoffs({ tenant_id: tenant.id });
  const coverages = harness.geoRoutingStore.listRepCoverages({ tenant_id: tenant.id, territory_id: 'shanghai-execute' });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].object_id, place.output.id);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action_type, 'voice.queue_call_for_approval');
  assert.equal(handoffs[0].status, 'queued');
  assert.equal(handoffs[0].payload.execution.crm_task.status, 'success');
  assert.equal(handoffs[0].payload.execution.voice_followup.status, 'blocked_pending_approval');
  assert.equal(coverages[0].active_assignments, 4);
});

test('geo territory capacity report rebalances only pending handoffs onto available rep coverage', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Geo Balance 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'shanghai-balance',
    name: 'Shanghai Balance Territory',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic',
    queue_route_id: 'geo-balance-primary',
    voice_route_id: 'balance-primary',
    default_owner_user_id: 'rep_primary'
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'shanghai-balance',
    coverage_id: 'rep-balance-primary',
    owner_user_id: 'rep_primary',
    owner_name: 'Primary Rep',
    channel: 'call_script',
    voice_route_id: 'balance-primary',
    queue_route_id: 'geo-balance-primary',
    priority_weight: 200,
    daily_capacity: 2,
    active_assignments: 1
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'shanghai-balance',
    coverage_id: 'rep-balance-backup',
    owner_user_id: 'rep_backup',
    owner_name: 'Backup Rep',
    channel: 'call_script',
    voice_route_id: 'balance-backup',
    queue_route_id: 'geo-balance-backup',
    priority_weight: 50,
    daily_capacity: 4,
    active_assignments: 0
  });

  async function createHandoff(stepPrefix: string) {
    const place = expectSuccess(await harness.toolExecutor.execute(
      toolContext(tenant.id, 'geo_agent', `${stepPrefix}-place`),
      'geo.place_upsert',
      {
        tenant_id: tenant.id,
        name: `${stepPrefix} Clinic`,
        business_type: 'clinic',
        city: 'Shanghai',
        region: 'Pudong',
        address: 'Pudong New Area',
        phone: '+86 21 6666 8888',
        rating: 4.5
      }
    ));
    await harness.toolExecutor.execute(
      toolContext(tenant.id, 'geo_agent', `${stepPrefix}-review`),
      'geo.review_ingest',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        author_name: 'Patient A',
        rating: 2,
        content: '电话预约排队太久，需要更快回访。'
      }
    );
    const insight = expectSuccess(await harness.toolExecutor.execute(
      toolContext(tenant.id, 'geo_agent', `${stepPrefix}-insight`),
      'geo.extract_place_pain_signals',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        offer_context: '诊所预约回访自动化'
      }
    ));
    const draft = expectSuccess(await harness.toolExecutor.execute(
      toolContext(tenant.id, 'geo_agent', `${stepPrefix}-draft`),
      'geo.generate_outreach_draft',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        insight_id: insight.output.insight.id,
        product_offer: '诊所预约回访自动化',
        channel: 'call_script'
      }
    ));
    const routed = await harness.runtime.runPlaybook({
      tenant_id: tenant.id,
      workspace_id: 'default',
      user_id: 'geo_user',
      playbook_id: 'geo_agent.route_place_followup.v1',
      goal: '给呼叫团队准备交接',
      place_id: place.output.id,
      insight_id: insight.output.insight.id,
      draft_id: draft.output.draft.id,
      channel: 'call_script'
    });
    return routed.step_outputs.generate_handoff_packet.handoff;
  }

  const executedHandoff = await createHandoff('balance-executed');
  const pendingHandoff = await createHandoff('balance-pending');

  await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.execute_handoff_followup.v1',
    goal: '执行交接',
    handoff_id: executedHandoff.id
  });

  const report = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'balance-report'),
    'geo.territory_capacity_report',
    {
      tenant_id: tenant.id,
      territory_id: 'shanghai-balance'
    }
  ));
  assert.equal(report.output.territory.territory_id, 'shanghai-balance');
  assert.equal(report.output.eligible_handoffs, 1);
  assert.equal(report.output.executed_handoffs, 1);
  assert.equal(report.output.recommended_moves.length, 1);
  assert.equal(report.output.recommended_moves[0].handoff_id, pendingHandoff.id);
  assert.equal(report.output.recommended_moves[0].to_coverage_id, 'rep-balance-backup');

  const balanced = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.balance_territory_capacity.v1',
    goal: '平衡片区容量',
    territory_id: 'shanghai-balance'
  });

  assert.equal(balanced.agent_run.status, 'completed');
  assert.equal(balanced.step_outputs.rebalance_handoffs.rebalanced_count, 1);
  assert.ok(balanced.artifacts.some((artifact) => artifact.type === 'geo_capacity_balance_report'));

  const handoffs = harness.geoRoutingStore.listHandoffs({ tenant_id: tenant.id });
  const executed = handoffs.find((handoff) => handoff.id === executedHandoff.id);
  const pending = handoffs.find((handoff) => handoff.id === pendingHandoff.id);

  assert.equal(executed?.owner_user_id, 'rep_primary');
  assert.equal(executed?.payload.execution.voice_followup.status, 'blocked_pending_approval');
  assert.equal(pending?.owner_user_id, 'rep_backup');
  assert.equal(pending?.payload.rep_coverage.coverage_id, 'rep-balance-backup');
  assert.equal(pending?.queue_route_id, 'geo-balance-backup');
  assert.equal(pending?.voice_route_id, 'balance-backup');
});

test('geo feedback sync pulls CRM and voice outcomes back into handoffs and coverage load', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Geo Feedback 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'shanghai-feedback',
    name: 'Shanghai Feedback Territory',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic',
    queue_route_id: 'geo-feedback',
    voice_route_id: 'feedback-voice',
    default_owner_user_id: 'rep_feedback'
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'shanghai-feedback',
    coverage_id: 'rep-feedback',
    owner_user_id: 'rep_feedback',
    owner_name: 'Feedback Rep',
    channel: 'call_script',
    voice_route_id: 'feedback-voice',
    queue_route_id: 'geo-feedback',
    priority_weight: 120,
    daily_capacity: 10,
    active_assignments: 3
  });

  const place = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'feedback-place'),
    'geo.place_upsert',
    {
      tenant_id: tenant.id,
      name: 'Feedback Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      phone: '+86 21 7777 9999',
      rating: 4.4
    }
  ));
  await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'feedback-review'),
    'geo.review_ingest',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Patient A',
      rating: 2,
      content: '预约确认慢，需要回访。'
    }
  );
  const insight = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'feedback-insight'),
    'geo.extract_place_pain_signals',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      offer_context: '诊所预约回访自动化'
    }
  ));
  const draft = expectSuccess(await harness.toolExecutor.execute(
    toolContext(tenant.id, 'geo_agent', 'feedback-draft'),
    'geo.generate_outreach_draft',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      insight_id: insight.output.insight.id,
      product_offer: '诊所预约回访自动化',
      channel: 'call_script'
    }
  ));
  const routed = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.route_place_followup.v1',
    goal: '准备交接',
    place_id: place.output.id,
    insight_id: insight.output.insight.id,
    draft_id: draft.output.draft.id,
    channel: 'call_script'
  });
  await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.execute_handoff_followup.v1',
    goal: '执行交接',
    handoff_id: routed.step_outputs.generate_handoff_packet.handoff.id
  });

  const approval = all(db, 'SELECT * FROM approval_requests WHERE tenant_id = ?', [tenant.id])[0];
  harness.approvalQueue.decide(tenant.id, approval.id, 'approved', 'geo_user');
  const resumed = await harness.toolExecutor.resumeApproved(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'geo_user',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'voice_followup'
    },
    approval.tool_call_id
  );
  await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'geo_user',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'voice_complete'
    },
    'voice.rustpbx_ingest_event',
    {
      tenant_id: tenant.id,
      rustpbx_call_id: resumed.output.call_session.rustpbx_call_id,
      event_type: 'completed',
      payload: { duration_seconds: 45 }
    }
  );
  const crmTask = all(db, 'SELECT * FROM tasks WHERE tenant_id = ?', [tenant.id])[0];
  await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'geo_user',
      agentId: 'crm_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'crm_complete'
    },
    'crm.complete_task',
    {
      tenant_id: tenant.id,
      task_id: crmTask.id
    }
  );

  const synced = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.sync_feedback_loops.v1',
    goal: '同步反馈',
    territory_id: 'shanghai-feedback'
  });

  assert.equal(synced.agent_run.status, 'completed');
  assert.ok(synced.artifacts.some((artifact) => artifact.type === 'geo_feedback_loop_report'));
  assert.equal(synced.step_outputs.sync_feedback.synced_handoffs.length, 1);
  assert.equal(synced.step_outputs.sync_feedback.coverage_updates[0].active_assignments, 3);

  const handoff = harness.geoRoutingStore.listHandoffs({ tenant_id: tenant.id })[0];
  const coverage = harness.geoRoutingStore.listRepCoverages({ tenant_id: tenant.id, territory_id: 'shanghai-feedback' })[0];

  assert.equal(handoff.status, 'reviewed');
  assert.equal(handoff.payload.feedback.overall_status, 'resolved');
  assert.equal(handoff.payload.feedback.crm_task.status, 'done');
  assert.equal(handoff.payload.feedback.voice_followup.approval_status, 'approved');
  assert.equal(handoff.payload.feedback.voice_followup.tool_call_status, 'success');
  assert.equal(handoff.payload.feedback.voice_followup.call_session_status, 'completed');
  assert.equal(coverage.active_assignments, 3);
  assert.equal(coverage.metadata.geo_feedback.baseline_active_assignments, 3);
  assert.equal(coverage.metadata.geo_feedback.active_geo_assignments, 0);
  assert.equal(coverage.metadata.geo_feedback.completed_handoffs, 1);
});

test('geo HTTP APIs expose live discovery and review import through tenant-scoped provider config', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const previousKey = process.env.AMAP_HTTP_TEST_KEY;
  process.env.AMAP_HTTP_TEST_KEY = 'geo-http-key';
  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/api/places/search') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        places: [
          {
            id: 'http-place-1',
            name: 'Pudong Care Clinic',
            type: 'clinic',
            address: 'Pudong New Area',
            city: 'Shanghai',
            rating: 4.2,
            review_count: 9
          }
        ]
      }));
      return;
    }
    if (req.url === '/api/reviews/list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        reviews: [
          {
            id: 'http-review-1',
            author: 'Patient A',
            rating: 2,
            text: '电话预约确认太慢。',
            date: '2026-04-01T09:00:00.000Z'
          }
        ]
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const providerPort = await listenOnRandomPort(providerServer);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo HTTP Live 公司' });
    const secret = await post(baseUrl, '/api/integrations/secret-refs', {
      tenant_id: tenant.id,
      integration_id: 'amap-place-search',
      secret_key: 'api_key',
      secret_value: 'geo-http-key',
      env_var_name: 'AMAP_HTTP_TEST_KEY'
    });
    await post(baseUrl, '/api/integrations/configs', {
      tenant_id: tenant.id,
      integration_id: 'amap-place-search',
      status: 'configured',
      config: {
        base_url: providerBaseUrl,
        health_path: '/api/health',
        auth_secret_key: 'api_key',
        auth_header_name: 'x-api-key',
        auth_scheme: 'none'
      },
      secret_ref_ids: [secret.id]
    });

    const discovery = await post(baseUrl, '/api/geo/discover', {
      tenant_id: tenant.id,
      query: 'clinic',
      business_type: 'clinic',
      city: 'Shanghai'
    });
    assert.equal(discovery.provider_execution_mode, 'live_provider');
    assert.equal(discovery.places.length, 1);

    const reviewImport = await post(baseUrl, '/api/geo/reviews/import', {
      tenant_id: tenant.id,
      place_id: discovery.places[0].id
    });
    assert.equal(reviewImport.provider_execution_mode, 'live_provider');
    assert.equal(reviewImport.reviews.length, 1);

    const places = await get(baseUrl, `/api/geo/places?tenant_id=${encodeURIComponent(tenant.id)}`);
    const reviews = await get(baseUrl, `/api/geo/reviews?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(discovery.places[0].id)}`);
    assert.equal(places.length, 1);
    assert.equal(reviews.length, 1);
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    if (previousKey == null) delete process.env.AMAP_HTTP_TEST_KEY;
    else process.env.AMAP_HTTP_TEST_KEY = previousKey;
  }
});

test('geo routing HTTP APIs manage territories coverages and handoff packets', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing HTTP 公司' });
    const session = await post(baseUrl, '/api/geo/sessions', {
      tenant_id: tenant.id,
      name: 'Shanghai clinic outreach',
      business_type: 'clinic',
      city: 'Shanghai'
    });
    const place = await post(baseUrl, '/api/geo/places', {
      tenant_id: tenant.id,
      session_id: session.session_id,
      name: 'Pudong Care Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      phone: '+86 21 5555 9999',
      rating: 4.3
    });
    await post(baseUrl, '/api/geo/reviews', {
      tenant_id: tenant.id,
      place_id: place.id,
      author_name: 'Patient A',
      rating: 2,
      content: '预约确认太慢，电话经常要打第二次。'
    });
    const insight = await post(baseUrl, '/api/geo/insights/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      offer_context: '提升电话预约跟进效率'
    });
    const draft = await post(baseUrl, '/api/geo/outreach-drafts/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      insight_id: insight.insight.id,
      product_offer: '诊所预约回访自动化与通话质检',
      channel: 'call_script'
    });
    const territory = await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-clinic',
      name: 'Shanghai Clinic Territory',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic',
      queue_route_id: 'geo-shanghai',
      voice_route_id: 'shanghai-voice',
      default_owner_user_id: 'rep_http'
    });
    const coverage = await post(baseUrl, '/api/geo/rep-coverages', {
      tenant_id: tenant.id,
      territory_id: territory.territory_id,
      coverage_id: 'rep-http',
      owner_user_id: 'rep_http',
      owner_name: 'Rep HTTP',
      channel: 'call_script',
      queue_route_id: 'geo-shanghai',
      voice_route_id: 'shanghai-voice',
      priority_weight: 110,
      daily_capacity: 12,
      active_assignments: 1
    });
    const handoff = await post(baseUrl, '/api/geo/handoffs/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      insight_id: insight.insight.id,
      draft_id: draft.draft.id,
      channel: 'call_script'
    });
    const execution = await post(baseUrl, '/api/geo/handoffs/execute', {
      tenant_id: tenant.id,
      handoff_id: handoff.handoff.id
    });

    const territories = await get(baseUrl, `/api/geo/territories?tenant_id=${encodeURIComponent(tenant.id)}`);
    const coverages = await get(baseUrl, `/api/geo/rep-coverages?tenant_id=${encodeURIComponent(tenant.id)}&territory_id=${encodeURIComponent(territory.territory_id)}`);
    const handoffs = await get(baseUrl, `/api/geo/handoffs?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(place.id)}`);

    assert.equal(territories.length, 1);
    assert.equal(coverages.length, 1);
    assert.equal(coverage.owner_user_id, 'rep_http');
    assert.equal(handoff.handoff.owner_user_id, 'rep_http');
    assert.equal(handoff.handoff.recommended_next_action, 'queue_voice_followup');
    assert.equal(execution.execution.crm_task.status, 'success');
    assert.equal(execution.execution.voice_followup.status, 'blocked_pending_approval');
    assert.equal(execution.handoff.status, 'queued');
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].payload.voice_followup.route_id, 'shanghai-voice');
    assert.equal(handoffs[0].payload.execution.crm_task.status, 'success');
    assert.equal(coverages[0].active_assignments, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo capacity HTTP APIs report and rebalance pending handoffs', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Capacity HTTP 公司' });
    const session = await post(baseUrl, '/api/geo/sessions', {
      tenant_id: tenant.id,
      name: 'Shanghai clinic rebalance',
      business_type: 'clinic',
      city: 'Shanghai'
    });
    const place = await post(baseUrl, '/api/geo/places', {
      tenant_id: tenant.id,
      session_id: session.session_id,
      name: 'Capacity HTTP Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      phone: '+86 21 5555 7777',
      rating: 4.3
    });
    await post(baseUrl, '/api/geo/reviews', {
      tenant_id: tenant.id,
      place_id: place.id,
      author_name: 'Patient A',
      rating: 2,
      content: '预约确认慢，经常需要多次跟进。'
    });
    const insight = await post(baseUrl, '/api/geo/insights/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      offer_context: '提升电话预约跟进效率'
    });
    const draft = await post(baseUrl, '/api/geo/outreach-drafts/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      insight_id: insight.insight.id,
      product_offer: '诊所预约回访自动化与通话质检',
      channel: 'call_script'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-balance',
      name: 'Shanghai HTTP Balance',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic',
      queue_route_id: 'geo-http-primary',
      voice_route_id: 'http-primary',
      default_owner_user_id: 'rep_http_primary'
    });
    await post(baseUrl, '/api/geo/rep-coverages', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-balance',
      coverage_id: 'rep-http-primary',
      owner_user_id: 'rep_http_primary',
      owner_name: 'Rep HTTP Primary',
      channel: 'call_script',
      queue_route_id: 'geo-http-primary',
      voice_route_id: 'http-primary',
      priority_weight: 220,
      daily_capacity: 1,
      active_assignments: 1
    });
    await post(baseUrl, '/api/geo/rep-coverages', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-balance',
      coverage_id: 'rep-http-backup',
      owner_user_id: 'rep_http_backup',
      owner_name: 'Rep HTTP Backup',
      channel: 'call_script',
      queue_route_id: 'geo-http-backup',
      voice_route_id: 'http-backup',
      priority_weight: 40,
      daily_capacity: 3,
      active_assignments: 0
    });
    const handoff = await post(baseUrl, '/api/geo/handoffs/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      insight_id: insight.insight.id,
      draft_id: draft.draft.id,
      channel: 'call_script'
    });

    const capacity = await get(baseUrl, `/api/geo/territories/capacity?tenant_id=${encodeURIComponent(tenant.id)}&territory_id=shanghai-http-balance`);
    const rebalance = await post(baseUrl, '/api/geo/territories/rebalance', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-balance'
    });
    const handoffs = await get(baseUrl, `/api/geo/handoffs?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(place.id)}`);

    assert.equal(capacity.recommended_moves.length, 1);
    assert.equal(capacity.recommended_moves[0].handoff_id, handoff.handoff.id);
    assert.equal(rebalance.rebalanced_count, 1);
    assert.equal(rebalance.applied_moves[0].handoff.owner_user_id, 'rep_http_backup');
    assert.equal(handoffs[0].owner_user_id, 'rep_http_backup');
    assert.equal(handoffs[0].payload.rep_coverage.coverage_id, 'rep-http-backup');
    assert.equal(handoffs[0].voice_route_id, 'http-backup');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo feedback sync HTTP API updates handoff feedback and coverage load from downstream state', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Feedback HTTP 公司' });
    const session = await post(baseUrl, '/api/geo/sessions', {
      tenant_id: tenant.id,
      name: 'Shanghai clinic feedback',
      business_type: 'clinic',
      city: 'Shanghai'
    });
    const place = await post(baseUrl, '/api/geo/places', {
      tenant_id: tenant.id,
      session_id: session.session_id,
      name: 'Feedback HTTP Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      phone: '+86 21 5555 6666',
      rating: 4.3
    });
    await post(baseUrl, '/api/geo/reviews', {
      tenant_id: tenant.id,
      place_id: place.id,
      author_name: 'Patient A',
      rating: 2,
      content: '电话回访慢。'
    });
    const insight = await post(baseUrl, '/api/geo/insights/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      offer_context: '提升电话预约跟进效率'
    });
    const draft = await post(baseUrl, '/api/geo/outreach-drafts/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      insight_id: insight.insight.id,
      product_offer: '诊所预约回访自动化与通话质检',
      channel: 'call_script'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-feedback',
      name: 'Shanghai HTTP Feedback',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic',
      queue_route_id: 'geo-http-feedback',
      voice_route_id: 'http-feedback-voice',
      default_owner_user_id: 'rep_http_feedback'
    });
    await post(baseUrl, '/api/geo/rep-coverages', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-feedback',
      coverage_id: 'rep-http-feedback',
      owner_user_id: 'rep_http_feedback',
      owner_name: 'Rep HTTP Feedback',
      channel: 'call_script',
      queue_route_id: 'geo-http-feedback',
      voice_route_id: 'http-feedback-voice',
      priority_weight: 120,
      daily_capacity: 8,
      active_assignments: 1
    });
    const handoff = await post(baseUrl, '/api/geo/handoffs/generate', {
      tenant_id: tenant.id,
      place_id: place.id,
      insight_id: insight.insight.id,
      draft_id: draft.draft.id,
      channel: 'call_script'
    });
    await post(baseUrl, '/api/geo/handoffs/execute', {
      tenant_id: tenant.id,
      handoff_id: handoff.handoff.id
    });

    const feedback = await post(baseUrl, '/api/geo/territories/feedback/sync', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-feedback'
    });
    const handoffs = await get(baseUrl, `/api/geo/handoffs?tenant_id=${encodeURIComponent(tenant.id)}&place_id=${encodeURIComponent(place.id)}`);
    const coverages = await get(baseUrl, `/api/geo/rep-coverages?tenant_id=${encodeURIComponent(tenant.id)}&territory_id=shanghai-http-feedback`);

    assert.equal(feedback.synced_handoffs.length, 1);
    assert.equal(feedback.totals.pending_voice_approvals, 1);
    assert.equal(feedback.coverage_updates[0].metadata.geo_feedback.pending_voice_approvals, 1);
    assert.equal(feedback.coverage_updates[0].active_assignments, 2);
    assert.equal(handoffs[0].payload.feedback.voice_followup.approval_status, 'pending');
    assert.equal(handoffs[0].payload.feedback.overall_status, 'active');
    assert.equal(coverages[0].metadata.geo_feedback.active_geo_assignments, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing maintenance HTTP API runs sync and rebalance across a territory', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Maintenance HTTP 公司' });
    const session = await post(baseUrl, '/api/geo/sessions', {
      tenant_id: tenant.id,
      name: 'Shanghai clinic routing maintenance',
      business_type: 'clinic',
      city: 'Shanghai'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-maintenance',
      name: 'Shanghai HTTP Maintenance',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic',
      queue_route_id: 'geo-http-maintenance-primary',
      voice_route_id: 'http-maintenance-primary',
      default_owner_user_id: 'rep_http_maintenance_primary'
    });
    await post(baseUrl, '/api/geo/rep-coverages', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-maintenance',
      coverage_id: 'rep-http-maintenance-primary',
      owner_user_id: 'rep_http_maintenance_primary',
      owner_name: 'Rep HTTP Maintenance Primary',
      channel: 'call_script',
      queue_route_id: 'geo-http-maintenance-primary',
      voice_route_id: 'http-maintenance-primary',
      priority_weight: 220,
      daily_capacity: 1,
      active_assignments: 1
    });
    await post(baseUrl, '/api/geo/rep-coverages', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-maintenance',
      coverage_id: 'rep-http-maintenance-backup',
      owner_user_id: 'rep_http_maintenance_backup',
      owner_name: 'Rep HTTP Maintenance Backup',
      channel: 'call_script',
      queue_route_id: 'geo-http-maintenance-backup',
      voice_route_id: 'http-maintenance-backup',
      priority_weight: 40,
      daily_capacity: 3,
      active_assignments: 0
    });

    async function createHandoff(name: string) {
      const place = await post(baseUrl, '/api/geo/places', {
        tenant_id: tenant.id,
        session_id: session.session_id,
        name,
        business_type: 'clinic',
        city: 'Shanghai',
        region: 'Pudong',
        address: 'Pudong New Area',
        phone: '+86 21 5555 2222',
        rating: 4.3
      });
      await post(baseUrl, '/api/geo/reviews', {
        tenant_id: tenant.id,
        place_id: place.id,
        author_name: 'Patient A',
        rating: 2,
        content: '预约确认慢。'
      });
      const insight = await post(baseUrl, '/api/geo/insights/generate', {
        tenant_id: tenant.id,
        place_id: place.id,
        offer_context: '提升电话预约跟进效率'
      });
      const draft = await post(baseUrl, '/api/geo/outreach-drafts/generate', {
        tenant_id: tenant.id,
        place_id: place.id,
        insight_id: insight.insight.id,
        product_offer: '诊所预约回访自动化与通话质检',
        channel: 'call_script'
      });
      return await post(baseUrl, '/api/geo/handoffs/generate', {
        tenant_id: tenant.id,
        place_id: place.id,
        insight_id: insight.insight.id,
        draft_id: draft.draft.id,
        channel: 'call_script'
      });
    }

    const executedHandoff = await createHandoff('Maintenance HTTP Executed');
    await createHandoff('Maintenance HTTP Pending');
    await post(baseUrl, '/api/geo/handoffs/execute', {
      tenant_id: tenant.id,
      handoff_id: executedHandoff.handoff.id
    });

    const maintenance = await post(baseUrl, '/api/geo/routing/maintenance', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-maintenance'
    });
    const coverages = await get(baseUrl, `/api/geo/rep-coverages?tenant_id=${encodeURIComponent(tenant.id)}&territory_id=shanghai-http-maintenance`);
    const handoffs = await get(baseUrl, `/api/geo/handoffs?tenant_id=${encodeURIComponent(tenant.id)}`);

    const primary = coverages.find((coverage) => coverage.coverage_id === 'rep-http-maintenance-primary');
    const backup = coverages.find((coverage) => coverage.coverage_id === 'rep-http-maintenance-backup');
    const pending = handoffs.find((handoff) => !handoff.payload?.execution);

    assert.equal(maintenance.totals.territories_processed, 1);
    assert.equal(maintenance.totals.applied_rebalances, 1);
    assert.equal(maintenance.totals.pending_voice_approvals, 1);
    assert.equal(primary.metadata.geo_feedback.pending_voice_approvals, 1);
    assert.equal(primary.active_assignments, 2);
    assert.equal(backup.metadata.geo_feedback.pending_handoffs, 1);
    assert.equal(pending.owner_user_id, 'rep_http_maintenance_backup');
    assert.equal(pending.voice_route_id, 'http-maintenance-backup');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing trigger bootstrap HTTP APIs create idempotent tenant maintenance triggers', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Trigger Bootstrap HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'shanghai-http-trigger',
      name: 'Shanghai HTTP Trigger',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic',
      queue_route_id: 'geo-http-trigger',
      voice_route_id: 'http-trigger-voice',
      default_owner_user_id: 'rep_http_trigger'
    });

    const firstBootstrap = await post(baseUrl, '/api/geo/routing/triggers/bootstrap', {
      tenant_id: tenant.id,
      scope: 'tenant',
      next_run_at: '2026-01-01T00:00:00.000Z',
      interval_seconds: 3600
    });
    const secondBootstrap = await post(baseUrl, '/api/geo/routing/triggers/bootstrap', {
      tenant_id: tenant.id,
      scope: 'tenant',
      next_run_at: '2026-01-01T00:00:00.000Z',
      interval_seconds: 3600
    });
    const routingTriggers = await get(baseUrl, `/api/geo/routing/triggers?tenant_id=${encodeURIComponent(tenant.id)}&scope=tenant`);
    const schedulerTriggers = await get(baseUrl, `/api/scheduler/triggers?tenant_id=${encodeURIComponent(tenant.id)}&playbook_id=${encodeURIComponent('ops_agent.geo_routing_maintenance.v1')}`);

    assert.equal(firstBootstrap.created_count, 1);
    assert.equal(firstBootstrap.existing_count, 0);
    assert.equal(secondBootstrap.created_count, 0);
    assert.equal(secondBootstrap.existing_count, 1);
    assert.equal(routingTriggers.length, 1);
    assert.equal(schedulerTriggers.length, 1);
    assert.equal(schedulerTriggers[0].playbook_id, 'ops_agent.geo_routing_maintenance.v1');
    assert.equal(schedulerTriggers[0].input.territory_id, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing policy HTTP APIs preview guardrails and pause out-of-policy triggers', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Policy HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'policy-http-east',
      name: 'Policy HTTP East',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'policy-http-west',
      name: 'Policy HTTP West',
      city: 'Shanghai',
      region: 'Minhang',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'policy-http-north',
      name: 'Policy HTTP North',
      city: 'Shanghai',
      region: 'Baoshan',
      business_type: 'clinic',
      status: 'archived'
    });

    const policy = await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['policy-http-east', 'policy-http-west'],
      territory_exclude_ids: ['policy-http-west'],
      auto_bootstrap: true
    });
    const preview = await get(baseUrl, `/api/geo/routing/policies/preview?tenant_id=${encodeURIComponent(tenant.id)}`);
    const rollout = await post(baseUrl, '/api/geo/routing/policies/rollout', {
      tenant_id: tenant.id,
      next_run_at: '2026-01-01T00:00:00.000Z'
    });
    const policies = await get(baseUrl, `/api/geo/routing/policies?tenant_id=${encodeURIComponent(tenant.id)}`);
    const routingTriggers = await get(baseUrl, `/api/geo/routing/triggers?tenant_id=${encodeURIComponent(tenant.id)}&scope=territory&policy_id=default`);
    const pausedPolicy = await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      paused_until: '2027-01-01T00:00:00.000Z',
      pause_reason: 'holiday freeze'
    });
    const pausedRollout = await post(baseUrl, '/api/geo/routing/policies/rollout', {
      tenant_id: tenant.id,
      next_run_at: '2026-01-02T00:00:00.000Z'
    });
    const pausedTriggers = await get(baseUrl, `/api/geo/routing/triggers?tenant_id=${encodeURIComponent(tenant.id)}&scope=territory&policy_id=default&status=paused`);

    assert.equal(policy.maintenance_scope, 'territory');
    assert.equal(policy.interval_seconds, 1800);
    assert.deepEqual(policy.territory_include_ids, ['policy-http-east', 'policy-http-west']);
    assert.deepEqual(policy.territory_exclude_ids, ['policy-http-west']);
    assert.equal(preview.totals.eligible_targets, 1);
    assert.equal(preview.eligible_targets[0].territory_id, 'policy-http-east');
    assert.equal(preview.skipped_targets.some((target) => target.territory_id === 'policy-http-west' && target.reason === 'excluded_by_policy'), true);
    assert.equal(preview.skipped_targets.some((target) => target.territory_id === 'policy-http-north' && target.reason === 'status_mismatch:archived'), true);
    assert.equal(policies.length, 1);
    assert.equal(rollout.skipped, false);
    assert.equal(rollout.bootstrap.created_count, 1);
    assert.equal(routingTriggers.length, 1);
    assert.equal(routingTriggers.every((trigger) => trigger.input.dry_run === true), true);
    assert.equal(routingTriggers.every((trigger) => trigger.playbook_id === 'ops_agent.geo_routing_maintenance.v1'), true);
    assert.equal(policies[0].last_rollout_snapshot.status, 'applied');
    assert.equal(policies[0].last_rollout_snapshot.trigger_changes.created_count, 1);
    assert.equal(pausedPolicy.paused_until, '2027-01-01T00:00:00.000Z');
    assert.equal(pausedRollout.skipped, true);
    assert.equal(pausedRollout.reason, 'holiday freeze');
    assert.equal(pausedRollout.bootstrap.paused_count, 1);
    assert.equal(pausedTriggers.length, 1);
    assert.equal(pausedTriggers[0].status, 'paused');
    assert.equal(pausedTriggers[0].input.guardrail_reason, 'holiday freeze');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing policy override HTTP APIs diff approval-gated overrides and rollback trigger state', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Override HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'override-http-east',
      name: 'Override HTTP East',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'override-http-west',
      name: 'Override HTTP West',
      city: 'Shanghai',
      region: 'Minhang',
      business_type: 'clinic'
    });

    await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['override-http-east'],
      territory_exclude_ids: ['override-http-west'],
      auto_bootstrap: true
    });
    await post(baseUrl, '/api/geo/routing/policies/rollout', {
      tenant_id: tenant.id,
      next_run_at: '2026-01-01T00:00:00.000Z'
    });

    const diff = await post(baseUrl, '/api/geo/routing/policies/overrides/diff', {
      tenant_id: tenant.id,
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['override-http-east', 'override-http-west'],
        territory_exclude_ids: []
      }
    });
    const blockedOverride = await post(baseUrl, '/api/geo/routing/policies/overrides', {
      tenant_id: tenant.id,
      reason: 'storm response override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['override-http-east', 'override-http-west'],
        territory_exclude_ids: []
      }
    });
    await post(baseUrl, `/api/approvals/${blockedOverride.approval_request.id}/decide`, {
      tenant_id: tenant.id,
      decision: 'approved',
      actor_id: 'ops_lead'
    });
    const resumedOverride = await post(baseUrl, `/api/tool-calls/${blockedOverride.approval_request.tool_call_id}/resume`, {
      tenant_id: tenant.id,
      agent_id: 'ops_agent',
      user_id: 'ops_lead',
      step_id: 'resume-override'
    });

    const blockedRollback = await post(baseUrl, `/api/geo/routing/policies/overrides/${resumedOverride.output.override.id}/rollback`, {
      tenant_id: tenant.id,
      reason: 'restore default routing posture',
      next_run_at: '2026-01-02T00:00:00.000Z'
    });
    await post(baseUrl, `/api/approvals/${blockedRollback.approval_request.id}/decide`, {
      tenant_id: tenant.id,
      decision: 'approved',
      actor_id: 'ops_lead'
    });
    const resumedRollback = await post(baseUrl, `/api/tool-calls/${blockedRollback.approval_request.tool_call_id}/resume`, {
      tenant_id: tenant.id,
      agent_id: 'ops_agent',
      user_id: 'ops_lead',
      step_id: 'resume-rollback'
    });

    const policies = await get(baseUrl, `/api/geo/routing/policies?tenant_id=${encodeURIComponent(tenant.id)}`);
    const triggers = await get(baseUrl, `/api/geo/routing/triggers?tenant_id=${encodeURIComponent(tenant.id)}&scope=territory&policy_id=default`);
    const overrides = await get(baseUrl, `/api/geo/routing/policies/overrides?tenant_id=${encodeURIComponent(tenant.id)}`);

    assert.equal(diff.diff_summary.changed_fields.some((entry) => entry.field === 'interval_seconds'), true);
    assert.deepEqual(diff.diff_summary.impact.added_targets, ['override-http-west']);
    assert.equal(blockedOverride.status, 'blocked_pending_approval');
    assert.equal(resumedOverride.status, 'success');
    assert.equal(resumedOverride.output.override.override_kind, 'policy_override');
    assert.equal(resumedOverride.output.policy.interval_seconds, 900);
    assert.equal(resumedOverride.output.rollout.bootstrap.created_count, 1);
    assert.equal(resumedOverride.output.rollout.bootstrap.updated_count, 1);
    assert.equal(blockedRollback.status, 'blocked_pending_approval');
    assert.equal(resumedRollback.status, 'success');
    assert.equal(resumedRollback.output.override.override_kind, 'policy_rollback');
    assert.equal(policies[0].interval_seconds, 1800);
    assert.equal(overrides.length, 2);
    assert.equal(overrides.some((entry) => entry.override_kind === 'policy_override' && entry.status === 'rolled_back'), true);
    assert.equal(overrides.some((entry) => entry.override_kind === 'policy_rollback' && entry.source_override_id === resumedOverride.output.override.id), true);
    assert.equal(triggers.length, 2);
    assert.equal(triggers.some((trigger) => trigger.input.territory_id === 'override-http-east' && trigger.status === 'active'), true);
    assert.equal(triggers.some((trigger) => trigger.input.territory_id === 'override-http-west' && trigger.status === 'paused'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing policy ops overview HTTP APIs expose drift pending approvals and timeline history', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Ops Visibility HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'ops-http-east',
      name: 'Ops HTTP East',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'ops-http-west',
      name: 'Ops HTTP West',
      city: 'Shanghai',
      region: 'Minhang',
      business_type: 'clinic'
    });

    await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['ops-http-east'],
      territory_exclude_ids: ['ops-http-west'],
      auto_bootstrap: true
    });

    const beforeRolloutOverview = await get(baseUrl, `/api/geo/routing/policies/ops/overview?tenant_id=${encodeURIComponent(tenant.id)}`);
    await post(baseUrl, '/api/geo/routing/policies/rollout', {
      tenant_id: tenant.id,
      next_run_at: '2026-01-01T00:00:00.000Z'
    });
    const blockedOverride = await post(baseUrl, '/api/geo/routing/policies/overrides', {
      tenant_id: tenant.id,
      reason: 'temporary spike',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['ops-http-east', 'ops-http-west'],
        territory_exclude_ids: []
      }
    });
    const pendingOverview = await get(baseUrl, `/api/geo/routing/policies/ops/overview?tenant_id=${encodeURIComponent(tenant.id)}`);
    const pendingTimeline = await get(baseUrl, `/api/geo/routing/policies/timeline?tenant_id=${encodeURIComponent(tenant.id)}`);

    await post(baseUrl, `/api/approvals/${blockedOverride.approval_request.id}/decide`, {
      tenant_id: tenant.id,
      decision: 'approved',
      actor_id: 'ops_manager'
    });
    await post(baseUrl, `/api/tool-calls/${blockedOverride.approval_request.tool_call_id}/resume`, {
      tenant_id: tenant.id,
      agent_id: 'ops_agent',
      user_id: 'ops_manager',
      step_id: 'resume-ops-visibility'
    });

    const appliedOverview = await get(baseUrl, `/api/geo/routing/policies/ops/overview?tenant_id=${encodeURIComponent(tenant.id)}`);
    const appliedTimeline = await get(baseUrl, `/api/geo/routing/policies/timeline?tenant_id=${encodeURIComponent(tenant.id)}`);

    assert.equal(beforeRolloutOverview.summary.drift_healthy, false);
    assert.equal(beforeRolloutOverview.trigger_drift.missing_active_targets.length, 1);
    assert.equal(beforeRolloutOverview.trigger_drift.missing_active_targets[0].territory_id, 'ops-http-east');
    assert.equal(pendingOverview.summary.pending_approval_count, 1);
    assert.equal(pendingOverview.pending_approvals[0].action_type, 'geo.override_routing_policy');
    assert.equal(pendingOverview.rollout_history[0].event_type, 'policy_rollout_snapshot');
    assert.equal(pendingTimeline.events.some((event) => event.event_type === 'approval_request' && event.status === 'pending'), true);
    assert.equal(appliedOverview.summary.pending_approval_count, 0);
    assert.equal(appliedOverview.summary.override_count, 1);
    assert.equal(appliedOverview.summary.drift_healthy, true);
    assert.equal(appliedOverview.overrides_recent[0].override_kind, 'policy_override');
    assert.equal(appliedOverview.preview.totals.eligible_targets, 2);
    assert.equal(appliedTimeline.events.some((event) => event.event_type === 'policy_override' && event.status === 'applied'), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing policy review HTTP APIs expose queue state and drift acknowledgements', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Review HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'review-http-east',
      name: 'Review HTTP East',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'review-http-west',
      name: 'Review HTTP West',
      city: 'Shanghai',
      region: 'Minhang',
      business_type: 'clinic'
    });

    await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['review-http-east'],
      territory_exclude_ids: ['review-http-west'],
      auto_bootstrap: true
    });

    const blockedOverride = await post(baseUrl, '/api/geo/routing/policies/overrides', {
      tenant_id: tenant.id,
      reason: 'review queue spike',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['review-http-east', 'review-http-west'],
        territory_exclude_ids: []
      }
    });

    const initialReview = await get(baseUrl, `/api/geo/routing/policies/review?tenant_id=${encodeURIComponent(tenant.id)}`);
    const driftItem = initialReview.items.find((item) => item.review_key === 'drift:missing_active_target:review-http-east');
    const pendingApprovalItem = initialReview.items.find((item) => item.item_type === 'pending_approval');
    const savedPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans', {
      tenant_id: tenant.id,
      plan_name: 'Review queue operator context plan',
      notes: 'Carries current execution target into review queue',
      items: [
        {
          review_key: driftItem.review_key,
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: pendingApprovalItem.review_key,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    });
    const targetedReview = await get(baseUrl, `/api/geo/routing/policies/review?tenant_id=${encodeURIComponent(tenant.id)}`);
    const targetedDriftItem = targetedReview.items.find((item) => item.review_key === driftItem.review_key);

    const acknowledged = await post(baseUrl, '/api/geo/routing/policies/review/acknowledge', {
      tenant_id: tenant.id,
      review_key: 'drift:missing_active_target:review-http-east',
      item_status: 'acknowledged',
      note: 'Ops saw the drift before rollout'
    });

    await post(baseUrl, `/api/approvals/${blockedOverride.approval_request.id}/decide`, {
      tenant_id: tenant.id,
      decision: 'approved',
      actor_id: 'ops_manager'
    });
    const resumedOverride = await post(baseUrl, `/api/tool-calls/${blockedOverride.approval_request.tool_call_id}/resume`, {
      tenant_id: tenant.id,
      agent_id: 'ops_agent',
      user_id: 'ops_manager',
      step_id: 'resume-review-queue'
    });

    const appliedReview = await get(baseUrl, `/api/geo/routing/policies/review?tenant_id=${encodeURIComponent(tenant.id)}`);

    assert.equal(initialReview.summary.open_items, 2);
    assert.equal(initialReview.summary.pending_approval_items, 1);
    assert.equal(initialReview.summary.drift_items, 1);
    assert.equal(driftItem.severity, 'critical');
    assert.equal(pendingApprovalItem.context.approval_request_id, blockedOverride.approval_request.id);
    assert.equal(pendingApprovalItem.suggested_actions.some((action) => action.endpoint === `/api/approvals/${blockedOverride.approval_request.id}/decide`), true);
    assert.equal(targetedReview.summary.current_target_plan_id, savedPlan.plan.id);
    assert.equal(targetedReview.report_summary.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(targetedDriftItem.operator_context.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(targetedReview.report_summary.target_event_count > 0, true);
    assert.equal(acknowledged.item.review_status, 'acknowledged');
    assert.equal(acknowledged.target_snapshot_before.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(acknowledged.target_snapshot_after.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(acknowledged.target_transition.changed, false);
    assert.equal(acknowledged.decision_diff.review_status_changed, true);
    assert.equal(acknowledged.decision_diff.target_changed, false);
    assert.equal(acknowledged.item.review_note, 'Ops saw the drift before rollout');
    assert.equal(acknowledged.summary.open_items, 1);
    assert.equal(acknowledged.summary.acknowledged_items, 1);
    assert.equal(resumedOverride.output.override.override_kind, 'policy_override');
    assert.equal(appliedReview.summary.pending_approval_items, 0);
    assert.equal(appliedReview.summary.drift_items, 0);
    assert.equal(appliedReview.summary.current_target_plan_id, savedPlan.plan.id);
    assert.equal(appliedReview.items.some((item) => item.item_type === 'override_change' && item.source_id === resumedOverride.output.override.id), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing policy action workbench HTTP APIs execute rollout approval-resume and rollback launch safely', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Action HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'action-http-east',
      name: 'Action HTTP East',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'action-http-west',
      name: 'Action HTTP West',
      city: 'Shanghai',
      region: 'Minhang',
      business_type: 'clinic'
    });

    await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['action-http-east'],
      territory_exclude_ids: ['action-http-west'],
      auto_bootstrap: true
    });

    const initialWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const initialDriftItem = initialWorkbench.items.find((item) => item.review_key === 'drift:missing_active_target:action-http-east');
    const savedPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans', {
      tenant_id: tenant.id,
      plan_name: 'Action workbench operator context plan',
      notes: 'Carries current execution target into action workbench',
      items: [
        {
          review_key: initialDriftItem.review_key,
          action_id: 'rollout_policy_from_review'
        }
      ]
    });
    const targetedWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const driftItem = targetedWorkbench.items.find((item) => item.review_key === 'drift:missing_active_target:action-http-east');
    const rolloutAction = driftItem.executable_actions.find((action) => action.action_id === 'rollout_policy_from_review');
    const rolloutResult = await post(baseUrl, '/api/geo/routing/policies/review/actions/execute', {
      tenant_id: tenant.id,
      review_key: driftItem.review_key,
      action_id: rolloutAction.action_id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager'
    });
    const afterRolloutWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);

    const blockedOverride = await post(baseUrl, '/api/geo/routing/policies/overrides', {
      tenant_id: tenant.id,
      reason: 'action workbench override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['action-http-east', 'action-http-west'],
        territory_exclude_ids: []
      }
    });
    const approvalWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const approvalItem = approvalWorkbench.items.find((item) => item.item_type === 'pending_approval');
    const approveAction = approvalItem.executable_actions.find((action) => action.action_id === 'approve_and_resume_pending_approval');
    const approved = await post(baseUrl, '/api/geo/routing/policies/review/actions/execute', {
      tenant_id: tenant.id,
      review_key: approvalItem.review_key,
      action_id: approveAction.action_id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager'
    });

    const overrideWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const overrideItem = overrideWorkbench.items.find((item) => item.item_type === 'override_change' && item.source_id === approved.result.resumed.output.override.id);
    const rollbackAction = overrideItem.executable_actions.find((action) => action.action_id === 'launch_rollback_from_review');
    const rollbackLaunch = await post(baseUrl, '/api/geo/routing/policies/review/actions/execute', {
      tenant_id: tenant.id,
      review_key: overrideItem.review_key,
      action_id: rollbackAction.action_id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      reason: 'Rollback from HTTP action workbench test'
    });
    const afterRollbackWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const actionHistory = await get(baseUrl, `/api/geo/routing/policies/review/actions/history?tenant_id=${encodeURIComponent(tenant.id)}`);
    const guardedOverrideItem = afterRollbackWorkbench.items.find((item) => item.review_key === overrideItem.review_key);
    const guardedRollbackAction = guardedOverrideItem.actions.find((action) => action.action_id === 'launch_rollback_from_review');

    assert.equal(initialWorkbench.summary.rollout_actions, 1);
    assert.equal(targetedWorkbench.summary.current_target_plan_id, savedPlan.plan.id);
    assert.equal(targetedWorkbench.report_summary.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(driftItem.operator_context.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(rolloutAction.operator_context.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(rolloutResult.result.rollout.status, 'success');
    assert.equal(rolloutResult.target_snapshot_before.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(rolloutResult.target_snapshot_after.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(rolloutResult.target_transition.changed, false);
    assert.equal(rolloutResult.result.rollout.output.bootstrap.created_count, 1);
    assert.equal(rolloutResult.action_history.status, 'succeeded');
    assert.equal(afterRolloutWorkbench.items.some((item) => item.review_key === 'drift:missing_active_target:action-http-east'), false);
    assert.equal(blockedOverride.status, 'blocked_pending_approval');
    assert.equal(approvalWorkbench.summary.approve_and_resume_actions, 1);
    assert.equal(approvalItem.context.approval_request_id, blockedOverride.approval_request.id);
    assert.equal(approvalItem.operator_context.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(approved.result.approval_request.status, 'approved');
    assert.equal(approved.target_snapshot_before.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(approved.target_snapshot_after.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(approved.result.resumed.status, 'success');
    assert.equal(approved.result.resumed.output.override.override_kind, 'policy_override');
    assert.equal(approved.action_history.status, 'succeeded');
    assert.equal(overrideWorkbench.summary.rollback_actions, 1);
    assert.equal(rollbackLaunch.result.rollback.status, 'blocked_pending_approval');
    assert.equal(rollbackLaunch.target_snapshot_after.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(rollbackLaunch.result.rollback.approval_request.action_type, 'geo.rollback_routing_policy_override');
    assert.equal(rollbackLaunch.action_history.status, 'blocked_pending_approval');
    assert.equal(afterRollbackWorkbench.summary.approve_and_resume_actions, 1);
    assert.equal(afterRollbackWorkbench.summary.history_entries, 3);
    assert.equal(guardedOverrideItem.latest_action.status, 'blocked_pending_approval');
    assert.equal(guardedOverrideItem.latest_action.target_plan_id_at_execution, savedPlan.plan.id);
    assert.equal(guardedOverrideItem.latest_action.target_changed_since_execution, false);
    assert.equal(guardedRollbackAction.executable, false);
    assert.equal(guardedRollbackAction.repeat_guard_reason, 'latest_action_pending_followup');
    assert.equal(guardedRollbackAction.latest_execution.target_plan_id_at_execution, savedPlan.plan.id);
    assert.equal(actionHistory.summary.total_entries, 3);
    assert.equal(actionHistory.summary.succeeded_entries, 2);
    assert.equal(actionHistory.summary.blocked_entries, 1);
    assert.equal(actionHistory.summary.entries_with_execution_target_snapshot, 3);
    assert.equal(actionHistory.summary.entries_with_target_change_since_execution, 0);
    assert.equal(actionHistory.summary.current_target_plan_id, savedPlan.plan.id);
    assert.equal(actionHistory.report_summary.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(actionHistory.entries[0].operator_context.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(actionHistory.entries[0].execution_target_context.target_snapshot_after.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(actionHistory.entries[0].historical_current_target_diff.current_target_plan_id, savedPlan.plan.id);
    assert.equal(actionHistory.entries[0].historical_current_target_diff.changed, false);
    const shiftedTargetPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans', {
      tenant_id: tenant.id,
      plan_name: 'Action HTTP shifted target plan',
      preferred: true,
      actor_id: 'ops_manager',
      preference_reason: 'audit_target_shift',
      items: [
        {
          review_key: overrideItem.review_key,
          action_id: rollbackAction.action_id,
          force_repeat: true
        }
      ]
    });
    const driftedActionHistory = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/history?tenant_id=${encodeURIComponent(tenant.id)}&target_changed_since_execution=true&target_event_limit=20`
    );
    const driftOnlyActionHistory = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/history?tenant_id=${encodeURIComponent(tenant.id)}&target_drift_only=true&target_event_limit=20`
    );
    const afterTargetShiftWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}&target_event_limit=20`);
    const targetAuditPacket = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/target-audit-packet?tenant_id=${encodeURIComponent(tenant.id)}&target_event_limit=20`
    );

    assert.equal(shiftedTargetPlan.plan.status, 'active');
    assert.equal(driftedActionHistory.summary.total_entries, 3);
    assert.equal(driftedActionHistory.summary.returned_entries, 3);
    assert.equal(driftedActionHistory.summary.target_changed_since_execution_filter, true);
    assert.equal(driftedActionHistory.summary.entries_with_target_plan_drift, 3);
    assert.equal(driftedActionHistory.summary.entries_with_target_governance_events_after_execution, 3);
    assert.equal(driftedActionHistory.target_audit_summary.latest_target_plan_drift.target_plan_id_at_execution, savedPlan.plan.id);
    assert.equal(driftedActionHistory.entries[0].historical_current_target_diff.target_plan_changed, true);
    assert.equal(driftedActionHistory.entries[0].historical_current_target_diff.execution_target_plan_id, savedPlan.plan.id);
    assert.equal(driftedActionHistory.entries[0].historical_current_target_diff.current_target_plan_id, shiftedTargetPlan.plan.id);
    assert.equal(driftedActionHistory.entries[0].target_governance_trail.has_target_plan_drift, true);
    assert.equal(driftedActionHistory.entries[0].target_governance_trail.latest_event_after_execution.event_type, 'batch_plan_preferred');
    assert.equal(driftedActionHistory.entries[0].target_governance_trail.latest_event_after_execution.touches_current_target, true);
    assert.equal(driftOnlyActionHistory.summary.returned_entries, 3);
    assert.equal(driftOnlyActionHistory.summary.target_drift_only_filter, true);
    assert.equal(afterTargetShiftWorkbench.summary.history_entries_with_target_plan_drift, 3);
    assert.equal(afterTargetShiftWorkbench.target_audit_summary.entries_with_target_plan_drift, 3);
    assert.equal(afterTargetShiftWorkbench.target_drift_history[0].historical_current_target_diff.current_target_plan_id, shiftedTargetPlan.plan.id);
    assert.equal(targetAuditPacket.export_metadata.packet_type, 'geo_routing_policy_target_audit');
    assert.equal(targetAuditPacket.target_audit_summary.entries_with_target_plan_drift, 3);
    assert.equal(targetAuditPacket.sla_rollup.drifted_execution_count, 3);
    assert.equal(targetAuditPacket.remediation_suggestions.some((suggestion) => suggestion.reason === 'execution_target_drifted_from_current_target'), true);
    assert.equal(targetAuditPacket.audit_trail.drifted_action_history[0].historical_current_target_diff.current_target_plan_id, shiftedTargetPlan.plan.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('geo routing policy batch planning and batch action HTTP APIs preview save and execute guarded multi-item plans', async () => {
  const db = createDatabase(':memory:');
  const server = createServer(db);
  const port = await listenOnRandomPort(server);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const tenant = await post(baseUrl, '/api/tenants', { name: 'Geo Routing Batch HTTP 公司' });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'batch-http-east',
      name: 'Batch HTTP East',
      city: 'Shanghai',
      region: 'Pudong',
      business_type: 'clinic'
    });
    await post(baseUrl, '/api/geo/territories', {
      tenant_id: tenant.id,
      territory_id: 'batch-http-west',
      name: 'Batch HTTP West',
      city: 'Shanghai',
      region: 'Minhang',
      business_type: 'clinic'
    });

    await post(baseUrl, '/api/geo/routing/policies', {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['batch-http-east'],
      territory_exclude_ids: ['batch-http-west'],
      auto_bootstrap: true
    });

    const blockedOverride = await post(baseUrl, '/api/geo/routing/policies/overrides', {
      tenant_id: tenant.id,
      reason: 'batch action override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['batch-http-east', 'batch-http-west'],
        territory_exclude_ids: []
      }
    });

    const batchPreview = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans/preview', {
      tenant_id: tenant.id,
      items: [
        {
          review_key: 'drift:missing_active_target:batch-http-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    });
    const savedPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      plan_name: 'HTTP mixed-risk batch plan',
      notes: 'Preview and reuse mixed-risk rollout + approval flow',
      items: [
        {
          review_key: 'drift:missing_active_target:batch-http-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    });
    const listedPlans = await get(baseUrl, `/api/geo/routing/policies/review/actions/plans?tenant_id=${encodeURIComponent(tenant.id)}`);
    const rolloutFromWorkbench = await post(baseUrl, '/api/geo/routing/policies/review/actions/execute', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      review_key: 'drift:missing_active_target:batch-http-east',
      action_id: 'rollout_policy_from_review'
    });
    const stalePreview = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans/preview', {
      tenant_id: tenant.id,
      plan_id: savedPlan.plan.id
    });
    const staleResponse = await fetch(`${baseUrl}/api/geo/routing/policies/review/actions/batch/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenant.id,
        actor_id: 'ops_manager',
        user_id: 'ops_manager',
        plan_id: savedPlan.plan.id
      })
    });
    await staleResponse.json();
    const refreshedPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans/refresh', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      plan_id: savedPlan.plan.id,
      refresh_mode: 'supersede'
    });
    const refreshedPlans = await get(baseUrl, `/api/geo/routing/policies/review/actions/plans?tenant_id=${encodeURIComponent(tenant.id)}`);
    const resolvedTarget = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/target?tenant_id=${encodeURIComponent(tenant.id)}`
    );
    const archivedPlanDetail = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/detail?tenant_id=${encodeURIComponent(tenant.id)}&plan_id=${encodeURIComponent(savedPlan.plan.id)}`
    );
    const archivedPlanLineage = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/lineage?tenant_id=${encodeURIComponent(tenant.id)}&plan_id=${encodeURIComponent(savedPlan.plan.id)}`
    );
    const activeLineage = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/lineage?tenant_id=${encodeURIComponent(tenant.id)}&plan_id=${encodeURIComponent(savedPlan.plan.id)}&status=active`
    );
    const batchResult = await post(baseUrl, '/api/geo/routing/policies/review/actions/batch/execute', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      plan_target: 'preferred'
    });

    const postBatchWorkbench = await get(baseUrl, `/api/geo/routing/policies/review/actions?tenant_id=${encodeURIComponent(tenant.id)}`);
    const overrideItem = postBatchWorkbench.items.find((item) => item.item_type === 'override_change');
    const rollbackBatch = await post(baseUrl, '/api/geo/routing/policies/review/actions/batch/execute', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      items: [
        {
          review_key: overrideItem.review_key,
          action_id: 'launch_rollback_from_review',
          reason: 'Rollback from batch action test'
        }
      ]
    });
    const repeatGuarded = await post(baseUrl, '/api/geo/routing/policies/review/actions/batch/execute', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      items: [
        {
          review_key: overrideItem.review_key,
          action_id: 'launch_rollback_from_review'
        }
      ],
      continue_on_error: true
    });
    const actionHistory = await get(baseUrl, `/api/geo/routing/policies/review/actions/history?tenant_id=${encodeURIComponent(tenant.id)}`);

    assert.equal(batchPreview.summary.total_selected, 2);
    assert.equal(batchPreview.summary.ready_items, 2);
    assert.equal(batchPreview.summary.mixed_risk.R1, 1);
    assert.equal(batchPreview.summary.mixed_risk.R3, 1);
    assert.equal(batchPreview.summary.action_mix.rollout_policy_from_review, 1);
    assert.equal(batchPreview.summary.action_mix.approve_and_resume_pending_approval, 1);
    assert.equal(savedPlan.plan.plan_name, 'HTTP mixed-risk batch plan');
    assert.equal(savedPlan.preview.summary.plan_ready, true);
    assert.equal(savedPlan.preview.summary.current_target_plan_id, null);
    assert.equal(savedPlan.preview.report_summary.current_execution_target, null);
    assert.equal(listedPlans.summary.total_plans, 1);
    assert.equal(listedPlans.summary.current_target_plan_id, savedPlan.plan.id);
    assert.equal(listedPlans.report_summary.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(listedPlans.plans[0].selection_summary.total_selected, 2);
    assert.equal(listedPlans.plans[0].report_summary.current_roles.includes('current_target'), true);
    assert.equal(listedPlans.plans[0].report_summary.last_target_change_reason, 'initial_active_plan');
    assert.equal(rolloutFromWorkbench.result.rollout.status, 'success');
    assert.equal(stalePreview.source, 'saved_plan');
    assert.equal(stalePreview.freshness.stale, true);
    assert.equal(stalePreview.freshness.requires_confirmation, true);
    assert.equal(stalePreview.freshness.missing_review_items, 1);
    assert.equal(stalePreview.freshness.blocking_changes, 1);
    assert.equal(stalePreview.summary.current_target_plan_id, savedPlan.plan.id);
    assert.equal(stalePreview.report_summary.source_alignment.source_plan_id, savedPlan.plan.id);
    assert.equal(stalePreview.report_summary.source_alignment.source_matches_current_target, true);
    assert.equal(stalePreview.freshness.changed_items[0].changes.some((change) => change.field === 'status'), true);
    assert.equal(staleResponse.ok, false);
    assert.equal(refreshedPlan.refresh_mode, 'supersede');
    assert.equal(refreshedPlan.refresh_selection.summary.kept_items, 1);
    assert.equal(refreshedPlan.refresh_selection.summary.dropped_missing_items, 1);
    assert.equal(refreshedPlan.archived_plan.status, 'archived');
    assert.equal(refreshedPlan.archived_plan.metadata.superseded_by_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(refreshedPlan.report_summary.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(refreshedPlan.report_summary.refreshed_plan.current_roles.includes('current_target'), true);
    assert.equal(refreshedPlan.report_summary.archived_plan.target_fallback_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(refreshedPlan.preview_after.freshness.stale, false);
    assert.equal(refreshedPlans.summary.total_plans, 2);
    assert.equal(refreshedPlans.summary.active_plans, 1);
    assert.equal(refreshedPlans.summary.archived_plans, 1);
    assert.equal(refreshedPlans.summary.current_target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(refreshedPlans.report_summary.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(resolvedTarget.summary.target, 'recommended');
    assert.equal(resolvedTarget.summary.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(resolvedTarget.recommended_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanDetail.plan.status, 'archived');
    assert.equal(archivedPlanDetail.plan.target_state.current_roles.includes('archived'), true);
    assert.equal(archivedPlanDetail.relationships.root_plan.id, savedPlan.plan.id);
    assert.equal(archivedPlanDetail.relationships.successor.id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanDetail.relationships.latest_active_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanDetail.relationships.recommended_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanDetail.target_drilldown.current_execution_target.summary.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanDetail.target_drilldown.anchor_plan_state.archive.target_fallback_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanLineage.summary.total_related_plans, 2);
    assert.equal(archivedPlanLineage.summary.current_is_archived, true);
    assert.equal(archivedPlanLineage.summary.current_target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanLineage.latest_active_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(archivedPlanLineage.target_drilldown.current_execution_target.summary.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(activeLineage.summary.displayed_plans, 1);
    assert.equal(activeLineage.plans[0].status, 'active');
    assert.equal(activeLineage.plans[0].is_recommended_plan, true);
    assert.equal(batchResult.plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(batchResult.plan_preflight.stale, false);
    assert.equal(batchResult.plan_preflight.requires_confirmation, false);
    assert.equal(batchResult.target_snapshot_before.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(batchResult.target_snapshot_after.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(batchResult.target_transition.changed, false);
    assert.equal(batchResult.report_summary.source_alignment.current_target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(batchResult.summary.succeeded_items, 1);
    assert.equal(batchResult.summary.failed_items, 0);
    assert.equal(batchResult.action_history.summary.total_entries, 2);
    assert.equal(batchResult.workbench.summary.rollback_actions, 1);
    assert.equal(batchResult.results[0].output.target_snapshot_after.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(rollbackBatch.summary.blocked_items, 1);
    assert.equal(rollbackBatch.target_snapshot_before.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(rollbackBatch.results[0].status, 'blocked_pending_approval');
    assert.equal(repeatGuarded.summary.failed_items, 1);
    assert.equal(repeatGuarded.target_snapshot_after.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(repeatGuarded.summary.processed_items, 1);
    assert.equal(repeatGuarded.results[0].error.message.includes('repeat-guarded'), true);
    assert.equal(actionHistory.summary.total_entries, 3);
    assert.equal(actionHistory.summary.succeeded_entries, 2);
    assert.equal(actionHistory.summary.blocked_entries, 1);

    const restoredPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans/govern', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      plan_id: savedPlan.plan.id,
      action: 'restore'
    });
    const plansAfterRestore = await get(baseUrl, `/api/geo/routing/policies/review/actions/plans?tenant_id=${encodeURIComponent(tenant.id)}`);
    const promotedPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans/govern', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      plan_id: savedPlan.plan.id,
      action: 'promote'
    });
    const promotedDetail = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/detail?tenant_id=${encodeURIComponent(tenant.id)}&plan_id=${encodeURIComponent(savedPlan.plan.id)}`
    );
    const promotedTarget = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/target?tenant_id=${encodeURIComponent(tenant.id)}&plan_target=preferred`
    );
    const reArchivedPlan = await post(baseUrl, '/api/geo/routing/policies/review/actions/plans/govern', {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      user_id: 'ops_manager',
      plan_id: savedPlan.plan.id,
      action: 'archive',
      reason: 'Retire restored fallback plan'
    });
    const finalDetail = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/detail?tenant_id=${encodeURIComponent(tenant.id)}&plan_id=${encodeURIComponent(savedPlan.plan.id)}`
    );
    const finalTarget = await get(
      baseUrl,
      `/api/geo/routing/policies/review/actions/plans/target?tenant_id=${encodeURIComponent(tenant.id)}&plan_target=recommended`
    );
    const finalOverview = await get(
      baseUrl,
      `/api/geo/routing/policies/ops/overview?tenant_id=${encodeURIComponent(tenant.id)}`
    );
    const finalTimeline = await get(
      baseUrl,
      `/api/geo/routing/policies/timeline?tenant_id=${encodeURIComponent(tenant.id)}`
    );
    const archivedExecuteResponse = await fetch(`${baseUrl}/api/geo/routing/policies/review/actions/batch/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tenant_id: tenant.id,
        actor_id: 'ops_manager',
        user_id: 'ops_manager',
        plan_id: savedPlan.plan.id
      })
    });

    assert.equal(restoredPlan.action, 'restore');
    assert.equal(restoredPlan.plan_after.status, 'active');
    assert.equal(restoredPlan.plan_after.is_preferred, false);
    assert.equal(plansAfterRestore.summary.total_plans, 2);
    assert.equal(plansAfterRestore.summary.active_plans, 2);
    assert.equal(plansAfterRestore.summary.preferred_plans, 1);
    assert.equal(promotedPlan.action, 'promote');
    assert.equal(promotedPlan.plan_after.is_preferred, true);
    assert.equal(promotedPlan.report_summary.current_execution_target.target_plan_id, savedPlan.plan.id);
    assert.equal(promotedPlan.report_summary.plan_after.current_roles.includes('current_target'), true);
    assert.equal(promotedPlan.lineage.summary.current_is_preferred, true);
    assert.equal(promotedPlan.lineage.summary.preferred_active_plan_id, savedPlan.plan.id);
    assert.equal(promotedDetail.relationships.preferred_active_plan.id, savedPlan.plan.id);
    assert.equal(promotedDetail.relationships.recommended_plan.id, savedPlan.plan.id);
    assert.equal(promotedDetail.plan.target_state.current_roles.includes('current_target'), true);
    assert.equal(promotedDetail.plan.target_state.preference.preference_reason, 'manual_promote');
    assert.equal(promotedTarget.target_plan.id, savedPlan.plan.id);
    assert.equal(promotedTarget.summary.resolution_reason, 'preferred_active_plan');
    assert.equal(reArchivedPlan.action, 'archive');
    assert.equal(reArchivedPlan.plan_after.status, 'archived');
    assert.equal(reArchivedPlan.auto_preferred_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(reArchivedPlan.report_summary.current_execution_target.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(reArchivedPlan.report_summary.plan_after.target_fallback_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalDetail.plan.status, 'archived');
    assert.equal(finalDetail.relationships.preferred_active_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalDetail.relationships.recommended_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalDetail.plan.target_state.archive.target_fallback_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalTarget.target_plan.id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalOverview.current_execution_target.summary.target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalOverview.summary.current_target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(finalOverview.summary.current_target_resolution_reason, 'preferred_active_plan');
    assert.equal(finalOverview.target_governance.summary.total_plans, 2);
    assert.equal(
      finalOverview.target_governance.recent_events.some((event) => event.event_type === 'batch_plan_preferred' && event.plan_id === savedPlan.plan.id),
      true
    );
    assert.equal(
      finalOverview.target_governance.recent_events.some((event) => event.event_type === 'batch_plan_archived' && event.payload.target_fallback_plan_id === refreshedPlan.refreshed_plan.id),
      true
    );
    assert.equal(finalTimeline.batch_plan_targeting.summary.current_target_plan_id, refreshedPlan.refreshed_plan.id);
    assert.equal(
      finalTimeline.events.some((event) => event.event_type === 'batch_plan_refreshed' && event.plan_id === refreshedPlan.refreshed_plan.id),
      true
    );
    assert.equal(
      finalTimeline.events.some((event) => event.event_type === 'batch_plan_archived' && event.payload.target_fallback_plan_id === refreshedPlan.refreshed_plan.id),
      true
    );
    assert.equal(archivedExecuteResponse.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function toolContext(tenantId, agentId, stepId) {
  return {
    tenantId,
    workspaceId: 'default',
    userId: 'geo_user',
    agentId,
    workflowRunId: null,
    agentRunId: null,
    playbookId: 'manual',
    stepId
  };
}

async function post<T = any>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function get<T = any>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  const data = (await response.json()) as T;
  assert.equal(response.ok, true, JSON.stringify(data));
  return data;
}

async function readJsonBody(req: AsyncIterable<Uint8Array | string>): Promise<any> {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
