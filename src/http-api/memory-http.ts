import { executeTool, requiredQuery } from './_helpers.js';

export async function routeMemoryApi(
  harness: any,
  method: string,
  path: string,
  url: URL,
  body: any,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/artifacts') && !path.startsWith('/api/campaign-artifacts') && !path.startsWith('/api/scheduler') && !path.startsWith('/api/transcripts') && !path.startsWith('/api/memory')) {
    return undefined;
  }

  if (path === '/api/artifacts' && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', status: url.searchParams.get('status'), type: url.searchParams.get('type'), workflow_run_id: url.searchParams.get('workflow_run_id'), agent_run_id: url.searchParams.get('agent_run_id'), parent_artifact_id: url.searchParams.get('parent_artifact_id'), limit: Number(url.searchParams.get('limit') || 100) }, url.searchParams.get('agent_id') || 'orchestration_agent', 'artifact.list');
  }

  if (path === '/api/campaign-artifacts/latest' && method === 'GET') {
    const artifact = harness.artifactStore.list({ tenant_id: requiredQuery(url, 'tenant_id'), type: 'marketing_campaign_snapshot', limit: 1 })[0] || null;
    return { status: 200, data: { artifact } };
  }

  if (path === '/api/campaign-artifacts' && method === 'POST') {
    if (!body.tenant_id) { const error = new Error('tenant_id is required'); (error as any).status = 400; throw error; }
    if (!body.snapshot) { const error = new Error('snapshot is required'); (error as any).status = 400; throw error; }
    const previous = harness.artifactStore.list({ tenant_id: body.tenant_id, type: 'marketing_campaign_snapshot', limit: 1 })[0] || null;
    const artifact = harness.artifactStore.commit({ tenant_id: body.tenant_id, workflow_run_id: body.workflow_run_id || null, agent_run_id: body.agent_run_id || null, type: 'marketing_campaign_snapshot', status: body.status || 'approved', version: previous ? Number(previous.version || 1) + 1 : 1, parent_artifact_id: previous?.id || null, payload: { ...body.snapshot, saved_at: new Date().toISOString() } });
    return { status: 201, data: { artifact } };
  }

  const artifactMatch = path.match(/^\/api\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', artifact_id: artifactMatch[1] }, url.searchParams.get('agent_id') || 'orchestration_agent', 'artifact.get');
  }

  const artifactReviewsMatch = path.match(/^\/api\/artifacts\/([^/]+)\/reviews$/);
  if (artifactReviewsMatch && method === 'GET') {
    return await executeTool(harness, { tenant_id: requiredQuery(url, 'tenant_id'), workspace_id: url.searchParams.get('workspace_id') || 'default', user_id: url.searchParams.get('user_id') || 'user', artifact_id: artifactReviewsMatch[1] }, url.searchParams.get('agent_id') || 'orchestration_agent', 'artifact.review_list');
  }

  const artifactReviewDecisionMatch = path.match(/^\/api\/artifacts\/([^/]+)\/review$/);
  if (artifactReviewDecisionMatch && method === 'POST') {
    return { status: 200, data: await executeTool(harness, { ...body, tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'), artifact_id: artifactReviewDecisionMatch[1] }, body.agent_id || 'orchestration_agent', 'artifact.review') };
  }

  if (path === '/api/scheduler/triggers' && method === 'POST') {
    return { status: 201, data: harness.triggerRunner.createScheduledTrigger(body) };
  }
  if (path === '/api/scheduler/triggers' && method === 'GET') {
    return harness.triggerRunner.listScheduledTriggers({ tenant_id: requiredQuery(url, 'tenant_id'), status: url.searchParams.get('status'), playbook_id: url.searchParams.get('playbook_id'), trigger_type: url.searchParams.get('trigger_type'), limit: Number(url.searchParams.get('limit') || 200) });
  }
  if (path === '/api/scheduler/tick' && method === 'POST') {
    return await harness.triggerRunner.tick(body);
  }

  if (path === '/api/transcripts' && method === 'POST') {
    return { status: 201, data: harness.transcriptStore.append(body) };
  }

  if (path === '/api/memory/search' && method === 'POST') {
    return await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'memory.search');
  }
  if (path === '/api/memory/recall' && method === 'POST') {
    return await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'memory.recall');
  }
  if (path === '/api/memory' && method === 'GET') {
    return harness.memoryStore.search({ tenant_id: requiredQuery(url, 'tenant_id'), scope_type: url.searchParams.get('scope_type'), scope_id: url.searchParams.has('scope_id') ? url.searchParams.get('scope_id') : null, memory_type: url.searchParams.get('memory_type'), status: url.searchParams.get('status') || 'active' });
  }
  if (path === '/api/memory/candidates' && method === 'GET') {
    return harness.memoryPromoter.listCandidates(requiredQuery(url, 'tenant_id'), url.searchParams.get('status') || 'candidate');
  }
  if (path === '/api/memory/candidates/propose' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'memory.propose') };
  }
  if (path === '/api/memory/candidates/extract' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'memory.extract_candidates_from_transcript') };
  }
  if (path === '/api/memory/profile/synthesize' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'memory.synthesize_profile') };
  }
  const memoryApproveMatch = path.match(/^\/api\/memory\/candidates\/([^/]+)\/approve$/);
  if (memoryApproveMatch && method === 'POST') {
    return harness.memoryPromoter.approve(body.tenant_id || requiredQuery(url, 'tenant_id'), memoryApproveMatch[1]);
  }
  const memoryRejectMatch = path.match(/^\/api\/memory\/candidates\/([^/]+)\/reject$/);
  if (memoryRejectMatch && method === 'POST') {
    return harness.memoryPromoter.reject(body.tenant_id || requiredQuery(url, 'tenant_id'), memoryRejectMatch[1]);
  }
  const memoryStatusMatch = path.match(/^\/api\/memory\/([^/]+)\/status$/);
  if (memoryStatusMatch && method === 'POST') {
    return await executeTool(harness, { ...body, tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'), memory_id: memoryStatusMatch[1] }, body.agent_id || 'orchestration_agent', 'memory.mark_status');
  }

  return undefined;
}
