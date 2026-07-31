import { terminalAgentStatuses } from './contracts.js';
import { classifyFailure, decideNextStep, recoverFromFailure, verifyAndTune, DEFAULT_FEEDBACK_THRESHOLDS } from './core-kernel/index.js';
import { resolveInputTemplate } from './workflow/template.js';
import type { JsonRecord } from './integrations/provider-runtime-types.js';

interface HarnessRuntimeOptions {
  agentRegistry: AgentRegistryLike;
  toolExecutor: ToolExecutorLike;
  artifactStore: ArtifactStoreLike;
  runStore: RuntimeRunStoreLike;
  contextBuilder: ContextBuilderLike;
  scopeLocks?: ScopeLocksLike | null;
  qualityGateRegistry?: QualityGateRegistryLike | null;
}

interface AgentRegistryLike {
  getPlaybook: (playbookId: string) => JsonRecord;
  getManifest: (agentId: string, version?: string) => JsonRecord;
  isEnabledForTenant: (tenantId: string, agentId: string) => boolean;
}

interface ToolExecutorLike {
  execute: (context: JsonRecord, toolId: string, input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface ArtifactStoreLike {
  commit: (input: JsonRecord) => JsonRecord;
  listForAgentRun: (tenantId: string, agentRunId: string) => JsonRecord[];
}

interface RuntimeRunStoreLike {
  createWorkflowRun: (input: JsonRecord) => JsonRecord | null;
  getWorkflowRun: (tenantId: string, workflowRunId: string) => JsonRecord | null;
  updateWorkflowRun: (tenantId: string, workflowRunId: string, patch: JsonRecord) => JsonRecord | null;
  recordFeedbackActions?: (input: JsonRecord) => JsonRecord[];
  createAgentRun: (input: JsonRecord) => JsonRecord | null;
  getAgentRun: (tenantId: string, agentRunId: string) => JsonRecord | null;
  updateAgentRun: (tenantId: string, agentRunId: string, patch: JsonRecord) => JsonRecord | null;
  recordCompletionReport: (input: JsonRecord) => JsonRecord | null;
}

interface ContextBuilderLike {
  build: (input: JsonRecord) => JsonRecord;
}

interface ScopeLocksLike {
  acquire: (input: JsonRecord) => JsonRecord;
  release: (tenantId: string, lockId: string) => void;
}

interface QualityGateRegistryLike {
  run: (qualityGates: string[], context: JsonRecord) => Promise<JsonRecord[]> | JsonRecord[];
}

export class HarnessRuntime {
  agentRegistry: AgentRegistryLike;
  toolExecutor: ToolExecutorLike;
  artifactStore: ArtifactStoreLike;
  runStore: RuntimeRunStoreLike;
  contextBuilder: ContextBuilderLike;
  scopeLocks: ScopeLocksLike | null;
  qualityGateRegistry: QualityGateRegistryLike | null;

  constructor({
    agentRegistry,
    toolExecutor,
    artifactStore,
    runStore,
    contextBuilder,
    scopeLocks = null,
    qualityGateRegistry = null
  }: HarnessRuntimeOptions) {
    this.agentRegistry = agentRegistry;
    this.toolExecutor = toolExecutor;
    this.artifactStore = artifactStore;
    this.runStore = runStore;
    this.contextBuilder = contextBuilder;
    this.scopeLocks = scopeLocks;
    this.qualityGateRegistry = qualityGateRegistry;
  }

  async runPlaybook(input: JsonRecord): Promise<JsonRecord> {
    const playbook = this.agentRegistry.getPlaybook(input.playbook_id);
    const agent = this.agentRegistry.getManifest(playbook.agent_id, input.agent_version);
    if (!this.agentRegistry.isEnabledForTenant(input.tenant_id, agent.agent_id)) {
      throw new Error(`agent disabled for tenant: ${agent.agent_id}`);
    }

    const workflowRun =
      input.workflow_run_id && this.runStore.getWorkflowRun(input.tenant_id, input.workflow_run_id)
        ? this.runStore.getWorkflowRun(input.tenant_id, input.workflow_run_id)
        : this.runStore.createWorkflowRun({
            tenant_id: input.tenant_id,
            created_by: input.user_id || 'system',
            source: input.source || 'api',
            goal: input.goal,
            dag: { playbook_id: playbook.playbook_id, agent_id: agent.agent_id }
          });
    if (!workflowRun) throw new Error('workflow run could not be created');

    let lock = null;
    if (input.scope_key && this.scopeLocks) {
      lock = this.scopeLocks.acquire({
        tenant_id: input.tenant_id,
        scope_key: input.scope_key,
        owner_run_id: workflowRun.id
      });
    }

    const contextPack = this.contextBuilder.build({
      tenantId: input.tenant_id,
      workspaceId: input.workspace_id || 'default',
      userId: input.user_id || 'system',
      channel: input.channel || input.source || 'api',
      workflowRunId: workflowRun.id,
      agent,
      playbook,
      goal: input.goal,
      businessContext: input.business_context || {}
    });

    const agentRun = this.runStore.createAgentRun({
      tenant_id: input.tenant_id,
      workflow_run_id: workflowRun.id,
      agent_id: agent.agent_id,
      agent_version: agent.version,
      playbook_id: playbook.playbook_id,
      input,
      context_pack: contextPack
    });
    if (!agentRun) throw new Error('agent run could not be created');

    const workflowDag: JsonRecord = {
      ...toRecord(workflowRun.dag),
      core_capability_state: {
        ...toRecord(toRecord(workflowRun.dag).core_capability_state),
        context: contextPack.core_capability_state?.context || contextPack.context_envelope
      }
    };

    this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
      dag: workflowDag,
      status: 'running',
      started_at: workflowRun.started_at || new Date().toISOString()
    });
    this.runStore.updateAgentRun(input.tenant_id, agentRun.id, {
      status: 'running',
      started_at: new Date().toISOString()
    });

    const artifacts: JsonRecord[] = [];
    const stepOutputs: JsonRecord = {};
    const completedSteps = new Set<string>();
    const feedbackHistory: JsonRecord[] = [];
    let currentStep: JsonRecord | null = null;
    let finalStatus = 'completed';

    try {
      for (const [index, rawStep] of (playbook.steps || []).entries()) {
        const step = toRecord(rawStep);
        currentStep = step;
        const stepId = String(step.id || `step_${index + 1}`);
        const controlDecision = decideNextStep({
          phase: completedSteps.size >= (playbook.steps || []).length ? 'completed' : 'running',
          plannedAction: stepId,
          dependencies: resolveStepDependencies(step, playbook.steps || [], index).map((dependencyId) => ({
            id: dependencyId,
            status: completedSteps.has(dependencyId) ? 'completed' : 'missing'
          }))
        });
        workflowDag.core_capability_state = {
          ...toRecord(workflowDag.core_capability_state),
          control: {
            ...controlDecision,
            step_id: stepId,
            completed_steps: [...completedSteps]
          }
        };
        this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
          dag: workflowDag
        });
        if (controlDecision.terminal_decision === 'blocked') {
          finalStatus = 'failed_blocked';
          break;
        }
        if (controlDecision.terminal_decision === 'stopped') {
          finalStatus = 'awaiting_human_approval';
          break;
        }

        if (step.type === 'tool') {
          this.runStore.updateAgentRun(input.tenant_id, agentRun.id, { status: 'tool_calling' });
          const result = await this.toolExecutor.execute(
            {
              tenantId: input.tenant_id,
              workspaceId: input.workspace_id || 'default',
              userId: input.user_id || 'system',
              agentId: agent.agent_id,
              workflowRunId: workflowRun.id,
              agentRunId: agentRun.id,
              playbookId: playbook.playbook_id,
              stepId: step.id
            },
            step.tool_id,
            resolveInputTemplate(step.input || {}, { input, steps: stepOutputs })
          );
          stepOutputs[step.id] = result.output ?? result;
          if (result.status === 'blocked_pending_approval') {
            finalStatus = 'awaiting_human_approval';
          }
        }

        if (step.type === 'artifact') {
          const artifact = this.artifactStore.commit({
            tenant_id: input.tenant_id,
            workflow_run_id: workflowRun.id,
            agent_run_id: agentRun.id,
            type: step.artifact_type,
            status: step.status || 'draft',
            payload: resolveInputTemplate(step.payload || {}, { input, steps: stepOutputs }),
            quality_score: step.quality_score ?? null
          });
          artifacts.push(artifact);
          stepOutputs[step.id] = artifact;
        }

        if (step.type === 'approval_checkpoint') {
          finalStatus = 'awaiting_human_approval';
        }

        completedSteps.add(stepId);
        const feedbackDecision = buildFeedbackDecision({
          goal: String(input.goal || playbook.playbook_id || 'runtime'),
          stage: stepId,
          completedStepCount: completedSteps.size,
          outputCount: Object.keys(stepOutputs).length,
          artifactCount: artifacts.length
        });
        const leadAcquisitionRunId = resolveLeadAcquisitionRunId(input.business_context);
        const persistedActions = leadAcquisitionRunId
          ? this.runStore.recordFeedbackActions?.({
              tenant_id: input.tenant_id,
              workflow_run_id: workflowRun.id,
              lead_acquisition_run_id: leadAcquisitionRunId,
              source_stage: stepId,
              recommendations: feedbackDecision.action_recommendations || []
            }) || []
          : [];
        const feedbackRecord = {
          step_id: stepId,
          ...feedbackDecision,
          persisted_actions: persistedActions
        };
        feedbackHistory.push(feedbackRecord);
        workflowDag.core_capability_state = {
          ...toRecord(workflowDag.core_capability_state),
          feedback: {
            latest: feedbackRecord,
            history: [...feedbackHistory]
          }
        };
        this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
          dag: workflowDag
        });
        if (finalStatus === 'awaiting_human_approval') {
          break;
        }
      }

      const producedArtifacts = mergeArtifacts(
        artifacts,
        this.artifactStore.listForAgentRun(input.tenant_id, agentRun.id)
      );
      let qualityResults: JsonRecord[] = [];
      const concerns: string[] = [];
      if (
        finalStatus !== 'awaiting_human_approval'
        && !String(finalStatus).startsWith('failed')
        && this.qualityGateRegistry
      ) {
        this.runStore.updateAgentRun(input.tenant_id, agentRun.id, { status: 'quality_checking' });
        qualityResults = await this.qualityGateRegistry.run(agent.quality_gates || [], {
          agent,
          playbook,
          workflowRun,
          agentRun: this.runStore.getAgentRun(input.tenant_id, agentRun.id),
          artifacts: producedArtifacts,
          stepOutputs
        });
        for (const result of qualityResults) {
          if (result.status === 'failed') concerns.push(result.message);
        }
        if (qualityResults.some((result) => result.status === 'failed')) finalStatus = 'failed_quality_gate';
        else if (qualityResults.some((result) => result.status === 'warning')) finalStatus = 'completed_with_concerns';
      }

      const completedStatus = terminalAgentStatuses.has(finalStatus) ? finalStatus : 'completed';
      const completionStatus =
        completedStatus === 'awaiting_human_approval'
          ? 'blocked_waiting_approval'
          : completedStatus === 'failed_blocked'
            ? 'blocked_missing_context'
          : completedStatus === 'failed_policy_denied'
            ? 'failed_policy'
            : completedStatus;
      this.runStore.recordCompletionReport({
        tenant_id: input.tenant_id,
        workflow_run_id: workflowRun.id,
        agent_run_id: agentRun.id,
        playbook_id: playbook.playbook_id,
        status: completionStatus,
        summary: buildOutputSummary(completedStatus, producedArtifacts),
        required_artifacts: playbook.required_artifacts || [],
        produced_artifacts: producedArtifacts.map((artifact) => artifact.type),
        quality_results: qualityResults,
        concerns
      });
      this.runStore.updateAgentRun(input.tenant_id, agentRun.id, {
        status: completedStatus,
        output_summary: buildOutputSummary(completedStatus, producedArtifacts),
        finished_at: completedStatus === 'awaiting_human_approval' ? null : new Date().toISOString()
      });
      this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
        dag: workflowDag,
        status:
          completedStatus === 'awaiting_human_approval'
            ? 'awaiting_human_approval'
            : completedStatus === 'failed_quality_gate' || String(completedStatus).startsWith('failed')
              ? 'failed'
              : 'completed',
        finished_at: completedStatus === 'awaiting_human_approval' ? null : new Date().toISOString()
      });

      return {
        workflow_run: this.runStore.getWorkflowRun(input.tenant_id, workflowRun.id),
        agent_run: this.runStore.getAgentRun(input.tenant_id, agentRun.id),
        artifacts: producedArtifacts,
        step_outputs: stepOutputs
      };
    } catch (error: any) {
      const errorRecord = {
        name: error?.name,
        code: error?.code,
        message: error?.message
      };
      const failureType = classifyFailure(errorRecord);
      const recoveryDecision = recoverFromFailure({
        phase: String(currentStep?.id || 'playbook_execution'),
        stepId: String(currentStep?.id || 'playbook_execution'),
        attempt: 1,
        maxRetries: Number(currentStep?.max_retries ?? 1),
        error: errorRecord
      });
      workflowDag.core_capability_state = {
        ...toRecord(workflowDag.core_capability_state),
        recovery: {
          ...recoveryDecision,
          failure_type: failureType,
          error: errorRecord
        }
      };
      this.runStore.updateAgentRun(input.tenant_id, agentRun.id, {
        status: error.name === 'PolicyError' ? 'failed_policy_denied' : 'failed_blocked',
        error: { name: error.name, message: error.message },
        finished_at: new Date().toISOString()
      });
      this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
        dag: workflowDag,
        status: 'failed',
        finished_at: new Date().toISOString()
      });
      throw error;
    } finally {
      if (lock) this.scopeLocks.release(input.tenant_id, lock.id);
    }
  }
}

