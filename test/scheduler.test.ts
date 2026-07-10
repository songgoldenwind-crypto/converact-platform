import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { all, one, parseJson } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('scheduler heartbeat runs due triggers through playbooks and advances next run', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler 测试公司' });
  const harness = createHarness(db);

  const trigger = harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: '每日周报心跳',
    playbook_id: 'analytics_agent.weekly_review.v1',
    goal: '每天生成一次经营复盘',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(tick.status, 'completed');
  assert.equal(tick.due, 1);
  assert.equal(tick.results[0].status, 'completed');

  const updatedTrigger = harness.triggerRunner.getScheduledTrigger(tenant.id, trigger.id);
  assert.equal(updatedTrigger.next_run_at, '2026-01-01T01:00:00.000Z');
  assert.ok(updatedTrigger.last_run_at);

  const schedulerRuns = all(db, 'SELECT * FROM scheduler_runs WHERE tenant_id = ?', [tenant.id]);
  assert.equal(schedulerRuns.length, 1);
  assert.equal(schedulerRuns[0].status, 'completed');
  const schedulerResult = parseJson(schedulerRuns[0].result) as { status: string };
  assert.equal(schedulerResult.status, 'completed');

  const artifactCount = one(db, 'SELECT COUNT(*) AS count FROM agent_artifacts WHERE tenant_id = ?', [tenant.id]);
  assert.equal(artifactCount.count, 1);
});

test('scheduler tick records failed trigger execution without hiding the error', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Failure 测试公司' });
  const harness = createHarness(db);

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: '错误 playbook',
    playbook_id: 'missing.playbook.v1',
    goal: '触发失败路径',
    next_run_at: '2026-01-01T00:00:00.000Z'
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(tick.status, 'completed_with_failures');
  assert.equal(tick.results[0].status, 'failed');
  assert.match(tick.results[0].error.message, /playbook not found/);

  const schedulerRun = one(db, 'SELECT * FROM scheduler_runs WHERE tenant_id = ?', [tenant.id]);
  assert.equal(schedulerRun.status, 'failed');
  const schedulerError = parseJson(schedulerRun.error) as { message: string };
  assert.match(schedulerError.message, /playbook not found/);
});

test('scheduler can run voice recording retention maintenance playbook', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Voice Retention 公司' });
  const harness = createHarness(db);

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-policy'),
    'voice.policy_upsert',
    {
      tenant_id: tenant.id,
      recording_mode: 'always',
      recording_retention_days: 7
    }
  );
  const session = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-session', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.rustpbx_create_call_session',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_scheduler',
      phone: '+1 415 555 0104',
      rustpbx_call_id: 'scheduler-call-1',
      status: 'completed'
    }
  );
  const recording = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-recording', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_ingest',
    {
      tenant_id: tenant.id,
      call_session_id: session.output.id,
      provider_recording_id: 'scheduler-rec-1',
      recording_url: 'https://voice.local/scheduler-rec-1.wav',
      duration_seconds: 60,
      retention_until: '2026-01-01T00:00:00.000Z'
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Voice retention maintenance',
    playbook_id: 'ops_agent.voice_recording_retention_maintenance.v1',
    goal: 'Expire overdue voice recordings',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      action: 'expire',
      due_before: '2026-01-01T00:00:00.000Z'
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(harness.voiceStore.getRecording(tenant.id, recording.output.id).status, 'expired');

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report'`, [tenant.id]);
  assert.equal(Boolean(artifact), true);
  const maintenancePayload = parseJson(artifact.payload) as { maintenance_type: string };
  assert.equal(maintenancePayload.maintenance_type, 'voice_recording_retention');
});

test('scheduler can run voice recording archive maintenance playbook through the media sidecar', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Voice Archive 公司' });
  const previousMediaToken = process.env.SCHEDULER_VOICE_MEDIA_TOKEN;
  process.env.SCHEDULER_VOICE_MEDIA_TOKEN = 'scheduler-voice-media-token';
  const seenRequests = [];
  const mediaServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== 'Bearer scheduler-voice-media-token') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.url === '/recordings/archive') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'archived',
        archived_recording_url: `${body.archive_url_base}/${body.provider_recording_id}`,
        boundary: 'rust_media'
      }));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const mediaBaseUrl = `http://127.0.0.1:${await listenOnRandomPort(mediaServer)}`;
  const harness = createHarness(db, { voiceMedia: { baseUrl: mediaBaseUrl } });

  try {
    const mediaSecret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'archive-media-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        secret_key: 'media_api_token',
        secret_value: 'scheduler-voice-media-token',
        env_var_name: 'SCHEDULER_VOICE_MEDIA_TOKEN'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'archive-media-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        status: 'configured',
        config: {
          media_service_url: mediaBaseUrl,
          recording_archive_url_base: 's3://voice-archive/scheduler'
        },
        secret_ref_ids: [mediaSecret.output.id]
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'archive-voice-policy'),
      'voice.policy_upsert',
      {
        tenant_id: tenant.id,
        recording_mode: 'always',
        recording_retention_days: 7
      }
    );
    const session = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'archive-voice-session', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.rustpbx_create_call_session',
      {
        tenant_id: tenant.id,
        lead_id: 'lead_scheduler_archive',
        phone: '+1 415 555 0106',
        rustpbx_call_id: 'scheduler-archive-call-1',
        status: 'completed'
      }
    );
    const recording = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'archive-voice-recording', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.recording_ingest',
      {
        tenant_id: tenant.id,
        call_session_id: session.output.id,
        provider_recording_id: 'scheduler-archive-rec-1',
        recording_url: 'https://voice.local/scheduler-archive-rec-1.wav',
        duration_seconds: 42,
        retention_until: '2026-01-01T00:00:00.000Z'
      }
    );

    harness.triggerRunner.createScheduledTrigger({
      tenant_id: tenant.id,
      name: 'Voice archive maintenance',
      playbook_id: 'ops_agent.voice_recording_archive_maintenance.v1',
      goal: 'Archive overdue voice recordings',
      interval_seconds: 3600,
      next_run_at: '2026-01-01T00:00:00.000Z'
    });

    const tick = await harness.triggerRunner.tick({
      tenant_id: tenant.id,
      now: '2026-01-01T00:00:00.000Z'
    });

    assert.equal(tick.status, 'completed');
    assert.equal(tick.results[0].status, 'completed');
    assert.equal(harness.voiceStore.getRecording(tenant.id, recording.output.id).status, 'archived');
    assert.equal(harness.voiceStore.getRecording(tenant.id, recording.output.id).metadata.retention_boundary, 'rust_media');
    assert.equal(seenRequests[0].url, '/recordings/archive');

    const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report'`, [tenant.id]);
    const maintenancePayload = parseJson(artifact.payload) as { maintenance_type: string };
    assert.equal(maintenancePayload.maintenance_type, 'voice_recording_archive');
  } finally {
    await new Promise((resolve) => mediaServer.close(resolve));
    if (previousMediaToken == null) delete process.env.SCHEDULER_VOICE_MEDIA_TOKEN;
    else process.env.SCHEDULER_VOICE_MEDIA_TOKEN = previousMediaToken;
  }
});

test('scheduler can run voice runtime deployment audit playbook', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Voice Deployment 公司' });
  const harness = createHarness(db);
  const previousRustpbxToken = process.env.SCHEDULER_RUSTPBX_TOKEN;
  const previousTurnPassword = process.env.SCHEDULER_TURN_PASSWORD;
  process.env.SCHEDULER_RUSTPBX_TOKEN = 'scheduler-rustpbx-token';
  process.env.SCHEDULER_TURN_PASSWORD = 'scheduler-turn-secret';

  try {
    const rustpbxSecret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'scheduler-rustpbx-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'rustpbx',
        secret_key: 'api_token',
        secret_value: 'scheduler-rustpbx-token',
        env_var_name: 'SCHEDULER_RUSTPBX_TOKEN'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'scheduler-rustpbx-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'rustpbx',
        status: 'configured',
        config: { base_url: 'https://rustpbx.scheduler.local' },
        secret_ref_ids: [rustpbxSecret.output.id]
      }
    );
    const webrtcSecret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'scheduler-webrtc-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        secret_key: 'turn_password',
        secret_value: 'scheduler-turn-secret',
        env_var_name: 'SCHEDULER_TURN_PASSWORD'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'scheduler-webrtc-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        status: 'configured',
        config: {
          media_service_url: 'https://voice-media.scheduler.local',
          turn_urls: ['turn:turn.scheduler.local:3478?transport=udp'],
          turn_username: 'scheduler-user'
        },
        secret_ref_ids: [webrtcSecret.output.id]
      }
    );

    harness.triggerRunner.createScheduledTrigger({
      tenant_id: tenant.id,
      name: 'Voice deployment audit',
      playbook_id: 'ops_agent.voice_runtime_deployment_audit.v1',
      goal: 'Audit current voice runtime deployment readiness',
      interval_seconds: 3600,
      next_run_at: '2026-01-01T00:00:00.000Z'
    });

    const tick = await harness.triggerRunner.tick({
      tenant_id: tenant.id,
      now: '2026-01-01T00:00:00.000Z'
    });

    assert.equal(tick.status, 'completed');
    assert.equal(tick.results[0].status, 'completed');
    assert.equal(harness.voiceStore.listDeploymentSnapshots({ tenant_id: tenant.id }).length, 1);

    const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report'`, [tenant.id]);
    const maintenancePayload = parseJson(artifact.payload) as { maintenance_type: string; snapshot: { status: string } };
    assert.equal(maintenancePayload.maintenance_type, 'voice_runtime_deployment');
    assert.equal(maintenancePayload.snapshot.status, 'ready');
  } finally {
    if (previousRustpbxToken == null) delete process.env.SCHEDULER_RUSTPBX_TOKEN;
    else process.env.SCHEDULER_RUSTPBX_TOKEN = previousRustpbxToken;
    if (previousTurnPassword == null) delete process.env.SCHEDULER_TURN_PASSWORD;
    else process.env.SCHEDULER_TURN_PASSWORD = previousTurnPassword;
  }
});

