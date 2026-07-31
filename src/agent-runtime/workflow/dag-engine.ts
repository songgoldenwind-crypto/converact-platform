import { resolveInputTemplate, readPath } from './template.js';
import { buildSessionPolicy } from '../context/session-isolation.js';
import type { JsonRecord } from '../integrations/provider-runtime-types.js';

const TERMINAL_NODE_STATUSES = new Set(['completed', 'failed_terminal', 'skipped', 'cancelled']);

interface DagEngineOptions {
  runStore: DagRunStore;
  toolExecutor: ToolExecutorLike;
  artifactStore: ArtifactStoreLike;
  playbookRunner?: PlaybookRunnerLike | null;
}

interface DagRunStore {
  createWorkflowRun: (input: JsonRecord) => JsonRecord | null;
  updateWorkflowRun: (tenantId: string, workflowRunId: string, patch: JsonRecord) => JsonRecord | null;
  getWorkflowRun: (tenantId: string, workflowRunId: string) => JsonRecord | null;
  persistDag: (input: JsonRecord) => void;
  getDagGraph: (tenantId: string, workflowRunId: string) => JsonRecord;
  getDagNode: (tenantId: string, workflowRunId: string, nodeId: string) => JsonRecord;
  updateDagNode: (tenantId: string, workflowRunId: string, nodeId: string, patch: JsonRecord) => JsonRecord | null;
  ensureAgentSession: (input: JsonRecord) => JsonRecord | null;
}

interface ToolExecutorLike {
  execute: (context: JsonRecord, toolId: string, input: JsonRecord) => Promise<JsonRecord> | JsonRecord;
  resumeApproved: (context: JsonRecord, toolCallId: string) => Promise<JsonRecord> | JsonRecord;
}

interface ArtifactStoreLike {
  commit: (input: JsonRecord) => JsonRecord | null;
}

type PlaybookRunnerLike = (input: JsonRecord) => Promise<JsonRecord> | JsonRecord;

export class DagEngine {
  runStore: DagRunStore;
  toolExecutor: ToolExecutorLike;
  artifactStore: ArtifactStoreLike;
  playbookRunner: PlaybookRunnerLike | null;

  constructor({ runStore, toolExecutor, artifactStore, playbookRunner = null }: DagEngineOptions) {
    this.runStore = runStore;
    this.toolExecutor = toolExecutor;
    this.artifactStore = artifactStore;
    this.playbookRunner = playbookRunner;
  }