function mergeArtifacts(primary: JsonRecord[], secondary: JsonRecord[]): JsonRecord[] {
  const merged = new Map();
  for (const artifact of [...primary, ...secondary]) {
    if (artifact?.id) merged.set(artifact.id, artifact);
  }
  return [...merged.values()];
}

function buildOutputSummary(status: string, artifacts: JsonRecord[]): string {
  if (status === 'awaiting_human_approval') return 'Run paused for human approval.';
  return `Run completed with ${artifacts.length} artifact(s).`;
}

function toRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function resolveStepDependencies(step: JsonRecord, steps: unknown[], index: number): string[] {
  if (Array.isArray(step.depends_on) && step.depends_on.length > 0) {
    return step.depends_on.map((dependency) => String(dependency)).filter(Boolean);
  }

  return steps
    .slice(0, index)
    .map((candidate) => String(toRecord(candidate).id || ''))
    .filter(Boolean);
}

function buildFeedbackDecision(input: {
  goal: string;
  stage: string;
  completedStepCount: number;
  outputCount: number;
  artifactCount: number;
}): JsonRecord {
  return verifyAndTune({
    goal: input.goal,
    stage: input.stage,
    receipt: {
      contacted_leads: Math.max(input.completedStepCount, 1),
      replied_leads: Math.min(input.outputCount, Math.max(input.completedStepCount, 1)),
      booked_calls: Math.min(input.artifactCount, Math.max(input.completedStepCount, 1)),
      bounce_rate: 0
    },
    thresholds: DEFAULT_FEEDBACK_THRESHOLDS
  });
}

function resolveLeadAcquisitionRunId(businessContext: unknown): string | null {
  const context = toRecord(businessContext);
  const rawRunId =
    context.lead_acquisition_run_id
    || context.leadAcquisitionRunId
    || context.run_id
    || context.runId;
  return typeof rawRunId === 'string' && rawRunId.trim() ? rawRunId.trim() : null;
}
