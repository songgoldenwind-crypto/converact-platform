import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';
import { all } from '../src/db.js';
import { createDatabase } from '../src/db.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { createServer } from '../src/http.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('voice agent queues RustPBX calls only through approval', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Agent 测试公司' });
  const harness = createHarness(db);

  const result = await harness.runtime.runPlaybook({
    tenant_id: tenant.id,
    user_id: 'user_test',
    playbook_id: 'voice_agent.queue_followup_call.v1',
    goal: '给 lead_123 安排一次外呼',
    lead_id: 'lead_123',
    phone: '+1 415 555 0100',
    script: '确认需求、预算和下次会议时间。',
    route_id: 'default',
    idempotency_key: 'lead_123:first_call'
  });

  assert.equal(result.agent_run.status, 'awaiting_human_approval');
  assert.equal(result.workflow_run.status, 'awaiting_human_approval');
  assert.equal(result.step_outputs.test_route.provider, 'rustpbx');
  assert.equal(result.step_outputs.queue_call.status, 'blocked_pending_approval');

  const approvals = all(db, 'SELECT * FROM approval_requests WHERE tenant_id = ?', [tenant.id]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].action_type, 'voice.queue_call_for_approval');

  const callLogsBeforeApproval = all(db, 'SELECT * FROM voice_call_logs WHERE tenant_id = ?', [tenant.id]);
  assert.equal(callLogsBeforeApproval.length, 0);
});

test('approved voice tool resumes through RustPBX adapter boundary and redacts phone', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Resume 测试公司' });
  const harness = createHarness(db);

  const blocked = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'queue_call'
    },
    'voice.queue_call_for_approval',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_123',
      phone: '+1 415 555 0100',
      script: '确认需求、预算和下次会议时间。',
      idempotency_key: 'lead_123:first_call'
    }
  );

  harness.approvalQueue.decide(tenant.id, blocked.approval_request.id, 'approved', 'user_test');
  const resumed = await harness.toolExecutor.resumeApproved(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'queue_call'
    },
    blocked.approval_request.tool_call_id
  );

  assert.equal(resumed.status, 'success');
  assert.equal(resumed.output.provider, 'rustpbx');
  assert.equal(resumed.output.call_log.status, 'queued');

  const callLogs = all(db, 'SELECT * FROM voice_call_logs WHERE tenant_id = ?', [tenant.id]);
  assert.equal(callLogs.length, 1);
  assert.equal(callLogs[0].phone_redacted.endsWith('0100'), true);
  assert.equal(callLogs[0].phone_redacted.includes('415555'), false);

  const callSessions = harness.voiceStore.listCallSessions({ tenant_id: tenant.id });
  assert.equal(callSessions.length, 1);
  assert.equal(callSessions[0].provider, 'rustpbx');
  assert.equal(callSessions[0].status, 'queued');
  assert.equal(callSessions[0].phone_redacted.endsWith('0100'), true);
});

test('approved voice tool can resume through live RustPBX adapter', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Live RustPBX 公司' });
  const harness = createHarness(db);
  const previousToken = process.env.RUSTPBX_TEST_TOKEN;
  process.env.RUSTPBX_TEST_TOKEN = 'rustpbx-live-token';
  const seenRequests = [];

  const providerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/api/routes/test') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy', route_id: body.route_id, sip_endpoint: 'sip:agent@test.local' }));
      return;
    }
    if (req.url === '/api/calls/queue') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'queued', call_id: 'rust-live-call-1', route_id: body.route_id }));
      return;
    }
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  const providerPort = await listenOnRandomPort(providerServer);
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  try {
    const secret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'rustpbx-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'rustpbx',
        secret_key: 'api_token',
        secret_value: 'rustpbx-live-token',
        env_var_name: 'RUSTPBX_TEST_TOKEN'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'rustpbx-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'rustpbx',
        status: 'configured',
        config: {
          base_url: providerBaseUrl,
          health_path: '/api/health',
          auth_secret_key: 'api_token'
        },
        secret_ref_ids: [secret.output.id]
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-live-policy'),
      'voice.policy_upsert',
      {
        tenant_id: tenant.id,
        recording_mode: 'always',
        recording_retention_days: 14
      }
    );

    const route = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'route-test'),
      'voice.test_sip_route',
      {
        tenant_id: tenant.id,
        route_id: 'priority-route'
      }
    );
    assert.equal(route.output.provider_execution_mode, 'live_provider');
    assert.equal(route.output.status, 'healthy');

    const blocked = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'queue-call', { userId: 'user_test', agentId: 'voice_agent' }),
      'voice.queue_call_for_approval',
      {
        tenant_id: tenant.id,
        lead_id: 'lead_123',
        phone: '+1 415 555 0100',
        script: '确认需求、预算和下次会议时间。',
        route_id: 'priority-route',
        idempotency_key: 'lead_123:live_call'
      }
    );

    harness.approvalQueue.decide(tenant.id, blocked.approval_request.id, 'approved', 'user_test');
    const resumed = await harness.toolExecutor.resumeApproved(
      baseToolContext(tenant.id, 'queue-call', { userId: 'user_test', agentId: 'voice_agent' }),
      blocked.approval_request.tool_call_id
    );

    assert.equal(resumed.status, 'success');
    assert.equal(resumed.output.provider_execution_mode, 'live_provider');
    assert.equal(resumed.output.delivery.external_call_id, 'rust-live-call-1');
    assert.equal(seenRequests.find((entry) => entry.url === '/api/calls/queue').headers.authorization, 'Bearer rustpbx-live-token');
    assert.deepEqual(seenRequests.find((entry) => entry.url === '/api/calls/queue').body.recording, {
      enabled: true,
      mode: 'always',
      retention_days: 14
    });
    assert.equal(harness.voiceStore.listCallSessions({ tenant_id: tenant.id })[0].rustpbx_call_id, 'rust-live-call-1');
  } finally {
    await new Promise((resolve) => providerServer.close(resolve));
    if (previousToken == null) delete process.env.RUSTPBX_TEST_TOKEN;
    else process.env.RUSTPBX_TEST_TOKEN = previousToken;
  }
});

