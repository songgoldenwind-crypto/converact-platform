import { createHash } from 'node:crypto';
import { all, id, json, one, parseJson, run } from '../../db.js';
import { recoverFromFailure } from '../core-kernel/index.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';
import type { AuditStoreLike } from '../runtime-domain-types.js';

interface CheckpointInput {
  tenant_id: string;
  type: string;
  workflow_run_id?: string | null;
  agent_run_id?: string | null;
  tool_call_id?: string | null;
  artifact_id?: string | null;
  state?: JsonRecord;
  recoverable?: boolean;
  expires_at?: string | null;
}

interface ArtifactStoreLike {
  commit: (input: JsonRecord) => JsonRecord | null;
}

export class CheckpointManager {
  db: unknown;
  runStore: AuditStoreLike | null;

  constructor(db: unknown, runStore: AuditStoreLike | null = null) {
    this.db = db;
    this.runStore = runStore;
  }

  create(input: CheckpointInput): JsonRecord | null {
    const sequence = this.nextSequence(input.tenant_id, input.workflow_run_id, input.agent_run_id);
    const checkpoint = {
      id: id('chk'),
      tenant_id: input.tenant_id,
      type: input.type,
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      tool_call_id: input.tool_call_id || null,
      artifact_id: input.artifact_id || null,
      sequence,
      state: input.state || {},
      state_hash: hashState(input.state || {}),
      recoverable: input.recoverable === false ? 0 : 1,
      expires_at: input.expires_at || null
    };
    run(
      this.db,
      `INSERT INTO checkpoints
        (id, tenant_id, type, workflow_run_id, agent_run_id, tool_call_id, artifact_id, sequence, state, state_hash, recoverable, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        checkpoint.id,
        checkpoint.tenant_id,
        checkpoint.type,
        checkpoint.workflow_run_id,
        checkpoint.agent_run_id,
        checkpoint.tool_call_id,
        checkpoint.artifact_id,
        checkpoint.sequence,
        json(checkpoint.state),
        checkpoint.state_hash,
        checkpoint.recoverable,
        checkpoint.expires_at
      ]
    );
    this.runStore?.audit(checkpoint.tenant_id, 'checkpoint.created', 'checkpoint', checkpoint.id, {
      type: checkpoint.type,
      recoverable: Boolean(checkpoint.recoverable)
    });
    return this.get(checkpoint.tenant_id, checkpoint.id);
  }

  createArtifactSnapshot(artifact: JsonRecord): JsonRecord | null {
    return this.create({
      tenant_id: artifact.tenant_id,
      type: 'artifact',
      workflow_run_id: artifact.workflow_run_id || null,
      agent_run_id: artifact.agent_run_id || null,
      artifact_id: artifact.id,
      state: { artifact },
      recoverable: true
    });
  }

  restoreArtifactSnapshot(tenantId: string, checkpointId: string, artifactStore: ArtifactStoreLike): JsonRecord | null {
    const checkpoint = this.get(tenantId, checkpointId);
    if (!checkpoint) throw new Error(`checkpoint not found: ${checkpointId}`);
    if (checkpoint.type !== 'artifact') throw new Error(`checkpoint is not an artifact snapshot: ${checkpoint.type}`);
    if (!checkpoint.recoverable) throw new Error(`checkpoint is not recoverable: ${checkpointId}`);
    const artifact = checkpoint.state.artifact;
    if (!artifact) throw new Error(`checkpoint has no artifact snapshot: ${checkpointId}`);
    return artifactStore.commit({
      tenant_id: artifact.tenant_id,
      workflow_run_id: artifact.workflow_run_id || null,
      agent_run_id: artifact.agent_run_id || null,
      type: artifact.type,
      status: 'draft',
      version: Number(artifact.version || 1) + 1,
      payload: artifact.payload,
      quality_score: artifact.quality_score ?? null,
      parent_artifact_id: artifact.id
    });
  }

  latestForWorkflow(tenantId: string, workflowRunId: string): JsonRecord | null {
    const row = one(
      this.db,
      `SELECT * FROM checkpoints
       WHERE tenant_id = ? AND workflow_run_id = ?
       ORDER BY sequence DESC, created_at DESC
       LIMIT 1`,
      [tenantId, workflowRunId]
    );
    return row ? decodeCheckpoint(row) : null;
  }

  listForWorkflow(tenantId: string, workflowRunId: string): JsonRecord[] {
    return all(
      this.db,
      `SELECT * FROM checkpoints
       WHERE tenant_id = ? AND workflow_run_id = ?
       ORDER BY sequence ASC, created_at ASC`,
      [tenantId, workflowRunId]
    ).map(decodeCheckpoint);
  }

  get(tenantId: string, checkpointId: string): JsonRecord | null {
    const row = one(this.db, 'SELECT * FROM checkpoints WHERE tenant_id = ? AND id = ?', [tenantId, checkpointId]);
    return row ? decodeCheckpoint(row) : null;
  }

  nextSequence(tenantId: string, workflowRunId: string | null = null, agentRunId: string | null = null): number {
    const row = one(
      this.db,
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM checkpoints
       WHERE tenant_id = ?
       AND COALESCE(workflow_run_id, '') = COALESCE(?, '')
       AND COALESCE(agent_run_id, '') = COALESCE(?, '')`,
      [tenantId, workflowRunId, agentRunId]
    );
    return row.next_sequence;
  }
}

