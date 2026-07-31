/**
 * IVR Flow Store — persists IvrFlowGraph JSON in the voice_agent_specs table.
 *
 * Reuses the existing table (nodes column stores the graph JSON), adding
 * a `flow_type` discriminator in the goal field to distinguish IVR flows
 * from regular voice-agent specs.
 */

import { randomUUID } from 'node:crypto';
import { run, one, all, parseJson } from '../../db.js';
import type { IvrFlowGraph } from './ivr-types.js';

export interface IvrFlowRecord {
  id: string;
  tenant_id: string;
  name: string;
  status: 'draft' | 'published' | 'needs_repair';
  version: number;
  graph: IvrFlowGraph;
  created_at: string;
  updated_at: string;
}

const FLOW_MARKER = '__ivr_flow__';

export class IvrFlowStore {
  constructor(private db: unknown) {}

  saveFlow(
    tenantId: string,
    id: string,
    name: string,
    graph: IvrFlowGraph,
    language = 'zh'
  ): IvrFlowRecord {
    const existing = one(this.db, 'SELECT * FROM voice_agent_specs WHERE id = ?', [id]) as
      | Record<string, unknown>
      | null;
    if (existing && String(existing.tenant_id) !== tenantId) {
      throw Object.assign(new Error('flow belongs to another tenant'), { status: 403 });
    }
    // Snapshot the current version into history before overwriting
    if (existing) {
      const currentGraphStr = existing.nodes as string;
      const currentVersion = (existing.version as number) ?? 1;
      run(this.db, `INSERT INTO ivr_flow_history (id, flow_id, tenant_id, version, name, graph, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
        [`${id}_h_${randomUUID()}`, id, tenantId,
         currentVersion, existing.goal as string, currentGraphStr]);
    }
    if (existing) {
      const nextVersion = ((existing.version as number) ?? 1) + 1;
      run(
        this.db,
        `UPDATE voice_agent_specs SET goal = ?, nodes = ?, version = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND tenant_id = ?`,
        [name, JSON.stringify(graph), nextVersion, id, tenantId]
      );
    } else {
      run(
        this.db,
        `INSERT INTO voice_agent_specs (id, tenant_id, language, goal, status, version, tools, compliance, runtime, nodes)
         VALUES (?, ?, ?, ?, 'draft', 1, '[]', '{}', '{}', ?)`,
        [id, tenantId, language, name, JSON.stringify(graph)]
      );
    }
    return this.getFlow(tenantId, id)!;
  }

  getFlow(tenantId: string, id: string): IvrFlowRecord | null {
    const row = one(this.db, 'SELECT * FROM voice_agent_specs WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    if (!row) return null;
    return this.decodeFlow(row);
  }

  listFlows(tenantId: string): IvrFlowRecord[] {
    const rows = all(this.db, 'SELECT * FROM voice_agent_specs WHERE tenant_id = ? ORDER BY updated_at DESC', [tenantId]);
    return rows.map((r) => this.decodeFlow(r)).filter((f): f is IvrFlowRecord => f !== null);
  }

  publishFlow(tenantId: string, id: string): void {
    run(this.db, 'UPDATE voice_agent_specs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?', ['published', id, tenantId]);
  }

  setFlowStatus(tenantId: string, id: string, status: IvrFlowRecord['status']): void {
    run(this.db, 'UPDATE voice_agent_specs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?', [status, id, tenantId]);
  }

  deleteFlow(tenantId: string, id: string): boolean {
    const result = run(this.db, 'DELETE FROM voice_agent_specs WHERE id = ? AND tenant_id = ?', [id, tenantId]);
    return result.changes > 0;
  }

  private decodeFlow(row: Record<string, unknown>): IvrFlowRecord | null {
    const graphStr = row.nodes as string;
    if (!graphStr) return null;
    let graph: IvrFlowGraph;
    try {
      graph = JSON.parse(graphStr);
    } catch {
      return null;
    }
    // Only return if it looks like an IVR flow graph (has entryNodeId)
    if (!graph.entryNodeId) return null;
    return {
      id: row.id as string,
      tenant_id: row.tenant_id as string,
      name: (row.goal as string) || '未命名流程',
      status: row.status as IvrFlowRecord['status'],
      version: (row.version as number) ?? 1,
      graph,
      created_at: (row.created_at as string) || '',
      updated_at: (row.updated_at as string) || '',
    };
  }

  // --- Version history ---

  listFlowHistory(tenantId: string, flowId: string): Array<{ version: number; name: string; created_at: string }> {
    const rows = all(
      this.db,
      `SELECT h.version, h.name, h.created_at
       FROM ivr_flow_history h
       INNER JOIN (
         SELECT version, MAX(created_at) AS max_created_at
         FROM ivr_flow_history
         WHERE flow_id = ? AND tenant_id = ?
         GROUP BY version
       ) latest ON h.version = latest.version AND h.created_at = latest.max_created_at
       WHERE h.flow_id = ? AND h.tenant_id = ?
       ORDER BY h.version DESC`,
      [flowId, tenantId, flowId, tenantId]
    );
    return rows.map((r) => ({
      version: r.version as number,
      name: r.name as string,
      created_at: (r.created_at as string) || '',
    }));
  }

  getFlowVersion(tenantId: string, flowId: string, version: number): IvrFlowRecord | null {
    const row = one(
      this.db,
      `SELECT * FROM ivr_flow_history
       WHERE flow_id = ? AND tenant_id = ? AND version = ?
       ORDER BY created_at DESC LIMIT 1`,
      [flowId, tenantId, version]
    );
    if (!row) return null;
    let graph: IvrFlowGraph;
    try { graph = JSON.parse(row.graph as string); } catch { return null; }
    return {
      id: flowId,
      tenant_id: tenantId,
      name: (row.name as string) || '未命名流程',
      status: 'draft',
      version: row.version as number,
      graph,
      created_at: (row.created_at as string) || '',
      updated_at: '',
    };
  }

  rollbackFlow(tenantId: string, flowId: string, version: number): IvrFlowRecord | null {
    const historical = this.getFlowVersion(tenantId, flowId, version);
    if (!historical) return null;
    // Restore the historical graph as the current version
    return this.saveFlow(tenantId, flowId, historical.name, historical.graph);
  }
}
