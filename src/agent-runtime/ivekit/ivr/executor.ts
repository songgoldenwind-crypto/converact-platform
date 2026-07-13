import { boundedVariableName, evaluateIvrCondition, renderIvrTemplate } from './expression.js';
import type { IvrAction } from './types.js';
import type { IvrFlowGraph, IvrNodeBase } from './graph-types.js';

export interface IvrExecutionContext {
  variables: Record<string, unknown>;
  interaction_attempts: Record<string, number>;
  subflow_stack: Array<{ flow_id: string; flow_version: number; return_node_id: string }>;
}

export type IvrExecutionEvent =
  | { type: 'enter' }
  | { type: 'dtmf'; digit: string }
  | { type: 'selection'; value: string }
  | { type: 'timeout' }
  | { type: 'action_succeeded'; result: Record<string, unknown> }
  | { type: 'action_failed'; error_code: string; retryable?: boolean };

export interface IvrExecutorEnvironment {
  is_time_group_active?: (timeGroupId: string) => boolean;
}

export interface IvrExecutionOutcome {
  state: 'advanced' | 'waiting' | 'completed' | 'failed' | 'delegated';
  context: IvrExecutionContext;
  branch: string | null;
  next_node_id: string | null;
  action: IvrAction | null;
  delegation: { flow_id: string; flow_version: number | null } | null;
  error_code: string;
}

export function executeIvrNode(input: {
  graph: IvrFlowGraph;
  node_id: string;
  context: IvrExecutionContext;
  event: IvrExecutionEvent;
  environment?: IvrExecutorEnvironment;
}): IvrExecutionOutcome {
  const node = input.graph.nodes.find((candidate) => candidate.id === input.node_id);
  if (!node) return failed(input.context, 'node_not_found');
  const context = cloneContext(input.context);
  try {
    return reduceNode(input.graph, node, context, input.event, input.environment ?? {});
  } catch {
    return failed(context, 'validation_failed');
  }
}

function reduceNode(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrExecutionContext,
  event: IvrExecutionEvent,
  environment: IvrExecutorEnvironment
): IvrExecutionOutcome {
  if (event.type === 'timeout') return route(graph, node, context, 'timeout');
  if (event.type === 'action_failed') return routeFailure(graph, node, context, event.error_code);
  if (event.type === 'dtmf' || event.type === 'selection') {
    return reduceInteraction(graph, node, context, event.type === 'dtmf' ? event.digit : event.value);
  }
  if (event.type === 'action_succeeded') {
    return reduceActionSuccess(graph, node, context, event.result);
  }

  switch (node.type) {
    case 'start':
      for (const variable of graph.variables) {
        if (context.variables[variable.name] === undefined && variable.defaultValue !== undefined) {
          context.variables[variable.name] = variable.defaultValue;
        }
      }
      return route(graph, node, context, 'out');
    case 'set_var': {
      const variable = boundedVariableName(node.data.variable ?? node.data.name);
      context.variables[variable] = renderIvrTemplate(node.data.value, context.variables);
      return route(graph, node, context, 'out');
    }
    case 'condition':
      return route(graph, node, context, evaluateIvrCondition(node.data, context.variables) ? 'true' : 'false');
    case 'time_condition': {
      const id = reference(node.data.time_group_id ?? node.data.timeGroupId ?? node.data.scheduleId);
      const active = environment.is_time_group_active?.(id) ?? false;
      return route(graph, node, context, active ? 'true' : 'false');
    }
    case 'subflow':
      return {
        state: 'delegated', context, branch: null, next_node_id: null, action: null,
        delegation: {
          flow_id: reference(node.data.flow_id ?? node.data.flowId),
          flow_version: optionalVersion(node.data.flow_version ?? node.data.flowVersion)
        },
        error_code: ''
      };
    case 'play': return waiting(context, action('play', node));
    case 'menu': return waiting(context, action('collect', node, { mode: 'menu' }));
    case 'collect': return waiting(context, action('collect', node, { mode: 'digits' }));
    case 'flush_audio': return waiting(context, action('flush', node));
    case 'queue': return waiting(context, action('queue', node));
    case 'http': return waiting(context, action('webhook', node, { operation: 'http' }));
    case 'webhook': return waiting(context, action('webhook', node, { operation: 'webhook' }));
    case 'transfer': return waiting(context, action('transfer', node, { operation: 'transfer' }));
    case 'sip': return waiting(context, action('transfer', node, { operation: 'sip' }));
    case 'voicemail': return waiting(context, action('record', node, { operation: 'voicemail' }));
    case 'disconnect': return waiting(context, action('hangup', node));
    case 'recording': return waiting(context, action('record', node, { operation: 'recording' }));
    case 'knowledge_qa': return waiting(context, action('knowledge', node));
    case 'ai_dialogue': return waiting(context, action('ai', node, { operation: 'dialogue' }));
    case 'intent': {
      if (node.data.dimension === 'keyword') return routeKeywordIntent(graph, node, context);
      return waiting(context, action('ai', node, { operation: 'intent' }));
    }
    case 'avatar_switch':
    case 'video_play':
    case 'screen_share':
    case 'visual_menu':
      return waiting(context, action('media', node, { operation: node.type }));
    case 'compliance': {
      if (node.data.complianceType === 'recording_consent') {
        return waiting(context, action('collect', node, { mode: 'compliance_consent' }));
      }
      return route(graph, node, context, 'out');
    }
    default:
      return failed(context, 'unsupported_node_type');
  }
}