test('scheduler can run geo routing maintenance playbook across feedback sync and pending rebalance', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Routing 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-geo',
    name: 'Scheduler Geo Territory',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic',
    queue_route_id: 'scheduler-geo-primary',
    voice_route_id: 'scheduler-geo-voice',
    default_owner_user_id: 'rep_scheduler_primary'
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'scheduler-geo',
    coverage_id: 'scheduler-primary',
    owner_user_id: 'rep_scheduler_primary',
    owner_name: 'Scheduler Primary',
    channel: 'call_script',
    queue_route_id: 'scheduler-geo-primary',
    voice_route_id: 'scheduler-geo-voice',
    priority_weight: 220,
    daily_capacity: 1,
    active_assignments: 1
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'scheduler-geo',
    coverage_id: 'scheduler-backup',
    owner_user_id: 'rep_scheduler_backup',
    owner_name: 'Scheduler Backup',
    channel: 'call_script',
    queue_route_id: 'scheduler-geo-backup',
    voice_route_id: 'scheduler-geo-backup-voice',
    priority_weight: 40,
    daily_capacity: 3,
    active_assignments: 0
  });

  async function createGeoHandoff(stepPrefix: string) {
    const place = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, `${stepPrefix}-place`, { agentId: 'geo_agent', userId: 'geo_user' }),
      'geo.place_upsert',
      {
        tenant_id: tenant.id,
        name: `${stepPrefix} Clinic`,
        business_type: 'clinic',
        city: 'Shanghai',
        region: 'Pudong',
        address: 'Pudong New Area',
        phone: '+86 21 8888 1111',
        rating: 4.5
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, `${stepPrefix}-review`, { agentId: 'geo_agent', userId: 'geo_user' }),
      'geo.review_ingest',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        author_name: 'Patient A',
        rating: 2,
        content: '预约回访需要更快一些。'
      }
    );
    const insight = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, `${stepPrefix}-insight`, { agentId: 'geo_agent', userId: 'geo_user' }),
      'geo.extract_place_pain_signals',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        offer_context: '诊所预约回访自动化'
      }
    );
    const draft = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, `${stepPrefix}-draft`, { agentId: 'geo_agent', userId: 'geo_user' }),
      'geo.generate_outreach_draft',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        insight_id: insight.output.insight.id,
        product_offer: '诊所预约回访自动化',
        channel: 'call_script'
      }
    );
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
    return routed.step_outputs.generate_handoff_packet.handoff;
  }

  const executedHandoff = await createGeoHandoff('scheduler-executed');
  await createGeoHandoff('scheduler-pending');
  await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    workspace_id: 'default',
    user_id: 'geo_user',
    playbook_id: 'geo_agent.execute_handoff_followup.v1',
    goal: '执行交接',
    handoff_id: executedHandoff.id
  });

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing maintenance',
    playbook_id: 'ops_agent.geo_routing_maintenance.v1',
    goal: '同步 geo 反馈并重平衡 pending handoff',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');

  const coverages = harness.geoRoutingStore.listRepCoverages({ tenant_id: tenant.id, territory_id: 'scheduler-geo' });
  const primary = coverages.find((coverage) => coverage.coverage_id === 'scheduler-primary');
  const backup = coverages.find((coverage) => coverage.coverage_id === 'scheduler-backup');
  const handoffs = harness.geoRoutingStore.listHandoffs({ tenant_id: tenant.id });
  const pending = handoffs.find((handoff) => !handoff.payload?.execution);

  assert.equal(primary?.active_assignments, 2);
  assert.equal(primary?.metadata.geo_feedback.pending_voice_approvals, 1);
  assert.equal(primary?.metadata.geo_feedback.active_geo_assignments, 1);
  assert.equal(backup?.metadata.geo_feedback.pending_handoffs, 1);
  assert.equal(pending?.owner_user_id, 'rep_scheduler_backup');
  assert.equal(pending?.queue_route_id, 'scheduler-geo-backup');

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report'`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as { maintenance_type: string; maintenance: { totals: { applied_rebalances: number } } };
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_maintenance');
  assert.equal(maintenancePayload.maintenance.totals.applied_rebalances, 1);
});

test('scheduler can bootstrap tenant-wide geo routing triggers and execute them', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Bootstrap 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-bootstrap',
    name: 'Scheduler Bootstrap Territory',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic',
    queue_route_id: 'scheduler-bootstrap-primary',
    voice_route_id: 'scheduler-bootstrap-voice',
    default_owner_user_id: 'rep_bootstrap_primary'
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'scheduler-bootstrap',
    coverage_id: 'scheduler-bootstrap-primary',
    owner_user_id: 'rep_bootstrap_primary',
    owner_name: 'Bootstrap Primary',
    channel: 'call_script',
    queue_route_id: 'scheduler-bootstrap-primary',
    voice_route_id: 'scheduler-bootstrap-voice',
    priority_weight: 220,
    daily_capacity: 1,
    active_assignments: 1
  });
  harness.geoRoutingStore.upsertRepCoverage({
    tenant_id: tenant.id,
    territory_id: 'scheduler-bootstrap',
    coverage_id: 'scheduler-bootstrap-backup',
    owner_user_id: 'rep_bootstrap_backup',
    owner_name: 'Bootstrap Backup',
    channel: 'call_script',
    queue_route_id: 'scheduler-bootstrap-backup',
    voice_route_id: 'scheduler-bootstrap-backup-voice',
    priority_weight: 40,
    daily_capacity: 3,
    active_assignments: 0
  });

  const place = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'bootstrap-place', { agentId: 'geo_agent', userId: 'geo_user' }),
    'geo.place_upsert',
    {
      tenant_id: tenant.id,
      name: 'Bootstrap Clinic',
      business_type: 'clinic',
      city: 'Shanghai',
      region: 'Pudong',
      address: 'Pudong New Area',
      phone: '+86 21 8888 3333',
      rating: 4.5
    }
  );
  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'bootstrap-review', { agentId: 'geo_agent', userId: 'geo_user' }),
    'geo.review_ingest',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Patient A',
      rating: 2,
      content: '预约回访需要更快一些。'
    }
  );
  const insight = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'bootstrap-insight', { agentId: 'geo_agent', userId: 'geo_user' }),
    'geo.extract_place_pain_signals',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      offer_context: '诊所预约回访自动化'
    }
  );
  const draft = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'bootstrap-draft', { agentId: 'geo_agent', userId: 'geo_user' }),
    'geo.generate_outreach_draft',
    {
      tenant_id: tenant.id,
      place_id: place.output.id,
      insight_id: insight.output.insight.id,
      product_offer: '诊所预约回访自动化',
      channel: 'call_script'
    }
  );
  await harness.runtime.runPlaybook({
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

  const bootstrap = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'bootstrap-trigger', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.bootstrap_routing_triggers',
    {
      tenant_id: tenant.id,
      scope: 'tenant',
      next_run_at: '2026-01-01T00:00:00.000Z',
      interval_seconds: 3600
    }
  );
  assert.equal(bootstrap.output.created_count, 1);

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(tick.status, 'completed');
  const triggers = harness.triggerRunner.listScheduledTriggers({ tenant_id: tenant.id, playbook_id: 'ops_agent.geo_routing_maintenance.v1' });
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].input.territory_id, undefined);

  const handoffs = harness.geoRoutingStore.listHandoffs({ tenant_id: tenant.id });
  const coverages = harness.geoRoutingStore.listRepCoverages({ tenant_id: tenant.id, territory_id: 'scheduler-bootstrap' });
  const pending = handoffs.find((handoff) => !handoff.payload?.execution);
  const backup = coverages.find((coverage) => coverage.coverage_id === 'scheduler-bootstrap-backup');

  assert.equal(pending?.owner_user_id, 'rep_bootstrap_backup');
  assert.equal(backup?.metadata.geo_feedback.pending_handoffs, 1);
});