test('voice policy blocks approved outbound calls until consent is recorded', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Consent 公司' });
  const harness = createHarness(db);

  const policy = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-policy'),
    'voice.policy_upsert',
    {
      tenant_id: tenant.id,
      require_outbound_consent: true,
      recording_mode: 'consent_required'
    }
  );
  assert.equal(policy.output.require_outbound_consent, true);

  const blocked = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'queue-without-consent', { userId: 'user_test', agentId: 'voice_agent' }),
    'voice.queue_call_for_approval',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_consent',
      phone: '+1 415 555 0100',
      script: '确认需求。',
      idempotency_key: 'lead_consent:first_call'
    }
  );
  harness.approvalQueue.decide(tenant.id, blocked.approval_request.id, 'approved', 'user_test');
  await assert.rejects(
    harness.toolExecutor.resumeApproved(
      baseToolContext(tenant.id, 'queue-without-consent', { userId: 'user_test', agentId: 'voice_agent' }),
      blocked.approval_request.tool_call_id
    ),
    /outbound call consent required/
  );

  const consent = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'record-consent'),
    'voice.consent_record',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_consent',
      phone: '+1 415 555 0100',
      evidence: { source: 'crm_checkbox', captured_by: 'operator' }
    }
  );
  assert.equal(consent.output.subject_id, 'lead_consent');

  const allowed = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'queue-with-consent', { userId: 'user_test', agentId: 'voice_agent' }),
    'voice.queue_call_for_approval',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_consent',
      phone: '+1 415 555 0100',
      script: '确认需求。',
      idempotency_key: 'lead_consent:second_call'
    }
  );
  harness.approvalQueue.decide(tenant.id, allowed.approval_request.id, 'approved', 'user_test');
  const resumed = await harness.toolExecutor.resumeApproved(
    baseToolContext(tenant.id, 'queue-with-consent', { userId: 'user_test', agentId: 'voice_agent' }),
    allowed.approval_request.tool_call_id
  );

  assert.equal(resumed.status, 'success');
  assert.equal(resumed.output.consent.id, consent.output.id);
  assert.equal(resumed.output.voice_policy.recording_mode, 'consent_required');
});

