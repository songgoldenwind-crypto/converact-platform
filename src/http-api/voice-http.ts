import { executeTool, toolContext, requiredQuery } from './_helpers.js';

export async function routeVoiceApi(
  db: unknown,
  harness: any,
  method: string,
  path: string,
  url: URL,
  body: any,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/voice/')) {
    return undefined;
  }

  if (path === '/api/voice/sessions' && method === 'GET') {
    return harness.voiceStore.listCallSessions({ tenant_id: requiredQuery(url, 'tenant_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/call-logs' && method === 'GET') {
    return harness.voiceStore.listCallLogs({ tenant_id: requiredQuery(url, 'tenant_id'), status: url.searchParams.get('status'), direction: url.searchParams.get('direction'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/call-center/workbench' && method === 'GET') {
    return harness.voiceStore.getCallCenterWorkbench({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/manual-outbound' && method === 'POST') {
    return { status: 201, data: harness.voiceStore.startManualOutboundCall({ ...body, actor_id: body.actor_id || body.agent_id || 'manual-agent' }) };
  }
  if (path === '/api/voice/inbound' && method === 'POST') {
    return { status: 201, data: harness.voiceStore.createInboundCall({ ...body, actor_id: body.actor_id || body.agent_id || 'manual-agent' }) };
  }
  const voiceAnswerMatch = path.match(/^\/api\/voice\/sessions\/([^/]+)\/answer$/);
  if (voiceAnswerMatch && method === 'POST') {
    return { status: 200, data: harness.voiceStore.answerCallSession({ ...body, call_session_id: voiceAnswerMatch[1], actor_id: body.actor_id || body.agent_id || 'manual-agent' }) };
  }
  const voiceCompleteMatch = path.match(/^\/api\/voice\/sessions\/([^/]+)\/complete$/);
  if (voiceCompleteMatch && method === 'POST') {
    const completion = harness.voiceStore.completeManualCall({ ...body, call_session_id: voiceCompleteMatch[1], actor_id: body.actor_id || body.agent_id || 'manual-agent' });
    return { status: 200, data: completion };
  }
  if (path === '/api/voice/calls/queue' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, body.agent_id || 'voice_agent', 'voice.queue_call_for_approval'), 'voice.queue_call_for_approval', body);
    return {
      status: result.status === 'blocked_pending_approval' ? 202 : 201,
      data: result
    };
  }
  if (path === '/api/voice/agent-presence' && method === 'GET') {
    return harness.voiceStore.listAgentPresence({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), status: url.searchParams.get('status'), skill: url.searchParams.get('skill'), limit: Number(url.searchParams.get('limit') || 100) });
  }
  if (path === '/api/voice/agent-presence' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.runtime_agent_id || 'voice_agent', 'voice.agent_presence_upsert') };
  }
  if (path === '/api/voice/skill-queues' && method === 'GET') {
    return harness.voiceStore.listSkillQueues({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 100) });
  }
  if (path === '/api/voice/skill-queues' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.runtime_agent_id || 'voice_agent', 'voice.skill_queue_upsert') };
  }
  if (path === '/api/voice/queue-memberships' && method === 'GET') {
    return harness.voiceStore.listQueueMemberships({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), queue_id: url.searchParams.get('queue_id'), agent_id: url.searchParams.get('agent_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 200) });
  }
  if (path === '/api/voice/queue-memberships' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.runtime_agent_id || 'voice_agent', 'voice.skill_queue_assign_agent') };
  }
  if (path === '/api/voice/routing-snapshots' && method === 'GET') {
    return harness.voiceStore.listRoutingSnapshots({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), route_id: url.searchParams.get('route_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/routing-snapshots' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.runtime_agent_id || 'voice_agent', 'voice.call_center_routing_snapshot') };
  }
  if (path === '/api/voice/call-center/ops-overview' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'ops_agent', 'voice.call_center_ops_overview');
  }
  if (path === '/api/voice/policies' && method === 'GET') {
    return harness.voiceStore.listPolicies({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/policies' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.policy_upsert') };
  }
  if (path === '/api/voice/consents' && method === 'GET') {
    return harness.voiceStore.listConsents({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), subject_type: url.searchParams.get('subject_type'), subject_id: url.searchParams.get('subject_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/consents' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.consent_record') };
  }
  if (path === '/api/voice/recordings' && method === 'GET') {
    return harness.voiceStore.listRecordings({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), call_session_id: url.searchParams.get('call_session_id'), status: url.searchParams.get('status'), due_before: url.searchParams.get('due_before'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/recordings' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.recording_ingest') };
  }
  if (path === '/api/voice/recordings/retention-enforce' && method === 'POST') {
    return { status: 200, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.recording_retention_enforce') };
  }
  if (path === '/api/voice/media-storage-policies' && method === 'GET') {
    return harness.voiceStore.listMediaStoragePolicies({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 50) });
  }
  if (path === '/api/voice/media-storage-policies' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.media_storage_policy_upsert') };
  }
  if (path === '/api/voice/recordings/retention-plan' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', policy_id: url.searchParams.get('policy_id') || 'default', due_before: url.searchParams.get('due_before'), limit: Number(url.searchParams.get('limit') || 100) }, url.searchParams.get('agent_id') || 'ops_agent', 'voice.recording_retention_plan');
  }
  if (path === '/api/voice/media/ops-overview' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', limit: Number(url.searchParams.get('limit') || 50) }, url.searchParams.get('agent_id') || 'ops_agent', 'voice.media_ops_overview');
  }
  if (path === '/api/voice/deployments' && method === 'GET') {
    return harness.voiceStore.listDeploymentSnapshots({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') || 20) });
  }
  if (path === '/api/voice/deployments/snapshot' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'ops_agent', 'voice.runtime_deployment_snapshot_create') };
  }
  if (path === '/api/voice/credential-rotations' && method === 'GET') {
    return harness.voiceStore.listCredentialRotations({ tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id'), integration_id: url.searchParams.get('integration_id'), secret_key: url.searchParams.get('secret_key'), limit: Number(url.searchParams.get('limit') || 20) });
  }
  if (path === '/api/voice/credentials/rotate' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, body.agent_id || 'ops_agent', 'voice.runtime_credential_rotate'), 'voice.runtime_credential_rotate', body);
    return { status: result.status === 'blocked_pending_approval' ? 202 : 201, data: result };
  }
  if (path === '/api/voice/rustpbx/sessions' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.rustpbx_create_call_session') };
  }
  if (path === '/api/voice/rustpbx/events' && method === 'POST') {
    const callSession = await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.rustpbx_ingest_event');
    return { status: 201, data: callSession };
  }
  if (path === '/api/voice/webrtc/sessions' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.webrtc_create_session') };
  }
  if (path === '/api/voice/webrtc/signals' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'voice_agent', 'voice.webrtc_signal') };
  }

  return undefined;
}
