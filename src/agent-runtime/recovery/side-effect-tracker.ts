import { all, id, json, one, parseJson, run } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface RuntimeContext {
  tenantId: string;
  workflowRunId?: string | null;
  agentRunId?: string | null;
}

interface SideEffectTool {
  tool_id: string;
  risk_level?: string;
  side_effect?: boolean;
  compensation?: JsonRecord;
}

interface ToolCallLike {
  id: string;
}

interface RecordCommittedInput {
  context: RuntimeContext;
  tool: SideEffectTool;
  toolCall: ToolCallLike;
  output?: JsonRecord | null;
}

export class SideEffectTracker {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
  }

  recordCommitted({ context, tool, toolCall, output }: RecordCommittedInput): JsonRecord | null {
    const compensation = tool.compensation || {};
    const compensationStatus =
      compensation.status || (tool.risk_level === 'R3' ? 'manual_required' : 'not_required');
    const effect = {
      id: id('sidefx'),
      tenant_id: context.tenantId,
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      tool_call_id: toolCall.id,
      tool_id: tool.tool_id,
      external_ref: readExternalRef(output),
      status: 'committed',
      compensation_status: compensationStatus,
      compensation,
      output: output || {}
    };
    run(
      this.db,
      `INSERT INTO external_side_effects
        (id, tenant_id, workflow_run_id, agent_run_id, tool_call_id, tool_id, external_ref, status, compensation_status, compensation, output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        effect.id,
        effect.tenant_id,
        effect.workflow_run_id,
        effect.agent_run_id,
        effect.tool_call_id,
        effect.tool_id,
        effect.external_ref,
        effect.status,
        effect.compensation_status,
        json(effect.compensation),
        json(effect.output)
      ]
    );
    this.runStore?.audit(effect.tenant_id, 'side_effect.committed', 'external_side_effect', effect.id, {
      tool_id: effect.tool_id,
      tool_call_id: effect.tool_call_id,
      compensation_status: effect.compensation_status
    });
    return this.get(effect.tenant_id, effect.id);
  }

  requireCompensation(tenantId: string, sideEffectId: string, reason?: string): JsonRecord | null {
    const effect = this.get(tenantId, sideEffectId);
    if (!effect) throw new Error(`side effect not found: ${sideEffectId}`);
    const compensation = {
      ...effect.compensation,
      required_reason: reason || effect.compensation.required_reason || 'manual compensation review required'
    };
    run(
      this.db,
      `UPDATE external_side_effects
       SET status = 'compensation_required',
           compensation_status = CASE
             WHEN compensation_status = 'not_required' THEN 'required'
             ELSE compensation_status
           END,
           compensation = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [json(compensation), tenantId, sideEffectId]
    );
    this.runStore?.audit(tenantId, 'side_effect.compensation_required', 'external_side_effect', sideEffectId, {
      reason
    });
    return this.get(tenantId, sideEffectId);
  }

  markCompensated(tenantId: string, sideEffectId: string, details: JsonRecord = {}): JsonRecord | null {
    const effect = this.get(tenantId, sideEffectId);
    if (!effect) throw new Error(`side effect not found: ${sideEffectId}`);
    run(
      this.db,
      `UPDATE external_side_effects
       SET status = 'compensated',
           compensation_status = 'completed',
           compensation = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ?`,
      [json({ ...effect.compensation, completed: details }), tenantId, sideEffectId]
    );
    this.runStore?.audit(tenantId, 'side_effect.compensated', 'external_side_effect', sideEffectId, details);
    return this.get(tenantId, sideEffectId);
  }

  listForWorkflow(tenantId: string, workflowRunId: string): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM external_side_effects
       WHERE tenant_id = ? AND workflow_run_id = ?
       ORDER BY created_at ASC`,
      [tenantId, workflowRunId]
    ).map(decodeSideEffect);
  }

  listForToolCall(tenantId: string, toolCallId: string): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM external_side_effects
       WHERE tenant_id = ? AND tool_call_id = ?
       ORDER BY created_at ASC`,
      [tenantId, toolCallId]
    ).map(decodeSideEffect);
  }

  get(tenantId: string, sideEffectId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM external_side_effects WHERE tenant_id = ? AND id = ?', [
      tenantId,
      sideEffectId
    ]);
    return row ? decodeSideEffect(row) : null;
  }
}

export function registerSideEffectHooks(
  hookManager: { on: (hookName: string, handler: (payload: JsonRecord) => void) => void },
  sideEffectTracker: SideEffectTracker
): void {
  hookManager.on('after_tool_call', ({ context, tool, toolCall, result }) => {
    if (!tool.side_effect || result?.status !== 'success') return;
    sideEffectTracker.recordCommitted({
      context,
      tool,
      toolCall,
      output: result.output
    });
  });
}

function decodeSideEffect(row: JsonRecord): JsonRecord {
  return {
    ...row,
    compensation: parseJson(row.compensation),
    output: parseJson(row.output)
  };
}

function readExternalRef(output: JsonRecord = {}): string {
  return (
    output.external_ref ||
    output.external_id ||
    output.call_log?.external_call_id ||
    output.call_log?.id ||
    output.delivery?.provider ||
    ''
  );
}
