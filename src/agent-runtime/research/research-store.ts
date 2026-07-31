import { all, id, json, one, parseJson, run } from '../../db.js';
import type { JsonRecord, ProviderSelection } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface ResearchStoreOptions {
  db: unknown;
  providerRegistryStore: JsonRecord;
  wikiStore: JsonRecord;
  artifactStore: JsonRecord;
  runStore?: AuditStoreLike | null;
}

export class ResearchStore {
  db: unknown;
  providerRegistryStore: JsonRecord;
  wikiStore: JsonRecord;
  artifactStore: JsonRecord;
  runStore: AuditStoreLike | null;

  constructor({ db, providerRegistryStore, wikiStore, artifactStore, runStore = null }: ResearchStoreOptions) {
    this.db = db;
    this.providerRegistryStore = providerRegistryStore;
    this.wikiStore = wikiStore;
    this.artifactStore = artifactStore;
    this.runStore = runStore;
  }

  listSearchSessions({ tenant_id, workspace_id = 'default', status = null }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_search_sessions
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC`,
      params
    ).map(decodeSearchSession);
  }

  getSearchSession(tenantId: string, workspaceId: string, sessionId: string): JsonRecord | null {
    const row = one(
      this.db,
      `SELECT * FROM tenant_search_sessions
       WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
      [tenantId, workspaceId, sessionId]
    );
    return row ? decodeSearchSession(row) : null;
  }

  upsertSearchSession(input: JsonRecord): JsonRecord | null {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const sessionId = input.session_id || id('searchsess');
    run(
      this.db,
      `INSERT INTO tenant_search_sessions
        (id, tenant_id, workspace_id, session_id, name, description, provider_integration_id, search_mode,
         source_modes, domain_filters, tags, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, session_id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         provider_integration_id = excluded.provider_integration_id,
         search_mode = excluded.search_mode,
         source_modes = excluded.source_modes,
         domain_filters = excluded.domain_filters,
         tags = excluded.tags,
         status = excluded.status,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('searchsess'),
        input.tenant_id,
        workspaceId,
        sessionId,
        input.name || sessionId,
        input.description || '',
        input.provider_integration_id || 'perplexica',
        input.search_mode || 'balanced',
        json(input.source_modes || ['web']),
        json(input.domain_filters || []),
        json(input.tags || []),
        input.status || 'active',
        input.actor_id || 'system',
        input.actor_id || 'system'
      ]
    );
    const session = this.getSearchSession(input.tenant_id, workspaceId, sessionId);
    this.runStore?.audit?.(input.tenant_id, 'research.search_session.upserted', 'tenant_search_session', session.id, {
      session_id: session.session_id,
      provider_integration_id: session.provider_integration_id
    }, input.actor_id || 'system');
    return session;
  }

  listNotebooks({ tenant_id, workspace_id = 'default', status = null }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    return all(
      this.db,
      `SELECT * FROM tenant_notebooks
       WHERE ${clauses.join(' AND ')}
       ORDER BY updated_at DESC, created_at DESC`,
      params
    ).map(decodeNotebook);
  }

  getNotebook(tenantId: string, workspaceId: string, notebookId: string): JsonRecord | null {
    const row = one(
      this.db,
      `SELECT * FROM tenant_notebooks
       WHERE tenant_id = ? AND workspace_id = ? AND notebook_id = ?`,
      [tenantId, workspaceId, notebookId]
    );
    return row ? decodeNotebook(row) : null;
  }

  upsertNotebook(input: JsonRecord): JsonRecord | null {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.notebook_id) throw new Error('notebook_id is required');
    if (!input.title) throw new Error('title is required');
    const workspaceId = input.workspace_id || 'default';
    run(
      this.db,
      `INSERT INTO tenant_notebooks
        (id, tenant_id, workspace_id, notebook_id, title, description, provider_integration_id, source_refs,
         tags, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workspace_id, notebook_id) DO UPDATE SET
         title = excluded.title,
         description = excluded.description,
         provider_integration_id = excluded.provider_integration_id,
         source_refs = excluded.source_refs,
         tags = excluded.tags,
         status = excluded.status,
         updated_by = excluded.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [
        id('notebook'),
        input.tenant_id,
        workspaceId,
        input.notebook_id,
        input.title,
        input.description || '',
        input.provider_integration_id || 'open-notebook',
        json(input.source_refs || []),
        json(input.tags || []),
        input.status || 'active',
        input.actor_id || 'system',
        input.actor_id || 'system'
      ]
    );
    const notebook = this.getNotebook(input.tenant_id, workspaceId, input.notebook_id);
    this.runStore?.audit?.(input.tenant_id, 'research.notebook.upserted', 'tenant_notebook', notebook.id, {
      notebook_id: notebook.notebook_id,
      provider_integration_id: notebook.provider_integration_id
    }, input.actor_id || 'system');
    return notebook;
  }

  attachNotebookSource(input: JsonRecord): JsonRecord | null {
    const workspaceId = input.workspace_id || 'default';
    const notebook = this.getNotebook(input.tenant_id, workspaceId, input.notebook_id);
    if (!notebook) throw new Error(`notebook not found: ${input.notebook_id}`);
    const nextRef = this.normalizeNotebookReference({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      ref_type: input.ref_type || 'source',
      ref_id: input.ref_id || input.source_id || input.page_id || input.artifact_id || '',
      page_slug: input.page_slug,
      title: input.title,
      uri: input.uri,
      content_text: input.content_text,
      metadata: input.metadata || {}
    });
    const refs = dedupeReferences([...notebook.source_refs, nextRef]);
    run(
      this.db,
      `UPDATE tenant_notebooks
       SET source_refs = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND workspace_id = ? AND notebook_id = ?`,
      [json(refs), input.actor_id || 'system', input.tenant_id, workspaceId, input.notebook_id]
    );
    const updated = this.getNotebook(input.tenant_id, workspaceId, input.notebook_id);
    this.runStore?.audit?.(input.tenant_id, 'research.notebook.source_attached', 'tenant_notebook', updated.id, {
      notebook_id: updated.notebook_id,
      ref_type: nextRef.ref_type,
      ref_id: nextRef.ref_id
    }, input.actor_id || 'system');
    return updated;
  }

  listSearchRuns({ tenant_id, workspace_id = 'default', session_id = null, notebook_id = null, limit = 50 }: JsonRecord): JsonRecord[] {
    const clauses = ['tenant_id = ?', 'workspace_id = ?'];
    const params = [tenant_id, workspace_id];
    if (session_id) {
      clauses.push('session_id = ?');
      params.push(session_id);
    }
    if (notebook_id) {
      clauses.push('notebook_id = ?');
      params.push(notebook_id);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM tenant_search_runs
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    ).map(decodeSearchRun);
  }

  async runSearchQuery(input: JsonRecord, context: JsonRecord = {}): Promise<JsonRecord> {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.query) throw new Error('query is required');
    const workspaceId = input.workspace_id || 'default';
    const session = input.session_id ? this.getSearchSession(input.tenant_id, workspaceId, input.session_id) : null;
    if (input.session_id && !session) throw new Error(`search session not found: ${input.session_id}`);
    const providerSelection = this.selectProvider({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      category: 'ai_search',
      capability: input.capability || 'ai_search',
      preferred_ids: compactUnique([input.provider_integration_id, session?.provider_integration_id]),
      allow_fallback: true
    });
    const tenantCitations = this.queryTenantEvidence({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      query: input.query,
      limit: input.limit || 5
    });
    const liveProvider = await this.maybeExecuteLiveProviderOperation({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      provider_selection: providerSelection,
      operation: session ? 'search.followup' : (input.search_mode === 'discovery' ? 'search.discover' : 'search.query'),
      payload: {
        query: input.query,
        search_mode: input.search_mode || session?.search_mode || 'balanced',
        limit: input.limit || 5,
        domain_filters: session?.domain_filters || [],
        conversation_id: input.conversation_id || session?.session_id || ''
      },
      actor_id: input.actor_id || context.userId || 'system'
    });
    const citations = mergeCitations(liveProvider?.citations, tenantCitations, input.limit || 5);
    const summary = liveProvider?.summary || buildSearchSummary(input.query, citations, providerSelection);
    const note = liveProvider
      ? 'Live provider execution completed through the tenant-configured search adapter; tenant evidence remains merged for review and grounding.'
      : 'Provider selection is foundation-ready; cited results currently come from tenant knowledge/wiki evidence until a live external adapter is configured.';
    const artifact = this.artifactStore.commit({
      tenant_id: input.tenant_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'search_query_result',
      status: 'draft',
      payload: {
        query: input.query,
        session_id: session?.session_id || '',
        provider_selection: providerSelection,
        provider_execution_mode: liveProvider ? 'live_provider' : 'tenant_evidence_fallback',
        citations,
        summary,
        live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
        note
      }
    });
    const runRecord = this.insertSearchRun({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      session_id: session?.session_id || '',
      notebook_id: '',
      query_text: input.query,
      provider_integration_id: providerSelection.selected?.integration_id || '',
      provider_category: 'ai_search',
      search_mode: input.search_mode || session?.search_mode || 'balanced',
      summary,
      citations,
      result_payload: artifact.payload,
      artifact_id: artifact.id,
      created_by: input.actor_id || context.userId || 'system'
    });
    if (session) this.touchSearchSession(input.tenant_id, workspaceId, session.session_id, input.actor_id || context.userId || 'system');
    return {
      session,
      provider_selection: providerSelection,
      citations,
      summary,
      provider_execution_mode: liveProvider ? 'live_provider' : 'tenant_evidence_fallback',
      artifact,
      run: runRecord
    };
  }

  async queryNotebook(input: JsonRecord, context: JsonRecord = {}): Promise<JsonRecord> {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.query) throw new Error('query is required');
    const workspaceId = input.workspace_id || 'default';
    const notebook = this.getNotebook(input.tenant_id, workspaceId, input.notebook_id);
    if (!notebook) throw new Error(`notebook not found: ${input.notebook_id}`);
    const providerSelection = this.selectProvider({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      category: 'notebook_workspace',
      capability: input.capability || 'citation_chat',
      preferred_ids: compactUnique([input.provider_integration_id, notebook.provider_integration_id]),
      allow_fallback: true
    });
    const tenantCitations = this.queryNotebookEvidence({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      query: input.query,
      source_refs: notebook.source_refs,
      limit: input.limit || 5
    });
    const liveProvider = await this.maybeExecuteLiveProviderOperation({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      provider_selection: providerSelection,
      operation: 'notebook.query',
      payload: {
        notebook_id: notebook.notebook_id,
        query: input.query,
        limit: input.limit || 5,
        source_refs: notebook.source_refs
      },
      actor_id: input.actor_id || context.userId || 'system'
    });
    const citations = mergeCitations(liveProvider?.citations, tenantCitations, input.limit || 5);
    const answer = liveProvider?.answer || buildNotebookAnswer(input.query, citations, notebook.title);
    const note = liveProvider
      ? 'Notebook query executed through the tenant-configured notebook adapter while preserving tenant-scoped source attachments and citations.'
      : 'Notebook result is tenant-scoped and source-aware; live external notebook execution can be added later behind the configured provider boundary.';
    const artifact = this.artifactStore.commit({
      tenant_id: input.tenant_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'notebook_query_result',
      status: 'draft',
      payload: {
        notebook_id: notebook.notebook_id,
        query: input.query,
        provider_selection: providerSelection,
        provider_execution_mode: liveProvider ? 'live_provider' : 'tenant_evidence_fallback',
        answer,
        citations,
        live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
        note
      }
    });
    const runRecord = this.insertSearchRun({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      session_id: '',
      notebook_id: notebook.notebook_id,
      query_text: input.query,
      provider_integration_id: providerSelection.selected?.integration_id || '',
      provider_category: 'notebook_workspace',
      search_mode: input.search_mode || 'balanced',
      summary: answer,
      citations,
      result_payload: artifact.payload,
      artifact_id: artifact.id,
      created_by: input.actor_id || context.userId || 'system'
    });
    this.touchNotebook(input.tenant_id, workspaceId, notebook.notebook_id, input.actor_id || context.userId || 'system');
    return {
      notebook,
      provider_selection: providerSelection,
      answer,
      citations,
      provider_execution_mode: liveProvider ? 'live_provider' : 'tenant_evidence_fallback',
      artifact,
      run: runRecord
    };
  }

  async generateNotebookAudioOverviewDraft(input: JsonRecord, context: JsonRecord = {}): Promise<JsonRecord> {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    const workspaceId = input.workspace_id || 'default';
    const notebook = this.getNotebook(input.tenant_id, workspaceId, input.notebook_id);
    if (!notebook) throw new Error(`notebook not found: ${input.notebook_id}`);
    const providerSelection = this.selectProvider({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      category: 'notebook_workspace',
      capability: 'podcast_generation',
      preferred_ids: compactUnique([input.provider_integration_id, notebook.provider_integration_id]),
      allow_fallback: true
    });
    const evidence = this.queryNotebookEvidence({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      query: input.focus || notebook.title,
      source_refs: notebook.source_refs,
      limit: input.limit || 6
    });
    const liveProvider = await this.maybeExecuteLiveProviderOperation({
      tenant_id: input.tenant_id,
      workspace_id: workspaceId,
      provider_selection: providerSelection,
      operation: 'notebook.audio_overview',
      payload: {
        notebook_id: notebook.notebook_id,
        notebook_title: notebook.title,
        focus: input.focus || '',
        limit: input.limit || 6,
        source_refs: notebook.source_refs
      },
      actor_id: input.actor_id || context.userId || 'system'
    });
    const citations = mergeCitations(liveProvider?.citations, evidence, input.limit || 6);
    const scriptOutline = liveProvider?.script_outline || buildAudioOverviewOutline(notebook, citations, input.focus || '');
    const note = liveProvider
      ? 'Draft generated through the tenant-configured notebook audio adapter; tenant citations remain attached for review.'
      : 'Draft only; tenant can later route this through Open Notebook or another audio-capable provider once configured.';
    const artifact = this.artifactStore.commit({
      tenant_id: input.tenant_id,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      type: 'notebook_audio_overview_draft',
      status: 'draft',
      payload: {
        notebook_id: notebook.notebook_id,
        notebook_title: notebook.title,
        provider_selection: providerSelection,
        provider_execution_mode: liveProvider ? 'live_provider' : 'tenant_evidence_fallback',
        focus: input.focus || '',
        citations,
        script_outline: scriptOutline,
        live_provider_result: liveProvider ? omitRawProviderPayload(liveProvider) : null,
        note
      }
    });
    this.touchNotebook(input.tenant_id, workspaceId, notebook.notebook_id, input.actor_id || context.userId || 'system');
    return {
      notebook,
      provider_selection: providerSelection,
      citations,
      script_outline: scriptOutline,
      provider_execution_mode: liveProvider ? 'live_provider' : 'tenant_evidence_fallback',
      artifact
    };
  }

  selectProvider(input: JsonRecord): ProviderSelection {
    return this.providerRegistryStore.previewSelection(input);
  }

  async maybeExecuteLiveProviderOperation({ tenant_id, workspace_id = 'default', provider_selection, operation, payload, actor_id = 'system' }: JsonRecord): Promise<JsonRecord | null> {
    const integrationId = provider_selection?.selected?.integration_id;
    if (!integrationId) return null;
    if (!this.providerRegistryStore.adapterRegistry.has(integrationId)) return null;
    const config = this.providerRegistryStore.integrationConfigStore.getConfig(tenant_id, workspace_id, integrationId);
    if (!config || config.status === 'disabled') return null;
    return this.providerRegistryStore.executeProviderOperation({
      tenant_id,
      workspace_id,
      integration_id: integrationId,
      operation,
      payload,
      actor_id
    });
  }

  insertSearchRun(input: JsonRecord): JsonRecord {
    const record = {
      id: id('searchrun'),
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      session_id: input.session_id || '',
      notebook_id: input.notebook_id || '',
      query_text: input.query_text,
      provider_integration_id: input.provider_integration_id || '',
      provider_category: input.provider_category || 'ai_search',
      search_mode: input.search_mode || 'balanced',
      summary: input.summary || '',
      citations: input.citations || [],
      result_payload: input.result_payload || {},
      artifact_id: input.artifact_id || null,
      created_by: input.created_by || 'system'
    };
    run(
      this.db,
      `INSERT INTO tenant_search_runs
        (id, tenant_id, workspace_id, session_id, notebook_id, query_text, provider_integration_id, provider_category,
         search_mode, summary, citations, result_payload, artifact_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.tenant_id,
        record.workspace_id,
        record.session_id,
        record.notebook_id,
        record.query_text,
        record.provider_integration_id,
        record.provider_category,
        record.search_mode,
        record.summary,
        json(record.citations),
        json(record.result_payload),
        record.artifact_id,
        record.created_by
      ]
    );
    this.runStore?.audit?.(input.tenant_id, 'research.search_run.created', 'tenant_search_run', record.id, {
      session_id: record.session_id,
      notebook_id: record.notebook_id,
      provider_integration_id: record.provider_integration_id
    }, record.created_by);
    return this.listSearchRuns({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      limit: 1
    })[0];
  }

  touchSearchSession(tenantId: string, workspaceId: string, sessionId: string, actorId: string): void {
    run(
      this.db,
      `UPDATE tenant_search_sessions
       SET last_query_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?`,
      [actorId || 'system', tenantId, workspaceId, sessionId]
    );
  }

  touchNotebook(tenantId: string, workspaceId: string, notebookId: string, actorId: string): void {
    run(
      this.db,
      `UPDATE tenant_notebooks
       SET last_query_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND workspace_id = ? AND notebook_id = ?`,
      [actorId || 'system', tenantId, workspaceId, notebookId]
    );
  }

  queryTenantEvidence({ tenant_id, workspace_id = 'default', query, limit = 5 }: JsonRecord): JsonRecord[] {
    const terms = tokenize(query);
    const pageDocs = this.wikiStore.listPages({ tenant_id, workspace_id, limit: 200 }).map((page) => ({
      ref_type: 'page',
      ref_id: page.id,
      title: page.title,
      content_text: `${page.summary}\n${page.content_markdown}`,
      slug: page.slug,
      uri: ''
    }));
    const sourceDocs = this.wikiStore.listSources({ tenant_id, workspace_id, limit: 200 }).map((source) => ({
      ref_type: 'source',
      ref_id: source.id,
      title: source.title,
      content_text: source.content_text,
      slug: '',
      uri: source.uri || ''
    }));
    return scoreEvidence([...pageDocs, ...sourceDocs], terms, limit);
  }

  queryNotebookEvidence({ tenant_id, workspace_id = 'default', query, source_refs = [], limit = 5 }: JsonRecord): JsonRecord[] {
    const terms = tokenize(query);
    const documents = source_refs
      .map((ref) => this.resolveReferenceDocument(tenant_id, workspace_id, ref))
      .filter(Boolean);
    return scoreEvidence(documents, terms, limit);
  }

  resolveReferenceDocument(tenantId: string, workspaceId: string, ref: JsonRecord): JsonRecord | null {
    if (!ref?.ref_type) return null;
    if (ref.ref_type === 'source') {
      const source = this.wikiStore.getSource(tenantId, ref.ref_id);
      return source
        ? {
            ref_type: 'source',
            ref_id: source.id,
            title: source.title,
            content_text: source.content_text,
            slug: '',
            uri: source.uri || ''
          }
        : manualFallbackReference(ref);
    }
    if (ref.ref_type === 'page') {
      const page = this.wikiStore.getPage(tenantId, ref.ref_id)
        || this.wikiStore.getPageBySlug(tenantId, workspaceId, ref.ref_id);
      return page
        ? {
            ref_type: 'page',
            ref_id: page.id,
            title: page.title,
            content_text: `${page.summary}\n${page.content_markdown}`,
            slug: page.slug,
            uri: ''
          }
        : manualFallbackReference(ref);
    }
    if (ref.ref_type === 'artifact') {
      const artifact = this.artifactStore.get(tenantId, ref.ref_id);
      return artifact
        ? {
            ref_type: 'artifact',
            ref_id: artifact.id,
            title: ref.title || artifact.type,
            content_text: JSON.stringify(artifact.payload),
            slug: '',
            uri: ''
          }
        : manualFallbackReference(ref);
    }
    if (ref.ref_type === 'manual') return manualFallbackReference(ref);
    return null;
  }

  normalizeNotebookReference(input: JsonRecord): JsonRecord {
    if (input.ref_type === 'source') {
      const source = this.wikiStore.getSource(input.tenant_id, input.ref_id);
      if (!source) throw new Error(`knowledge source not found: ${input.ref_id}`);
      return {
        ref_type: 'source',
        ref_id: source.id,
        title: source.title,
        uri: source.uri || '',
        content_text: source.content_text.slice(0, 400),
        metadata: source.metadata || {}
      };
    }
    if (input.ref_type === 'page') {
      const page = input.ref_id
        ? this.wikiStore.getPage(input.tenant_id, input.ref_id)
        : this.wikiStore.getPageBySlug(input.tenant_id, input.workspace_id, input.page_slug || '');
      if (!page) throw new Error(`wiki page not found: ${input.ref_id || input.page_slug}`);
      return {
        ref_type: 'page',
        ref_id: page.id,
        title: page.title,
        uri: '',
        content_text: `${page.summary}\n${page.content_markdown}`.slice(0, 400),
        metadata: { slug: page.slug, category: page.category }
      };
    }
    if (input.ref_type === 'artifact') {
      const artifact = this.artifactStore.get(input.tenant_id, input.ref_id);
      if (!artifact) throw new Error(`artifact not found: ${input.ref_id}`);
      return {
        ref_type: 'artifact',
        ref_id: artifact.id,
        title: input.title || artifact.type,
        uri: '',
        content_text: JSON.stringify(artifact.payload).slice(0, 400),
        metadata: { artifact_type: artifact.type, status: artifact.status }
      };
    }
    if (input.ref_type === 'manual') {
      if (!input.title) throw new Error('title is required for manual notebook source');
      if (!input.content_text) throw new Error('content_text is required for manual notebook source');
      return {
        ref_type: 'manual',
        ref_id: input.ref_id || id('nbref'),
        title: input.title,
        uri: input.uri || '',
        content_text: input.content_text,
        metadata: input.metadata || {}
      };
    }
    throw new Error(`unsupported notebook ref_type: ${input.ref_type}`);
  }
}

function decodeSearchSession(row: JsonRecord): JsonRecord {
  return {
    ...row,
    source_modes: parseJson(row.source_modes, []),
    domain_filters: parseJson(row.domain_filters, []),
    tags: parseJson(row.tags, [])
  };
}

function decodeNotebook(row: JsonRecord): JsonRecord {
  return {
    ...row,
    source_refs: parseJson(row.source_refs, []),
    tags: parseJson(row.tags, [])
  };
}

function decodeSearchRun(row: JsonRecord): JsonRecord {
  return {
    ...row,
    citations: parseJson(row.citations, []),
    result_payload: parseJson(row.result_payload, {})
  };
}

function dedupeReferences(refs: JsonRecord[]): JsonRecord[] {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.ref_type}:${ref.ref_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenize(value: unknown): string[] {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9\u4e00-\u9fff]+/g) || [])];
}

function scoreEvidence(documents: JsonRecord[], terms: string[], limit: number): JsonRecord[] {
  return documents
    .map((document): JsonRecord => ({ ...document, score: scoreText(document.content_text, terms) }))
    .filter((document) => document.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit)
    .map((document) => ({
      ref_type: document.ref_type,
      ref_id: document.ref_id,
      title: document.title,
      score: document.score,
      slug: document.slug || '',
      uri: document.uri || '',
      excerpt: excerptFor(document.content_text, terms)
    }));
}

function scoreText(content: unknown, terms: string[]): number {
  const normalized = String(content || '').toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 + countOccurrences(normalized, term) : 0), 0);
}

function countOccurrences(content: string, term: string): number {
  return content.split(term).length - 1;
}

function excerptFor(content: unknown, terms: string[]): string {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const firstHit = terms
    .map((term) => text.toLowerCase().indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (firstHit == null) return text.slice(0, 220);
  const start = Math.max(0, firstHit - 60);
  return text.slice(start, start + 220);
}

function buildSearchSummary(query: string, citations: JsonRecord[], providerSelection: ProviderSelection): string {
  if (!citations.length) {
    return `No tenant knowledge evidence matched "${query}" yet. Configure ${providerSelection.selected?.integration_id || 'a search provider'} and/or ingest more sources.`;
  }
  return `Found ${citations.length} cited evidence item(s) for "${query}" using ${providerSelection.selected?.integration_id || 'local tenant evidence'}.`;
}

function buildNotebookAnswer(query: string, citations: JsonRecord[], notebookTitle: string): string {
  if (!citations.length) return `Notebook "${notebookTitle}" does not yet contain cited evidence for "${query}".`;
  return `Notebook "${notebookTitle}" found ${citations.length} cited evidence item(s) related to "${query}".`;
}

function buildAudioOverviewOutline(notebook: JsonRecord, citations: JsonRecord[], focus: string): JsonRecord {
  return {
    title: `${notebook.title} audio overview`,
    focus: focus || notebook.title,
    segments: [
      'Opening context and research goal',
      'Key findings grounded in cited notebook sources',
      'Implications for tenant operations or lead follow-up',
      'Open questions and next research actions'
    ],
    source_titles: citations.map((citation) => citation.title)
  };
}

function compactUnique(values: unknown[]): string[] {
  return [...new Set(values.filter(Boolean).map(String))];
}

function mergeCitations(primary: JsonRecord[] = [], secondary: JsonRecord[] = [], limit = 5): JsonRecord[] {
  const merged = [...(primary || []), ...(secondary || [])];
  const seen = new Set();
  return merged.filter((citation) => {
    const key = `${citation.ref_type || 'external'}:${citation.ref_id || citation.uri || citation.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function omitRawProviderPayload(result: JsonRecord | null): JsonRecord | null {
  if (!result) return null;
  const { raw, ...rest } = result;
  return rest;
}

function manualFallbackReference(ref: JsonRecord): JsonRecord | null {
  if (!ref?.title && !ref?.content_text) return null;
  return {
    ref_type: ref.ref_type || 'manual',
    ref_id: ref.ref_id || id('nbref'),
    title: ref.title || 'Manual notebook source',
    content_text: ref.content_text || '',
    slug: '',
    uri: ref.uri || ''
  };
}