function reduceInteraction(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrExecutionContext,
  value: string
): IvrExecutionOutcome {
  if (node.type === 'menu' || node.type === 'visual_menu') {
    const options = (node.data.options ?? node.data.items) as Array<{ digit?: unknown }> | undefined;
    const allowed = (options ?? []).some((option) => String(option.digit ?? '') === value);
    return route(graph, node, context, allowed ? `digit_${value}` : 'invalid');
  }
  if (node.type === 'collect') {
    const min = boundedInteger(node.data.min_digits ?? node.data.minDigits, 1, 1, 64);
    const max = boundedInteger(node.data.max_digits ?? node.data.maxDigits, 64, min, 64);
    if (!/^[0-9*#]+$/.test(value) || value.length < min || value.length > max) {
      return route(graph, node, context, 'invalid');
    }
    const variable = boundedVariableName(node.data.variable ?? 'digits');
    context.variables[variable] = value;
    return route(graph, node, context, 'out');
  }
  if (node.type === 'compliance') {
    const acknowledged = String(node.data.acknowledge_digit ?? '1');
    const declined = String(node.data.decline_digit ?? '2');
    if (value === acknowledged) {
      context.variables.compliance_ack = 'true';
      return route(graph, node, context, 'acknowledged');
    }
    if (value === declined) {
      context.variables.compliance_ack = 'false';
      return route(graph, node, context, 'declined');
    }
    return route(graph, node, context, 'timeout');
  }
  return failed(context, 'unexpected_interaction_event');
}

function reduceActionSuccess(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrExecutionContext,
  result: Record<string, unknown>
): IvrExecutionOutcome {
  const mapped = result.mapped_variables;
  if (mapped && typeof mapped === 'object' && !Array.isArray(mapped)) {
    Object.assign(context.variables, boundedVariables(mapped as Record<string, unknown>));
  }
  switch (node.type) {
    case 'transfer':
    case 'sip':
    case 'voicemail':
    case 'disconnect':
      return hasAnyOutgoing(graph, node.id)
        ? routeFirst(graph, node, context, ['success', 'out'])
        : completed(context);
    case 'http':
    case 'webhook': {
      const status = Number(result.status ?? 200);
      return route(graph, node, context, status >= 200 && status < 300 ? 'success' : 'fail');
    }
    case 'queue':
      return route(graph, node, context, result.status === 'at_capacity' ? 'at_capacity' : 'out');
    case 'knowledge_qa': {
      if (typeof result.answer === 'string') context.variables.knowledge_answer = result.answer.slice(0, 8_192);
      const found = Boolean(result.answer) && Number(result.confidence ?? 0) >= Number(node.data.min_confidence ?? 0);
      return route(graph, node, context, found ? 'found' : 'not_found');
    }
    case 'intent': {
      const score = Number(result.confidence ?? result.score ?? 0);
      const high = Number(node.data.high_threshold ?? 0.8);
      const low = Number(node.data.low_threshold ?? 0.3);
      return route(graph, node, context, score >= high ? 'high' : score < low ? 'low' : 'continue');
    }
    case 'avatar_switch':
      return route(graph, node, context, result.disposition === 'declined' ? 'declined' : 'success');
    case 'video_play':
      return route(graph, node, context, result.disposition === 'skipped' ? 'skipped' : 'out');
    case 'screen_share':
      return route(graph, node, context, result.disposition === 'denied' ? 'denied' : 'out');
    case 'recording':
      return route(graph, node, context, result.disposition === 'skipped' ? 'skipped' : 'out');
    case 'ai_dialogue':
    case 'play':
    case 'flush_audio':
    case 'compliance':
    case 'subflow':
      return route(graph, node, context, 'out');
    default:
      return failed(context, 'unexpected_action_result');
  }
}

function routeKeywordIntent(graph: IvrFlowGraph, node: IvrNodeBase, context: IvrExecutionContext): IvrExecutionOutcome {
  const source = String(context.variables[node.data.variable as string] ?? context.variables.transcript ?? '').toLowerCase();
  const keywords = Array.isArray(node.data.keywords) ? node.data.keywords.map(String) : [];
  return route(graph, node, context, keywords.some((keyword) => source.includes(keyword.toLowerCase())) ? 'high' : 'continue');
}

function routeFailure(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrExecutionContext,
  errorCode: string
): IvrExecutionOutcome {
  const branch = ['error', 'failed', 'fail'].find((candidate) => hasBranch(graph, node.id, candidate));
  return branch ? route(graph, node, context, branch) : failed(context, boundedErrorCode(errorCode));
}

function routeFirst(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrExecutionContext,
  branches: string[]
): IvrExecutionOutcome {
  const branch = branches.find((candidate) => hasBranch(graph, node.id, candidate));
  return branch ? route(graph, node, context, branch) : completed(context);
}

function route(
  graph: IvrFlowGraph,
  node: IvrNodeBase,
  context: IvrExecutionContext,
  branch: string
): IvrExecutionOutcome {
  const edge = graph.edges.find((candidate) => candidate.source === node.id && (candidate.sourceHandle || 'out') === branch);
  if (!edge) return failed(context, 'branch_missing');
  return {
    state: 'advanced', context: boundedContext(context), branch, next_node_id: edge.target,
    action: null, delegation: null, error_code: ''
  };
}

function action(kind: IvrAction['kind'], node: IvrNodeBase, extra: Record<string, unknown> = {}): IvrAction {
  return { kind, node_id: node.id, payload: { ...structuredClone(node.data), ...extra } };
}

function waiting(context: IvrExecutionContext, plannedAction: IvrAction): IvrExecutionOutcome {
  return {
    state: 'waiting', context: boundedContext(context), branch: null, next_node_id: null,
    action: plannedAction, delegation: null, error_code: ''
  };
}

function completed(context: IvrExecutionContext): IvrExecutionOutcome {
  return {
    state: 'completed', context: boundedContext(context), branch: null, next_node_id: null,
    action: null, delegation: null, error_code: ''
  };
}

function failed(context: IvrExecutionContext, errorCode: string): IvrExecutionOutcome {
  return {
    state: 'failed', context: boundedContext(context), branch: null, next_node_id: null,
    action: null, delegation: null, error_code: boundedErrorCode(errorCode)
  };
}

function cloneContext(context: IvrExecutionContext): IvrExecutionContext {
  return boundedContext(structuredClone(context));
}

function boundedContext(context: IvrExecutionContext): IvrExecutionContext {
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, 'utf8') > 262_144) {
    return { variables: {}, interaction_attempts: {}, subflow_stack: [] };
  }
  return context;
}

function boundedVariables(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 50)) {
    if (/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(key)) output[key] = renderIvrTemplate(child, {});
  }
  return output;
}

function reference(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(value)) throw new Error();
  return value;
}

function optionalVersion(value: unknown): number | null {
  return value === undefined || value === null ? null : boundedInteger(value, 0, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const output = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(output) || output < min || output > max) throw new Error();
  return output;
}

function boundedErrorCode(value: string): string {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : 'action_failed';
}

function hasBranch(graph: IvrFlowGraph, nodeId: string, branch: string): boolean {
  return graph.edges.some((edge) => edge.source === nodeId && (edge.sourceHandle || 'out') === branch);
}

function hasAnyOutgoing(graph: IvrFlowGraph, nodeId: string): boolean {
  return graph.edges.some((edge) => edge.source === nodeId);
}