  async run(input: JsonRecord): Promise<JsonRecord> {
    const dag = validateDag(input.dag);
    const workflowRun =
      input.workflow_run_id && this.runStore.getWorkflowRun(input.tenant_id, input.workflow_run_id)
        ? this.runStore.updateWorkflowRun(input.tenant_id, input.workflow_run_id, { dag, status: 'running' })
        : this.runStore.createWorkflowRun({
            tenant_id: input.tenant_id,
            created_by: input.user_id || 'system',
            source: input.source || 'dag',
            goal: input.goal,
             dag
           });
    if (!workflowRun) throw new Error('workflow run could not be created');

    this.runStore.persistDag({
      tenant_id: input.tenant_id,
      workflow_run_id: workflowRun.id,
      nodes: dag.nodes,
      edges: dag.edges
    });
    const sessionPolicy = buildSessionPolicy({
      tenantId: input.tenant_id,
      workspaceId: input.workspace_id || 'default',
      channel: input.channel || input.source || 'api',
      userId: input.user_id || 'system',
      agentId: input.agent_id || 'orchestration_agent',
      workflowRunId: workflowRun.id,
      businessContext: input.business_context || {}
    });
    this.runStore.ensureAgentSession({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      session_key: sessionPolicy.sessionKey,
      channel: sessionPolicy.channel,
      sandbox_scope: sessionPolicy.sandboxScope,
      dm_scope: sessionPolicy.dmScope,
      business_object_type: sessionPolicy.businessObjectType,
      business_object_id: sessionPolicy.businessObjectId,
      agent_id: input.agent_id || 'orchestration_agent'
    });
    this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
      status: 'running',
      started_at: workflowRun.started_at || new Date().toISOString()
    });

    while (true) {
      const graph = this.runStore.getDagGraph(input.tenant_id, workflowRun.id);
      const waitingNode = graph.nodes.find((node) => node.status === 'waiting_approval');
      if (waitingNode) {
        this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, { status: 'awaiting_human_approval' });
        return this.result(input.tenant_id, workflowRun.id);
      }

      this.skipUnreachableNodes(input.tenant_id, workflowRun.id, graph);
      const refreshed = this.runStore.getDagGraph(input.tenant_id, workflowRun.id);
      const readyNodes = this.readyNodes(refreshed);

      if (!readyNodes.length) {
        const terminalDecision = this.terminalDecision(refreshed);
        if (terminalDecision) {
          this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
            status: terminalDecision,
            finished_at: new Date().toISOString()
          });
          return this.result(input.tenant_id, workflowRun.id);
        }

        const nodes = refreshed.nodes;
        const blocked = nodes.find((node) => node.status === 'failed_retryable' && node.attempts >= node.max_attempts);
        if (blocked) {
          this.runStore.updateDagNode(input.tenant_id, workflowRun.id, blocked.node_id, {
            status: 'failed_terminal',
            finished_at: new Date().toISOString()
          });
          continue;
        }

        this.runStore.updateWorkflowRun(input.tenant_id, workflowRun.id, {
          status: 'failed',
          finished_at: new Date().toISOString()
        });
        return this.result(input.tenant_id, workflowRun.id);
      }

      await Promise.all(readyNodes.map((node) => this.executeNode(input, workflowRun.id, node)));
    }
  }

  async resumeAfterApproval(input: JsonRecord): Promise<JsonRecord> {
    const workflowRun = this.runStore.getWorkflowRun(input.tenant_id, input.workflow_run_id);
    if (!workflowRun) throw new Error(`workflow run not found: ${input.workflow_run_id}`);

    const graph = this.runStore.getDagGraph(input.tenant_id, input.workflow_run_id);
    const waitingNodes = graph.nodes.filter((node) => node.status === 'waiting_approval');
    const node = input.node_id
      ? waitingNodes.find((candidate) => candidate.node_id === input.node_id)
      : waitingNodes.find((candidate) => {
          if (!input.approval_request_id) return waitingNodes.length === 1;
          return candidate.output?.approval_request?.id === input.approval_request_id;
        });
    if (!node) throw new Error('no matching DAG node is waiting for approval');

    const approvalRequest = node.output?.approval_request;
    if (!approvalRequest?.tool_call_id) throw new Error(`waiting node has no resumable tool call: ${node.node_id}`);
    const definition = node.definition || {};
    const resumed = await this.toolExecutor.resumeApproved(
      {
        tenantId: input.tenant_id,
        workspaceId: input.workspace_id || 'default',
        userId: input.user_id || 'system',
        agentId: definition.agent_id || input.agent_id || 'orchestration_agent',
        workflowRunId: input.workflow_run_id,
        agentRunId: null,
        playbookId: `dag:${input.workflow_run_id}`,
        stepId: node.node_id
      },
      approvalRequest.tool_call_id
    );

    this.runStore.updateDagNode(input.tenant_id, input.workflow_run_id, node.node_id, {
      status: 'completed',
      output: resumed.output,
      finished_at: new Date().toISOString()
    });

    return this.run({
      tenant_id: input.tenant_id,
      workspace_id: input.workspace_id || 'default',
      user_id: input.user_id || 'system',
      agent_id: input.agent_id || definition.agent_id || 'orchestration_agent',
      workflow_run_id: input.workflow_run_id,
      source: input.source || 'dag_resume',
      goal: input.goal || workflowRun.goal,
      dag: workflowRun.dag || { nodes: [], edges: [] },
      business_context: input.business_context || {}
    });
  }

  result(tenantId: string, workflowRunId: string): JsonRecord {
    const graph = this.runStore.getDagGraph(tenantId, workflowRunId);
    return {
      workflow_run: this.runStore.getWorkflowRun(tenantId, workflowRunId),
      dag_nodes: graph.nodes,
      dag_edges: graph.edges,
      node_outputs: Object.fromEntries(graph.nodes.map((node) => [node.node_id, node.output]))
    };
  }

  readyNodes(graph: JsonRecord): JsonRecord[] {
    return graph.nodes.filter((node) => {
      if (!['pending', 'failed_retryable'].includes(node.status)) return false;
      if (node.status === 'failed_retryable' && node.attempts >= node.max_attempts) return false;
      const incoming = graph.edges.filter((edge) => edge.to_node_id === node.node_id);
      if (!incoming.length) return true;
      return this.dependenciesSatisfied(graph, node, incoming);
    });
  }

  skipUnreachableNodes(tenantId: string, workflowRunId: string, graph: JsonRecord): void {
    for (const node of graph.nodes) {
      if (node.status !== 'pending') continue;
      const incoming = graph.edges.filter((edge) => edge.to_node_id === node.node_id);
      if (!incoming.length) continue;
      const parents = incoming.map((edge) => graph.nodes.find((candidate) => candidate.node_id === edge.from_node_id));
      if (!parents.every((parent) => parent && TERMINAL_NODE_STATUSES.has(parent.status))) continue;
      if (this.dependenciesSatisfied(graph, node, incoming)) continue;
      this.runStore.updateDagNode(tenantId, workflowRunId, node.node_id, {
        status: 'skipped',
        finished_at: new Date().toISOString()
      });
    }
  }

  dependenciesSatisfied(graph: JsonRecord, node: JsonRecord, incoming: JsonRecord[]): boolean {
    const satisfied = incoming.map((edge) => {
      const parent = graph.nodes.find((candidate) => candidate.node_id === edge.from_node_id);
      return Boolean(parent && this.edgeSatisfied(edge, parent));
    });
    if (this.dependencyMode(node) === 'any') return satisfied.some(Boolean);
    return satisfied.every(Boolean);
  }

  dependencyMode(node: JsonRecord): 'all' | 'any' {
    return node.definition?.dependency_mode === 'any' ? 'any' : 'all';
  }

  terminalDecision(graph: JsonRecord): 'completed' | 'failed' | null {
    if (!graph.nodes.every((node) => TERMINAL_NODE_STATUSES.has(node.status))) return null;
    return graph.nodes.some((node) => node.status === 'failed_terminal') ? 'failed' : 'completed';
  }

  edgeSatisfied(edge: JsonRecord, parent: JsonRecord): boolean {
    if (edge.condition === 'always') return TERMINAL_NODE_STATUSES.has(parent.status);
    if (edge.condition === 'success' && parent.status !== 'completed') return false;
    if (edge.condition === 'failure' && parent.status !== 'failed_terminal') return false;
    if (edge.condition === 'approval_required' && parent.status !== 'waiting_approval') return false;
    if (Object.hasOwn(edge.metadata || {}, 'when')) return parent.output?.result === edge.metadata.when;
    return true;
  }

  async executeNode(input: JsonRecord, workflowRunId: string, node: JsonRecord): Promise<void> {
    const startedAt = new Date().toISOString();
    this.runStore.updateDagNode(input.tenant_id, workflowRunId, node.node_id, {
      status: 'running',
      attempts: node.attempts + 1,
      started_at: node.started_at || startedAt,
      error: null
    });

    const graph = this.runStore.getDagGraph(input.tenant_id, workflowRunId);
    const nodeOutputs = Object.fromEntries(graph.nodes.map((item) => [item.node_id, item.output]));
    const definition = node.definition;
    const resolvedInput = resolveInputTemplate(definition.input || {}, { input, nodes: nodeOutputs, steps: nodeOutputs });

    try {
      const output = await this.executeByType(input, workflowRunId, node, definition, resolvedInput);
      if (output?.status === 'blocked_pending_approval') {
        this.runStore.updateDagNode(input.tenant_id, workflowRunId, node.node_id, {
          status: 'waiting_approval',
          output,
          finished_at: null
        });
        return;
      }
      this.runStore.updateDagNode(input.tenant_id, workflowRunId, node.node_id, {
        status: 'completed',
        output,
        finished_at: new Date().toISOString()
      });
    } catch (error: any) {
      const latest = this.runStore.getDagNode(input.tenant_id, workflowRunId, node.node_id);
      const retryable = latest.attempts < latest.max_attempts;
      this.runStore.updateDagNode(input.tenant_id, workflowRunId, node.node_id, {
        status: retryable ? 'failed_retryable' : 'failed_terminal',
        error: { name: error.name, message: error.message },
        finished_at: retryable ? null : new Date().toISOString()
      });
    }
  }

  async executeByType(
    input: JsonRecord,
    workflowRunId: string,
    node: JsonRecord,
    definition: JsonRecord,
    resolvedInput: JsonRecord
  ): Promise<JsonRecord | null> {
    if (node.node_type === 'tool') {
      const result = await this.toolExecutor.execute(
        {
          tenantId: input.tenant_id,
          workspaceId: input.workspace_id || 'default',
          userId: input.user_id || 'system',
          agentId: definition.agent_id || input.agent_id || 'orchestration_agent',
          workflowRunId,
          agentRunId: null,
          playbookId: `dag:${workflowRunId}`,
          stepId: node.node_id
        },
        definition.tool_id,
        resolvedInput
      );
      return result.output ?? result;
    }

    if (node.node_type === 'artifact') {
      return this.artifactStore.commit({
        tenant_id: input.tenant_id,
        workflow_run_id: workflowRunId,
        agent_run_id: null,
        type: definition.artifact_type,
        status: definition.status || 'draft',
        payload: resolvedInput.payload ?? resolvedInput,
        quality_score: definition.quality_score ?? null
      });
    }

    if (node.node_type === 'condition') {
      const value = readConditionValue(definition.condition, input, resolvedInput);
      return {
        result: evaluateCondition(definition.condition || {}, value),
        value
      };
    }

    if (node.node_type === 'playbook') {
      if (!this.playbookRunner) throw new Error('playbook node requires a playbookRunner');
      return this.playbookRunner({
        ...resolvedInput,
        tenant_id: input.tenant_id,
        workspace_id: input.workspace_id || 'default',
        user_id: input.user_id || 'system',
        workflow_run_id: workflowRunId,
        playbook_id: definition.playbook_id,
        goal: resolvedInput.goal || input.goal
      });
    }

    throw new Error(`unsupported dag node type: ${node.node_type}`);
  }
}

