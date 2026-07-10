export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export type ToolCategory =
  | 'read'
  | 'draft'
  | 'internal_write'
  | 'external_action'
  | 'financial_action'
  | 'admin_action';

export type ToolInput = Record<string, unknown>;
export type ToolOutput = any;
export type ToolCallStatus = 'created' | 'running' | 'success' | 'failed' | 'blocked_pending_approval' | string;
export type ApprovalDecision = 'allow' | 'deny' | 'approval_required';
export type ArtifactReviewDecision = 'approve' | 'reject' | 'publish' | 'archive' | 'request_changes' | string;

export interface ToolDefinition {
  tool_id: string;
  display_name: string;
  toolset: string;
  category: ToolCategory;
  risk_level: RiskLevel;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  side_effect: boolean;
  idempotency_required: boolean;
  approval_required: boolean;
  /** Domain command creates its own approval_request; skip harness-level block. */
  domain_approval_handler?: boolean;
  allowed_agents: string[];
  forbidden_agents?: string[];
  tenant_scope_required: boolean;
  audit_event_name: string;
  required_scopes?: string[];
  object_scope_required?: boolean;
  timeout_ms?: number;
  retry_policy?: { max_attempts?: number };
  rate_limit_policy?: Record<string, unknown>;
  /** Compensation strategy for irreversible external actions (R3 side-effect tools).
   * Read by SideEffectTracker when recording committed actions. */
  compensation?: Record<string, unknown>;
}

export interface ToolExecutionContext {
  tenantId: string;
  agentId: string;
  workflowRunId?: string | null;
  agentRunId?: string | null;
  stepId?: string | null;
  userId?: string;
  [key: string]: unknown;
}

export type ToolHandler = (input: ToolInput, context: ToolExecutionContext) => Promise<ToolOutput> | ToolOutput;

export interface ToolRegistryEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface ToolRegistryLike {
  get: (toolId: string) => ToolRegistryEntry;
}

export interface ApprovalEvaluation {
  decision: ApprovalDecision;
  reason: string;
}

export interface ApprovalPolicyLike {
  evaluate: (input: { context: ToolExecutionContext; tool: ToolDefinition; input: ToolInput }) => ApprovalEvaluation;
  assertAllowed: (evaluation: ApprovalEvaluation) => void;
}

export interface ApprovalRequestRecord {
  id: string;
  tenant_id: string;
  workflow_run_id: string | null;
  agent_run_id: string | null;
  tool_call_id: string | null;
  action_type: string;
  risk_level: RiskLevel;
  reason: string;
  payload: ToolInput;
  status: string;
  requested_by?: string;
  decided_by?: string | null;
  decided_at?: string | null;
}

export interface ApprovalRequestInput {
  tenant_id: string;
  workflow_run_id?: string | null;
  agent_run_id?: string | null;
  tool_call_id?: string | null;
  action_type: string;
  risk_level: RiskLevel;
  reason?: string;
  payload?: ToolInput;
  requested_by?: string;
}

export interface ApprovalQueueLike {
  request: (input: ApprovalRequestInput) => ApprovalRequestRecord;
  get: (tenantId: string, approvalRequestId: string) => ApprovalRequestRecord | null;
}

export interface ToolCallRecord {
  id: string;
  tenant_id: string;
  workflow_run_id: string | null;
  agent_run_id: string | null;
  tool_id: string;
  status: ToolCallStatus;
  risk_level: RiskLevel;
  approval_request_id: string | null;
  input: ToolInput;
  output?: ToolOutput;
  error?: { message?: string; name?: string } | null;
  idempotency_key: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface ToolRunStoreLike {
  recordToolCall: (input: {
    id?: string;
    tenant_id: string;
    workflow_run_id?: string | null;
    agent_run_id?: string | null;
    tool_id: string;
    risk_level: RiskLevel;
    status?: ToolCallStatus;
    input?: ToolInput;
    output?: ToolOutput;
    error?: Record<string, unknown> | null;
    approval_request_id?: string | null;
    idempotency_key?: string;
    started_at?: string | null;
    finished_at?: string | null;
  }) => ToolCallRecord;
  updateToolCall: (
    tenantId: string,
    toolCallId: string,
    patch: Record<string, unknown>
  ) => ToolCallRecord;
  getToolCall: (tenantId: string, toolCallId: string) => ToolCallRecord | null;
  audit: (
    tenantId: string,
    action: string,
    objectType: string,
    objectId: string,
    metadata?: Record<string, unknown>,
    actorId?: string
  ) => void;
}

export interface ToolSuccessResult {
  status: 'success';
  output: ToolOutput;
  tool_call: ToolCallRecord;
  approval_request?: ApprovalRequestRecord | null;
}

export interface ToolBlockedResult {
  status: 'blocked_pending_approval';
  approval_request: ApprovalRequestRecord;
  output?: ToolOutput;
  tool_call?: ToolCallRecord;
}

export type ToolExecutionResult = ToolSuccessResult | ToolBlockedResult;

export interface AgentLikeForToolFiltering {
  allowed_toolsets?: string[];
  forbidden_tools?: string[];
}

export interface AuditStoreLike {
  audit?: (
    tenantId: string,
    action: string,
    objectType: string,
    objectId: string,
    metadata?: Record<string, unknown>,
    actorId?: string
  ) => void;
}

export interface ArtifactRecord {
  id: string;
  tenant_id: string;
  workflow_run_id: string | null;
  agent_run_id: string | null;
  type: string;
  status: string;
  version: number;
  payload: Record<string, unknown>;
  quality_score: number | null;
  parent_artifact_id: string | null;
}

export interface ArtifactReviewRecord {
  id: string;
  tenant_id: string;
  artifact_id: string;
  decision: string;
  from_status: string;
  to_status: string;
  review_notes: string;
  metadata: Record<string, unknown>;
  created_by: string;
}

export interface ArtifactCommitInput {
  tenant_id: string;
  workflow_run_id?: string | null;
  agent_run_id?: string | null;
  type: string;
  status?: string;
  version?: number;
  payload?: Record<string, unknown>;
  quality_score?: number | null;
  parent_artifact_id?: string | null;
}

export interface ArtifactListInput {
  tenant_id: string;
  status?: string;
  type?: string;
  workflow_run_id?: string | null;
  agent_run_id?: string | null;
  parent_artifact_id?: string | null;
  limit?: number;
}

export interface ArtifactReviewInput {
  tenant_id: string;
  artifact_id: string;
  decision: ArtifactReviewDecision;
  to_status?: string | null;
  review_notes?: string;
  metadata?: Record<string, unknown>;
  actor_id?: string;
}