test('scheduler can enforce geo routing policy guardrails through rollout snapshots and paused triggers', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Policy 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-policy-east',
    name: 'Scheduler Policy East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-policy-west',
    name: 'Scheduler Policy West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-policy-north',
    name: 'Scheduler Policy North',
    city: 'Shanghai',
    region: 'Baoshan',
    business_type: 'clinic',
    status: 'archived'
  });

  const policy = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'routing-policy-upsert', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-policy-east', 'scheduler-policy-west'],
      territory_exclude_ids: ['scheduler-policy-west'],
      auto_bootstrap: true
    }
  );
  const preview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'routing-policy-preview', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_preview',
    {
      tenant_id: tenant.id
    }
  );
  const rollout = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'routing-policy-rollout', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.rollout_routing_policy',
    {
      tenant_id: tenant.id,
      next_run_at: '2026-01-01T00:00:00.000Z'
    }
  );

  assert.equal(policy.output.maintenance_scope, 'territory');
  assert.deepEqual(policy.output.territory_include_ids, ['scheduler-policy-east', 'scheduler-policy-west']);
  assert.deepEqual(policy.output.territory_exclude_ids, ['scheduler-policy-west']);
  assert.equal(preview.output.totals.eligible_targets, 1);
  assert.equal(preview.output.eligible_targets[0].territory_id, 'scheduler-policy-east');
  assert.equal(rollout.output.bootstrap.created_count, 1);
  assert.equal(rollout.output.policy.last_rollout_snapshot.status, 'applied');

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });
  const triggers = harness.triggerRunner.listScheduledTriggers({ tenant_id: tenant.id, playbook_id: 'ops_agent.geo_routing_maintenance.v1' });

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results.length, 1);
  assert.equal(triggers.length, 1);
  assert.equal(triggers.every((trigger) => trigger.input.dry_run === true), true);
  assert.deepEqual(
    triggers.map((trigger) => trigger.input.territory_id).sort(),
    ['scheduler-policy-east']
  );

  const pausedPolicy = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'routing-policy-pause', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      paused_until: '2027-01-01T00:00:00.000Z',
      pause_reason: 'ops freeze'
    }
  );
  const pausedRollout = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'routing-policy-rollout-paused', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.rollout_routing_policy',
    {
      tenant_id: tenant.id,
      next_run_at: '2026-01-02T00:00:00.000Z'
    }
  );
  const pausedTriggers = harness.triggerRunner.listScheduledTriggers({
    tenant_id: tenant.id,
    playbook_id: 'ops_agent.geo_routing_maintenance.v1',
    status: 'paused'
  });

  assert.equal(pausedPolicy.output.paused_until, '2027-01-01T00:00:00.000Z');
  assert.equal(pausedRollout.output.skipped, true);
  assert.equal(pausedRollout.output.bootstrap.paused_count, 1);
  assert.equal(pausedRollout.output.policy.last_rollout_snapshot.status, 'skipped');
  assert.equal(pausedTriggers.length, 1);
  assert.equal(pausedTriggers[0].input.guardrail_reason, 'ops freeze');
});

test('scheduler can approval-gate geo routing policy overrides and roll them back safely', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Override 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-override-east',
    name: 'Scheduler Override East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-override-west',
    name: 'Scheduler Override West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'base-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-override-east'],
      territory_exclude_ids: ['scheduler-override-west'],
      auto_bootstrap: true
    }
  );
  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'base-rollout', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.rollout_routing_policy',
    {
      tenant_id: tenant.id,
      next_run_at: '2026-01-01T00:00:00.000Z'
    }
  );

  const diff = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'override-diff', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_override_diff',
    {
      tenant_id: tenant.id,
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-override-east', 'scheduler-override-west'],
        territory_exclude_ids: []
      }
    }
  );
  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'override-apply', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'storm response override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-override-east', 'scheduler-override-west'],
        territory_exclude_ids: []
      }
    }
  );

  assert.equal(diff.output.diff_summary.changed_fields.some((entry) => entry.field === 'interval_seconds'), true);
  assert.deepEqual(diff.output.diff_summary.impact.added_targets, ['scheduler-override-west']);
  assert.equal(blockedOverride.status, 'blocked_pending_approval');

  harness.approvalQueue.decide(tenant.id, blockedOverride.approval_request.id, 'approved', 'ops_lead');
  const resumedOverride = await harness.toolExecutor.resumeApproved(
    baseToolContext(tenant.id, 'override-resume', { agentId: 'ops_agent', userId: 'ops_lead' }),
    blockedOverride.approval_request.tool_call_id
  );
  const activeAfterOverride = harness.triggerRunner.listScheduledTriggers({
    tenant_id: tenant.id,
    playbook_id: 'ops_agent.geo_routing_maintenance.v1',
    status: 'active'
  });
  const overrideLedger = harness.geoRoutingStore.listRoutingPolicyOverrides({ tenant_id: tenant.id });

  assert.equal(resumedOverride.status, 'success');
  assert.equal(resumedOverride.output.override.override_kind, 'policy_override');
  assert.equal(resumedOverride.output.policy.interval_seconds, 900);
  assert.equal(activeAfterOverride.length, 2);
  assert.equal(overrideLedger.length, 1);

  const blockedRollback = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'rollback-apply', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.rollback_routing_policy_override',
    {
      tenant_id: tenant.id,
      override_id: resumedOverride.output.override.id,
      reason: 'restore default routing posture',
      next_run_at: '2026-01-02T00:00:00.000Z'
    }
  );

  assert.equal(blockedRollback.status, 'blocked_pending_approval');
  harness.approvalQueue.decide(tenant.id, blockedRollback.approval_request.id, 'approved', 'ops_lead');
  const resumedRollback = await harness.toolExecutor.resumeApproved(
    baseToolContext(tenant.id, 'rollback-resume', { agentId: 'ops_agent', userId: 'ops_lead' }),
    blockedRollback.approval_request.tool_call_id
  );

  const policy = harness.geoRoutingStore.getRoutingPolicy(tenant.id);
  const allTriggers = harness.triggerRunner.listScheduledTriggers({
    tenant_id: tenant.id,
    playbook_id: 'ops_agent.geo_routing_maintenance.v1'
  });
  const finalOverrides = harness.geoRoutingStore.listRoutingPolicyOverrides({ tenant_id: tenant.id });

  assert.equal(resumedRollback.status, 'success');
  assert.equal(resumedRollback.output.override.override_kind, 'policy_rollback');
  assert.equal(policy.interval_seconds, 1800);
  assert.equal(finalOverrides.length, 2);
  assert.equal(finalOverrides.some((entry) => entry.override_kind === 'policy_override' && entry.status === 'rolled_back'), true);
  assert.equal(finalOverrides.some((entry) => entry.override_kind === 'policy_rollback' && entry.source_override_id === resumedOverride.output.override.id), true);
  assert.equal(allTriggers.some((trigger) => trigger.input.territory_id === 'scheduler-override-east' && trigger.status === 'active'), true);
  assert.equal(allTriggers.some((trigger) => trigger.input.territory_id === 'scheduler-override-west' && trigger.status === 'paused'), true);
});

test('scheduler tools expose geo routing policy ops overview and timeline', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Visibility 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-visibility-east',
    name: 'Scheduler Visibility East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-visibility-west',
    name: 'Scheduler Visibility West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-visibility-east'],
      territory_exclude_ids: ['scheduler-visibility-west'],
      auto_bootstrap: true
    }
  );

  const beforeRollout = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-overview-before', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_ops_overview',
    {
      tenant_id: tenant.id
    }
  );

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-rollout', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.rollout_routing_policy',
    {
      tenant_id: tenant.id,
      next_run_at: '2026-01-01T00:00:00.000Z'
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'visibility spike override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-visibility-east', 'scheduler-visibility-west'],
        territory_exclude_ids: []
      }
    }
  );

  const pendingOverview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-overview-pending', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_ops_overview',
    {
      tenant_id: tenant.id
    }
  );
  const pendingTimeline = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-timeline-pending', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_timeline',
    {
      tenant_id: tenant.id
    }
  );

  assert.equal(beforeRollout.output.summary.drift_healthy, false);
  assert.equal(beforeRollout.output.trigger_drift.missing_active_targets[0].territory_id, 'scheduler-visibility-east');
  assert.equal(blockedOverride.status, 'blocked_pending_approval');
  assert.equal(pendingOverview.output.summary.pending_approval_count, 1);
  assert.equal(pendingOverview.output.pending_approvals[0].action_type, 'geo.override_routing_policy');
  assert.equal(pendingTimeline.output.events.some((event) => event.event_type === 'approval_request' && event.status === 'pending'), true);

  harness.approvalQueue.decide(tenant.id, blockedOverride.approval_request.id, 'approved', 'ops_manager');
  await harness.toolExecutor.resumeApproved(
    baseToolContext(tenant.id, 'visibility-resume', { agentId: 'ops_agent', userId: 'ops_manager' }),
    blockedOverride.approval_request.tool_call_id
  );

  const appliedOverview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-overview-applied', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_ops_overview',
    {
      tenant_id: tenant.id
    }
  );
  const appliedTimeline = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'visibility-timeline-applied', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_timeline',
    {
      tenant_id: tenant.id
    }
  );

  assert.equal(appliedOverview.output.summary.pending_approval_count, 0);
  assert.equal(appliedOverview.output.summary.override_count, 1);
  assert.equal(appliedOverview.output.summary.drift_healthy, true);
  assert.equal(appliedOverview.output.preview.totals.eligible_targets, 2);
  assert.equal(appliedTimeline.output.events.some((event) => event.event_type === 'policy_override' && event.status === 'applied'), true);
});

