import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IvrError,
  IvrSessionService,
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

test('IVR durable session advances, persists actions, replays exactly, and reaches terminal state', async () => {
  const fixture = createFixture();
  const started = await fixture.service.startSession({
    tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a',
    provider_profile_id: 'profile-a', provider_session_id: 'provider-session-a', trace_id: 'trace-a'
  });
  assert.equal(started.session.state, 'running');
  assert.equal(started.session.current_node_id, 'start');

  const first = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });
  assert.equal(first.action?.kind, 'play');
  assert.equal(first.session.state, 'waiting');
  assert.equal(first.session.current_node_id, 'play');
  assert.equal(first.session.step_count, 1, 'start step is append-only before play waits');
  assert.equal(fixture.actions.items.length, 1);

  const replay = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.action, first.action);
  assert.equal(fixture.steps.items.length, 1);
  assert.equal(fixture.actions.items.length, 1);

  const menu = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 2, action_revision: 2,
    event: { type: 'action_succeeded', result: {} }
  });
  assert.equal(menu.action?.kind, 'collect');
  assert.equal(menu.session.current_node_id, 'menu');
  assert.equal(fixture.actions.items[0]?.state, 'succeeded');

  const hangup = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 3, action_revision: 3,
    event: { type: 'dtmf', digit: '1' }
  });
  assert.equal(hangup.action?.kind, 'hangup');
  assert.equal(hangup.session.current_node_id, 'end');

  const completed = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 4, action_revision: 4,
    event: { type: 'action_succeeded', result: {} }
  });
  assert.equal(completed.action, null);
  assert.equal(completed.session.state, 'completed');
  assert.equal(completed.session.step_count, 4);
  assert.equal(fixture.steps.items.length, 4);
  assert.deepEqual(fixture.steps.items.map((step) => step.node_id), ['start', 'play', 'menu', 'end']);
});

test('IVR durable session rejects sequence gaps, altered replays, and terminal advances', async () => {
  const fixture = createFixture();
  const started = await fixture.service.startSession({ tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a' });
  await fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' } });

  await assert.rejects(() => fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 3, action_revision: 2, event: { type: 'action_succeeded', result: {} } }),
  hasIvrCode('event_sequence_conflict'));
  await assert.rejects(() => fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'timeout' } }),
  hasIvrCode('event_sequence_conflict'));

  await fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 2, action_revision: 2, event: { type: 'action_succeeded', result: {} } });
  await fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 3, action_revision: 3, event: { type: 'dtmf', digit: '1' } });
  await fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 4, action_revision: 4, event: { type: 'action_succeeded', result: {} } });
  await assert.rejects(() => fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 5, action_revision: 5, event: { type: 'enter' } }), hasIvrCode('invalid_session_state'));
});

test('IVR session start idempotently binds one provider session to one published flow version', async () => {
  const fixture = createFixture();
  const input = {
    tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a',
    provider_profile_id: 'profile-a', provider_session_id: 'provider-session-a'
  };
  const first = await fixture.service.startSession(input);
  const replay = await fixture.service.startSession(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.session.id, first.session.id);
  assert.equal(fixture.sessions.items.length, 1);

  await assert.rejects(() => fixture.service.startSession({ ...input, call_id: 'call-b' }),
    hasIvrCode('idempotency_conflict'));
});

test('IVR worker action completion atomically settles and resumes the session', async () => {
  const fixture = createFixture(workerGraph());
  const started = await fixture.service.startSession({ tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a' });
  const waiting = await fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' } });
  assert.equal(waiting.action?.kind, 'webhook');
  const pending = fixture.actions.items[0]!;
  pending.state = 'processing'; pending.worker_id = 'worker-a'; pending.attempt_count = 1;

  await assert.rejects(() => fixture.service.completeWorkerAction({
    tenant_id: 'tenant-a', action_id: pending.id, worker_id: 'worker-b', result: { status: 200 }
  }), hasIvrCode('lease_lost'));
  const resumed = await fixture.service.completeWorkerAction({
    tenant_id: 'tenant-a', action_id: pending.id, worker_id: 'worker-a', result: { status: 200 }
  });
  assert.equal(resumed.action?.kind, 'hangup');
  assert.equal(resumed.session.current_node_id, 'end');
  assert.equal(fixture.actions.items.find((item) => item.id === pending.id)?.state, 'succeeded');
  assert.deepEqual(fixture.steps.items.map((step) => step.node_id), ['start', 'http']);

  const originalReplay = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });
  assert.equal(originalReplay.action?.kind, 'webhook', 'worker completion must not mutate prior provider response');

  const poll = await fixture.service.acknowledgeProviderPoll({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 2, action_revision: 2, event: { type: 'provider_wait_complete' }
  });
  assert.equal(poll.action?.kind, 'hangup');
  const pollReplay = await fixture.service.acknowledgeProviderPoll({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 2, action_revision: 2, event: { type: 'provider_wait_complete' }
  });
  assert.equal(pollReplay.replayed, true);
  assert.equal(pollReplay.action?.kind, 'hangup');
});

