import { executeTool, toolContext, requiredQuery } from './_helpers.js';

export async function routeWikiApi(
  harness: any,
  method: string,
  path: string,
  url: URL,
  body: any,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (!path.startsWith('/api/knowledge/') && !path.startsWith('/api/wiki/') && !path.startsWith('/api/search/') && !path.startsWith('/api/notebooks')) {
    return undefined;
  }

  if (path === '/api/knowledge/sources' && method === 'GET') {
    return harness.wikiStore.listSources({
      tenant_id: requiredQuery(url, 'tenant_id'),
      workspace_id: url.searchParams.get('workspace_id') || 'default'
    });
  }

  if (path === '/api/knowledge/sources' && method === 'POST') {
    const result = await harness.toolExecutor.execute(
      toolContext(body, 'knowledge_agent', 'knowledge.source_ingest'),
      'knowledge.source_ingest',
      body
    );
    return { status: 201, data: result.output };
  }

  if (path === '/api/wiki/pages' && method === 'GET') {
    return harness.wikiStore.listPages({
      tenant_id: requiredQuery(url, 'tenant_id'),
      workspace_id: url.searchParams.get('workspace_id') || 'default',
      category: url.searchParams.get('category')
    });
  }

  if (path === '/api/wiki/pages' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, 'knowledge_agent', 'wiki.page_upsert'), 'wiki.page_upsert', body);
    return { status: 201, data: result.output };
  }

  const wikiPageMatch = path.match(/^\/api\/wiki\/pages\/([^/]+)$/);
  if (wikiPageMatch && method === 'GET') {
    const tenantId = requiredQuery(url, 'tenant_id');
    const page = harness.wikiStore.getPageBySlug(tenantId, url.searchParams.get('workspace_id') || 'default', decodeURIComponent(wikiPageMatch[1]));
    if (!page) {
      const error = new Error('wiki page not found');
      (error as any).status = 404;
      throw error;
    }
    return page;
  }

  if (path === '/api/wiki/index' && method === 'GET') {
    return (
      harness.wikiStore.latestIndex({
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default'
      }) || { content_markdown: '# Wiki Index\n', page_count: 0 }
    );
  }

  if (path === '/api/wiki/index/build' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, 'knowledge_agent', 'wiki.index_build'), 'wiki.index_build', body);
    return result.output;
  }

  if (path === '/api/wiki/query' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, 'knowledge_agent', 'wiki.query'), 'wiki.query', body);
    return result.output;
  }

  if (path === '/api/wiki/lint' && method === 'POST') {
    const result = await harness.toolExecutor.execute(toolContext(body, 'knowledge_agent', 'wiki.lint'), 'wiki.lint', body);
    return result.output;
  }

  if (path === '/api/wiki/synthesize' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, 'knowledge_agent', 'wiki.synthesize_page_draft') };
  }

  if (path === '/api/wiki/diff' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, 'knowledge_agent', 'wiki.propose_page_diff') };
  }

  if (path === '/api/wiki/contradictions' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, 'knowledge_agent', 'wiki.detect_contradictions') };
  }

  if (path === '/api/search/sessions' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        status: url.searchParams.get('status')
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'search.session_list'
    );
  }

  if (path === '/api/search/sessions' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'search.session_upsert') };
  }

  if (path === '/api/search/runs' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        session_id: url.searchParams.get('session_id'),
        notebook_id: url.searchParams.get('notebook_id'),
        limit: Number(url.searchParams.get('limit') || 50)
      },
      url.searchParams.get('agent_id') || 'orchestration_agent',
      'search.run_list'
    );
  }

  if (path === '/api/search/query' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'orchestration_agent', 'search.query') };
  }

  if (path === '/api/notebooks' && method === 'GET') {
    return await executeTool(
      harness,
      {
        tenant_id: requiredQuery(url, 'tenant_id'),
        workspace_id: url.searchParams.get('workspace_id') || 'default',
        user_id: url.searchParams.get('user_id') || 'user',
        status: url.searchParams.get('status')
      },
      url.searchParams.get('agent_id') || 'knowledge_agent',
      'notebook.list'
    );
  }

  if (path === '/api/notebooks' && method === 'POST') {
    return { status: 201, data: await executeTool(harness, body, body.agent_id || 'knowledge_agent', 'notebook.upsert') };
  }

  const notebookAttachMatch = path.match(/^\/api\/notebooks\/([^/]+)\/sources$/);
  if (notebookAttachMatch && method === 'POST') {
    return {
      status: 201,
      data: await executeTool(
        harness,
        {
          ...body,
          tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'),
          notebook_id: notebookAttachMatch[1]
        },
        body.agent_id || 'knowledge_agent',
        'notebook.attach_source'
      )
    };
  }

  const notebookQueryMatch = path.match(/^\/api\/notebooks\/([^/]+)\/query$/);
  if (notebookQueryMatch && method === 'POST') {
    return {
      status: 201,
      data: await executeTool(
        harness,
        {
          ...body,
          tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'),
          notebook_id: notebookQueryMatch[1]
        },
        body.agent_id || 'knowledge_agent',
        'notebook.query_cited'
      )
    };
  }

  const notebookAudioMatch = path.match(/^\/api\/notebooks\/([^/]+)\/audio-overview$/);
  if (notebookAudioMatch && method === 'POST') {
    return {
      status: 201,
      data: await executeTool(
        harness,
        {
          ...body,
          tenant_id: body.tenant_id || requiredQuery(url, 'tenant_id'),
          notebook_id: notebookAudioMatch[1]
        },
        body.agent_id || 'knowledge_agent',
        'notebook.generate_audio_overview_draft'
      )
    };
  }

  return undefined;
}
