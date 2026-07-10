import { createHash } from 'node:crypto';
import { all, id, json, one, parseJson, run } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

export class KnowledgeWikiStore {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
  }

  ingestSource(input: JsonRecord): JsonRecord {
    const contentText = input.content_text || input.content || '';
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.title) throw new Error('source title is required');
    if (!contentText) throw new Error('source content is required');

    const source = {
      id: id('ksrc'),
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      source_type: input.source_type || 'document',
      title: input.title,
      uri: input.uri || '',
      content_text: contentText,
      content_hash: hashText(contentText),
      metadata: input.metadata || {}
    };

    run(
      this.db,
      `INSERT OR IGNORE INTO knowledge_sources
        (id, tenant_id, workspace_id, source_type, title, uri, content_text, content_hash, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        source.id,
        source.tenant_id,
        source.workspace_id,
        source.source_type,
        source.title,
        source.uri,
        source.content_text,
        source.content_hash,
        json(source.metadata)
      ]
    );

    const persisted = this.getSourceByHash(source.tenant_id, source.workspace_id, source.content_hash);
    if (!persisted) throw new Error('knowledge source was not persisted');
    this.appendEvent({
      tenant_id: source.tenant_id,
      workspace_id: source.workspace_id,
      event_type: 'ingest',
      object_type: 'knowledge_source',
      object_id: persisted.id,
      payload: { title: persisted.title, source_type: persisted.source_type }
    });
    return persisted;
  }

  getSource(tenantId: string, sourceId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM knowledge_sources WHERE tenant_id = ? AND id = ?', [tenantId, sourceId]);
    return row ? decodeSource(row) : null;
  }

  getSourceByHash(tenantId: string, workspaceId: string, contentHash: string): JsonRecord | null {
    const row = one(
      this.db,
      'SELECT * FROM knowledge_sources WHERE tenant_id = ? AND workspace_id = ? AND content_hash = ?',
      [tenantId, workspaceId, contentHash]
    );
    return row ? decodeSource(row) : null;
  }

  listSources({ tenant_id, workspace_id = 'default', limit = 50 }: JsonRecord): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM knowledge_sources
       WHERE tenant_id = ? AND workspace_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT ?`,
      [tenant_id, workspace_id, limit]
    ).map(decodeSource);
  }

  upsertPage(input: JsonRecord): JsonRecord {
    if (!input.tenant_id) throw new Error('tenant_id is required');
    if (!input.title) throw new Error('wiki page title is required');
    const workspaceId = input.workspace_id || 'default';
    const slug = normalizeSlug(input.slug || input.title);
    const existing = this.getPageBySlug(input.tenant_id, workspaceId, slug);
    const sourceIds = input.source_ids || [];
    const tags = input.tags || [];
    const summary = input.summary || summarizeMarkdown(input.content_markdown || '');
    const content = input.content_markdown || renderDefaultPage({ title: input.title, summary, sourceIds });

    if (existing) {
      run(
        this.db,
        `UPDATE wiki_pages
         SET title = ?, category = ?, summary = ?, content_markdown = ?, source_ids = ?, tags = ?,
             status = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND workspace_id = ? AND slug = ?`,
        [
          input.title,
          input.category || existing.category,
          summary,
          content,
          json(sourceIds),
          json(tags),
          input.status || 'active',
          input.tenant_id,
          workspaceId,
          slug
        ]
      );
    } else {
      run(
        this.db,
        `INSERT INTO wiki_pages
          (id, tenant_id, workspace_id, slug, title, category, summary, content_markdown, source_ids, tags, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id('wpage'),
          input.tenant_id,
          workspaceId,
          slug,
          input.title,
          input.category || 'concept',
          summary,
          content,
          json(sourceIds),
          json(tags),
          input.status || 'active'
        ]
      );
    }

    const page = this.getPageBySlug(input.tenant_id, workspaceId, slug);
    if (!page) throw new Error('wiki page was not persisted');
    this.replaceLinks(page, input.links || []);
    this.appendEvent({
      tenant_id: page.tenant_id,
      workspace_id: page.workspace_id,
      event_type: 'page_upsert',
      object_type: 'wiki_page',
      object_id: page.id,
      payload: { slug: page.slug, version: page.version, source_count: page.source_ids.length }
    });
    return this.getPage(page.tenant_id, page.id);
  }

  getPage(tenantId: string, pageId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM wiki_pages WHERE tenant_id = ? AND id = ?', [tenantId, pageId]);
    return row ? this.decodePageWithLinks(row) : null;
  }

  getPageBySlug(tenantId: string, workspaceId: string, slug: string): JsonRecord | null {
    const row = one(
      this.db,
      'SELECT * FROM wiki_pages WHERE tenant_id = ? AND workspace_id = ? AND slug = ?',
      [tenantId, workspaceId, normalizeSlug(slug)]
    );
    return row ? this.decodePageWithLinks(row) : null;
  }

  listPages({ tenant_id, workspace_id = 'default', category = null, limit = 100 }: JsonRecord): JsonRecord[] {
    const conditions = [`tenant_id = ?`, `workspace_id = ?`, `status != 'archived'`];
    const params = [tenant_id, workspace_id];
    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM wiki_pages
       WHERE ${conditions.join(' AND ')}
       ORDER BY category ASC, updated_at DESC
       LIMIT ?`,
      params
    ).map((row) => this.decodePageWithLinks(row));
  }

  buildIndex({ tenant_id, workspace_id = 'default' }: JsonRecord): JsonRecord {
    const pages = this.listPages({ tenant_id, workspace_id, limit: 1000 });
    const grouped = groupBy(pages, (page) => page.category);
    const lines = ['# Wiki Index', ''];
    for (const category of Object.keys(grouped).sort()) {
      lines.push(`## ${category}`, '');
      for (const page of grouped[category]) {
        lines.push(`- [[${page.slug}|${page.title}]] - ${page.summary || 'No summary'} (${page.source_ids.length} source)`);
      }
      lines.push('');
    }
    const content = lines.join('\n').trimEnd() + '\n';
    const snapshot = {
      id: id('widx'),
      tenant_id,
      workspace_id,
      content_markdown: content,
      page_count: pages.length
    };
    run(
      this.db,
      `INSERT INTO wiki_index_snapshots (id, tenant_id, workspace_id, content_markdown, page_count)
       VALUES (?, ?, ?, ?, ?)`,
      [snapshot.id, snapshot.tenant_id, snapshot.workspace_id, snapshot.content_markdown, snapshot.page_count]
    );
    this.appendEvent({
      tenant_id,
      workspace_id,
      event_type: 'index_build',
      object_type: 'wiki_index',
      object_id: snapshot.id,
      payload: { page_count: pages.length }
    });
    return snapshot;
  }

  latestIndex({ tenant_id, workspace_id = 'default' }: JsonRecord): JsonRecord | null {
    const row = one(
      this.db,
      `SELECT * FROM wiki_index_snapshots
       WHERE tenant_id = ? AND workspace_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [tenant_id, workspace_id]
    );
    return row || null;
  }

  query({ tenant_id, workspace_id = 'default', query, limit = 5 }: JsonRecord): JsonRecord {
    if (!query) throw new Error('query is required');
    const terms = tokenize(query);
    const pages: JsonRecord[] = this.listPages({ tenant_id, workspace_id, limit: 1000 })
      .map((page): JsonRecord => ({ ...page, score: scorePage(page, terms) }))
      .filter((page) => page.score > 0)
      .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
      .slice(0, limit);
    this.appendEvent({
      tenant_id,
      workspace_id,
      event_type: 'query',
      object_type: 'wiki_query',
      object_id: '',
      payload: { query, result_count: pages.length }
    });
    return {
      query,
      results: pages.map((page) => ({
        id: page.id,
        slug: page.slug,
        title: page.title,
        category: page.category,
        summary: page.summary,
        score: page.score,
        source_ids: page.source_ids
      }))
    };
  }

  lint({ tenant_id, workspace_id = 'default' }: JsonRecord): JsonRecord {
    const pages = this.listPages({ tenant_id, workspace_id, limit: 1000 });
    const pageIds = new Set(pages.map((page) => page.id));
    const inbound = new Map(pages.map((page) => [page.id, 0]));
    const brokenLinks = [];
    for (const page of pages) {
      for (const link of page.links) {
        if (!pageIds.has(link.to_page_id)) brokenLinks.push({ from_page_id: page.id, to_page_id: link.to_page_id });
        else inbound.set(link.to_page_id, (inbound.get(link.to_page_id) || 0) + 1);
      }
    }
    const orphanPages = pages.filter((page) => (inbound.get(page.id) || 0) === 0 && pages.length > 1);
    const stalePages = pages.filter((page) => page.status === 'stale');
    const missingSources = pages.filter((page) => !page.source_ids.length);
    const result = {
      status: brokenLinks.length || stalePages.length ? 'warning' : 'passed',
      page_count: pages.length,
      orphan_pages: orphanPages.map(toPageRef),
      broken_links: brokenLinks,
      stale_pages: stalePages.map(toPageRef),
      missing_source_pages: missingSources.map(toPageRef)
    };
    this.appendEvent({
      tenant_id,
      workspace_id,
      event_type: 'lint',
      object_type: 'wiki_lint',
      object_id: '',
      payload: result
    });
    return result;
  }

  listEvents({ tenant_id, workspace_id = 'default', limit = 50 }: JsonRecord): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM wiki_events
       WHERE tenant_id = ? AND workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [tenant_id, workspace_id, limit]
    ).map((row) => ({ ...row, payload: parseJson(row.payload) }));
  }

  appendEvent(input: JsonRecord): JsonRecord {
    const event = {
      id: id('wevt'),
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      event_type: input.event_type,
      object_type: input.object_type || '',
      object_id: input.object_id || '',
      payload: input.payload || {}
    };
    run(
      this.db,
      `INSERT INTO wiki_events (id, tenant_id, workspace_id, event_type, object_type, object_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [event.id, event.tenant_id, event.workspace_id, event.event_type, event.object_type, event.object_id, json(event.payload)]
    );
    this.runStore?.audit(event.tenant_id, `wiki.${event.event_type}`, event.object_type || 'wiki_event', event.object_id || event.id, event.payload);
    return event;
  }

  replaceLinks(page: JsonRecord, links: JsonRecord[]): void {
    run(this.db, 'DELETE FROM wiki_page_links WHERE tenant_id = ? AND workspace_id = ? AND from_page_id = ?', [
      page.tenant_id,
      page.workspace_id,
      page.id
    ]);
    for (const link of links) {
      const target = link.to_page_id ? this.getPage(page.tenant_id, link.to_page_id) : this.getPageBySlug(page.tenant_id, page.workspace_id, link.to_slug || '');
      if (!target) continue;
      run(
        this.db,
        `INSERT OR IGNORE INTO wiki_page_links
          (id, tenant_id, workspace_id, from_page_id, to_page_id, link_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id('wlink'), page.tenant_id, page.workspace_id, page.id, target.id, link.link_type || 'related']
      );
    }
  }

  decodePageWithLinks(row: JsonRecord): JsonRecord {
    const page = decodePage(row);
    page.links = all(
      this.db,
      `SELECT l.*, p.slug AS to_slug, p.title AS to_title
       FROM wiki_page_links l
       JOIN wiki_pages p ON p.id = l.to_page_id AND p.tenant_id = l.tenant_id
       WHERE l.tenant_id = ? AND l.from_page_id = ?
       ORDER BY p.title ASC`,
      [page.tenant_id, page.id]
    );
    return page;
  }
}

function decodeSource(row: JsonRecord): JsonRecord {
  return { ...row, metadata: parseJson(row.metadata) };
}

function decodePage(row: JsonRecord): JsonRecord {
  return {
    ...row,
    source_ids: parseJson(row.source_ids, []),
    tags: parseJson(row.tags, [])
  };
}

function hashText(text: unknown): string {
  return createHash('sha256').update(String(text)).digest('hex');
}

function normalizeSlug(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function summarizeMarkdown(markdown: unknown): string {
  return String(markdown || '')
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .filter(Boolean)[0] || 'Generated wiki page';
}

function renderDefaultPage({ title, summary, sourceIds }: JsonRecord): string {
  return [`# ${title}`, '', summary, '', '## Sources', '', ...sourceIds.map((sourceId) => `- ${sourceId}`)].join('\n');
}

function tokenize(text: unknown): string[] {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean);
}

function scorePage(page: JsonRecord, terms: string[]): number {
  const haystack = `${page.title} ${page.summary} ${page.content_markdown} ${page.tags.join(' ')}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function groupBy(items: JsonRecord[], keyFn: (item: JsonRecord) => string): Record<string, JsonRecord[]> {
  return items.reduce((groups, item) => {
    const key = keyFn(item);
    groups[key] = groups[key] || [];
    groups[key].push(item);
    return groups;
  }, {});
}

function toPageRef(page: JsonRecord): JsonRecord {
  return {
    id: page.id,
    slug: page.slug,
    title: page.title,
    category: page.category
  };
}