test('voice recording ingest enforces recording consent and retention policy', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Recording Governance 公司' });
  const harness = createHarness(db);

  const policy = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-recording-policy'),
    'voice.policy_upsert',
    {
      tenant_id: tenant.id,
      recording_mode: 'consent_required',
      recording_retention_days: 45
    }
  );
  assert.equal(policy.output.recording_retention_days, 45);

  const session = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-recording-session', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.rustpbx_create_call_session',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_recording',
      phone: '+1 415 555 0102',
      rustpbx_call_id: 'recording-call-1',
      status: 'completed'
    }
  );

  await assert.rejects(
    harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'recording-without-consent', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.recording_ingest',
      {
        tenant_id: tenant.id,
        call_session_id: session.output.id,
        provider_recording_id: 'rec-1',
        recording_url: 'https://voice.local/recordings/rec-1.wav',
        duration_seconds: 120
      }
    ),
    /voice recording consent required/
  );

  const recordingConsent = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'record-recording-consent'),
    'voice.consent_record',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_recording',
      phone: '+1 415 555 0102',
      consent_type: 'recording',
      evidence: { source: 'ivr_prompt', captured_by: 'system' }
    }
  );

  const recording = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'recording-with-consent', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_ingest',
    {
      tenant_id: tenant.id,
      rustpbx_call_id: 'recording-call-1',
      provider_recording_id: 'rec-1',
      recording_url: 'https://voice.local/recordings/rec-1.wav',
      duration_seconds: 120,
      metadata: { codec: 'opus' }
    }
  );

  assert.equal(recording.output.call_session_id, session.output.id);
  assert.equal(recording.output.consent_id, recordingConsent.output.id);
  assert.equal(recording.output.recording_mode, 'consent_required');
  assert.equal(recording.output.metadata.codec, 'opus');
  assert.ok(recording.output.retention_until);
  assert.equal(harness.voiceStore.listRecordings({ tenant_id: tenant.id }).length, 1);
  assert.equal(harness.voiceStore.getCallSession(tenant.id, session.output.id).metadata.latest_recording_id, recording.output.id);
});

test('voice recording retention enforcement expires and deletes overdue recordings with guardrails', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Retention Enforcement 公司' });
  const harness = createHarness(db);

  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-policy'),
    'voice.policy_upsert',
    {
      tenant_id: tenant.id,
      recording_mode: 'always',
      recording_retention_days: 7
    }
  );

  const session = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-session', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.rustpbx_create_call_session',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_retention',
      phone: '+1 415 555 0103',
      rustpbx_call_id: 'retention-call-1',
      status: 'completed'
    }
  );
  const recording = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-recording', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_ingest',
    {
      tenant_id: tenant.id,
      call_session_id: session.output.id,
      provider_recording_id: 'retention-rec-1',
      recording_url: 'https://voice.local/retention-rec-1.wav',
      duration_seconds: 45,
      retention_until: '2000-01-01T00:00:00.000Z'
    }
  );

  const preview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-preview', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_retention_enforce',
    {
      tenant_id: tenant.id,
      action: 'expire',
      dry_run: true
    }
  );
  assert.equal(preview.output.action, 'expire');
  assert.equal(preview.output.candidate_count, 1);
  assert.equal(harness.voiceStore.getRecording(tenant.id, recording.output.id).status, 'available');

  const expired = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-expire', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_retention_enforce',
    {
      tenant_id: tenant.id,
      action: 'expire'
    }
  );
  assert.equal(expired.output.updated.length, 1);
  assert.equal(expired.output.updated[0].status, 'expired');

  const archived = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-archive', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_retention_enforce',
    {
      tenant_id: tenant.id,
      action: 'archive',
      archive_url_base: 's3://voice-archive/tenant-a'
    }
  );
  assert.equal(archived.output.updated.length, 1);
  assert.equal(archived.output.updated[0].status, 'archived');
  assert.equal(archived.output.updated[0].recording_url, 's3://voice-archive/tenant-a/retention-rec-1');
  assert.equal(archived.output.updated[0].metadata.archived_recording_url, 's3://voice-archive/tenant-a/retention-rec-1');

  const deleted = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'voice-retention-delete', { agentId: 'voice_agent', userId: 'user_test' }),
    'voice.recording_retention_enforce',
    {
      tenant_id: tenant.id,
      action: 'delete'
    }
  );
  assert.equal(deleted.output.updated.length, 1);
  assert.equal(deleted.output.updated[0].status, 'deleted');
  assert.equal(deleted.output.updated[0].recording_url, '');
});

