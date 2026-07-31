import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrSimulationService,
  type IvrFlow,
  type IvrFlowRepository,
  type IvrFlowVersion
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('IVR simulator uses the durable session runtime with deterministic virtual time and trace', async () => {
  const simulator = new IvrSimulationService({ flows: new SimulationFlowRepository(flowVersion()) });
  const input = {
    tenant_id: 'tenant-a', flow_id: 'flow-a', started_at: '2026-07-13T00:00:00.000Z',
    script: [
      { expected_action_kind: 'play' as const, delay_ms: 100,
        event: { type: 'action_succeeded' as const, result: {} } },
      { expected_action_kind: 'collect' as const, expected_node_id: 'menu', delay_ms: 250,
        event: { type: 'dtmf' as const, digit: '1' } },
      { expected_action_kind: 'hangup' as const, delay_ms: 50,
        event: { type: 'action_succeeded' as const, result: {} } }
    ]
  };

  const first = await simulator.simulate(input);
  const replay = await simulator.simulate(input);

  assert.deepEqual(replay, first);
  assert.equal(first.status, 'completed');
  assert.equal(first.elapsed_ms, 400);
  assert.equal(first.remaining_script_entries, 0);
  assert.deepEqual(first.trace.map((item) => item.action.kind), ['play', 'collect', 'hangup']);
  assert.deepEqual(first.trace.map((item) => item.event_at), [
    '2026-07-13T00:00:00.100Z', '2026-07-13T00:00:00.350Z', '2026-07-13T00:00:00.400Z'
  ]);
  assert.deepEqual(first.steps.map((step) => step.node_id), ['start', 'play', 'menu', 'end']);
});

test('IVR simulator pauses without inventing provider input and reports unused script', async () => {
  const simulator = new IvrSimulationService({ flows: new SimulationFlowRepository(flowVersion()) });
  const waiting = await simulator.simulate({
    tenant_id: 'tenant-a', flow_id: 'flow-a', script: [
      { event: { type: 'action_succeeded', result: {} } }
    ]
  });

  assert.equal(waiting.status, 'waiting_for_script');
  assert.equal(waiting.action?.kind, 'collect');
  assert.equal(waiting.remaining_script_entries, 0);

  const terminal = await simulator.simulate({
    tenant_id: 'tenant-a', flow_id: 'flow-a', script: [
      { event: { type: 'action_failed', error_code: 'provider_error' } },
      { event: { type: 'action_succeeded', result: {} } }
    ]
  });
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.remaining_script_entries, 0);
});

