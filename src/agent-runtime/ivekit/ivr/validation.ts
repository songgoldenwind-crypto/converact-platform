import { IVR_BRANCH, REQUIRED_HANDLES_BY_TYPE } from '../../../shared/ivr/branch-handles.js';

import { canonicalIvrGraphHash, normalizeIvrGraph, redactSensitiveIvrGraph } from './canonical.js';
import { extractIvrDependencies, type IvrDependencyManifest } from './dependencies.js';
import {
  IVR_NODE_TYPES,
  isTerminalNode,
  type GlobalShortcut,
  type IvrFlowGraph,
  type IvrNodeBase,
  type IvrNodeType
} from './graph-types.js';

export interface IvrValidationIssue {
  code: string;
  message: string;
  node_id?: string;
  edge_id?: string;
  handle?: string;
  path?: string;
}

export interface IvrCompilationReport {
  normalized_graph: IvrFlowGraph;
  graph_hash: string;
  errors: IvrValidationIssue[];
  warnings: IvrValidationIssue[];
  dependencies: IvrDependencyManifest;
  reachable_node_ids: string[];
  terminal_node_ids: string[];
}

export interface IvrCompilationOptions {
  max_nodes?: number;
  max_edges?: number;
  max_graph_bytes?: number;
}

const NODE_TYPES = new Set<string>(IVR_NODE_TYPES);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export function compileIvrGraph(
  input: IvrFlowGraph,
  options: IvrCompilationOptions = {}
): IvrCompilationReport {
  const graph = normalizeIvrGraph(input);
  const errors: IvrValidationIssue[] = [];
  const warnings: IvrValidationIssue[] = [];
  const limits = {
    max_nodes: boundedLimit(options.max_nodes, 500, 1, 10_000),
    max_edges: boundedLimit(options.max_edges, 2_000, 1, 50_000),
    max_graph_bytes: boundedLimit(options.max_graph_bytes, 1_048_576, 1_024, 10_485_760)
  };

  validateEnvelope(graph, limits, errors);
  const uniqueNodes = validateNodes(graph, errors);
  const reachable = reachableNodes(graph, uniqueNodes);
  validateEdges(graph, uniqueNodes, reachable, errors);
  validateVariables(graph, errors);
  validateShortcuts(graph, uniqueNodes, errors);
  validateSensitiveData(graph, errors);

  const reachableTerminals = [...reachable].filter((id) => {
    const node = uniqueNodes.get(id);
    return node ? isRuntimeTerminal(graph, node) : false;
  });
  if (graph.nodes.length > 0 && reachableTerminals.length === 0) {
    errors.push(issue('reachable_terminal_missing', 'flow has no reachable terminal node'));
  }
  validateTerminalPaths(graph, uniqueNodes, reachable, reachableTerminals, errors);
  for (const node of uniqueNodes.values()) {
    if (!reachable.has(node.id)) warnings.push(issue('node_unreachable', 'node is unreachable', node.id));
  }

  const hasSensitiveData = errors.some((entry) => entry.code === 'sensitive_graph_value');
  return {
    normalized_graph: hasSensitiveData ? redactSensitiveIvrGraph(graph) : graph,
    graph_hash: canonicalIvrGraphHash(graph),
    errors,
    warnings,
    dependencies: extractIvrDependencies(graph, reachable),
    reachable_node_ids: [...reachable].sort(),
    terminal_node_ids: reachableTerminals.sort()
  };
}

function validateEnvelope(
  graph: IvrFlowGraph,
  limits: { max_nodes: number; max_edges: number; max_graph_bytes: number },
  errors: IvrValidationIssue[]
): void {
  if (!Number.isInteger(graph.version) || graph.version < 1) {
    errors.push(issue('invalid_graph_version', 'graph version must be a positive integer'));
  }
  if (graph.nodes.length > limits.max_nodes) {
    errors.push(issue('graph_node_limit_exceeded', 'graph node limit exceeded'));
  }
  if (graph.edges.length > limits.max_edges) {
    errors.push(issue('graph_edge_limit_exceeded', 'graph edge limit exceeded'));
  }
  if (Buffer.byteLength(JSON.stringify(graph), 'utf8') > limits.max_graph_bytes) {
    errors.push(issue('graph_size_limit_exceeded', 'graph byte limit exceeded'));
  }
}