test('call center control plane manages agent presence skill queues and routing snapshots', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Call Center Core 公司' });
  const harness = createHarness(db);

  const agent = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'agent-presence', { agentId: 'voice_agent', userId: 'supervisor' }),
    'voice.agent_presence_upsert',
    {
      tenant_id: tenant.id,
      agent_id: 'agent_001',
      display_name: 'Agent 001',
      status: 'available',
      capacity: 2,
      active_call_count: 0,
      skills: ['billing', 'vip']
    }
  );
  const queue = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'skill-queue', { agentId: 'voice_agent', userId: 'supervisor' }),
    'voice.skill_queue_upsert',
    {
      tenant_id: tenant.id,
      queue_id: 'billing_queue',
      name: 'Billing Queue',
      skill_tags: ['billing'],
      priority: 90
    }
  );
  const membership = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'queue-membership', { agentId: 'voice_agent', userId: 'supervisor' }),
    'voice.skill_queue_assign_agent',
    {
      tenant_id: tenant.id,
      queue_id: 'billing_queue',
      agent_id: 'agent_001',
      priority: 100
    }
  );
  const snapshot = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'routing-snapshot', { agentId: 'voice_agent', userId: 'supervisor' }),
    'voice.call_center_routing_snapshot',
    {
      tenant_id: tenant.id,
      route_id: 'inbound_billing',
      required_skills: ['billing']
    }
  );
  const overview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'call-center-overview', { agentId: 'ops_agent', userId: 'supervisor' }),
    'voice.call_center_ops_overview',
    {
      tenant_id: tenant.id
    }
  );

  assert.equal(agent.output.status, 'available');
  assert.deepEqual(agent.output.skills, ['billing', 'vip']);
  assert.equal(queue.output.queue_id, 'billing_queue');
  assert.equal(membership.output.agent_id, 'agent_001');
  assert.equal(snapshot.output.status, 'assigned');
  assert.equal(snapshot.output.selected_agent_id, 'agent_001');
  assert.equal(snapshot.output.payload.decision_reason, 'available_skill_queue_agent');
  assert.equal(overview.output.summary.available_agents, 1);
  assert.equal(overview.output.summary.active_queue_count, 1);
  assert.equal(overview.output.queues[0].active_member_count, 1);
  await assert.rejects(
    harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'agent-over-capacity', { agentId: 'voice_agent', userId: 'supervisor' }),
      'voice.agent_presence_upsert',
      {
        tenant_id: tenant.id,
        agent_id: 'agent_002',
        capacity: 1,
        active_call_count: 2
      }
    ),
    /active_call_count cannot exceed capacity/
  );
});

test('voice media storage policy plans archive-before-delete maintenance batches', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Media Policy 公司' });
  const harness = createHarness(db);

  const mediaPolicy = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'media-policy', { agentId: 'voice_agent', userId: 'ops_manager' }),
    'voice.media_storage_policy_upsert',
    {
      tenant_id: tenant.id,
      archive_url_base: 's3://voice-archive/policy',
      purge_mode: 'archive_before_delete',
      retention_tiers: [{ status: 'available', action: 'archive' }]
    }
  );
  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'media-voice-policy', { agentId: 'voice_agent', userId: 'ops_manager' }),
    'voice.policy_upsert',
    {
      tenant_id: tenant.id,
      recording_mode: 'always',
      recording_retention_days: 7
    }
  );
  const session = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'media-policy-session', { agentId: 'voice_agent', userId: 'ops_manager' }),
    'voice.rustpbx_create_call_session',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_media_policy',
      rustpbx_call_id: 'media-policy-call',
      status: 'completed'
    }
  );
  await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'media-policy-recording', { agentId: 'voice_agent', userId: 'ops_manager' }),
    'voice.recording_ingest',
    {
      tenant_id: tenant.id,
      call_session_id: session.output.id,
      provider_recording_id: 'media-policy-rec',
      recording_url: 'https://voice.local/media-policy-rec.wav',
      retention_until: '2000-01-01T00:00:00.000Z'
    }
  );
  const plan = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'media-retention-plan', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'voice.recording_retention_plan',
    {
      tenant_id: tenant.id,
      due_before: '2026-01-01T00:00:00.000Z'
    }
  );
  const overview = await harness.toolExecutor.execute(
    baseToolContext(tenant.id, 'media-ops-overview', { agentId: 'ops_agent', userId: 'ops_manager' }),
    'voice.media_ops_overview',
    {
      tenant_id: tenant.id
    }
  );

  assert.equal(mediaPolicy.output.archive_url_base, 's3://voice-archive/policy');
  assert.equal(plan.output.summary.archive_candidates, 1);
  assert.equal(plan.output.summary.recommended_action, 'archive');
  assert.equal(plan.output.execution_guidance.suggested_action, 'archive');
  assert.equal(overview.output.summary.media_storage_policy_count, 1);
  assert.equal(overview.output.summary.due_recording_count, 1);
});

