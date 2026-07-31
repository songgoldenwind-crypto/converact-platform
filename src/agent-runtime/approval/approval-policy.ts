import { policyError, riskRank } from '../contracts.js';
import type { ApprovalEvaluation, RiskLevel, ToolDefinition, ToolExecutionContext, ToolInput } from '../runtime-domain-types.js';

export class ApprovalPolicy {
  autoApproveRiskMax: RiskLevel;
  hardBlockedTools: Set<string>;

  constructor(options: { autoApproveRiskMax?: RiskLevel; hardBlockedTools?: string[] } = {}) {
    this.autoApproveRiskMax = options.autoApproveRiskMax || 'R2';
    this.hardBlockedTools = new Set(options.hardBlockedTools || []);
  }

  evaluate({
    context,
    tool,
    input
  }: {
    context: ToolExecutionContext;
    tool: ToolDefinition;
    input: ToolInput;
  }): ApprovalEvaluation {
    if (this.hardBlockedTools.has(tool.tool_id)) {
      return { decision: 'deny', reason: `${tool.tool_id} is hard-blocked` };
    }

    if (tool.tenant_scope_required && input?.tenant_id && input.tenant_id !== context.tenantId) {
      return { decision: 'deny', reason: 'cross-tenant tool input is denied' };
    }

    if (tool.forbidden_agents?.includes(context.agentId)) {
      return { decision: 'deny', reason: `${context.agentId} is forbidden to call ${tool.tool_id}` };
    }

    if (!tool.allowed_agents.includes('*') && !tool.allowed_agents.includes(context.agentId)) {
      return { decision: 'deny', reason: `${context.agentId} is not allowed to call ${tool.tool_id}` };
    }

    if (
      !tool.domain_approval_handler
      && (tool.approval_required || riskRank(tool.risk_level) > riskRank(this.autoApproveRiskMax))
    ) {
      return { decision: 'approval_required', reason: `${tool.tool_id} requires approval at ${tool.risk_level}` };
    }

    return { decision: 'allow', reason: 'allowed by policy' };
  }

  assertAllowed(evaluation: ApprovalEvaluation): void {
    if (evaluation.decision === 'deny') throw policyError(evaluation.reason);
  }
}
