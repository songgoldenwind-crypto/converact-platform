import type { JsonRecord } from '../integrations/provider-runtime-types.js';

interface CommanderServiceOptions {
  playbookRouter: PlaybookRouterLike;
  runtime: RuntimeLike;
  dagEngine?: DagEngineLike | null;
  toolRegistry?: ToolRegistryLike | null;
  modelGateway?: ModelGatewayLike | null;
}

interface PlaybookRouterLike {
  agentRegistry: { getPlaybook: (playbookId: string) => JsonRecord };
  route: (input: JsonRecord) => JsonRecord;
}

interface RuntimeLike {
  runPlaybook: (input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface DagEngineLike {
  run: (input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

interface ToolRegistryLike {
  get: (toolId: string) => { definition: JsonRecord };
}

interface ModelGatewayLike {
  complete: (context: JsonRecord, request: JsonRecord) => Promise<JsonRecord> | JsonRecord;
}

export class CommanderService {
  playbookRouter: PlaybookRouterLike;
  runtime: RuntimeLike;
  dagEngine: DagEngineLike | null;
  toolRegistry: ToolRegistryLike | null;
  modelGateway: ModelGatewayLike | null;

  constructor({ playbookRouter, runtime, dagEngine = null, toolRegistry = null, modelGateway = null }: CommanderServiceOptions) {
    this.playbookRouter = playbookRouter;
    this.runtime = runtime;
    this.dagEngine = dagEngine;
    this.toolRegistry = toolRegistry;
    this.modelGateway = modelGateway;
  }

  route(input: JsonRecord): JsonRecord {
    const playbook = this.playbookRouter.route({
      intent: input.intent || '',
      goal: input.goal || '',
      preferred_agent_id: input.preferred_agent_id || null
    });
    return {
      playbook_id: playbook.playbook_id,
      agent_id: playbook.agent_id,
      required_inputs: playbook.required_inputs || [],
      missing_inputs: missingInputs(['tenant_id', ...(playbook.required_inputs || [])], input),
      intent: inferIntent(playbook),
      approval_points: approvalPoints(playbook, this.toolRegistry),
      risk_summary: riskSummary(playbook, this.toolRegistry)
    };
  }

  async plan(input: JsonRecord): Promise<JsonRecord> {
    const route = this.route(input);
    const playbook = this.playbookRouter.agentRegistry.getPlaybook(route.playbook_id);
    const dag = buildDagFromPlaybook(playbook);
    const basePlan: JsonRecord = {
      status: route.missing_inputs.length ? 'blocked_missing_context' : 'planned',
      goal: input.goal || '',
      route,
      dag,
      expected_artifacts: playbook.required_artifacts || [],
      approval_points: route.approval_points,
      risk_summary: route.risk_summary,
      next_required_action: route.missing_inputs.length ? `补充字段：${route.missing_inputs.join(', ')}` : 'review_or_execute'
    };

    if (!route.missing_inputs.length && this.modelGateway) {
      const modelResult = await this.modelGateway.complete(
        {
          tenantId: input.tenant_id,
          workspaceId: input.workspace_id || 'default',
          userId: input.user_id || 'system',
          agentId: 'orchestration_agent',
          workflowRunId: null,
          agentRunId: null
        },
        {
          provider: 'tenant_default',
          fallback_provider: 'dry_run',
          purpose: 'commander_plan',
          messages: [
            { role: 'system', content: 'Create a concise execution plan for a Converact agent workflow.' },
            { role: 'user', content: JSON.stringify({ goal: input.goal, playbook_id: playbook.playbook_id, dag }) }
          ]
        }
      );
      basePlan.plan_summary = modelResult.output.content;
      basePlan.model_call_id = modelResult.model_call.id;
    }

    return basePlan;
  }

  async run(input: JsonRecord): Promise<JsonRecord> {
    const plan = await this.plan(input);
    if (plan.route.missing_inputs.length) {
      return {
        status: 'blocked_missing_context',
        route: plan.route,
        plan,
        missing_inputs: plan.route.missing_inputs,
        next_required_action: plan.next_required_action
      };
    }

    if (input.execution_mode === 'dag' || input.use_dag) {
      if (!this.dagEngine) throw new Error('dag engine is not configured');
      const result = await this.dagEngine.run({
        ...input,
        source: input.source || 'commander',
        dag: plan.dag,
        agent_id: plan.route.agent_id
      });
      return {
        status: result.workflow_run.status,
        route: plan.route,
        plan,
        workflow_run: result.workflow_run,
        dag_nodes: result.dag_nodes,
        dag_edges: result.dag_edges,
        node_outputs: result.node_outputs
      };
    }

    const result = await this.runtime.runPlaybook({
      ...input,
      playbook_id: plan.route.playbook_id,
      source: input.source || 'commander'
    });
    return {
      status: result.agent_run.status,
      route: plan.route,
      plan,
      workflow_run: result.workflow_run,
      agent_run: result.agent_run,
      artifacts: result.artifacts,
      step_outputs: result.step_outputs
    };
  }
}

function missingInputs(requiredInputs: string[], input: JsonRecord): string[] {
  return requiredInputs.filter((path) => readPath(input, path) === undefined || readPath(input, path) === null || readPath(input, path) === '');
}

function readPath(object: JsonRecord, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (cursor, part) => (cursor && typeof cursor === 'object' ? (cursor as JsonRecord)[part] : undefined),
    object
  );
}

function inferIntent(playbook: JsonRecord): string {
  return playbook.trigger_intents?.[0] || playbook.playbook_id;
}

function approvalPoints(playbook: JsonRecord, toolRegistry: ToolRegistryLike | null): JsonRecord[] {
  return (playbook.steps || [])
    .filter((step) => step.type === 'tool')
    .map((step) => {
      const tool = safeTool(toolRegistry, step.tool_id);
      return tool?.approval_required || tool?.risk_level === 'R3'
        ? {
            step_id: step.id,
            tool_id: step.tool_id,
            risk_level: tool.risk_level,
            reason: `${step.tool_id} requires human approval`
          }
        : null;
    })
    .filter(Boolean);
}

function riskSummary(playbook: JsonRecord, toolRegistry: ToolRegistryLike | null): JsonRecord {
  const tools = (playbook.steps || []).filter((step) => step.type === 'tool').map((step) => safeTool(toolRegistry, step.tool_id));
  const riskLevels = tools.filter(Boolean).map((tool) => tool.risk_level);
  return {
    max_risk_level: riskLevels.sort().at(-1) || 'R0',
    external_actions: tools.filter((tool) => tool?.category === 'external_action').map((tool) => tool.tool_id),
    approval_required: tools.some((tool) => tool?.approval_required)
  };
}

function safeTool(toolRegistry: ToolRegistryLike | null, toolId: string): JsonRecord | null {
  if (!toolRegistry) return null;
  return toolRegistry.get(toolId).definition;
}

function buildDagFromPlaybook(playbook: JsonRecord): JsonRecord {
  const supportedSteps = (playbook.steps || []).filter((step) => ['tool', 'artifact'].includes(step.type));
  return {
    playbook_id: playbook.playbook_id,
    agent_id: playbook.agent_id,
    nodes: supportedSteps.map((step) => {
      if (step.type === 'tool') {
        return {
          id: step.id,
          type: 'tool',
          agent_id: playbook.agent_id,
          tool_id: step.tool_id,
          input: step.input || {},
          max_attempts: step.retry_policy?.max_attempts || 1
        };
      }
      return {
        id: step.id,
        type: 'artifact',
        artifact_type: step.artifact_type,
        status: step.status || 'draft',
        input: {
          payload: step.payload || {}
        }
      };
    }),
    edges: supportedSteps.slice(1).map((step, index) => ({
      from: supportedSteps[index].id,
      to: step.id,
      condition: 'success'
    }))
  };
}
