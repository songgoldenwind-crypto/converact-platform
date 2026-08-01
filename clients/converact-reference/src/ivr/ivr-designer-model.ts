import type { ConveractFabricIvrFlowGraph, ConveractFabricIvrNodeType as SdkConveractFabricIvrNodeType } from '@converact/sdk';

export type ConveractFabricIvrNodeType = SdkConveractFabricIvrNodeType;

export type ConveractFabricIvrNodeCategory = 'call' | 'logic' | 'intelligence' | 'media';

export interface ConveractFabricIvrNodeDefinition {
  type: ConveractFabricIvrNodeType;
  label: string;
  description: string;
  category: ConveractFabricIvrNodeCategory;
  default_data: Record<string, unknown>;
}

export interface ConveractFabricIvrGraphNode {
  id: string;
  type: ConveractFabricIvrNodeType;
  name: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface ConveractFabricIvrCanvasNode {
  id: string;
  type: 'ivr';
  position: { x: number; y: number };
  data: {
    ivr_type: ConveractFabricIvrNodeType;
    name: string;
    config: Record<string, unknown>;
    issue_count?: number;
  };
}

export interface ConveractFabricIvrCanvasEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface ConveractFabricIvrCanvasGraph {
  nodes: ConveractFabricIvrCanvasNode[];
  edges: ConveractFabricIvrCanvasEdge[];
}

const definitions: ConveractFabricIvrNodeDefinition[] = [
  node('start', 'Start', 'Initialize the call context', 'call', {}),
  node('play', 'Play audio', 'Play an audio asset or TTS prompt', 'call', { text: 'Welcome' }),
  node('menu', 'DTMF menu', 'Collect one menu selection', 'call', {
    prompt: 'Choose an option', options: [{ digit: '1', label: 'Option 1' }],
    timeout_seconds: 5, max_retries: 3
  }),
  node('collect', 'Collect digits', 'Collect and validate a digit sequence', 'call', {
    prompt: 'Enter digits', min_digits: 1, max_digits: 8, variable: 'digits', timeout_seconds: 10
  }),
  node('survey', 'Survey', 'Collect a bounded DTMF or visual rating', 'call', {
    prompt: 'Rate from 1 to 5', min_score: 1, max_score: 5,
    variable: 'survey_score', input_mode: 'dtmf', timeout_seconds: 10
  }),
  node('flush_audio', 'Flush audio', 'Wait for queued audio to finish', 'call', {}),
  node('transfer', 'Transfer', 'Transfer to an approved Voice target', 'call', {
    target_type: 'extension', target_ref: ''
  }),
  node('voicemail', 'Voicemail', 'Record a bounded voicemail message', 'call', { max_duration_seconds: 60 }),
  node('sip', 'SIP transfer', 'Transfer to an approved SIP target', 'call', { target_ref: '' }),
  node('disconnect', 'Disconnect', 'End the call with a reason', 'call', { reason: 'completed' }),
  node('recording', 'Recording', 'Start, pause, resume, or stop recording', 'call', { action: 'start' }),
  node('set_var', 'Set variable', 'Assign a bounded value or expression', 'logic', {
    variable: 'result', value: '', value_type: 'string'
  }),
  node('condition', 'Condition', 'Route using typed comparison rules', 'logic', {
    logic: 'and', rules: [{ field: '', operator: 'equals', value: '' }]
  }),
  node('time_condition', 'Time condition', 'Route using a published time group', 'logic', {
    time_group_id: ''
  }),
  node('queue', 'Queue', 'Enqueue the call in Contact Center', 'logic', {
    queue_id: '', timeout_seconds: 300
  }),
  node('http', 'HTTP request', 'Call an allowlisted webhook reference', 'logic', {
    webhook_ref: '', method: 'POST', timeout_ms: 5_000
  }),
  node('webhook', 'Webhook', 'Emit a bounded business webhook', 'logic', {
    webhook_ref: '', event_type: 'ivr.event', timeout_ms: 5_000
  }),
  node('subflow', 'Subflow', 'Enter an immutable published subflow', 'logic', { flow_id: '' }),
  node('ai_dialogue', 'AI dialogue', 'Run a bounded provider-neutral dialogue', 'intelligence', {
    ai_profile_id: '', max_turns: 10, timeout_seconds: 30
  }),
  node('intent', 'Intent', 'Route by score or keyword intent', 'intelligence', {
    dimension: 'score', high_threshold: 0.8, low_threshold: 0.3
  }),
  node('knowledge_qa', 'Knowledge QA', 'Query an approved knowledge profile', 'intelligence', {
    knowledge_profile_id: '', min_confidence: 0.7, noAnswerAction: 'continue'
  }),
  node('compliance', 'Compliance', 'Apply disclosure or recording consent', 'intelligence', {
    complianceType: 'ai_disclosure', language: 'zh-CN'
  }),
  node('avatar_switch', 'Avatar switch', 'Switch the authorized media avatar', 'media', {
    avatar_ref: '', direction: 'voice_to_video'
  }),
  node('video_play', 'Video play', 'Play an approved media asset', 'media', {
    media_asset_ref: '', skippable: true
  }),
  node('screen_share', 'Screen share', 'Request an authorized screen-share action', 'media', {
    source: 'agent', allow_remote_control: false
  }),
  node('visual_menu', 'Visual menu', 'Show synchronized visual choices', 'media', {
    title: 'Choose an option', items: [{ digit: '1', label: 'Option 1' }], timeout_seconds: 15
  })
];

export const IVR_NODE_DEFINITIONS: readonly ConveractFabricIvrNodeDefinition[] = Object.freeze(definitions);

const definitionByType = new Map(IVR_NODE_DEFINITIONS.map((definition) => [definition.type, definition]));

export function createDefaultIvrGraph(): ConveractFabricIvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'start',
    nodes: [
      createIvrNode('start', { x: 80, y: 180 }, 'start'),
      createIvrNode('disconnect', { x: 380, y: 180 }, 'disconnect')
    ],
    edges: [{ id: 'edge_start_disconnect', source: 'start', target: 'disconnect', sourceHandle: 'out' }],
    variables: []
  };
}