test('IVR session cancellation atomically closes its pending action and is exactly replayable', async () => {
  const fixture = createFixture();
  const started = await fixture.service.startSession({
    tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a'
  });
  await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });

  const cancelled = await fixture.service.cancelSession({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 2, action_revision: 2, reason: 'caller_hangup'
  });
  assert.equal(cancelled.session.state, 'cancelled');
  assert.equal(cancelled.session.termination_reason, 'caller_hangup');
  assert.equal(cancelled.action, null);
  assert.equal(fixture.actions.items[0]?.state, 'cancelled');
  assert.deepEqual(fixture.steps.items.map((step) => step.node_id), ['start', 'play']);

  const replay = await fixture.service.cancelSession({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 2, action_revision: 2, reason: 'caller_hangup'
  });
  assert.equal(replay.replayed, true);
  assert.equal(fixture.steps.items.length, 2);
});

test('IVR worker failure atomically settles and resumes through the exact fail branch', async () => {
  const fixture = createFixture(workerGraph());
  const started = await fixture.service.startSession({ tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a' });
  await fixture.service.advance({ tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' } });
  const pending = fixture.actions.items[0]!;
  pending.state = 'processing'; pending.worker_id = 'worker-a'; pending.attempt_count = 3;

  const resumed = await fixture.service.failWorkerAction({
    tenant_id: 'tenant-a', action_id: pending.id, worker_id: 'worker-a', error_code: 'provider_rejected'
  });
  assert.equal(resumed.action?.kind, 'hangup');
  assert.equal(resumed.session.current_node_id, 'end');
  assert.equal(fixture.actions.items[0]?.state, 'failed');
  assert.equal(fixture.steps.items.find((step) => step.node_id === 'http')?.branch_taken, 'fail');
});

test('IVR subflow executes an immutable child version and returns to the parent out branch', async () => {
  const child = publishedFlow(childReturnGraph('ok'), 'child-flow', 3);
  const fixture = createFixture(parentSubflowGraph('child-flow', 3), [child]);
  const started = await fixture.service.startSession({
    tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a'
  });

  const waiting = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });

  assert.equal(waiting.action?.kind, 'hangup');
  assert.equal(waiting.session.current_node_id, 'parent-ok');
  assert.deepEqual((waiting.session.context.active_flow as Record<string, unknown>), {
    flow_id: 'flow-a', flow_version: 1
  });
  assert.deepEqual(waiting.session.context.subflow_stack, []);
  assert.deepEqual(fixture.steps.items.map((step) => step.node_id), [
    'parent-start', 'child-call', 'child-start', 'child-return'
  ]);
  assert.deepEqual(fixture.steps.items.map((step) => [step.flow_id, step.flow_version]), [
    ['flow-a', 1], ['flow-a', 1], ['child-flow', 3], ['child-flow', 3]
  ]);
});

test('IVR subflow error return routes the exact parent error branch', async () => {
  const child = publishedFlow(childReturnGraph('error'), 'child-flow', 3);
  const fixture = createFixture(parentSubflowGraph('child-flow', 3), [child]);
  const started = await fixture.service.startSession({
    tenant_id: 'tenant-a', call_id: 'call-a', flow_id: 'flow-a'
  });

  const waiting = await fixture.service.advance({
    tenant_id: 'tenant-a', session_id: started.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });

  assert.equal(waiting.action?.kind, 'hangup');
  assert.equal(waiting.session.current_node_id, 'parent-error');
  assert.equal(fixture.steps.items.find((step) => step.node_id === 'child-return')?.branch_taken, 'error');
});

test('IVR subflow routes missing child versions and excessive depth through error branches', async () => {
  const missingFixture = createFixture(parentSubflowGraph('missing-flow', 1));
  const missingStarted = await missingFixture.service.startSession({
    tenant_id: 'tenant-a', call_id: 'call-missing', flow_id: 'flow-a'
  });
  const missing = await missingFixture.service.advance({
    tenant_id: 'tenant-a', session_id: missingStarted.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });
  assert.equal(missing.session.current_node_id, 'parent-error');
  assert.equal(missingFixture.steps.items.find((step) => step.node_id === 'child-call')?.error_code,
    'subflow_not_found');

  const nested = publishedFlow(parentSubflowGraph('grandchild-flow', 1, 'child'), 'child-flow', 1);
  const grandchild = publishedFlow(childReturnGraph('ok'), 'grandchild-flow', 1);
  const depthFixture = createFixture(parentSubflowGraph('child-flow', 1), [nested, grandchild], 1);
  const depthStarted = await depthFixture.service.startSession({
    tenant_id: 'tenant-a', call_id: 'call-depth', flow_id: 'flow-a'
  });
  const depth = await depthFixture.service.advance({
    tenant_id: 'tenant-a', session_id: depthStarted.session.id,
    event_sequence: 1, action_revision: 1, event: { type: 'enter' }
  });
  assert.equal(depth.session.current_node_id, 'parent-error');
  assert.equal(depthFixture.steps.items.find((step) => step.error_code === 'subflow_depth_exceeded')?.node_id,
    'child-call');
});

function createFixture(
  graphOverride?: IvrFlowGraph,
  additionalVersions: IvrFlowVersion[] = [],
  maxSubflowDepth?: number
) {
  const flow = publishedFlow(graphOverride);
  const flows = new MemoryFlowRepository([flow, ...additionalVersions]);
  const sessions = new MemorySessionRepository();
  const steps = new MemoryStepRepository();
  const actions = new MemoryActionRepository();
  const unitOfWork: IvrSessionUnitOfWork = {
    run: async (_tenantId, operation) => operation({ flows, sessions, actions, steps })
  };
  let id = 0;
  const service = new IvrSessionService({
    unit_of_work: unitOfWork,
    id: (kind) => `${kind}-${++id}`,
    now: () => new Date('2026-07-13T01:00:00.000Z'),
    max_subflow_depth: maxSubflowDepth
  });
  return { actions, flows, service, sessions, steps };
}

class MemoryFlowRepository implements IvrFlowRepository {
  constructor(readonly published: IvrFlowVersion[]) {}
  async getPublished(tenantId: string, flowId: string, version?: number): Promise<IvrFlowVersion | null> {
    const matches = this.published.filter((candidate) => candidate.tenant_id === tenantId
      && candidate.flow_id === flowId && (version === undefined || version === candidate.version));
    const selected = matches.sort((left, right) => right.version - left.version)[0] ?? null;
    return clone(selected);
  }
  async getVersion(tenantId: string, flowId: string, version: number) { return this.getPublished(tenantId, flowId, version); }
  async getFlow(): Promise<IvrFlow | null> { return null; }
  async listFlows(): Promise<IvrFlow[]> { return []; }
  async insertFlow(): Promise<IvrFlow> { throw new Error('not used'); }
  async updateDraft(): Promise<IvrFlow> { throw new Error('not used'); }
  async updatePublication(): Promise<IvrFlow> { throw new Error('not used'); }
  async listVersions(): Promise<IvrFlowVersion[]> { return clone(this.published); }
  async findVersionByPublicationKey(): Promise<IvrFlowVersion | null> { return null; }
  async insertVersion(): Promise<IvrFlowVersion> { throw new Error('not used'); }
}

class MemorySessionRepository implements IvrSessionRepository {
  readonly items: IvrSession[] = [];
  async get(tenantId: string, sessionId: string): Promise<IvrSession | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.id === sessionId) ?? null);
  }
  async findByProviderBinding(tenantId: string, profileId: string, providerSessionId: string): Promise<IvrSession | null> {
    return clone(this.items.find((item) => item.tenant_id === tenantId && item.provider_profile_id === profileId
      && item.provider_session_id === providerSessionId) ?? null);
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
  async settle(input: { tenant_id: string; action_id: string; state: 'succeeded' | 'failed' | 'cancelled'; result: Record<string, unknown>; error_code: string; completed_at: string }): Promise<IvrPendingAction> {
    const item = this.items.find((candidate) => candidate.tenant_id === input.tenant_id && candidate.id === input.action_id)!;
    Object.assign(item, input, { id: item.id, state: input.state, updated_at: input.completed_at });
    return clone(item);
  }
}

