/**
 * Persists active IVR runtime sessions for multi-step inbound calls.
 */

import { run, one, all, parseJson } from '../../db.js';
import { migrateIvrRuntimeTables } from '../../db-migrations/ivr-runtime-schema.js';
import type { IvrAction, IvrRuntimeContext } from './ivr-executor.js';

export interface StoredIvrSession {
  call_session_id: string;
  tenant_id: string;
  flow_id: string;
  context: IvrRuntimeContext;
  step_count: number;
  terminated: number;
  revision: number;
  last_action?: IvrAction;
  updated_at: string;
}

export interface StoredIvrSessionStep {
  id: number;
  call_session_id: string;
  step_index: number;
  node_id: string | null;
  action_kind: string;
  action_json: string;
  branch_taken: string | null;
  created_at: string;
}

export class IvrSessionStore {
  constructor(private db: unknown) {
    migrateIvrRuntimeTables(db);
  }

  private parseLastAction(raw: string): IvrAction | undefined {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as IvrAction).kind === 'string') {
        return parsed as IvrAction;
      }
      console.warn('[ivr-session] invalid last_action_json shape');
      return undefined;
    } catch {
      console.warn('[ivr-session] invalid last_action_json');
      return undefined;
    }
  }

  appendStep(input: {
    callSessionId: string;
    tenantId: string;
    stepIndex: number;
    nodeId: string | null;
    action: IvrAction;
    branchTaken?: string | null;
  }): void {
    run(
      this.db,
      `INSERT INTO ivr_session_steps (call_session_id, tenant_id, step_index, node_id, action_kind, action_json, branch_taken)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.callSessionId,
        input.tenantId,
        input.stepIndex,
        input.nodeId,
        input.action.kind,
        JSON.stringify(input.action),
        input.branchTaken ?? null,
      ]
    );
  }

  listSteps(callSessionId: string, tenantId: string): StoredIvrSessionStep[] {
    const rows = all(
      this.db,
      `SELECT id, call_session_id, step_index, node_id, action_kind, action_json, branch_taken, created_at
       FROM ivr_session_steps
       WHERE call_session_id = ? AND tenant_id = ?
       ORDER BY step_index ASC`,
      [callSessionId, tenantId]
    );
    return rows.map((row) => ({
      id: row.id as number,
      call_session_id: row.call_session_id as string,
      step_index: row.step_index as number,
      node_id: (row.node_id as string) || null,
      action_kind: row.action_kind as string,
      action_json: row.action_json as string,
      branch_taken: (row.branch_taken as string) || null,
      created_at: (row.created_at as string) || '',
    }));
  }

  deleteSteps(callSessionId: string, tenantId: string): void {
    run(this.db, 'DELETE FROM ivr_session_steps WHERE call_session_id = ? AND tenant_id = ?', [
      callSessionId,
      tenantId,
    ]);
  }

  upsert(input: {
    callSessionId: string;
    tenantId: string;
    flowId: string;
    context: IvrRuntimeContext;
    stepCount: number;
    terminated: boolean;
    lastAction?: IvrAction;
    /** When set on update, must match current revision or throws 409 */
    expectedRevision?: number;
  }): number {
    const existing = one(
      this.db,
      'SELECT tenant_id, revision FROM ivr_sessions WHERE call_session_id = ?',
      [input.callSessionId]
    ) as { tenant_id?: string; revision?: number } | null;
    if (existing && String(existing.tenant_id) !== input.tenantId) {
      throw Object.assign(new Error('ivr session belongs to another tenant'), { status: 409 });
    }
    if (existing && input.expectedRevision != null) {
      const current = Number(existing.revision ?? 0);
      if (current !== input.expectedRevision) {
        throw Object.assign(
          new Error(
            `ivr session revision conflict (expected ${input.expectedRevision}, current ${current})`
          ),
          { status: 409 }
        );
      }
    }

    if (!existing) {
      run(
        this.db,
        `INSERT INTO ivr_sessions (call_session_id, tenant_id, flow_id, context_json, step_count, terminated, last_action_json, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
        [
          input.callSessionId,
          input.tenantId,
          input.flowId,
          JSON.stringify(input.context),
          input.stepCount,
          input.terminated ? 1 : 0,
          input.lastAction ? JSON.stringify(input.lastAction) : null,
        ]
      );
      return 0;
    }

    const result = run(
      this.db,
      `UPDATE ivr_sessions SET
         flow_id = ?,
         context_json = ?,
         step_count = ?,
         terminated = ?,
         last_action_json = ?,
         revision = revision + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE call_session_id = ? AND tenant_id = ?
         AND (? IS NULL OR revision = ?)`,
      [
        input.flowId,
        JSON.stringify(input.context),
        input.stepCount,
        input.terminated ? 1 : 0,
        input.lastAction ? JSON.stringify(input.lastAction) : null,
        input.callSessionId,
        input.tenantId,
        input.expectedRevision ?? null,
        input.expectedRevision ?? null,
      ]
    );
    if (result.changes === 0) {
      throw Object.assign(new Error('ivr session revision conflict'), { status: 409 });
    }
    const row = one(
      this.db,
      'SELECT revision FROM ivr_sessions WHERE call_session_id = ? AND tenant_id = ?',
      [input.callSessionId, input.tenantId]
    ) as { revision?: number } | null;
    return Number(row?.revision ?? 0);
  }

  get(callSessionId: string, tenantId: string): StoredIvrSession | null {
    const row = one(
      this.db,
      'SELECT * FROM ivr_sessions WHERE call_session_id = ? AND tenant_id = ?',
      [callSessionId, tenantId]
    );
    if (!row) return null;
    return this.decode(row);
  }

  delete(callSessionId: string, tenantId: string): boolean {
    this.deleteSteps(callSessionId, tenantId);
    const result = run(
      this.db,
      'DELETE FROM ivr_sessions WHERE call_session_id = ? AND tenant_id = ?',
      [callSessionId, tenantId]
    );
    return result.changes > 0;
  }

  listActive(tenantId: string): StoredIvrSession[] {
    const rows = all(
      this.db,
      'SELECT * FROM ivr_sessions WHERE tenant_id = ? AND terminated = 0 ORDER BY updated_at DESC',
      [tenantId]
    );
    return rows.map((r) => this.decode(r));
  }

  listAll(tenantId: string, limit = 50): StoredIvrSession[] {
    const rows = all(
      this.db,
      'SELECT * FROM ivr_sessions WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?',
      [tenantId, limit]
    );
    return rows.map((r) => this.decode(r));
  }

  private decode(row: Record<string, unknown>): StoredIvrSession {
    const lastActionRaw = row.last_action_json as string | null | undefined;
    return {
      call_session_id: row.call_session_id as string,
      tenant_id: row.tenant_id as string,
      flow_id: row.flow_id as string,
      context: parseJson(row.context_json as string, {
        graph: { version: 1, entryNodeId: '', nodes: [], edges: [], variables: [] },
        currentNodeId: null,
        variables: {},
        flowStack: [],
      } as IvrRuntimeContext),
      step_count: (row.step_count as number) ?? 0,
      terminated: (row.terminated as number) ?? 0,
      revision: Number(row.revision ?? 0),
      last_action: lastActionRaw ? this.parseLastAction(lastActionRaw) : undefined,
      updated_at: (row.updated_at as string) || '',
    };
  }
}