test('voice recording retention can execute live archive and purge through the Rust media sidecar', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Media Retention 公司' });
  const seenRequests = [];
  const previousMediaToken = process.env.VOICE_MEDIA_TEST_TOKEN;
  process.env.VOICE_MEDIA_TEST_TOKEN = 'voice-media-live-token';
  const mediaServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.headers.authorization !== 'Bearer voice-media-live-token') {
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
    if (req.url === '/recordings/purge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'purged',
        purged_recording_url: body.archived_recording_url,
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
  const mediaPort = await listenOnRandomPort(mediaServer);
  const mediaUrl = `http://127.0.0.1:${mediaPort}`;
  const harness = createHarness(db, { voiceMedia: { baseUrl: mediaUrl } });

  try {
    const mediaSecret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        secret_key: 'media_api_token',
        secret_value: 'voice-media-live-token',
        env_var_name: 'VOICE_MEDIA_TEST_TOKEN'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        status: 'configured',
        config: {
          media_service_url: mediaUrl,
          recording_archive_url_base: 's3://voice-archive/live'
        },
        secret_ref_ids: [mediaSecret.output.id]
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-policy'),
      'voice.policy_upsert',
      {
        tenant_id: tenant.id,
        recording_mode: 'always',
        recording_retention_days: 7
      }
    );

    const session = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-session', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.rustpbx_create_call_session',
      {
        tenant_id: tenant.id,
        lead_id: 'lead_media_retention',
        phone: '+1 415 555 0105',
        rustpbx_call_id: 'media-retention-call-1',
        status: 'completed'
      }
    );
    const recording = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-recording', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.recording_ingest',
      {
        tenant_id: tenant.id,
        call_session_id: session.output.id,
        provider_recording_id: 'media-retention-rec-1',
        recording_url: 'https://voice.local/media-retention-rec-1.wav',
        duration_seconds: 30,
        retention_until: '2000-01-01T00:00:00.000Z'
      }
    );

    const archived = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-archive', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.recording_retention_enforce',
      {
        tenant_id: tenant.id,
        action: 'archive'
      }
    );
    assert.equal(archived.output.updated.length, 1);
    assert.equal(archived.output.updated[0].status, 'archived');
    assert.equal(archived.output.updated[0].recording_url, 's3://voice-archive/live/media-retention-rec-1');
    assert.equal(archived.output.updated[0].metadata.retention_boundary, 'rust_media');
    assert.equal(archived.output.updated[0].metadata.retention_operation_result.status, 'archived');

    const deleted = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-media-delete', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.recording_retention_enforce',
      {
        tenant_id: tenant.id,
        action: 'delete'
      }
    );
    assert.equal(deleted.output.updated.length, 1);
    assert.equal(deleted.output.updated[0].status, 'deleted');
    assert.equal(deleted.output.updated[0].metadata.retention_boundary, 'rust_media');
    assert.deepEqual(seenRequests.map((entry) => entry.url), ['/recordings/archive', '/recordings/purge']);
    assert.equal(seenRequests[0].headers.authorization, 'Bearer voice-media-live-token');
    assert.equal(recording.output.provider_recording_id, 'media-retention-rec-1');
  } finally {
    await new Promise((resolve) => mediaServer.close(resolve));
    if (previousMediaToken == null) delete process.env.VOICE_MEDIA_TEST_TOKEN;
    else process.env.VOICE_MEDIA_TEST_TOKEN = previousMediaToken;
  }
});

