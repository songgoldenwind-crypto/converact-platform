import { executeTool, requiredQuery } from './_helpers.js';

export async function routeIntegrationsApi(
  harness: any,
  method: string,
  path: string,
  url: URL,
  body: any,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/integrations/') && !path.startsWith('/api/skills') && !path.startsWith('/api/mcp/')) {
    return undefined;
  }

  if (path === '/api/integrations/catalog' && method === 'GET') {
    return harness.integrationCatalog.list({
      category: url.searchParams.get('category'),
      source_type: url.searchParams.get('source_type'),
      capability: url.searchParams.get('capability'),
      min_stability: url.searchParams.get('min_stability')
    });
  }

  if (path === '/api/integrations/recommend' && method === 'POST') {
    return harness.integrationCatalog.recommend(body);
  }

  if (path === '/api/integrations/stable-stack' && method === 'GET') {
    return harness.integrationCatalog.stableStackForConveract();
  }

  if (path === '/api/integrations/configs' && method === 'GET') {
    return harness.integrationConfigStore.listConfigs({
      tenant_id: requiredQuery(url, 'tenant_id'),
      workspace_id: url.searchParams.get('workspace_id') || 'default',
      status: url.searchParams.get('status')
    });
  }

  if (path === '/api/integrations/secret-refs' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'integration.secret_ref_upsert') };
  }

  if (path === '/api/integrations/configs' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'integration.config_upsert') };
  }

  if (path === '/api/integrations/health-check' && method === 'POST') {
    return await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'integration.health_check');
  }

  if (path === '/api/integrations/providers' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        category: url.searchParams.get('category'),
        source_type: url.searchParams.get('source_type'),
        capability: url.searchParams.get('capability'),
        status: url.searchParams.get('status'),
        configured_only: url.searchParams.get('configured_only') === 'true'
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'integration.provider_inventory'
    );
  }

  if (path === '/api/integrations/providers/select' && method === 'POST') {
    return await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'integration.provider_select');
  }

  if (path === '/api/integrations/provider-policies' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        status: url.searchParams.get('status'),
        use_case: url.searchParams.get('use_case'),
        category: url.searchParams.get('category'),
        capability: url.searchParams.get('capability')
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'integration.provider_policy_list'
    );
  }

  if (path === '/api/integrations/provider-policies' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'integration.provider_policy_upsert') };
  }

  if (path === '/api/integrations/providers/health-snapshot' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'integration.provider_health_snapshot') };
  }

  if (path === '/api/integrations/providers/health-snapshots' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        integration_id: url.searchParams.get('integration_id'),
        limit: Number(url.searchParams.get('limit') || 50)
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'integration.provider_health_snapshots'
    );
  }

  if (path === '/api/skills' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        status: url.searchParams.get('status'),
        applicable_agent: url.searchParams.get('applicable_agent')
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'skill.tenant_list'
    );
  }

  if (path === '/api/skills' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'skill.tenant_upsert') };
  }

  if (path === '/api/skills/candidates' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        status: url.searchParams.get('status') || 'candidate'
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'skill.candidate_list'
    );
  }

  if (path === '/api/skills/candidates' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'skill.candidate_propose') };
  }

  const skillCandidateReviewMatch = path.match(/^\/api\/skills\/candidates\/([^/]+)\/review$/);
  if (skillCandidateReviewMatch && method === 'POST') {
    return {
      status: 200,
      data: await executeTool(
        harness,
        {
          ...body,
          tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'),
          candidate_id: skillCandidateReviewMatch[1]
        },
        body.agent_id || 'orchestration_agent',
        'skill.candidate_review'
      )
    };
  }

  if (path === '/api/mcp/servers' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        status: url.searchParams.get('status'),
        capability: url.searchParams.get('capability'),
        integration_id: url.searchParams.get('integration_id')
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'mcp.server_list'
    );
  }

  if (path === '/api/mcp/servers' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'mcp.server_upsert') };
  }

  if (path === '/api/mcp/servers/select' && method === 'POST') {
    return await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'mcp.server_select');
  }

  const mcpHealthMatch = path.match(/^\/api\/mcp\/servers\/([^/]+)\/health-check$/);
  if (mcpHealthMatch && method === 'POST') {
    return {
      status: 200,
      data: await executeTool(
        harness,
        {
          ...body,
          tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'),
          server_id: mcpHealthMatch[1]
        },
        body.agent_id || 'orchestration_agent',
        'mcp.server_health_check'
      )
    };
  }

  if (path === '/api/mcp/servers/snapshots' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        server_id: url.searchParams.get('server_id'),
        limit: Number(url.searchParams.get('limit') || 50)
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'mcp.server_snapshots'
    );
  }

  return undefined;
}