export function registerCheckpointHooks(
  hookManager: { on: (hookName: string, handler: (payload: JsonRecord) => void) => void },
  checkpointManager: CheckpointManager
): void {
  hookManager.on('before_tool_call', ({ context, tool, toolCall, input }) => {
    checkpointManager.create({
      tenant_id: context.tenantId,
      type: 'tool',
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      tool_call_id: toolCall.id,
      state: {
        tool_id: tool.tool_id,
        risk_level: tool.risk_level,
        side_effect: tool.side_effect,
        input
      },
      recoverable: !tool.side_effect || tool.risk_level !== 'R3'
    });
  });

  hookManager.on('before_artifact_commit', ({ input }) => {
    checkpointManager.create({
      tenant_id: input.tenant_id,
      type: 'artifact',
      workflow_run_id: input.workflow_run_id || null,
      agent_run_id: input.agent_run_id || null,
      state: {
        artifact_input: input
      },
      recoverable: true
    });
  });

  hookManager.on('on_tool_call_failed', ({ context, tool, toolCall, error }) => {
    const failure = serializeError(error);
    const recovery = recoverFromFailure({
      phase: String(context.stepId || tool.tool_id || 'tool_call'),
      stepId: String(context.stepId || tool.tool_id || 'tool_call'),
      attempt: 1,
      maxRetries: Number(tool.retry_policy?.max_attempts ?? 1),
      error: failure
    });
    checkpointManager.create({
      tenant_id: context.tenantId,
      type: 'tool_failure',
      workflow_run_id: context.workflowRunId || null,
      agent_run_id: context.agentRunId || null,
      tool_call_id: toolCall.id,
      state: {
        tool_id: tool.tool_id,
        failure_type: recovery.failure_type,
        failure_message: failure.message,
        recovery_strategy: recovery.strategy,
        retryable: recovery.retryable,
        next_attempt: recovery.next_attempt,
        stop_reason: recovery.stop_reason
      },
      recoverable: recovery.retryable
    });
  });
}

function decodeCheckpoint(row: JsonRecord): JsonRecord {
  return {
    ...row,
    state: parseJson(row.state),
    recoverable: Boolean(row.recoverable)
  };
}

function hashState(state: JsonRecord): string {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

function serializeError(error: unknown): { code?: string; message: string; name: string } {
  if (error instanceof Error) {
    return {
      code: (error as Error & { code?: string }).code,
      message: error.message,
      name: error.name
    };
  }

  return {
    message: String(error),
    name: 'Error'
  };
}