test('voice runtime deployment snapshots and credential rotation harden production ops surfaces', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Voice Runtime Ops 公司' });
  const harness = createHarness(db);
  const previousRustpbxToken = process.env.RUSTPBX_ROTATION_TOKEN;
  const previousTurnPassword = process.env.WEBRTC_TURN_PASSWORD;
  const previousTurnPasswordNext = process.env.WEBRTC_TURN_PASSWORD_NEXT;
  process.env.RUSTPBX_ROTATION_TOKEN = 'rustpbx-old-token';
  process.env.WEBRTC_TURN_PASSWORD = 'turn-old-secret';
  process.env.WEBRTC_TURN_PASSWORD_NEXT = 'turn-new-secret';

  try {
    const rustpbxSecret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-rustpbx-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'rustpbx',
        secret_key: 'api_token',
        secret_value: 'rustpbx-old-token',
        env_var_name: 'RUSTPBX_ROTATION_TOKEN'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-rustpbx-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'rustpbx',
        status: 'configured',
        config: {
          base_url: 'https://rustpbx.example.com'
        },
        secret_ref_ids: [rustpbxSecret.output.id]
      }
    );
    const webrtcSecret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-webrtc-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        secret_key: 'turn_password',
        secret_value: 'turn-old-secret',
        env_var_name: 'WEBRTC_TURN_PASSWORD'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-webrtc-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        status: 'configured',
        config: {
          media_service_url: 'https://voice-media.example.com',
          turn_urls: ['turn:turn.example.com:3478?transport=udp'],
          turn_username: 'turn-user'
        },
        secret_ref_ids: [webrtcSecret.output.id]
      }
    );

    const snapshot = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-runtime-snapshot', { agentId: 'ops_agent', userId: 'admin_user' }),
      'voice.runtime_deployment_snapshot_create',
      {
        tenant_id: tenant.id
      }
    );
    assert.equal(snapshot.output.status, 'ready');
    assert.equal(snapshot.output.payload.rustpbx.status, 'ready');
    assert.equal(snapshot.output.payload.webrtc.status, 'ready');
    assert.equal(harness.voiceStore.listDeploymentSnapshots({ tenant_id: tenant.id }).length, 1);

    harness.rbacStore.upsertMember({ tenant_id: tenant.id, user_id: 'operator_user', role_code: 'operator' });
    harness.rbacStore.upsertMember({ tenant_id: tenant.id, user_id: 'admin_user', role_code: 'admin' });

    await assert.rejects(
      harness.toolExecutor.execute(
        baseToolContext(tenant.id, 'voice-runtime-rotate-operator', { agentId: 'ops_agent', userId: 'operator_user' }),
        'voice.runtime_credential_rotate',
        {
          tenant_id: tenant.id,
          integration_id: 'opc-native-webrtc',
          secret_key: 'turn_password',
          secret_value: 'turn-new-secret',
          env_var_name: 'WEBRTC_TURN_PASSWORD_NEXT',
          reason: 'rotate turn credential'
        }
      ),
      /missing permission: admin:manage/
    );

    const blocked = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'voice-runtime-rotate-admin', { agentId: 'ops_agent', userId: 'admin_user' }),
      'voice.runtime_credential_rotate',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        secret_key: 'turn_password',
        secret_value: 'turn-new-secret',
        env_var_name: 'WEBRTC_TURN_PASSWORD_NEXT',
        reason: 'rotate turn credential'
      }
    );
    assert.equal(blocked.status, 'blocked_pending_approval');
    harness.approvalQueue.decide(tenant.id, blocked.approval_request.id, 'approved', 'admin_user');

    const resumed = await harness.toolExecutor.resumeApproved(
      baseToolContext(tenant.id, 'voice-runtime-rotate-admin', { agentId: 'ops_agent', userId: 'admin_user' }),
      blocked.approval_request.tool_call_id
    );
    assert.equal(resumed.status, 'success');
    assert.equal(resumed.output.rotation.integration_id, 'opc-native-webrtc');
    assert.equal(resumed.output.secret_ref.env_var_name, 'WEBRTC_TURN_PASSWORD_NEXT');
    assert.equal(resumed.output.health.status, 'healthy');
    assert.equal(harness.voiceStore.listCredentialRotations({ tenant_id: tenant.id, integration_id: 'opc-native-webrtc' }).length, 1);
  } finally {
    if (previousRustpbxToken == null) delete process.env.RUSTPBX_ROTATION_TOKEN;
    else process.env.RUSTPBX_ROTATION_TOKEN = previousRustpbxToken;
    if (previousTurnPassword == null) delete process.env.WEBRTC_TURN_PASSWORD;
    else process.env.WEBRTC_TURN_PASSWORD = previousTurnPassword;
    if (previousTurnPasswordNext == null) delete process.env.WEBRTC_TURN_PASSWORD_NEXT;
    else process.env.WEBRTC_TURN_PASSWORD_NEXT = previousTurnPasswordNext;
  }
});

test('RustPBX webhook events update call session lifecycle', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'RustPBX Webhook 测试公司' });
  const harness = createHarness(db);

  const created = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'rustpbx_session'
    },
    'voice.rustpbx_create_call_session',
    {
      tenant_id: tenant.id,
      lead_id: 'lead_123',
      phone: '+1 415 555 0100',
      rustpbx_call_id: 'rustpbx_call_1',
      status: 'queued'
    }
  );
  assert.equal(created.output.status, 'queued');

  const answered = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'rustpbx_event'
    },
    'voice.rustpbx_ingest_event',
    {
      tenant_id: tenant.id,
      rustpbx_call_id: 'rustpbx_call_1',
      event_type: 'answered',
      payload: { codec: 'opus' }
    }
  );

  assert.equal(answered.output.status, 'active');
  assert.equal(answered.output.metadata.last_event, 'answered');
});

