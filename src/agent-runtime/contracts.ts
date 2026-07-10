import type { JsonRecord } from './integrations/provider-runtime-types.js';

export const RISK_LEVELS = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];
export const TOOL_CATEGORIES = ['read', 'draft', 'internal_write', 'external_action', 'financial_action', 'admin_action'];

export const terminalAgentStatuses = new Set([
  'completed',
  'completed_with_concerns',
  'awaiting_user_input',
  'awaiting_human_approval',
  'failed_retryable',
  'failed_blocked',
  'failed_policy_denied',
  'failed_quota_exceeded',
  'failed_quality_gate',
  'cancelled',
  'expired'
]);

interface RuntimeValidationError extends Error {
  status: number;
}

export function validateAgentManifest(manifest: JsonRecord): Readonly<JsonRecord> {
  requireFields(manifest, ['agent_id', 'name', 'version', 'allowed_toolsets', 'outputs']);
  assertArray(manifest.allowed_toolsets, 'allowed_toolsets');
  assertArray(manifest.outputs.artifacts, 'outputs.artifacts');
  if (manifest.forbidden_tools) assertArray(manifest.forbidden_tools, 'forbidden_tools');
  if (manifest.quality_gates) assertArray(manifest.quality_gates, 'quality_gates');
  return freezeClone({
    description: '',
    forbidden_tools: [],
    activation: {
      standalone: true,
      commander_callable: true,
      cron_callable: false,
      event_callable: false
    },
    memory_scope: { read: [], write: [] },
    quality_gates: [],
    human_approval: { required_for: [] },
    ...manifest
  });
}

export function validateAgentPlaybook(playbook: JsonRecord): Readonly<JsonRecord> {
  requireFields(playbook, [
    'playbook_id',
    'agent_id',
    'version',
    'name',
    'trigger_intents',
    'steps',
    'required_artifacts',
    'completion_protocol'
  ]);
  assertArray(playbook.trigger_intents, 'trigger_intents');
  assertArray(playbook.steps, 'steps');
  assertArray(playbook.required_artifacts, 'required_artifacts');
  if (!playbook.steps.length) throw validationError('playbook.steps cannot be empty');
  for (const step of playbook.steps) {
    requireFields(step, ['id', 'type']);
    if (!['tool', 'artifact', 'quality_gate', 'approval_checkpoint', 'memory_note'].includes(step.type)) {
      throw validationError(`unsupported playbook step type: ${step.type}`);
    }
    if (step.type === 'tool') requireFields(step, ['tool_id']);
  }
  return freezeClone({
    description: '',
    required_inputs: [],
    allowed_toolsets: [],
    forbidden_toolsets: [],
    quality_gates: [],
    telemetry_events: [],
    ...playbook
  });
}

export function validateToolDefinition(definition: JsonRecord): Readonly<JsonRecord> {
  requireFields(definition, [
    'tool_id',
    'display_name',
    'toolset',
    'category',
    'risk_level',
    'input_schema',
    'output_schema',
    'side_effect',
    'idempotency_required',
    'approval_required',
    'allowed_agents',
    'tenant_scope_required',
    'audit_event_name'
  ]);
  if (!TOOL_CATEGORIES.includes(definition.category)) throw validationError(`invalid tool category: ${definition.category}`);
  if (!RISK_LEVELS.includes(definition.risk_level)) throw validationError(`invalid risk level: ${definition.risk_level}`);
  assertArray(definition.allowed_agents, 'allowed_agents');
  if (!definition.allowed_agents.length) throw validationError('allowed_agents cannot be empty');
  if (definition.forbidden_agents) assertArray(definition.forbidden_agents, 'forbidden_agents');
  if (definition.side_effect && !definition.idempotency_required) {
    throw validationError('side-effect tools must require idempotency');
  }
  if (
    riskRank(definition.risk_level) >= riskRank('R3')
    && !definition.approval_required
    && !definition.domain_approval_handler
  ) {
    throw validationError('R3+ tools must require approval');
  }
  if (definition.category === 'read' && definition.side_effect) {
    throw validationError('read tools cannot declare side effects');
  }
  return freezeClone({
    forbidden_agents: [],
    required_scopes: [],
    object_scope_required: false,
    timeout_ms: 30000,
    retry_policy: { max_attempts: 1 },
    rate_limit_policy: {},
    ...definition
  });
}

export function riskRank(riskLevel: string): number {
  const index = RISK_LEVELS.indexOf(riskLevel);
  if (index === -1) throw validationError(`invalid risk level: ${riskLevel}`);
  return index;
}

export function validationError(message: string): RuntimeValidationError {
  const error: RuntimeValidationError = Object.assign(new Error(message), { status: 400 });
  error.name = 'ValidationError';
  return error;
}

export function policyError(message: string): RuntimeValidationError {
  const error: RuntimeValidationError = Object.assign(new Error(message), { status: 403 });
  error.name = 'PolicyError';
  return error;
}

function requireFields(value: JsonRecord, fields: string[]): void {
  if (!value || typeof value !== 'object') throw validationError('expected object');
  for (const field of fields) {
    const parts = field.split('.');
    let cursor: unknown = value;
    for (const part of parts) cursor = cursor && typeof cursor === 'object' ? (cursor as JsonRecord)[part] : undefined;
    if (cursor === undefined || cursor === null || cursor === '') throw validationError(`${field} is required`);
  }
}

function assertArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) throw validationError(`${name} must be an array`);
}

function freezeClone(value: JsonRecord): Readonly<JsonRecord> {
  return Object.freeze(structuredClone(value));
}
