import { all, id, json, parseJson, run } from '../../db.js';
import type { HookManager } from '../hooks/hook-manager.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export interface TraceEvent extends JsonRecord {
  id: string;
  tenant_id: string;
  trace_id: string;
  event_name: string;
  object_type: string;
  object_id: string;
  workflow_run_id: string | null;
  agent_run_id: string | null;
  tool_call_id: string | null;
  model_call_id: string | null;
  payload: JsonRecord;
}

export class TraceStore {
  db: unknown;

  constructor(db: unknown) {
    this.db = db;
  }

  append(input: JsonRecord): TraceEvent | null {
    const tenantId = input.tenant_id || input.tenantId;
    if (!tenantId) return null;
    const trace = {
      id: input.id || id('traceevt'),
      tenant_id: tenantId,
      trace_id: input.trace_id || input.workflow_run_id || input.agent_run_id || input.tool_call_id || input.model_call_id || 'manual',
      event_name: input.event_name,
      object_type: input.object_type || '',
      object_id: input.object_id || '',
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      tool_call_id: input.tool_call_id || null,
      model_call_id: input.model_call_id || null,
      payload: input.payload || {}
    };
    run(
      this.db,
      `INSERT INTO trace_events
        (id, tenant_id, trace_id, event_name, object_type, object_id, workflow_run_id, agent_run_id, tool_call_id, model_call_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trace.id,
        trace.tenant_id,
        trace.trace_id,
        trace.event_name,
        trace.object_type,
        trace.object_id,
        trace.workflow_run_id,
        trace.agent_run_id,
        trace.tool_call_id,
        trace.model_call_id,
        json(trace.payload)
      ]
    );
    return trace;
  }

  list({ tenant_id, trace_id = null, workflow_run_id = null, agent_run_id = null, limit = 100 }: JsonRecord): TraceEvent[] {
    const clauses = ['tenant_id = ?'];
    const params = [tenant_id];
    if (trace_id) {
      clauses.push('trace_id = ?');
      params.push(trace_id);
    }
    if (workflow_run_id) {
      clauses.push('workflow_run_id = ?');
      params.push(workflow_run_id);
    }
    if (agent_run_id) {
      clauses.push('agent_run_id = ?');
      params.push(agent_run_id);
    }
    params.push(limit);
    return all(
      this.db,
      `SELECT * FROM trace_events WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC LIMIT ?`,
      params
    ).map((row) => ({ ...row, payload: parseJson(row.payload) }));
  }
}

export function registerTraceHooks(hookManager: HookManager, traceStore: TraceStore): void {
  hookManager.on('before_context_build', (payload) => {
    traceStore.append({
      tenant_id: payload.tenantId,
      trace_id: payload.workflowRunId || payload.goal || 'context',
      event_name: 'before_context_build',
      object_type: 'agent',
      object_id: payload.agent?.agent_id || '',
      workflow_run_id: payload.workflowRunId || null,
      payload: {
        workspace_id: payload.workspaceId,
        user_id: payload.userId,
        channel: payload.channel,
        playbook_id: payload.playbook?.playbook_id || null
      }
    });
  });

  hookManager.on('after_context_build', (payload) => {
    traceStore.append({
      tenant_id: payload.contextPack.tenantId,
      trace_id: payload.contextPack.workflowRunId || payload.contextPack.goal || 'context',
      event_name: 'after_context_build',
      object_type: 'context_pack',
      object_id: payload.contextPack.playbookId,
      workflow_run_id: payload.contextPack.workflowRunId || null,
      payload: {
        agent_id: payload.contextPack.agentId,
        memory_counts: {
          facts: payload.contextPack.memoryPack?.facts?.length || 0,
          learnings: payload.contextPack.memoryPack?.learnings?.length || 0,
          skills: payload.contextPack.memoryPack?.skills?.length || 0
        },
        allowed_toolsets: payload.contextPack.allowedToolsets || []
      }
    });
  });

  hookManager.on('before_tool_call', (payload) => {
    traceStore.append({
      tenant_id: payload.context.tenantId,
      trace_id: payload.context.workflowRunId || payload.context.agentRunId || payload.toolCall?.id,
      event_name: 'before_tool_call',
      object_type: 'tool',
      object_id: payload.tool.tool_id,
      workflow_run_id: payload.context.workflowRunId || null,
      agent_run_id: payload.context.agentRunId || null,
      tool_call_id: payload.toolCall?.id || null,
      payload: {
        agent_id: payload.context.agentId,
        risk_level: payload.tool.risk_level,
        category: payload.tool.category,
        resumed: Boolean(payload.resumed)
      }
    });
  });

  hookManager.on('after_tool_call', (payload) => {
    traceStore.append({
      tenant_id: payload.context.tenantId,
      trace_id: payload.context.workflowRunId || payload.context.agentRunId || payload.toolCall?.id,
      event_name: 'after_tool_call',
      object_type: 'tool',
      object_id: payload.tool.tool_id,
      workflow_run_id: payload.context.workflowRunId || null,
      agent_run_id: payload.context.agentRunId || null,
      tool_call_id: payload.toolCall?.id || null,
      payload: {
        status: payload.result?.status,
        resumed: Boolean(payload.resumed)
      }
    });
  });

  hookManager.on('before_model_call', (payload) => {
    traceStore.append({
      tenant_id: payload.context.tenantId,
      trace_id: payload.context.workflowRunId || payload.context.agentRunId || payload.modelCall?.id,
      event_name: 'before_model_call',
      object_type: 'model_call',
      object_id: payload.modelCall?.id || '',
      workflow_run_id: payload.context.workflowRunId || null,
      agent_run_id: payload.context.agentRunId || null,
      model_call_id: payload.modelCall?.id || null,
      payload: {
        provider: payload.request.provider,
        model: payload.request.model,
        purpose: payload.request.purpose || 'default'
      }
    });
  });

  hookManager.on('after_model_call', (payload) => {
    traceStore.append({
      tenant_id: payload.context.tenantId,
      trace_id: payload.context.workflowRunId || payload.context.agentRunId || payload.modelCall?.id,
      event_name: 'after_model_call',
      object_type: 'model_call',
      object_id: payload.modelCall?.id || '',
      workflow_run_id: payload.context.workflowRunId || null,
      agent_run_id: payload.context.agentRunId || null,
      model_call_id: payload.modelCall?.id || null,
      payload: {
        status: payload.result?.status,
        usage: payload.result?.output?.usage || {}
      }
    });
  });

  hookManager.on('before_artifact_commit', (payload) => {
    traceStore.append({
      tenant_id: payload.input.tenant_id,
      trace_id: payload.input.workflow_run_id || payload.input.agent_run_id || 'artifact',
      event_name: 'before_artifact_commit',
      object_type: 'artifact',
      object_id: payload.input.type,
      workflow_run_id: payload.input.workflow_run_id || null,
      agent_run_id: payload.input.agent_run_id || null,
      payload: { type: payload.input.type, status: payload.input.status || 'draft' }
    });
  });

  hookManager.on('after_artifact_commit', (payload) => {
    traceStore.append({
      tenant_id: payload.artifact.tenant_id,
      trace_id: payload.artifact.workflow_run_id || payload.artifact.agent_run_id || payload.artifact.id,
      event_name: 'after_artifact_commit',
      object_type: 'artifact',
      object_id: payload.artifact.id,
      workflow_run_id: payload.artifact.workflow_run_id || null,
      agent_run_id: payload.artifact.agent_run_id || null,
      payload: { type: payload.artifact.type, status: payload.artifact.status, version: payload.artifact.version }
    });
  });
}
