import { id, json, one, parseJson, run } from '../../db.js';
import type { ApprovalRequestInput, ApprovalRequestRecord, AuditStoreLike } from '../runtime-domain-types.js';

export class ApprovalQueue {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null) {
    this.db = db;
    this.runStore = runStore;
  }

  request(input: ApprovalRequestInput): ApprovalRequestRecord {
    const request = {
      id: id('approval'),
      tenant_id: input.tenant_id,
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      tool_call_id: input.tool_call_id || null,
      action_type: input.action_type,
      risk_level: input.risk_level,
      reason: input.reason || '',
      payload: input.payload || {},
      requested_by: input.requested_by || 'system'
    };
    run(
      this.db,
      `INSERT INTO approval_requests
        (id, tenant_id, workflow_run_id, agent_run_id, tool_call_id, action_type, risk_level, reason, payload, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        request.id,
        request.tenant_id,
        request.workflow_run_id,
        request.agent_run_id,
        request.tool_call_id,
        request.action_type,
        request.risk_level,
        request.reason,
        json(request.payload),
        request.requested_by
      ]
    );
    this.runStore?.audit(request.tenant_id, 'approval.requested', 'approval_request', request.id, request);
    const persisted = this.get(request.tenant_id, request.id);
    if (!persisted) throw new Error(`approval request not found after insert: ${request.id}`);
    return persisted;
  }

  decide(
    tenantId: string,
    approvalRequestId: string,
    decision: 'approved' | 'rejected',
    actorId = 'system'
  ): ApprovalRequestRecord | null {
    if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
    run(
      this.db,
      `UPDATE approval_requests
       SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
      [decision, actorId, tenantId, approvalRequestId]
    );
    const request = this.get(tenantId, approvalRequestId);
    this.runStore?.audit(tenantId, `approval.${decision}`, 'approval_request', approvalRequestId, { actorId });
    return request;
  }

  get(tenantId: string, approvalRequestId: string): ApprovalRequestRecord | null {
    const row = one(this.db, 'SELECT * FROM approval_requests WHERE tenant_id = ? AND id = ?', [
      tenantId,
      approvalRequestId
    ]);
    return row ? ({ ...row, payload: parseJson(row.payload) } as ApprovalRequestRecord) : null;
  }
}