function validateDag(dag: JsonRecord): JsonRecord {
  if (!dag || typeof dag !== 'object') throw new Error('dag is required');
  if (!Array.isArray(dag.nodes) || !dag.nodes.length) throw new Error('dag.nodes cannot be empty');
  const nodeIds = new Set();
  for (const node of dag.nodes) {
    if (!node.id) throw new Error('dag node id is required');
    if (!['tool', 'artifact', 'condition', 'playbook'].includes(node.type)) throw new Error(`unsupported dag node type: ${node.type}`);
    if (nodeIds.has(node.id)) throw new Error(`duplicate dag node id: ${node.id}`);
    nodeIds.add(node.id);
    if (node.type === 'tool' && !node.tool_id) throw new Error(`tool_id is required for node: ${node.id}`);
    if (node.type === 'artifact' && !node.artifact_type) throw new Error(`artifact_type is required for node: ${node.id}`);
    if (node.type === 'playbook' && !node.playbook_id) throw new Error(`playbook_id is required for node: ${node.id}`);
  }
  const edges = dag.edges || [];
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) throw new Error(`edge.from not found: ${edge.from}`);
    if (!nodeIds.has(edge.to)) throw new Error(`edge.to not found: ${edge.to}`);
  }
  assertAcyclic(dag.nodes, edges);
  return { nodes: dag.nodes, edges };
}

function assertAcyclic(nodes: JsonRecord[], edges: JsonRecord[]): void {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId);
  let visited = 0;
  while (queue.length) {
    const nodeId = queue.shift();
    visited += 1;
    for (const next of outgoing.get(nodeId)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) throw new Error('dag must be acyclic');
}

function readConditionValue(condition: JsonRecord = {}, input: JsonRecord, resolvedInput: JsonRecord): unknown {
  if (condition.path) {
    if (condition.path.startsWith('$input.')) return readPath(input, condition.path.slice('$input.'.length));
    if (condition.path.startsWith('$value.')) return readPath(resolvedInput, condition.path.slice('$value.'.length));
  }
  return resolvedInput.value;
}

function evaluateCondition(condition: JsonRecord, value: unknown): boolean {
  if (Object.hasOwn(condition, 'equals')) return value === condition.equals;
  if (Object.hasOwn(condition, 'not_equals')) return value !== condition.not_equals;
  if (condition.exists) return value !== undefined && value !== null && value !== '';
  return Boolean(value);
}
