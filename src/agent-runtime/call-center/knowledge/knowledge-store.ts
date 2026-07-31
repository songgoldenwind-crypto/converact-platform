import { all, id, json, one, parseJson, run } from '../../../db.js';

export interface KnowledgeBase {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: string;
  document_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledge_base_id: string;
  tenant_id: string;
  title: string;
  content: string;
  content_type: string;
  chunks: string[];
  metadata: Record<string, unknown>;
  status: string;
  created_at: string;
}

export class KnowledgeStore {
  constructor(private readonly db: unknown) {
    (db as { exec(sql: string): void }).exec(`
      CREATE TABLE IF NOT EXISTS knowledge_bases (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        document_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_kb_tenant ON knowledge_bases(tenant_id);

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        chunks TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'indexed',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_kd_kb ON knowledge_documents(knowledge_base_id);
      CREATE INDEX IF NOT EXISTS idx_kd_tenant ON knowledge_documents(tenant_id);
    `);
  }

  createKnowledgeBase(input: { tenant_id: string; name: string; description?: string }): KnowledgeBase {
    const kbId = id('kb');
    const now = new Date().toISOString();
    run(
      this.db,
      `INSERT INTO knowledge_bases (id, tenant_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [kbId, input.tenant_id, input.name, input.description ?? '', now, now]
    );
    return this.getKnowledgeBase(kbId)!;
  }

  getKnowledgeBase(kbId: string): KnowledgeBase | null {
    const row = one(this.db, 'SELECT * FROM knowledge_bases WHERE id = ?', [kbId]);
    return row ? decodeKnowledgeBase(row) : null;
  }

  listKnowledgeBases(tenantId: string): KnowledgeBase[] {
    return all(
      this.db,
      'SELECT * FROM knowledge_bases WHERE tenant_id = ? ORDER BY created_at DESC',
      [tenantId]
    ).map(decodeKnowledgeBase);
  }

  addDocument(input: {
    knowledge_base_id: string;
    tenant_id: string;
    title: string;
    content: string;
    content_type?: string;
  }): KnowledgeDocument {
    const docId = id('doc');
    const now = new Date().toISOString();
    run(
      this.db,
      `INSERT INTO knowledge_documents
        (id, knowledge_base_id, tenant_id, title, content, content_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [docId, input.knowledge_base_id, input.tenant_id, input.title, input.content, input.content_type ?? 'text', now]
    );
    run(
      this.db,
      `UPDATE knowledge_bases SET document_count = document_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [input.knowledge_base_id]
    );
    return this.getDocument(docId)!;
  }

  getDocument(docId: string): KnowledgeDocument | null {
    const row = one(this.db, 'SELECT * FROM knowledge_documents WHERE id = ?', [docId]);
    return row ? decodeDocument(row) : null;
  }

  listDocuments(knowledgeBaseId: string): KnowledgeDocument[] {
    return all(
      this.db,
      'SELECT * FROM knowledge_documents WHERE knowledge_base_id = ? ORDER BY created_at DESC',
      [knowledgeBaseId]
    ).map(decodeDocument);
  }

  deleteDocument(docId: string): void {
    const doc = this.getDocument(docId);
    if (!doc) return;
    run(this.db, 'DELETE FROM knowledge_documents WHERE id = ?', [docId]);
    run(
      this.db,
      `UPDATE knowledge_bases SET document_count = MAX(0, document_count - 1), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [doc.knowledge_base_id]
    );
  }

  searchDocuments(
    tenantId: string,
    query: string,
    opts?: { limit?: number; knowledgeBaseId?: string }
  ): KnowledgeDocument[] {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const conditions = ['tenant_id = ?'];
    const params: (string | number)[] = [tenantId];

    if (opts?.knowledgeBaseId) {
      conditions.push('knowledge_base_id = ?');
      params.push(opts.knowledgeBaseId);
    }

    const likeConditions = words.map(() => "(content LIKE ? OR title LIKE ?)");
    conditions.push(`(${likeConditions.join(' AND ')})`);
    for (const word of words) {
      params.push(`%${word}%`, `%${word}%`);
    }

    const limit = opts?.limit ?? 10;
    params.push(limit);

    return all(
      this.db,
      `SELECT * FROM knowledge_documents WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    ).map(decodeDocument);
  }
}

function decodeKnowledgeBase(row: Record<string, unknown>): KnowledgeBase {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    name: String(row.name),
    description: String(row.description),
    status: String(row.status),
    document_count: Number(row.document_count),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function decodeDocument(row: Record<string, unknown>): KnowledgeDocument {
  return {
    id: String(row.id),
    knowledge_base_id: String(row.knowledge_base_id),
    tenant_id: String(row.tenant_id),
    title: String(row.title),
    content: String(row.content),
    content_type: String(row.content_type),
    chunks: parseJson<string[]>(row.chunks as string, []),
    metadata: parseJson<Record<string, unknown>>(row.metadata as string, {}),
    status: String(row.status),
    created_at: String(row.created_at)
  };
}
