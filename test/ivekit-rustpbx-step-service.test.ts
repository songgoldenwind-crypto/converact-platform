import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrSessionService,
  RustPbxStepIvrService,
  type IvrFlow,
  type IvrFlowGraph,
  type IvrFlowRepository,
  type IvrFlowVersion,
  type IvrPendingAction,
  type IvrPendingActionRepository,
  type IvrSession,
  type IvrSessionRepository,
  type IvrSessionStep,
  type IvrSessionUnitOfWork
} from '../src/agent-runtime/ivekit/ivr/index.js';

test('RustPBX Step service binds, waits for a worker, polls, and exactly replays every exchange', async () => {
  const fixture = createFixture(workerGraph());
  let bindingCalls = 0;
  const step = new RustPbxStepIvrService({
    sessions: fixture.sessionsService,
    bindings: { resolve: async () => {
      bindingCalls += 1;
      return { call_id: 'call-a', flow_id: 'flow-a', flow_version: 1 };
    } },
    worker_poll_interval_ms: 250
  });
  const startRequest = request(1, 'session_start');
  const started = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: startRequest
  });
  assert.deepEqual(started.action_node, { type: 'wait', duration_ms: 250, reason: 'ivekit_worker' });
  assert.equal(bindingCalls, 1);
  assert.deepEqual(fixture.steps.items.map((item) => item.node_id), ['start']);

  const startReplay = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: startRequest
  });
  assert.equal(startReplay.replayed, true);
  assert.deepEqual(startReplay.action_node, started.action_node);
  assert.equal(bindingCalls, 1);
  assert.equal(fixture.steps.items.length, 1);
  assert.equal(fixture.actions.items.length, 1);

  const pending = fixture.actions.items[0]!;
  pending.state = 'processing';
  pending.worker_id = 'worker-a';
  pending.attempt_count = 1;
  await fixture.sessionsService.completeWorkerAction({
    tenant_id: 'tenant-a', action_id: pending.id, worker_id: 'worker-a', result: { status: 200 }
  });

  const pollRequest = request(2, 'audio_complete');
  const polled = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: pollRequest
  });
  assert.deepEqual(polled.action_node, { type: 'prompt', tts_text: 'Ready' });
  const stepsAfterPoll = fixture.steps.items.length;
  const pollReplay = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: pollRequest
  });
  assert.equal(pollReplay.replayed, true);
  assert.deepEqual(pollReplay.action_node, polled.action_node);
  assert.equal(fixture.steps.items.length, stepsAfterPoll);

  const hangup = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: request(3, 'audio_complete')
  });
  assert.deepEqual(hangup.action_node, { type: 'hangup' });
  const completed = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: request(4, 'hangup')
  });
  assert.equal(completed.session_state, 'completed');
  assert.deepEqual(completed.action_node, { type: 'hangup' });
});

test('RustPBX Step service cancels a live session on caller hangup', async () => {
  const fixture = createFixture(providerGraph());
  const step = new RustPbxStepIvrService({
    sessions: fixture.sessionsService,
    bindings: { resolve: async () => ({ call_id: 'call-a', flow_id: 'flow-a' }) }
  });
  await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a', request: request(1, 'session_start')
  });
  const cancelled = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    request: { ...request(2, 'hangup'), event: { type: 'hangup', reason: 'caller_left' } }
  });
  assert.equal(cancelled.session_state, 'cancelled');
  assert.deepEqual(cancelled.action_node, { type: 'hangup' });
  assert.equal(fixture.actions.items[0]?.state, 'cancelled');

  const replay = await step.handle({
    tenant_id: 'tenant-a', profile_id: 'profile-a',
    request: { ...request(2, 'hangup'), event: { type: 'hangup', reason: 'caller_left' } }
  });
  assert.equal(replay.replayed, true);
});

function request(sequence: number, eventType: string) {
  return {
    profile_id: 'profile-a', provider_session_id: 'provider-session-a',
    event_sequence: sequence, action_revision: sequence, event: { type: eventType }
  };
}

function createFixture(graph: IvrFlowGraph) {
  const flows = new MemoryFlowRepository(version(graph));
  const sessions = new MemorySessionRepository();
  const steps = new MemoryStepRepository();
  const actions = new MemoryActionRepository();
  const unitOfWork: IvrSessionUnitOfWork = {
    run: async (_tenantId, operation) => operation({ flows, sessions, steps, actions })
  };
  let id = 0;
  const sessionsService = new IvrSessionService({
    unit_of_work: unitOfWork,
    id: (kind) => `${kind}-${++id}`,
    now: () => new Date('2026-07-13T00:00:00.000Z')
  });
  return { actions, sessions, sessionsService, steps };
}

