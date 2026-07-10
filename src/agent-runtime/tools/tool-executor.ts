import { id } from '../../db.js';
import type { HookManagerLike } from '../context/runtime-types.js';
import type {
  ApprovalPolicyLike,
  ApprovalQueueLike,
  ToolBlockedResult,
  ToolCallRecord,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolInput,
  ToolRegistryLike,
  ToolRunStoreLike,
  ToolSuccessResult
} from '../runtime-domain-types.js';

export class ToolExecutor {
  registry: ToolRegistryLike;
  approvalPolicy: ApprovalPolicyLike;
  approvalQueue: ApprovalQueueLike;
  runStore: ToolRunStoreLike;
  hookManager: HookManagerLike | null;

  constructor({
    registry,
    approvalPolicy,
    approvalQueue,
    runStore,
    hookManager = null
  }: {
    registry: ToolRegistryLike;
    approvalPolicy: ApprovalPolicyLike;
    approvalQueue: ApprovalQueueLike;
    runStore: ToolRunStoreLike;
    hookManager?: HookManagerLike | null;
  }) {
    this.registry = registry;
    this.approvalPolicy = approvalPolicy;
    this.approvalQueue = approvalQueue;
    this.runStore = runStore;
    this.hookManager = hookManager;
  }

  async execute(context: ToolExecutionContext, toolId: string, input: ToolInput = {}): Promise<ToolExecutionResult> {
    const { definition, handler } = this.registry.get(toolId);
    const idempotencyKey =
      typeof input.idempotency_key === 'string'
        ? input.idempotency_key
        : `${context.agentRunId}:${definition.tool_id}:${context.stepId || 'manual'}`;
    const toolCall = this.runStore.recordToolCall({
      id: id('tcall'),
      tenant_id: context.tenantId,
      workflow_run_id: context.workflowRunId,
      agent_run_id: context.agentRunId,
      tool_id: definition.tool_id,
      risk_level: definition.risk_level,
      status: 'created',
      input,
      idempotency_key: idempotencyKey
    });

    let executionInput: ToolInput;
    try {
      const evaluation = this.approvalPolicy.evaluate({
        context: { ...context, agentId: context.agentId },
        tool: definition,
        input
      });
      this.approvalPolicy.assertAllowed(evaluation);
      executionInput = definition.tenant_scope_required ? { ...input, tenant_id: context.tenantId } : input;
      await this.hookManager?.run?.('before_tool_call', {
        context,
        tool: definition,
        toolCall,
        input: executionInput,
        evaluation
      });
      if (!definition.domain_approval_handler && evaluation.decision === 'approval_required') {
        const approval = this.approvalQueue.request({
          tenant_id: context.tenantId,
          workflow_run_id: context.workflowRunId,
          agent_run_id: context.agentRunId,
          tool_call_id: toolCall.id,
          action_type: definition.tool_id,
          risk_level: definition.risk_level,
          reason: evaluation.reason,
          payload: executionInput
        });
        this.runStore.updateToolCall(context.tenantId, toolCall.id, {
          status: 'blocked_pending_approval',
          approval_request_id: approval.id
        });
        const blocked: ToolBlockedResult = { status: 'blocked_pending_approval', approval_request: approval };
        await this.hookManager?.run?.('after_tool_call', {
          context,
          tool: definition,
          toolCall: this.runStore.getToolCall(context.tenantId, toolCall.id),
          result: blocked
        });
        return blocked;
      }
    } catch (error: unknown) {
      const failed = this.runStore.updateToolCall(context.tenantId, toolCall.id, {
        status: 'failed',
        error: serializeError(error),
        finished_at: new Date().toISOString()
      });
      await this.hookManager?.run?.('on_tool_call_failed', {
        context,
        tool: definition,
        toolCall: failed,
        error
      });
      throw error;
    }

    try {
      this.runStore.updateToolCall(context.tenantId, toolCall.id, {
        status: 'running',
        started_at: new Date().toISOString()
      });
      const output = await handler(executionInput, context);
      const finished = this.runStore.updateToolCall(context.tenantId, toolCall.id, {
        status: 'success',
        output,
        finished_at: new Date().toISOString()
      });
      this.runStore.audit(context.tenantId, definition.audit_event_name, 'tool_call', toolCall.id, {
        tool_id: definition.tool_id,
        risk_level: definition.risk_level
      });
      const result: ToolSuccessResult = { status: 'success', output, tool_call: finished };
      await this.hookManager?.run?.('after_tool_call', {
        context,
        tool: definition,
        toolCall: finished,
        result
      });
      return result;
    } catch (error: unknown) {
      const failed = this.runStore.updateToolCall(context.tenantId, toolCall.id, {
        status: 'failed',
        error: serializeError(error),
        finished_at: new Date().toISOString()
      });
      await this.hookManager?.run?.('on_tool_call_failed', {
        context,
        tool: definition,
        toolCall: failed,
        error
      });
      throw error;
    }
  }

  async resumeApproved(context: ToolExecutionContext, toolCallId: string): Promise<ToolSuccessResult> {
    const toolCall = this.runStore.getToolCall(context.tenantId, toolCallId);
    if (!toolCall) throw new Error(`tool call not found: ${toolCallId}`);
    if (toolCall.status !== 'blocked_pending_approval') {
      throw new Error(`tool call is not waiting for approval: ${toolCall.status}`);
    }

    const approval = this.approvalQueue.get(context.tenantId, toolCall.approval_request_id);
    if (!approval || approval.status !== 'approved') {
      const error = new Error('approval is required before resuming tool call');
      error.status = 409;
      throw error;
    }

    const { definition, handler } = this.registry.get(toolCall.tool_id);
    const executionInput = definition.tenant_scope_required
      ? { ...toolCall.input, tenant_id: context.tenantId }
      : toolCall.input;
    try {
      await this.hookManager?.run?.('before_tool_call', {
        context,
        tool: definition,
        toolCall,
        input: executionInput,
        resumed: true
      });
    } catch (error: unknown) {
      const failed = this.runStore.updateToolCall(context.tenantId, toolCall.id, {
        status: 'failed',
        error: serializeError(error),
        finished_at: new Date().toISOString()
      });
      await this.hookManager?.run?.('on_tool_call_failed', {
        context,
        tool: definition,
        toolCall: failed,
        error,
        resumed: true
      });
      throw error;
    }

    this.runStore.updateToolCall(context.tenantId, toolCall.id, {
      status: 'running',
      started_at: new Date().toISOString()
    });
    const output = await handler(executionInput, context);
    const finished = this.runStore.updateToolCall(context.tenantId, toolCall.id, {
      status: 'success',
      output,
      finished_at: new Date().toISOString()
    });
    this.runStore.audit(context.tenantId, `${definition.audit_event_name}.resumed`, 'tool_call', toolCall.id, {
      tool_id: definition.tool_id,
      approval_request_id: approval.id
    });
    const result: ToolSuccessResult = { status: 'success', output, tool_call: finished };
    await this.hookManager?.run?.('after_tool_call', {
      context,
      tool: definition,
      toolCall: finished,
      result,
      resumed: true
    });
    return result;
  }
}

function serializeError(error: unknown): { message: string; name: string } {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name
    };
  }
  return {
    message: String(error),
    name: 'Error'
  };
}