test('scheduler tools expose geo routing policy review queue and acknowledgements', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Review 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-review-east',
    name: 'Scheduler Review East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-review-west',
    name: 'Scheduler Review West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-review-east'],
      territory_exclude_ids: ['scheduler-review-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'review workflow override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-review-east', 'scheduler-review-west'],
        territory_exclude_ids: []
      }
    }
  );

  const initialQueue = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-queue', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_review_queue',
    {
      tenant_id: tenant.id
    }
  );
  assert.equal(initialQueue.status, 'success');
  if (initialQueue.status !== 'success') {
    throw new Error('expected geo.routing_policy_review_queue to succeed');
  }
  const reviewDriftItem = initialQueue.output.items.find((item) => item.review_key === 'drift:missing_active_target:scheduler-review-east');
  const reviewApprovalItem = initialQueue.output.items.find((item) => item.item_type === 'pending_approval');
  const savedReviewPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-plan', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler review execution context plan',
      notes: 'Carries current execution target into acknowledge output',
      items: [
        {
          review_key: reviewDriftItem.review_key,
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: reviewApprovalItem.review_key,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );
  assert.equal(savedReviewPlan.status, 'success');
  if (savedReviewPlan.status !== 'success') {
    throw new Error('expected geo.routing_policy_batch_plan_upsert to succeed');
  }

  const acknowledged = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-ack', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_acknowledge',
    {
      tenant_id: tenant.id,
      review_key: 'drift:missing_active_target:scheduler-review-east',
      item_status: 'acknowledged',
      note: 'Drift seen by ops'
    }
  );

  harness.approvalQueue.decide(tenant.id, blockedOverride.approval_request.id, 'approved', 'ops_manager');
  const resumedOverride = await harness.toolExecutor.resumeApproved(
    baseToolContext(tenant.id, 'review-resume', { agentId: 'ops_agent', userId: 'ops_manager' }),
    blockedOverride.approval_request.tool_call_id
  );

  const appliedQueue = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-queue-applied', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_queue',
    {
      tenant_id: tenant.id
    }
  );

  assert.equal(blockedOverride.status, 'blocked_pending_approval');
  assert.equal(initialQueue.output.summary.open_items, 2);
  assert.equal(initialQueue.output.summary.pending_approval_items, 1);
  assert.equal(initialQueue.output.items.some((item) => item.review_key === 'drift:missing_active_target:scheduler-review-east' && item.severity === 'critical'), true);
  assert.equal(acknowledged.output.item.review_status, 'acknowledged');
  assert.equal(acknowledged.output.target_snapshot_before.current_execution_target.target_plan_id, savedReviewPlan.output.plan.id);
  assert.equal(acknowledged.output.target_snapshot_after.current_execution_target.target_plan_id, savedReviewPlan.output.plan.id);
  assert.equal(acknowledged.output.target_transition.changed, false);
  assert.equal(acknowledged.output.decision_diff.review_status_changed, true);
  assert.equal(acknowledged.output.summary.open_items, 1);
  assert.equal(acknowledged.output.summary.acknowledged_items, 1);
  assert.equal(resumedOverride.status, 'success');
  assert.equal(appliedQueue.output.summary.pending_approval_items, 0);
  assert.equal(appliedQueue.output.summary.drift_items, 0);
  assert.equal(appliedQueue.output.items.some((item) => item.item_type === 'override_change' && item.source_id === resumedOverride.output.override.id), true);
});

test('scheduler tools expose geo routing policy action workbench and execute guarded actions', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Action 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-action-east',
    name: 'Scheduler Action East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-action-west',
    name: 'Scheduler Action West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-action-east'],
      territory_exclude_ids: ['scheduler-action-west'],
      auto_bootstrap: true
    }
  );

  const initialWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-workbench-before', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  assert.equal(initialWorkbench.status, 'success');
  if (initialWorkbench.status !== 'success') {
    throw new Error('expected geo.routing_policy_action_workbench to succeed');
  }
  const workbenchDriftItem = initialWorkbench.output.items.find((item) => item.review_key === 'drift:missing_active_target:scheduler-action-east');
  const savedWorkbenchPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-plan', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler action execution context plan',
      notes: 'Carries current execution target into execute output',
      items: [
        {
          review_key: workbenchDriftItem.review_key,
          action_id: 'rollout_policy_from_review'
        }
      ]
    }
  );
  assert.equal(savedWorkbenchPlan.status, 'success');
  if (savedWorkbenchPlan.status !== 'success') {
    throw new Error('expected geo.routing_policy_batch_plan_upsert to succeed');
  }
  const rollout = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-rollout', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      review_key: 'drift:missing_active_target:scheduler-action-east',
      action_id: 'rollout_policy_from_review',
      actor_id: 'ops_manager'
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'action workbench override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-action-east', 'scheduler-action-west'],
        territory_exclude_ids: []
      }
    }
  );

  const approvalWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-workbench-approval', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  const approved = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-approve-resume', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      review_key: `approval:${blockedOverride.approval_request.id}`,
      action_id: 'approve_and_resume_pending_approval',
      actor_id: 'ops_manager'
    }
  );

  const overrideWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-workbench-override', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  const rollbackLaunch = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-rollback-launch', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      review_key: `override:${approved.output.result.resumed.output.override.id}`,
      action_id: 'launch_rollback_from_review',
      actor_id: 'ops_manager',
      reason: 'Rollback from scheduler action workbench test'
    }
  );

  const afterRollbackWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-workbench-after', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  const actionHistory = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_history',
    {
      tenant_id: tenant.id
    }
  );
  const guardedOverrideItem = afterRollbackWorkbench.output.items.find((item) => item.review_key === `override:${approved.output.result.resumed.output.override.id}`);
  const guardedRollbackAction = guardedOverrideItem.actions.find((action) => action.action_id === 'launch_rollback_from_review');

  assert.equal(initialWorkbench.output.summary.rollout_actions, 1);
  assert.equal(rollout.output.result.rollout.status, 'success');
  assert.equal(rollout.output.target_snapshot_before.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(rollout.output.target_snapshot_after.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(rollout.output.target_transition.changed, false);
  assert.equal(rollout.output.action_history.status, 'succeeded');
  assert.equal(blockedOverride.status, 'blocked_pending_approval');
  assert.equal(approvalWorkbench.output.summary.approve_and_resume_actions, 1);
  assert.equal(approved.output.result.approval_request.status, 'approved');
  assert.equal(approved.output.target_snapshot_before.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(approved.output.target_snapshot_after.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(approved.output.result.resumed.status, 'success');
  assert.equal(approved.output.action_history.status, 'succeeded');
  assert.equal(overrideWorkbench.output.summary.rollback_actions, 1);
  assert.equal(rollbackLaunch.output.result.rollback.status, 'blocked_pending_approval');
  assert.equal(rollbackLaunch.output.target_snapshot_after.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(rollbackLaunch.output.result.rollback.approval_request.action_type, 'geo.rollback_routing_policy_override');
  assert.equal(rollbackLaunch.output.action_history.status, 'blocked_pending_approval');
  assert.equal(afterRollbackWorkbench.output.summary.approve_and_resume_actions, 1);
  assert.equal(afterRollbackWorkbench.output.summary.history_entries, 3);
  assert.equal(guardedOverrideItem.latest_action.status, 'blocked_pending_approval');
  assert.equal(guardedOverrideItem.latest_action.target_plan_id_at_execution, savedWorkbenchPlan.output.plan.id);
  assert.equal(guardedOverrideItem.latest_action.target_changed_since_execution, false);
  assert.equal(guardedRollbackAction.executable, false);
  assert.equal(guardedRollbackAction.repeat_guard_reason, 'latest_action_pending_followup');
  assert.equal(guardedRollbackAction.latest_execution.target_plan_id_at_execution, savedWorkbenchPlan.output.plan.id);
  assert.equal(actionHistory.output.summary.total_entries, 3);
  assert.equal(actionHistory.output.summary.succeeded_entries, 2);
  assert.equal(actionHistory.output.summary.blocked_entries, 1);
  assert.equal(actionHistory.output.summary.entries_with_execution_target_snapshot, 3);
  assert.equal(actionHistory.output.summary.entries_with_target_change_since_execution, 0);
  assert.equal(actionHistory.output.entries[0].execution_target_context.target_snapshot_after.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(actionHistory.output.entries[0].historical_current_target_diff.current_target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(actionHistory.output.entries[0].historical_current_target_diff.changed, false);
  const shiftedTargetPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-target-shift', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler shifted action target plan',
      preferred: true,
      actor_id: 'ops_manager',
      preference_reason: 'audit_target_shift',
      items: [
        {
          review_key: `override:${approved.output.result.resumed.output.override.id}`,
          action_id: 'launch_rollback_from_review',
          force_repeat: true
        }
      ]
    }
  );
  const driftedActionHistory = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-drift-filter', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_history',
    {
      tenant_id: tenant.id,
      target_changed_since_execution: true,
      target_event_limit: 20
    }
  );
  const driftOnlyActionHistory = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-plan-drift-filter', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_history',
    {
      tenant_id: tenant.id,
      target_drift_only: true,
      target_event_limit: 20
    }
  );
  const targetShiftWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-workbench-target-shift', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id,
      target_event_limit: 20
    }
  );

  assert.equal(shiftedTargetPlan.output.plan.status, 'active');
  assert.equal(driftedActionHistory.output.summary.returned_entries, 3);
  assert.equal(driftedActionHistory.output.summary.target_changed_since_execution_filter, true);
  assert.equal(driftedActionHistory.output.summary.entries_with_target_plan_drift, 3);
  assert.equal(driftedActionHistory.output.summary.entries_with_target_governance_events_after_execution, 3);
  assert.equal(driftedActionHistory.output.target_audit_summary.latest_target_plan_drift.target_plan_id_at_execution, savedWorkbenchPlan.output.plan.id);
  assert.equal(driftedActionHistory.output.entries[0].historical_current_target_diff.target_plan_changed, true);
  assert.equal(driftedActionHistory.output.entries[0].historical_current_target_diff.current_target_plan_id, shiftedTargetPlan.output.plan.id);
  assert.equal(driftedActionHistory.output.entries[0].target_governance_trail.latest_event_after_execution.event_type, 'batch_plan_preferred');
  assert.equal(driftOnlyActionHistory.output.summary.returned_entries, 3);
  assert.equal(driftOnlyActionHistory.output.summary.target_drift_only_filter, true);
  assert.equal(targetShiftWorkbench.output.summary.history_entries_with_target_plan_drift, 3);
  assert.equal(targetShiftWorkbench.output.target_drift_history[0].historical_current_target_diff.current_target_plan_id, shiftedTargetPlan.output.plan.id);
});