export function createIvrNode(
  type: ConveractFabricIvrNodeType,
  position: { x: number; y: number },
  id = uniqueNodeId(type)
): ConveractFabricIvrGraphNode {
  const definition = definitionByType.get(type);
  if (!definition) throw new TypeError(`unsupported IVR node type: ${type}`);
  return {
    id,
    type,
    name: definition.label,
    position: { ...position },
    data: structuredClone(definition.default_data)
  };
}

export function ivrNodeOutputHandles(node: Pick<ConveractFabricIvrGraphNode, 'type' | 'data'>): string[] {
  switch (node.type) {
    case 'start': case 'set_var':
      return ['out'];
    case 'play': case 'flush_audio':
      return ['out', 'error'];
    case 'menu': return [
      ...dynamicDigitHandles(node.data.options), 'timeout', 'invalid', 'max_retries'
    ];
    case 'collect': return ['out', 'timeout', 'invalid'];
    case 'survey': return ['submitted', 'invalid', 'timeout'];
    case 'condition': case 'time_condition': return ['true', 'false'];
    case 'queue': return ['out', 'timeout', 'at_capacity', 'error'];
    case 'http': case 'webhook': return ['success', 'fail', 'timeout'];
    case 'knowledge_qa': return node.data.noAnswerAction === 'continue'
      ? ['found', 'not_found'] : ['found'];
    case 'intent': return ['high', 'low', 'continue'];
    case 'compliance': return node.data.complianceType === 'recording_consent'
      ? ['out', 'acknowledged', 'declined', 'timeout'] : ['out'];
    case 'visual_menu': return [...dynamicDigitHandles(node.data.items), 'timeout', 'invalid'];
    case 'subflow': return ['out', 'error'];
    case 'ai_dialogue': return ['out', 'timeout', 'error'];
    case 'avatar_switch': return ['success', 'declined', 'error'];
    case 'video_play': return ['out', 'skipped', 'error'];
    case 'screen_share': return ['out', 'denied', 'error'];
    case 'transfer': case 'voicemail': case 'sip': return ['out', 'failed'];
    case 'recording': return ['out', 'skipped', 'error'];
    case 'disconnect': return [];
  }
}

export function toCanvasGraph(graph: ConveractFabricIvrFlowGraph): ConveractFabricIvrCanvasGraph {
  return {
    nodes: graph.nodes.map((raw) => {
      const nodeValue = raw as ConveractFabricIvrGraphNode;
      return {
        id: nodeValue.id,
        type: 'ivr' as const,
        position: { ...nodeValue.position },
        data: {
          ivr_type: nodeValue.type,
          name: nodeValue.name,
          config: structuredClone(nodeValue.data)
        }
      };
    }),
    edges: graph.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
    }))
  };
}

export function toIvrFlowGraph(
  canvas: ConveractFabricIvrCanvasGraph,
  source: ConveractFabricIvrFlowGraph
): ConveractFabricIvrFlowGraph {
  return {
    ...structuredClone(source),
    nodes: canvas.nodes.map((nodeValue) => ({
      id: nodeValue.id,
      type: nodeValue.data.ivr_type,
      name: nodeValue.data.name,
      position: { ...nodeValue.position },
      data: structuredClone(nodeValue.data.config)
    })),
    edges: canvas.edges.map((edge) => ({
      id: edge.id, source: edge.source, target: edge.target,
      ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}),
      ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {})
    }))
  };
}

export function parseImportedIvrGraph(json: string): ConveractFabricIvrFlowGraph {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new TypeError('invalid IVR graph JSON');
  }
  if (!record(value) || !Number.isInteger(value.version) || typeof value.entryNodeId !== 'string'
    || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.variables)) {
    throw new TypeError('invalid IVR graph envelope');
  }
  for (const candidate of value.nodes) {
    if (!record(candidate) || typeof candidate.id !== 'string' || typeof candidate.type !== 'string'
      || !definitionByType.has(candidate.type as ConveractFabricIvrNodeType) || !record(candidate.data)
      || !record(candidate.position) || typeof candidate.position.x !== 'number'
      || typeof candidate.position.y !== 'number') {
      if (record(candidate) && typeof candidate.type === 'string'
        && !definitionByType.has(candidate.type as ConveractFabricIvrNodeType)) {
        throw new TypeError(`unsupported IVR node type: ${candidate.type}`);
      }
      throw new TypeError('invalid IVR graph node');
    }
  }
  return structuredClone(value) as unknown as ConveractFabricIvrFlowGraph;
}

function dynamicDigitHandles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => record(item) ? String(item.digit ?? '') : '')
    .filter((digit) => /^[0-9*#]$/.test(digit))
    .map((digit) => `digit_${digit}`))];
}

function node(
  type: ConveractFabricIvrNodeType,
  label: string,
  description: string,
  category: ConveractFabricIvrNodeCategory,
  default_data: Record<string, unknown>
): ConveractFabricIvrNodeDefinition {
  return { type, label, description, category, default_data };
}

function uniqueNodeId(type: ConveractFabricIvrNodeType): string {
  const suffix = globalThis.crypto?.randomUUID?.().replaceAll('-', '')
    ?? `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `${type}_${suffix}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
