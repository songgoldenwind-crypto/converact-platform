/**
 * Provider-neutral IVR graph contract shared by the iveKit runtime and designers.
 */

export type IvrNodeType =
  | 'start' | 'play' | 'menu' | 'collect' | 'set_var'
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

export const TERMINAL_NODE_TYPES: ReadonlySet<IvrNodeType> = new Set([
  'transfer', 'voicemail', 'sip', 'disconnect'
]);

export function isTerminalNode(type: IvrNodeType): boolean {
  return TERMINAL_NODE_TYPES.has(type);
}

/** Normalize flat designer nodes (fields at top level) into `{ data }` shape. */
export function normalizeGraphForValidation(graph: IvrFlowGraph): IvrFlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const flatNode = node as IvrNodeBase & Record<string, unknown>;
      const { id, type, name, position, data: rawData, ...rest } = flatNode;
      const baseData = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
        ? rawData as Record<string, unknown>
        : {};
      return {
        id: String(id),
        type: type as IvrNodeType,
        name: String(name ?? ''),
        position: position as { x: number; y: number } ?? { x: 0, y: 0 },
        data: { ...baseData, ...rest }
      };
    })
  };
}