test('scheduler tools preview save and execute geo routing policy batch plans with history and repeat safety', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-east',
    name: 'Scheduler Batch East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-west',
    name: 'Scheduler Batch West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-east'],
      territory_exclude_ids: ['scheduler-batch-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'batch workbench override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-batch-east', 'scheduler-batch-west'],
        territory_exclude_ids: []
      }
    }
  );

  const batchPreview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-preview', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_preview',
    {
      tenant_id: tenant.id,
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );
  const savedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-save', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_name: 'Scheduler mixed-risk batch plan',
      notes: 'Persist scheduler batch plan for guarded reuse',
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );
  const listedPlans = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-list', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_list',
    {
      tenant_id: tenant.id
    }
  );
  const rolloutFromWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-rollout', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      review_key: 'drift:missing_active_target:scheduler-batch-east',
      action_id: 'rollout_policy_from_review'
    }
  );
  const stalePreview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-stale-preview', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_preview',
    {
      tenant_id: tenant.id,
      plan_id: savedPlan.output.plan.id
    }
  );
  await assert.rejects(
    harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'batch-execute-stale', { agentId: 'ops_agent', userId: 'ops_manager' }),
      'geo.routing_policy_review_batch_execute',
      {
        tenant_id: tenant.id,
        actor_id: 'ops_manager',
        plan_id: savedPlan.output.plan.id
      }
    ),
    /stale/
  );
  const refreshedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-refresh', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_refresh',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_id: savedPlan.output.plan.id,
      refresh_mode: 'supersede'
    }
  );
  const refreshedPlans = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-list-refreshed', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_list',
    {
      tenant_id: tenant.id
    }
  );
  const archivedPlanDetail = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-detail', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_detail',
    {
      tenant_id: tenant.id,
      plan_id: savedPlan.output.plan.id
    }
  );
  const archivedPlanLineage = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-lineage', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_lineage',
    {
      tenant_id: tenant.id,
      plan_id: savedPlan.output.plan.id
    }
  );
  const activeLineage = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-lineage-active', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_lineage',
    {
      tenant_id: tenant.id,
      plan_id: savedPlan.output.plan.id,
      status: 'active'
    }
  );
  const resolvedTarget = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-target', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_target',
    {
      tenant_id: tenant.id,
      policy_id: 'default',
      plan_target: 'recommended'
    }
  );
  const batchResult = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-execute', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_batch_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_target: 'preferred'
    }
  );

  const postBatchWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-workbench-after', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  const overrideItem = postBatchWorkbench.output.items.find((item) => item.item_type === 'override_change');

  const rollbackBatch = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-rollback', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_batch_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      items: [
        {
          review_key: overrideItem.review_key,
          action_id: 'launch_rollback_from_review',
          reason: 'Rollback from scheduler batch test'
        }
      ]
    }
  );

  const repeatGuarded = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-repeat-guard', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_batch_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      continue_on_error: true,
      items: [
        {
          review_key: overrideItem.review_key,
          action_id: 'launch_rollback_from_review'
        }
      ]
    }
  );

  const actionHistory = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-history', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_action_history',
    {
      tenant_id: tenant.id
    }
  );

  assert.equal(batchPreview.output.summary.total_selected, 2);
  assert.equal(batchPreview.output.summary.ready_items, 2);
  assert.equal(batchPreview.output.summary.mixed_risk.R1, 1);
  assert.equal(batchPreview.output.summary.mixed_risk.R3, 1);
  assert.equal(savedPlan.output.plan.plan_name, 'Scheduler mixed-risk batch plan');
  assert.equal(savedPlan.output.preview.summary.plan_ready, true);
  assert.equal(savedPlan.output.preview.summary.current_target_plan_id, null);
  assert.equal(savedPlan.output.preview.report_summary.current_execution_target, null);
  assert.equal(listedPlans.output.summary.total_plans, 1);
  assert.equal(listedPlans.output.summary.current_target_plan_id, savedPlan.output.plan.id);
  assert.equal(listedPlans.output.report_summary.current_execution_target.target_plan_id, savedPlan.output.plan.id);
  assert.equal(listedPlans.output.plans[0].report_summary.current_roles.includes('current_target'), true);
  assert.equal(listedPlans.output.plans[0].report_summary.last_target_change_reason, 'initial_active_plan');
  assert.equal(rolloutFromWorkbench.output.result.rollout.status, 'success');
  assert.equal(stalePreview.output.source, 'saved_plan');
  assert.equal(stalePreview.output.freshness.stale, true);
  assert.equal(stalePreview.output.freshness.requires_confirmation, true);
  assert.equal(stalePreview.output.freshness.missing_review_items, 1);
  assert.equal(stalePreview.output.freshness.blocking_changes, 1);
  assert.equal(stalePreview.output.summary.current_target_plan_id, savedPlan.output.plan.id);
  assert.equal(stalePreview.output.report_summary.source_alignment.source_plan_id, savedPlan.output.plan.id);
  assert.equal(stalePreview.output.report_summary.source_alignment.source_matches_current_target, true);
  assert.equal(refreshedPlan.output.refresh_mode, 'supersede');
  assert.equal(refreshedPlan.output.refresh_selection.summary.kept_items, 1);
  assert.equal(refreshedPlan.output.refresh_selection.summary.dropped_missing_items, 1);
  assert.equal(refreshedPlan.output.archived_plan.status, 'archived');
  assert.equal(refreshedPlan.output.archived_plan.metadata.superseded_by_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(refreshedPlan.output.report_summary.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(refreshedPlan.output.report_summary.refreshed_plan.current_roles.includes('current_target'), true);
  assert.equal(refreshedPlan.output.report_summary.archived_plan.target_fallback_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(refreshedPlan.output.preview_after.freshness.stale, false);
  assert.equal(refreshedPlans.output.summary.total_plans, 2);
  assert.equal(refreshedPlans.output.summary.active_plans, 1);
  assert.equal(refreshedPlans.output.summary.archived_plans, 1);
  assert.equal(refreshedPlans.output.summary.current_target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(refreshedPlans.output.report_summary.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanDetail.output.plan.status, 'archived');
  assert.equal(archivedPlanDetail.output.plan.target_state.current_roles.includes('archived'), true);
  assert.equal(archivedPlanDetail.output.relationships.root_plan.id, savedPlan.output.plan.id);
  assert.equal(archivedPlanDetail.output.relationships.successor.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanDetail.output.relationships.latest_active_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanDetail.output.relationships.recommended_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanDetail.output.target_drilldown.current_execution_target.summary.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanDetail.output.target_drilldown.anchor_plan_state.archive.target_fallback_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanLineage.output.summary.total_related_plans, 2);
  assert.equal(archivedPlanLineage.output.summary.current_is_archived, true);
  assert.equal(archivedPlanLineage.output.summary.current_target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanLineage.output.latest_active_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(archivedPlanLineage.output.target_drilldown.current_execution_target.summary.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(activeLineage.output.summary.displayed_plans, 1);
  assert.equal(activeLineage.output.plans[0].status, 'active');
  assert.equal(activeLineage.output.plans[0].is_recommended_plan, true);
  assert.equal(resolvedTarget.output.summary.target, 'recommended');
  assert.equal(resolvedTarget.output.summary.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(resolvedTarget.output.recommended_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(batchResult.output.plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(batchResult.output.target_resolution.target, 'preferred');
  assert.equal(batchResult.output.target_resolution.target_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(batchResult.output.plan_preflight.stale, false);
  assert.equal(batchResult.output.plan_preflight.requires_confirmation, false);
  assert.equal(batchResult.output.target_snapshot_before.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(batchResult.output.target_snapshot_after.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(batchResult.output.target_transition.changed, false);
  assert.equal(batchResult.output.report_summary.source_alignment.current_target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(batchResult.output.summary.succeeded_items, 1);
  assert.equal(batchResult.output.summary.failed_items, 0);
  assert.equal(batchResult.output.action_history.summary.total_entries, 2);
  assert.equal(batchResult.output.workbench.summary.rollback_actions, 1);
  assert.equal(batchResult.output.results[0].output.target_snapshot_after.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(rollbackBatch.output.summary.blocked_items, 1);
  assert.equal(rollbackBatch.output.target_snapshot_before.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(rollbackBatch.output.results[0].status, 'blocked_pending_approval');
  assert.equal(repeatGuarded.output.summary.failed_items, 1);
  assert.equal(repeatGuarded.output.target_snapshot_after.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(repeatGuarded.output.results[0].error.message.includes('repeat-guarded'), true);
  assert.equal(actionHistory.output.summary.total_entries, 3);
  assert.equal(actionHistory.output.summary.succeeded_entries, 2);
  assert.equal(actionHistory.output.summary.blocked_entries, 1);

  const restoredPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-restore', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_govern',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_id: savedPlan.output.plan.id,
      action: 'restore'
    }
  );
  const plansAfterRestore = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-list-restored', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_list',
    {
      tenant_id: tenant.id
    }
  );
  const promotedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-promote', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_govern',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_id: savedPlan.output.plan.id,
      action: 'promote'
    }
  );
  const promotedDetail = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-detail-promoted', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_detail',
    {
      tenant_id: tenant.id,
      plan_id: savedPlan.output.plan.id
    }
  );
  const promotedTarget = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-target-promoted', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_target',
    {
      tenant_id: tenant.id,
      policy_id: 'default',
      plan_target: 'preferred'
    }
  );
  const reArchivedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-archive', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_govern',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_id: savedPlan.output.plan.id,
      action: 'archive',
      reason: 'Retire restored fallback plan'
    }
  );
  const finalDetail = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-detail-final', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_detail',
    {
      tenant_id: tenant.id,
      plan_id: savedPlan.output.plan.id
    }
  );
  const finalTarget = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-target-final', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_target',
    {
      tenant_id: tenant.id,
      policy_id: 'default',
      plan_target: 'recommended'
    }
  );
  const finalOverview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-overview-final', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_ops_overview',
    {
      tenant_id: tenant.id
    }
  );
  const finalTimeline = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-timeline-final', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_timeline',
    {
      tenant_id: tenant.id
    }
  );
  await assert.rejects(
    harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'batch-plan-execute-archived', { agentId: 'ops_agent', userId: 'ops_manager' }),
      'geo.routing_policy_review_batch_execute',
      {
        tenant_id: tenant.id,
        actor_id: 'ops_manager',
        plan_id: savedPlan.output.plan.id
      }
    ),
    /archived/
  );

  assert.equal(restoredPlan.output.action, 'restore');
  assert.equal(restoredPlan.output.plan_after.status, 'active');
  assert.equal(restoredPlan.output.plan_after.is_preferred, false);
  assert.equal(plansAfterRestore.output.summary.total_plans, 2);
  assert.equal(plansAfterRestore.output.summary.active_plans, 2);
  assert.equal(plansAfterRestore.output.summary.preferred_plans, 1);
  assert.equal(promotedPlan.output.action, 'promote');
  assert.equal(promotedPlan.output.plan_after.is_preferred, true);
  assert.equal(promotedPlan.output.report_summary.current_execution_target.target_plan_id, savedPlan.output.plan.id);
  assert.equal(promotedPlan.output.report_summary.plan_after.current_roles.includes('current_target'), true);
  assert.equal(promotedPlan.output.lineage.summary.current_is_preferred, true);
  assert.equal(promotedPlan.output.lineage.summary.preferred_active_plan_id, savedPlan.output.plan.id);
  assert.equal(promotedDetail.output.relationships.preferred_active_plan.id, savedPlan.output.plan.id);
  assert.equal(promotedDetail.output.relationships.recommended_plan.id, savedPlan.output.plan.id);
  assert.equal(promotedDetail.output.plan.target_state.current_roles.includes('current_target'), true);
  assert.equal(promotedDetail.output.plan.target_state.preference.preference_reason, 'manual_promote');
  assert.equal(promotedTarget.output.target_plan.id, savedPlan.output.plan.id);
  assert.equal(promotedTarget.output.summary.resolution_reason, 'preferred_active_plan');
  assert.equal(reArchivedPlan.output.action, 'archive');
  assert.equal(reArchivedPlan.output.plan_after.status, 'archived');
  assert.equal(reArchivedPlan.output.auto_preferred_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(reArchivedPlan.output.report_summary.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(reArchivedPlan.output.report_summary.plan_after.target_fallback_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalDetail.output.plan.status, 'archived');
  assert.equal(finalDetail.output.relationships.preferred_active_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalDetail.output.relationships.recommended_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalDetail.output.plan.target_state.archive.target_fallback_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalTarget.output.target_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalOverview.output.current_execution_target.summary.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalOverview.output.summary.current_target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(finalOverview.output.summary.current_target_resolution_reason, 'preferred_active_plan');
  assert.equal(finalOverview.output.target_governance.summary.total_plans, 2);
  assert.equal(
    finalOverview.output.target_governance.recent_events.some((event) => event.event_type === 'batch_plan_preferred' && event.plan_id === savedPlan.output.plan.id),
    true
  );
  assert.equal(
    finalOverview.output.target_governance.recent_events.some((event) => event.event_type === 'batch_plan_archived' && event.payload.target_fallback_plan_id === refreshedPlan.output.refreshed_plan.id),
    true
  );
  assert.equal(finalTimeline.output.batch_plan_targeting.summary.current_target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(
    finalTimeline.output.events.some((event) => event.event_type === 'batch_plan_refreshed' && event.plan_id === refreshedPlan.output.refreshed_plan.id),
    true
  );
  assert.equal(
    finalTimeline.output.events.some((event) => event.event_type === 'batch_plan_archived' && event.payload.target_fallback_plan_id === refreshedPlan.output.refreshed_plan.id),
    true
  );
});

test('scheduler can run geo routing policy batch planning playbook and commit a planning artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch Planning 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-plan-east',
    name: 'Scheduler Batch Plan East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-plan-west',
    name: 'Scheduler Batch Plan West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-playbook-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-plan-east'],
      territory_exclude_ids: ['scheduler-batch-plan-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-plan-playbook-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'batch planning playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-batch-plan-east', 'scheduler-batch-plan-west'],
        territory_exclude_ids: []
      }
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy batch planning',
    playbook_id: 'ops_agent.geo_routing_policy_batch_planning.v1',
    goal: 'Build geo routing policy batch planning preview',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-plan-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    batch_plan_preview: {
      summary: { total_selected: number; ready_items: number; mixed_risk: { R1: number; R3: number }; current_target_plan_id: string | null };
      report_summary: { current_execution_target: null; target_event_count: number };
    };
  };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_batch_planning');
  assert.equal(maintenancePayload.batch_plan_preview.summary.total_selected, 2);
  assert.equal(maintenancePayload.batch_plan_preview.summary.ready_items, 2);
  assert.equal(maintenancePayload.batch_plan_preview.summary.mixed_risk.R1, 1);
  assert.equal(maintenancePayload.batch_plan_preview.summary.mixed_risk.R3, 1);
  assert.equal(maintenancePayload.batch_plan_preview.summary.current_target_plan_id, null);
  assert.equal(maintenancePayload.batch_plan_preview.report_summary.current_execution_target, null);
  assert.equal(maintenancePayload.batch_plan_preview.report_summary.target_event_count, 0);
});