test('WebRTC session uses tenant runtime TURN configuration when present', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'WebRTC Runtime Config 公司' });
  const harness = createHarness(db);
  const previousTurnPassword = process.env.WEBRTC_TURN_PASSWORD;
  process.env.WEBRTC_TURN_PASSWORD = 'turn-secret-live';

  try {
    const secret = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'webrtc-secret'),
      'integration.secret_ref_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        secret_key: 'turn_password',
        secret_value: 'turn-secret-live',
        env_var_name: 'WEBRTC_TURN_PASSWORD'
      }
    );
    await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'webrtc-config'),
      'integration.config_upsert',
      {
        tenant_id: tenant.id,
        integration_id: 'opc-native-webrtc',
        status: 'configured',
        config: {
          stun_urls: ['stun:stun1.example.com:3478'],
          turn_urls: ['turn:turn.example.com:3478?transport=udp'],
          turn_username: 'turn-user'
        },
        secret_ref_ids: [secret.output.id]
      }
    );

    const created = await harness.toolExecutor.execute(
      baseToolContext(tenant.id, 'webrtc-runtime-session', { agentId: 'voice_agent', userId: 'user_test' }),
      'voice.webrtc_create_session',
      {
        tenant_id: tenant.id,
        endpoint_id: 'browser_agent',
        ttl_seconds: 300
      }
    );

    assert.equal(created.output.session.ice_servers.length, 2);
    assert.equal(created.output.session.ice_servers[0].urls, 'stun:stun1.example.com:3478');
    assert.equal(created.output.session.ice_servers[1].urls, 'turn:turn.example.com:3478?transport=udp');
    assert.equal(created.output.session.ice_servers[1].username, 'turn-user');
    assert.equal(created.output.session.ice_servers[1].credential, 'turn-secret-live');
  } finally {
    if (previousTurnPassword == null) delete process.env.WEBRTC_TURN_PASSWORD;
    else process.env.WEBRTC_TURN_PASSWORD = previousTurnPassword;
  }
});

test('WebRTC foundation creates tokenized sessions and records signaling lifecycle', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'WebRTC 测试公司' });
  const harness = createHarness(db);
  const callSession = harness.voiceStore.createCallSession({
    tenant_id: tenant.id,
    provider: 'rustpbx',
    lead_id: 'lead_123',
    status: 'planned'
  });

  const created = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'webrtc_session'
    },
    'voice.webrtc_create_session',
    {
      tenant_id: tenant.id,
      call_session_id: callSession.id,
      endpoint_id: 'browser_agent',
      ttl_seconds: 300
    }
  );

  assert.equal(created.output.session.status, 'initialized');
  assert.equal(typeof created.output.token, 'string');
  assert.equal(harness.voiceStore.getCallSession(tenant.id, callSession.id).webrtc_session_id, created.output.session.id);

  const signaled = await harness.toolExecutor.execute(
    {
      tenantId: tenant.id,
      workspaceId: 'default',
      userId: 'user_test',
      agentId: 'voice_agent',
      workflowRunId: null,
      agentRunId: null,
      playbookId: 'manual',
      stepId: 'webrtc_signal'
    },
    'voice.webrtc_signal',
    {
      tenant_id: tenant.id,
      webrtc_session_id: created.output.session.id,
      signal_type: 'offer',
      payload: { sdp: 'v=0...' }
    }
  );

  assert.equal(signaled.output.session.status, 'offer_created');
  assert.equal(signaled.output.signals[0].signal_type, 'offer');
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

