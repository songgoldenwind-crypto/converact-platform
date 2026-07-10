import { KnowledgeStore } from './knowledge-store.js';
import { retrieveAndAnswer } from './knowledge-retriever.js';
import { logKnowledgeQuery, getKnowledgeAnalytics } from './knowledge-analytics.js';
import { resolveAuthContext } from '../../../middleware/auth.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeKnowledgeApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new KnowledgeStore(db);

  if (path === '/api/knowledge/bases' && method === 'GET') {
    const ctx = requireAuth(headers);
    return store.listKnowledgeBases(ctx.tenantId!);
  }

  if (path === '/api/knowledge/bases' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { name?: string; description?: string };
    if (!input?.name) {
      return { status: 400, data: { error: 'name is required' } };
    }
    const kb = store.createKnowledgeBase({
      tenant_id: ctx.tenantId!,
      name: input.name,
      description: input.description
    });
    return { status: 201, data: kb };
  }

  const docsMatch = path.match(/^\/api\/knowledge\/bases\/([^/]+)\/documents$/);
  if (docsMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    // Verify KB belongs to caller's tenant before listing documents.
    const kb = store.getKnowledgeBase(docsMatch[1]);
    if (!kb || kb.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'knowledge base not found' } };
    }
    return store.listDocuments(docsMatch[1]);
  }

  if (docsMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const kbId = docsMatch[1];
    // Verify KB belongs to caller's tenant.
    const kb = store.getKnowledgeBase(kbId);
    if (!kb || kb.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'knowledge base not found' } };
    }
    const input = body as { title?: string; content?: string; content_type?: string };
    if (!input?.title || !input?.content) {
      return { status: 400, data: { error: 'title and content are required' } };
    }
    const doc = store.addDocument({
      knowledge_base_id: kbId,
      tenant_id: ctx.tenantId!,
      title: input.title,
      content: input.content,
      content_type: input.content_type
    });
    return { status: 201, data: doc };
  }

  const deleteMatch = path.match(/^\/api\/knowledge\/documents\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    const ctx = requireAuth(headers);
    // Verify document belongs to caller's tenant before deleting.
    const doc = store.getDocument(deleteMatch[1]);
    if (!doc || doc.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'document not found' } };
    }
    store.deleteDocument(deleteMatch[1]);
    return { status: 204, data: null };
  }

  if (path === '/api/knowledge/search' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { query?: string; limit?: number };
    if (!input?.query) {
      return { status: 400, data: { error: 'query is required' } };
    }
    const results = store.searchDocuments(ctx.tenantId!, input.query, { limit: input.limit });
    logKnowledgeQuery(db, {
      tenant_id: ctx.tenantId!,
      query: input.query,
      hit_count: results.length,
      source_channel: 'search'
    });
    return results;
  }

  if (path === '/api/knowledge/ask' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { question?: string; knowledge_base_id?: string };
    if (!input?.question) {
      return { status: 400, data: { error: 'question is required' } };
    }
    const docs = store.searchDocuments(ctx.tenantId!, input.question, {
      knowledgeBaseId: input.knowledge_base_id,
      limit: 5
    });
    const result = await retrieveAndAnswer(
      input.question,
      docs.map((d) => ({ id: d.id, title: d.title, content: d.content })),
      {}
    );
    logKnowledgeQuery(db, {
      tenant_id: ctx.tenantId!,
      query: input.question,
      hit_count: result.sources.length,
      confidence: result.confidence,
      source_channel: 'ask'
    });
    return { data: result };
  }

  if (path === '/api/knowledge/analytics' && method === 'GET') {
    const ctx = requireAuth(headers);
    const days = Number(url.searchParams.get('days') || 30);
    return { data: getKnowledgeAnalytics(db, ctx.tenantId!, days) };
  }

  return undefined;
}