test('scheduler can run geo routing policy batch plan refresh playbook and commit a refresh artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch Refresh 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-refresh-east',
    name: 'Scheduler Batch Refresh East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-refresh-west',
    name: 'Scheduler Batch Refresh West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-refresh-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-refresh-east'],
      territory_exclude_ids: ['scheduler-batch-refresh-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-refresh-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'batch refresh playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-batch-refresh-east', 'scheduler-batch-refresh-west'],
        territory_exclude_ids: []
      }
    }
  );

  const savedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-refresh-save', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_name: 'Scheduler refresh source plan',
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-refresh-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-refresh-rollout', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      review_key: 'drift:missing_active_target:scheduler-batch-refresh-east',
      action_id: 'rollout_policy_from_review'
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy batch plan refresh',
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_refresh.v1',
    goal: 'Refresh stale geo routing policy batch plan',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      plan_id: savedPlan.output.plan.id,
      refresh_mode: 'supersede'
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    batch_plan_refresh: {
      refresh_selection: { summary: { kept_items: number; dropped_missing_items: number } };
      archived_plan: { status: string };
      refreshed_plan: { id: string };
      current_execution_target: { summary: { target_plan_id: string } };
      report_summary: {
        current_execution_target: { target_plan_id: string };
        refreshed_plan: { current_roles: string[] };
      };
      preview_after: { freshness: { stale: boolean } };
    };
  };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_batch_plan_refresh');
  assert.equal(maintenancePayload.batch_plan_refresh.refresh_selection.summary.kept_items, 1);
  assert.equal(maintenancePayload.batch_plan_refresh.refresh_selection.summary.dropped_missing_items, 1);
  assert.equal(maintenancePayload.batch_plan_refresh.archived_plan.status, 'archived');
  assert.equal(maintenancePayload.batch_plan_refresh.current_execution_target.summary.target_plan_id, maintenancePayload.batch_plan_refresh.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_refresh.report_summary.current_execution_target.target_plan_id, maintenancePayload.batch_plan_refresh.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_refresh.report_summary.refreshed_plan.current_roles.includes('current_target'), true);
  assert.equal(maintenancePayload.batch_plan_refresh.preview_after.freshness.stale, false);
});

