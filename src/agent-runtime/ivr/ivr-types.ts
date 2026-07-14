import { isTransferTerminal } from './ivr-transfer-handler.js';
import type { GraphValidationError } from './ivr-branch-handles.js';
import {
  validateFlowGraphDetailed as sharedValidateFlowGraphDetailed,
  validateFlowGraph as sharedValidateFlowGraph,
  validateFlowGraphAll as sharedValidateFlowGraphAll,
  type FlowValidationReport,
} from '../../../shared/ivr/validate-flow-graph.js';

export type { GraphValidationError, FlowValidationReport };

/**
 * IVR Flow Graph backend types — mirrors the frontend discriminated union.
 *
 * The full 23-node type system is defined here for the backend executor,
 * storage, and API. The frontend types.ts is the source of truth for the
 * UI; this file is the source of truth for the server.
 */

export type IvrNodeType =
  | 'start' | 'play' | 'menu' | 'collect' | 'survey' | 'set_var'
  | 'condition' | 'time_condition' | 'queue' | 'http'
  | 'transfer' | 'voicemail' | 'sip' | 'disconnect' | 'flush_audio'
  | 'ai_dialogue' | 'intent' | 'knowledge_qa' | 'avatar_switch' | 'compliance'
  | 'video_play' | 'screen_share' | 'visual_menu' | 'subflow' | 'recording' | 'webhook';

export interface IvrNodeBase {
  id: string;
  type: IvrNodeType;
  name: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface IvrEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
}

export interface IvrVariable {
  name: string;
  defaultValue?: string;
  description?: string;
}

export type GlobalShortcut =
  | { digit: string; action: 'transfer_queue'; queueName: string }
  | { digit: string; action: 'repeat_last' }
  | { digit: string; action: 'goto_node'; targetNodeId: string; popSubflow?: boolean };

export interface IvrFlowGraph {
  version: number;
  entryNodeId: string;
  nodes: IvrNodeBase[];
  edges: IvrEdge[];
  variables: IvrVariable[];
  globalShortcuts?: GlobalShortcut[];
}

// Terminal node types (no outgoing edges)
export const TERMINAL_NODE_TYPES: ReadonlySet<IvrNodeType> = new Set([
  'transfer', 'voicemail', 'sip', 'disconnect',
]);

export function isTerminalNode(type: IvrNodeType): boolean {
  return TERMINAL_NODE_TYPES.has(type);
}

/** Session terminal check — transfer with failure edges is non-terminal (7-B). */
export function isNodeSessionTerminal(graph: IvrFlowGraph, node: IvrNodeBase): boolean {
  if (node.type === 'transfer') return isTransferTerminal(graph, node.id);
  return isTerminalNode(node.type);
}

export { isTransferTerminal };

/**
 * Find the edge from a node via a specific handle.
 * Returns the target node ID, or null if no edge matches.
 *
 * @deprecated for branch routing — use {@link requireEdge}. Fallback to `out` masks missing edges.
 */
export function resolveEdge(
  graph: IvrFlowGraph,
  sourceNodeId: string,
  handle?: string
): string | null {
  // Prefer exact handle match; fall back to the first edge from this node.
  const exact = graph.edges.find(
    (e) => e.source === sourceNodeId && e.sourceHandle === handle
  );
  if (exact) return exact.target;

  const fallback = graph.edges.find(
    (e) => e.source === sourceNodeId && (!e.sourceHandle || e.sourceHandle === 'out')
  );
  return fallback?.target ?? null;
}

export type RequireEdgeResult =
  | { ok: true; target: string }
  | { ok: false; handle: string };

/**
 * Strict edge lookup — no fallback to `out` or other handles.
 */
export function requireEdge(
  graph: IvrFlowGraph,
  sourceNodeId: string,
  handle: string
): RequireEdgeResult {
  const exact = graph.edges.find(
    (e) => e.source === sourceNodeId && e.sourceHandle === handle
  );
  if (exact) return { ok: true, target: exact.target };
  return { ok: false, handle };
}

/**
 * Get all outgoing edges from a node, keyed by handle.
 */
export function getNodeExits(
  graph: IvrFlowGraph,
  nodeId: string
): Map<string, string> {
  const exits = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.source === nodeId) {
      exits.set(edge.sourceHandle || 'out', edge.target);
    }
  }
  return exits;
}

/**
 * Detailed graph validation — shared with frontend designer (阶段 C).
 */
export function validateFlowGraphDetailed(graph: IvrFlowGraph): FlowValidationReport {
  return sharedValidateFlowGraphDetailed(graph);
}

/**
 * Structural validation only — backward compatible with pre-phase-A callers.
 */
export function validateFlowGraph(graph: IvrFlowGraph): string[] {
  return sharedValidateFlowGraph(graph);
}

/** All validation messages (errors + warnings) as legacy string[]. */
export function validateFlowGraphAll(graph: IvrFlowGraph): string[] {
  return sharedValidateFlowGraphAll(graph);
}