function publishedFlow(
  graphOverride?: IvrFlowGraph,
  flowId = 'flow-a',
  version = 1
): IvrFlowVersion {
  return {
    id: `version-${flowId}-${version}`, tenant_id: 'tenant-a', flow_id: flowId, version, schema_version: 1,
    graph: graphOverride ?? graph(), graph_hash: 'a'.repeat(64), dependencies: emptyDependencies(),
    release_kind: 'publish', source_version: null, publication_key: `publish-${flowId}-${version}`,
    publication_payload_hash: 'b'.repeat(64), release_metadata: {}, published_by: 'admin-a',
    published_at: '2026-07-13T00:00:00.000Z'
  };
}

function parentSubflowGraph(
  childFlowId: string,
  childFlowVersion: number,
  prefix = 'parent'
): IvrFlowGraph {
  return {
    version: 1, entryNodeId: `${prefix}-start`, variables: [],
    nodes: [
      { id: `${prefix}-start`, type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'child-call', type: 'subflow', name: 'Child', position: { x: 1, y: 0 },
        data: { flow_id: childFlowId, flow_version: childFlowVersion } },
      { id: `${prefix}-ok`, type: 'disconnect', name: 'Success', position: { x: 2, y: 0 }, data: {} },
      { id: `${prefix}-error`, type: 'disconnect', name: 'Error', position: { x: 2, y: 1 },
        data: { return_code: 'error' } }
    ],
    edges: [
      { id: `${prefix}-e1`, source: `${prefix}-start`, target: 'child-call', sourceHandle: 'out' },
      { id: `${prefix}-e2`, source: 'child-call', target: `${prefix}-ok`, sourceHandle: 'out' },
      { id: `${prefix}-e3`, source: 'child-call', target: `${prefix}-error`, sourceHandle: 'error' }
    ]
  };
}