test('scheduler can run geo routing policy batch plan lineage playbook and commit a lineage artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch Lineage 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-lineage-east',
    name: 'Scheduler Batch Lineage East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-lineage-west',
    name: 'Scheduler Batch Lineage West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-lineage-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-lineage-east'],
      territory_exclude_ids: ['scheduler-batch-lineage-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-lineage-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'batch lineage playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-batch-lineage-east', 'scheduler-batch-lineage-west'],
        territory_exclude_ids: []
      }
    }
  );

  const savedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-lineage-save', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_name: 'Scheduler lineage source plan',
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-lineage-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-lineage-rollout', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      review_key: 'drift:missing_active_target:scheduler-batch-lineage-east',
      action_id: 'rollout_policy_from_review'
    }
  );

  const refreshedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-lineage-refresh', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_refresh',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_id: savedPlan.output.plan.id,
      refresh_mode: 'supersede'
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy batch plan lineage',
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_lineage.v1',
    goal: 'Inspect geo routing policy batch plan lineage',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      plan_id: savedPlan.output.plan.id
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    batch_plan_lineage: {
      summary: { total_related_plans: number; current_is_archived: boolean; recommended_plan_id: string; current_target_plan_id: string };
      latest_active_plan: { id: string };
      target_drilldown: { anchor_plan_state: { archive: { target_fallback_plan: { id: string } } } };
    };
  };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_batch_plan_lineage');
  assert.equal(maintenancePayload.batch_plan_lineage.summary.total_related_plans, 2);
  assert.equal(maintenancePayload.batch_plan_lineage.summary.current_is_archived, true);
  assert.equal(maintenancePayload.batch_plan_lineage.summary.recommended_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_lineage.summary.current_target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_lineage.latest_active_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_lineage.target_drilldown.anchor_plan_state.archive.target_fallback_plan.id, refreshedPlan.output.refreshed_plan.id);
});

test('scheduler can run geo routing policy batch plan target playbook and commit a target artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch Target 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-target-east',
    name: 'Scheduler Batch Target East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-target-west',
    name: 'Scheduler Batch Target West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-target-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-target-east'],
      territory_exclude_ids: ['scheduler-batch-target-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-target-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'batch target playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-batch-target-east', 'scheduler-batch-target-west'],
        territory_exclude_ids: []
      }
    }
  );

  const savedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-target-save', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_name: 'Scheduler target source plan',
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-target-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-target-rollout', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      review_key: 'drift:missing_active_target:scheduler-batch-target-east',
      action_id: 'rollout_policy_from_review'
    }
  );

  const refreshedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-target-refresh', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_refresh',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_id: savedPlan.output.plan.id,
      refresh_mode: 'supersede'
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy batch plan target',
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_target.v1',
    goal: 'Resolve geo routing policy batch plan target',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      plan_target: 'recommended'
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    batch_plan_target: {
      summary: { target: string; target_plan_id: string; resolution_reason: string };
      target_plan: { id: string };
      recommended_plan: { id: string };
      report_summary: { current_execution_target: { target_plan_id: string }; target_plan: { current_roles: string[] } };
    };
  };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_batch_plan_target');
  assert.equal(maintenancePayload.batch_plan_target.summary.target, 'recommended');
  assert.equal(maintenancePayload.batch_plan_target.summary.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_target.summary.resolution_reason, 'preferred_active_plan');
  assert.equal(maintenancePayload.batch_plan_target.report_summary.current_execution_target.target_plan_id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_target.report_summary.target_plan.current_roles.includes('current_target'), true);
  assert.equal(maintenancePayload.batch_plan_target.target_plan.id, refreshedPlan.output.refreshed_plan.id);
  assert.equal(maintenancePayload.batch_plan_target.recommended_plan.id, refreshedPlan.output.refreshed_plan.id);
});

test('scheduler can run geo routing policy batch plan governance playbook and commit a governance artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch Governance 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-govern-east',
    name: 'Scheduler Batch Govern East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-govern-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-govern-east'],
      auto_bootstrap: true
    }
  );

  const savedPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-govern-save', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      actor_id: 'ops_manager',
      plan_name: 'Scheduler governance source plan',
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-govern-east',
          action_id: 'rollout_policy_from_review'
        }
      ]
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy batch plan governance',
    playbook_id: 'ops_agent.geo_routing_policy_batch_plan_governance.v1',
    goal: 'Govern geo routing policy batch plan',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      plan_id: savedPlan.output.plan.id,
      action: 'archive',
      reason: 'Archive obsolete governance test plan'
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    batch_plan_governance: {
      action: string;
      plan_after: { status: string };
      current_execution_target: null;
      report_summary: { current_execution_target: null; plan_after: { status: string } };
    };
  };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_batch_plan_governance');
  assert.equal(maintenancePayload.batch_plan_governance.action, 'archive');
  assert.equal(maintenancePayload.batch_plan_governance.plan_after.status, 'archived');
  assert.equal(maintenancePayload.batch_plan_governance.current_execution_target, null);
  assert.equal(maintenancePayload.batch_plan_governance.report_summary.current_execution_target, null);
  assert.equal(maintenancePayload.batch_plan_governance.report_summary.plan_after.status, 'archived');
});

test('scheduler can run geo routing policy review playbook and commit a review artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Review Playbook 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-review-playbook-east',
    name: 'Scheduler Review Playbook East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-review-playbook-west',
    name: 'Scheduler Review Playbook West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-playbook-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-review-playbook-east'],
      territory_exclude_ids: ['scheduler-review-playbook-west'],
      auto_bootstrap: true
    }
  );

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-playbook-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'review playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-review-playbook-east', 'scheduler-review-playbook-west'],
        territory_exclude_ids: []
      }
    }
  );
  const reviewQueue = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-playbook-queue', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_review_queue',
    {
      tenant_id: tenant.id
    }
  );
  assert.equal(reviewQueue.status, 'success');
  if (reviewQueue.status !== 'success') {
    throw new Error('expected geo.routing_policy_review_queue to succeed');
  }
  const reviewDriftItem = reviewQueue.output.items.find((item) => item.review_key === 'drift:missing_active_target:scheduler-review-playbook-east');
  const reviewApprovalItem = reviewQueue.output.items.find((item) => item.item_type === 'pending_approval');
  const savedReviewPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'review-playbook-plan', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler review operator context plan',
      notes: 'Carries current execution target into review artifacts',
      items: [
        {
          review_key: reviewDriftItem.review_key,
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: reviewApprovalItem.review_key,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );
  assert.equal(savedReviewPlan.status, 'success');
  if (savedReviewPlan.status !== 'success') {
    throw new Error('expected geo.routing_policy_batch_plan_upsert to succeed');
  }

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy review',
    playbook_id: 'ops_agent.geo_routing_policy_review.v1',
    goal: 'Review geo routing policy drift and approvals',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as { maintenance_type: string; review_queue: { summary: { open_items: number; pending_approval_items: number; current_target_plan_id: string }; report_summary: { current_execution_target: { target_plan_id: string } } } };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_review');
  assert.equal(maintenancePayload.review_queue.summary.open_items, 2);
  assert.equal(maintenancePayload.review_queue.summary.pending_approval_items, 1);
  assert.equal(maintenancePayload.review_queue.summary.current_target_plan_id, savedReviewPlan.output.plan.id);
  assert.equal(maintenancePayload.review_queue.report_summary.current_execution_target.target_plan_id, savedReviewPlan.output.plan.id);
});

test('scheduler can run geo routing policy action workbench playbook and commit an action artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Action Playbook 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-action-playbook-east',
    name: 'Scheduler Action Playbook East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-action-playbook-west',
    name: 'Scheduler Action Playbook West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-playbook-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-action-playbook-east'],
      territory_exclude_ids: ['scheduler-action-playbook-west'],
      auto_bootstrap: true
    }
  );

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-playbook-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'action playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-action-playbook-east', 'scheduler-action-playbook-west'],
        territory_exclude_ids: []
      }
    }
  );
  const initialWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-playbook-workbench', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  assert.equal(initialWorkbench.status, 'success');
  if (initialWorkbench.status !== 'success') {
    throw new Error('expected geo.routing_policy_action_workbench to succeed');
  }
  const workbenchDriftItem = initialWorkbench.output.items.find((item) => item.review_key === 'drift:missing_active_target:scheduler-action-playbook-east');
  const workbenchApprovalItem = initialWorkbench.output.items.find((item) => item.item_type === 'pending_approval');
  const savedWorkbenchPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-playbook-plan', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler action operator context plan',
      notes: 'Carries current execution target into action artifacts',
      items: [
        {
          review_key: workbenchDriftItem.review_key,
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: workbenchApprovalItem.review_key,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  );
  assert.equal(savedWorkbenchPlan.status, 'success');
  if (savedWorkbenchPlan.status !== 'success') {
    throw new Error('expected geo.routing_policy_batch_plan_upsert to succeed');
  }

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy action workbench',
    playbook_id: 'ops_agent.geo_routing_policy_action_workbench.v1',
    goal: 'Build geo routing policy action workbench',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as { maintenance_type: string; action_workbench: { summary: { actionable_items: number; approve_and_resume_actions: number; current_target_plan_id: string }; report_summary: { current_execution_target: { target_plan_id: string } } } };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_action_workbench');
  assert.equal(maintenancePayload.action_workbench.summary.actionable_items, 2);
  assert.equal(maintenancePayload.action_workbench.summary.approve_and_resume_actions, 1);
  assert.equal(maintenancePayload.action_workbench.summary.current_target_plan_id, savedWorkbenchPlan.output.plan.id);
  assert.equal(maintenancePayload.action_workbench.report_summary.current_execution_target.target_plan_id, savedWorkbenchPlan.output.plan.id);
});

