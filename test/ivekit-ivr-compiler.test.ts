import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalIvrGraphHash,
  compileIvrGraph,
  extractIvrDependencies,
  type IvrFlowGraph,
  type IvrNodeBase,
  type IvrNodeType
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('IVR compiler normalizes flat nodes and produces order-stable canonical hashes', () => {
  const graph = validGraph();
  const reordered: IvrFlowGraph = {
    ...graph,
    nodes: [...graph.nodes].reverse().map((node) => ({
      position: node.position,
      data: Object.fromEntries(Object.entries(node.data).reverse()),
      name: node.name,
      type: node.type,
      id: node.id
    })),
    edges: [...graph.edges].reverse(),
    variables: [...graph.variables].reverse()
  };
  const flat = structuredClone(graph) as unknown as IvrFlowGraph;
  const flatStart = flat.nodes[0] as IvrNodeBase & Record<string, unknown>;
  flatStart.greeting = 'hello';
  delete flatStart.data;

  assert.equal(canonicalIvrGraphHash(graph), canonicalIvrGraphHash(reordered));
  const compiled = compileIvrGraph(flat);
  assert.equal(compiled.normalized_graph.nodes.find((node) => node.id === 'start')?.data.greeting, 'hello');
  assert.match(compiled.graph_hash, /^[a-f0-9]{64}$/);
  assert.equal(compiled.errors.length, 0);
  assert.deepEqual(graph, validGraph(), 'compilation must not mutate caller input');
});

test('IVR publication gate rejects duplicate IDs, duplicate handles, and dangling targets', () => {
  const graph = validGraph();
  graph.nodes.push(node('start', 'start-copy'));
  graph.nodes.push(node('play', 'play-a'));
  graph.nodes.push(node('play', 'play-a'));
  graph.edges.push(
    { id: 'edge-copy', source: 'start', target: 'play-a', sourceHandle: 'out' },
    { id: 'edge-copy', source: 'play-a', target: 'missing', sourceHandle: 'out' },
    { id: 'edge-copy-2', source: 'play-a', target: 'end', sourceHandle: 'out' }
  );

  const codes = compileIvrGraph(graph).errors.map((issue) => issue.code);
  for (const code of [
    'duplicate_node_id',
    'duplicate_edge_id',
    'multiple_start_nodes',
    'duplicate_edge_handle',
    'edge_target_missing'
  ]) assert.equal(codes.includes(code), true, code);
});

test('IVR publication gate requires exact branches and a reachable terminal', () => {
  const graph: IvrFlowGraph = {
    version: 1,
    entryNodeId: 'start',
    nodes: [node('start', 'start'), node('condition', 'condition'), node('disconnect', 'end')],
    edges: [
      { id: 'e1', source: 'start', target: 'condition', sourceHandle: 'out' },
      { id: 'e2', source: 'condition', target: 'condition', sourceHandle: 'true' },
      { id: 'e3', source: 'condition', target: 'end', sourceHandle: 'false' }
    ],
    variables: []
  };

  assert.equal(compileIvrGraph(graph).errors.length, 0, 'a loop with an explicit terminal exit is valid');
  graph.edges.pop();
  const report = compileIvrGraph(graph);
  assert.equal(report.errors.some((issue) => issue.code === 'required_edge_missing' && issue.handle === 'false'), true);
  assert.equal(report.errors.some((issue) => issue.code === 'reachable_terminal_missing'), true);
  assert.equal(report.errors.some((issue) => issue.code === 'closed_execution_path'), true);
});

test('IVR publication gate validates variables, shortcuts, graph limits, and sensitive material', () => {
  const graph = validGraph();
  graph.variables = [
    { name: 'valid_name' },
    { name: 'valid_name' },
    { name: 'not valid' }
  ];
  graph.globalShortcuts = [
    { digit: '12', action: 'goto_node', targetNodeId: 'missing' },
    { digit: '#', action: 'goto_node', targetNodeId: 'missing' }
  ];
  graph.nodes[0]!.data = {
    authorization: 'Bearer inline-secret',
    endpoint: 'https://admin:password@example.test/hook'
  };

  const report = compileIvrGraph(graph, { max_nodes: 1 });
  const codes = report.errors.map((issue) => issue.code);
  for (const code of [
    'graph_node_limit_exceeded',
    'duplicate_variable',
    'invalid_variable_name',
    'invalid_shortcut_digit',
    'shortcut_target_missing',
    'sensitive_graph_value'
  ]) assert.equal(codes.includes(code), true, code);
  assert.doesNotMatch(JSON.stringify(report), /inline-secret|admin:password/);
});

