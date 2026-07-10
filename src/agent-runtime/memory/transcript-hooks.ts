import { one } from '../../db.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { MemoryMaintenance } from './memory-maintenance.js';

interface HookManagerLike {
  on: (hookName: string, handler: (payload: JsonRecord) => void | Promise<void>) => void;
}

interface TranscriptStoreLike {
  append: (input: JsonRecord) => JsonRecord | null;
}

interface BusinessObjectRef {
  object_type: string;
  object_id: string;
}

const RECALL_LOG_BACKLOG_THRESHOLD = 100;
const BACKLOG_DEBOUNCE_MS = 5000;

export function registerTranscriptHooks(
  hookManager: HookManagerLike,
  transcriptStore: TranscriptStoreLike,
  db: unknown = null,
  memoryMaintenance: MemoryMaintenance | null = null
): void {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  hookManager.on('after_context_build', ({ contextPack }) => {
    transcriptStore.append({
      tenant_id: contextPack.tenantId,
      workspace_id: contextPack.workspaceId,
      session_key: contextPack.session?.sessionKey || '',
      workflow_run_id: contextPack.session?.businessObjectType === 'workflow' ? contextPack.session.businessObjectId : null,
      agent_run_id: null,
      role: 'system',
      content_type: 'context_pack',
      content: {
        agent_id: contextPack.agentId,
        playbook_id: contextPack.playbookId,
        goal: contextPack.goal,
        session: contextPack.session,
        memory_count: {
          facts: contextPack.memoryPack?.facts?.length || 0,
          learnings: contextPack.memoryPack?.learnings?.length || 0,
          skills: contextPack.memoryPack?.skills?.length || 0
        }
      },
      channel: contextPack.channel,
      business_object_refs: businessRefsFromSession(contextPack.session)
    });

    // Backlog trigger: debounced auto-run maintenance when recall_log is backing up
    if (db && memoryMaintenance) {
      try {
        const backlog = one(db,
          `SELECT COUNT(*) as cnt FROM memory_recall_logs WHERE tenant_id = ?`,
          [contextPack.tenantId]
        );
        if (backlog && backlog.cnt >= RECALL_LOG_BACKLOG_THRESHOLD && !debounceTimers.has(contextPack.tenantId)) {
          const timer = setTimeout(() => {
            debounceTimers.delete(contextPack.tenantId);
            memoryMaintenance.runMaintenanceCycle(contextPack.tenantId).catch(() => {
              // Silently ignore — maintenance must not break transcript logging
            });
          }, BACKLOG_DEBOUNCE_MS);
          debounceTimers.set(contextPack.tenantId, timer);
        }
      } catch {
        // Silently ignore — maintenance must not break transcript logging
      }
    }
  });

  hookManager.on('after_tool_call', ({ context, tool, result }) => {
    transcriptStore.append({
      tenant_id: context.tenantId,
      workspace_id: context.workspaceId || 'default',
      session_key: context.sessionKey || '',
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      role: 'tool',
      content_type: result.status === 'blocked_pending_approval' ? 'approval_decision' : 'tool_result',
      content: {
        tool_id: tool.tool_id,
        status: result.status,
        output: result.output || null,
        approval_request_id: result.approval_request?.id || null
      },
      channel: context.channel || '',
      business_object_refs: []
    });
  });

  hookManager.on('after_model_call', ({ context, request, result }) => {
    transcriptStore.append({
      tenant_id: context.tenantId,
      workspace_id: context.workspaceId || 'default',
      session_key: context.sessionKey || '',
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      role: 'assistant',
      content_type: 'model_result',
      content: {
        provider: request.provider,
        model: request.model,
        purpose: request.purpose || 'default',
        content: result.output.content,
        structured_output: result.output.structured_output
      },
      channel: context.channel || '',
      business_object_refs: []
    });
  });

  hookManager.on('after_artifact_commit', ({ artifact }) => {
    transcriptStore.append({
      tenant_id: artifact.tenant_id,
      workspace_id: 'default',
      session_key: '',
      workflow_run_id: artifact.workflow_run_id || null,
      agent_run_id: artifact.agent_run_id || null,
      role: 'event',
      content_type: 'artifact_ref',
      content: {
        artifact_id: artifact.id,
        type: artifact.type,
        status: artifact.status,
        version: artifact.version
      },
      channel: '',
      business_object_refs: []
    });
  });
}

function businessRefsFromSession(session: JsonRecord = {}): BusinessObjectRef[] {
  if (!session.businessObjectType || !session.businessObjectId) return [];
  return [
    {
      object_type: String(session.businessObjectType),
      object_id: String(session.businessObjectId)
    }
  ];
}