test('IVR simulator records a survey score through the durable provider exchange path', async () => {
  const version = flowVersion();
  version.graph.nodes[2] = {
    id: 'survey', type: 'survey', name: 'CSAT', position: { x: 2, y: 0 },
    data: { variable: 'csat', min_score: 1, max_score: 5 }
  };
  version.graph.edges = [
    { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
    { id: 'e2', source: 'play', target: 'survey', sourceHandle: 'out' },
    { id: 'e3', source: 'play', target: 'end', sourceHandle: 'error' },
    { id: 'e4', source: 'survey', target: 'end', sourceHandle: 'submitted' },
    { id: 'e5', source: 'survey', target: 'end', sourceHandle: 'invalid' },
    { id: 'e6', source: 'survey', target: 'end', sourceHandle: 'timeout' }
  ];
  const result = await new IvrSimulationService({
    flows: new SimulationFlowRepository(version)
  }).simulate({
    tenant_id: 'tenant-a', flow_id: 'flow-a', script: [
      { expected_action_kind: 'play', event: { type: 'action_succeeded', result: {} } },
      { expected_action_kind: 'collect', expected_node_id: 'survey', event: { type: 'dtmf', digit: '5' } },
      { expected_action_kind: 'hangup', event: { type: 'action_succeeded', result: {} } }
    ]
  });

  assert.equal(result.status, 'completed');
  assert.equal((result.session.context.variables as Record<string, unknown>).csat, 5);
  const step = result.steps.find((item) => item.node_id === 'survey');
  assert.equal(step?.branch_taken, 'submitted');
  assert.equal(step?.action.payload.mode, 'survey');
});

test('IVR simulator fails closed on script mismatches and input limits', async () => {
  const simulator = new IvrSimulationService({ flows: new SimulationFlowRepository(flowVersion()) });
  await assert.rejects(() => simulator.simulate({
    tenant_id: 'tenant-a', flow_id: 'flow-a', script: [
      { expected_action_kind: 'collect', event: { type: 'timeout' } }
    ]
  }), hasIvrCode('simulation_script_mismatch'));

  await assert.rejects(() => simulator.simulate({
    tenant_id: 'tenant-a', flow_id: 'flow-a', max_actions: 1, script: [
      { event: { type: 'action_succeeded', result: {} } },
      { event: { type: 'dtmf', digit: '1' } }
    ]
  }), hasIvrCode('simulation_limit_exceeded'));
});

class SimulationFlowRepository implements IvrFlowRepository {
  constructor(private readonly version: IvrFlowVersion) {}
  async getPublished(tenantId: string, flowId: string, version?: number): Promise<IvrFlowVersion | null> {
    return tenantId === this.version.tenant_id && flowId === this.version.flow_id
      && (version === undefined || version === this.version.version)
      ? structuredClone(this.version) : null;
  }
  async getVersion(tenantId: string, flowId: string, version: number) {
    return this.getPublished(tenantId, flowId, version);
  }
  async getFlow(): Promise<IvrFlow | null> { return null; }
  async listFlows(): Promise<IvrFlow[]> { return []; }
  async insertFlow(): Promise<IvrFlow> { throw new Error('not used'); }
  async updateDraft(): Promise<IvrFlow> { throw new Error('not used'); }
  async updatePublication(): Promise<IvrFlow> { throw new Error('not used'); }
  async listVersions(): Promise<IvrFlowVersion[]> { return [structuredClone(this.version)]; }
  async findVersionByPublicationKey(): Promise<IvrFlowVersion | null> { return null; }
  async insertVersion(): Promise<IvrFlowVersion> { throw new Error('not used'); }
}

function flowVersion(): IvrFlowVersion {
  return {
    id: 'version-a', tenant_id: 'tenant-a', flow_id: 'flow-a', version: 1, schema_version: 1,
    graph: {
      version: 1, entryNodeId: 'start', variables: [],
      nodes: [
        { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
        { id: 'play', type: 'play', name: 'Play', position: { x: 1, y: 0 }, data: { text: 'Welcome' } },
        { id: 'menu', type: 'menu', name: 'Menu', position: { x: 2, y: 0 },
          data: { options: [{ digit: '1' }] } },
        { id: 'end', type: 'disconnect', name: 'End', position: { x: 3, y: 0 }, data: {} }
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
        { id: 'e2', source: 'play', target: 'menu', sourceHandle: 'out' },
        { id: 'e3', source: 'play', target: 'end', sourceHandle: 'error' },
        { id: 'e4', source: 'menu', target: 'end', sourceHandle: 'digit_1' },
        { id: 'e5', source: 'menu', target: 'end', sourceHandle: 'timeout' },
        { id: 'e6', source: 'menu', target: 'end', sourceHandle: 'invalid' },
        { id: 'e7', source: 'menu', target: 'end', sourceHandle: 'max_retries' }
      ]
    },
    graph_hash: 'a'.repeat(64), dependencies: {
      node_types: ['start', 'play', 'menu', 'disconnect'], audio_assets: [], time_groups: [],
      region_groups: [], ring_groups: [], queues: [], subflows: [], webhook_refs: [],
      knowledge_profiles: [], ai_profiles: [], provider_profile_ids: [], media_capabilities: [],
      voice_capabilities: ['play', 'collect', 'hangup']
    },
    release_kind: 'publish', source_version: null, publication_key: 'publish-a',
    publication_payload_hash: 'b'.repeat(64), release_metadata: {}, published_by: 'admin-a',
    published_at: '2026-07-13T00:00:00.000Z'
  };
}

function hasIvrCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof IvrError && error.code === code;
}
