import type { JsonRecord } from '../integrations/provider-runtime-types.js';

interface RegisterableToolRegistry {
  register: (definition: JsonRecord, handler: (input: JsonRecord, context: JsonRecord) => unknown) => void;
}

interface WikiStoreLike {
  ingestSource: (input: JsonRecord) => JsonRecord;
  upsertPage: (input: JsonRecord) => JsonRecord;
  buildIndex: (input: JsonRecord) => JsonRecord;
  query: (input: JsonRecord) => JsonRecord;
  lint: (input: JsonRecord) => JsonRecord;
  getSource: (tenantId: string, sourceId: string) => JsonRecord | null;
  getPage: (tenantId: string, pageId: string) => JsonRecord | null;
  getPageBySlug: (tenantId: string, workspaceId: string, slug: string) => JsonRecord | null;
  listPages: (input: JsonRecord) => JsonRecord[];
  appendEvent: (input: JsonRecord) => JsonRecord;
}

interface ModelGatewayLike {
  complete: (context: JsonRecord, request: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface ArtifactStoreLike {
  commit: (input: JsonRecord) => JsonRecord;
}

interface KnowledgeToolOptions {
  modelGateway?: ModelGatewayLike | null;
  artifactStore?: ArtifactStoreLike | null;
}

export function registerKnowledgeWikiTools(
  toolRegistry: RegisterableToolRegistry,
  wikiStore: WikiStoreLike,
  { modelGateway = null, artifactStore = null }: KnowledgeToolOptions = {}
): void {
  toolRegistry.register(
    internalWikiTool({
      tool_id: 'knowledge.source_ingest',
      display_name: 'Ingest knowledge source',
      audit_event_name: 'tool.knowledge_source_ingest'
    }),
    async (input) => {
      const source = wikiStore.ingestSource(input);
      const page = wikiStore.upsertPage({
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        title: input.page_title || input.title,
        slug: input.page_slug || input.slug || input.title,
        category: input.category || 'source',
        summary: input.summary || summarizeSource(input.content_text || input.content || ''),
        content_markdown: input.content_markdown || renderSourcePage(source, input.summary),
        source_ids: [source.id],
        tags: input.tags || ['source']
      });
      return { source, page };
    }
  );

  toolRegistry.register(
    internalWikiTool({
      tool_id: 'wiki.page_upsert',
      display_name: 'Upsert wiki page',
      audit_event_name: 'tool.wiki_page_upsert'
    }),
    async (input) => wikiStore.upsertPage(input)
  );

  toolRegistry.register(
    internalWikiTool({
      tool_id: 'wiki.index_build',
      display_name: 'Build wiki index',
      audit_event_name: 'tool.wiki_index_build'
    }),
    async (input) => wikiStore.buildIndex(input)
  );

  toolRegistry.register(
    readWikiTool({
      tool_id: 'wiki.query',
      display_name: 'Query wiki',
      audit_event_name: 'tool.wiki_query'
    }),
    async (input) => wikiStore.query(input)
  );

  toolRegistry.register(
    readWikiTool({
      tool_id: 'wiki.lint',
      display_name: 'Lint wiki',
      audit_event_name: 'tool.wiki_lint'
    }),
    async (input) => wikiStore.lint(input)
  );

  toolRegistry.register(
    internalWikiTool({
      tool_id: 'wiki.synthesize_page_draft',
      display_name: 'Synthesize wiki page draft',
      side_effect: true,
      audit_event_name: 'tool.wiki_synthesize_page_draft'
    }),
    async (input, context) => {
      if (!modelGateway) throw new Error('wiki synthesis requires modelGateway');
      if (!artifactStore) throw new Error('wiki synthesis requires artifactStore');
      if (!input.title) throw new Error('title is required');
      const sources = (input.source_ids || [])
        .map((sourceId) => wikiStore.getSource(input.tenant_id, sourceId))
        .filter(Boolean);
      const existingPage = input.page_id
        ? wikiStore.getPage(input.tenant_id, input.page_id)
        : input.page_slug
          ? wikiStore.getPageBySlug(input.tenant_id, input.workspace_id || 'default', input.page_slug)
          : null;
      const modelResult = await modelGateway.complete(context, {
        provider: 'tenant_default',
        fallback_provider: 'dry_run',
        purpose: 'wiki.synthesize_page_draft',
        prompt: renderSynthesisPrompt({ input, sources, existingPage }),
        response_schema: {
          type: 'object',
          required: ['content_markdown', 'summary', 'citations']
        }
      });
      const draft = {
        title: input.title,
        slug: input.slug || input.page_slug || input.title,
        category: input.category || existingPage?.category || 'concept',
        summary: input.summary || synthesizeSummary(sources, existingPage),
        content_markdown: renderModelDraft({
          title: input.title,
          modelContent: modelResult.output.content,
          sources,
          existingPage
        }),
        source_ids: sources.map((source) => source.id),
        target_page_id: existingPage?.id || null,
        status: 'draft'
      };
      const artifact = artifactStore.commit({
        tenant_id: input.tenant_id,
        workflow_run_id: context.workflowRunId || null,
        agent_run_id: context.agentRunId || null,
        type: 'wiki_page_draft',
        status: 'draft',
        payload: {
          draft,
          model_call_id: modelResult.model_call.id,
          note: 'Draft artifact only; active wiki page is unchanged until reviewed and upserted.'
        }
      });
      wikiStore.appendEvent({
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        event_type: 'synthesis_draft',
        object_type: 'agent_artifact',
        object_id: artifact.id,
        payload: {
          title: input.title,
          source_count: sources.length,
          target_page_id: existingPage?.id || null,
          model_call_id: modelResult.model_call.id
        }
      });
      return { draft, artifact, model_call: modelResult.model_call };
    }
  );

  toolRegistry.register(
    internalWikiTool({
      tool_id: 'wiki.propose_page_diff',
      display_name: 'Propose wiki page diff',
      side_effect: true,
      audit_event_name: 'tool.wiki_propose_page_diff'
    }),
    async (input, context) => {
      if (!modelGateway) throw new Error('wiki diff proposal requires modelGateway');
      if (!artifactStore) throw new Error('wiki diff proposal requires artifactStore');
      const page = input.page_id
        ? wikiStore.getPage(input.tenant_id, input.page_id)
        : wikiStore.getPageBySlug(input.tenant_id, input.workspace_id || 'default', input.page_slug || '');
      if (!page) throw new Error('wiki page is required for diff proposal');
      const modelResult = await modelGateway.complete(context, {
        provider: 'tenant_default',
        fallback_provider: 'dry_run',
        purpose: 'wiki.propose_page_diff',
        prompt: renderDiffPrompt({ page, change_request: input.change_request || '' }),
        response_schema: {
          type: 'object',
          required: ['diff_summary', 'proposed_content_markdown']
        }
      });
      const proposal = {
        page_id: page.id,
        page_slug: page.slug,
        current_version: page.version,
        change_request: input.change_request || '',
        diff_summary: modelResult.output.content,
        proposed_content_markdown: input.proposed_content_markdown || `${page.content_markdown}\n\n## Proposed update\n\n${modelResult.output.content}`
      };
      const artifact = artifactStore.commit({
        tenant_id: input.tenant_id,
        workflow_run_id: context.workflowRunId || null,
        agent_run_id: context.agentRunId || null,
        type: 'wiki_page_diff',
        status: 'draft',
        payload: {
          proposal,
          model_call_id: modelResult.model_call.id,
          note: 'Diff proposal only; active wiki page is unchanged until reviewed and applied.'
        }
      });
      wikiStore.appendEvent({
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        event_type: 'diff_proposal',
        object_type: 'agent_artifact',
        object_id: artifact.id,
        payload: {
          page_id: page.id,
          page_slug: page.slug,
          model_call_id: modelResult.model_call.id
        }
      });
      return { proposal, artifact, model_call: modelResult.model_call };
    }
  );

  toolRegistry.register(
    internalWikiTool({
      tool_id: 'wiki.detect_contradictions',
      display_name: 'Detect wiki contradictions',
      side_effect: true,
      audit_event_name: 'tool.wiki_detect_contradictions'
    }),
    async (input, context) => {
      if (!modelGateway) throw new Error('wiki contradiction detection requires modelGateway');
      if (!artifactStore) throw new Error('wiki contradiction detection requires artifactStore');
      const pages = selectContradictionPages(wikiStore.listPages({
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        category: input.category || null,
        limit: input.limit || 50
      }));
      const modelResult = await modelGateway.complete(context, {
        provider: 'tenant_default',
        fallback_provider: 'dry_run',
        purpose: 'wiki.detect_contradictions',
        prompt: renderContradictionPrompt({ pages, focus: input.focus || '' }),
        response_schema: {
          type: 'object',
          required: ['contradictions', 'review_notes']
        }
      });
      const review = {
        focus: input.focus || '',
        page_count: pages.length,
        candidates: pages.map((page) => ({
          id: page.id,
          slug: page.slug,
          title: page.title,
          version: page.version,
          summary: page.summary
        })),
        model_review: modelResult.output.content,
        status: 'needs_review'
      };
      const artifact = artifactStore.commit({
        tenant_id: input.tenant_id,
        workflow_run_id: context.workflowRunId || null,
        agent_run_id: context.agentRunId || null,
        type: 'wiki_contradiction_review',
        status: 'draft',
        payload: {
          review,
          model_call_id: modelResult.model_call.id,
          note: 'Contradiction review artifact only; active wiki pages are unchanged until reviewed.'
        }
      });
      wikiStore.appendEvent({
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        event_type: 'contradiction_review',
        object_type: 'agent_artifact',
        object_id: artifact.id,
        payload: {
          page_count: pages.length,
          model_call_id: modelResult.model_call.id
        }
      });
      return { review, artifact, model_call: modelResult.model_call };
    }
  );
}

function internalWikiTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'knowledge',
    category: 'internal_write',
    risk_level: 'R2',
    input_schema: {},
    output_schema: {},
    side_effect: true,
    idempotency_required: true,
    approval_required: false,
    allowed_agents: ['knowledge_agent', 'orchestration_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function readWikiTool(overrides: JsonRecord): JsonRecord {
  return {
    toolset: 'knowledge',
    category: 'read',
    risk_level: 'R0',
    input_schema: {},
    output_schema: {},
    side_effect: false,
    idempotency_required: false,
    approval_required: false,
    allowed_agents: ['knowledge_agent', 'orchestration_agent', 'analytics_agent', 'crm_agent', 'content_agent'],
    forbidden_agents: [],
    tenant_scope_required: true,
    object_scope_required: false,
    ...overrides
  };
}

function summarizeSource(content: unknown): string {
  return String(content || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
    ?.slice(0, 240) || 'Knowledge source ingested into wiki.';
}

function renderSourcePage(source: JsonRecord, summary = ''): string {
  return [
    `# ${source.title}`,
    '',
    summary || summarizeSource(source.content_text),
    '',
    '## Source',
    '',
    `- Source ID: ${source.id}`,
    `- Type: ${source.source_type}`,
    source.uri ? `- URI: ${source.uri}` : '- URI: n/a',
    '',
    '## Notes',
    '',
    source.content_text.slice(0, 1200)
  ].join('\n');
}

function renderSynthesisPrompt({ input, sources, existingPage }: JsonRecord): string {
  return [
    'Synthesize a reviewed wiki page draft for a Converact one-person-company operating system.',
    `Title: ${input.title}`,
    `Category: ${input.category || existingPage?.category || 'concept'}`,
    existingPage ? `Existing page:\n${existingPage.content_markdown}` : 'Existing page: none',
    'Sources:',
    ...sources.map((source) => `- ${source.title} (${source.id}): ${source.content_text.slice(0, 1200)}`),
    'Return concise Markdown with source-aware claims and review-friendly structure.'
  ].join('\n\n');
}

function renderDiffPrompt({ page, change_request }: JsonRecord): string {
  return [
    'Propose a wiki page diff for review. Do not apply the change.',
    `Page: ${page.title} (${page.slug})`,
    `Current version: ${page.version}`,
    `Change request: ${change_request || 'Improve completeness and clarity.'}`,
    'Current content:',
    page.content_markdown
  ].join('\n\n');
}

function renderContradictionPrompt({ pages, focus }: JsonRecord): string {
  return [
    'Review these Converact wiki pages for contradictions, stale claims, or conflicting SOPs. Do not edit pages.',
    focus ? `Focus: ${focus}` : 'Focus: general operational consistency',
    ...pages.map((page) => [
      `Page: ${page.title} (${page.slug}) v${page.version}`,
      `Summary: ${page.summary || 'n/a'}`,
      page.content_markdown.slice(0, 1600)
    ].join('\n'))
  ].join('\n\n---\n\n');
}

function selectContradictionPages(pages: JsonRecord[]): JsonRecord[] {
  return pages
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 20);
}

function renderModelDraft({ title, modelContent, sources, existingPage }: JsonRecord): string {
  return [
    `# ${title}`,
    '',
    modelContent,
    '',
    '## Review notes',
    '',
    existingPage ? `- Based on existing page version: ${existingPage.version}` : '- New page draft',
    `- Source count: ${sources.length}`,
    ...sources.map((source) => `- Source: ${source.title} (${source.id})`)
  ].join('\n');
}

function synthesizeSummary(sources: JsonRecord[], existingPage: JsonRecord | null): string {
  if (sources[0]) return summarizeSource(sources[0].content_text);
  if (existingPage?.summary) return existingPage.summary;
  return 'Model-assisted wiki draft awaiting review.';
}