test('scheduler can run geo routing policy action history playbook and commit a history artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Action History 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-action-history-east',
    name: 'Scheduler Action History East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-action-history-east'],
      auto_bootstrap: true
    }
  );
  const actionHistoryWorkbench = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-workbench', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_action_workbench',
    {
      tenant_id: tenant.id
    }
  );
  assert.equal(actionHistoryWorkbench.status, 'success');
  if (actionHistoryWorkbench.status !== 'success') {
    throw new Error('expected geo.routing_policy_action_workbench to succeed');
  }
  const actionHistoryDriftItem = actionHistoryWorkbench.output.items.find((item) => item.review_key === 'drift:missing_active_target:scheduler-action-history-east');
  const savedHistoryPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-plan', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler history operator context plan',
      notes: 'Carries current execution target into history artifacts',
      items: [
        {
          review_key: actionHistoryDriftItem.review_key,
          action_id: 'rollout_policy_from_review'
        }
      ]
    }
  );
  assert.equal(savedHistoryPlan.status, 'success');
  if (savedHistoryPlan.status !== 'success') {
    throw new Error('expected geo.routing_policy_batch_plan_upsert to succeed');
  }

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-rollout', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_review_action_execute',
    {
      tenant_id: tenant.id,
      review_key: 'drift:missing_active_target:scheduler-action-history-east',
      action_id: 'rollout_policy_from_review',
      actor_id: 'ops_manager'
    }
  );
  const shiftedHistoryTargetPlan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'action-history-artifact-target-shift', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'geo.routing_policy_batch_plan_upsert',
    {
      tenant_id: tenant.id,
      plan_name: 'Scheduler action history artifact shifted target plan',
      preferred: true,
      actor_id: 'ops_manager',
      preference_reason: 'audit_target_shift',
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-action-history-east',
          action_id: 'rollout_policy_from_review'
        }
      ]
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy action history',
    playbook_id: 'ops_agent.geo_routing_policy_action_history.v1',
    goal: 'Build geo routing policy action history',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    action_history: {
      summary: {
        total_entries: number;
        succeeded_entries: number;
         current_target_plan_id: string;
         entries_with_execution_target_snapshot: number;
         entries_with_target_plan_drift: number;
         entries_with_target_governance_events_after_execution: number;
       };
       target_audit_summary: {
         entries_with_target_plan_drift: number;
         latest_target_plan_drift: { target_plan_id_at_execution: string; current_target_plan_id: string };
       };
       report_summary: { current_execution_target: { target_plan_id: string } };
       entries: Array<{
         operator_context: { current_execution_target: { target_plan_id: string } };
         execution_target_context: { target_snapshot_after: { current_execution_target: { target_plan_id: string } } };
         historical_current_target_diff: { current_target_plan_id: string; changed: boolean; target_plan_changed: boolean };
         target_governance_trail: {
           has_target_plan_drift: boolean;
           latest_event_after_execution: { event_type: string; touches_current_target: boolean };
         };
       }>;
     };
   };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_action_history');
  assert.equal(maintenancePayload.action_history.summary.total_entries, 1);
  assert.equal(maintenancePayload.action_history.summary.succeeded_entries, 1);
  assert.equal(maintenancePayload.action_history.summary.entries_with_execution_target_snapshot, 1);
  assert.equal(maintenancePayload.action_history.summary.entries_with_target_plan_drift, 1);
  assert.equal(maintenancePayload.action_history.summary.entries_with_target_governance_events_after_execution, 1);
  assert.equal(maintenancePayload.action_history.summary.current_target_plan_id, shiftedHistoryTargetPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.target_audit_summary.latest_target_plan_drift.target_plan_id_at_execution, savedHistoryPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.target_audit_summary.latest_target_plan_drift.current_target_plan_id, shiftedHistoryTargetPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.report_summary.current_execution_target.target_plan_id, shiftedHistoryTargetPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.entries[0].operator_context.current_execution_target.target_plan_id, shiftedHistoryTargetPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.entries[0].execution_target_context.target_snapshot_after.current_execution_target.target_plan_id, savedHistoryPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.entries[0].historical_current_target_diff.current_target_plan_id, shiftedHistoryTargetPlan.output.plan.id);
  assert.equal(maintenancePayload.action_history.entries[0].historical_current_target_diff.changed, true);
  assert.equal(maintenancePayload.action_history.entries[0].historical_current_target_diff.target_plan_changed, true);
  assert.equal(maintenancePayload.action_history.entries[0].target_governance_trail.has_target_plan_drift, true);
  assert.equal(maintenancePayload.action_history.entries[0].target_governance_trail.latest_event_after_execution.event_type, 'batch_plan_preferred');
  assert.equal(maintenancePayload.action_history.entries[0].target_governance_trail.latest_event_after_execution.touches_current_target, true);
});

test('scheduler can run geo routing policy batch actions playbook and commit a batch artifact', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Scheduler Geo Batch Playbook 公司' });
  const harness = createHarness(db);

  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-playbook-east',
    name: 'Scheduler Batch Playbook East',
    city: 'Shanghai',
    region: 'Pudong',
    business_type: 'clinic'
  });
  harness.geoRoutingStore.upsertTerritory({
    tenant_id: tenant.id,
    territory_id: 'scheduler-batch-playbook-west',
    name: 'Scheduler Batch Playbook West',
    city: 'Shanghai',
    region: 'Minhang',
    business_type: 'clinic'
  });

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-playbook-policy', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.routing_policy_upsert',
    {
      tenant_id: tenant.id,
      maintenance_scope: 'territory',
      interval_seconds: 1800,
      dry_run: true,
      territory_status: 'active',
      territory_include_ids: ['scheduler-batch-playbook-east'],
      territory_exclude_ids: ['scheduler-batch-playbook-west'],
      auto_bootstrap: true
    }
  );

  const blockedOverride = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'batch-playbook-override', { agentId: 'ops_agent', userId: 'ops_user' }),
    'geo.override_routing_policy',
    {
      tenant_id: tenant.id,
      reason: 'batch playbook override',
      next_run_at: '2026-01-01T00:00:00.000Z',
      override_patch: {
        interval_seconds: 900,
        territory_include_ids: ['scheduler-batch-playbook-east', 'scheduler-batch-playbook-west'],
        territory_exclude_ids: []
      }
    }
  );

  harness.triggerRunner.createScheduledTrigger({
    tenant_id: tenant.id,
    name: 'Geo routing policy batch actions',
    playbook_id: 'ops_agent.geo_routing_policy_batch_actions.v1',
    goal: 'Run geo routing policy batch actions',
    interval_seconds: 3600,
    next_run_at: '2026-01-01T00:00:00.000Z',
    input: {
      items: [
        {
          review_key: 'drift:missing_active_target:scheduler-batch-playbook-east',
          action_id: 'rollout_policy_from_review'
        },
        {
          review_key: `approval:${blockedOverride.approval_request.id}`,
          action_id: 'approve_and_resume_pending_approval'
        }
      ]
    }
  });

  const tick = await harness.triggerRunner.tick({
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  const artifact = one(db, `SELECT * FROM agent_artifacts WHERE tenant_id = ? AND type = 'ops_maintenance_report' ORDER BY created_at DESC LIMIT 1`, [tenant.id]);
  const maintenancePayload = parseJson(artifact.payload) as {
    maintenance_type: string;
    batch_actions: {
      summary: { succeeded_items: number; failed_items: number; current_target_plan_id_before: string | null; current_target_plan_id_after: string | null; target_changed: boolean };
      report_summary: { target_snapshot_before: { current_execution_target: null }; target_snapshot_after: { current_execution_target: null }; target_transition: { changed: boolean } };
    };
  };

  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].status, 'completed');
  assert.equal(maintenancePayload.maintenance_type, 'geo_routing_policy_batch_actions');
  assert.equal(maintenancePayload.batch_actions.summary.succeeded_items, 2);
  assert.equal(maintenancePayload.batch_actions.summary.failed_items, 0);
  assert.equal(maintenancePayload.batch_actions.summary.current_target_plan_id_before, null);
  assert.equal(maintenancePayload.batch_actions.summary.current_target_plan_id_after, null);
  assert.equal(maintenancePayload.batch_actions.summary.target_changed, false);
  assert.equal(maintenancePayload.batch_actions.report_summary.target_snapshot_before.current_execution_target, null);
  assert.equal(maintenancePayload.batch_actions.report_summary.target_snapshot_after.current_execution_target, null);
  assert.equal(maintenancePayload.batch_actions.report_summary.target_transition.changed, false);
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

test('scheduler HTTP API creates triggers and runs due heartbeat ticks', async () => {
  const tenant = await post('/api/tenants', { name: 'Scheduler API 公司' });
  const trigger = await post('/api/scheduler/triggers', {
    tenant_id: tenant.id,
    name: 'API heartbeat',
    playbook_id: 'analytics_agent.weekly_review.v1',
    goal: 'API heartbeat report',
    interval_seconds: 60,
    next_run_at: '2026-01-01T00:00:00.000Z'
  });
  const tick = await post('/api/scheduler/tick', {
    tenant_id: tenant.id,
    now: '2026-01-01T00:00:00.000Z'
  });

  assert.equal(trigger.name, 'API heartbeat');
  assert.equal(tick.status, 'completed');
  assert.equal(tick.results[0].trigger_id, trigger.id);
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