class MemoryFlowRepository implements IvrFlowRepository {
  constructor(private readonly published: IvrFlowVersion) {}
  async getPublished(tenantId: string, flowId: string, versionNumber?: number): Promise<IvrFlowVersion | null> {
    return tenantId === this.published.tenant_id && flowId === this.published.flow_id
      && (versionNumber === undefined || versionNumber === this.published.version)
      ? structuredClone(this.published) : null;
  }
  async getVersion(tenantId: string, flowId: string, versionNumber: number) {
    return this.getPublished(tenantId, flowId, versionNumber);
  }
  async getFlow(): Promise<IvrFlow | null> { return null; }
  async listFlows(): Promise<IvrFlow[]> { return []; }
  async insertFlow(): Promise<IvrFlow> { throw new Error('not used'); }
  async updateDraft(): Promise<IvrFlow> { throw new Error('not used'); }
  async updatePublication(): Promise<IvrFlow> { throw new Error('not used'); }
  async listVersions(): Promise<IvrFlowVersion[]> { return [structuredClone(this.published)]; }
  async findVersionByPublicationKey(): Promise<IvrFlowVersion | null> { return null; }
  async insertVersion(): Promise<IvrFlowVersion> { throw new Error('not used'); }
}

class MemorySessionRepository implements IvrSessionRepository {
  readonly items: IvrSession[] = [];
  async get(tenantId: string, sessionId: string): Promise<IvrSession | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.id === sessionId) ?? null);
  }
  async findByProviderBinding(tenantId: string, profileId: string, providerSessionId: string) {
    return clone(this.items.find((item) => item.tenant_id === tenantId
      && item.provider_profile_id === profileId && item.provider_session_id === providerSessionId) ?? null);
  }
  async insert(session: IvrSession): Promise<IvrSession> { this.items.push(clone(session)); return clone(session); }
  async update(session: IvrSession, expectedRevision: number): Promise<IvrSession> {
    const index = this.items.findIndex((item) => item.id === session.id && item.revision === expectedRevision);
    if (index < 0) throw new IvrError({ code: 'revision_conflict' });
    this.items[index] = clone(session);
    return clone(session);
  }
}

class MemoryStepRepository {
  readonly items: IvrSessionStep[] = [];
  async append(step: IvrSessionStep): Promise<void> { this.items.push(clone(step)); }
  async list(tenantId: string, sessionId: string): Promise<IvrSessionStep[]> {
    return clone(this.items.filter((item) => item.tenant_id === tenantId && item.session_id === sessionId));
  }
}

class MemoryActionRepository implements IvrPendingActionRepository {
  readonly items: IvrPendingAction[] = [];
  async claimDue(): Promise<IvrPendingAction[]> { return []; }
  async claimUncertain(): Promise<IvrPendingAction[]> { return []; }
  async release(): Promise<IvrPendingAction> { throw new Error('not used'); }
  async get(tenantId: string, actionId: string): Promise<IvrPendingAction | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.id === actionId) ?? null);
  }
  async findOpenForSession(tenantId: string, sessionId: string): Promise<IvrPendingAction | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.session_id === sessionId
      && ['pending', 'processing', 'retry_wait', 'uncertain'].includes(item.state)) ?? null);
  }
  async insert(action: IvrPendingAction): Promise<IvrPendingAction> { this.items.push(clone(action)); return clone(action); }
  async settle(input: { tenant_id: string; action_id: string; state: 'succeeded' | 'failed' | 'cancelled'; result: Record<string, unknown>; error_code: string; completed_at: string }) {
    const item = this.items.find((candidate) => candidate.tenant_id === input.tenant_id
      && candidate.id === input.action_id)!;
    Object.assign(item, input, { worker_id: '', updated_at: input.completed_at });
    return clone(item);
  }
}

function version(graph: IvrFlowGraph): IvrFlowVersion {
  return {
    id: 'version-a', tenant_id: 'tenant-a', flow_id: 'flow-a', version: 1, schema_version: 1,
    graph, graph_hash: 'a'.repeat(64), dependencies: {
      node_types: [], audio_assets: [], time_groups: [], region_groups: [], ring_groups: [], queues: [],
      subflows: [], webhook_refs: [], knowledge_profiles: [], ai_profiles: [], provider_profile_ids: [],
      media_capabilities: [], voice_capabilities: []
    }, release_kind: 'publish', source_version: null, publication_key: 'publish-a',
    publication_payload_hash: 'b'.repeat(64), release_metadata: {}, published_by: 'admin-a',
    published_at: '2026-07-13T00:00:00.000Z'
  };
}

function workerGraph(): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [], nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'http', type: 'http', name: 'HTTP', position: { x: 1, y: 0 }, data: { webhook_ref: 'crm' } },
      { id: 'play', type: 'play', name: 'Play', position: { x: 2, y: 0 }, data: { text: 'Ready' } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 3, y: 0 }, data: {} }
    ], edges: [
      { id: 'e1', source: 'start', target: 'http', sourceHandle: 'out' },
      { id: 'e2', source: 'http', target: 'play', sourceHandle: 'success' },
      { id: 'e3', source: 'http', target: 'end', sourceHandle: 'fail' },
      { id: 'e4', source: 'http', target: 'end', sourceHandle: 'timeout' },
      { id: 'e5', source: 'play', target: 'end', sourceHandle: 'out' },
      { id: 'e6', source: 'play', target: 'end', sourceHandle: 'error' }
    ]
  };
}

function providerGraph(): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [], nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'play', type: 'play', name: 'Play', position: { x: 1, y: 0 }, data: { text: 'Welcome' } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 2, y: 0 }, data: {} }
    ], edges: [
      { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
      { id: 'e2', source: 'play', target: 'end', sourceHandle: 'out' },
      { id: 'e3', source: 'play', target: 'end', sourceHandle: 'error' }
    ]
  };
}

function clone<T>(value: T): T { return structuredClone(value); }