function childReturnGraph(returnCode: 'ok' | 'error'): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'child-start', variables: [],
    nodes: [
      { id: 'child-start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'child-return', type: 'disconnect', name: 'Return', position: { x: 1, y: 0 },
        data: { return_code: returnCode } }
    ],
    edges: [
      { id: 'child-e1', source: 'child-start', target: 'child-return', sourceHandle: 'out' }
    ]
  };
}

function workerGraph(): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'http', type: 'http', name: 'HTTP', position: { x: 1, y: 0 }, data: { webhook_ref: 'crm' } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 2, y: 0 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'http', sourceHandle: 'out' },
      { id: 'e2', source: 'http', target: 'end', sourceHandle: 'success' },
      { id: 'e3', source: 'http', target: 'end', sourceHandle: 'fail' },
      { id: 'e4', source: 'http', target: 'end', sourceHandle: 'timeout' }
    ]
  };
}

function graph(): IvrFlowGraph {
  return {
    version: 1, entryNodeId: 'start', variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 0, y: 0 }, data: {} },
      { id: 'play', type: 'play', name: 'Play', position: { x: 1, y: 0 }, data: { text: 'Welcome' } },
      { id: 'menu', type: 'menu', name: 'Menu', position: { x: 2, y: 0 }, data: { options: [{ digit: '1' }] } },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 3, y: 0 }, data: {} }
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'play', sourceHandle: 'out' },
      { id: 'e2', source: 'play', target: 'menu', sourceHandle: 'out' },
      { id: 'e3', source: 'menu', target: 'end', sourceHandle: 'digit_1' },
      { id: 'e4', source: 'menu', target: 'end', sourceHandle: 'timeout' },
      { id: 'e5', source: 'menu', target: 'end', sourceHandle: 'invalid' },
      { id: 'e6', source: 'menu', target: 'end', sourceHandle: 'max_retries' }
    ]
  };
}

function emptyDependencies() {
  return { node_types: ['collect', 'disconnect', 'menu', 'play', 'start'] as never[], audio_assets: [],
    time_groups: [], region_groups: [], ring_groups: [], queues: [], subflows: [], webhook_refs: [],
    knowledge_profiles: [], ai_profiles: [], provider_profile_ids: [], media_capabilities: [],
    voice_capabilities: ['collect', 'hangup', 'play'] };
}

function hasIvrCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof IvrError && error.code === code;
}

function clone<T>(value: T): T { return structuredClone(value); }