test('voice HTTP API exposes approval-safe RustPBX and WebRTC surfaces', async () => {
  const tenant = await post('/api/tenants', { name: 'Voice API 公司' });
  const queued = await post('/api/voice/calls/queue', {
    tenant_id: tenant.id,
    lead_id: 'lead_api',
    phone: '+1 415 555 0100',
    script: '确认需求。',
    idempotency_key: 'lead_api:first_call'
  });
  assert.equal(queued.status, 'blocked_pending_approval');
  assert.equal(queued.approval_request.action_type, 'voice.queue_call_for_approval');

  const callSession = await post('/api/voice/rustpbx/sessions', {
    tenant_id: tenant.id,
    lead_id: 'lead_api',
    rustpbx_call_id: 'api_call_1',
    status: 'queued'
  });
  const event = await post('/api/voice/rustpbx/events', {
    tenant_id: tenant.id,
    rustpbx_call_id: 'api_call_1',
    event_type: 'answered'
  });
  const webrtc = await post('/api/voice/webrtc/sessions', {
    tenant_id: tenant.id,
    call_session_id: callSession.id,
    endpoint_id: 'browser_api'
  });
  const signal = await post('/api/voice/webrtc/signals', {
    tenant_id: tenant.id,
    webrtc_session_id: webrtc.session.id,
    signal_type: 'offer',
    payload: { sdp: 'v=0...' }
  });
  const policy = await post('/api/voice/policies', {
    tenant_id: tenant.id,
    require_outbound_consent: true,
    recording_mode: 'consent_required'
  });
  const policies = await get(`/api/voice/policies?tenant_id=${tenant.id}`);
  const consent = await post('/api/voice/consents', {
    tenant_id: tenant.id,
    lead_id: 'lead_api',
    phone: '+1 415 555 0100',
    evidence: { source: 'api' }
  });
  const consents = await get(`/api/voice/consents?tenant_id=${tenant.id}&subject_type=lead&subject_id=lead_api`);
  const recordingConsent = await post('/api/voice/consents', {
    tenant_id: tenant.id,
    lead_id: 'lead_api',
    phone: '+1 415 555 0100',
    consent_type: 'recording',
    evidence: { source: 'api-recording' }
  });
  const recording = await post('/api/voice/recordings', {
    tenant_id: tenant.id,
    call_session_id: callSession.id,
    provider_recording_id: 'api-recording-1',
    recording_url: 'https://voice.local/api-recording-1.wav',
    duration_seconds: 95
  });
  const recordings = await get(`/api/voice/recordings?tenant_id=${tenant.id}&call_session_id=${callSession.id}`);
  const retentionPreview = await post('/api/voice/recordings/retention-enforce', {
    tenant_id: tenant.id,
    action: 'expire',
    dry_run: true,
    due_before: '9999-12-31T00:00:00.000Z'
  });
  const agentPresence = await post('/api/voice/agent-presence', {
    tenant_id: tenant.id,
    agent_id: 'api_agent_001',
    display_name: 'API Agent',
    status: 'available',
    capacity: 1,
    skills: ['support']
  });
  const skillQueue = await post('/api/voice/skill-queues', {
    tenant_id: tenant.id,
    queue_id: 'support_queue',
    name: 'Support Queue',
    skill_tags: ['support']
  });
  const queueMembership = await post('/api/voice/queue-memberships', {
    tenant_id: tenant.id,
    queue_id: 'support_queue',
    agent_id: 'api_agent_001'
  });
  const routingSnapshot = await post('/api/voice/routing-snapshots', {
    tenant_id: tenant.id,
    route_id: 'api_support',
    required_skills: ['support']
  });
  const callCenterOverview = await get(`/api/voice/call-center/ops-overview?tenant_id=${tenant.id}`);
  const mediaPolicy = await post('/api/voice/media-storage-policies', {
    tenant_id: tenant.id,
    archive_url_base: 's3://voice-api-archive',
    purge_mode: 'archive_before_delete'
  });
  const retentionPlan = await get(`/api/voice/recordings/retention-plan?tenant_id=${tenant.id}&due_before=9999-12-31T00:00:00.000Z`);
  const mediaOverview = await get(`/api/voice/media/ops-overview?tenant_id=${tenant.id}`);
  const deploymentSnapshot = await post('/api/voice/deployments/snapshot', {
    tenant_id: tenant.id
  });
  const dueRecordings = await get(`/api/voice/recordings?tenant_id=${tenant.id}&call_session_id=${callSession.id}&due_before=9999-12-31T00:00:00.000Z`);
  const deployments = await get(`/api/voice/deployments?tenant_id=${tenant.id}`);

  assert.equal(event.status, 'active');
  assert.equal(webrtc.session.call_session_id, callSession.id);
  assert.equal(signal.session.status, 'offer_created');
  assert.equal(policy.require_outbound_consent, true);
  assert.equal(policies[0].policy_id, 'default');
  assert.equal(consent.subject_id, 'lead_api');
  assert.equal(consents[0].id, consent.id);
  assert.equal(recordingConsent.consent_type, 'recording');
  assert.equal(recording.call_session_id, callSession.id);
  assert.equal(recordings[0].provider_recording_id, 'api-recording-1');
  assert.equal(retentionPreview.action, 'expire');
  assert.equal(retentionPreview.candidate_count, 1);
  assert.equal(agentPresence.agent_id, 'api_agent_001');
  assert.equal(skillQueue.queue_id, 'support_queue');
  assert.equal(queueMembership.agent_id, 'api_agent_001');
  assert.equal(routingSnapshot.status, 'assigned');
  assert.equal(callCenterOverview.summary.available_agents, 1);
  assert.equal(mediaPolicy.archive_url_base, 's3://voice-api-archive');
  assert.equal(retentionPlan.summary.expire_candidates, 1);
  assert.equal(mediaOverview.summary.media_storage_policy_count, 1);
  assert.equal(deploymentSnapshot.payload.rustpbx.integration_id, 'rustpbx');
  assert.equal(dueRecordings[0].id, recording.id);
  assert.equal(deployments[0].id, deploymentSnapshot.id);
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