function validateNodes(graph: IvrFlowGraph, errors: IvrValidationIssue[]): Map<string, IvrNodeBase> {
  const nodes = new Map<string, IvrNodeBase>();
  const starts: IvrNodeBase[] = [];
  for (const node of graph.nodes) {
    if (!IDENTIFIER.test(node.id)) errors.push(issue('invalid_node_id', 'node id is invalid', node.id));
    if (nodes.has(node.id)) errors.push(issue('duplicate_node_id', 'node id must be unique', node.id));
    else nodes.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) errors.push(issue('unknown_node_type', 'node type is unsupported', node.id));
    if (node.type === 'start') starts.push(node);
  }
  if (starts.length === 0) errors.push(issue('start_node_missing', 'flow requires exactly one start node'));
  if (starts.length > 1) errors.push(issue('multiple_start_nodes', 'flow requires exactly one start node'));
  if (!graph.entryNodeId || !nodes.has(graph.entryNodeId)) {
    errors.push(issue('entry_node_missing', 'entry node does not exist', graph.entryNodeId));
  } else if (starts.length === 1 && starts[0]!.id !== graph.entryNodeId) {
    errors.push(issue('entry_node_not_start', 'entry node must be the start node', graph.entryNodeId));
  }
  return nodes;
}

function validateEdges(
  graph: IvrFlowGraph,
  nodes: ReadonlyMap<string, IvrNodeBase>,
  reachable: ReadonlySet<string>,
  errors: IvrValidationIssue[]
): void {
  const edgeIds = new Set<string>();
  const handles = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) errors.push(edgeIssue('duplicate_edge_id', 'edge id must be unique', edge.id));
    edgeIds.add(edge.id);
    if (!nodes.has(edge.source)) errors.push(edgeIssue('edge_source_missing', 'edge source does not exist', edge.id));
    if (!nodes.has(edge.target)) errors.push(edgeIssue('edge_target_missing', 'edge target does not exist', edge.id));
    const handle = edge.sourceHandle || IVR_BRANCH.OUT;
    const key = `${edge.source}\u0000${handle}`;
    if (handles.has(key)) {
      errors.push({ ...edgeIssue('duplicate_edge_handle', 'outgoing edge handle must be unique', edge.id), node_id: edge.source, handle });
    }
    handles.add(key);
  }
  for (const node of nodes.values()) {
    if (!reachable.has(node.id)) continue;
    const rule = REQUIRED_HANDLES_BY_TYPE[node.type];
    if (!rule) continue;
    const present = new Set(graph.edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => edge.sourceHandle || IVR_BRANCH.OUT));
    for (const handle of [...rule.required, ...(rule.dynamic?.(node) ?? [])]) {
      if (!present.has(handle)) {
        errors.push({ ...issue('required_edge_missing', 'required outgoing edge is missing', node.id), handle });
      }
    }
  }
}

function validateVariables(graph: IvrFlowGraph, errors: IvrValidationIssue[]): void {
  const names = new Set<string>();
  for (const variable of graph.variables) {
    if (!IDENTIFIER.test(variable.name)) {
      errors.push({ ...issue('invalid_variable_name', 'variable name is invalid'), path: 'variables' });
    }
    if (names.has(variable.name)) {
      errors.push({ ...issue('duplicate_variable', 'variable name must be unique'), path: 'variables' });
    }
    names.add(variable.name);
  }
}