test('IVR dependency extraction covers all node families without retaining credentials', () => {
  const nodeTypes: IvrNodeType[] = [
    'start', 'play', 'menu', 'collect', 'set_var', 'condition', 'time_condition',
    'queue', 'http', 'transfer', 'voicemail', 'sip', 'disconnect', 'flush_audio',
    'ai_dialogue', 'intent', 'knowledge_qa', 'avatar_switch', 'compliance',
    'video_play', 'screen_share', 'visual_menu', 'subflow', 'recording', 'webhook'
  ];
  const nodes = nodeTypes.map((type, index) => node(type, `${type}-${index}`, dependencyData(type)));
  const dependencies = extractIvrDependencies({
    version: 1,
    entryNodeId: nodes[0]!.id,
    nodes,
    edges: [],
    variables: []
  });

  assert.deepEqual(dependencies.node_types, [...nodeTypes].sort());
  assert.deepEqual(dependencies.audio_assets, ['audio-main']);
  assert.deepEqual(dependencies.time_groups, ['time-business']);
  assert.deepEqual(dependencies.region_groups, ['region-cn']);
  assert.deepEqual(dependencies.ring_groups, ['ring-support']);
  assert.deepEqual(dependencies.queues, ['queue-support']);
  assert.deepEqual(dependencies.subflows, [{ flow_id: 'flow-child', version: 3 }]);
  assert.deepEqual(dependencies.webhook_refs, ['webhook-crm']);
  assert.deepEqual(dependencies.knowledge_profiles, ['knowledge-main']);
  assert.deepEqual(dependencies.ai_profiles, ['ai-dialogue', 'ai-intent']);
  assert.deepEqual(dependencies.provider_profile_ids, ['voice-primary']);
  assert.deepEqual(dependencies.media_capabilities, [
    'avatar_switch', 'screen_share', 'video_play', 'visual_menu'
  ]);
  assert.deepEqual(dependencies.voice_capabilities, [
    'collect', 'flush_audio', 'hangup', 'play', 'recording', 'sip_transfer', 'transfer'
  ]);
  assert.doesNotMatch(JSON.stringify(dependencies), /top-secret|authorization/i);
});

test('IVR compiler reports unreachable nodes as warnings without publishing false dependencies', () => {
  const graph = validGraph();
  graph.nodes.push(node('queue', 'unused-queue', { queue_id: 'unused' }));
  const report = compileIvrGraph(graph);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.some((issue) => issue.code === 'node_unreachable'), true);
  assert.equal(report.dependencies.queues.includes('unused'), false);
});

function validGraph(): IvrFlowGraph {
  return {
    version: 1,
    entryNodeId: 'start',
    nodes: [node('start', 'start'), node('disconnect', 'end')],
    edges: [{ id: 'edge-start-end', source: 'start', target: 'end', sourceHandle: 'out' }],
    variables: [{ name: 'language', defaultValue: 'zh-CN' }]
  };
}

function node(type: IvrNodeType, id: string, data: Record<string, unknown> = {}): IvrNodeBase {
  return { id, type, name: id, position: { x: 0, y: 0 }, data };
}

function dependencyData(type: IvrNodeType): Record<string, unknown> {
  const values: Partial<Record<IvrNodeType, Record<string, unknown>>> = {
    play: { audio_asset_id: 'audio-main' },
    menu: { audio_asset_id: 'audio-main' },
    collect: { audio_asset_id: 'audio-main' },
    time_condition: { time_group_id: 'time-business' },
    condition: { region_group_id: 'region-cn' },
    queue: { queue_id: 'queue-support' },
    http: { webhook_ref: 'webhook-crm' },
    webhook: { webhook_ref: 'webhook-crm' },
    transfer: { ring_group_id: 'ring-support', provider_profile_id: 'voice-primary' },
    sip: { provider_profile_id: 'voice-primary' },
    subflow: { flow_id: 'flow-child', flow_version: 3 },
    knowledge_qa: { knowledge_profile_id: 'knowledge-main' },
    ai_dialogue: { ai_profile_id: 'ai-dialogue' },
    intent: { ai_profile_id: 'ai-intent' },
    compliance: { audio_asset_id: 'audio-main' },
    video_play: { audio_asset_id: 'audio-main' },
    voicemail: { audio_asset_id: 'audio-main' },
    visual_menu: { authorization: 'top-secret-must-not-be-a-dependency' }
  };
  return values[type] ?? {};
}