function validateShortcuts(
  graph: IvrFlowGraph,
  nodes: ReadonlyMap<string, IvrNodeBase>,
  errors: IvrValidationIssue[]
): void {
  const digits = new Set<string>();
  for (const shortcut of graph.globalShortcuts ?? []) {
    if (!/^[0-9*#]$/.test(shortcut.digit)) {
      errors.push({ ...issue('invalid_shortcut_digit', 'shortcut digit must be one DTMF symbol'), path: 'globalShortcuts' });
    }
    if (digits.has(shortcut.digit)) {
      errors.push({ ...issue('duplicate_shortcut_digit', 'shortcut digit must be unique'), path: 'globalShortcuts' });
    }
    digits.add(shortcut.digit);
    validateShortcutTarget(shortcut, nodes, errors);
  }
}

function validateShortcutTarget(
  shortcut: GlobalShortcut,
  nodes: ReadonlyMap<string, IvrNodeBase>,
  errors: IvrValidationIssue[]
): void {
  if (shortcut.action === 'goto_node' && !nodes.has(shortcut.targetNodeId)) {
    errors.push({ ...issue('shortcut_target_missing', 'shortcut target does not exist'), path: 'globalShortcuts' });
  }
  if (shortcut.action === 'transfer_queue' && !shortcut.queueName.trim()) {
    errors.push({ ...issue('shortcut_queue_missing', 'shortcut queue is required'), path: 'globalShortcuts' });
  }
}

function validateSensitiveData(graph: IvrFlowGraph, errors: IvrValidationIssue[]): void {
  for (const node of graph.nodes) scanSensitive(node.data, `nodes.${node.id}.data`, node.id, errors);
}

function scanSensitive(
  value: unknown,
  path: string,
  nodeId: string,
  errors: IvrValidationIssue[]
): void {
  if (typeof value === 'string') {
    if (containsSensitiveValue(value)) {
      errors.push({ ...issue('sensitive_graph_value', 'graph contains sensitive material', nodeId), path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => scanSensitive(child, `${path}.${index}`, nodeId, errors));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      errors.push({ ...issue('sensitive_graph_value', 'graph contains a sensitive field', nodeId), path: `${path}.${key}` });
    } else {
      scanSensitive(child, `${path}.${key}`, nodeId, errors);
    }
  }
}

function reachableNodes(
  graph: IvrFlowGraph,
  nodes: ReadonlyMap<string, IvrNodeBase>
): Set<string> {
  const reachable = new Set<string>();
  if (!nodes.has(graph.entryNodeId)) return reachable;
  const queue = [graph.entryNodeId];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of graph.edges) {
      if (edge.source === id && nodes.has(edge.target) && !reachable.has(edge.target)) queue.push(edge.target);
    }
  }
  return reachable;
}

function validateTerminalPaths(
  graph: IvrFlowGraph,
  nodes: ReadonlyMap<string, IvrNodeBase>,
  reachable: ReadonlySet<string>,
  terminals: string[],
  errors: IvrValidationIssue[]
): void {
  const canReachTerminal = new Set(terminals);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (reachable.has(edge.source) && canReachTerminal.has(edge.target) && !canReachTerminal.has(edge.source)) {
        canReachTerminal.add(edge.source);
        changed = true;
      }
    }
  }
  for (const nodeId of reachable) {
    if (!canReachTerminal.has(nodeId) && nodes.has(nodeId)) {
      errors.push(issue('closed_execution_path', 'reachable node has no path to a terminal', nodeId));
    }
  }
}

function isRuntimeTerminal(graph: IvrFlowGraph, node: IvrNodeBase): boolean {
  if (!isTerminalNode(node.type)) return false;
  if (node.type !== 'transfer' && node.type !== 'sip' && node.type !== 'voicemail') return true;
  return graph.edges.every((edge) => edge.source !== node.id || ['failed', 'error'].includes(edge.sourceHandle || ''));
}

function containsSensitiveValue(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)
    || /\b(?:bearer|basic)\s+[A-Za-z0-9+/=_:.-]{4,}/i.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|password|passwd|privatekey|clientsecret|accesstoken|refreshtoken|apikey|bearertoken|credential|secret)$/.test(normalized);
}

function issue(code: string, message: string, nodeId?: string): IvrValidationIssue {
  return { code, message, ...(nodeId ? { node_id: nodeId } : {}) };
}

function edgeIssue(code: string, message: string, edgeId: string): IvrValidationIssue {
  return { code, message, edge_id: edgeId };
}

function boundedLimit(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) && value! >= min && value! <= max ? value! : fallback;
}
